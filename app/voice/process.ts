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
import { Enrolment, VoiceGate, voicedSeconds, type EnrolState, type Printer } from "./match";
import { decodePrint, encodePrint } from "./voiceprint";
import { adaptedThreshold } from "./adapt";
import { oneVoice, sampleOffered } from "./adapt-sample";
import type { VoiceprintWorkerMessage } from "./voiceprint-worker";
import { ModelLoadError, sherpaBackend, type BackendInfo, type ModelPaths } from "./sherpa";
import { SpeakerMonitor } from "./speakers";
import { FrameWatchdog, SilenceWatch } from "./watchdog";
import type { MicFrame } from "../shared/voice";

type FromMain =
  /** `dev`: an unpackaged (development) build. */
  /** `voiceprint`: the owner's (Voice Match on), base64 (voiceprint.ts). */
  /** `wasm`: run on WebAssembly (a voice process before this one died loading natively; runtime.ts). */
  /** `anchor`, `clips`: what Voice Match learnt since enrolment (adapt.ts): the enrolment's print, and how many samples. */
  /** `conversation`: a wake's request opens a conversation (engine.ts CONVERSATION_IDLE_MS). */
  | { type: "init"; generation: number; models: ModelPaths; monitor: boolean; dev: boolean; manualOnly?: boolean; voiceprint?: string | null; anchor?: string; clips?: number; wasm?: boolean; capiDir?: string; conversation?: boolean }
  /** Voice Match turned on (the owner's voiceprint) or off (null); `anchor` and `clips` as init's. */
  | { type: "voiceprint"; generation: number; refresh?: boolean; print: string | null; anchor?: string; clips?: number }
  /** Voice Match keeps learning (adapt.ts): the owner's well-matched requests are offered to main as samples, or not. */
  | { type: "learning"; on: boolean }
  /** Enrolment: listen for the owner's phrases (nothing heard meanwhile is a request), or stop doing so. */
  | { type: "enrol"; generation: number }
  /** `why`: the kill switch stopped it (EnrolEnd), not the user's Cancel. */
  | { type: "enrol-cancel"; why?: "stopped" }
  | { type: "self-speaking"; on: boolean }
  /** Words Ember is about to say, to tell them from the user's over its voice (engine.ts spokenByEmber). */
  | { type: "self-words"; text: string }
  /** Conversations turned on or off (settings' voice.conversation). */
  | { type: "conversation"; on: boolean }
  /** The computer is playing other sound (a song's words aren't requests), or no longer. */
  | { type: "other-sound"; on: boolean }
  /** A reply or a task is under way (a conversation stays open), or none any more. */
  | { type: "conversation-busy"; on: boolean }
  /** One of Ember's questions is up (or no longer): a "no" in a follow-up window then answers it. */
  | { type: "question"; up: boolean }
  /** `afterQuestion`: Ember's answer asked something ("Okay." is then a reply, not a closer). */
  | { type: "follow-up"; ms: number; afterQuestion?: boolean }
  | { type: "listen-once"; generation: number; from: number; ms: number }
  | { type: "cancel"; generation: number };

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
  | (VoiceEvent & { generation: number })
  /** `backend`: which build of sherpa-onnx runs the recognizers, and how (runtime.ts). */
  | { type: "ready"; loadMs: number; backend: BackendInfo }
  | { type: "error"; message: string; models?: boolean; model?: "kws" | "vad" | "asr" }
  | { type: "engine-error"; message: string; count: number }
  | { type: "engine-broken"; message: string }
  | { type: "stats"; cpuMs: number; audioMs: number; peak: number }
  | { type: "monitor"; on: boolean; reason?: string }
  | { type: "stalled"; ms: number }
  | { type: "alive" }
  /** `manual`: a Listen once window heard only digital silence (exact zeros) until it timed out (sent just before that). */
  | { type: "silent"; on: boolean; manual?: boolean }
  /** Enrolment's progress; at "done", `print` is the owner's voiceprint (base64) for main to keep. */
  | { type: "enrol"; state: Exclude<EnrolState["state"], "done">; got: number; of: number; why?: string }
  | { type: "enrol"; state: "done"; got: number; of: number; print: string }
  /** Voice Match couldn't check a request (it was heard anyway). */
  | { type: "voice-match-error"; message: string }
  /**
   * A verified request that matched the owner by ADAPT.margin or more, sent after it: its voiceprint (base64, numbers
   * only), its score, whether it was one voice throughout (adapt-sample.ts), how many seconds of voice follow its wake
   * phrase (`voiced`) and which utterance it belongs to (`utterance`: the nth this process sent, so main pairs it with
   * that request and no other). Main decides whether it is learnt.
   */
  | { type: "voice-sample"; generation: number; print: string; score: number; oneVoice: boolean; voiced: number; utterance: number };

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
/** The utterances sent to main so far (a voice-sample says which one it belongs to). */
let utterances = 0;
/** Main owns this revision so messages already queued on IPC can be revoked immediately. */
let generation = 0;
const gate = new VoiceGate(voiceprinter, e => { if (e.type === "utterance") utterances++; send({ ...e, generation }); }, err => send({ type: "voice-match-error", message: err instanceof Error ? err.message : String(err) }));
/** What Voice Match learnt, as main sends it: the enrolment to check too, and the learnt print's threshold (adapt.ts). */
function learntOf(m: { anchor?: string; clips?: number }): { anchor: Float32Array; threshold: number } | null {
  const anchor = decodePrint(m.anchor);
  return anchor && m.clips ? { anchor, threshold: adaptedThreshold(m.clips) } : null;
}
/**
 * Voice Match keeps learning (main says so): a verified request that matched well goes to main as a sample (adapt-sample.ts
 * sampleOffered), at most one in ADAPT.minGapMs (the halves are printed only for those).
 */
