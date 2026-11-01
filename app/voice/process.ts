/**
 * The voice utility process: runs the recognizers off Electron's main thread.
 * Audio frames arrive from the microphone window over a MessagePort; events
 * go to the main process. Optionally listens to speaker output (PulseAudio
 * monitor, via parec) to reject wake words that come from videos. Tells main
 * when the microphone's frames stop arriving, so it can start listening again.
 */

import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { VoiceEngine, type VoiceBackend, type VoiceEvent } from "./engine";
import { Enrolment, VoiceGate, type EnrolState, type Printer } from "./match";
import { decodePrint, encodePrint } from "./voiceprint";
import type { VoiceprintWorkerMessage } from "./voiceprint-worker";
import { ModelLoadError, sherpaBackend, type BackendInfo, type ModelPaths } from "./sherpa";
import { SpeakerMonitor } from "./speakers";
import { FrameWatchdog, SilenceWatch } from "./watchdog";

type FromMain =
  /** `dev`: an unpackaged (development) build. */
  /** `voiceprint`: the owner's (Voice Match on), base64 (voiceprint.ts). */
  /** `wasm`: run on WebAssembly (a voice process before this one died loading natively; runtime.ts). */
  | { type: "init"; models: ModelPaths; monitor: boolean; dev: boolean; voiceprint?: string | null; wasm?: boolean }
  /** Voice Match turned on (the owner's voiceprint) or off (null). */
  | { type: "voiceprint"; print: string | null }
  /** Enrolment: listen for the owner's phrases (nothing heard meanwhile is a request), or stop doing so. */
  | { type: "enrol" }
  | { type: "enrol-cancel" }
  | { type: "self-speaking"; on: boolean }
  /** `afterQuestion`: Ember's answer asked something ("Okay." is then a reply, not a closer). */
  | { type: "follow-up"; ms: number; afterQuestion?: boolean }
  | { type: "cancel" };

/**
 * Messages for main (VoiceService); `error`: listening couldn't start (`models`: the speech models couldn't be loaded,
 * and downloading them again repairs it; `model`: which one, when known); `monitor`: the speakers' stream started or stopped; `stalled`: no microphone
 * frames for `ms`; `engine-error`: the recognizers failed on some audio (`count` times since the last report), and the
 * process carried on; `engine-broken`: they keep failing, so they are taken for unusable (main starts the process again);
 * `alive`: every second once started (main restarts a process that goes quiet: it is stuck or
 * suspended, and can't say so itself); `silent`: the microphone has sent only digital silence for a minute (muted, or
 * the wrong input), or sends sound again.
 */
export type VoiceProcessMessage =
  | VoiceEvent
  /** `backend`: which build of sherpa-onnx runs the recognizers, and how (runtime.ts). */
  | { type: "ready"; loadMs: number; backend: BackendInfo }
  | { type: "error"; message: string; models?: boolean; model?: "kws" | "vad" | "asr" }
  | { type: "engine-error"; message: string; count: number }
  | { type: "engine-broken"; message: string }
  | { type: "stats"; cpuMs: number; audioMs: number; peak: number }
  | { type: "monitor"; on: boolean; reason?: string }
  | { type: "stalled"; ms: number }
  | { type: "alive" }
  | { type: "silent"; on: boolean }
  /** Enrolment's progress; at "done", `print` is the owner's voiceprint (base64) for main to keep. */
  | { type: "enrol"; state: Exclude<EnrolState["state"], "done">; got: number; of: number; why?: string }
  | { type: "enrol"; state: "done"; got: number; of: number; print: string }
  /** Voice Match couldn't check a request (it was heard anyway). */
  | { type: "voice-match-error"; message: string };

/** Which model a ModelLoadError is about, by the name sherpa.ts gives it ("The wake word model couldn't be loaded."). */
const LOADED_AS: [RegExp, "kws" | "vad" | "asr"][] = [[/wake word/i, "kws"], [/voice activity/i, "vad"], [/speech recognition/i, "asr"]];
const damagedModel = (message: string) => LOADED_AS.find(([re]) => re.test(message))?.[1];

const parent = process.parentPort;
const send = (m: VoiceProcessMessage) => parent.postMessage(m);

let engine: VoiceEngine | null = null;
let backend: (VoiceBackend & { free(): void }) | null = null;
let speakerModel = "";

/** The voiceprint model on a worker thread (started when Voice Match or enrolment first needs it). */
let printer: (Printer & { stop(): void }) | null = null;
function voiceprinter(): Printer {
  if (printer) return printer;
  const worker = new Worker(path.join(__dirname, "voiceprint.cjs"));
  const waiting = new Map<number, { resolve: (p: Float32Array) => void; reject: (e: Error) => void }>();
  let next = 0, broken: Error | null = null;
  const fail = (err: Error) => { broken = err; for (const w of waiting.values()) w.reject(err); waiting.clear(); printer = null; };
  worker.on("message", (m: VoiceprintWorkerMessage) => {
    if ("type" in m) { if (m.type === "error") fail(new Error(`the voiceprint model couldn't be loaded: ${m.message}`)); return; }
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.print) w?.resolve(m.print); else w?.reject(new Error(m.error ?? "no voiceprint"));
  });
  worker.on("error", err => fail(err));
  worker.on("exit", code => fail(new Error(`the voiceprint thread stopped (${code})`)));
  worker.postMessage({ type: "init", model: speakerModel });
  const made = {
    print: (samples: Float32Array) => new Promise<Float32Array>((resolve, reject) => {
      if (broken) { reject(broken); return; }
      const id = ++next;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ type: "print", id, samples });
    }),
    stop: () => { void worker.terminate(); },
  };
  printer = made;
  return made;
}
/** Requests go through Voice Match on their way to main. */
const gate = new VoiceGate(voiceprinter, e => send(e), err => send({ type: "voice-match-error", message: err instanceof Error ? err.message : String(err) }),
  undefined, () => engine?.cancel());
