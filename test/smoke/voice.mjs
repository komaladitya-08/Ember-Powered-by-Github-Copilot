// End-to-end voice test inside the real Electron app: Ember's hidden microphone window hears a WAV file through
// Chromium's fake microphone (EMBER_TEST_MIC_WAV, development builds only), the real voice process spots the wake word
// and transcribes the request, the real Copilot runtime asks the scripted model server (test/mock-llm/server.mjs), and
// the real speech process says the reply, which the mic window plays. Everything is checked from Ember's JSON log
// (EMBER_LOG_STDOUT=1). Each scenario is one start of Ember, with its own profile and its own recording (the fake
// microphone plays it once, from when the mic window opens it; it starts with silence so the voice process is ready
// by the time anything is said):
//   reply      "Hey Ember, turn on night light.": voice.ready, voice.wake, voice.utterance, voice.tts_ready and the reply's
//              audio reaching the page, in that order; the voice process is told Ember speaks (self-speaking) while it
//              does, and the follow-up window opens only once it has finished.
//   name       "Ember, turn on night light." (the bare name) wakes Ember the same way.
//   stop       "Hey Ember, stop" said while Ember speaks a long reply hushes it at once, and no follow-up opens.
//   match      Voice Match: enrolled from 4 clips through the settings page's own IPC (window.ember.enrolVoice, on
//              Chromium's debugging port), then a request in another synthetic voice is turned away (voice.rejected,
//              reason "voice") and one in the owner's is heard.
// Needs an X display (in CI: xvfb-run -a), the speech models (node scripts/voice/prepare.mjs) and the other voice's
// clips (node scripts/voice/prepare.mjs --voice ryan --clips); a development build (npm run build).
// EMBER_VOICE_E2E_MODELS and EMBER_VOICE_E2E_OTHER override where those are (.cache/voice/models,
// .cache/voice/clips-ryan); EMBER_VOICE_E2E_VERBOSE=1 shows Ember's log as it comes.
// usage: node test/smoke/voice.mjs [scenario...]   (default: all of reply, name, stop, match)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startMockLlm } from "../mock-llm/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(root, "test/fixtures/voice");
const models = path.resolve(process.env.EMBER_VOICE_E2E_MODELS ?? path.join(root, ".cache/voice/models"));
const otherVoice = path.resolve(process.env.EMBER_VOICE_E2E_OTHER ?? path.join(root, ".cache/voice/clips-ryan"));
const verbose = process.env.EMBER_VOICE_E2E_VERBOSE === "1";
const SCENARIOS = ["reply", "name", "stop", "match"];
const wanted = process.argv.slice(2);
if (wanted.some(s => !SCENARIOS.includes(s))) { console.error(`usage: node test/smoke/voice.mjs [${SCENARIOS.join(" | ")}]...`); process.exit(2); }
const run = wanted.length ? wanted : SCENARIOS;

if (!existsSync(path.join(models, "silero_vad.onnx"))) {
  console.error(`FAIL no speech models in ${models}: run node scripts/voice/prepare.mjs`);
  process.exit(1);
}
if (run.includes("match") && !existsSync(path.join(otherVoice, "wake.wav"))) {
  console.error(`FAIL no clips in another voice in ${otherVoice}: run node scripts/voice/prepare.mjs --voice ryan --clips`);
  process.exit(1);
}
if (!existsSync(path.join(root, "dist/app/main.cjs"))) {
  console.error("FAIL no development build: run npm run build");
  process.exit(1);
}

