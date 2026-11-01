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
import { Player, type PlayerAudio } from "./player";
import { speechWatch, type WatchedUtterance } from "./speech-watch";
import { bestVoice } from "./voices";

declare global { interface Window { emberMic: MicApi } }

const api = window.emberMic;
let port: MessagePort | null = null;
let capture: Capture | null = null;

window.addEventListener("message", e => {
  if (e.data === "ember-voice-port" && e.ports[0] && !capture) {
    port = e.ports[0];
    capture = new Capture({
      getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false }),
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
    node.port.onmessage = ev => port?.postMessage(ev.data);
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
let stillSpeaking: ReturnType<typeof setInterval> | undefined;
function update(): void {
  const on = player.active || (synthStarted && synthQueued.size > 0);
  if (on === told) return;
  told = on;
  clearInterval(stillSpeaking);
  if (on) stillSpeaking = setInterval(() => api.speaking(true), 20_000);
  api.speaking(on);
}

/** Ember's own voice: main sends each reply's audio as it is made; the first chunk of sound says speech works. */
const player = new Player(() => new AudioContext({ latencyHint: "interactive" }) as unknown as PlayerAudio, on => {
  if (on) api.speech(true);
  update();
});
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
  report: ok => api.speech(ok),
});
let watching: WatchedUtterance | null = null;

/** The system's most natural local voice for the language (voices load late on some systems: asked each time). */
const systemVoice = (lang: string): SpeechSynthesisVoice | null => bestVoice(speechSynthesis.getVoices(), lang);

api.onSpeak(({ text, append }) => {
  if (!append) {
    watching?.cancelled();
    speechSynthesis.cancel();
    synthQueued = new Set();
    synthStarted = false;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language || "en-US";
  const voice = systemVoice(u.lang);
  if (voice) u.voice = voice;
  u.rate = 1.05;
  const w = watching = watch.utterance();
  const queued = synthQueued;
  queued.add(u);
  u.onstart = () => { w.started(); if (queued === synthQueued) synthStarted = true; update(); };
  // A reply replaced by the next one ends after the next has started: only the current queue counts.
  u.onend = () => { queued.delete(u); update(); };
  u.onerror = e => { w.failed(e.error); queued.delete(u); update(); };
  speechSynthesis.speak(u);
});
api.onHush(() => {
  watching?.cancelled();
  speechSynthesis.cancel();
  synthQueued = new Set();
  synthStarted = false;
  player.stop();
  update();
});

window.addEventListener("beforeunload", () => capture?.stop());
