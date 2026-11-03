// Measures personal vocabulary for recognition (app/main/personal/correct.ts): word error rate of Moonshine's
// transcripts as Ember hears them, before and after correction against a personal lexicon (installed apps' names, the
// names the user asked Ember to remember), and after the user taught it what it got wrong once ("That's not what I
// said": learnt from a first take of each request, measured on a second take in the same voice). The clips: the voice tests' own (they must
// come out unchanged), and requests with app and people's names synthesised in two voices (in memory, never saved).
// Counts reference words helped and harmed separately. Prints a table and the same as JSON for docs/ASSISTANT.md.
// Needs the models and the test-only TTS voice from `node scripts/voice/prepare.mjs --tts-voice --voice ryan`.
//   usage: node scripts/voice/words-bench.mjs [voice dir] [--show]   (default: .cache/voice; --show prints each name clip it got wrong)
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.resolve(process.argv.slice(2).find(a => !a.startsWith("--")) ?? path.join(root, ".cache/voice"));
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-words-"));
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, [
  `export { sherpaBackend } from ${JSON.stringify(path.join(root, "app/voice/sherpa.ts"))};`,
  `export { modelPaths } from ${JSON.stringify(path.join(root, "app/voice/models.ts"))};`,
  `export { correctTranscript, learnFrom } from ${JSON.stringify(path.join(root, "app/main/personal/correct.ts"))};`,
  `export { isRiskyLabel } from ${JSON.stringify(path.join(root, "app/main/policy/policy.ts"))};`,
  `export { recognitionScore } from ${JSON.stringify(path.join(root, "scripts/voice/word-errors.ts"))};`,
].join("\n"));
// Beside node_modules, so sherpa-onnx (left out of the bundle) is found as bench.mjs finds it.
const bundle = path.join(root, "node_modules", ".ember-words-bench.cjs");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error", external: ["sherpa-onnx", "sherpa-onnx-*", "koffi"] });
const m = require(bundle);
const sherpa = require("sherpa-onnx");
const models = path.join(dir, "models");
const backend = m.sherpaBackend(m.modelPaths(models), { monitor: false, runtime: { prefer: "wasm" } });
const risky = w => m.isRiskyLabel(w, "linux");

/** The installed apps and the remembered names the lexicon holds (as a user's might). */
const APPS = ["Spotify", "Thunderbird", "LibreOffice Calc", "LibreOffice Writer", "Visual Studio Code", "GIMP", "Inkscape", "Rhythmbox", "Nautilus", "Firefox", "Slack", "Zoom", "Obsidian", "Evolution", "Cheese", "Calculator", "Settings", "Files", "Text Editor", "Terminal"];
const PEOPLE = ["Priya", "Siobhan", "Anjali", "Joaquin", "Saoirse", "Mehmet", "Nguyen", "Kofi", "Aoife", "Ravi"];
const lexicon = (learned = []) => ({ entries: [...APPS.map(text => ({ text, source: "app" })), ...PEOPLE.map(text => ({ text, source: "memory" }))], learned });
/** Requests with those names, as people say them to Ember. */
const NAMED = [
  "Open Spotify and play something calm.", "Open Thunderbird.", "Start LibreOffice Calc.", "Open Visual Studio Code.", "Open GIMP.",
  "Open Inkscape please.", "Play my music in Rhythmbox.", "Open Nautilus.", "Open Obsidian.", "Open Slack.",
  "Remind me to call Priya at five.", "Ask Siobhan about the budget.", "Message Anjali that I'm running late.",
  "When is my meeting with Joaquin?", "Remind me to thank Saoirse tomorrow.", "Find the notes from Mehmet.",
  "What did Nguyen say about the launch?", "Set up a call with Kofi.", "Remind me Aoife's birthday is Friday.", "Open the report Ravi sent.",
];
const REPEATED = ["Find the New York, New York office.", "Write go team, go team in the note.", "Say very, very clearly."];