// ───── Recordings ─────
const RATE = 16_000;
/** A 16 kHz mono 16-bit WAV (the clips' format) as samples. */
function readWav(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} isn't a WAV file`);
  let at = 12, fmt = null;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4), body = at + 8;
    if (id === "fmt ") fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`${file}: expected 16 kHz mono 16-bit PCM, got ${JSON.stringify(fmt)}`);
      const n = Math.floor(Math.min(size, b.length - body) / 2), out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(body + i * 2) / 32768;
      return out;
    }
    at = body + size + (size & 1);
  }
  throw new Error(`${file} has no audio`);
}
function writeWav(file, samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  writeFileSync(file, b);
}
const at = s => Math.round(s * RATE);
const silence = s => new Float32Array(at(s));
const clip = name => readWav(path.join(fixtures, `${name}.wav`));
const cat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
/** "Hey Ember, stop": the committed clips' "Hey Ember" and "stop", as test/integration/voice.test.ts makes it. */
const heyEmberStop = () => cat(clip("wake_pause").subarray(0, at(1.52)), silence(0.1), clip("stop").subarray(at(1.09)), silence(1));
/** Silence before anything is said: the voice process loads its models (2–3 s) while the mic window already hears. */
const LEAD_S = 5;

// ───── Ember ─────
const electron = createRequire(import.meta.url)("electron");
const noSandbox = (process.platform === "linux" && process.getuid?.() === 0) || process.env.EMBER_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mock = await startMockLlm({ delayMs: 10, respond: () => ({ text: reply }) });
/** What the scripted model says to the scenario's request. */
let reply = "";

function startEmber(name, wav, { debugPort = false } = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), `ember-voice-${name}-`));
  const micWav = path.join(userData, "mic.wav");
  writeWav(micWav, wav);
  // Set up, listening and speaking: wake word on, the microphone agreed to, replies spoken. Speaker rejection off, so
  // the run is the same with or without parec and a sound server (it changes how "Hey Ember" over Ember's voice is taken).
  writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, consent: { version: 1, at: new Date().toISOString() },
    wakeWord: true, speak: true, voice: { consent: true, speakerRejection: false, muted: false, match: false },
  }));
  const env = {
    ...process.env, EMBER_USER_DATA: userData, EMBER_LOG_STDOUT: "1", EMBER_LOG_LEVEL: "debug",
    EMBER_TEST_PROVIDER_URL: mock.baseUrl, EMBER_VOICE_MODELS: models, EMBER_TEST_MIC_WAV: micWav,
  };
  const child = spawn(electron, [root, ...noSandbox, ...(debugPort ? ["--remote-debugging-port=0"] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
  const inst = { name, child, userData, log: [], stdout: "", stderr: "", failed: null };
  let buf = "";
  child.stdout.on("data", d => {
    inst.stdout = (inst.stdout + d).slice(-40_000);
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      entry.at = Date.now();
      inst.log.push(entry);
      if (verbose && entry.msg !== "voice.stderr" && entry.msg !== "voice.event") console.log(`  [${name}] ${line}`);
      if (entry.msg === "app.start_failed") inst.failed ??= line.trim();
    }
  });
  child.stderr.on("data", d => { inst.stderr = (inst.stderr + d).slice(-20_000); });
  child.on("error", err => { inst.failed ??= `couldn't start ${electron}: ${err.message}`; });
  return inst;
}

const exited = inst => inst.child.exitCode !== null || inst.child.signalCode !== null;

/** The first log entry from index `from` on that `pred` matches, waited for up to `ms`. */
const waitFor = (inst, pred, ms, what, from = 0) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const id = setInterval(() => {
    const i = inst.log.findIndex((e, k) => k >= from && pred(e));
    if (i >= 0) { clearInterval(id); resolve(i); return; }
    const why = inst.failed ?? (exited(inst) ? `Ember exited (${inst.child.signalCode ?? inst.child.exitCode})` : null)
      ?? inst.log.find(e => e.msg === "voice.error" || e.msg === "voice.mic_error" || e.msg === "voice.tts_error")?.msg ?? null;
    if (why) { clearInterval(id); reject(new Error(`${why} (waiting for ${what})`)); }
    else if (Date.now() - t0 > ms) { clearInterval(id); reject(new Error(`timed out after ${ms / 1000} s waiting for ${what}`)); }
  }, 50);
});
const index = (inst, msg, pred = () => true, from = 0) => inst.log.findIndex((e, k) => k >= from && e.msg === msg && pred(e));
const all = (inst, msg, pred = () => true) => inst.log.filter(e => e.msg === msg && pred(e));
function expect(ok, message) { if (!ok) throw new Error(message); }
/** `msgs` were logged in this order (each the first after the one before); returns their indexes. */
function inOrder(inst, steps) {
  let from = 0;
  return steps.map(([msg, pred = () => true]) => {
    const i = index(inst, msg, pred, from);
    expect(i >= 0, `no ${msg} after ${from ? inst.log[from - 1].msg : "the start"} (in order: ${steps.map(s => s[0]).join(" → ")})`);
    from = i + 1;
    return i;
  });
}
const ms = (inst, a, b) => inst.log[b].at - inst.log[a].at;

