// Ember's voice and speech processes in Electron itself (utility processes, as VoiceService starts them): which build
// of sherpa-onnx each loads, and how fast each works there. The voice process (dist/app/voice.cjs) hears
// test/fixtures/voice/wake.wav in real time ("Hey Ember, turn on night light.") through a MessagePort, as the mic page
// sends it; the speech process (dist/app/tts.cjs) says a reply, chunk by chunk. Each runs on the build Ember picks, then
// on WebAssembly for comparison. On Windows and macOS the picked build must be the native addon (EMBER_VOICE_BACKEND=wasm
// expects WebAssembly instead); elsewhere WebAssembly. Prints one JSON line per run ("voice-backends: {...}").
// Needs `npm run build` and the models from `node scripts/voice/prepare.mjs` (<models> defaults to .cache/voice/models).
// usage: npx electron test/smoke/voice-backends.mjs [<models>]   (Linux: under xvfb-run, or with --headless)
import { app, MessageChannelMain, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const models = path.resolve(process.argv.slice(2).find(a => !a.startsWith("-") && !/\.[cm]?js$/.test(a)) ?? path.join(root, ".cache/voice/models"));
const dist = path.join(root, "dist/app");
const REPLY = "I opened the terminal, ran the tests, and all twenty-four of them passed. Night Light is on, and do not disturb is off.";
const wantNative = (process.platform === "win32" || process.platform === "darwin") && process.env.EMBER_VOICE_BACKEND !== "wasm";

/** The model folders, as models.ts's modelPaths names them (read from its targets: no TypeScript here). */
function modelPaths() {
  const src = fs.readFileSync(path.join(root, "app/voice/models.ts"), "utf8");
  const target = id => {
    const m = new RegExp(`id: "${id}"[\\s\\S]*?target: "([^"]+)"`).exec(src);
    if (!m) throw new Error(`no ${id} model in models.ts`);
    return path.join(models, m[1]);
  };
  return { kws: target("kws"), vad: target("vad"), asr: target("asr"), tts: target("tts"), speaker: target("speaker"), natural: target("natural") };
}

/** A 16-bit mono WAV's samples as floats. */
function readWav(file) {
  const b = fs.readFileSync(file);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === "data") {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${file}`);
}

const fail = message => { console.error(`voice-backends: FAIL ${message}`); app.exit(1); };
const within = (ms, what, p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: nothing after ${ms / 1000} s`)), ms))]);

/** The voice process hears the clip: its build, how long it took to load, and how soon after the clip the request came. */
async function voiceRun(wasm) {
  const proc = utilityProcess.fork(path.join(dist, "voice.cjs"), [], { serviceName: "Ember voice (check)", stdio: "inherit" });
  const messages = [];
  let notify = () => {};
  proc.on("message", m => { messages.push({ at: performance.now(), m }); notify(); });
  const next = (type, ms) => within(ms, `voice process ${type}`, new Promise(resolve => {
    const look = () => { const hit = messages.find(x => x.m.type === type || (type === "ready" && x.m.type === "error")); if (hit) resolve(hit); };
    notify = look;
    look();
  }));
  const { port1, port2 } = new MessageChannelMain();
  const t0 = performance.now();
  proc.postMessage({ type: "init", models: modelPaths(), monitor: false, dev: true, voiceprint: null, ...(wasm ? { wasm: true } : {}) }, [port1]);
  const ready = await next("ready", 60_000);
  if (ready.m.type === "error") throw new Error(`voice process: ${ready.m.message}`);
  const loadMs = Math.round(ready.at - t0);
  // Real time: one 32 ms frame every 32 ms, then two seconds of silence.
  const clip = readWav(path.join(root, "test/fixtures/voice/wake.wav"));
  const audio = new Float32Array(clip.length + 32_000);
  audio.set(clip);
  port2.start();
  let endedAt = 0;
  for (let i = 0; i + 512 <= audio.length; i += 512) {
    port2.postMessage(audio.slice(i, i + 512));
    if (i + 512 >= clip.length && !endedAt) endedAt = performance.now();
    await new Promise(r => setTimeout(r, 32));
  }
  const utterance = await next("utterance", 10_000);
  proc.kill();
  // When the request came, from the end of the clip (whose last 0.5 s or so is silence: the VAD ends a request after
  // 0.6 s of it, and the recognizer then transcribes it).
  return { process: "voice", backend: ready.m.backend, loadMs, heard: utterance.m.text, requestMsAfterClip: Math.round(utterance.at - endedAt) };
}

/** The speech process says the reply: its voice and build, its load time, the first chunk's latency, and the real-time factor. */
async function speechRun(wasm) {
  const proc = utilityProcess.fork(path.join(dist, "tts.cjs"), [], { serviceName: "Ember speech (check)", stdio: "inherit" });
  const paths = modelPaths();
  const out = await within(120_000, "speech process", new Promise((resolve, reject) => {
    const t0 = performance.now();
    let ready = null, saidAt = 0, first = 0, seconds = 0;
    proc.on("message", m => {
      if (m.type === "error") reject(new Error(`speech process: ${m.message}`));
      else if (m.type === "ready") {
        ready = { voice: m.voice, loadMs: Math.round(performance.now() - t0) };
        saidAt = performance.now();
        proc.postMessage({ type: "say", id: 1, text: REPLY });
      } else if (m.type === "audio") {
        if (!first) first = performance.now() - saidAt;
        seconds += m.samples.length / m.rate;
      } else if (m.type === "done") {
        const ms = performance.now() - saidAt;
        resolve({ process: "speech", ...ready, firstAudioMs: Math.round(first), audioSeconds: Math.round(seconds * 100) / 100, rtf: Math.round((ms / 1000 / seconds) * 1000) / 1000 });
      } else if (m.type === "failed") reject(new Error(`speech process: ${m.message}`));
    });
    proc.postMessage({ type: "init", model: paths.tts, natural: fs.existsSync(paths.natural) ? paths.natural : null, ...(wasm ? { wasm: true } : {}) });
  }));
  proc.kill();
  return out;
}

app.whenReady().then(async () => {
  try {
    const runs = [];
    for (const wasm of [false, true]) {
      runs.push({ asked: wasm ? "wasm" : "picked", ...(await voiceRun(wasm)) });
      runs.push({ asked: wasm ? "wasm" : "picked", ...(await speechRun(wasm)) });
    }
    for (const r of runs) console.log(`voice-backends: ${JSON.stringify(r)}`);
    const picked = runs.filter(r => r.asked === "picked");
    const want = wantNative ? "native" : "wasm";
    for (const r of picked) {
      const got = r.process === "voice" ? r.backend?.backend : r.voice?.backend;
      if (got !== want) return fail(`the ${r.process} process ran on ${got}, not ${want} (${r.process === "voice" ? r.backend?.detail : r.voice?.detail})`);
    }
    for (const r of runs.filter(x => x.process === "voice")) if (!/night ?light/i.test(r.heard ?? "")) return fail(`the voice process (${r.asked}) heard "${r.heard}"`);
    for (const r of runs.filter(x => x.process === "speech")) if (!(r.rtf > 0 && r.rtf < 1)) return fail(`the speech process (${r.asked}) spoke at ${r.rtf} of real time`);
    console.log(`voice-backends: ok (${want} picked on ${process.platform}-${process.arch})`);
    app.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
});
app.on("window-all-closed", () => undefined);
