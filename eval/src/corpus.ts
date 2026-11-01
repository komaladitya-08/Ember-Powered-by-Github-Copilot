/**
 * Real voices for the wake-word gates (gates.ts) and the threshold tuner (tune.ts): the folders
 * scripts/voice/record.mjs writes, one per speaker, each with a manifest.json of its clips (what was read, whether it
 * should wake Ember, whether it is a stop). Clips are read as 16 kHz mono (resampled if they aren't).
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export interface CorpusClip { speaker: string; file: string; text: string; label: "positive" | "negative"; wakes: boolean; stops: boolean; bare: boolean; samples: Float32Array }

/** The corpus folder: EMBER_VOICE_CORPUS, else <voice dir>/corpus; null when it holds no speaker. */
export function corpusDir(voiceDir: string): string | null {
  const dir = path.resolve(process.env.EMBER_VOICE_CORPUS ?? path.join(voiceDir, "corpus"));
  try {
    return fs.readdirSync(dir).some(s => fs.existsSync(path.join(dir, s, "manifest.json"))) ? dir : null;
  } catch {
    return null;
  }
}

export function loadCorpus(dir: string): CorpusClip[] {
  const sherpa = createRequire(__filename)("sherpa-onnx");
  const out: CorpusClip[] = [];
  for (const speaker of fs.readdirSync(dir).sort()) {
    const mf = path.join(dir, speaker, "manifest.json");
    if (!fs.existsSync(mf)) continue;
    const m = JSON.parse(fs.readFileSync(mf, "utf8")) as { clips: { file: string; text: string; label: "positive" | "negative"; wakes?: boolean; stops?: boolean }[] };
    for (const c of m.clips) {
      const file = path.join(dir, speaker, c.file);
      if (!fs.existsSync(file)) continue;
      const w = sherpa.readWave(file) as { samples: Float32Array; sampleRate: number };
      const samples = w.sampleRate === 16000 ? w.samples : resample(w.samples, w.sampleRate);
      out.push({ speaker, file: c.file, text: c.text, label: c.label, wakes: c.wakes ?? (c.label === "positive"), stops: c.stops ?? false, bare: /^\W*ember\b/i.test(c.text), samples });
    }
  }
  return out;
}

function resample(x: Float32Array, from: number): Float32Array {
  const n = Math.round((x.length * 16000) / from), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = (i * from) / 16000, a = Math.floor(t), f = t - a; out[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? 0) * f; }
  return out;
}