async function stop(inst) {
  if (!inst || exited(inst)) return;
  const gone = new Promise(r => inst.child.once("exit", r));
  inst.child.kill();
  const late = setTimeout(() => inst.child.kill("SIGKILL"), 10_000);
  await gone;
  clearTimeout(late);
}

/** Evaluates `expression` in the settings window's page, through Chromium's debugging port (Node's own WebSocket). */
async function evaluateInSettings(inst, expression) {
  const t0 = Date.now();
  let port;
  while (!(port = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(inst.stderr)?.[1])) {
    if (Date.now() - t0 > 10_000) throw new Error("Chromium didn't open its debugging port");
    await sleep(100);
  }
  let target;
  while (!(target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => /\/renderer\/home\/index\.html/.test(p.url)))) {
    if (Date.now() - t0 > 20_000) throw new Error("no settings window to call Voice Match from");
    await sleep(200);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("couldn't reach the settings page")); });
  try {
    const answer = await new Promise((resolve, reject) => {
      ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.id === 1) resolve(m); };
      ws.onerror = () => reject(new Error("the settings page's debugger connection failed"));
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (answer.result?.exceptionDetails) throw new Error(`${expression} threw: ${answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text}`);
    return answer.result?.result?.value;
  } finally {
    ws.close();
  }
}

// ───── Scenarios ─────
/** The request reached the model: the last user message of a request mentions it. */
const asked = (from, words) => mock.requests.slice(from).some(r => {
  const user = [...r.messages].reverse().find(m => m.role === "user");
  return words.test(typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? ""));
});

/** Speech starts, its audio reaches the page, and it ends: [on, first audio, off] indexes from `from`. */
async function spoken(inst, from, ms = 30_000) {
  const on = await waitFor(inst, e => e.msg === "voice.self_speaking" && e.on, ms, "Ember to start speaking (voice.self_speaking on)", from);
  const audio = await waitFor(inst, e => e.msg === "voice.audio_played", 5_000, "the reply's audio to reach the page (voice.audio_played)", from);
  const off = await waitFor(inst, e => e.msg === "voice.self_speaking" && !e.on, 60_000, "Ember to finish speaking (voice.self_speaking off)", on);
  return { on, audio, off };
}

