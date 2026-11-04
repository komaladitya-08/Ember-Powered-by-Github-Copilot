// Runs one speech benchmark in a fresh process: WASM memory never shrinks, so sharing a process across voices would
// charge earlier models to later ones. Called by bench.mjs; measures whole-process RSS (including Node/runtime), CPU
// work and wall time separately. Uses only the repository's synthetic fixture or generated speech, never a mic.
// usage: node scripts/voice/bench-case.mjs <bundle> <models> <JSON case>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [bundle, models, raw] = process.argv.slice(2);
const job = JSON.parse(raw);
const m = createRequire(import.meta.url)(bundle);
const paths = m.modelPaths(models);
const runtime = { prefer: job.build, ...(job.build === "native" && process.env.EMBER_SHERPA_CAPI ? { capiDir: process.env.EMBER_SHERPA_CAPI } : {}) };
const round = value => Math.round(value * 10) / 10;
const cpuMs = start => { const c = process.cpuUsage(start); return round((c.user + c.system) / 1000); };
const rssMiB = () => round(process.memoryUsage().rss / 1024 ** 2);
const baselineRssMiB = rssMiB();
const t0 = performance.now(), c0 = process.cpuUsage();
let row;

if (job.kind === "listening") {
  const backend = m.sherpaBackend(paths, { runtime });
  const loadMs = Math.round(performance.now() - t0), loadCpuMs = cpuMs(c0), loadedRssMiB = rssMiB();
  try {
    const b = fs.readFileSync(job.clip);
    let clip;
    for (let at = 12; at + 8 <= b.length;) {
      const id = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4);
      if (id === "data") { clip = Float32Array.from({ length: size / 2 }, (_, i) => b.readInt16LE(at + 8 + i * 2) / 32768); break; }
      at += 8 + size + (size & 1);
    }
    if (!clip) throw new Error(`no audio in ${job.clip}`);
    const audio = new Float32Array(clip.length + 32_000);
    audio.set(clip);
    let t = 0, heard = "";
    const engine = new m.VoiceEngine(backend, e => { if (e.type === "utterance") heard = e.text; }, { now: () => t });
    const start = performance.now(), cpu = process.cpuUsage();
    for (let i = 0; i + 512 <= audio.length; i += 512) { engine.feed(audio.subarray(i, i + 512)); t += 32; }
    row = { what: `listening ("${heard || "nothing heard"}")`, build: backend.info.backend, provider: backend.info.provider, threads: backend.info.threads,
      rtf: (performance.now() - start) / (audio.length / 16), cpuMs: cpuMs(cpu), audioSeconds: round(audio.length / 16_000), loadMs, loadCpuMs, loadedRssMiB };
  } finally { backend.free(); }
} else {
  const sherpa = m.sherpaRuntime(runtime);
  if (sherpa.backend !== job.build) throw new Error(`${job.build} unavailable: ${sherpa.detail}`);
  if (job.kind !== "kitten" && job.kind !== "kokoro") throw new Error(`unknown speech benchmark ${job.kind}`);
  const natural = job.kind === "kokoro";
  const spec = natural ? m.kokoroSpec(paths.natural) : m.kittenSpec(paths.tts);
  const speaker = natural ? m.kokoroSpeaker(paths.natural) : 0;
  const tts = sherpa.createTts(spec, { provider: job.provider, numThreads: job.threads }, 1);
  const loadMs = Math.round(performance.now() - t0), loadCpuMs = cpuMs(c0);
  try {
    tts.generate({ text: "Hello.", sid: speaker, speed: 1 });
    const loadedRssMiB = rssMiB(), cpu = process.cpuUsage();
    let ms = 0, seconds = 0, firstMs;
    for (const text of ["I opened the terminal,", "ran the tests, and all twenty-four of them passed on the first try.", "Night Light is on."]) {
      const start = performance.now();
      const out = tts.generate({ text, sid: speaker, speed: 1 });
      const took = performance.now() - start;
      firstMs ??= Math.round(took);
      ms += took; seconds += out.samples.length / out.sampleRate;
    }
    row = { what: natural ? `optional voice (Kokoro ${path.basename(paths.natural)})` : `default voice (${m.DEFAULT_VOICE.name})`,
      build: sherpa.backend, provider: job.provider, threads: job.threads, speaker, rtf: ms / 1000 / seconds, cpuMs: cpuMs(cpu), audioSeconds: round(seconds), firstMs, loadMs, loadCpuMs, loadedRssMiB };
  } finally { tts.free(); }
}
console.log(`EMBER_BENCH_RESULT ${JSON.stringify({ ...row, baselineRssMiB, peakRssMiB: round(process.resourceUsage().maxRSS / 1024) })}`);
