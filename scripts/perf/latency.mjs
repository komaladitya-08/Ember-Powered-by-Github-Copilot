// Times Ember's latencies on this computer (docs/ASSISTANT.md §1), each over many runs, as median and p95, so a change
// can be compared with main on the same machine. Sections (all by default; --only voice,tts,ask,task,kill):
//   voice  wake word → listening, and end of speech → transcript (the VAD's tail plus Moonshine), on the real models.
//          The clips are synthesized with another voice than Ember's (`prepare.mjs --tts-voice --voice ryan`), in a quiet
//          room's noise, and fed frame by frame as the microphone sends them, with each frame's real compute time put
//          on a real-time clock (a frame waits for the one before it), so a slow transcription delays what follows.
//          Requests said with a pause in the middle count those cut short, and each is also heard with the transcript
//          made from the VAD's own segment (transcribeAhead off) on the same audio, to compare.
//   tts    transcript → first spoken audio: the answer streams from the mock model's fixed pace (--word-ms, 30 ms a
//          word), SpeechStream picks the first chunk, and Ember's voice (Piper, as the speech process runs it) makes it.
//          Also the voice's cold start (load and warm-up), which a first reply waits for unless it was warmed.
//   ask    a typed question → the first answer token, through the real Copilot runtime and Ember's Conductor, against
//          the mock model (test/mock-llm) answering at once: Ember's and the runtime's own overhead.
//   task   a task's start → its first tool call, and each tool call's time in the worker (perception, policy, the
//          audit, the act), from the mock model's request times: the eval's scripted tasks on the GTK test bench and
//          gedit (needs a display, a session bus and EMBER_PYTHON set to a Python with GTK 3).
//   kill   the kill switch: KillSwitch.pull() with a conductor turn streaming and a borrowed mouse mid-glide.
// Nothing here writes audio anywhere: clips are made and fed in memory.
//   usage: dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node scripts/perf/latency.mjs [--only s,s] [--runs N] [--json file]
// Needs `node scripts/voice/prepare.mjs` (the models, and the test voice). The voice section runs 18 clips whatever --runs says.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const only = new Set((opt("--only", "voice,tts,ask,task,kill")).split(","));
const RUNS = Number(opt("--runs", "12"));
const WORD_MS = Number(opt("--word-ms", "30"));
const jsonOut = opt("--json", null);
const require = createRequire(import.meta.url);
const voiceDir = path.resolve(process.env.EMBER_VOICE_DIR ?? path.join(root, ".cache/voice"));
const models = path.join(voiceDir, "models");

const results = { cpu: os.cpus()[0]?.model?.trim(), threads: os.availableParallelism(), platform: `${process.platform}-${process.arch}`, at: new Date().toISOString(), rows: [] };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
/** One measured latency: its samples, as median and p95. */
function row(section, what, samples, note = "") {
  const r = { section, what, n: samples.length, median: Math.round(pct(samples, 50)), p95: Math.round(pct(samples, 95)), note };
  results.rows.push({ ...r, samples: samples.map(x => Math.round(x)) });
  console.log(`  ${what.padEnd(58)} n=${String(r.n).padStart(3)}  median ${String(r.median).padStart(5)} ms  p95 ${String(r.p95).padStart(5)} ms${note ? `  (${note})` : ""}`);
}

// The app's own modules, bundled as bench.mjs does (sherpa-onnx, koffi and the Copilot SDK stay external).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-latency-"));
const entry = path.join(tmp, "entry.ts");
const at = f => JSON.stringify(path.join(root, f));
fs.writeFileSync(entry, [
  `export * from ${at("app/voice/runtime.ts")};`,
  `export { sherpaBackend } from ${at("app/voice/sherpa.ts")};`,
  `export { VoiceEngine } from ${at("app/voice/engine.ts")};`,
  `export { modelPaths } from ${at("app/voice/models.ts")};`,
  `export { piperSpec } from ${at("app/voice/tts-spec.ts")};`,
  `export { SpeechStream, speechChunks } from ${at("app/voice/tts.ts")};`,
  `export { Conductor } from ${at("app/main/agent/conductor.ts")};`,
  `export { Presenter } from ${at("app/main/agent/presenter.ts")};`,
  `export { locateRuntime } from ${at("app/main/agent/runtime.ts")};`,
  `export { SettingsStore } from ${at("app/main/settings.ts")};`,
  `export { createLogger } from ${at("app/main/logger.ts")};`,
  `export { KillSwitch } from ${at("app/main/agent/killswitch.ts")};`,
  `export { CursorBorrow } from ${at("app/main/hands/borrow.ts")};`,
  `export { openXInput } from ${at("app/main/hands/input.ts")};`,
].join("\n"));
const bundle = path.join(root, "node_modules", ".ember-latency.cjs");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "error", external: ["sherpa-onnx", "sherpa-onnx-*", "koffi", "@github/copilot-sdk", "electron"] });
const m = require(bundle);
console.log(`${results.cpu}, ${results.threads} threads, ${results.platform}, load average ${os.loadavg().map(x => x.toFixed(1)).join(" ")}\n`);