const scenarios = {
  async reply() {
    reply = "Night Light is on now. I turned it on for you in the display settings.";
    const sent = mock.requests.length;
    const inst = startEmber("reply", cat(silence(LEAD_S), clip("wake"), silence(30)));
    try {
      await waitFor(inst, e => e.msg === "voice.utterance", 40_000, "the request (voice.utterance)");
      const { on, off } = await spoken(inst, 0);
      const followUp = await waitFor(inst, e => e.msg === "voice.follow_up", 10_000, "the follow-up window (voice.follow_up)");
      // The log, in order. Ember's voice starts loading at the wake (it's warmed then), so its tts_ready may come before
      // or after the request's end: it's checked to come after the wake and before any of its audio.
      const [ready, wake, utterance, audio] = inOrder(inst, [["voice.ready"], ["voice.wake", e => e.keyword === "hey_ember"], ["voice.utterance", e => e.window === "wake"], ["voice.audio_played"]]);
      const tts = index(inst, "voice.tts_ready");
      expect(tts > wake && tts < audio, `voice.tts_ready (#${tts}) should come after the wake (#${wake}) and before the reply's audio (#${audio})`);
      expect(ready < wake, "voice.ready came after the wake");
      expect(asked(sent, /night light/i), `the model wasn't asked about night light (requests: ${JSON.stringify(mock.requests.slice(sent).map(r => r.messages.at(-1)))})`);
      console.log(`ok   reply: voice.ready → voice.wake → voice.utterance (${inst.log[utterance].chars} chars) → voice.tts_ready → audio on the page`);
      // Both sentences were played, and the voice process was told while they were.
      const played = all(inst, "voice.audio_played");
      const seconds = played.reduce((n, e) => n + e.seconds, 0);
      expect(seconds > 2, `only ${seconds} s of the reply reached the page`);
      expect(inst.log[on].listening === true, "the voice process wasn't running to be told Ember speaks");
      expect(on < audio + 2 && audio < off, "self-speaking didn't span the reply's audio");
      const lastAudio = inst.log.findLastIndex(e => e.msg === "voice.audio_played");
      expect(lastAudio < off, "audio reached the page after Ember said it had finished speaking");
      console.log(`ok   reply: ${played.length} chunk(s), ${seconds.toFixed(1)} s of Ember's voice played; self-speaking on for ${(ms(inst, on, off) / 1000).toFixed(1)} s`);
      // The follow-up window opens only once Ember has finished speaking.
      expect(followUp > off, `the follow-up window opened (#${followUp}) before Ember finished speaking (#${off})`);
      expect(index(inst, "voice.follow_up") === followUp, "a follow-up window opened twice");
      await waitFor(inst, e => e.msg === "voice.event" && e.type === "listening", 5_000, "the follow-up window to listen", followUp);
      console.log(`ok   reply: the follow-up window opened ${ms(inst, off, followUp)} ms after Ember finished speaking`);
    } finally { await finish(inst); }
  },

  async name() {
    reply = "Night Light is on. Anything else?";
    const sent = mock.requests.length;
    const inst = startEmber("name", cat(silence(LEAD_S), clip("name_wake"), silence(25)));
    try {
      await waitFor(inst, e => e.msg === "voice.utterance", 40_000, "the request after the bare name (voice.utterance)");
      await spoken(inst, 0);
      inOrder(inst, [["voice.ready"], ["voice.wake", e => e.keyword === "ember"], ["voice.utterance", e => e.window === "wake"], ["voice.audio_played"]]);
      expect(asked(sent, /night light/i), "the model wasn't asked about night light");
      console.log("ok   name: \"Ember, …\" woke Ember (keyword ember), was heard and answered aloud");
    } finally { await finish(inst); }
  },

  async stop() {
    // Long enough to be still speaking when "Hey Ember, stop" comes 6 s after the request (its first sentence plays
    // about 1–3 s after the request ends).
    reply = "Night Light is on now, and the screen will look warmer from this evening until tomorrow morning, which is easier on your eyes late at night. "
      + "If you would like it to start earlier or later, or to be a little warmer or cooler, just tell me and I will change the schedule and the colour temperature for you.";
    const inst = startEmber("stop", cat(silence(LEAD_S), clip("wake"), silence(6), heyEmberStop(), silence(25)));
    try {
      const on = await waitFor(inst, e => e.msg === "voice.self_speaking" && e.on, 40_000, "Ember to start speaking");
      const stopAt = await waitFor(inst, e => e.msg === "voice.stop", 30_000, "\"Hey Ember, stop\" to stop Ember (voice.stop)", on);
      const offIdx = index(inst, "voice.self_speaking", e => !e.on, on);
      expect(offIdx < 0 || offIdx > stopAt, `Ember had already finished speaking (#${offIdx}) before "Hey Ember, stop" (#${stopAt}): the reply was too short for the test`);
      const off = await waitFor(inst, e => e.msg === "voice.self_speaking" && !e.on, 3_000, "Ember to go quiet after the stop", stopAt);
      const quietMs = ms(inst, stopAt, off);
      expect(quietMs < 1500, `Ember took ${quietMs} ms to go quiet after the stop`);
      const played = all(inst, "voice.audio_played").reduce((n, e) => n + e.seconds, 0);
      // Nothing more is said, and no follow-up window opens, for a hushed reply.
      await sleep(4000);
      const resumed = inst.log.slice(off + 1).find(e => e.msg === "voice.self_speaking" && e.on);
      expect(!resumed, "Ember started speaking again after it was stopped");
      expect(index(inst, "voice.follow_up") < 0, "a follow-up window opened after Ember was stopped");
      expect(index(inst, "voice.utterance", () => true, stopAt) < 0, "\"Hey Ember, stop\" was taken as a request");
      console.log(`ok   stop: "Hey Ember, stop" during the reply hushed it (${quietMs} ms after the stop, ${played.toFixed(1)} s of audio had been queued); no follow-up opened`);
    } finally { await finish(inst); }
  },

  async match() {
    reply = "Night Light is on. Anything else?";
    const other = readWav(path.join(otherVoice, "wake.wav"));
    // Ten seconds' silence for the enrolment to start (it's asked for once the voice process is ready), the owner's four
    // phrases, then "Hey Ember, turn on night light." in another voice, then in the owner's.
    const enrolClips = ["dnd", "chat", "remember", "followup"];
    const inst = startEmber("match", cat(silence(10), ...enrolClips.flatMap(c => [clip(c), silence(1.5)]), silence(3), other, silence(6), clip("wake"), silence(25)), { debugPort: true });
    try {
      await waitFor(inst, e => e.msg === "voice.ready", 40_000, "the voice process (voice.ready)");
      const started = await evaluateInSettings(inst, "window.ember.enrolVoice()");
      expect(started === true, `the voiceMatch enrol IPC answered ${JSON.stringify(started)}`);
      const enrolled = await waitFor(inst, e => e.msg === "voice.match_enrolled", 40_000, "Voice Match to enrol from the four phrases (voice.match_enrolled)");
      expect(inst.log[enrolled].phrases === 4, `enrolled from ${inst.log[enrolled].phrases} phrases`);
      expect(existsSync(path.join(inst.userData, "voiceprint.json")), "no voiceprint.json was written");
      console.log(`ok   match: enrolled from ${enrolClips.length} clips through the voiceMatch IPC`);
      const rejected = await waitFor(inst, e => e.msg === "voice.rejected", 30_000, "the other voice to be turned away (voice.rejected)", enrolled);
      expect(inst.log[rejected].reason === "voice", `the other voice was rejected for "${inst.log[rejected].reason}", not its voice`);
      const owner = await waitFor(inst, e => e.msg === "voice.utterance", 30_000, "the owner's request after the other voice (voice.utterance)", rejected);
      expect(index(inst, "voice.utterance", () => true, enrolled) === owner, "the other voice's request got through");
      await waitFor(inst, e => e.msg === "voice.audio_played", 30_000, "the owner's reply to be spoken", owner);
      console.log(`ok   match: another voice was turned away (voice.rejected reason voice, score ${inst.log[rejected].score}); the owner's request was heard and answered`);
    } finally { await finish(inst); }
  },
};

/** The scenario's Ember, once stopped: its profile is removed, or kept and its log shown when the scenario failed. */
const last = { inst: null };
async function finish(inst) {
  last.inst = inst;
  await stop(inst);
}

let ok = true;
try {
  for (const name of run) {
    last.inst = null;
    try {
      await scenarios[name]();
      if (last.inst) rmSync(last.inst.userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      ok = false;
      console.error(`FAIL ${name}: ${err.message}`);
      const current = last.inst;
      if (current) {
        const lines = current.log.filter(e => e.msg !== "voice.stderr").slice(-80).map(e => { const { at: _at, ...rest } = e; return JSON.stringify(rest); });
        process.stderr.write(`--- Ember's log (last lines) ---\n${lines.join("\n")}\n`);
        if (current.stderr.trim()) process.stderr.write(`--- Ember's stderr (last lines) ---\n${current.stderr.trim().split("\n").slice(-30).join("\n")}\n`);
        console.error(`(profile kept in ${current.userData})`);
      }
    }
  }
} finally {
  await mock.close();
}
process.exit(ok ? 0 : 1);