let learning = false, sampledAt = Number.NEGATIVE_INFINITY;
gate.onSample = (print, score, rest) => {
  const owner = gate.ownerPrint;
  const now = Date.now();
  if (!owner || !sampleOffered({ learning, hasOwner: true, score, rest, now, sampledAt })) return;
  sampledAt = now;
  // The utterance just sent (the gate sends it before it offers its sample).
  const utterance = utterances;
  const sampleGeneration = generation, gateGeneration = gate.generation;
  const voiced = Math.floor(voicedSeconds(rest) * 10) / 10;
  void oneVoice(voiceprinter(), rest, p => gate.matches(p, owner)).then(
    whole => { if (sampleGeneration === generation && gateGeneration === gate.generation) send({ type: "voice-sample", generation, print: encodePrint(print), score: Math.round(score * 1000) / 1000, oneVoice: whole, voiced, utterance }); },
    () => undefined, // the model failed: nothing to learn from this one (the gate reported failures already)
  );
};
/**
 * Enrolment under way: the microphone's speech goes to it (through the VAD) instead of the engine's requests. The engine
 * still hears "Ember, stop" meanwhile (VoiceEngine.stopsOnly), which ends the teaching too (voice-listening-v1).
 */
let enrolment: Enrolment | null = null;
function enrolFrame(frame: Float32Array, capturedAt?: number): void {
  if (!backend || !enrolment) return;
  engine?.feed(frame, capturedAt);
  if (!enrolment) return; // "Ember, stop" in this frame ended it
  for (const seg of backend.vad(frame)) void enrolment.heard(seg);
}
function endEnrolment(): void {
  enrolment = null;
  backend?.resetVad();
  engine?.stopsOnly(false);
}
/**
 * A Listen once window under way: how many frames it was given, and whether each was exact zeros (a muted microphone, or
 * the wrong input). The minute-long SilenceWatch can't say so in an 8 s window (voice-listening-4).
 */
