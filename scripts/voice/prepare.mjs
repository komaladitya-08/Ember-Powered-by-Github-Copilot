// Downloads Ember's speech models (verified) and synthesizes test clips with a
// local TTS voice, for the voice tests and demos. Nothing here ships with Ember.
// usage: node scripts/voice/prepare.mjs [dir]   (default: .cache/voice)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const dir = path.resolve(process.argv[2] ?? path.join(root, ".cache/voice"));
const require = createRequire(import.meta.url);
fs.mkdirSync(dir, { recursive: true });

const bundle = path.join(dir, "models.cjs");
await build({ entryPoints: [path.join(root, "app/voice/models.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { ensureModels, curlDownloader } = require(bundle);
const models = path.join(dir, "models");
let last = -1;
await ensureModels(models, curlDownloader, (done, total) => {
  const pct = Math.floor((done / total) * 100);
  if (pct !== last && pct % 10 === 0) { last = pct; console.log(`models ${pct}%`); }
});

// A TTS voice to speak the test lines (test-only; not shipped).
const ttsDir = path.join(dir, "vits-piper-en_US-amy-low");
if (!fs.existsSync(ttsDir)) {
  const tar = path.join(dir, "tts.tar.bz2");
  execFileSync("curl", ["-sSfL", "--retry", "3", "-o", tar, "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2"]);
  execFileSync("tar", ["-xjf", tar, "-C", dir]);
  fs.rmSync(tar);
}
const sherpa = require("sherpa-onnx");
const tts = sherpa.createOfflineTts({
  offlineTtsModelConfig: { offlineTtsVitsModelConfig: { model: `${ttsDir}/en_US-amy-low.onnx`, tokens: `${ttsDir}/tokens.txt`, dataDir: `${ttsDir}/espeak-ng-data` }, numThreads: 1, debug: 0 },
  maxNumSentences: 1,
});
export const CLIPS = {
  wake: "Hey Ember, turn on night light.",
  wake_pause: "Hey Ember.|Make the text bigger please.",
  stop: "Ember, stop!",
  amber: "Hey Amber, what time is it?",
  remember: "I remember the September weather was nice.",
  chat: "Let's meet at the station after lunch.",
  followup: "And turn on do not disturb too.",
  dnd: "Hey Ember, turn on do not disturb.",
  bigger: "And make the text a bit bigger.",
};
const clips = path.join(dir, "clips");
fs.mkdirSync(clips, { recursive: true });
for (const [name, text] of Object.entries(CLIPS)) {
  const parts = text.split("|").map(t => tts.generate({ text: t, sid: 0, speed: 1.0 }).samples);
  const gap = new Float32Array(16000 * 0.9);
  const lead = new Float32Array(16000 * 0.6);
  const pieces = [lead, ...parts.flatMap((p, i) => (i ? [gap, p] : [p])), lead];
  const samples = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) { samples.set(p, at); at += p.length; }
  sherpa.writeWave(path.join(clips, `${name}.wav`), { samples, sampleRate: 16000 });
}
fs.writeFileSync(path.join(clips, "clips.json"), JSON.stringify(CLIPS, null, 2) + "\n");
console.log(`models in ${models}\nclips in ${clips}`);