/** Enrolment under way: the microphone's speech goes to it (through the VAD) instead of the engine. */
let enrolment: Enrolment | null = null;
function enrolFrame(frame: Float32Array): void {
  if (!backend || !enrolment) return;
  for (const seg of backend.vad(frame)) void enrolment.heard(seg);
}
function endEnrolment(): void {
  enrolment = null;
  backend?.resetVad();
}
let cpuMs = 0, audioMs = 0, peak = 0, reported = false;
/**
 * The recognizers failed on some audio (WebAssembly throws bare numbers): main is told, at most once a minute with how
 * many times since, and listening carries on. Thrown out of a port's handler, it would end the process, and Ember would
 * be deaf while the models load again (review #253).
 */
let failures = 0, failureReportedAt = Number.NEGATIVE_INFINITY;
/**
 * More failures than BROKEN_FAILURES within BROKEN_MS: the recognizers are unusable (a WebAssembly abort or running out
 * of memory leaves the module so, and every frame fails), so main is told once and nothing more is fed to them; main
 * starts the process again with fresh models, with its backoff. Listening would otherwise stay deaf while showing
 * "Listening" (review #253).
 */
const BROKEN_FAILURES = 20, BROKEN_MS = 10_000;
let recentFailures: number[] = [], broken = false;
const failed = (err: unknown) => {
  if (broken) return;
  const message = err instanceof Error ? err.message : `the speech recognizer failed (${String(err)})`;
  const now = Date.now();
  recentFailures = recentFailures.filter(t => now - t < BROKEN_MS);
  recentFailures.push(now);
  if (recentFailures.length > BROKEN_FAILURES) { broken = true; send({ type: "engine-broken", message }); return; }
  failures++;
  if (now - failureReportedAt < 60_000) return;
  send({ type: "engine-error", message, count: failures });
  failures = 0;
  failureReportedAt = now;
};
/** The speakers' stream counts in the CPU report too (its spotter runs while a wake or stop is checked). */
const speakers = new SpeakerMonitor(f => {
  const t0 = performance.now();
  if (!broken) try { engine?.feedMonitor(f); } catch (err) { failed(err); }
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
      const recognizers = sherpaBackend(m.models, { monitor: m.monitor, onError: failed, ...(m.wasm ? { runtime: { prefer: "wasm" as const } } : {}) });
      backend = recognizers;
      speakerModel = m.models.speaker;
      gate.setOwner(decodePrint(m.voiceprint));
      const made = new VoiceEngine(backend, e => gate.event(e, e.type === "utterance" ? made.requestAudio : e.type === "wake" ? made.wakeAudio : null));
      engine = made;
      if (m.monitor) speakers.start();
      send({ type: "ready", loadMs: Date.now() - t0, backend: recognizers.info });
    } catch (err) {
      // What WebAssembly throws while loading a model is a bare number: the models are damaged (review #254).
      if (err instanceof ModelLoadError) {
        const model = damagedModel(err.message);
        send({ type: "error", message: err.message, models: true, ...(model ? { model } : {}) });
      }
      else if (err instanceof Error) send({ type: "error", message: err.message });
      else send({ type: "error", message: "The speech models couldn't be loaded.", models: true });
    }
    const watchdog = new FrameWatchdog(ms => send({ type: "stalled", ms }));
    const silence = new SilenceWatch(on => send({ type: "silent", on }));
    setInterval(() => { watchdog.check(); send({ type: "alive" }); }, 1000);
    const port = e.ports[0];
    port.on("message", ev => {
      watchdog.frame();
      const d = ev.data as ArrayBuffer | ArrayBufferView;
      const frame = ArrayBuffer.isView(d) ? new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Float32Array(d);
      dump?.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      silence.frame(frame);
      const t0 = performance.now();
      if (!broken) try { if (enrolment) enrolFrame(frame); else engine?.feed(frame); } catch (err) { failed(err); }
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
  } else if (m.type === "voiceprint") {
    gate.setOwner(decodePrint(m.print));
  } else if (m.type === "enrol") {
    if (enrolment || !backend) return;
    engine?.cancel();
    backend.resetVad();
    const made: Enrolment = new Enrolment(voiceprinter(), st => {
      if (st.state === "done") send({ type: "enrol", state: "done", got: st.got, of: st.of, print: encodePrint(st.print) });
      else send({ type: "enrol", state: st.state, got: st.got, of: st.of, ...("why" in st ? { why: st.why } : {}) });
      if ((st.state === "done" || st.state === "cancelled") && enrolment === made) endEnrolment();
    });
    enrolment = made;
  } else if (m.type === "enrol-cancel") {
    enrolment?.cancel();
    endEnrolment();
  }
});

process.on("exit", () => { speakers.stop(); printer?.stop(); });
