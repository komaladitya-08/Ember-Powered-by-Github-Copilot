/**
 * Native neural speech in its own utility process. Kitten Nano is the default; an explicitly downloaded Kokoro may
 * replace it only when its probe is fast enough. An unavailable, failed or slow default voice reports its reason to
 * main, which uses a local operating-system voice. Audio chunks and hush numbering keep playback cancellable.
 */

import { NATURAL_MAX_RTF, rememberedSlow, slowVerdict, speechChunks } from "./tts";
import { SUPERTONIC_SPEAKER, kittenSpec, kokoroSpec, kokoroSpeaker, supertonicSpec } from "./tts-spec";
import { fastestProvider, modelKey, providerCache, providers, sherpaRuntime, threads, type ProviderTry, type Sherpa, type SherpaBackend, type Tts } from "./runtime";

type FromMain =
  /** `model`: Kitten's folder; optional `natural`: Kokoro's folder. WASM can listen, but cannot make neural speech. */
  | { type: "init"; model: string; natural?: string | null; naturalVoice?: "kokoro" | "supertonic"; wasm?: boolean; capiDir?: string }
  /** `speed`: how fast it is said (the speaking speed setting), 1 as made. */
  | { type: "say"; id: number; text: string; speed?: number }
  | { type: "hush"; id: number };

/** Which voice speaks, its runtime/provider/threads, and measured generation seconds per playback second. */
export interface VoiceInfo {
  voice: "kitten" | "kokoro" | "supertonic";
  backend: SherpaBackend;
  detail: string;
  provider: string;
  threads: number;
  tried: ProviderTry[];
  rtf?: number;
  /** Why downloaded Kokoro is not speaking, while Kitten remains usable. */
  natural?: string;
  naturalWhy?: "slow" | "load" | "native";
}

type UnavailableReason = "slow" | "load" | "native";

/** `audio`: one chunk of `id`'s speech; `done`: all sent; `failed`: recover its ungenerated suffix with the OS voice. */
export type TtsProcessMessage =
  | { type: "ready"; loadMs: number; rate: number; voice: VoiceInfo }
  | { type: "error"; message: string; reason?: UnavailableReason }
  | { type: "audio"; id: number; samples: Float32Array; rate: number; remaining: string }
  | { type: "done"; id: number }
  | { type: "failed"; id: number; message: string };

const WARM_UP = "Hello.";
const PROBE = "I opened the terminal and ran the tests; all of them passed.";

let tts: Tts | null = null;
let sid = 0;
let rate = 24_000;
let hushed = 0;
const queue: { id: number; chunks: string[]; speed: number }[] = [];
let busy = false;
/**
 * At most this much speech is made ahead of what the page has played. A chunk being made can't be stopped, so a reply
 * that cuts in waits for it; made all at once, a long answer kept this process busy while it was heard
 * (voice-speaking-10). A CHUNK_MAX chunk (about 7 s of speech) takes at most 3.5 s to make at NATURAL_MAX_RTF.
 */
const AHEAD_MS = 8_000;
/**
 * When the speech made so far will have played (performance.now(), which a clock set back can't move): on the page it
 * can only end later, never sooner.
 */
let playsUntil = 0;
let wait: ReturnType<typeof setTimeout> | null = null;

const parent = process.parentPort;
const send = (m: TtsProcessMessage) => parent.postMessage(m);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

class VoiceUnavailable extends Error {
  constructor(readonly reason: UnavailableReason, detail: string) { super(detail); }
}

/** Time usable audio after warmup; an empty or damaged result must not be accepted as a fast voice. */
function realTimeFactor(voice: Tts, speaker: number): number {
  voice.generate({ text: WARM_UP, sid: speaker, speed: 1.0 });
  const t0 = performance.now();
  const audio = voice.generate({ text: PROBE, sid: speaker, speed: 1.0 });
  if (!audio.samples.length || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || !audio.samples.every(Number.isFinite)) throw new Error("The voice produced no usable audio.");
  return Math.round(((performance.now() - t0) / 1000 / (audio.samples.length / audio.sampleRate)) * 1000) / 1000;
}

