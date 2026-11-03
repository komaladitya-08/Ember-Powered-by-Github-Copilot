/**
 * The memory embedding model itself (docs/MEMORY.md §2): all-MiniLM-L6-v2, int8, on onnxruntime-web's WebAssembly build
 * with one thread, on every OS (RHEL 8's glibc included: Linux ships no native addon, and this is the same
 * onnxruntime-web 1.23.2 Voice Match already runs). A text is cut into WordPiece ids (./wordpiece.ts), run through the
 * model, and its token vectors are averaged (the model's mean pooling) and scaled to unit length, so a dot product is
 * the cosine similarity.
 *
 * Runs in Ember's memory process (./embed-process.ts), never in main, and in scripts and tests under plain Node.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WordPiece } from "./wordpiece";

/** The longest text the model is given, in tokens: a fact (400 characters at most) and its names fit. */
export const MAX_TOKENS = 128;

export interface EmbedModel {
  /** Unit-length vectors, one per text. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  readonly dim: number;
  release(): Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- onnxruntime-web is loaded at run time, beside the bundle */
/** Loads the model (`model`: the .onnx file, `vocab`: its vocab.txt). */
export async function loadEmbedModel(o: { model: string; vocab: string }): Promise<EmbedModel> {
  const require = createRequire(__filename);
  const ort = require("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
  // Its WebAssembly is beside its own entry point (dist/), wherever the app's node_modules are; as a file: URL, which
  // its loader imports on every OS (a bare Windows path isn't one).
  ort.env.wasm.wasmPaths = `${pathToFileURL(path.dirname(require.resolve("onnxruntime-web"))).href}/`;
  const tokenizer = new WordPiece(fs.readFileSync(o.vocab, "utf8"));
  // No memory arena: a session that keeps every buffer it ever used holds more for longer (measured: 15 MB more).
  const session: any = await ort.InferenceSession.create(o.model, { executionProviders: ["wasm"], enableCpuMemArena: false });
  const typed = session.inputNames.includes("token_type_ids");
  let dim = 0;

  const one = async (text: string): Promise<Float32Array> => {
    const e = tokenizer.encode(text, MAX_TOKENS);
    const n = e.ids.length;
    const tensor = (a: number[]) => new ort.Tensor("int64", BigInt64Array.from(a, BigInt), [1, n]);
    const feeds: Record<string, unknown> = { input_ids: tensor(e.ids), attention_mask: tensor(e.mask) };
    if (typed) feeds.token_type_ids = tensor(e.types);
    const out = await session.run(feeds);
    const hidden = out[session.outputNames[0]];
    const d: number = hidden.dims[2];
    const data = hidden.data as Float32Array;
    const v = new Float32Array(d);
    for (let t = 0; t < n; t++) for (let i = 0; i < d; i++) v[i] += data[t * d + i];
    let norm = 0;
    for (let i = 0; i < d; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < d; i++) v[i] /= norm;
    dim = d;
    return v;
  };

  return {
    // One at a time: the model runs on one thread, and a batch would pad short texts to the longest.
    async embed(texts) {
      const out: Float32Array[] = [];
      for (const t of texts) out.push(await one(t));
      return out;
    },
    get dim() { return dim; },
    release: () => session.release(),
  };
}
