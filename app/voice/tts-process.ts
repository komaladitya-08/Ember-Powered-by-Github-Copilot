/**
 * Ember's voice process: the neural voice (app/voice/tts.ts) in a utility process of its own, so making speech never
 * holds up listening (the voice process) or Ember's main thread. Main sends what to say, numbered; this process says
 * it chunk by chunk (speechChunks), sending each chunk's audio as soon as it's made, and "done" after the last. A
 * hush drops everything up to the number it names, between chunks (a chunk takes a fraction of a second to make). The
 * audio goes to main, which hands it to the page that plays it (renderer/mic).
 * It runs on sherpa-onnx's native addon on Windows and macOS, its WebAssembly build elsewhere (runtime.ts). Natively,
 * the natural voice (Kokoro, models.ts NATURAL_VOICE) speaks when it is downloaded and this computer makes it fast
 * enough (timed when it loads); otherwise the Piper voice does.
 */

import { NATURAL_MAX_RTF, rememberedSlow, slowVerdict, speechChunks } from "./tts";
import { kokoroSpec, kokoroSpeaker, piperSpec } from "./tts-spec";
import { fastestProvider, modelKey, providerCache, providers, sherpaRuntime, threads, type ProviderTry, type SherpaBackend, type Tts } from "./runtime";

type FromMain =
  /** `model`: the Piper voice's folder; `natural`: Kokoro's (when downloaded); `wasm`: run on WebAssembly (a process before this one died loading natively). */
  | { type: "init"; model: string; natural?: string | null; wasm?: boolean }
  | { type: "say"; id: number; text: string }
  | { type: "hush"; id: number };

/** Which voice speaks, on which build and how, and how fast it is here (`rtf`: seconds to make a second of speech; measured natively only). */
export interface VoiceInfo {
  voice: "piper" | "kokoro";
  backend: SherpaBackend;
  detail: string;
  provider: string;
  threads: number;
  tried: ProviderTry[];
  rtf?: number;
  /** Why the natural voice isn't speaking, when it was downloaded. */
  natural?: string;
}

/** `audio`: one chunk of `id`'s speech (mono, `rate` Hz); `done`: the last of it was sent; `failed`: it couldn't be said. */
export type TtsProcessMessage =
  | { type: "ready"; loadMs: number; rate: number; voice: VoiceInfo }
  | { type: "error"; message: string }
  | { type: "audio"; id: number; samples: Float32Array; rate: number }
  | { type: "done"; id: number }
  | { type: "failed"; id: number; message: string };

/** What a voice is timed on: a warm-up, then a sentence of about three seconds. */
const WARM_UP = "Hello.";
const PROBE = "I opened the terminal and ran the tests; all of them passed.";

let tts: Tts | null = null;
let sid = 0;
let rate = 22_050;
let hushed = 0;
const queue: { id: number; chunks: string[] }[] = [];
let busy = false;

const parent = process.parentPort;
const send = (m: TtsProcessMessage) => parent.postMessage(m);

