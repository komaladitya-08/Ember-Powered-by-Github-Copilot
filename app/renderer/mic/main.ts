/**
 * Hidden microphone window: captures audio with echo cancellation (gain control
 * and noise suppression stay off: they distort speech enough to miss the wake
 * word), resamples to 16 kHz (the AudioContext does it), and streams
 * 512-sample frames to the voice process. Also speaks Ember's replies (speechSynthesis). Nothing is
 * stored; the stream stops (and the mic is released) when Ember stops listening.
 */

import type { MicApi } from "../../shared/voice";

declare global { interface Window { emberMic: MicApi } }

const api = window.emberMic;
let port: MessagePort | null = null;
let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;

window.addEventListener("message", e => {
  if (e.data === "ember-voice-port" && e.ports[0]) {
    port = e.ports[0];
    void start();
  }
});

async function start(): Promise<void> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule("worklet.js");
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "ember-frames", { numberOfInputs: 1, numberOfOutputs: 0 });
    // Copied, not transferred: ports that cross into a utility process can't carry transferables.
    node.port.onmessage = ev => port?.postMessage(ev.data);
    src.connect(node);
    if (ctx.state !== "running") await ctx.resume();
    const track = stream.getAudioTracks()[0];
    api.status({ state: "capturing", device: track?.label ?? "", rate: ctx.sampleRate, context: ctx.state });
  } catch (err) {
    api.status({ state: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}

api.onSpeak(text => {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language || "en-US";
  u.rate = 1.05;
  u.onstart = () => api.speaking(true);
  u.onend = () => api.speaking(false);
  u.onerror = () => api.speaking(false);
  speechSynthesis.speak(u);
});
api.onHush(() => { speechSynthesis.cancel(); api.speaking(false); });

window.addEventListener("beforeunload", () => {
  stream?.getTracks().forEach(t => t.stop());
  void ctx?.close();
});
