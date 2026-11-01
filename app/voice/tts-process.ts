/**
 * Ember's voice process: the neural voice (app/voice/tts.ts) in a utility process of its own, so making speech never
 * holds up listening (the voice process) or Ember's main thread. Main sends what to say, numbered; this process says
 * it chunk by chunk (speechChunks), sending each chunk's audio as soon as it's made, and "done" after the last. A
 * hush drops everything up to the number it names, between chunks (a chunk takes a fraction of a second to make). The
 * audio goes to main, which hands it to the page that plays it (renderer/mic).
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { speechChunks } from "./tts";

type FromMain =
  | { type: "init"; model: string }
  | { type: "say"; id: number; text: string }
  | { type: "hush"; id: number };

/** `audio`: one chunk of `id`'s speech (mono, `rate` Hz); `done`: the last of it was sent; `failed`: it couldn't be said. */
export type TtsProcessMessage =
  | { type: "ready"; loadMs: number; rate: number }
  | { type: "error"; message: string }
  | { type: "audio"; id: number; samples: Float32Array; rate: number }
  | { type: "done"; id: number }
  | { type: "failed"; id: number; message: string };

/* eslint-disable @typescript-eslint/no-explicit-any -- sherpa-onnx ships untyped JS */
let tts: any = null;
let rate = 22_050;
let hushed = 0;
const queue: { id: number; chunks: string[] }[] = [];
let busy = false;

const parent = process.parentPort;
const send = (m: TtsProcessMessage) => parent.postMessage(m);

/** The voice's files in its folder (a Piper voice: one .onnx, tokens.txt, espeak-ng-data). */
function load(dir: string): any {
  const onnx = fs.readdirSync(dir).find(f => f.endsWith(".onnx"));
  if (!onnx) throw new Error(`no voice model in ${dir}`);
  const sherpa = createRequire(__filename)("sherpa-onnx") as any;
  const made = sherpa.createOfflineTts({
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: { model: path.join(dir, onnx), tokens: path.join(dir, "tokens.txt"), dataDir: path.join(dir, "espeak-ng-data"), noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 },
      numThreads: 1, provider: "cpu", debug: 0,
    },
    maxNumSentences: 1,
  });
  if (!made?.handle) throw new Error("Ember's voice couldn't be loaded.");
  return made;
}

/** Makes the next chunk, then lets messages in (a hush) before the one after. */
function step(): void {
  while (queue.length && queue[0].id <= hushed) queue.shift();
  const item = queue[0];
  if (!item || !tts) { busy = false; return; }
  busy = true;
  const chunk = item.chunks.shift();
  if (chunk !== undefined) {
    try {
      const audio = tts.generate({ text: chunk, sid: 0, speed: 1.0 }) as { samples: Float32Array; sampleRate: number };
      if (item.id > hushed && audio.samples.length) send({ type: "audio", id: item.id, samples: audio.samples, rate: audio.sampleRate });
    } catch (err) {
      // WebAssembly throws bare numbers: the rest of this reply goes unsaid (main lets the system's voice say it).
      queue.shift();
      send({ type: "failed", id: item.id, message: err instanceof Error ? err.message : `the voice failed (${String(err)})` });
      setImmediate(step);
      return;
    }
  }
  if (!item.chunks.length) {
    queue.shift();
    if (item.id > hushed) send({ type: "done", id: item.id });
  }
  setImmediate(step);
}

parent.on("message", e => {
  const m = e.data as FromMain;
  if (m.type === "init") {
    try {
      const t0 = Date.now();
      tts = load(m.model);
      rate = Number(tts.sampleRate) || rate;
      send({ type: "ready", loadMs: Date.now() - t0, rate });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : "Ember's voice couldn't be loaded." });
    }
    if (!busy) { busy = true; setImmediate(step); }
  } else if (m.type === "say") {
    const chunks = speechChunks(m.text);
    if (!chunks.length) { send({ type: "done", id: m.id }); return; }
    queue.push({ id: m.id, chunks });
    // On the next turn: a hush sent right after (a new answer cutting this one off) is heard first.
    if (!busy) { busy = true; setImmediate(step); }
  } else if (m.type === "hush") {
    hushed = Math.max(hushed, m.id);
  }
});