/** Seconds `voice` takes to make a second of speech (after a warm-up: the first run sets up onnxruntime's buffers). */
function realTimeFactor(voice: Tts, speaker: number): number {
  voice.generate({ text: WARM_UP, sid: speaker, speed: 1.0 });
  const t0 = performance.now();
  const audio = voice.generate({ text: PROBE, sid: speaker, speed: 1.0 });
  const seconds = audio.samples.length / audio.sampleRate;
  return seconds > 0 ? Math.round(((performance.now() - t0) / 1000 / seconds) * 1000) / 1000 : Infinity;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

/** The voice that speaks: Kokoro when it's there and fast enough here (natively), otherwise the Piper voice. */
function load(m: Extract<FromMain, { type: "init" }>): { voice: Tts; speaker: number; info: VoiceInfo } {
  const sherpa = sherpaRuntime(m.wasm ? { prefer: "wasm" } : {});
  const list = providers(sherpa.backend);
  let natural: string | undefined;
  if (m.natural && sherpa.backend === "native") {
    // Kokoro is the model a GPU helps: CoreML competes with the CPU for it on macOS.
    const list = providers(sherpa.backend, process.platform, process.env, { gpu: true });
    try {
      const n = threads(sherpa.backend, 4);
      const spec = kokoroSpec(m.natural);
      const store = providerCache();
      const key = modelKey(spec.model, list, n);
      const verdictKey = key && `natural|${key}`;
      const slow = verdictKey ? rememberedSlow(store.get(verdictKey), Date.now()) : null;
      if (slow !== null) {
        natural = `too slow here: ${slow} of real time (at most ${NATURAL_MAX_RTF}; timed before)`;
      } else {
        const speaker = kokoroSpeaker(m.natural);
        const chosen = fastestProvider(list, provider => sherpa.createTts(spec, { provider, numThreads: n }, 1), v => v.generate({ text: WARM_UP, sid: speaker, speed: 1.0 }),
          { cache: { store, key } });
        const rtf = realTimeFactor(chosen.made, speaker);
        const info = { backend: sherpa.backend, detail: sherpa.detail, provider: chosen.provider, threads: n, tried: chosen.tried, rtf };
        if (rtf <= NATURAL_MAX_RTF) return { voice: chosen.made, speaker, info: { voice: "kokoro", ...info } };
        chosen.made.free();
        if (verdictKey) store.set(verdictKey, slowVerdict(rtf, Date.now()));
        natural = `too slow here: ${rtf} of real time (at most ${NATURAL_MAX_RTF})`;
      }
    } catch (err) {
      natural = `it couldn't be loaded: ${message(err)}`;
    }
  } else if (m.natural) {
    natural = `it needs the native build (${sherpa.detail})`;
  }
  // One thread: on a computer kept busy by other apps, a second made it slower (all 4 cores busy: 0.16 of real time on
  // two threads, 0.14 on one), and when idle it saved only about 30 ms a sentence (0.10 against 0.13).
  const n = threads(sherpa.backend, 1);
  const spec = piperSpec(m.model);
  const chosen = fastestProvider(list, provider => sherpa.createTts(spec, { provider, numThreads: n }, 1), v => v.generate({ text: WARM_UP, sid: 0, speed: 1.0 }),
    { cache: { store: providerCache(), key: modelKey(spec.model, list, n) } });
  // Timed natively only (it tells main whether this computer is fast enough for the natural voice): in WebAssembly
  // the probe would hold up the first reply by two seconds.
  const rtf = sherpa.backend === "native" ? realTimeFactor(chosen.made, 0) : undefined;
  return {
    voice: chosen.made, speaker: 0,
    info: { voice: "piper", backend: sherpa.backend, detail: sherpa.detail, provider: chosen.provider, threads: n, tried: chosen.tried, ...(rtf !== undefined ? { rtf } : {}), ...(natural ? { natural } : {}) },
  };
}

/** Makes the next chunk, then lets messages in (a hush) before the one after. */
function step(): void {
  while (queue.length && queue[0].id <= hushed) queue.shift();
  const item = queue[0];
  if (!item || !tts) { busy = false; return; }
  busy = true;
  const chunk = item.chunks.shift();
  if (chunk !== undefined) {
    try {
      const audio = tts.generate({ text: chunk, sid, speed: 1.0 });
      if (item.id > hushed && audio.samples.length) send({ type: "audio", id: item.id, samples: audio.samples, rate: audio.sampleRate });
    } catch (err) {
      // WebAssembly throws bare numbers: the rest of this reply goes unsaid (main lets the system's voice say it).
      queue.shift();
      send({ type: "failed", id: item.id, message: err instanceof Error ? err.message : `the voice failed (${String(err)})` });
      setImmediate(step);
      return;
    }
  }
  if (!item.chunks.length) {
    queue.shift();
    if (item.id > hushed) send({ type: "done", id: item.id });
  }
  setImmediate(step);
}

parent.on("message", e => {
  const m = e.data as FromMain;
  if (m.type === "init") {
    try {
      const t0 = Date.now();
      const made = load(m);
      tts = made.voice;
      sid = made.speaker;
      rate = Number(tts.sampleRate) || rate;
      send({ type: "ready", loadMs: Date.now() - t0, rate, voice: made.info });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : "Ember's voice couldn't be loaded." });
    }
    if (!busy) { busy = true; setImmediate(step); }
  } else if (m.type === "say") {
    const chunks = speechChunks(m.text);
    if (!chunks.length) { send({ type: "done", id: m.id }); return; }
    queue.push({ id: m.id, chunks });
    // On the next turn: a hush sent right after (a new answer cutting this one off) is heard first.
    if (!busy) { busy = true; setImmediate(step); }
  } else if (m.type === "hush") {
    hushed = Math.max(hushed, m.id);
  }
});