const paths = m.modelPaths(models);
const SR = 16_000, FRAME = 512, FRAME_MS = 32;
const capiDir = process.env.EMBER_SHERPA_CAPI;
const runtime = capiDir ? { capiDir } : {};

/** Floats at 16 kHz from a voice's output (linear resampling: the synthesized test voice is 16 kHz or 22.05 kHz). */
function to16k(samples, rate) {
  if (rate === SR) return samples;
  const out = new Float32Array(Math.floor(samples.length * SR / rate));
  for (let i = 0; i < out.length; i++) { const x = i * rate / SR, j = Math.floor(x), f = x - j; out[i] = samples[j] * (1 - f) + (samples[j + 1] ?? 0) * f; }
  return out;
}
/** The last sample above speech loudness (10 ms windows), as the eval's wake gate finds a phrase's end. */
function speechEnd(s) {
  let end = 0;
  for (let i = 0; i + 160 <= s.length; i += 160) { let e = 0; for (let j = i; j < i + 160; j++) e += s[j] * s[j]; if (Math.sqrt(e / 160) > 0.01) end = i + 160; }
  return end;
}
let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed / 0x7fffffff) - 0.5) * 0.004; };

/**
 * Feeds `audio` to a fresh engine frame by frame on a real-time clock: frame i is complete at (i+1)·32 ms and is
 * processed once the frame before it is done. Each event is stamped with when it would have been seen.
 */
function play(backend, audio, opts = {}) {
  const events = [];
  let clock = 0, audioT = 0, start = 0, c0 = 0, ready = 0;
  // `ready`: when the frame that brought the event was complete (audio time); `wall`: when the event came, with every
  // frame's compute on a real-time clock.
  const engine = new m.VoiceEngine(backend, e => events.push({ ...e, ready, wall: start + (performance.now() - c0) }), { now: () => audioT, ...opts });
  const quiet = new Float32Array(FRAME);
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    ready = (i / FRAME + 1) * FRAME_MS;
    start = Math.max(ready, clock);
    c0 = performance.now();
    engine.feedMonitor(quiet);
    engine.feed(audio.subarray(i, i + FRAME));
    clock = start + (performance.now() - c0);
    audioT += FRAME_MS;
  }
  backend.resetVad();
  return events;
}