function readWav(file) { return sherpa.readWave(file).samples; }
const clips = [];
for (const [where, voice] of [[path.join(root, "test/fixtures/voice"), "amy"], [path.join(dir, "clips-ryan"), "ryan"]]) {
  if (!fs.existsSync(path.join(where, "clips.json"))) continue;
  for (const [name, text] of Object.entries(JSON.parse(fs.readFileSync(path.join(where, "clips.json"), "utf8")))) {
    clips.push({ set: "voice tests", voice, ref: text.replace("|", " "), audio: readWav(path.join(where, `${name}.wav`)) });
  }
}
const ttsVoices = [
  ["ryan", path.join(dir, "vits-piper-en_US-ryan-low"), "en_US-ryan-low.onnx", 1.0],
  ["kristin", path.join(models, "vits-piper-en_US-kristin-medium"), "en_US-kristin-medium.onnx", 1.1],
].filter(([, d]) => fs.existsSync(d));
for (const [voice, d, model, speed] of ttsVoices) {
  const tts = sherpa.createOfflineTts({ offlineTtsModelConfig: { offlineTtsVitsModelConfig: { model: path.join(d, model), tokens: path.join(d, "tokens.txt"), dataDir: path.join(d, "espeak-ng-data") }, numThreads: 1, debug: 0 }, maxNumSentences: 1 });
  // Two takes of each (the voices vary from one rendering to the next, as a person does): the user corrects the first
  // take's misses, the second is measured.
  for (const [set, prompts] of [["taught", NAMED], ["names", NAMED], ["repetitions", REPEATED]]) for (const ref of prompts) {
    const g = tts.generate({ text: ref, sid: 0, speed: speed * (set === "taught" ? 1 : 0.95) });
    // At 16 kHz, as the microphone's frames come (the voices speak at 16 or 22.05 kHz).
    const rate = g.sampleRate;
    const audio = rate === 16000 ? g.samples : Float32Array.from({ length: Math.floor(g.samples.length * 16000 / rate) }, (_, i) => g.samples[Math.floor(i * rate / 16000)]);
    clips.push({ set, voice, ref, audio });
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

for (const c of clips) c.raw = backend.transcribe(c.audio);
// Each voice's owner corrects what the first take got wrong ("That's not what I said"); the second take is measured
// with what their Ember learnt.
const learnedBy = new Map();
for (const c of clips) if (c.set === "taught" && m.recognitionScore(c.ref, c.raw).errors) { const l = m.learnFrom(c.raw, c.ref, risky); if (l) learnedBy.set(c.voice, [...(learnedBy.get(c.voice) ?? []), l]); }
const learned = [...learnedBy.values()].flat();

const sum = (set, pick) => {
  const total = { errors: 0, words: 0, harmed: 0, improved: 0 };
  for (const c of clips.filter(set)) {
    const score = m.recognitionScore(c.ref, c.raw, pick(c));
    for (const key of Object.keys(total)) total[key] += score[key];
  }
  return { ...total, wer: total.words ? total.errors / total.words : 0 };
};
const lex = lexicon();
const lexOf = c => lexicon(learnedBy.get(c.voice) ?? []);
const results = {};
for (const [name, set] of [["voice tests", c => c.set === "voice tests"], ["names (all voices)", c => c.set === "names"], ["intentional repeats", c => c.set === "repetitions"], ...ttsVoices.map(([v]) => [`names (${v})`, c => c.set === "names" && c.voice === v])]) {
  results[name] = {
    raw: sum(set, c => c.raw),
    lexicon: sum(set, c => m.correctTranscript(c.raw, lex, risky).text),
    learnt: sum(set, c => m.correctTranscript(c.raw, lexOf(c), risky).text),
  };
}
results.taught = learned.length;
const pct = x => `${(x * 100).toFixed(1)} %`;
console.log(`Word error rate (${clips.filter(c => c.set !== "taught").length} clips measured; ${learned.length} corrections taught from the first takes' misses)`);
for (const [k, r] of Object.entries(results)) {
  if (typeof r !== "object") continue;
  console.log(`  ${k.padEnd(20)} raw ${pct(r.raw.wer)}   lexicon ${pct(r.lexicon.wer)} (helped ${r.lexicon.improved}, harmed ${r.lexicon.harmed})   + taught ${pct(r.learnt.wer)} (helped ${r.learnt.improved}, harmed ${r.learnt.harmed})   of ${r.raw.words} words`);
}
for (const c of clips.filter(c => c.set === "names" || c.set === "repetitions")) {
  const fixed = m.correctTranscript(c.raw, lexOf(c), risky).text;
  if (process.argv.includes("--show") && (m.recognitionScore(c.ref, c.raw).errors || fixed !== c.raw)) console.log(`    [${c.voice}] ${c.ref}  |  ${c.raw}  →  ${fixed}`);
}
console.log(JSON.stringify(results));
