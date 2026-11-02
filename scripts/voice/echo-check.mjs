// Measures how much of Ember's own voice its microphone hears, for each way of playing it (docs/ASSISTANT.md phase 2.3:
// barge-in without the wake word is safe only if Ember doesn't hear itself). For each playback path ("context", Web
// Audio straight out; "element", Web Audio through an <audio> element, which Chromium's echo cancellation is documented
// to cover), it starts the built app with voice on, records what the voice process hears (EMBER_VOICE_DUMP), stays quiet
// for a few seconds to hear the room, then has Ember say a fixed set of sentences. It reports how far above the room
// Ember's voice came back (dB, lower is better), and how often Ember's own voice woke it or counted as speech.
//
// Run it on a real computer with speakers and a microphone (a laptop's built-in ones are the hard case), in a quiet room,
// with nobody talking. Audio stays on this computer: the recording is read and deleted, never kept.
//
// usage: node scripts/voice/echo-check.mjs [--modes context,element] [--fake] [--json out.json]
//   Needs npm run build and node scripts/voice/prepare.mjs (EMBER_VOICE_E2E_MODELS overrides where the models are).
//   --fake uses Chromium's fake microphone with silence (no acoustic path): it checks the script works, not the echo.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const modes = arg("modes", "context,element").split(",").filter(m => m === "context" || m === "element");
const fake = process.argv.includes("--fake");
const jsonOut = arg("json", null);
const models = path.resolve(process.env.EMBER_VOICE_E2E_MODELS ?? path.join(root, ".cache/voice/models"));
const RATE = 16_000;
const ROOM_S = 6;
/** Trimmed from each end of a window: the recording's clock and the log's differ by up to about this much. */
const GUARD_S = 0.3;
const SENTENCES = [
  "I opened the quarterly report in LibreOffice Writer.",
  "Night Light is on now, and it will turn off at seven.",
  "You have two meetings this afternoon, the first at three.",
  "I couldn't find a folder called invoices in your documents.",
  "Ember here. Working on it: step two of four, saving the file.",
  "All working. Copilot is connected, and I'm listening for Hey Ember.",
];

if (!existsSync(path.join(root, "dist/app/main.cjs"))) { console.error("no development build: run npm run build"); process.exit(1); }
if (!existsSync(path.join(models, "silero_vad.onnx"))) { console.error(`no speech models in ${models}: run node scripts/voice/prepare.mjs`); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dB = rms => (rms > 0 ? 20 * Math.log10(rms) : -120);
function rmsOf(x, from, to) {
  const a = Math.max(0, Math.floor(from * RATE)), b = Math.min(x.length, Math.floor(to * RATE));
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
}
/** A WAV of `s` seconds of silence, for --fake. */
function silentWav(file, s) {
  const n = s * RATE, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8, "ascii"); b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "ascii"); b.writeUInt32LE(n * 2, 40);
  writeFileSync(file, b);
}

