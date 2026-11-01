// Downloads Ember's speech models (verified) for the voice tests and demos.
//   --tts-voice        also fetches a TTS voice (test-only; never shipped). With it the evaluation's missed-wakes gate
//                      speaks enough renderings of "Hey Ember" (in memory, new ones every run) to be measured.
//   --clips            also (with the TTS voice) synthesizes new test clips into <dir>/clips, a scratch folder.
//   --update-fixtures  as --clips, but into test/fixtures/voice, replacing the committed clips. The voice is random
//                      on every run, so new clips must pass the voice tests before they're committed (git restore
//                      test/fixtures/voice puts the old ones back); the committed clips keep the tests repeatable.
// Downloads (Node's https, honouring HTTPS_PROXY/NO_PROXY) and unpacking (app/voice/untar.ts) are the app's own, so
// no system curl, tar or bzip2 is needed on any OS.
// usage: node scripts/voice/prepare.mjs [dir] [--tts-voice] [--clips | --update-fixtures]   (default dir: .cache/voice)
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const FLAGS = ["--tts-voice", "--clips", "--update-fixtures"];
const unknown = args.filter(a => a.startsWith("--") && !FLAGS.includes(a));
if (unknown.length) {
  console.error(`unknown option ${unknown.join(", ")}\nusage: node scripts/voice/prepare.mjs [dir] [--tts-voice] [--clips | --update-fixtures]`);
  process.exit(2);
}
const dir = path.resolve(args.find(a => !a.startsWith("--")) ?? path.join(root, ".cache/voice"));
const updateFixtures = args.includes("--update-fixtures");
const makeClips = updateFixtures || args.includes("--clips");
const ttsVoice = makeClips || args.includes("--tts-voice");
const require = createRequire(import.meta.url);
fs.mkdirSync(dir, { recursive: true });

const bundle = path.join(dir, "models.cjs");
await build({ entryPoints: [path.join(root, "app/voice/models.ts")], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const { ensureModels, fetchModel, httpsDownloader } = require(bundle);
const models = path.join(dir, "models");
let last = -1;
await ensureModels(models, httpsDownloader, (done, total) => {
  const pct = Math.floor((done / total) * 100);
  if (pct !== last && pct % 10 === 0) { last = pct; console.log(`models ${pct}%`); }
});

if (!ttsVoice) {
  console.log(`models in ${models}`);
  process.exit(0);
}

// A TTS voice to speak the test lines (test-only; not shipped). The evaluation looks for it here.
const TTS_VOICE = {
  name: "TTS voice (test-only)", kind: "tar.bz2", target: "vits-piper-en_US-amy-low",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2",
  sha256: "c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639",
};
const ttsDir = path.join(dir, TTS_VOICE.target);
// Pinned and unpacked like the speech models: a failed download or unpack leaves nothing behind (a half-unpacked
// voice would be skipped next time).
if (!fs.existsSync(ttsDir)) await fetchModel(dir, TTS_VOICE, httpsDownloader);
if (!makeClips) {
  console.log(`models in ${models}\nTTS voice in ${ttsDir}`);
  process.exit(0);
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
  name_wake: "Ember, turn on night light.",
  embers: "The embers in the fireplace were still glowing.",
};
// Into a scratch folder unless the committed clips are to be replaced (--update-fixtures).
const clips = updateFixtures ? path.join(root, "test/fixtures/voice") : path.join(dir, "clips");
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
console.log(`models in ${models}\nTTS voice in ${ttsDir}\nclips in ${clips}${updateFixtures ? " (run the voice tests before committing them; git restore test/fixtures/voice puts the old ones back)" : ""}`);