if (only.has("voice")) {
  console.log("Voice: wake word and end of speech (real models)");
  const testVoice = ["vits-piper-en_US-ryan-low", "vits-piper-en_US-amy-low"].map(d => path.join(voiceDir, d)).find(d => fs.existsSync(d));
  if (!testVoice) { console.log("  (no test voice: run node scripts/voice/prepare.mjs)"); }
  else {
    const t0 = performance.now();
    const backend = m.sherpaBackend(paths, { monitor: true, runtime });
    row("voice", `listening models load (${backend.info.backend})`, [performance.now() - t0], "once, when listening starts");
    const say = m.sherpaRuntime({ prefer: "wasm" }).createTts(m.piperSpec(testVoice), { provider: "cpu", numThreads: 1 }, 1);
    const synth = (text, speed) => { const a = say.generate({ text, sid: 0, speed }); return to16k(a.samples, a.sampleRate); };
    const REQUESTS = ["Turn on night light.", "What's on my screen?", "Make the text bigger please.", "Open the files app.", "Turn on do not disturb.", "What time is my next meeting?"];
    const wakeMs = [], endMs = [], oneBreathMs = [], asrMs = [], tailMs = [];
    let missed = 0, wrong = 0, differ = 0, wrongAtEnd = 0;
    for (const speed of [0.9, 1.0, 1.1]) for (const request of REQUESTS) {
      // Two breaths: "Hey Ember." · a second · the request · 2.5 s of quiet.
      const wake = synth("Hey Ember.", speed), req = synth(request, speed);
      const lead = Math.round(0.6 * SR), gap = SR;
      const audio = new Float32Array(lead + wake.length + gap + req.length + Math.round(2.5 * SR));
      audio.set(wake, lead); audio.set(req, lead + wake.length + gap);
      for (let i = 0; i < audio.length; i++) audio[i] += noise();
      const wakeEnd = (lead + speechEnd(wake)) / 16, reqEnd = (lead + wake.length + gap + speechEnd(req)) / 16;
      const ev = play(backend, audio);
      const listening = ev.find(e => e.type === "listening" && e.on), heard = ev.find(e => e.type === "utterance");
      if (!listening || !heard) { missed++; continue; }
      wakeMs.push(listening.wall - wakeEnd);
      endMs.push(heard.wall - reqEnd);
      tailMs.push(heard.ready - reqEnd);
      asrMs.push(heard.wall - heard.ready);
      const key = request.toLowerCase().split(" ")[1].replace(/[^a-z']/g, "");
      if (!heard.text.toLowerCase().includes(key)) wrong++;
      // The same clip with the transcript made from the VAD's own segment (transcribeAhead off; main ignores it).
      const atEnd = play(backend, audio, { transcribeAhead: false }).find(e => e.type === "utterance");
      const words = t => (t ?? "").toLowerCase().replace(/[^a-z0-9' ]/g, "").trim();
      if (words(atEnd?.text) !== words(heard.text)) differ++;
      if (!atEnd?.text.toLowerCase().includes(key)) wrongAtEnd++;
      // One breath: "Hey Ember, <request>".
      const one = synth(`Hey Ember, ${request.charAt(0).toLowerCase()}${request.slice(1)}`, speed);
      const audio1 = new Float32Array(lead + one.length + Math.round(2.5 * SR));
      audio1.set(one, lead);
      for (let i = 0; i < audio1.length; i++) audio1[i] += noise();
      const ev1 = play(backend, audio1).find(e => e.type === "utterance");
      if (ev1) oneBreathMs.push(ev1.wall - (lead + speechEnd(one)) / 16);
    }
    row("voice", "wake word end → listening", wakeMs, `“Hey Ember.” then a pause; ${missed} of ${REQUESTS.length * 3} missed`);
    row("voice", "end of speech → transcript (two breaths)", endMs, `${wrong} transcripts off; from the VAD's segment ${wrongAtEnd} off, ${differ} worded differently`);
    row("voice", "  of which: the VAD's silence (audio time)", tailMs);
    row("voice", "  of which: work after it (Moonshine, unless done ahead)", asrMs);
    row("voice", "end of speech → transcript (one breath)", oneBreathMs, "“Hey Ember, …” said at once");
    // Cut short: a request said in two parts with a pause between them must arrive whole. The first part of each
    // reads as a whole request on its own (the hard case) or doesn't; the pause is 0.3 to 0.6 s (the VAD's own wait
    // is 0.6 s). Cut short: the request ended before its second part began.
    const SPLIT = [["Open the files app.", "In my documents folder."], ["Turn on the", "night light please."], ["Set a timer", "for ten minutes."], ["Make the text bigger,", "and turn on dark style."]];
    const cut = {};
    for (const pause of [0.3, 0.45, 0.6, 0.7]) for (const [a, b] of SPLIT) for (const speed of [0.9, 1.1]) {
      const wake = synth("Hey Ember.", speed), pa = synth(a, speed), pb = synth(b, speed);
      const lead = Math.round(0.6 * SR), gap = SR, p = Math.round(pause * SR);
      const ea = speechEnd(pa);
      let sb = 0;
      while (sb < pb.length && Math.abs(pb[sb]) < 0.02) sb++;
      const bAt = lead + wake.length + gap + ea + p;
      const audio = new Float32Array(bAt - sb + pb.length + Math.round(2.5 * SR));
      audio.set(wake, lead); audio.set(pa.subarray(0, ea), lead + wake.length + gap); audio.set(pb, bAt - sb);
      for (let i = 0; i < audio.length; i++) audio[i] += noise();
      // The same audio with the transcript made from the VAD's own segment (transcribeAhead off; main ignores it).
      const isCut = o => { const heard = play(backend, audio, o).find(e => e.type === "utterance"); return !heard || heard.ready < bAt / 16; };
      cut[pause] ??= { split: 0, atEnd: 0, of: 0 };
      cut[pause].of++;
      if (isCut({})) cut[pause].split++;
      if (isCut({ transcribeAhead: false })) cut[pause].atEnd++;
    }
    for (const [pause, c] of Object.entries(cut)) {
      console.log(`  a ${pause} s pause mid-request: cut short ${c.split} of ${c.of} (the same audio transcribed at the VAD's end: ${c.atEnd})`);
      results.rows.push({ section: "voice", what: `cut short at a ${pause} s pause`, n: c.of, cut: c.split, cutAtEnd: c.atEnd });
    }
    say.free?.();
    backend.free();
  }
}

if (only.has("tts")) {
  console.log("\nEmber's voice: transcript → first audio");
  const ANSWERS = [
    "It's 3:40 in the afternoon, and your next meeting is at 4.",
    "Night Light is on now. It will turn off at sunrise.",
    "Sure, I've made the text bigger in the Settings app, so everything should be easier to read.",
    "You have three windows open: Files, the text editor with your notes, and Firefox showing the weather.",
    "I can't do that one, because it would delete files from your home folder without a way back.",
    "Done.",
    "The test bench has a form with a name field, a password field and a Night Light switch.",
    "Okay, do not disturb is on, so notifications will wait until you turn it off again.",
    "I opened the Files app in your Documents folder; the report you wanted is the newest one there.",
    "Your battery is at 82 percent and charging.",
    "That's the latest version of Firefox, so there's nothing to update right now.",
    "Here's what I found: the project builds, but two of the unit tests fail on the date format.",
  ];
  const sherpa = m.sherpaRuntime(runtime);
  const spec = m.piperSpec(paths.tts);
  const coldMs = [];
  for (let i = 0; i < Math.min(RUNS, 5); i++) {
    const t0 = performance.now();
    const v = sherpa.createTts(spec, { provider: "cpu", numThreads: 1 }, 1);
    v.generate({ text: "Hello.", sid: 0, speed: 1 });
    coldMs.push(performance.now() - t0);
    v.free?.();
  }
  row("tts", `Ember's voice cold start (${sherpa.backend}: load + warm-up)`, coldMs, "a first reply waits for it unless warmed");
  const voice = sherpa.createTts(spec, { provider: "cpu", numThreads: 1 }, 1);
  voice.generate({ text: "Hello.", sid: 0, speed: 1 });
  const textMs = [], synthMs = [], firstMs = [];
  for (let r = 0; r < Math.max(1, Math.round(RUNS / ANSWERS.length)); r++) for (const answer of ANSWERS) {
    // The mock streams a word every WORD_MS: the first chunk is ready once SpeechStream gives it.
    const stream = new m.SpeechStream();
    const words = answer.split(/(?<= )/);
    let first = null, at = 0;
    for (const w of words) { at += WORD_MS; const out = stream.push(w); if (out.length) { first = out[0]; break; } }
    if (!first) { first = stream.finish(answer)[0]; at = words.length * WORD_MS; }
    // The speech process cuts it again (speechChunks) and makes its first piece.
    const chunk = m.speechChunks(first)[0];
    const t0 = performance.now();
    voice.generate({ text: chunk, sid: 0, speed: 1 });
    const synth = performance.now() - t0;
    textMs.push(at); synthMs.push(synth); firstMs.push(at + synth);
  }
  row("tts", "first token → first chunk ready (stream at the mock's pace)", textMs, `${WORD_MS} ms a word`);
  row("tts", `first chunk → its audio (${sherpa.backend}, warm)`, synthMs);
  row("tts", "first token → first audio", firstMs);
  voice.free?.();
}

/** The Copilot runtime with the mock model, as the conductor's integration test runs it. */
async function copilot(mockOpts) {
  const { startMockLlm } = await import(path.join(root, "test/mock-llm/server.mjs"));
  const { CopilotClient, RuntimeConnection } = require("@github/copilot-sdk");
  const mock = await startMockLlm(mockOpts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-latency-copilot-"));
  const runtime = m.locateRuntime({ appPath: root });
  const client = new CopilotClient({
    mode: "empty", baseDirectory: path.join(dir, "copilot"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: runtime.path }),
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  await client.start();
  const settings = new m.SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const conductor = (handlers = {}) => new m.Conductor({
    client, settings, presenter: new m.Presenter(() => undefined), log: m.createLogger({ dir: path.join(dir, "logs") }),
    stateFile: path.join(dir, "agent.json"), workDir: path.join(dir, "empty"), model: "mock-model",
    provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, ...handlers,
  });
  return { mock, client, conductor, close: async () => { await client.stop(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

if (only.has("ask")) {
  console.log("\nA typed question → the first answer token (real Copilot runtime, mock model answering at once)");
  // No "reasoning" before the answer, and no pause between words: what's left is Ember's and the runtime's own time.
  const cp = await copilot({ delayMs: 0, respond: () => ({ text: "It's a quarter to four, and your next meeting is at four." }) });
  let first = null, done = null;
  const c = cp.conductor({ onAnswerDelta: () => first?.(), onTurnEnd: () => done?.() });
  const t0 = performance.now();
  await c.start();
  const startMs = performance.now() - t0;
  const firstMs = [], sendMs = [];
  for (let i = 0; i <= RUNS; i++) {
    const gotFirst = new Promise(r => { first = r; }), ended = new Promise(r => { done = r; });
    const a = performance.now();
    await c.ask(`What time is it? (${i})`);
    const sent = performance.now() - a;
    await gotFirst;
    const ms = performance.now() - a;
    first = null;
    await ended;
    // The first turn of a conversation also sets the runtime up: counted apart.
    if (i === 0) row("ask", "first question of a conversation → first token", [ms]);
    else { firstMs.push(ms); sendMs.push(sent); }
  }
  row("ask", "conductor session start (create + check tools)", [startMs], "once a connection");
  row("ask", "question → sent to the runtime", sendMs);
  row("ask", "question → first answer token", firstMs);
  await c.stop();
  await cp.close();
}

if (only.has("kill")) {
  console.log("\nThe kill switch");
  const cp = await copilot({ delayMs: 40, respond: () => ({ text: Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ") }) });
  const h = { delta: null, end: null };
  const c = cp.conductor({ onAnswerDelta: () => h.delta?.(), onTurnEnd: () => h.end?.() });
  await c.start();
  const x = process.env.DISPLAY ? m.openXInput() : null;
  const log = m.createLogger({ dir: path.join(tmp, "kill-logs") });
  const pullMs = [], allMs = [];
  for (let i = 0; i < RUNS; i++) {
    const going = new Promise(r => { h.delta = r; });
    await c.ask(`Tell me a long story (${i})`);
    await going;
    h.delta = null;
    let borrow = null, run = null;
    if (x) {
      const screen = x.screenSize();
      borrow = new m.CursorBorrow(x);
      run = borrow.borrow(async hand => { for (let k = 0; ; k++) await hand.glideTo(k % 2 ? 100 : screen.width - 100, k % 2 ? 100 : screen.height - 100); }, { idleMs: 0 }).catch(() => undefined);
      await new Promise(r => setTimeout(r, 200));
    }
    const idle = new Promise(r => { h.end = r; });
    const ks = new m.KillSwitch(() => [
      { name: "borrow", stop: () => borrow?.stop() },
      { name: "agent", stop: () => c.abort() },
    ], log);
    const t0 = performance.now();
    const r = await ks.pull("hotkey");
    pullMs.push(r.ms);
    await Promise.all([idle, run]);
    allMs.push(performance.now() - t0);
    h.end = null;
  }
  row("kill", "kill switch → pull() returned", pullMs, x ? "a streaming answer and a borrowed mouse mid-glide" : "a streaming answer (no display: no mouse)");
  row("kill", "kill switch → everything stopped (turn idle, mouse let go)", allMs);
  x?.close();
  await c.stop();
  await cp.close();
}

if (only.has("task")) {
  console.log("\nA task: start → first tool call, and each tool call (the eval's scripted tasks on the GTK test bench)");
  if (!process.env.DISPLAY) console.log("  (no display: run under xvfb-run and dbus-run-session)");
  else {
    const out = path.join(tmp, "eval-out");
    const tasks = "bench-fill-name,bench-night-light,bench-whole-form,editor-append-line";
    const r = spawnSync(process.execPath, [path.join(root, "eval", "run.mjs"), "--only", tasks, "--repeat", String(Math.max(3, Math.round(RUNS / 4))), "--no-gates", "--out", out], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 900_000 });
    if (!fs.existsSync(path.join(out, "results.json"))) console.log(`  (the eval didn't run: ${(r.stderr || r.stdout || "").split("\n").slice(-5).join(" ")})`);
    else {
      const res = JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf8"));
      const attempts = res.tasks.flatMap(t => t.attempts);
      const firstCall = attempts.map(a => a.timing?.firstCallMs).filter(x => typeof x === "number");
      const tools = attempts.flatMap(a => a.timing?.toolMs ?? []);
      const firstAction = attempts.map(a => a.firstActionMs).filter(x => typeof x === "number");
      const passed = res.tasks.filter(t => t.status === "pass").length;
      row("task", "task start → first model request (session made)", attempts.map(a => a.timing?.firstRequestMs).filter(x => typeof x === "number"));
      row("task", "task start → first tool call", firstCall);
      row("task", "task start → first action in the app", firstAction, `${passed} of ${res.tasks.length} tasks passed`);
      row("task", "a tool call in the worker (any tool)", tools);
      const names = [...new Set(attempts.flatMap(a => Object.keys(a.timing?.byTool ?? {})))].sort();
      for (const name of names) row("task", `  ${name}`, attempts.flatMap(a => a.timing?.byTool?.[name] ?? []));
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2) + "\n");
fs.rmSync(bundle, { force: true });
process.exit(0);