async function measure(mode) {
  const userData = mkdtempSync(path.join(tmpdir(), `ember-echo-${mode}-`));
  // Voice on and agreed, replies spoken, speaker rejection off: the raw case, as barge-in would face it.
  writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, consent: { version: 1, at: new Date().toISOString() },
    wakeWord: true, speak: true, voice: { consent: true, speakerRejection: false, muted: false, match: false },
  }));
  const dump = path.join(userData, "heard.f32");
  // Interrupted (Ctrl+C), the recording of what the room heard goes too, as it does after a finished run.
  const onInterrupt = () => { rmSync(userData, { recursive: true, force: true }); process.exit(130); };
  process.once("SIGINT", onInterrupt);
  const env = {
    ...process.env, EMBER_USER_DATA: userData, EMBER_LOG_STDOUT: "1", EMBER_TEST_HOOKS: "1", EMBER_VOICE_MODELS: models,
    EMBER_VOICE_DUMP: dump, EMBER_TTS_OUTPUT: mode,
  };
  if (fake) { const wav = path.join(userData, "mic.wav"); silentWav(wav, 120); env.EMBER_TEST_MIC_WAV = wav; }
  const noSandbox = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)("electron"), args: [root, ...noSandbox], env });
  const log = [];
  let buf = "";
  app.process().stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { log.push({ ...JSON.parse(line), at: Date.now() }); } catch { /* not a log line */ }
    }
  });
  const waitFor = async (pred, ms, from = 0) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = log.slice(from).find(pred); if (e) return e; await sleep(50); }
    return null;
  };
  try {
    if (!await waitFor(e => e.msg === "voice.ready", 60_000)) throw new Error("the voice process never got ready (are the models in place?)");
    await sleep(ROOM_S * 1000);
    const windows = [];
    for (const text of SENTENCES) {
      const from = log.length;
      await app.evaluate((_e, t) => globalThis.__ember.voice()?.speak(t), text);
      const on = await waitFor(e => e.msg === "voice.self_speaking" && e.on === true, 20_000, from);
      const off = on && await waitFor(e => e.msg === "voice.self_speaking" && e.on === false, 30_000, log.indexOf(on));
      if (on && off) windows.push({ start: on.at, end: off.at });
      await sleep(1500);
    }
    const closedAt = Date.now();
    await app.close();
    const raw = readFileSync(dump);
    const heard = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    // The recording ran in real time up to the close: its first sample was this long before it.
    const startAt = closedAt - (heard.length / RATE) * 1000;
    const sec = at => (at - startAt) / 1000;
    const ready = log.find(e => e.msg === "voice.ready").at;
    const room = rmsOf(heard, sec(ready) + 1, sec(ready) + ROOM_S - GUARD_S);
    let sum = 0, n = 0;
    for (const w of windows) {
      const a = sec(w.start) + GUARD_S, b = sec(w.end) - GUARD_S;
      if (b <= a) continue;
      const r = rmsOf(heard, a, b);
      sum += r * r * (b - a); n += b - a;
    }
    const speaking = n ? Math.sqrt(sum / n) : 0;
    const during = e => windows.some(w => e.at >= w.start && e.at <= w.end + 500);
    const count = pred => log.filter(e => pred(e) && during(e)).length;
    return {
      mode, sentences: windows.length, speakingSeconds: Math.round(n * 10) / 10,
      roomDb: Math.round(dB(room) * 10) / 10, speakingDb: Math.round(dB(speaking) * 10) / 10,
      echoAboveRoomDb: Math.round((dB(speaking) - dB(room)) * 10) / 10,
      wakes: count(e => e.msg === "voice.wake"), speechOnsets: count(e => e.msg === "voice.speech_heard" && e.on === true),
      utterances: count(e => e.msg === "voice.utterance"),
    };
  } finally {
    await app.close().catch(() => undefined);
    // The recording held what the room heard: it goes now.
    rmSync(userData, { recursive: true, force: true });
    process.off("SIGINT", onInterrupt);
  }
}

const results = [];
for (const mode of modes) {
  console.log(`measuring ${mode}…`);
  results.push(await measure(mode));
}
console.log("\nmode      sentences  room dB  speaking dB  echo above room  wakes  speech onsets  utterances");
for (const r of results) {
  console.log(`${r.mode.padEnd(9)} ${String(r.sentences).padStart(9)} ${String(r.roomDb).padStart(8)} ${String(r.speakingDb).padStart(12)} ${String(r.echoAboveRoomDb).padStart(16)} ${String(r.wakes).padStart(6)} ${String(r.speechOnsets).padStart(14)} ${String(r.utterances).padStart(11)}`);
}
if (fake) console.log("\n(--fake: Chromium's fake microphone has no acoustic path, so these show the script works, not the echo.)");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ machine: process.platform, at: new Date().toISOString(), results }, null, 2));
