/**
 * Hidden microphone window: captures audio with echo cancellation (for sound the browser itself plays; gain
 * control and noise suppression stay off: they distort speech enough to miss the wake word), resamples to
 * 16 kHz (the AudioContext does it), and streams 512-sample frames to the voice process. Also speaks Ember's
 * replies: in Ember's own neural voice (its audio comes from main, made by the speech process, and plays here), or
 * with the system's voice (speechSynthesis, through speech-dispatcher on Linux, outside the browser's echo
 * cancellation). Either way the voice process is told while Ember speaks. Nothing is stored; the stream stops (and the mic is
 * released) when Ember stops listening. Without an audio port (listening off) the page only speaks. If the
 * microphone goes away, or isn't there yet, capture starts again (capture.ts).
 */

import type { MicApi } from "../../shared/voice";
import { Capture } from "./capture";
import { Player, playerAudio, type PlayerContext } from "./player";
import { speechWatch, type WatchedUtterance } from "./speech-watch";
import { LocalSpeech } from "./local-speech";
import { LEVEL_MS, VOICE_KEEP_ALIVE_MS, VOICE_LEVEL_MS, LevelMeter, envelope, rms, voiceAt, type VoiceSpan } from "../../shared/level";

declare global { interface Window { emberMic: MicApi } }

const api = window.emberMic;
/** Keep the warning in sync across neural playback, local-voice loading and the system-speech watchdog. */
let speechOk: boolean | null = null;
function reportSpeech(ok: boolean): void {
  if (ok === speechOk) return;
  speechOk = ok;
  api.speech(ok);
}
let port: MessagePort | null = null;
let capture: Capture | null = null;

/**
 * The microphone's level for Ember's presence, only while main asks for it (Ember hears a request): a step of eight,
 * sent at most 20 times a second and only when it changed (app/shared/level.ts). Never the audio itself.
 */
let micLevels = false;
const micMeter = new LevelMeter(l => api.level({ mic: l }));
api.onLevelOn(on => {
  micLevels = on;
  if (!on) micMeter.end();
});

window.addEventListener("message", e => {
  if (e.data === "ember-voice-port" && e.ports[0] && !capture) {
    port = e.ports[0];
    const echoCancellation = new URLSearchParams(location.search).get("testMicWav") !== "1";
    capture = new Capture({
      getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false }),
      enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      onDeviceChange: fn => navigator.mediaDevices.addEventListener("devicechange", fn),
      graph,
      status: s => api.status(s),
    });
    void capture.start();
  }
});