let manualWindow: { frames: number; zeros: boolean } | null = null;
/** At least this many frames (2 s) of zeros before a window says the microphone sent only silence. */
const MANUAL_SILENT_FRAMES = 62;
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
    generation = m.generation;
    if (m.dev && process.env.EMBER_VOICE_DUMP) dump = fs.createWriteStream(process.env.EMBER_VOICE_DUMP);
    try {
      const t0 = Date.now();
      const recognizers = sherpaBackend(m.models, { monitor: m.monitor, onError: failed, ...(m.wasm ? { runtime: { prefer: "wasm" as const } } : m.capiDir ? { runtime: { capiDir: m.capiDir } } : {}) });
      backend = recognizers;
      speakerModel = m.models.speaker;
      gate.setOwner(decodePrint(m.voiceprint), learntOf(m));
      const made = new VoiceEngine(backend, e => {
        // Teaching Voice Match: its phrases aren't requests; "Ember, stop" stops everything, the teaching with it.
        if (enrolment) { if (e.type !== "stop") return; enrolment.cancel("stopped"); }
        if (e.type === "listening" && !e.on && e.window === "manual") {
          if (e.reason === "timeout" && manualWindow?.zeros && manualWindow.frames >= MANUAL_SILENT_FRAMES) send({ type: "silent", on: true, manual: true });
          manualWindow = null;
        }
        gate.event(e, e.type === "utterance" ? made.requestAudio : null, e.type === "utterance" && made.requestWithWake);
      }, { conversation: !!m.conversation });
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
      if (m.manualOnly && !engine?.listening) return;
      const data = ev.data as ArrayBuffer | ArrayBufferView | MicFrame;
      // The native backend smoke probe also supplies unlabelled frames, for wake recognition only.
      const packet = "samples" in data ? data : null;
      const d = packet ? packet.samples : data as ArrayBuffer | ArrayBufferView;
      const frame = ArrayBuffer.isView(d) ? new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Float32Array(d);
      dump?.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      silence.frame(frame);
      if (manualWindow) {
        manualWindow.frames++;
        if (manualWindow.zeros) for (let i = 0; i < frame.length; i++) if (frame[i] !== 0) { manualWindow.zeros = false; break; }
      }
      const t0 = performance.now();
      if (!broken) try { if (enrolment) enrolFrame(frame, packet?.capturedAt); else engine?.feed(frame, packet?.capturedAt); } catch (err) { failed(err); }
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
  } else if (m.type === "self-words") {
    engine?.selfWords(m.text);
  } else if (m.type === "conversation") {
    engine?.conversation(m.on);
  } else if (m.type === "other-sound") {
    engine?.otherSound(m.on);
  } else if (m.type === "conversation-busy") {
    engine?.conversationBusy(m.on);
  } else if (m.type === "question") {
    engine?.questionUp(m.up);
  } else if (m.type === "follow-up") {
    engine?.followUp(m.ms, { afterQuestion: m.afterQuestion });
  } else if (m.type === "listen-once") {
    if (enrolment || broken || !engine) return;
    gate.cancel();
    engine.cancel();
    generation = m.generation;
    manualWindow = { frames: 0, zeros: true };
    engine.listenOnce(m.from, m.ms);
  } else if (m.type === "cancel") {
    generation = m.generation;
    gate.cancel();
    engine?.cancel();
  } else if (m.type === "voiceprint") {
    generation = m.generation;
    gate.setOwner(decodePrint(m.print), learntOf(m), m.refresh);
    if (!m.refresh) engine?.cancel();
  } else if (m.type === "learning") {
    learning = m.on;
  } else if (m.type === "enrol") {
    generation = m.generation;
    if (enrolment || !backend) return;
    gate.cancel();
    engine?.cancel();
    engine?.stopsOnly(true);
    backend.resetVad();
    const made: Enrolment = new Enrolment(voiceprinter(), st => {
      if (st.state === "done") send({ type: "enrol", state: "done", got: st.got, of: st.of, print: encodePrint(st.print) });
      else send({ type: "enrol", state: st.state, got: st.got, of: st.of, ...("why" in st ? { why: st.why } : {}) });
      if ((st.state === "done" || st.state === "cancelled") && enrolment === made) endEnrolment();
    });
    enrolment = made;
  } else if (m.type === "enrol-cancel") {
    enrolment?.cancel(m.why === "stopped" ? "stopped" : undefined);
    endEnrolment();
  }
});

process.on("exit", () => { speakers.stop(); printer?.stop(); });
