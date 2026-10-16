/**
 * Hidden microphone window: captures audio with echo cancellation (for sound the browser itself plays; gain
 * control and noise suppression stay off: they distort speech enough to miss the wake word), resamples to
 * 16 kHz (the AudioContext does it), and streams 512-sample frames to the voice process. Also speaks Ember's
 * replies (speechSynthesis). Those play through speech-dispatcher, outside the browser's echo cancellation:
 * the voice process is told while Ember speaks instead. Nothing is stored; the stream stops (and the mic is
 * released) when Ember stops listening. Without an audio port (listening off) the page only speaks. If the
 * microphone goes away, or isn't there yet, capture starts again (capture.ts).
 */

import type { MicApi } from "../../shared/voice";
import { Capture } from "./capture";

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

/** What Ember is saying. Main is told while it lasts (repeated: main stops believing it after a minute) and when it ends. */
let saying: SpeechSynthesisUtterance | null = null;
let stillSpeaking: ReturnType<typeof setInterval> | undefined;
function setSaying(u: SpeechSynthesisUtterance | null): void {
  saying = u;
  clearInterval(stillSpeaking);
  if (u) stillSpeaking = setInterval(() => api.speaking(true), 20_000);
  api.speaking(!!u);
}

api.onSpeak(text => {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language || "en-US";
  u.rate = 1.05;
  u.onstart = () => setSaying(u);
  // A reply replaced by the next one ends after the next has started: only the current one counts.
  u.onend = u.onerror = () => { if (saying === u) setSaying(null); };
  speechSynthesis.speak(u);
});
api.onHush(() => { speechSynthesis.cancel(); setSaying(null); });

window.addEventListener("beforeunload", () => capture?.stop());
