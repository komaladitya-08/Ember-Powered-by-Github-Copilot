/**
 * The voice utility process: runs the recognizers off Electron's main thread.
 * Audio frames arrive from the microphone window over a MessagePort; events
 * go to the main process. Optionally listens to speaker output (PulseAudio
 * monitor, via parec) to reject wake words that come from videos. Tells main
 * when the microphone's frames stop arriving, so it can start listening again.
 */

import fs from "node:fs";
import { VoiceEngine, type VoiceEvent } from "./engine";
import { sherpaBackend, type ModelPaths } from "./sherpa";
import { SpeakerMonitor } from "./speakers";
import { FrameWatchdog } from "./watchdog";

type FromMain =
  /** `dev`: an unpackaged (development) build. */
  | { type: "init"; models: ModelPaths; monitor: boolean; dev: boolean }
  | { type: "self-speaking"; on: boolean }
  | { type: "follow-up"; ms: number }
  | { type: "cancel" };

/** Messages for main (VoiceService); `monitor`: the speakers' stream started or stopped; `stalled`: no microphone frames for `ms`. */
export type VoiceProcessMessage =
  | VoiceEvent
  | { type: "ready"; loadMs: number }
  | { type: "error"; message: string }
  | { type: "stats"; cpuMs: number; audioMs: number; peak: number }
  | { type: "monitor"; on: boolean; reason?: string }
  | { type: "stalled"; ms: number };

const parent = process.parentPort;
const send = (m: VoiceProcessMessage) => parent.postMessage(m);

let engine: VoiceEngine | null = null;
let cpuMs = 0, audioMs = 0, peak = 0, reported = false;
/** The speakers' stream counts in the CPU report too (its spotter runs while a wake or stop is checked). */
const speakers = new SpeakerMonitor(f => {
  const t0 = performance.now();
  engine?.feedMonitor(f);
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
      const backend = sherpaBackend(m.models, { monitor: m.monitor });
      engine = new VoiceEngine(backend, send);
      if (m.monitor) speakers.start();
      send({ type: "ready", loadMs: Date.now() - t0 });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
      engine?.feed(frame);
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
    engine?.followUp(m.ms);
  } else if (m.type === "cancel") {
    engine?.cancel();
  }
});

process.on("exit", () => speakers.stop());
