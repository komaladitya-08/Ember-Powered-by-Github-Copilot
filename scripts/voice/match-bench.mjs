// Measures Voice Match that keeps learning (app/voice/adapt.ts) on real speakers: false rejects (the owner turned
// away) and false accepts (another voice let in) with the enrolment's print alone and after learning from the owner's
// own requests, in the room they enrolled in and on another microphone (a narrower band with noise), and a
// drift attack: another speaker's samples crafted to sit just under, at and above the threshold, fed in hundreds of
// times, with adapt.ts's limits and without them. Prints a table, and the same as JSON for docs/ASSISTANT.md.
// The speakers: a folder of folders, one per speaker, of 16 kHz mono clips as raw 16-bit (.s16) or float (.f32) little
// endian, at least 24 a speaker (LibriSpeech dev-clean through ffmpeg: `ffmpeg -i x.flac -ac 1 -ar 16000 -f s16le x.s16`).
// Needs the voiceprint model from `node scripts/voice/prepare.mjs`.
// --cache <file> keeps the voiceprints (numbers only) between runs, for trying other limits without printing again.
//   usage: node scripts/voice/match-bench.mjs <speakers dir> [models dir] [--cache <file>]   (default models: .cache/voice/models)
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const cacheAt = argv.indexOf("--cache");
const cacheFile = cacheAt >= 0 ? argv[cacheAt + 1] : null;
const [speakersDir, modelsArg] = argv.filter((a, i) => !a.startsWith("--") && !(cacheAt >= 0 && i === cacheAt + 1));
if (!speakersDir) { console.error("usage: node scripts/voice/match-bench.mjs <speakers dir> [models dir] [--cache <file>]"); process.exit(2); }
const models = path.resolve(modelsArg ?? path.join(root, ".cache/voice/models"));
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-match-"));
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(root, "app/voice/voiceprint.ts"))};`,
  `export * from ${JSON.stringify(path.join(root, "app/voice/adapt.ts"))};`,
  `export { modelPaths } from ${JSON.stringify(path.join(root, "app/voice/models.ts"))};`,
].join("\n"));
const bundle = path.join(tmp, "bundle.cjs");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
const m = require(bundle);
const ort = require("onnxruntime-web");
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";
const session = await ort.InferenceSession.create(m.modelPaths(models).speaker, { executionProviders: ["wasm"] });
fs.rmSync(tmp, { recursive: true, force: true });
async function print(samples) {
  const { data, frames } = m.printFeatures(samples);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", data, [1, frames, 80]) });
  return m.unit(out[session.outputNames[0]].data);
}

/** A clip as floats in [-1, 1]. */
function read(file) {
  const b = fs.readFileSync(file);
  if (file.endsWith(".f32")) return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const s = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  return Float32Array.from(s, x => x / 32768);
}
/**
 * Another microphone and room: a narrower band (200 Hz to 5 kHz, one-pole filters, as a cheap headset or a laptop's
 * built-in microphone), 0.7 gain and noise 30 dB under the speech.
 */
function otherMic(x, seed) {
  let r = seed >>> 0;
  const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 2 ** 32 - 0.5; };
  const hp = Math.exp(-2 * Math.PI * 200 / 16000), lp = Math.exp(-2 * Math.PI * 5000 / 16000);
  const y = new Float32Array(x.length);
  let px = 0, hy = 0, ly = 0, power = 0;
  for (let i = 0; i < x.length; i++) power += x[i] * x[i];
  const noise = Math.sqrt(power / x.length) * 10 ** (-30 / 20) * Math.sqrt(12);
  for (let i = 0; i < x.length; i++) {
    hy = hp * (hy + x[i] - px); px = x[i];
    ly = (1 - lp) * hy + lp * ly;
    y[i] = 0.7 * ly + noise * rnd();
  }
  return y;
}
const cut = (x, s) => x.subarray(0, Math.min(x.length, Math.round(s * 16000)));

const speakers = fs.readdirSync(speakersDir).filter(d => fs.statSync(path.join(speakersDir, d)).isDirectory()).sort();
const T = m.VOICE_MATCH_THRESHOLD;
let data = [];
let n = 0;
const cached = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : null;
if (cached) data = cached.map(d => ({ s: d.s, anchor: Float32Array.from(d.anchor), clean: d.clean.map(p => Float32Array.from(p)), moved: d.moved.map(p => Float32Array.from(p)) }));
else for (const s of speakers) {
  const files = fs.readdirSync(path.join(speakersDir, s)).filter(f => /\.(s16|f32)$/.test(f)).sort().map(f => path.join(speakersDir, s, f));
  if (files.length < 24) continue;
  const clips = files.slice(0, 24).map(read);
  const enrol = [];
  for (const c of clips.slice(0, 4)) enrol.push(await print(cut(c, 3)));
  const clean = [], moved = [];
  for (let i = 4; i < 24; i++) {
    clean.push(await print(cut(clips[i], 2.5)));
    moved.push(await print(cut(otherMic(clips[i], i * 7919 + n), 2.5)));
  }
  data.push({ s, anchor: m.averagePrint(enrol), clean, moved });
  process.stderr.write(`\rprinted ${++n} speakers`);
}
process.stderr.write("\n");
if (cacheFile && !cached) fs.writeFileSync(cacheFile, JSON.stringify(data.map(d => ({ s: d.s, anchor: [...d.anchor], clean: d.clean.map(p => [...p]), moved: d.moved.map(p => [...p]) }))));
// Each speaker's 20 requests: the first 12 are what they say to Ember over time (learnt from), the last 8 are tested.
const LEARN = 12;

/** The gate as the voice process runs it (match.ts with adapt.ts): the learnt print's threshold, and the enrolment's floor. */
const accepts = (st, p, limits) => (limits?.naive ? m.similarity(p, st.print) >= T : m.gateMatches(p, st.print, m.adaptedThreshold(st.clips.length), st.clips.length ? st.anchor : null));
/** The owner's state after their requests (`which`: clean or moved) went through the gate and adapt(). */
function learnt(o, which, limits) {
  let st = m.fromEnrolment(o.anchor);
  let learntN = 0;
  for (const p of o[which].slice(0, LEARN)) {
    if (!accepts(st, p, limits)) continue; // turned away: nothing is learnt
    const r = m.adapt(st, p, m.similarity(p, st.print), limits);
    st = r.state;
    if (r.outcome === "learnt") learntN++;
  }
  return { st, learntN };
}
function rates(which, after, limits) {
  let fr = 0, frN = 0, fa = 0, faN = 0, learntN = 0, steps = 0;
  for (const o of data) {
    const { st, learntN: k } = after ? learnt(o, which, limits) : { st: m.fromEnrolment(o.anchor), learntN: 0 };
    learntN += k; steps += LEARN;
    for (const t of o[which].slice(LEARN)) { frN++; if (!accepts(st, t, limits)) fr++; }
    for (const x of data) if (x !== o) for (const t of x[which].slice(LEARN)) { faN++; if (accepts(st, t, limits)) fa++; }
  }
  return { frr: fr / frN, far: fa / faN, frN, faN, learnt: learntN / steps };
}
/** With no limits: learnt from anything the gate let in, no margin, step, anchor or raised threshold. */
const NAIVE = { naive: true, margin: 0, anchorMatch: -1, maxStep: 2, anchorMin: -1 };
const pct = x => `${(x * 100).toFixed(2)} %`;
const results = {
  speakers: data.length,
  clean: { before: rates("clean", false), after: rates("clean", true), naive: rates("clean", true, NAIVE) },
  otherMic: { before: rates("moved", false), after: rates("moved", true), naive: rates("moved", true, NAIVE) },
};

// How often a sample is good enough to learn from: the owner's requests at the margin, and others' that pass the gate.
let ownMargin = 0, ownN = 0, otherPass = 0, otherMargin = 0, otherN = 0;
for (const o of data) {
  for (const p of o.clean) { ownN++; if (m.similarity(p, o.anchor) >= T + m.ADAPT.margin) ownMargin++; }
  for (const x of data) if (x !== o) for (const p of x.clean) {
    otherN++;
    const sc = m.similarity(p, o.anchor);
    if (sc >= T) otherPass++;
    if (sc >= T + m.ADAPT.margin) otherMargin++;
  }
}
results.samples = { ownAtMargin: ownMargin / ownN, otherAccepted: otherPass / otherN, otherAtMargin: otherMargin / otherN, otherAtMarginN: otherMargin, otherN };

/**
 * The drift attack: for each owner, each other speaker in turn crafts samples that are part their voice and part the
 * print in use, to score exactly `at` against it (just under the threshold, at it, or just over the margin), and feeds
 * `rounds` of them; then their real requests are tried. `naive`: learnt from anything the gate let in, with no margin,
 * step or anchor limit.
 */
function attack(at, rounds, naive) {
  let let_in = 0, tried = 0, moved = 0;
  const limits = naive ? NAIVE : undefined;
  for (const o of data) {
    for (const a of data) {
      if (a === o) continue;
      let st = m.fromEnrolment(o.anchor);
      const voice = m.averagePrint(a.clean.slice(0, LEARN));
      for (let r = 0; r < rounds; r++) {
        // `at` above the gate's own threshold for the print now (which rises as it learns).
        const sample = m.towards(st.print, voice, Math.min(1, (naive ? T : m.adaptedThreshold(st.clips.length)) + at));
        if (!accepts(st, sample, limits)) continue; // the gate turned it away
        st = m.adapt(st, sample, m.similarity(sample, st.print), limits).state;
      }
      moved += 1 - m.similarity(st.print, o.anchor);
      for (const t of a.clean.slice(LEARN)) { tried++; if (accepts(st, t, limits)) let_in++; }
    }
  }
  return { far: let_in / tried, tried, drift: moved / (data.length * (data.length - 1)) };
}
const ROUNDS = 200;
results.drift = {
  rounds: ROUNDS,
  baseline: rates("clean", false).far,
  underThreshold: { guarded: attack(-0.01, ROUNDS, false), naive: attack(-0.01, ROUNDS, true) },
  atThreshold: { guarded: attack(0.005, ROUNDS, false), naive: attack(0.005, ROUNDS, true) },
  overMargin: { guarded: attack(m.ADAPT.margin + 0.005, ROUNDS, false), naive: attack(m.ADAPT.margin + 0.005, ROUNDS, true) },
};

console.log(`Voice Match on ${results.speakers} speakers (threshold ${T}, margin ${m.ADAPT.margin}, raise ${m.ADAPT.raise}, floor ${m.ADAPT.anchorFloor}, ${LEARN} requests learnt from, 8 tested each)`);
for (const [k, label] of [["clean", "same room"], ["otherMic", "another microphone"]]) {
  const r = results[k];
  console.log(`  ${label.padEnd(20)} before: FRR ${pct(r.before.frr)}  FAR ${pct(r.before.far)}   after: FRR ${pct(r.after.frr)}  FAR ${pct(r.after.far)}  (learnt from ${pct(r.after.learnt)} of requests)   no limits: FRR ${pct(r.naive.frr)}  FAR ${pct(r.naive.far)}`);
}
console.log(`  samples: own at the margin ${pct(results.samples.ownAtMargin)}, others let in ${pct(results.samples.otherAccepted)}, others at the margin ${pct(results.samples.otherAtMargin)} (${results.samples.otherAtMarginN} of ${results.samples.otherN})`);
console.log(`  drift attack (${ROUNDS} crafted samples per pair, attacker's real requests then tried; baseline FAR ${pct(results.drift.baseline)}):`);
for (const k of ["underThreshold", "atThreshold", "overMargin"]) {
  const d = results.drift[k];
  console.log(`    ${k.padEnd(15)} guarded FAR ${pct(d.guarded.far)} (drift ${d.guarded.drift.toFixed(3)})   naive FAR ${pct(d.naive.far)} (drift ${d.naive.drift.toFixed(3)})`);
}
console.log(JSON.stringify(results));
