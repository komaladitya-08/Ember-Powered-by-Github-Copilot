/**
 * The voice utility process: runs the recognizers off Electron's main thread.
 * Audio frames arrive from the microphone window over a MessagePort; events
 * go to the main process. Optionally listens to speaker output (PulseAudio
 * monitor, via parec) to reject wake words that come from videos. Tells main
 * when the microphone's frames stop arriving, so it can start listening again.
 */

import fs from "node:fs";
import { VoiceEngine, type VoiceEvent } from "./engine";
import { ModelLoadError, sherpaBackend, type ModelPaths } from "./sherpa";
import { SpeakerMonitor } from "./speakers";
import { FrameWatchdog } from "./watchdog";

type FromMain =
  /** `dev`: an unpackaged (development) build. */
  | { type: "init"; models: ModelPaths; monitor: boolean; dev: boolean }
  | { type: "self-speaking"; on: boolean }
  /** `afterQuestion`: Ember's answer asked something ("Okay." is then a reply, not a closer). */
  | { type: "follow-up"; ms: number; afterQuestion?: boolean }
  | { type: "cancel" };

/**
 * Messages for main (VoiceService); `error`: listening couldn't start (`models`: the speech models couldn't be loaded,
 * and downloading them again repairs it); `monitor`: the speakers' stream started or stopped; `stalled`: no microphone
 * frames for `ms`; `engine-error`: the recognizers failed on some audio (`count` times since the last report), and the
 * process carried on.
 */
export type VoiceProcessMessage =
  | VoiceEvent
  | { type: "ready"; loadMs: number }
  | { type: "error"; message: string; models?: boolean }
  | { type: "engine-error"; message: string; count: number }
  | { type: "stats"; cpuMs: number; audioMs: number; peak: number }
  | { type: "monitor"; on: boolean; reason?: string }
  | { type: "stalled"; ms: number };

const parent = process.parentPort;
const send = (m: VoiceProcessMessage) => parent.postMessage(m);

let engine: VoiceEngine | null = null;
let cpuMs = 0, audioMs = 0, peak = 0, reported = false;
/**
 * The recognizers failed on some audio (WebAssembly throws bare numbers): main is told, at most once a minute with how
 * many times since, and listening carries on. Thrown out of a port's handler, it would end the process, and Ember would
 * be deaf while the models load again (review #253).
 */
let failures = 0, failureReportedAt = Number.NEGATIVE_INFINITY;
const failed = (err: unknown) => {
  failures++;
  if (Date.now() - failureReportedAt < 60_000) return;
  send({ type: "engine-error", message: err instanceof Error ? err.message : `the speech recognizer failed (${String(err)})`, count: failures });
  failures = 0;
  failureReportedAt = Date.now();
};
/** The speakers' stream counts in the CPU report too (its spotter runs while a wake or stop is checked). */
const speakers = new SpeakerMonitor(f => {
  const t0 = performance.now();
  try { engine?.feedMonitor(f); } catch (err) { failed(err); }
  cpuMs += performance.now() - t0;
}, (on, reason) => send({ type: "monitor", on, ...(reason ? { reason } : {}) }));
/** Development builds only (installed Ember never keeps audio): EMBER_VOICE_DUMP=/path.f32 writes the received audio (raw float32). */
let dump: fs.WriteStream | null = null;

parent.on("message", e => {
  const m = e.data as FromMain;
  if (m.type === "init") {
    if (m.dev && process.env.EMBER_VOICE_DUMP) dump = fs.createWriteStream(process.env.EMBER_VOICE_DUMP);
    try {
      const t0 = Date.now();
      const backend = sherpaBackend(m.models, { monitor: m.monitor, onError: failed });
      engine = new VoiceEngine(backend, send);
      if (m.monitor) speakers.start();
      send({ type: "ready", loadMs: Date.now() - t0 });
    } catch (err) {
      // What WebAssembly throws while loading a model is a bare number: the models are damaged (review #254).
      if (err instanceof ModelLoadError) send({ type: "error", message: err.message, models: true });
      else if (err instanceof Error) send({ type: "error", message: err.message });
      else send({ type: "error", message: "The speech models couldn't be loaded.", models: true });
    }
    const watchdog = new FrameWatchdog(ms => send({ type: "stalled", ms }));
    setInterval(() => watchdog.check(), 1000);
    const port = e.ports[0];
    port.on("message", ev => {
      watchdog.frame();
      const d = ev.data as ArrayBuffer | ArrayBufferView;
      const frame = ArrayBuffer.isView(d) ? new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Float32Array(d);
      dump?.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      const t0 = performance.now();
      try { engine?.feed(frame); } catch (err) { failed(err); }
      cpuMs += performance.now() - t0;
      audioMs += frame.length / 16;
      for (let i = 0; i < frame.length; i++) peak = Math.max(peak, Math.abs(frame[i]));
      // First report after 5 s (shows audio is arriving), then every minute.
      if (audioMs >= (reported ? 60_000 : 5_000)) {
        send({ type: "stats", cpuMs: Math.round(cpuMs), audioMs: Math.round(audioMs), peak: Math.round(peak * 1000) / 1000 });
        reported = true; cpuMs = 0; audioMs = 0; peak = 0;
      }
    });
    port.start();
  } else if (m.type === "self-speaking") {
    engine?.selfSpeaking(m.on);
  } else if (m.type === "follow-up") {
    engine?.followUp(m.ms, { afterQuestion: m.afterQuestion });
  } else if (m.type === "cancel") {
    engine?.cancel();
  }
});

process.on("exit", () => speakers.stop());
