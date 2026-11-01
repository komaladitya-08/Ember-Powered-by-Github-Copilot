/**
 * The voiceprint model (voiceprint.ts) on a worker thread of the voice process, so making a voiceprint (half a second
 * or so of computing for a request) never holds up listening. onnxruntime-web's WebAssembly build runs it on one
 * thread, on every OS (RHEL 8's glibc included). Messages: "init" loads the model; each { id, samples } gets back
 * { id, print } (unit length) or { id, error }.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { printFeatures, unit } from "./voiceprint";

/* eslint-disable @typescript-eslint/no-explicit-any -- onnxruntime-web is loaded at run time, beside the bundle */
type In = { type: "init"; model: string } | { type: "print"; id: number; samples: Float32Array };
export type VoiceprintWorkerMessage = { type: "ready" } | { type: "error"; message: string } | { id: number; print?: Float32Array; error?: string };

const port = parentPort!;
let session: Promise<any> | null = null;
let ort: any = null;

port.on("message", (m: In) => {
  if (m.type === "init") {
    const require = createRequire(__filename);
    ort = require("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = "error";
    // Its WebAssembly is beside its own entry point (dist/), wherever the app's node_modules are; as a file: URL, which
    // its loader imports on every OS (a bare Windows path isn't one).
    ort.env.wasm.wasmPaths = `${pathToFileURL(path.dirname(require.resolve("onnxruntime-web"))).href}/`;
    const made: Promise<any> = ort.InferenceSession.create(m.model, { executionProviders: ["wasm"] });
    session = made;
    made.then(() => port.postMessage({ type: "ready" } satisfies VoiceprintWorkerMessage), (err: unknown) => {
      port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies VoiceprintWorkerMessage);
    });
    return;
  }
  void (async () => {
    try {
      if (!session) throw new Error("the voiceprint model isn't loaded");
      const s = await session;
      const { data, frames } = printFeatures(m.samples);
      if (frames < 10) throw new Error("too little audio for a voiceprint");
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, [1, frames, 80]) });
      port.postMessage({ id: m.id, print: unit(out[s.outputNames[0]].data as Float32Array) } satisfies VoiceprintWorkerMessage);
    } catch (err) {
      port.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) } satisfies VoiceprintWorkerMessage);
    }
  })();
});
