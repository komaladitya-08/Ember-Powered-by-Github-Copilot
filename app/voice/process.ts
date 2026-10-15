/**
 * The voice utility process: runs the recognizers off Electron's main thread.
 * Audio frames arrive from the microphone window over a MessagePort; events
 * go to the main process. Optionally listens to speaker output (PulseAudio
 * monitor, via parec) to reject wake words that come from videos.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { VoiceEngine, type VoiceEvent } from "./engine";
import { sherpaBackend, type ModelPaths } from "./sherpa";

type FromMain =
  | { type: "init"; models: ModelPaths; monitor: boolean }
  | { type: "self-speaking"; on: boolean }
  | { type: "follow-up"; ms: number }
  | { type: "cancel" };

type ToMain = VoiceEvent | { type: "ready"; loadMs: number; monitor: boolean } | { type: "error"; message: string } | { type: "stats"; cpuMs: number; audioMs: number; peak: number };

const parent = process.parentPort;
const send = (m: ToMain) => parent.postMessage(m);

let engine: VoiceEngine | null = null;
let monitor: ChildProcess | null = null;
let cpuMs = 0, audioMs = 0, peak = 0, reported = false;
// Development only: EMBER_VOICE_DUMP=/path.f32 writes the received audio (raw float32) for debugging.
const dump = process.env.EMBER_VOICE_DUMP ? fs.createWriteStream(process.env.EMBER_VOICE_DUMP) : null;

function startMonitor(): boolean {
  // Speaker output as 16 kHz mono float: whatever is playing (videos, calls).
  const p = spawn("parec", ["--device=@DEFAULT_MONITOR@", "--rate=16000", "--channels=1", "--format=float32le", "--latency-msec=40"], { stdio: ["ignore", "pipe", "ignore"] });
  let ok = true;
  p.on("error", () => { ok = false; monitor = null; });
  let rest = Buffer.alloc(0);
  p.stdout!.on("data", (chunk: Buffer) => {
    rest = Buffer.concat([rest, chunk]);
    const usable = rest.length - (rest.length % 2048);
    for (let i = 0; i < usable; i += 2048) {
      const f = new Float32Array(rest.buffer.slice(rest.byteOffset + i, rest.byteOffset + i + 2048));
      engine?.feedMonitor(f);
    }
    rest = rest.subarray(usable);
  });
  monitor = p;
  return ok;
}

parent.on("message", e => {
  const m = e.data as FromMain;
  if (m.type === "init") {
    try {
      const t0 = Date.now();
      const backend = sherpaBackend(m.models, { monitor: m.monitor });
      engine = new VoiceEngine(backend, send);
      const monitorOn = m.monitor && startMonitor();
      send({ type: "ready", loadMs: Date.now() - t0, monitor: monitorOn });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    const port = e.ports[0];
    port.on("message", ev => {
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

process.on("exit", () => monitor?.kill());