/** 16 kHz (the AudioContext resamples) → the worklet's 512-sample frames → the voice process. */
async function graph(stream: MediaStream): Promise<AudioContext> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    await ctx.audioWorklet.addModule("worklet.js");
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "ember-frames", { numberOfInputs: 1, numberOfOutputs: 0 });
    // Copied, not transferred: ports that cross into a utility process can't carry transferables.
    node.port.onmessage = ev => {
      port?.postMessage(ev.data);
      if (micLevels && ev.data instanceof ArrayBuffer) micMeter.push(rms(new Float32Array(ev.data)), performance.now());
    };
    src.connect(node);
    if (ctx.state !== "running") await ctx.resume();
    return ctx;
  } catch (err) {
    void ctx.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Whether Ember is speaking, in its own voice (the player) or the system's (utterances queued and not ended). Main is
 * told while it lasts (repeated: main stops believing it after a minute) and when it ends.
 */
let synthQueued = new Set<SpeechSynthesisUtterance>();
/**
 * Whether the system's voice has started on the current queue: until it has, queued words don't count as speaking (with
 * no voice installed they never start, and Ember would seem to talk over the user for a minute); from then, the gap
 * between two queued sentences doesn't end it.
 */
let synthStarted = false;
let told = false;
let speechGeneration = 0;
let stillSpeaking: ReturnType<typeof setInterval> | undefined;
function update(): void {
  const on = player.active || (synthStarted && synthQueued.size > 0);
  if (on === told) return;
  told = on;
  clearInterval(stillSpeaking);
  const generation = speechGeneration;
  if (on) stillSpeaking = setInterval(() => api.speaking(true, generation), 20_000);
  api.speaking(on, generation);
}

/**
 * Ember's own voice level as it plays, for its presence: each chunk's envelope (one RMS per 50 ms) is kept with when it
 * starts, and while the voice plays a timer reads the level at the audio clock's time (only then: none runs while Ember
 * is quiet). The system's voice has no samples to read, so it shows no meter: never one that moves on nothing.
 */
let spans: VoiceSpan[] = [];
let voiceTimer: ReturnType<typeof setInterval> | undefined;
// (Read on a 100 ms timer: a little slack, so a tick that comes a hair early is not held back to the next. Between two
// chunks it reads silence: the meter rests, and goes only when the voice has stopped. A level that holds is sent again
// every VOICE_KEEP_ALIVE_MS: Ember's mouth follows its voice only while levels keep coming.)
const voiceMeter = new LevelMeter(l => api.level({ voice: l }), VOICE_LEVEL_MS - 5, VOICE_KEEP_ALIVE_MS);
function voicePlaying(on: boolean): void {
  clearInterval(voiceTimer);
  voiceTimer = undefined;
  if (!on) { spans = []; voiceMeter.end(); return; }
  voiceTimer = setInterval(() => {
    const t = player.time;
    if (t === null) return;
    spans = spans.filter(s => s.at + s.env.length * s.stepS > t);
    const v = voiceAt(spans, t);
    voiceMeter.push(v ?? 0, performance.now());
  }, VOICE_LEVEL_MS);
}

/** Ember's own voice: main sends each reply's audio as it is made; the first chunk of sound says speech works. */
const player = new Player(() => playerAudio(new AudioContext({ latencyHint: "interactive" }) as unknown as PlayerContext, new URLSearchParams(location.search).get("playback") === "element"), on => {
  if (on) reportSpeech(true);
  voicePlaying(on);
  update();
  if (!on) localSpeech.drain();
}, (at, samples, rate) => { spans.push({ at, env: envelope(samples, rate), stepS: LEVEL_MS / 1000 }); });
api.onAudio(a => {
  const seconds = player.chunk(a.id, a.samples, a.rate);
  if (seconds) api.played({ id: a.id, seconds: Math.round(seconds * 100) / 100 });
});
api.onAudioDone(id => player.done(id));

/**
 * Whether replies are heard at all: with no voice on the computer an utterance never starts, and main shows that in
 * settings (review #101). The wait is longer than a cold speech-dispatcher takes to start.
 */
const watch = speechWatch({
  timeoutMs: 8000,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  report: reportSpeech,
});
let watching: WatchedUtterance | null = null;

/** Local fallback waits for neural audio to finish, and briefly for voices to load. */
const localSpeech = new LocalSpeech({
  voices: () => speechSynthesis.getVoices(),
  busy: () => player.active,
  speak: speakLocal,
  unavailable: () => reportSpeech(false),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}, navigator.language || "en-US");
speechSynthesis.addEventListener("voiceschanged", () => localSpeech.drain());

function speakLocal(text: string, voice: SpeechSynthesisVoice): void {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language || "en-US";
  u.voice = voice;
  u.rate = 1.05;
  const w = watching = watch.utterance();
  const queued = synthQueued;
  queued.add(u);
  u.onstart = () => { if (queued !== synthQueued) return; w.started(); reportSpeech(true); synthStarted = true; update(); };
  // A reply replaced by the next one ends after the next has started: only the current queue counts.
  u.onend = () => { if (queued !== synthQueued) return; queued.delete(u); update(); };
  u.onerror = e => { if (queued !== synthQueued) return; w.failed(e.error); queued.delete(u); update(); };
  speechSynthesis.speak(u);
}

api.onSpeak(({ text, append }) => {
  if (!append) hush();
  localSpeech.enqueue(text);
});
function hush(): void {
  localSpeech.cancel();
  watching?.cancelled();
  speechSynthesis.cancel();
  synthQueued = new Set();
  synthStarted = false;
  player.stop();
  update();
}
api.onHush(generation => { hush(); speechGeneration = generation; api.speaking(false, speechGeneration); });

window.addEventListener("beforeunload", () => capture?.stop());
