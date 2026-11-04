// Times Ember's default speech on this computer: listening on its selected backend and WebAssembly, plus the native
// Kitten Nano voice on one CPU thread. Optional Kokoro is included only with --kokoro, even when it is already cached.
// Each case runs in a fresh process, reporting wall RTF, CPU work and whole-process loaded/peak RSS (Node/runtime
// included). Run it as the computer usually is; the production neural voice's measured RTF gate is at most 0.5.
// Needs the default models from `node scripts/voice/prepare.mjs`; --kokoro also fetches the pinned optional model.
// On Linux, EMBER_SHERPA_CAPI=<folder from fetch-capi.mjs> times the C API as the native build. Where native speech is
// unavailable, only listening is benchmarked: the app speaks with the local OS voice, never neural speech in WASM.
// usage: node scripts/voice/bench.mjs [--kokoro] [models dir]   (default: .cache/voice/models)
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const withKokoro = args.includes("--kokoro");
const unknown = args.filter(a => a.startsWith("--") && a !== "--kokoro");
if (unknown.length) { console.error(`unknown option ${unknown.join(", ")}\nusage: node scripts/voice/bench.mjs [--kokoro] [models dir]`); process.exit(2); }
const models = path.resolve(args.find(a => !a.startsWith("--")) ?? path.join(root, ".cache/voice/models"));
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-bench-"));

// The app's own modules, bundled as prepare.mjs does (sherpa-onnx and its addon stay external: loaded from node_modules).
const entry = path.join(tmp, "entry.ts");
fs.writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(root, "app/voice/runtime.ts"))};`,
  `export { sherpaBackend } from ${JSON.stringify(path.join(root, "app/voice/sherpa.ts"))};`,
  `export { VoiceEngine } from ${JSON.stringify(path.join(root, "app/voice/engine.ts"))};`,
  `export { modelPaths, ensureModel, NATURAL_VOICE, DEFAULT_VOICE, httpsDownloader } from ${JSON.stringify(path.join(root, "app/voice/models.ts"))};`,
  `export { kittenSpec, kokoroSpec, kokoroSpeaker } from ${JSON.stringify(path.join(root, "app/voice/tts-spec.ts"))};`,
].join("\n"));
const bundle = path.join(root, "node_modules", `.ember-bench-${process.pid}.cjs`);
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "error", external: ["sherpa-onnx", "sherpa-onnx-*", "koffi"] });
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
/** Every engine runs in a new process: model memory and CPU work cannot accumulate across cases. */
function run(job) {
  const child = spawnSync(process.execPath, [path.join(root, "scripts/voice/bench-case.mjs"), bundle, models, JSON.stringify(job)], { encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 ** 2 });
  const line = child.stdout?.split("\n").find(line => line.startsWith("EMBER_BENCH_RESULT "));
  if (child.status !== 0 || !line) throw new Error(`speech benchmark failed (${job.kind}, ${job.build}): ${child.error?.message ?? child.stderr ?? child.status}`);
  const row = JSON.parse(line.slice("EMBER_BENCH_RESULT ".length));
  rows.push(row);
  console.log(`  ${row.what.padEnd(46)} ${row.build.padEnd(7)} ${String(row.provider).padEnd(7)} ${String(row.threads).padStart(2)}  rtf ${row.rtf.toFixed(3)}  CPU ${row.cpuMs} ms  RSS ${row.loadedRssMiB} MiB (peak ${row.peakRssMiB})${row.firstMs !== undefined ? `  first audio ${row.firstMs} ms` : ""}  load ${row.loadMs} ms`);
}

// EMBER_SHERPA_CAPI: the native build is sherpa-onnx's C API in that folder (app/voice/capi.ts; Linux: fetch-capi.mjs).
const capiDir = process.env.EMBER_SHERPA_CAPI;
const nativeOpts = capiDir ? { capiDir } : {};
const picked = m.sherpaRuntime(nativeOpts).backend;
console.log(`${os.cpus()[0]?.model ?? "cpu"}, ${os.availableParallelism()} threads, ${process.platform}-${process.arch}, load average ${os.loadavg().map(x => x.toFixed(1)).join(" ")}`);
console.log(`Ember picks: ${picked} (${m.sherpaRuntime(nativeOpts).detail})\n`);

// Listening: the wake clip and 2 s of silence through the engine, as the microphone sends it (32 ms frames).
for (const build of picked === "native" ? ["native", "wasm"] : ["wasm"]) {
  run({ kind: "listening", build, clip: path.join(root, "test/fixtures/voice/wake.wav") });
}
if (picked === "native") run({ kind: "kitten", build: "native", provider: "cpu", threads: 1 });
else console.log("\n  (Default Kitten not timed: native speech is unavailable; the app uses a local system voice.)");
if (withKokoro && picked === "native" && fs.existsSync(paths.natural)) {
  for (const provider of m.providers("native", process.platform, process.env, { gpu: true })) {
    for (const n of [2, 3, 4]) run({ kind: "kokoro", build: "native", provider, threads: n });
  }
} else {
  console.log("\n  (Kokoro not timed: requires explicit --kokoro and native speech.)");
}
console.log(`\n${JSON.stringify({ cpu: os.cpus()[0]?.model, threads: os.availableParallelism(), platform: `${process.platform}-${process.arch}`, rows })}`);
fs.rmSync(bundle, { force: true });
