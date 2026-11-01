// Times Ember's speech on this computer, on the build Ember picks (sherpa-onnx's native addon on Windows and macOS,
// WebAssembly elsewhere) and on WebAssembly: listening (the wake clip through the spotter, both VADs and Moonshine),
// the Piper voice on 1 and 2 threads, and Kokoro (the natural voice) on 2, 3 and 4 threads with each provider this
// computer can try. Run it as the computer usually is (other apps open): a real-time factor (rtf) below 1 keeps up;
// Kokoro speaks in Ember only at 0.5 or less. Prints a table, and the same as JSON for pasting into an issue.
// Needs the models from `node scripts/voice/prepare.mjs`; --kokoro also fetches Kokoro (320 MB, verified) into the
// same folder.
//   usage: node scripts/voice/bench.mjs [--kokoro] [models dir]   (default: .cache/voice/models)
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const withKokoro = args.includes("--kokoro");
const models = path.resolve(args.find(a => !a.startsWith("--")) ?? path.join(root, ".cache/voice/models"));
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-bench-"));

// The app's own modules, bundled as prepare.mjs does (sherpa-onnx and its addon stay external: loaded from node_modules).
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(root, "app/voice/runtime.ts"))};`,
  `export { sherpaBackend } from ${JSON.stringify(path.join(root, "app/voice/sherpa.ts"))};`,
  `export { VoiceEngine } from ${JSON.stringify(path.join(root, "app/voice/engine.ts"))};`,
  `export { modelPaths, ensureModel, NATURAL_VOICE, httpsDownloader } from ${JSON.stringify(path.join(root, "app/voice/models.ts"))};`,
  `export { piperSpec, kokoroSpec } from ${JSON.stringify(path.join(root, "app/voice/tts-spec.ts"))};`,
].join("\n"));
const bundle = path.join(root, "node_modules", ".ember-bench.cjs");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error", external: ["sherpa-onnx", "sherpa-onnx-*"] });
const m = require(bundle);
fs.rmSync(tmp, { recursive: true, force: true });

const paths = m.modelPaths(models);
if (!fs.existsSync(paths.asr) || !fs.existsSync(paths.tts)) {
  console.error(`no speech models in ${models}: run node scripts/voice/prepare.mjs first`);
  process.exit(1);
}
if (withKokoro && !fs.existsSync(paths.natural)) {
  console.log(`fetching Kokoro (${Math.round(m.NATURAL_VOICE.bytes / 1e6)} MB) into ${models}…`);
  await m.ensureModel(models, m.NATURAL_VOICE, m.httpsDownloader);
}

const rows = [];
const add = row => { rows.push(row); console.log(`  ${row.what.padEnd(46)} ${row.build.padEnd(7)} ${String(row.provider).padEnd(7)} ${String(row.threads).padStart(2)}  rtf ${row.rtf.toFixed(3)}${row.firstMs !== undefined ? `  first audio ${row.firstMs} ms` : ""}${row.loadMs !== undefined ? `  load ${row.loadMs} ms` : ""}`); };

/** 16-bit mono WAV → floats. */
function readWav(file) {
  const b = fs.readFileSync(file);
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === "data") { const out = new Float32Array(size / 2); for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(at + 8 + i * 2) / 32768; return out; }
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${file}`);
}

const picked = m.sherpaRuntime().backend;
console.log(`${os.cpus()[0]?.model ?? "cpu"}, ${os.availableParallelism()} threads, ${process.platform}-${process.arch}, load average ${os.loadavg().map(x => x.toFixed(1)).join(" ")}`);
console.log(`Ember picks: ${picked} (${m.sherpaRuntime().detail})\n`);

// Listening: the wake clip and 2 s of silence through the engine, as the microphone sends it (32 ms frames).
const clip = readWav(path.join(root, "test/fixtures/voice/wake.wav"));
for (const prefer of picked === "native" ? ["native", "wasm"] : ["wasm"]) {
  const t0 = performance.now();
  const backend = m.sherpaBackend(paths, { runtime: { prefer } });
  const loadMs = Math.round(performance.now() - t0);
  const audio = new Float32Array(clip.length + 32_000);
  audio.set(clip);
  let t = 0, heard = "";
  const engine = new m.VoiceEngine(backend, e => { if (e.type === "utterance") heard = e.text; }, { now: () => t });
  const c0 = performance.now();
  for (let i = 0; i + 512 <= audio.length; i += 512) { engine.feed(audio.subarray(i, i + 512)); t += 32; }
  const rtf = (performance.now() - c0) / (audio.length / 16);
  add({ what: `listening ("${heard || "nothing heard"}")`, build: backend.info.backend, provider: backend.info.provider, threads: backend.info.threads, rtf, loadMs });
}

const SENTENCES = ["I opened the terminal,", "ran the tests, and all twenty-four of them passed on the first try.", "Night Light is on."];
/** One voice: its load time, the first chunk's time (the first words' delay) and the real-time factor over three sentences. */
function speak(what, prefer, spec, provider, threads, sid) {
  const sherpa = m.sherpaRuntime({ prefer });
  if (sherpa.backend !== prefer) return;
  let tts;
  const t0 = performance.now();
  try { tts = sherpa.createTts(spec, { provider, numThreads: threads }, 1); } catch (err) { console.log(`  ${what} ${provider}: couldn't load (${String(err?.message ?? err).split("\n")[0]})`); return; }
  const loadMs = Math.round(performance.now() - t0);
  tts.generate({ text: "Hello.", sid, speed: 1 });
  let ms = 0, seconds = 0, firstMs;
  for (const text of SENTENCES) {
    const a = performance.now();
    const out = tts.generate({ text, sid, speed: 1 });
    const took = performance.now() - a;
    firstMs ??= Math.round(took);
    ms += took; seconds += out.samples.length / out.sampleRate;
  }
  add({ what, build: sherpa.backend, provider, threads, rtf: ms / 1000 / seconds, firstMs, loadMs });
}

const piper = m.piperSpec(paths.tts);
for (const n of [1, 2]) speak("Ember's voice (Piper Kristin)", "native", piper, "cpu", n, 0);
speak("Ember's voice (Piper Kristin)", "wasm", piper, "cpu", 1, 0);
if (fs.existsSync(paths.natural)) {
  const kokoro = m.kokoroSpec(paths.natural);
  for (const provider of m.providers("native", process.platform, process.env, { gpu: true })) {
    for (const n of [2, 3, 4]) speak(`natural voice (Kokoro ${path.basename(paths.natural)})`, "native", kokoro, provider, n, 1);
  }
} else {
  console.log("\n  (Kokoro not timed: run with --kokoro to fetch it, 320 MB)");
}
console.log(`\n${JSON.stringify({ cpu: os.cpus()[0]?.model, threads: os.availableParallelism(), platform: `${process.platform}-${process.arch}`, rows })}`);
fs.rmSync(bundle, { force: true });
