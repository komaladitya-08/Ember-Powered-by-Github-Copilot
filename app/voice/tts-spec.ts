/**
 * Where a voice's files are in its folder (Piper, Kokoro), for the speech process (tts-process.ts) and
 * scripts/voice/bench.mjs. Nothing here loads a model.
 */

import fs from "node:fs";
import path from "node:path";
import type { TtsSpec } from "./runtime";

/** A Piper voice's files in its folder: one .onnx, tokens.txt, espeak-ng-data. */
export function piperSpec(dir: string): TtsSpec {
  const onnx = fs.readdirSync(dir).find(f => f.endsWith(".onnx"));
  if (!onnx) throw new Error(`no voice model in ${dir}`);
  return { kind: "vits", model: path.join(dir, onnx), tokens: path.join(dir, "tokens.txt"), dataDir: path.join(dir, "espeak-ng-data"), noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 };
}

/** Kokoro's files in its folder: model(.int8).onnx, voices.bin, tokens.txt, espeak-ng-data, and v1.0's US English lexicon. */
export function kokoroSpec(dir: string): TtsSpec {
  const model = ["model.onnx", "model.int8.onnx"].find(f => fs.existsSync(path.join(dir, f)));
  if (!model) throw new Error(`no voice model in ${dir}`);
  const lexicon = path.join(dir, "lexicon-us-en.txt");
  const multi = fs.existsSync(lexicon);
  return { kind: "kokoro", model: path.join(dir, model), voices: path.join(dir, "voices.bin"), tokens: path.join(dir, "tokens.txt"), dataDir: path.join(dir, "espeak-ng-data"), lexicon: multi ? lexicon : "", lang: multi ? "en-us" : "", lengthScale: 1.0 };
}

/** Kokoro's speaker (af_heart in kokoro-multi-lang v1.0's voices.bin; af_bella in kokoro-en v0.19's). */
const KOKORO_SID: Record<string, number> = { "kokoro-int8-multi-lang-v1_0": 3, "kokoro-multi-lang-v1_0": 3, "kokoro-en-v0_19": 1, "kokoro-int8-en-v0_19": 1 };

/** Kokoro's speaker for the model in `dir` (by its folder's name; 0 for one not listed). */
export function kokoroSpeaker(dir: string): number {
  return KOKORO_SID[path.basename(dir)] ?? 0;
}