/** One native model, using its own provider cache and one-week slow verdict keyed by model/provider/thread configuration. */
function timedVoice(sherpa: Sherpa, voice: VoiceInfo["voice"], folder: string): { voice: Tts; speaker: number; info: VoiceInfo } {
  const spec = voice === "kitten" ? kittenSpec(folder) : voice === "supertonic" ? supertonicSpec(folder) : kokoroSpec(folder);
  // Kitten leaves the other cores for applications; CoreML may compete with the CPU for the larger optional Kokoro.
  const list = providers(sherpa.backend, process.platform, process.env, { gpu: voice === "kokoro" });
  const n = threads(sherpa.backend, voice === "kitten" ? 1 : voice === "supertonic" ? 2 : 4);
  const speaker = voice === "kitten" ? 0 : voice === "supertonic" ? SUPERTONIC_SPEAKER : kokoroSpeaker(folder);
  const store = providerCache(), key = modelKey(spec.model, list, n);
  // Only an optional voice is held to one timing: a busy moment mustn't cost Ember its default voice for a week (timed at 0.81
  // with the laptop under load, 0.36 otherwise), and Kitten is timed again at every start for about a second.
  const verdictKey = key && voice !== "kitten" ? `natural|${key}` : null;
  const slow = verdictKey ? rememberedSlow(store.get(verdictKey), Date.now()) : null;
  if (slow !== null) throw new VoiceUnavailable("slow", `too slow here: ${slow} of real time (at most ${NATURAL_MAX_RTF}; timed before)`);
  const chosen = fastestProvider(list, provider => sherpa.createTts(spec, { provider, numThreads: n }, 1), v => v.generate({ text: WARM_UP, sid: speaker, speed: 1.0 }),
    { cache: { store, key }, free: v => v.free() });
  try {
    // Timed while the words just said are being recognized: Kitten came to 0.51 then and 0.28 a moment later, and one such
    // timing cost the reply Ember's own voice. The best of three says what this computer can do.
    let rtf = realTimeFactor(chosen.made, speaker);
    for (let i = 0; i < 2 && rtf > NATURAL_MAX_RTF; i++) rtf = Math.min(rtf, realTimeFactor(chosen.made, speaker));
    if (!Number.isFinite(rtf)) throw new Error("The voice could not be timed.");
    if (rtf > NATURAL_MAX_RTF) {
      if (verdictKey) store.set(verdictKey, slowVerdict(rtf, Date.now()));
      throw new VoiceUnavailable("slow", `too slow here: ${rtf} of real time (at most ${NATURAL_MAX_RTF})`);
    }
    return { voice: chosen.made, speaker, info: { voice, backend: sherpa.backend, detail: sherpa.detail, provider: chosen.provider, threads: n, tried: chosen.tried, rtf } };
  } catch (err) { chosen.made.free(); throw err; }
}

function load(m: Extract<FromMain, { type: "init" }>): { voice: Tts; speaker: number; info: VoiceInfo } {
  const sherpa = sherpaRuntime(m.wasm ? { prefer: "wasm" } : m.capiDir ? { capiDir: m.capiDir } : {});
  if (sherpa.backend !== "native") throw new VoiceUnavailable("native", `Neural speech needs the native speech runtime (${sherpa.detail}).`);
  let natural: string | undefined, naturalWhy: VoiceInfo["naturalWhy"];
  if (m.natural) {
    try { return timedVoice(sherpa, m.naturalVoice ?? "kokoro", m.natural); }
    catch (err) {
      naturalWhy = err instanceof VoiceUnavailable ? err.reason : "load";
      natural = naturalWhy === "slow" ? message(err) : `it couldn't be loaded: ${message(err)}`;
    }
  }
  try {
    const made = timedVoice(sherpa, "kitten", m.model);
    if (natural) made.info = { ...made.info, natural, naturalWhy };
    return made;
  } catch (err) {
    if (err instanceof VoiceUnavailable) throw err;
    throw new VoiceUnavailable("load", `Kitten couldn't be loaded: ${message(err)}`);
  }
}

/** Makes the next chunk, then lets messages in (a hush) before the one after. */
function step(): void {
  while (queue.length && queue[0].id <= hushed) queue.shift();
  const item = queue[0];
  if (!item || !tts) { busy = false; return; }
  busy = true;
  // Enough is made: the next chunk is made as playback nears it (a hush starts it at once).
  const ahead = playsUntil - performance.now();
  if (item.chunks.length && ahead > AHEAD_MS) { wait = setTimeout(() => { wait = null; step(); }, ahead - AHEAD_MS); return; }
  const chunk = item.chunks.shift();
  if (chunk !== undefined) {
    try {
      const audio = tts.generate({ text: chunk, sid, speed: item.speed });
      if (!audio.samples.length) throw new Error("The voice produced no audio.");
      playsUntil = Math.max(playsUntil, performance.now()) + (audio.samples.length / audio.sampleRate) * 1000;
      if (item.id > hushed) send({ type: "audio", id: item.id, samples: audio.samples, rate: audio.sampleRate, remaining: item.chunks.join(" ") });
    } catch (err) {
      // Main lets the local system voice say only the ungenerated remainder.
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
      send({ type: "error", message: err instanceof Error ? err.message : "Ember's voice couldn't be loaded.", reason: err instanceof VoiceUnavailable ? err.reason : "load" });
    }
    if (!busy) { busy = true; setImmediate(step); }
  } else if (m.type === "say") {
    const chunks = speechChunks(m.text);
    if (!chunks.length) { send({ type: "done", id: m.id }); return; }
    // The speaking speed as settings keep it (0.8 to 1.4); anything else is said as made.
    const speed = typeof m.speed === "number" && m.speed >= 0.8 && m.speed <= 1.4 ? m.speed : 1;
    queue.push({ id: m.id, chunks, speed });
    // On the next turn: a hush sent right after (a new answer cutting this one off) is heard first.
    if (!busy) { busy = true; setImmediate(step); }
  } else if (m.type === "hush") {
    hushed = Math.max(hushed, m.id);
    // Every reply made so far is hushed (main hushes up to its latest), and the page stopped playing it.
    playsUntil = 0;
    if (wait) { clearTimeout(wait); wait = null; setImmediate(step); }
  }
});
