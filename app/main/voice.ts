/**
 * VoiceService: the microphone window, the voice process and the models.
 * The mic is opened only when the user turned listening on, agreed to it,
 * the models are verified and Ember isn't muted; muting closes the stream,
 * which releases the microphone (GNOME's mic indicator goes away).
 * Replies are spoken from the mic window, or, while listening is off, from a
 * hidden window that never opens the mic: in Ember's own neural voice once its
 * model is in (made in the speech process, sentence by sentence, and played by
 * that window as it comes), otherwise in the system's voice. The voice process
 * is told while Ember speaks and doesn't take what it hears then as a request.
 */

import { app, BrowserWindow, MessageChannelMain, desktopCapturer, ipcMain, net, session, utilityProcess, webContents, type UtilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CLEAR_SPEECH, SUPERTONIC_VOICE, ensureModel, ensureModels, forgetModels, LISTENING_MODELS, modelPaths, modelReady, modelsBytes, NATURAL_VOICE, VOICE_MODELS, VOICE_MODELS_BYTES, type Downloader, type ModelFile, type ModelId, type ModelsProgress } from "../voice/models";
import type { ModelPaths } from "../voice/sherpa";
import { MANUAL_MAX_MS, type VoiceEvent } from "../voice/engine";
import type { VoiceProcessMessage } from "../voice/process";
import type { TtsProcessMessage, VoiceInfo } from "../voice/tts-process";
import { nativePackage } from "../voice/runtime";
import { speechChunks, type NaturalVoiceModel } from "../voice/tts";
import { FrameWatchdog } from "../voice/watchdog";
import { speechLanguage, withoutOwnPhrases } from "../voice/spoken";
import { readLevel, type SoundLevel } from "../shared/level";
import { VOICE, type MicState, type MicStatus, type SpeakRequest, type SpeechAudio, type SpeechPlayed } from "../shared/voice";
import type { ClearHearingStatus, ListenOnceStatus, NaturalVoiceStatus } from "../shared/ipc";
import type { Logger } from "./logger";
import { pageUrl } from "./page-url";

const appDir = __dirname;
/** A download that sends nothing for this long has stalled (ms). */
const STALL_MS = 30_000;
/** From speak() until speech starts; if it never does (no voices), a follow-up stops waiting for it (ms). */
const SPEECH_START_MS = 3000;
/** The same while Ember's own voice is still loading (its first reply: 1–2.5 s to load, then its first sentence; ms). */
const VOICE_START_MS = 8000;
/**
 * How long Hear Ember waits for its sample to be heard before saying no voice spoke it: Ember's voice loading, or the
 * system voice's own 8 s check of an utterance that never starts (mic/main.ts), with a little to spare (ms).
 */
const SAMPLE_WAIT_MS = 12_000;
/** One synthesis failure retires this engine, keeping recovery and subsequent streamed sentences in order. */
const VOICE_FAILURES = 1;
/**
 * Kitten too slow at a busy moment, or stopped after it had spoken, is timed again by itself once a session, at the
 * first request this long after (ms): the system voice no longer stays for the whole session (voice-speaking-6).
 */
const KITTEN_RECHECK_MS = 5 * 60_000;
/** Longest Ember counts as speaking without hearing so again (the mic window repeats it while it speaks; ms). */
const SPEAKING_MAX_MS = 60_000;
/**
 * The speech-only window closes once it has said nothing for this long (ms): with listening off it was kept for good
 * after the first reply, a renderer of about 30 MB private bytes on Windows. Loading it again for the next reply takes
 * a few hundred ms, under Ember's voice starting up (VOICE_START_MS).
 */
const SPEAKER_IDLE_MS = 60_000;
/** Retain the synthesiser through a conversation, then release its model and runtime until Ember is called again. */
const VOICE_IDLE_MS = 120_000;
/** Listening that broke starts again after 1 s, 5 s, then every 30 s (ms). */
const RESTART_MS = [1000, 5000, 30_000];
/**
 * A ready voice process that says nothing for this long is stuck or suspended (it says it's alive every second; its
 * longest piece of work, 21 s of speech to transcribe, took 1.4 s as measured; ms).
 */
const ALIVE_MS = 15_000;
/** Listen once: how long speech may take to start (ms); a request under way then is heard to its end (MANUAL_MAX_MS). */
const LISTEN_ONCE_MS = 8000;
const LISTEN_ONCE_CHECK_MS = 3000;
/**
 * What the voice line says while Listen once is open, or a follow-up's or a conversation's window: "Hearing you…" was
 * up from its first frame, though nobody had spoken, and then turned into "No request heard." (voice-listening-c2-2,
 * voice-listening-r3-2). It stays as the user starts: a screen reader announcing a change then would say it over their
 * words (voice-listening-c2-1).
 */
const LISTEN_ONCE_LISTENING = "Listening…";
/**
 * Settings' voice line while Ember listens for its name (Home's VOICE_TEXT.waiting), with " through <microphone>" after
 * it while the microphone has a name (copy.ts heardThrough).
 */
const WAITING_TEXT = "Listening for “Ember”";
/**
 * What Ember's windows announce as Listen once opens, which a screen reader says through the speakers, outside the echo
 * canceller, as the microphone opens: its status line in Home and Ask (listenOnceStatus, and the button's own
 * "Checking the microphone…" as it is pressed), the button's new name (renderer/shared/listen-once.ts) and Settings'
 * voice line (and, said a moment before, what it said while Ember listened for its name: armListenOnce adds the
 * microphone's name). The voice process takes them off the start of what it
 * hears (engine.ts withoutAnnounced): they were sent as the request, or before it (voice-listening-c2-1, voice-listening-r3-1).
 */
export const LISTEN_ONCE_ANNOUNCED = ["Checking the microphone…", "Starting to listen…", "Listening for one request…", "Cancel listening", "Starting…", LISTEN_ONCE_LISTENING, WAITING_TEXT];
/**
 * Listen once ended on talk it couldn't tell from the room's: begun as it opened and still going 12 s after the press
 * (engine.ts MANUAL_DOUBT_MS). It may have been the user's long request, so "No request heard." was untrue; begun a
 * moment after the window opens, a request is heard to its end (voice-listening-r2-1).
 */
const LISTEN_ONCE_DOUBT = "I heard talking but couldn't tell it was a request. Wait a moment after pressing Listen once, then speak.";
/**
 * The same in Settings, where Ember isn't "I" (voice-listening-v4-3). Without the name: a screen reader says it as the
 * window ends, into the wake word's microphone, and the check hears from a spotted name on, so "…but Ember couldn't
 * tell it was a request…" woke Ember and was sent as a request (6 of 40 real-model placements, voice-listening-r4-3).
 */
const LISTEN_ONCE_DOUBT_SETTINGS = "There was talking, but it wasn't clear it was a request. Wait a moment after pressing Listen once, then speak.";
/**
 * Listen once's line while Ember talks: a press hushes it first, as "Hey Ember" does (voice-listening-7). Main's
 * `LISTEN_ONCE_STOPS_ANSWER` takes its place while an answer is on its way. Without the name: Home's status line says
 * it after each Listen once as the short spoken answer plays, into the idle wake microphone, and "Stops Ember talking,
 * …" woke Ember and was sent as a request in 23 of 40 real-model placements (voice-listening-x6-1). Worded for any
 * speech: Hear Ember's sample is no answer, and "Stops the spoken answer, …" said so for its whole length (y6-2).
 */
export const LISTEN_ONCE_HUSH = "Stops speaking first, then listens for one request.";
/**
 * How long a question's answer window listens for a bare "allow" or "not now" once Ember has said the question (ms):
 * as long as a follow-up window. Short, as the room's talk could otherwise answer: what is said later needs the name.
 */
export const ANSWER_WINDOW_MS = 8000;
/**
 * Listen once's line while an answer is on its way: a press stops it first, as a wake does (main's requestListenOnce).
 * No name at all, not even "Ember's", which `calledByName` leaves out: the recogniser joins the word before it to the
 * name, and "Stops Ember's answer, …", said after each Listen once until the answer came, was heard as "Stop Timbers'
 * answer, …" and woke Ember in 20 of 40 real-model placements (voice-listening-y6-1).
 */
export const LISTEN_ONCE_STOPS_ANSWER = "Stops the answer on its way, then listens for one request.";
/** What the voice line says while the screen is locked (review #81). */
const LOCKED_TEXT = "Not listening while the screen is locked.";
/**
 * What the voice line says while Voice Match is taught: its phrases aren't requests, so "Hey Ember" isn't heard then,
 * only "Ember, stop" (voice-listening-v1).
 */
export const ENROL_TEXT = "Learning your voice. Until that's done, Ember hears only “Ember, stop”.";
/** What the voice line says while the microphone sends only digital silence (review #255). */
const SILENT_TEXT = "The microphone is sending only silence. Check that the right microphone is chosen, and not muted, in the sound settings.";

export interface VoiceOptions {
  log: Logger;
  /** The speech models' folder. */
  modelsRoot: string;
  /**
   * `modelsRoot` came with Ember (inside the app, or installed beside it), so Ember never changes it: a model it lacks
   * (Ember's voice, Voice Match: listening needs only LISTENING_MODELS) or whose copy there turns out damaged is taken
   * from the user's own models folder (`userRoot`) instead, and downloaded there (review #254).
   */
  bundled?: { userRoot: string };
  /** Speaker-output rejection (needs parec). */
  monitor: boolean;
  /**
   * Where the user allows Ember the microphone when the system refused it (Windows Settings, macOS System Settings),
   * added to that refusal's text. Absent on Linux, where nothing asks first.
   */
  micHint?: string;
  /** `heard.utterance`: which utterance of this voice process it is (a voice-sample's `utterance` is the same number). */
  onEvent: (e: VoiceEvent, heard?: { utterance: number }) => void;
  onState: (s: MicState, detail?: string) => void;
  onListenOnce?: () => void;
  /** A reply was heard (true), or no voice spoke (false): the speaking page tells it when that changes (review #101). */
  onSpeech?: (ok: boolean) => void;
  /** Ember started (true) or stopped (false) making sound, as the page that speaks tells it (turn-latency.ts). */
  onSelfSpeaking?: (on: boolean) => void;
  /**
   * The sound's level for Ember's presence (app/shared/level.ts): the microphone's only while Ember hears a request,
   * its own voice's while that plays; null when that stream ended. A level in eight steps, never audio.
   */
  onLevel?: (l: SoundLevel) => void;
  /** Speak in Ember's own neural voice once its model is in (app/voice/tts.ts); otherwise always the system's voice. */
  neuralVoice?: boolean;
  /**
   * Explicit optional Kokoro override. Kitten is always the baseline neural voice; false never disables it.
   */
  naturalVoice?: boolean;
  /** Legacy preference compatibility: only true + Kokoro requests the optional voice; Kitten uses the baseline. */
  naturalModel?: NaturalVoiceModel;
  /** The speaking speed setting (settings' `voice.rate`): 1 as made. */
  rate?: number;
  /** The optional Kokoro capability on this platform; false preserves its saved choice without loading/fetching it. */
  naturalSupported?: boolean;
  /** What became of the natural voice changed (naturalStatus): Home shows it under its switch. */
  onNatural?: (s: NaturalVoiceStatus) => void;
  /**
   * A folder with sherpa-onnx's C API libraries (app/voice/capi.ts). ASR may fall back to WebAssembly; neural speech
   * uses the local system voice when native synthesis fails.
   */
  capiDir?: string;
  /**
   * How the mic page plays Ember's voice: "context", Web Audio straight to the speakers (the default), or "element",
   * Web Audio into a media stream played by an <audio> element. Chromium's echo cancellation is documented to cover
   * media elements and not Web Audio, which matters before barge-in without the wake word (docs/ASSISTANT.md 2.3);
   * scripts/voice/echo-check.mjs measures both on a real computer. Development builds only, for now (EMBER_TTS_OUTPUT).
   */
  playback?: "context" | "element";
  /** A wake's request opens a conversation (settings' voice.conversation; engine.ts CONVERSATION_IDLE_MS). */
  conversation?: () => boolean;
  /** A screen reader runs (Platform a11y.screenReaderOn): it says Listen once's status lines through the speakers. */
  screenReaderOn?: () => boolean;
  /** The mic page can read how loud the computer's output is (PlatformVoice.outputLevel). */
  outputLevel?: boolean;
  /** Synthetic WAV input has no acoustic echo. Chromium's processing can distort it (development builds only). */
  testMicWav?: boolean;
  /**
   * Speech can run on sherpa-onnx's native addon here (default: Windows and macOS, runtime.ts). A voice or speech
   * process that dies before it is ready is then started again on WebAssembly: a damaged model aborts the addon's
   * onnxruntime, which nothing in the process can catch.
   */
  native?: boolean;
  /** Downloads the natural voice (default: Chromium's network stack, electronDownloader; tests pass their own). */
  downloader?: Downloader;
  /** Voice Match: the owner's voiceprint (base64, app/voice/voiceprint.ts) while it is on, else null. */
  voiceprint?: () => string | null;
  /**
   * What Voice Match learnt since enrolment (app/voice/adapt.ts): the enrolment's print (base64) and how many samples,
   * sent with the voiceprint; null: nothing learnt.
   */
  matchLearnt?: () => { anchor: string; clips: number } | null;
  /** Voice Match keeps learning (Settings › Voice › Keep learning my voice, with Voice Match on): read at each start. */
  learning?: () => boolean;
  /** A request Voice Match may learn from (app/voice/adapt.ts): main applies its guards and keeps what it learns. */
  onSample?: (s: Extract<VoiceProcessMessage, { type: "voice-sample" }>) => void;
  /** Enrolment's progress (Voice Match); at "done", `print` is the voiceprint to keep. */
  onEnrol?: (e: EnrolProgress) => void;
  /** Which models are in changed (a download finished, one turned out damaged): settings shows it. */
  onModels?: () => void;
}

/** What settings shows of enrolment: phrases kept so far, and whether the last must be said again (and why). */
export type EnrolProgress = Extract<VoiceProcessMessage, { type: "enrol" }>;

/** Downloads with Chromium's network stack (system proxy settings apply). A stalled connection fails, so "Downloading…" can't stay up forever. */
export const electronDownloader: Downloader = async (url, dest, progress, signal) => {
  // Already cancelled: nothing is fetched (an abort listener added now would never fire).
  if (signal?.aborted) throw new Error("cancelled");
  const ac = new AbortController();
  // Cancelled by the caller (Better recall's download when memory turns off): ends the transfer at once.
  const cancel = () => ac.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), STALL_MS); };
  alive();
  try {
    const res = await net.fetch(url, { signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    let bytes = 0;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    body.on("data", (c: Buffer) => { bytes += c.length; alive(); progress(bytes); });
    await pipeline(body, fs.createWriteStream(dest), { signal: ac.signal });
  } catch (err) {
    if (signal?.aborted) throw new Error("cancelled", { cause: err });
    throw ac.signal.aborted ? new Error(`nothing arrived for ${STALL_MS / 1000} seconds (check the network or proxy)`) : err;
  } finally {
    signal?.removeEventListener("abort", cancel);
    clearTimeout(timer);
  }
};

/** A hidden window that only speaks (its page, the sender to recognize it by, and whether it's speaking). */
type Speaker = { win: BrowserWindow; wc: Electron.WebContents; loaded: Promise<void>; saying: boolean };
/** Sends to the page that speaks a reply (the same one for all of it, should listening start or stop meanwhile). */
type PageSend = (channel: string, payload: unknown) => void;

export class VoiceService {
  private proc: UtilityProcess | null = null;
  /** The utterances the voice process has sent since it started (0 at each start: its own count starts again too). */
  private utterances = 0;
  private mic: BrowserWindow | null = null;
  /** Speaks replies while listening is off (loaded on first use; it never opens the microphone). */
  private speaker: Speaker | null = null;
  /** Closes the speech-only window once it has been quiet for SPEAKER_IDLE_MS. */
  private speakerIdle: NodeJS.Timeout | null = null;
  private state: MicState = "off";
  private muted = false;
  private wanted = false;
  /** The screen is locked: no listening and no speech until it's unlocked. */
  private locked = false;
  /** The natural voice was turned on while the screen was locked: it is decided once it is unlocked. */
  private naturalOnUnlock = false;
  private downloading: Promise<void> | null = null;
  /** Cancels the speech models' download (Cancel beside its progress, or listening turned off: voice-listening-6). */
  private downloadAbort: AbortController | null = null;
  /** Until when Ember is speaking, or about to: a follow-up window waits until it's done. */
  private speakingUntil = 0;
  private speechGeneration = 0;
  private hushMeasure: { owner: Electron.WebContents; page: "mic" | "speaker"; at: number } | null = null;
  private awaitingSpeechStart = false;
  private readonly pageGenerations = new WeakMap<Electron.WebContents, number>();
  /** A follow-up window (ms) waiting for Ember to finish speaking, its timer, and whether the answer asked something. */
  private followUpMs = 0;
  private followUpAsked = false;
  private followUpTimer: NodeJS.Timeout | null = null;
  /** A question's answer window (ms) waiting, with the follow-up's timer, for Ember to finish speaking (answerWindow). */
  private answerMs = 0;
  private listeningGeneration = 0;
  private capturing = false;
  private captureGeneration = 0;
  private manual: { phase: "starting" | "listening" | "checking"; timer: NodeJS.Timeout; temporary: boolean; armed: boolean } | null = null;
  private manualGeneration = 0;
  private manualDetail = "";
  /** The Listen once window under way heard only digital silence (the voice process said so before it timed out). */
  private manualSilent = false;
  /** The microphone went away and the mic page is getting it back (its frames stop meanwhile). */
  private micLost = false;
  /** The microphone sends only digital silence (the voice line says so until sound comes back). */
  private micSilent = false;
  /** The capturing microphone's name as the system gives it (Settings shows it; voice-listening-v2), or "". */
  private micDevice = "";
  /** The voice process hears the speakers' own stream (speaker rejection runs: Linux with parec). */
  private monitorOn = false;
  /** Starting again after listening broke: the timer, how many times in a row, and when the current process got ready. */
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;
  private readyAt = 0;
  /** Whether the ready voice process still answers: what it last sent, checked every second (review #257). */
  private alive: { watch: FrameWatchdog; timer: NodeJS.Timeout } | null = null;
  /**
   * Where the models are looked for: the folder that came with Ember (`bundledRoot`, null without one), less those of
   * its models that turned out damaged (`notBundled`), then the user's own (`userRoot`), where downloads go.
   */
  private bundledRoot: string | null;
  private notBundled = new Set<ModelId>();
  private userRoot: string;
  /** Ember's own voice: its process (started on the first reply), whether it has loaded, and how often it failed. */
  private tts: { proc: UtilityProcess; ready: boolean } | null = null;
  private voiceIdle: NodeJS.Timeout | null = null;
  private ttsFailures = 0;
  /** Ember's own voice failed after it had loaded (a reply it couldn't make, or its process ended): Home says it stopped. */
  private ttsStopped = false;
  /** When Kitten may be timed again by itself (0: not), and whether it was this session (KITTEN_RECHECK_MS). */
  private kittenRecheckAt = 0;
  private kittenRechecked = false;
  /** How fast replies are said (voice-speaking-7): sent with each reply only when it isn't 1. */
  private rate = 1;
  /** Replies are numbered; those up to `ttsHushed` were hushed (their late audio is dropped). */
  private ttsId = 0;
  private ttsHushed = 0;
  /** Replies still being synthesised: original text, producer-reported ungenerated suffix, and their page. */
  private ttsPending = new Map<number, { text: string; remaining: string; send: PageSend }>();
  /**
   * Words for the system's voice (another language's) that follow pieces Ember's own voice is still making: sent once
   * those are done, so they are never said ahead of them (voice-speaking-r1). A hush drops them.
   */
  private afterVoice: { send: PageSend; request: SpeakRequest }[] = [];
  /** Hear Ember's sample waiting to be heard, in the speech generation it was said in (voice-speaking-r3). */
  private sampleWait: { generation: number; done: (heard: NaturalVoiceModel | "system" | "stopped" | null) => void } | null = null;
  /** Enrolment (Voice Match) is under way in the voice process, and how far it got (said if it is cut short). */
  private enrolling = false;
  private enrolGot = { got: 0, of: 0 };
  /** ASR may retry through WebAssembly. Neural synthesis is native-only and falls back to the local system voice. */
  private wasmOnly = { voice: false };
  /** Hear me more clearly: wanted, what became of it, its download, and whether the running voice process has it. */
  private clearWanted = false;
  private clear: ClearHearingStatus = { state: "off" };
  private clearFetch: Promise<void> | null = null;
  private clearAbort: AbortController | null = null;
  private clearLoaded = false;
  /**
   * The natural voice: being fetched, or not to be used this session (it was too slow here, or couldn't be fetched);
   * `switchVoice`: fetched, so the speech process starts again with it once it has nothing left to say.
   */
  private naturalFetch: Promise<void> | null = null;
  private naturalAbort: AbortController | null = null;
  private naturalEpoch = 0;
  private naturalRetiring = false;
  /** The explicit optional Kokoro override; Kitten needs no toggle or separate download. */
  private naturalWanted: boolean;
  private currentVoice: "kitten" | "kokoro" | "supertonic" | "system" = "system";
  /** Which optional voice is wanted while naturalWanted. */
  private optional: "kokoro" | "supertonic" = "kokoro";
  private naturalOff = false;
  private switchVoice = false;
  /** What became of the natural voice, as Home shows it while it is wanted (naturalStatus). */
  private natural: NaturalVoiceStatus = { state: "off" };
  private naturalPublished = "";
  /** How the speech process that is running now said it speaks (its "ready"), so turning the natural voice on decides at once. */
  private ttsInfo: VoiceInfo | null = null;
  /** How much of the natural voice's download has arrived (percent). */
  private naturalPercent = 0;
  /** Whether the log last said that Ember speaks (voice.self_speaking). */
  private saidSpeaking = false;
  /** The page that last said Ember speaks (VOICE.speaking), while it does: destroying it ends Ember's speech too. */
  private speakingPage: "mic" | "speaker" | null = null;

  constructor(private o: VoiceOptions) {
    this.naturalWanted = !!o.naturalVoice && o.naturalModel !== "kitten";
    if (o.naturalModel === "supertonic") this.optional = "supertonic";
    this.naturalOff = this.naturalWanted && o.naturalSupported === false;
    this.bundledRoot = o.bundled ? o.modelsRoot : null;
    this.userRoot = o.bundled?.userRoot ?? o.modelsRoot;
    this.setRate(o.rate ?? 1);
    // On at start: decided the next time Ember speaks (Ember's voice loads only then), unless it can't be at all.
    this.natural = this.naturalBlocked() ?? { state: "later" };
    ipcMain.on(VOICE.status, (e, s: MicStatus) => {
      if (!this.mic || e.sender !== this.mic.webContents) return;
      const capturing = s.state === "capturing" && s.context === "running";
      const paused = this.capturing && !capturing;
      this.capturing = capturing;
      if (this.manual?.temporary && (s.state === "error" || s.state === "lost" || paused)) {
        this.cancelListenOnce(s.state === "error" || s.state === "lost" ? micHelp(s.message, this.o.micHint) : "The microphone paused. Try again.");
        return;
      }
      if (paused) { this.captureGeneration++; this.cancelListenOnce(); }
      if (s.state === "error") { this.o.log.error("voice.mic_error", { message: s.message }); this.setState("error", micHelp(s.message, this.o.micHint)); this.teardown(); }
      else if (s.state === "lost") { this.o.log.warn("voice.mic_lost", { message: s.message }); this.micLost = true; this.interruptEnrol(); this.setState("error", `${micHelp(s.message, this.o.micHint)} Trying again…`); }
      else if (s.state === "capturing") {
        this.o.log.info("voice.mic", { device: s.device, rate: s.rate, context: s.context });
        this.micDevice = typeof s.device === "string" ? s.device.trim().slice(0, 80) : "";
        if (this.micLost) { this.micLost = false; this.setState("waiting"); }
        this.armListenOnce();
      }
      this.o.onListenOnce?.();
    });
    ipcMain.on(VOICE.speech, (e, ok: unknown) => {
      if (!(this.mic && e.sender === this.mic.webContents) && e.sender !== this.speaker?.wc) return;
      if (ok !== true) this.sampleWait?.done(null);
      this.o.onSpeech?.(ok === true);
    });
    ipcMain.on(VOICE.played, (e, p: SpeechPlayed) => {
      const page = this.mic && e.sender === this.mic.webContents ? "mic" : e.sender === this.speaker?.wc ? "speaker" : null;
      if (page) this.o.log.info("voice.audio_played", { id: Number(p?.id), seconds: Number(p?.seconds), page });
    });
    ipcMain.on(VOICE.level, (e, v: unknown) => {
      if (!(this.mic && e.sender === this.mic.webContents) && e.sender !== this.speaker?.wc) return;
      const l = readLevel(v);
      if (!l) return;
      // The microphone's level counts only while Ember hears a request (a late one after that is dropped).
      if (l.mic !== undefined && l.mic !== null && this.state !== "active") delete l.mic;
      if (Object.keys(l).length) this.o.onLevel?.(l);
    });
    ipcMain.on(VOICE.outputBusy, (e, on: unknown) => {
      if (!(this.mic && e.sender === this.mic.webContents) || typeof on !== "boolean") return;
      this.o.log.info("voice.other_sound", { on });
      this.proc?.postMessage({ type: "other-sound", on });
    });
    ipcMain.on(VOICE.speaking, (e, on: unknown, generation: unknown) => {
      if (!(this.mic && e.sender === this.mic.webContents) && e.sender !== this.speaker?.wc) return;
      if (typeof on !== "boolean" || generation !== this.speechGeneration) return;
      const measure = this.hushMeasure;
      if (!on && measure?.owner === e.sender) {
        this.hushMeasure = null;
        this.o.log.info("voice.hush_ack", { page: measure.page, ms: Math.round(performance.now() - measure.at) });
      }
      if (on && !this.saidSpeaking) this.awaitingSpeechStart = false;
      // Hear Ember's sample is heard now: in the voice speaking it (Kitten's, or the system's after it failed).
      if (on && this.sampleWait?.generation === generation) this.sampleWait.done(this.nextVoice);
      this.speakingPage = !on ? null : this.mic && e.sender === this.mic.webContents ? "mic" : "speaker";
      // (Repeated every 20 s while it lasts: the voice process is told each time, the log only when it changes.)
      if (!!on !== this.saidSpeaking) { this.saidSpeaking = !!on; this.o.log.info("voice.self_speaking", { on: !!on, listening: !!this.proc }); this.o.onSelfSpeaking?.(!!on); }
      if (on && !this.saidSpeakingBefore) this.lastSelfSpeech = Date.now();
      this.saidSpeakingBefore = !!on;
      this.proc?.postMessage({ type: "self-speaking", on: !!on });
      if (on) this.speakingUntil = Date.now() + SPEAKING_MAX_MS;
      else this.speakingUntil = this.awaitingSpeechStart ? Date.now() + SPEECH_START_MS : 0;
      if (this.speaker && e.sender === this.speaker.wc) {
        this.speaker.saying = !!on;
        // Listening started while it spoke: the mic window speaks from now on. Otherwise it goes once it stays quiet.
        if (!on && this.mic) this.closeSpeaker();
        else this.idleSpeaker();
      }
      this.openFollowUp();
      // Listen once pressed while Ember talked: it listens now that Ember has stopped.
      if (!on) this.armListenOnce();
      this.o.onListenOnce?.();
    });
  }

  get micState(): MicState {
    return this.state;
  }

  /** Which microphone Ember hears through, while it captures (null: none, or the system gave no name). */
  get micLabel(): string | null {
    return this.capturing && this.micDevice ? this.micDevice : null;
  }

  get listenOnceStatus(): ListenOnceStatus {
    if (this.manual) return {
      phase: this.manual.phase,
      detail: this.manual.phase === "starting" ? "Starting to listen…" : this.manual.phase === "listening" ? "Listening for one request…" : "Checking what was said…",
    };
    const blocked = (detail: string): ListenOnceStatus => ({ phase: "blocked", detail });
    if (this.locked) return blocked("The screen is locked.");
    if (this.muted) return blocked("Unmute the microphone first.");
    // (Not told screen readers: said as teaching began, into its microphone, it was taken for a phrase: voice-listening-r4-1.)
    if (this.enrolling) return { ...blocked("Finish teaching Ember your voice first."), reason: "listening" };
    if (!this.modelsReady) return this.downloading ? blocked("Speech models are downloading.") : { ...blocked("Download speech models in Settings first."), reason: "needs-models" };
    // Ember talking: Listen once hushes it first, as "Hey Ember" does (it was blocked, and the keyboard had no other way
    // to cut in but Stop response or Stop everything: voice-listening-7).
    const hushFirst = this.talking ? LISTEN_ONCE_HUSH : "";
    if (!this.wanted) return { phase: "ready", detail: hushFirst || this.manualDetail || "Opens the microphone for one request." };
    if (this.state === "error") return { ...blocked("Check the microphone and voice status in Settings."), reason: "voice-error" };
    if (!this.capturing || !this.readyAt || !this.proc) return blocked("The microphone or speech recogniser is getting ready.");
    // (Not a line screen readers are told: it changes as a wake's window opens, and a screen reader saying it then was
    // heard in the request, or as one in the conversation: voice-listening-c3-1.)
    if (this.state === "active") return { ...blocked("Ember is already listening."), reason: "listening" };
    return { phase: "ready", detail: hushFirst || this.manualDetail };
  }

  /** Ember is speaking, or about to (a reply on its way to the page, or speech asked for that hasn't started yet). */
  private get talking(): boolean {
    return this.saidSpeaking || this.ttsPending.size > 0 || this.speakingUntil > Date.now();
  }

  /** Ember is speaking, or about to: main stops it when speaking is turned off, and offers Stop speaking meanwhile. */
  get speaking(): boolean {
    return this.talking;
  }

  listenOnce(): boolean {
    if (this.listenOnceStatus.phase !== "ready") return false;
    this.dropFollowUp();
    this.manualGeneration++;
    this.manualSilent = false;
    const temporary = !this.wanted;
    // Ember stops talking first; the window opens once the page says it has (armListenOnce, and VOICE.speaking).
    const hush = this.talking;
    this.manual = { phase: "starting", temporary, armed: false, timer: setTimeout(() => this.cancelListenOnce("The microphone did not get ready. Try again."), 30_000) };
    this.manual.timer.unref();
    if (hush) this.hush();
    if (temporary) {
      const manual = this.manual;
      void this.start().catch(() => { if (this.manual === manual) this.cancelListenOnce("Couldn't start the microphone. Try again."); });
    }
    else this.armListenOnce();
    this.o.onListenOnce?.();
    return true;
  }

  private armListenOnce(): void {
    const manual = this.manual;
    if (!manual || manual.armed || !this.readyAt || !this.capturing || !this.proc || this.talking) return;
    manual.armed = true;
    clearTimeout(manual.timer);
    // The voice process ends the window itself, by MANUAL_MAX_MS at the latest: this catches one that never says so.
    manual.timer = setTimeout(() => this.cancelListenOnce("Listening timed out. Try again."), MANUAL_MAX_MS + LISTEN_ONCE_CHECK_MS);
    manual.timer.unref();
    const announced = this.micLabel ? [...LISTEN_ONCE_ANNOUNCED, `${WAITING_TEXT} through ${this.micLabel}`] : LISTEN_ONCE_ANNOUNCED;
    this.proc.postMessage({ type: "listen-once", generation: ++this.listeningGeneration, from: Date.now(), ms: LISTEN_ONCE_MS, ...(this.o.screenReaderOn?.() ? { announced } : {}) });
  }

  cancelListenOnce(detail = "Listening cancelled."): void {
    // Recognition can be done while the request still waits for its desktop context.
    if (this.manual) this.cancelListening(detail);
    else this.manualGeneration++;
  }

  /** A manual request may be waiting for its pre-focus context after Voice Match let it through. */
  listenOnceStillCurrent(): () => boolean {
    const manual = this.manualGeneration;
    const generation = this.listeningGeneration;
    const capture = this.captureGeneration;
    const temporary = this.manual?.temporary;
    return () => manual === this.manualGeneration && !this.muted && !this.locked &&
      (temporary || (generation === this.listeningGeneration && capture === this.captureGeneration && this.capturing && this.wanted));
  }

  private finishListenOnce(detail: string, accepted = false): void {
    const manual = this.manual;
    if (!manual) return;
    clearTimeout(manual.timer);
    this.manual = null;
    this.manualDetail = detail;
    if (manual.temporary) {
      if (this.proc) this.teardown(accepted);
      if (this.state !== "error") this.setState("off");
    }
    this.o.onListenOnce?.();
  }

  /**
   * Ember listens and can tell its own voice (and the speakers') from the user's: the speakers' stream is arriving, so
   * a wake or stop phrase it says itself is rejected. False while not listening, and wherever speaker rejection doesn't
   * run (Windows, macOS, Linux without parec): Ember then never says those phrases (owner decision V1, review #251), and
   * a call, a video or Ember's own voice can say a request, so words heard then never count as asking for a dangerous
   * command (review #252).
   */
  /** When Ember last started making sound (as the speaking page told it; 0: never this run), and whether it was then. */
  private lastSelfSpeech = 0;
  private saidSpeakingBefore = false;

  /**
   * Is Ember speaking now, or did it start to since `t` (ms since the epoch: when the user's request began, at its wake)?
   * A spoken answer to a question heard then may be Ember's own voice from the speakers ("…or say not now"), so it isn't
   * taken (the echo guard of review #112, on top of the voice process not taking requests while Ember speaks).
   */
  selfSpokeSince(t: number): boolean {
    return this.saidSpeaking || this.lastSelfSpeech >= t;
  }

  /** One of Ember's questions is up, or no longer: a "no" said in a follow-up window then answers it (engine.ts). */
  questionUp(up: boolean): void {
    this.proc?.postMessage({ type: "question", up });
  }

  get rejectsSpeakers(): boolean {
    return !!this.proc && this.monitorOn && (this.state === "waiting" || this.state === "active");
  }

  /** Listening can start: the wake word, voice activity and speech recognition models are in (LISTENING_MODELS). */
  get modelsReady(): boolean {
    return LISTENING_MODELS.every(id => this.rootOf(id) !== null);
  }

  /** The models that aren't in (or turned out damaged): what the download fetches. */
  get missingModels(): ModelFile[] {
    return VOICE_MODELS.filter(m => this.rootOf(m.id) === null);
  }

  /** Voice Match can run: its voiceprint model is in. Without it, a kept voiceprint isn't used (every voice is heard). */
  get matchReady(): boolean {
    return this.rootOf("speaker") !== null;
  }

  /** A download is under way (listening may be running meanwhile, when only Ember's voice or Voice Match is fetched). */
  get isDownloading(): boolean {
    return !!this.downloading;
  }

  /** Hear me more clearly, as it stands (Home shows it under its switch). */
  get clearStatus(): ClearHearingStatus {
    return this.clear;
  }

  private setClear(s: ClearHearingStatus): void {
    this.clear = s;
    this.o.onNatural?.(this.naturalStatus);
  }

  /** Hear me more clearly turned on or off: fetched first if it must be, and listening starts again with it or without. */
  setClearHearing(on: boolean): void {
    if (on === this.clearWanted) return;
    this.clearWanted = on;
    this.o.log.info("voice.clear_wanted", { on });
    if (on) { this.checkClear(); return; }
    this.clearAbort?.abort();
    this.clearAbort = null;
    this.setClear({ state: "off" });
    if (this.clearLoaded) this.listenAgain();
  }

  private checkClear(): void {
    if (!this.clearWanted || this.clearFetch) return;
    if (!this.native) { this.setClear({ state: "needs-native" }); return; }
    if (this.rootOf("clear") !== null) {
      if (this.clearLoaded) { this.setClear({ state: "on" }); return; }
      this.setClear({ state: "starting" });
      this.listenAgain();
      return;
    }
    const abort = new AbortController();
    this.clearAbort = abort;
    let failed = false;
    this.setClear({ state: "downloading", percent: 0 });
    let shown = 0;
    const progress = (bytes: number) => {
      const percent = Math.min(99, Math.floor((bytes / CLEAR_SPEECH.bytes) * 100));
      if (percent === shown || abort.signal.aborted) return;
      shown = percent;
      this.setClear({ state: "downloading", percent });
    };
    this.clearFetch = ensureModel(this.userRoot, CLEAR_SPEECH, this.o.downloader ?? electronDownloader, progress, abort.signal)
      .then(() => { this.o.log.info("voice.clear_ready", { bytes: CLEAR_SPEECH.bytes }); })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        this.o.log.warn("voice.clear_download_failed", { message });
        this.setClear({ state: "failed", detail: downloadHelp(message, CLEAR_SPEECH.bytes) });
        failed = true;
      })
      .finally(() => {
        this.clearFetch = null;
        // A failure waits for the user. A cancelled download may have been turned on again while it cleaned up: that
        // turn found this one still running, so what is wanted now is looked at here.
        if (!failed) this.checkClear();
      });
  }

  /** The voice process starts again, so that it loads the recognizers wanted now. */
  private listenAgain(): void {
    if (!this.proc) return;
    this.teardown();
    void this.start();
  }

  /** Which folder model `id` is used from: the one that came with Ember, else the user's own; null when in neither. */
  private rootOf(id: ModelId): string | null {
    if (this.bundledRoot && !this.notBundled.has(id) && modelReady(this.bundledRoot, id)) return this.bundledRoot;
    return modelReady(this.userRoot, id) ? this.userRoot : null;
  }

  /** Each model's path, from the folder it is used from (the user's own for one that isn't in anywhere). */
  private paths(): ModelPaths {
    const at = (id: Exclude<keyof ModelPaths, "clear" | "supertonic">) => modelPaths(this.rootOf(id) ?? this.userRoot)[id];
    const clearRoot = this.clearWanted && this.native ? this.rootOf("clear") : null;
    return { kws: at("kws"), vad: at("vad"), asr: at("asr"), tts: at("tts"), speaker: at("speaker"), natural: at("natural"),
      ...(clearRoot !== null ? { clear: path.join(clearRoot, CLEAR_SPEECH.target) } : {}) };
  }

  /** The owner's voiceprint for the voice process: none while its model isn't in (Voice Match is off then, not deaf). */
  private voiceprint(): string | null {
    return this.matchReady ? this.o.voiceprint?.() ?? null : null;
  }

  /** Lets the mic window (and only it) use the microphone, audio only. */
  allowsMedia(wc: Electron.WebContents, mediaTypes: string[] | undefined): boolean {
    return !!this.mic && !this.mic.isDestroyed() && wc === this.mic.webContents && (mediaTypes ?? ["audio"]).every(t => t === "audio");
  }

  /** Listening on or off (from settings and consent). */
  async setWanted(on: boolean): Promise<void> {
    if (this.manual?.temporary) this.cancelListenOnce();
    this.wanted = on;
    // Listening turned off: its download stops too, rather than run on unseen (voice-listening-6).
    if (!on) { this.cancelDownload(); this.cancelRetry(); this.teardown(); this.setState("off"); return; }
    await this.start();
  }

  setMuted(on: boolean): void {
    this.muted = on;
    if (on) { this.cancelRetry(); this.teardown(); this.setState("muted"); }
    else if (this.wanted) void this.start();
    else this.setState("off");
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Voice Match is being taught (the microphone hears its phrases and "Ember, stop" only). */
  get isEnrolling(): boolean {
    return this.enrolling;
  }

  /**
   * The screen locked, or this session isn't the one in front (review #81): no listening and no speech until it's back,
   * so nobody in the room talks to Ember (the wake word isn't the user's alone) or hears it read out the user's apps.
   */
  setLocked(on: boolean): void {
    if (on === this.locked) return;
    this.locked = on;
    if (!on) {
      void this.start();
      // The natural voice turned on while locked is decided now.
      if (this.naturalOnUnlock) { this.naturalOnUnlock = false; this.checkNatural(); }
      return;
    }
    this.hush();
    this.cancelRetry();
    this.teardown();
    // Nothing speaks while locked: not left "speaking" until a page that was hushed says so (or never does).
    this.speakingEnded();
    if (this.wanted && !this.muted) this.setState("off", LOCKED_TEXT);
  }

  /**
   * Downloads the models that aren't in (to the user's own folder): all of them on first use, or only what is missing
   * or was damaged (Ember's voice, Voice Match). Listening that already runs carries on meanwhile. Rejects if the
   * download fails; the state has then already gone back (with what went wrong as its detail).
   */
  async downloadModels(progress: ModelsProgress): Promise<void> {
    const missing = this.missingModels;
    if (!this.downloading && missing.length) {
      // Only what listening needs shows as "Downloading…": while just Ember's voice or Voice Match comes, listening (or
      // muting, or being off) carries on as it was, and settings shows the download's own progress (isDownloading).
      if (!this.modelsReady) this.setState("downloading");
      const ids = missing.map(m => m.id);
      const abort = new AbortController();
      this.downloadAbort = abort;
      this.downloading = ensureModels(this.userRoot, electronDownloader, progress, ids, abort.signal)
        .then(() => {
          this.o.log.info("voice.models_ready", { models: ids, bytes: modelsBytes(missing) });
          for (const id of ids) this.notBundled.delete(id); // (the user's own copy is used: it verified)
          if (ids.includes("tts")) this.ttsFailures = 0;
          // New models: the native build is tried again (one that died loading may have died on a damaged model).
          this.wasmOnly = { voice: false };
          this.setNatural(this.naturalBlocked() ?? { state: "later" });
        })
        .catch((err: unknown) => {
          // Never left on "Downloading…": back to what it was, saying why (the download button offers a retry).
          const message = err instanceof Error ? err.message : String(err);
          const cancelled = abort.signal.aborted;
          if (cancelled) this.o.log.info("voice.download_cancelled", { models: ids });
          else this.o.log.warn("voice.download_failed", { message });
          const detail = cancelled ? "Download cancelled." : `Couldn't download the speech models. ${downloadHelp(message, modelsBytes(missing))}`;
          // (Cancelled while listening ran on, fetching only Ember's voice or Voice Match: the voice line stays as it is.)
          if (!cancelled || this.state === "downloading" || this.state === "off") this.setState(this.state !== "downloading" ? this.state : !this.wanted ? "off" : this.muted ? "muted" : "needs-models", detail);
          throw cancelled ? new Error("cancelled", { cause: err }) : err;
        })
        .finally(() => { this.downloading = null; if (this.downloadAbort === abort) this.downloadAbort = null; this.o.onModels?.(); });
      this.o.onModels?.(); // (settings hides the button and shows the download's progress)
    }
    await this.downloading;
    // Voice Match's model came in while listening: a kept voiceprint is used from now on.
    if (this.proc) this.setVoiceprint(this.o.voiceprint?.() ?? null);
    if (this.wanted) await this.start();
    else if (this.state === "downloading") this.setState("off");
  }

  /** Stops the speech models' download under way, if any: downloadModels then rejects, and the state says "Download cancelled.". */
  cancelDownload(): void {
    this.downloadAbort?.abort();
  }

  /**
   * A follow-up window (no wake word needed). It opens once Ember has finished speaking its answer, or it would hear
   * itself. `afterQuestion`: the answer asked something, so "Okay." or "Fine." is a reply to send (not "that's all").
   */
  followUp(ms = 8000, o: { afterQuestion?: boolean } = {}): void {
    if (this.manual || !this.wanted) return;
    this.followUpMs = ms;
    this.followUpAsked = !!o.afterQuestion;
    this.openFollowUp();
  }

  /**
   * One of Ember's questions is up: listen for its answer without the name (engine.ts answerWindow), once Ember has
   * finished saying it (or a note about it), or at once where it says nothing. Never while it speaks, or it would hear
   * itself; a hush, a wake, Listen once or Stop drops it, as a follow-up is dropped (owner's report of 2026-11-12).
   */
  answerWindow(ms = ANSWER_WINDOW_MS): void {
    if (this.manual || !this.wanted) return;
    this.answerMs = ms;
    this.openFollowUp();
  }

  private openFollowUp(): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
    if ((!this.followUpMs && !this.answerMs) || this.ttsPending.size) return;
    const wait = this.speakingUntil - Date.now();
    if (wait > 0) { this.followUpTimer = setTimeout(() => this.openFollowUp(), wait); return; }
    if (this.followUpMs) {
      if (this.proc) this.o.log.info("voice.follow_up", { ms: this.followUpMs, afterQuestion: this.followUpAsked });
      this.proc?.postMessage({ type: "follow-up", ms: this.followUpMs, ...(this.followUpAsked ? { afterQuestion: true } : {}) });
      this.followUpMs = 0;
    }
    if (this.answerMs) {
      if (this.proc) this.o.log.info("voice.answer_window", { ms: this.answerMs });
      this.proc?.postMessage({ type: "answer-window", ms: this.answerMs });
      this.answerMs = 0;
    }
  }

  private dropFollowUp(): void {
    this.followUpMs = 0;
    this.answerMs = 0;
    this.openFollowUp();
  }

  /**
   * Voice Match: starts enrolment (the owner's phrases; nothing heard meanwhile is a request). False when Ember isn't
   * listening (enrolment needs the microphone) or its voiceprint model isn't there, and while the microphone isn't
   * working (lost, denied or silent: the voice line says which), as Listen once is held back then: Teach showed the
   * first phrase with no microphone, and 45 s later said no phrase was heard for a while (voice-listening-r7-1).
   */
  enrol(): boolean {
    if (this.enrolling) return true;
    if (!this.wanted || !this.proc || !this.readyAt || !this.matchReady || this.state === "error") return false;
    this.cancelListenOnce();
    this.enrolling = true;
    this.enrolGot = { got: 0, of: 0 };
    // (A screen reader reads each prompt aloud, into the teaching microphone: voice-listening-r4-1.)
    this.proc.postMessage({ type: "enrol", generation: ++this.listeningGeneration, ...(this.o.screenReaderOn?.() ? { reader: true } : {}) });
    // (A conversation or follow-up listening now ends at once in the voice process: voice-listening-r2.)
    if (this.state === "waiting" || this.state === "active") this.setState("waiting", ENROL_TEXT);
    this.o.onListenOnce?.();
    return true;
  }

  /** Teaching stops: the user's Cancel, or (`why`) the kill switch. */
  cancelEnrol(why?: "stopped"): void {
    if (!this.enrolling) return;
    this.enrolling = false;
    this.proc?.postMessage({ type: "enrol-cancel", ...(why ? { why } : {}) });
    this.enrolEnded();
    this.o.onListenOnce?.();
  }

  /**
   * The microphone went (lost, or only silence arrives) while a voice was taught: teaching ends as cut short, which
   * settings says, rather than 45 s later as no phrase heard for a while (voice-listening-r7-1).
   */
  private interruptEnrol(): void {
    if (!this.enrolling) return;
    this.enrolling = false;
    this.o.onEnrol?.({ type: "enrol", state: "cancelled", ...this.enrolGot, why: "interrupted" });
    this.proc?.postMessage({ type: "enrol-cancel" });
  }

  /** Teaching is over: the voice line says what it did before (listening for “Ember” again). */
  private enrolEnded(): void {
    if (this.state === "waiting") this.setState("waiting");
  }

  /**
   * Voice Match turned on (the owner's voiceprint) or off (null): the voice process checks requests from now on, or
   * doesn't. Without its model, it stays off. Only an adaptation sample uses `refresh`, preserving pending requests.
   */
  setVoiceprint(print: string | null, refresh = false): void {
    const p = this.matchReady ? print : null;
    if (!refresh) { this.cancelListenOnce(); this.listeningGeneration++; }
    this.proc?.postMessage({ type: "voiceprint", generation: this.listeningGeneration, refresh, print: p, ...(p ? this.o.matchLearnt?.() ?? {} : {}) });
  }

  /** Voice Match keeps learning (Settings › Voice), or stops: the voice process offers samples (onSample), or doesn't. */
  setLearning(on: boolean): void {
    this.proc?.postMessage({ type: "learning", on });
  }

  /** Speech was heard over Ember, so its voice drops while the words are checked; or it comes back. */
  duck(on: boolean): void {
    const win = this.speakingPage === "mic" ? this.mic : this.speakingPage === "speaker" ? this.speaker?.win : null;
    if (win && !win.isDestroyed()) win.webContents.send(VOICE.duck, on);
  }

  /** A conversation opened or closed: while it is open, the mic page watches whether other sound plays. */
  watchOutput(on: boolean): void {
    if (this.o.outputLevel && this.mic && !this.mic.isDestroyed()) this.mic.webContents.send(VOICE.outputWatch, on);
  }

  /** The page asking for the output's level is the mic page, in a build where it can. */
  allowsOutputLevel(wc: Electron.WebContents | null | undefined): boolean {
    return !!this.o.outputLevel && !!wc && !!this.mic && wc === this.mic.webContents;
  }

  /** Conversations turned on or off (the setting): off ends one under way. */
  setConversation(on: boolean): void {
    this.proc?.postMessage({ type: "conversation", on });
  }

  /** A reply or a task is under way, so a conversation stays open; or none any more, and its idle time starts. */
  conversationBusy(on: boolean): void {
    this.proc?.postMessage({ type: "conversation-busy", on });
  }

  /** Stops listening for a request at once (the kill switch): a wake being checked, a waiting follow-up and a request already on its way are dropped. */
  cancelListening(detail = "Listening cancelled."): void {
    this.manualGeneration++;
    this.listeningGeneration++;
    this.dropFollowUp();
    // Teaching Voice Match stops with everything else (voice-listening-v1).
    this.cancelEnrol("stopped");
    this.proc?.postMessage({ type: "cancel", generation: this.listeningGeneration });
    if (!this.manual) return;
    if (this.state === "active" && !this.manual.temporary) this.setState("waiting");
    this.finishListenOnce(detail);
  }

  /**
   * Says `text` (plain words: spokenText). `append`: after what Ember is saying (the next sentences of an answer that is
   * still streaming), instead of cutting it off. `lang`: the language of the answer this piece is part of, decided once
   * for all its pieces (main's AnswerLanguage; null: English); without it, `text` is judged on its own.
   */
  speak(text: string, o: { append?: boolean; lang?: string | null } = {}): void {
    if (this.locked || !text.trim()) return;
    if (this.manual) this.cancelListenOnce();
    // Listening without the speakers' stream, the microphone would take Ember's own "Ember, stop" for the user's.
    if (this.mic && !this.rejectsSpeakers) text = withoutOwnPhrases(text);
    // What is heard over Ember's voice is told from Ember's own words by these (engine.ts spokenByEmber).
    this.proc?.postMessage({ type: "self-words", text });
    // Kitten reads only English: a reply in another language goes to a local system voice for it, or isn't said.
    const lang = o.lang !== undefined ? o.lang : speechLanguage(text);
    const neural = this.neuralVoice && !lang;
    if (!o.append) this.hush();
    if (!o.append || !this.saidSpeaking) this.awaitingSpeechStart = true;
    this.speakingUntil = Math.max(this.speakingUntil, Date.now() + (neural && !this.tts?.ready ? VOICE_START_MS : SPEECH_START_MS));
    const send = this.pageSend();
    if (!neural) {
      const request: SpeakRequest = { text, ...(o.append ? { append: true } : {}), ...(lang ? { lang } : {}), ...this.rateField };
      if (o.append && (this.ttsPending.size || this.afterVoice.length)) this.afterVoice.push({ send, request });
      else send(VOICE.speak, request);
      return;
    }
    const id = ++this.ttsId;
    this.ttsPending.set(id, { text, remaining: speechChunks(text).join(" "), send });
    this.cancelVoiceIdle();
    this.voiceProcess().postMessage({ type: "say", id, text, ...this.speedField });
  }

  /**
   * Hear Ember's sample (Settings › Voice), said as a reply is: the voice it was heard in once it starts, "stopped" when
   * something else Ember said cut it off first, or null when no voice spoke it within SAMPLE_WAIT_MS or the page said
   * speech failed. Named only once heard: a guess before Kitten loaded named a voice that might never speak (voice-speaking-r3).
   */
  sample(text: string): Promise<NaturalVoiceModel | "system" | "stopped" | null> {
    this.speak(text);
    const generation = this.speechGeneration;
    return new Promise(resolve => {
      const wait = {
        generation,
        done: (heard: NaturalVoiceModel | "system" | "stopped" | null) => {
          clearTimeout(timer);
          if (this.sampleWait === wait) this.sampleWait = null;
          resolve(heard);
        },
      };
      const timer = setTimeout(() => wait.done(null), SAMPLE_WAIT_MS);
      timer.unref?.();
      this.sampleWait?.done("stopped");
      this.sampleWait = wait;
    });
  }

  /** The speaking speed setting changed: replies from now on are said at it. */
  setRate(rate: number): void {
    this.rate = Number.isFinite(rate) && rate >= 0.8 && rate <= 1.4 ? rate : 1;
  }

  private get rateField(): { rate?: number } {
    return this.rate === 1 ? {} : { rate: this.rate };
  }

  private get speedField(): { speed?: number } {
    return this.rate === 1 ? {} : { speed: this.rate };
  }

  /** The voice the next reply is said in (Hear Ember says which): Ember's own, loaded or to be, or this computer's. */
  get nextVoice(): NaturalVoiceModel | "system" {
    if (!this.neuralVoice) return "system";
    return this.ttsInfo?.voice ?? (this.optionalVoiceReady ? this.optional : "kitten");
  }

  /**
   * The natural voice turned on or off (the setting): the speech process starts again once it has nothing left to say,
   * with Kokoro (fetched first, where this computer is fast enough for it) or without.
   */
  setNaturalVoice(on: boolean): void {
    if (on === this.naturalWanted) return;
    this.naturalWanted = on;
    this.naturalOff = on && this.o.naturalSupported === false;
    this.ttsFailures = 0;
    this.o.log.info("voice.natural_wanted", { on });
    if (!on) {
      this.cancelNaturalDownload();
      this.switchVoice = false;
      if (this.ttsInfo?.voice === "kitten") this.setNatural({ state: "on" });
      else {
        this.setNatural(this.naturalBlocked() ?? { state: this.tts ? "checking" : "later" });
        if (this.tts) { this.switchVoice = true; this.switchWhenIdle(); }
      }
      return;
    }
    this.checkNatural();
  }

  /** Selects the optional model; choosing it while off downloads nothing. An in-flight old model never changes this choice. */
  setNaturalModel(model: NaturalVoiceModel): void {
    if (model === "kitten") { this.setNaturalVoice(false); return; }
    if (model === this.optional) return;
    this.optional = model;
    if (!this.naturalWanted) return;
    this.cancelNaturalDownload();
    this.naturalOff = this.o.naturalSupported === false;
    this.ttsFailures = 0;
    this.checkNatural();
  }

  /** The optional voice wanted, as a download. */
  private get naturalFile(): typeof NATURAL_VOICE {
    return this.optional === "supertonic" ? SUPERTONIC_VOICE : NATURAL_VOICE;
  }

  private get selectedVoice(): NaturalVoiceModel {
    return this.naturalWanted ? this.optional : "kitten";
  }

  private get naturalPath(): string | null {
    const file = this.naturalFile;
    const root = this.rootOf(file.id);
    return root === null ? null : path.join(root, file.target);
  }

  /** Effective requested model and actual local engine, including baseline Kitten when the legacy toggle is false. */
  get naturalStatus(): NaturalVoiceStatus {
    return { ...this.natural, model: this.selectedVoice, voice: this.currentVoice, ...(this.natural.state === "wont-load" && this.ttsStopped && this.selectedVoice === "kitten" ? { stopped: true as const } : {}) };
  }

  /**
   * Try again (Home's button) after the natural voice's download failed, or Kitten stopped working or was too slow just
   * now (voice-speaking-6): the check, and the download or the timing, start again now.
   */
  retryNaturalVoice(): void {
    if (this.naturalFetch) return;
    this.naturalOff = this.naturalWanted && this.o.naturalSupported === false;
    this.ttsFailures = 0;
    this.ttsStopped = false;
    this.kittenRecheckAt = 0;
    this.checkNatural();
  }

  private cancelNaturalDownload(): void {
    this.naturalEpoch++;
    this.naturalAbort?.abort();
    this.naturalAbort = null;
    // ensureModel owns shared download/staging paths until its cleanup settles. Never start a replacement early.
    this.naturalRetiring = this.naturalFetch !== null;
    this.naturalPercent = 0;
  }

  /**
   * An explicit Kokoro choice loads its existing cache or fetches that optional model. Kitten always uses the base
   * speech-model download. Each model's native runtime probe decides whether it can speak fast enough.
   */
  private checkNatural(): void {
    const blocked = this.naturalBlocked();
    if (blocked) { this.setNatural(blocked); return; }
    if (!this.naturalWanted) {
      if (this.ttsInfo?.voice === "kitten") { this.setNatural({ state: "on" }); return; }
      if (this.tts) this.switchVoice = true;
      this.switchWhenIdle();
      if (this.locked) { this.naturalOnUnlock = true; this.setNatural({ state: "later" }); return; }
      this.setNatural({ state: "checking" });
      this.warmVoice();
      return;
    }
    // Turned off and on again while it downloads: the download carries on.
    if (this.naturalFetch) { this.setNatural(this.naturalRetiring ? { state: "checking" } : { state: "downloading", percent: this.naturalPercent }); return; }
    if (this.naturalPath !== null) {
      if (this.ttsInfo?.voice === this.optional) { this.setNatural({ state: "on" }); return; }
      this.switchVoice = true;
      this.switchWhenIdle();
      if (this.tts) { this.setNatural({ state: "checking" }); return; }
    } else if (this.ttsInfo?.voice === "kitten") { this.decideNatural(this.ttsInfo); return; }
    else if (this.ttsInfo) { this.switchVoice = true; this.switchWhenIdle(); if (this.tts) { this.setNatural({ state: "checking" }); return; } }
    // Nothing speaks while the screen is locked, so nothing can tell: "later", and it is decided once it is unlocked
    // (setLocked), never "Checking…" for as long as the lock lasts (review of #143).
    if (this.locked) { this.naturalOnUnlock = true; this.setNatural({ state: "later" }); return; }
    this.setNatural({ state: "checking" });
    // Its "ready" decides (voiceReady).
    this.warmVoice();
  }

  /** Why the natural voice can't be had at all here, or null: speech doesn't run natively, or Ember's own voice isn't in. */
  private naturalBlocked(): NaturalVoiceStatus | null {
    if (!this.native || (this.naturalWanted && this.o.naturalSupported === false)) return { state: "needs-native" };
    if (!this.o.neuralVoice || (this.rootOf("tts") === null && !this.optionalVoiceReady)) return { state: "needs-voice" };
    if (this.ttsFailures >= VOICE_FAILURES) return { state: "wont-load" };
    return null;
  }

  private setNatural(s: NaturalVoiceStatus): void {
    this.natural = s;
    const next = JSON.stringify(this.naturalStatus);
    if (next === this.naturalPublished) return;
    this.naturalPublished = next;
    this.o.onNatural?.(this.naturalStatus);
  }

  hush(): void {
    // Only the speaking page can confirm this cancellation. Repeated hushes retain the first request time.
    if (!this.hushMeasure && this.speakingPage) {
      const win = this.speakingPage === "mic" ? this.mic : this.speaker?.win;
      if (win && !win.isDestroyed()) this.hushMeasure = { owner: win.webContents, page: this.speakingPage, at: performance.now() };
    }
    this.dropFollowUp();
    this.speakingUntil = 0;
    this.awaitingSpeechStart = false;
    if (this.ttsId > this.ttsHushed) {
      this.ttsHushed = this.ttsId;
      // Each reply on its way is over for its page too (its Player would otherwise wait for it, "speaking", for good).
      for (const [id, p] of this.ttsPending) p.send(VOICE.audioDone, id);
      this.ttsPending.clear();
      this.tts?.proc.postMessage({ type: "hush", id: this.ttsHushed });
    }
    this.afterVoice = [];
    this.idleVoice();
    const generation = ++this.speechGeneration;
    this.sampleWait?.done("stopped");
    const hushPage = (wc: Electron.WebContents) => { this.pageGenerations.set(wc, generation); wc.send(VOICE.hush, generation); };
    if (this.mic && !this.mic.isDestroyed()) hushPage(this.mic.webContents);
    // A page still loading receives the current hush once ready; old queued sends check their captured generation.
    const s = this.speaker;
    if (s && !s.win.isDestroyed()) s.loaded.then(() => { if (!s.win.isDestroyed() && generation === this.speechGeneration) hushPage(s.win.webContents); }, () => { /* it never loaded: it says nothing */ });
  }

  /**
   * Loads Ember's voice ahead of its first reply (2 s or so), once someone has called Ember: until then it costs no
   * memory. After a conversation it is released (VOICE_IDLE_MS), and the next wake warms it again.
   */
  warmVoice(): void {
    if (this.kittenRecheckAt && Date.now() >= this.kittenRecheckAt && !this.locked && this.selectedVoice === "kitten" && !this.naturalFetch) {
      this.kittenRecheckAt = 0;
      this.kittenRechecked = true;
      this.o.log.info("voice.kitten_recheck");
      this.ttsFailures = 0;
      this.ttsStopped = false;
    }
    if (this.neuralVoice && !this.locked) {
      // A voice already speaking this session that is only loaded again after VOICE_IDLE_MS stays "on": "checking" and
      // back at every first wake after two quiet minutes was said by a screen reader over the request, and into the idle
      // wake microphone, where it woke Ember (voice-listening-c5-1). A load that now fails still says so (voiceFailed).
      if (!this.tts && !this.naturalFetch && (!this.naturalWanted || !this.naturalOff) && this.natural.state !== "on") this.setNatural({ state: "checking" });
      this.voiceProcess(); this.idleVoice();
    }
  }

  /**
   * A request is likely (the ask box opened, a typed request was sent): Ember's voice loads meanwhile, and with
   * listening off its speak-only page too, so the answer isn't heard 2 s after it is shown (voice-speaking-1: 2.7 s to
   * the first sound cold, 0.8 s warm). Both are let go again when idle (VOICE_IDLE_MS, SPEAKER_IDLE_MS).
   */
  warmSpeech(): void {
    if (this.locked) return;
    this.warmVoice();
    if (!this.mic || this.mic.isDestroyed()) this.speakerWindow();
  }

  private cancelVoiceIdle(): void {
    if (this.voiceIdle) clearTimeout(this.voiceIdle);
    this.voiceIdle = null;
  }

  /** Audio already handed to the page plays independently; pending generation always keeps the synthesiser alive. */
  private idleVoice(): void {
    this.cancelVoiceIdle();
    const tts = this.tts;
    if (!tts?.ready || this.ttsPending.size) return;
    this.voiceIdle = setTimeout(() => {
      this.voiceIdle = null;
      if (this.tts !== tts || this.ttsPending.size) return;
      this.o.log.info("voice.tts_idle");
      this.releaseVoice();
    }, VOICE_IDLE_MS);
    this.voiceIdle.unref?.();
  }

  /** Drop the live handle before stopping it: late audio and exit events cannot revive a retired voice. */
  private releaseVoice(): void {
    this.cancelVoiceIdle();
    const tts = this.tts;
    this.tts = null;
    this.ttsInfo = null;
    if (!tts) return;
    tts.proc.removeAllListeners("exit");
    tts.proc.kill();
    // utilityProcess.kill() before spawn has no effect. Retain this handle until it can actually be stopped.
    if (tts.proc.pid === undefined) tts.proc.once("spawn", () => tts.proc.kill());
  }

  /** Whether replies are said in Ember's own voice: wanted, its model is in, and it hasn't failed this session. */
  private get neuralVoice(): boolean {
    return !!this.o.neuralVoice && this.native && this.ttsFailures < VOICE_FAILURES && (this.rootOf("tts") !== null || this.optionalVoiceReady);
  }

  private get optionalVoiceReady(): boolean {
    return this.naturalWanted && this.o.naturalSupported !== false && !this.naturalOff && this.naturalPath !== null;
  }

  /** The page that speaks now: the mic window while listening, otherwise one that only speaks (listening is off). */
  private pageSend(): PageSend {
    const generation = this.speechGeneration;
    const send = (wc: Electron.WebContents, channel: string, payload: unknown) => {
      if (generation !== this.speechGeneration) return;
      if (this.pageGenerations.get(wc) !== generation) { wc.send(VOICE.hush, generation); this.pageGenerations.set(wc, generation); }
      wc.send(channel, payload);
    };
    const mic = this.mic;
    if (mic && !mic.isDestroyed()) return (channel, payload) => { if (!mic.isDestroyed()) send(mic.webContents, channel, payload); };
    const s = this.speakerWindow();
    return (channel, payload) => {
      if (this.speaker === s) this.idleSpeaker();
      s.loaded.then(() => { if (!s.win.isDestroyed()) send(s.win.webContents, channel, payload); }, (err: unknown) => this.o.log.warn("voice.speaker_failed", { message: String(err) }));
    };
  }

  /** Speech can run natively here (runtime.ts). */
  private get native(): boolean {
    return process.env.EMBER_VOICE_BACKEND !== "wasm" && (this.o.native ?? (nativePackage() !== null || !!this.o.capiDir));
  }

  /** Ember's voice process, started (and its voice loaded) on first use. */
  private voiceProcess(): UtilityProcess {
    if (this.tts) return this.tts.proc;
    const proc = utilityProcess.fork(path.join(appDir, "tts.cjs"), [], { serviceName: "Ember speech", stdio: "pipe" });
    const tts = { proc, ready: false };
    this.tts = tts;
    proc.stderr?.on("data", (d: Buffer) => this.o.log.debug("voice.tts_stderr", { line: d.toString().slice(0, 300) }));
    proc.on("exit", code => {
      if (this.tts !== tts) return;
      const used = this.ttsInfo?.voice;
      this.ttsInfo = null;
      if ((used === "kokoro" || used === "supertonic" || (!tts.ready && this.naturalWanted && this.naturalPath && !this.naturalOff)) && this.native) {
        this.kokoroFailed();
        return;
      }
      this.o.log.warn("voice.tts_exit", { code });
      this.ttsFailures++;
      this.voiceFailed("load", tts.ready);
    });
    proc.on("message", (m: TtsProcessMessage) => {
      if (this.tts !== tts) return;
      if (m.type === "ready") { tts.ready = true; this.voiceReady(m.loadMs, m.rate, m.voice); return; }
      if (m.type === "error") { this.o.log.error("voice.tts_error", { message: m.message }); this.voiceFailed(m.reason); return; }
      const pending = this.ttsPending.get(m.id);
      if (m.id <= this.ttsHushed || !pending) return;
      if (m.type === "audio") { pending.remaining = m.remaining; pending.send(VOICE.audio, { id: m.id, samples: m.samples, rate: m.rate } satisfies SpeechAudio); return; }
      if (m.type === "failed") { this.o.log.warn("voice.tts_failed", { message: m.message }); if (this.ttsInfo?.voice === "kokoro" || this.ttsInfo?.voice === "supertonic") this.kokoroFailed(); else this.voiceFailed("load", true); return; }
      this.ttsPending.delete(m.id);
      pending.send(VOICE.audioDone, m.id);
      this.sendAfterVoice();
      if (!this.saidSpeaking) { this.awaitingSpeechStart = true; this.speakingUntil = Date.now() + SPEECH_START_MS; }
      this.openFollowUp();
      this.switchWhenIdle();
      this.idleVoice();
    });
    const natural = this.optionalVoiceReady ? this.naturalPath : null;
    proc.postMessage({ type: "init", model: this.paths().tts, natural, naturalVoice: this.optional, ...(this.o.capiDir ? { capiDir: this.o.capiDir } : {}) });
    return proc;
  }

  /**
   * Ember's voice loaded: actual model, runtime and speed. Engine-only fallback changes are published too.
   */
  private voiceReady(loadMs: number, rate: number, v: VoiceInfo | undefined): void {
    this.o.log.info("voice.tts_ready", { loadMs, rate, ...(v ? { voice: v.voice, backend: v.backend, detail: v.detail, provider: v.provider, threads: v.threads, rtf: v.rtf, tried: v.tried, natural: v.natural } : {}) });
    this.ttsInfo = v ?? null;
    this.currentVoice = v?.voice ?? "kitten";
    if (v) this.decideNatural(v);
    else if (!this.naturalWanted) this.setNatural({ state: "on" });
    this.setNatural(this.natural);
    this.idleVoice();
  }

  /**
   * Kokoro is used only as an explicit supported override. Its failed probe keeps Kitten; baseline failures keep the
   * local system voice. Merely selecting baseline Kitten never fetches an optional model.
   */
  private decideNatural(v: VoiceInfo): void {
    if (v.backend !== "native") { this.voiceFailed("native"); return; }
    if (this.naturalWanted && this.o.naturalSupported === false) { this.naturalOff = true; this.setNatural({ state: "needs-native" }); return; }
    if (v.voice === this.selectedVoice) { this.setNatural({ state: "on" }); return; }
    if (!this.naturalWanted) { this.setNatural({ state: "checking" }); this.switchVoice = true; this.switchWhenIdle(); return; }
    if (this.naturalFetch) return;
    if (this.naturalOff) return;
    // Optional Kokoro failed its real probe; keep baseline Kitten for this session.
    if (v.natural) {
      this.naturalOff = true;
      this.setNatural({ state: v.naturalWhy === "native" ? "needs-native" : v.naturalWhy === "load" ? "wont-load" : "too-slow" });
      return;
    }
    // Downloaded already (and not loaded by this process: it started before): it starts again with it once idle.
    if (this.naturalPath !== null) { this.setNatural({ state: "ready" }); this.switchVoice = true; this.switchWhenIdle(); return; }
    const file = this.naturalFile, epoch = ++this.naturalEpoch, abort = new AbortController();
    this.naturalAbort = abort;
    this.o.log.info("voice.natural_fetching", { bytes: file.bytes, model: this.optional });
    this.setNatural({ state: "downloading", percent: 0 });
    // Into the user's own models folder (one that came with Ember is never changed).
    this.naturalPercent = 0;
    const progress = (bytes: number) => {
      if (epoch !== this.naturalEpoch || !this.naturalWanted) return;
      const percent = Math.min(99, Math.floor((bytes / file.bytes) * 100));
      if (percent === this.naturalPercent) return;
      this.naturalPercent = percent;
      if (this.naturalWanted) this.setNatural({ state: "downloading", percent });
    };
    const transfer: Promise<void> = ensureModel(this.userRoot, file, this.o.downloader ?? electronDownloader, progress, abort.signal)
      .then(() => {
        if (epoch !== this.naturalEpoch || !this.naturalWanted) return;
        this.o.log.info("voice.natural_ready", { root: this.userRoot });
        this.setNatural({ state: "ready" });
        this.switchVoice = true;
        this.switchWhenIdle();
      })
      .catch((err: unknown) => {
        if (epoch !== this.naturalEpoch || !this.naturalWanted) return;
        const message = err instanceof Error ? err.message : String(err);
        this.naturalOff = true;
        this.o.log.warn("voice.natural_download_failed", { message });
        this.setNatural({ state: "failed", detail: downloadHelp(message, file.bytes) });
      })
      .finally(() => {
        if (this.naturalFetch !== transfer) return;
        const retired = this.naturalRetiring;
        this.naturalFetch = null;
        this.naturalAbort = null;
        this.naturalRetiring = false;
        if (retired && this.naturalWanted && !this.naturalOff) this.checkNatural();
      });
    this.naturalFetch = transfer;
  }

  /**
   * The speech process is to start again with (or without) the natural voice: it stops once it has nothing to say, and
   * starts again at once while the natural voice is wanted (so it is loaded and timed now, not at some later reply).
   */
  private switchWhenIdle(): void {
    if (!this.switchVoice) return;
    if (!this.tts) { this.switchVoice = false; return; }
    if (this.ttsPending.size) return;
    this.switchVoice = false;
    this.releaseVoice();
    if (!this.locked && this.neuralVoice) {
      if (this.natural.state === "ready") this.setNatural({ state: "checking" });
      this.warmVoice();
    } else if (!this.neuralVoice) {
      this.currentVoice = "system";
      this.setNatural(this.naturalBlocked() ?? { state: "wont-load" });
    }
  }

  /**
   * Retire a failed synthesiser for this session. The page drains already generated audio before the local system
   * voice says only the remaining chunks. Later streamed sentences use that same engine, never overlap it.
   */
  private voiceFailed(reason: "slow" | "load" | "native" = "load", stopped = false): void {
    this.ttsFailures = VOICE_FAILURES;
    this.ttsStopped = stopped;
    // A busy moment or a crash after it spoke may pass: Kitten is timed again later, once (KITTEN_RECHECK_MS).
    if (!this.kittenRechecked && this.selectedVoice === "kitten" && (reason === "slow" || (reason === "load" && stopped))) this.kittenRecheckAt = Date.now() + KITTEN_RECHECK_MS;
    this.switchVoice = false;
    this.currentVoice = "system";
    this.setNatural({ state: reason === "native" ? "needs-native" : reason === "slow" ? "too-slow" : "wont-load" });
    this.releaseVoice();
    const pending = [...this.ttsPending.entries()];
    this.ttsPending.clear();
    if (pending.some(([, p]) => p.remaining.trim())) {
      this.awaitingSpeechStart = true;
      if (!this.saidSpeaking) this.speakingUntil = Date.now() + SPEECH_START_MS;
    }
    for (const [id, p] of pending) {
      p.send(VOICE.audioDone, id);
      const text = p.remaining;
      if (text) p.send(VOICE.speak, { text, append: true, ...this.rateField } satisfies SpeakRequest);
    }
    this.sendAfterVoice();
    this.openFollowUp();
  }

  /** The system voice's words that waited for Ember's own (afterVoice), once it has nothing left to make. */
  private sendAfterVoice(): void {
    if (this.ttsPending.size) return;
    const waiting = this.afterVoice;
    this.afterVoice = [];
    for (const w of waiting) w.send(VOICE.speak, w.request);
  }

  /** Retire optional Kokoro and append only its ungenerated suffix through baseline Kitten. */
  private kokoroFailed(): void {
    this.naturalOff = true;
    this.switchVoice = false;
    this.cancelNaturalDownload();
    this.releaseVoice();
    this.currentVoice = "system";
    this.setNatural({ state: this.naturalWanted ? "wont-load" : "checking" });
    const pending = [...this.ttsPending.entries()];
    this.ttsPending.clear();
    for (const [id, p] of pending) {
      p.send(VOICE.audioDone, id);
      if (!p.remaining.trim()) continue;
      const next = ++this.ttsId, text = p.remaining;
      this.ttsPending.set(next, { text, remaining: text, send: p.send });
      this.voiceProcess().postMessage({ type: "say", id: next, text, ...this.speedField });
    }
  }

  /** The mic page's address and its development audio options. */
  private micPage(): string {
    return pageUrl(path.join(appDir, "renderer", "mic", "index.html"), {
      ...(this.o.playback === "element" ? { playback: "element" } : {}),
      ...(!app.isPackaged && this.o.testMicWav ? { testMicWav: "1" } : {}),
    });
  }

  private speakerWindow(): Speaker {
    if (this.speaker && !this.speaker.win.isDestroyed()) return this.speaker;
    // The mic page without its audio port: it speaks, and never asks for the microphone.
    const win = hiddenWindow("Ember speech");
    const wc = win.webContents;
    wc.on("render-process-gone", () => { if (this.hushMeasure?.owner === wc) this.hushMeasure = null; });
    this.speaker = { win, wc, loaded: win.loadURL(this.micPage()), saying: false };
    this.idleSpeaker();
    return this.speaker;
  }

  /** The speech-only window closes SPEAKER_IDLE_MS from now unless it speaks or is sent more meanwhile. */
  private idleSpeaker(): void {
    if (this.speakerIdle) clearTimeout(this.speakerIdle);
    this.speakerIdle = null;
    if (!this.speaker || this.speaker.saying) return;
    this.speakerIdle = setTimeout(() => { this.speakerIdle = null; if (this.speaker && !this.speaker.saying) this.closeSpeaker(); }, SPEAKER_IDLE_MS);
    this.speakerIdle.unref?.();
  }

  private async start(): Promise<void> {
    const temporary = !!this.manual?.temporary;
    if ((!this.wanted && !temporary) || this.proc) return;
    this.cancelRetry();
    if (this.muted) { this.setState("muted"); return; }
    if (this.locked) { this.setState("off", LOCKED_TEXT); return; }
    if (!this.modelsReady) { this.setState(this.downloading ? "downloading" : "needs-models"); return; }
    this.setState("starting");
    this.readyAt = 0;
    this.micLost = false;
    this.micSilent = false;
    this.monitorOn = false;
    this.utterances = 0;
    const proc = utilityProcess.fork(path.join(appDir, "voice.cjs"), [], { serviceName: "Ember voice", stdio: "pipe" });
    this.proc = proc;
    let connectTemporaryMic: (() => void) | undefined;
    proc.stderr?.on("data", (d: Buffer) => this.o.log.debug("voice.stderr", { line: d.toString().slice(0, 300) }));
    proc.on("exit", code => {
      if (this.proc !== proc) return;
      if (temporary && !this.readyAt && this.native) this.wasmOnly.voice = true;
      if (!temporary && !this.readyAt && this.native && !this.wasmOnly.voice) {
        // It died loading, natively (a damaged model aborts the addon's onnxruntime): started again at once on
        // WebAssembly, which says whether the models are damaged.
        this.o.log.warn("voice.native_failed", { code });
        this.wasmOnly.voice = true;
        this.teardown();
        void this.start();
        return;
      }
      this.o.log.warn("voice.exit", { code });
      this.restartLater("The voice process stopped.");
    });
    proc.on("message", (m: VoiceProcessMessage) => {
      if (this.proc !== proc) return; // a process being replaced: only the current one speaks for the mic
      this.alive?.watch.frame();
      if (m.type === "alive") return;
      if (m.type === "ready") {
        const b = m.backend;
        this.o.log.info("voice.ready", { loadMs: m.loadMs, ...(b?.clear ? { clear: true } : {}), ...(b ? { backend: b.backend, detail: b.detail, provider: b.provider, threads: b.threads, tried: b.tried } : {}) });
        // A model the native build couldn't make runs on WebAssembly (slower): worth a warning, it may be the build's fault.
        if (b?.wasmModels?.length) this.o.log.warn("voice.model_wasm_fallback", { models: b.wasmModels, detail: b.detail });
        this.clearLoaded = !!b?.clear;
        if (this.clearWanted && !this.clearFetch && this.clear.state !== "failed") {
          // Not fetched yet: checkClear says what comes next (it can't run here, or its download), never "Starting…"
          // first. Home's line changed twice as each ready came, a temporary Listen once's as its window opened, and a
          // screen reader said it over the request (voice-listening-c4-1).
          if (!b?.clear && this.rootOf("clear") === null) this.checkClear();
          else this.setClear({ state: b?.clear ? "on" : "wont-load" });
        }
        // (A Listen once with wake listening off stays "Starting…" until its window opens: "Listening for “Ember”" was up
        // a moment, untrue, and a screen reader said it over the microphone as the request began: voice-listening-r3-1.)
        this.readyAt = Date.now(); this.watchAlive(proc); if (!temporary) this.setState("waiting");
        connectTemporaryMic?.();
        connectTemporaryMic = undefined;
        this.armListenOnce();
        // Turned off while this process was loading it: it has what was wanted then.
        if (this.clearLoaded && !this.clearWanted) this.listenAgain();
        return;
      }
      if (m.type === "error") {
        this.o.log.error("voice.error", { message: m.message, models: !!m.models });
        this.teardown();
        // A model that won't load is damaged: it (alone, when the process says which; otherwise the ones listening
        // loads) counts as missing from now, and settings offers the download again, of that one.
        if (m.models) {
          if (!this.forgetDamaged(m.model ? [m.model] : LISTENING_MODELS)) {
            this.setState("error", "The speech models look damaged, and Ember can't replace them: it isn't allowed to change its models folder.");
            return;
          }
          this.o.onModels?.();
          // Other copies of the models: the native build is tried again.
          this.wasmOnly = { voice: false };
          if (this.modelsReady) void this.start(); // the user's own copy is there: it's tried
          else this.setState("needs-models", "The speech models look damaged. Download them again.");
          return;
        }
        this.setState("error", m.message);
        return;
      }
      if (m.type === "enrol") {
        const was = this.enrolling;
        this.enrolling = m.state !== "done" && m.state !== "cancelled";
        this.enrolGot = { got: m.got, of: m.of };
        if (was && !this.enrolling) this.enrolEnded();
        this.o.onEnrol?.(m); this.o.onListenOnce?.(); return;
      }
      if (m.type === "voice-match-error") { this.o.log.warn("voice.match_error", { message: m.message }); return; }
      // A request Voice Match may learn from (app/voice/adapt.ts): main decides (numbers only, never audio).
      if (m.type === "voice-sample") { if (m.generation === this.listeningGeneration) this.o.onSample?.(m); return; }
      if (m.type === "stats") { this.o.log.info("voice.cpu", { percent: Math.round((m.cpuMs / m.audioMs) * 1000) / 10, audioMs: m.audioMs, peak: m.peak }); return; }
      // The recognizers failed on some audio; the process carried on (it heard nothing in that audio).
      if (m.type === "engine-error") { this.o.log.warn("voice.engine_error", { message: m.message, count: m.count }); return; }
      // They keep failing (unusable until loaded again): started again, with the backoff.
      if (m.type === "engine-broken") { this.o.log.error("voice.engine_broken", { message: m.message }); this.restartLater("The speech recognizer kept failing."); return; }
      if (m.type === "monitor") { this.monitorOn = m.on; this.o.log.info("voice.speaker_rejection", { on: m.on, reason: m.reason }); return; }
      if (m.type === "silent" && m.manual) {
        // Listen once heard only zeros: its window says so when it times out, next (voice-listening-4).
        this.o.log.warn("voice.silent", { on: true, manual: true });
        this.manualSilent = !!this.manual;
        return;
      }
      if (m.type === "silent") {
        // Frames still arrive (the watchdog is content), but nothing can be heard in them: said, not restarted.
        this.o.log.warn("voice.silent", { on: m.on });
        const was = this.micSilent;
        this.micSilent = m.on;
        if (m.on) { this.captureGeneration++; this.cancelListenOnce(); this.interruptEnrol(); this.setState("error", SILENT_TEXT); }
        else if (was && this.state === "error") this.setState("waiting"); // (not another error, such as a lost microphone)
        return;
      }
      if (m.type === "stalled") {
        // The mic page says when it lost the microphone (and gets it back itself); otherwise audio just stopped.
        if (!this.micLost) { this.o.log.warn("voice.stalled", { ms: m.ms }); this.restartLater("No sound is arriving from the microphone."); }
        return;
      }
      // Every utterance the voice process sends is counted, dropped or not: a voice-sample names its request by this number.
      if (m.type === "utterance") this.utterances++;
      if (m.type !== "stop" && m.generation !== this.listeningGeneration) { this.o.log.info("voice.dropped", { reason: "cancelled" }); return; }
      if (temporary && m.type !== "stop" && !("window" in m && m.window === "manual")) return;
      if (m.type === "wake") { this.finishListenOnce("Listening cancelled."); this.o.log.info("voice.wake", { keyword: m.keyword }); this.dropFollowUp(); this.warmVoice(); } // a new request: the old answer's follow-up is moot
      if (m.type === "stop") this.o.log.info("voice.stop");
      const { generation: _generation, ...event } = m;
      if ((m.type === "utterance" || m.type === "listening") && m.window === "manual") {
        const manual = this.manual;
        if (!manual) return;
        if (m.type === "utterance") {
          this.o.onEvent(event, { utterance: this.utterances });
          // (Its microphone off once it is done: straight to "off", never "Listening for “Ember”".)
          if (this.state === "active" && !temporary) this.setState("waiting");
          this.finishListenOnce("Request heard.", true);
          return;
        }
        if (m.on) manual.phase = "listening";
        else if (m.reason === "done") {
          manual.phase = "checking";
          // Heard: only Voice Match's check is left, which gets LISTEN_ONCE_CHECK_MS.
          clearTimeout(manual.timer);
          manual.timer = setTimeout(() => this.cancelListenOnce("Listening timed out. Try again."), LISTEN_ONCE_CHECK_MS);
          manual.timer.unref();
          if (temporary) { this.capturing = false; this.closeMic(); }
        }
        // (Checked by Voice Match after it is done, a temporary one's window stays as it was until its end says "off".)
        if (m.on || !temporary) this.setState(m.on ? "active" : "waiting", m.on ? LISTEN_ONCE_LISTENING : undefined);
        this.o.onEvent(event);
        if (!m.on && m.reason !== "done") this.finishListenOnce(m.reason === "timeout" ? (this.manualSilent ? SILENT_TEXT : m.doubt ? LISTEN_ONCE_DOUBT : "No request heard. Try again.") : m.reason === "rejected" ? "Voice Match didn't recognise you." : "Listening cancelled.");
        else this.o.onListenOnce?.();
        return;
      }
      // A window whose request opens a conversation goes straight on into it: "Listening for “Ember”" for a moment between
      // them (Listen once's line with it) was said by a screen reader into the conversation, as a request (voice-listening-c3-1).
      // Only a wake's window hears the user from its start: a follow-up's or a conversation's waits for them, as Listen
      // once does ("Hearing you…" was up for 30 s after each answer, the badge saying "Listening": voice-listening-r3-2).
      if (m.type === "listening" && (m.on || m.next !== "conversation")) this.setState(m.on ? "active" : "waiting", m.on && m.window !== "wake" ? LISTEN_ONCE_LISTENING : undefined);
      if (m.type === "rejected") this.o.log.info("voice.rejected", { keyword: m.keyword, reason: m.reason, ...(m.score !== undefined ? { score: m.score } : {}) });
      this.o.log.debug("voice.event", { type: m.type });
      this.o.onEvent(event, m.type === "utterance" ? { utterance: this.utterances } : undefined);
    });
    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ type: "init", generation: this.listeningGeneration, models: this.paths(), monitor: !temporary && this.o.monitor, ...(temporary ? { manualOnly: true } : {}), dev: !app.isPackaged, voiceprint: this.voiceprint(), ...(this.voiceprint() ? this.o.matchLearnt?.() ?? {} : {}), ...(this.wasmOnly.voice ? { wasm: true } : this.o.capiDir ? { capiDir: this.o.capiDir } : {}), ...(!temporary && this.o.conversation?.() ? { conversation: true } : {}) }, [port1]);
    if (this.o.learning?.()) proc.postMessage({ type: "learning", on: true });

    this.mic = hiddenWindow("Ember microphone");
    const mic = this.mic;
    // The mic window speaks from now on: the speech-only window isn't needed (once it has finished).
    if (!this.speaker?.saying) this.closeSpeaker();
    mic.webContents.on("render-process-gone", (_e, d) => {
      if (this.mic === mic) { this.o.log.warn("voice.mic_gone", { reason: d.reason }); this.restartLater("The microphone page stopped."); }
    });
    await mic.loadURL(this.micPage()).catch(err => {
      if (temporary && this.proc === proc) this.cancelListenOnce("Couldn't open the microphone. Try again.");
      this.o.log.warn("voice.mic_page_failed", { err });
    });
    if (mic.isDestroyed() || this.mic !== mic) return;
    const connectMic = () => mic.webContents.postMessage(VOICE.port, null, [port2]);
    if (temporary && !this.readyAt) connectTemporaryMic = connectMic;
    else connectMic();
  }

  /**
   * The models `ids` turned out damaged. One that came with Ember is never changed (it may be inside the signed app,
   * and an update replaces it): the user's own copy is used from now on, and the download goes there. One of the
   * user's own is forgotten (its marker goes), the others are left as they are. False when that couldn't be done.
   */
  private forgetDamaged(ids: readonly ModelId[]): boolean {
    const own: ModelId[] = [];
    for (const id of ids) {
      const root = this.rootOf(id);
      if (root !== null && root === this.bundledRoot) {
        this.o.log.warn("voice.bundled_model_damaged", { root, model: id });
        this.notBundled.add(id);
      } else own.push(id);
    }
    return !own.length || forgetModels(this.userRoot, own);
  }

  /** Listening broke (the voice process or the mic page died, or no sound arrives): start again after 1 s, 5 s, then every 30 s, saying so meanwhile. */
  private restartLater(why: string): void {
    if (this.manual?.temporary) { this.cancelListenOnce(`${why} Try again.`); return; }
    this.teardown();
    if (!this.wanted || this.muted) return;
    if (this.readyAt && Date.now() - this.readyAt > 60_000) this.failures = 0; // it had been working: start the backoff over
    const ms = RESTART_MS[Math.min(this.failures++, RESTART_MS.length - 1)];
    this.o.log.warn("voice.restart", { why, inMs: ms, attempt: this.failures });
    this.setState("error", `${why} Trying again in ${ms / 1000} s…`);
    this.cancelRetry();
    this.retry = setTimeout(() => { this.retry = null; void this.start(); }, ms);
  }

  /**
   * From ready on, a voice process that says nothing for ALIVE_MS is taken for stuck (a WebAssembly call that never
   * returns, or security software suspending it) and started again: it can't say so itself, the microphone's frames
   * would pile up in its queue, and Ember would show "Listening" while deaf (review #257). Main's own late check (the
   * computer slept) doesn't count.
   */
  private watchAlive(proc: UtilityProcess): void {
    this.stopWatchingAlive();
    const watch = new FrameWatchdog(ms => {
      if (this.proc !== proc) return;
      this.o.log.warn("voice.unresponsive", { ms });
      this.restartLater("The voice process stopped responding.");
    }, Date.now, ALIVE_MS, ALIVE_MS);
    watch.frame();
    const timer = setInterval(() => watch.check(), 1000);
    timer.unref?.();
    this.alive = { watch, timer };
  }

  private stopWatchingAlive(): void {
    if (this.alive) clearInterval(this.alive.timer);
    this.alive = null;
  }

  private cancelRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private closeMic(): void {
    const mic = this.mic;
    this.mic = null;
    this.micDevice = "";
    if (this.hushMeasure?.page === "mic") this.hushMeasure = null;
    if (mic && !mic.isDestroyed()) mic.destroy();
    // Its meter goes with it (the page that sends the levels is gone, so no null would ever come), and its speech.
    this.o.onLevel?.({ mic: null });
    if (this.speakingPage === "mic") this.speakingEnded();
  }

  /**
   * The page Ember spoke from is gone (or nothing may speak): Ember isn't speaking any more. The voice meter stops, the
   * voice process stops discounting Ember's own voice, and a follow-up waits for nothing.
   */
  private speakingEnded(): void {
    this.speakingPage = null;
    this.speakingUntil = 0;
    // Its next start is a new one: the spoken-answer echo guard (selfSpokeSince) dates it, as after any speech.
    this.saidSpeakingBefore = false;
    this.o.onLevel?.({ voice: null });
    if (this.saidSpeaking) { this.saidSpeaking = false; this.o.log.info("voice.self_speaking", { on: false, listening: !!this.proc }); this.o.onSelfSpeaking?.(false); }
    this.proc?.postMessage({ type: "self-speaking", on: false });
  }

  private teardown(acceptedTemporary = false): void {
    if (!acceptedTemporary) this.manualGeneration++;
    this.listeningGeneration++;
    this.capturing = false;
    if (this.enrolling) {
      // Teaching goes with the voice process (muted, locked, listening off, a restart): settings is told, or it would go
      // on showing the phrase to say, and saying it would make it a request (voice-listening-2).
      this.enrolling = false;
      this.o.onEnrol?.({ type: "enrol", state: "cancelled", ...this.enrolGot, why: "interrupted" });
    }
    this.closeMic();
    this.dropFollowUp();
    this.stopWatchingAlive();
    this.monitorOn = false;
    const p = this.proc;
    this.proc = null;
    this.finishListenOnce("Listening cancelled.");
    if (!p) return;
    p.kill();
    // Not started yet (no pid): kill() does nothing then, and with its handle dropped the process would live on, models
    // loaded, until Ember quits. It goes as soon as it has started (review #256).
    if (p.pid === undefined) p.once("spawn", () => p.kill());
  }

  stop(): void {
    this.wanted = false;
    this.naturalWanted = false;
    this.cancelNaturalDownload();
    this.currentVoice = "system";
    this.setNatural({ state: "off" });
    this.cancelRetry();
    this.teardown();
    this.closeSpeaker();
    this.releaseVoice();
    this.ttsPending.clear();
    this.afterVoice = [];
  }

  private closeSpeaker(): void {
    const s = this.speaker;
    this.speaker = null;
    if (this.hushMeasure?.page === "speaker") this.hushMeasure = null;
    if (this.speakerIdle) { clearTimeout(this.speakerIdle); this.speakerIdle = null; }
    if (s && !s.win.isDestroyed()) s.win.destroy();
    if (s && (s.saying || this.speakingPage === "speaker")) this.speakingEnded();
  }

  private setState(s: MicState, detail?: string): void {
    // While Ember learns a voice, the voice line says so whenever it has nothing of its own to say: a window that ended
    // as teaching began (a conversation's) left "Listening for “Ember”" beside the phrase to say (voice-listening-r2).
    if (s === "waiting" && detail === undefined && this.enrolling) detail = ENROL_TEXT;
    const hearing = s === "active";
    if (hearing !== (this.state === "active")) {
      // The mic page sends the microphone's level only while Ember hears a request; the meter stops at once after.
      if (this.mic && !this.mic.isDestroyed()) this.mic.webContents.send(VOICE.levelOn, hearing);
      if (!hearing) this.o.onLevel?.({ mic: null });
    }
    this.state = s;
    this.o.onState(s, detail);
  }
}

/** The hidden page that hears and speaks for Ember (renderer/mic). */
function hiddenWindow(title: string): BrowserWindow {
  return new BrowserWindow({
    show: false, width: 1, height: 1, skipTaskbar: true, focusable: false, title,
    webPreferences: {
      preload: path.join(appDir, "preload", "mic.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false,
      // A hidden window never gets a user gesture; without this its AudioContext stays suspended.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
}

/**
 * Listen once as Settings (Home) shows it: there, "in Settings" sent people where they already were, right above the
 * Download button (accessibility-visual-9, voice-listening-8), and Ember isn't "I" (voice-listening-v4-3). Ask keeps the
 * words as they are.
 */
export function listenOnceInSettings(s: ListenOnceStatus): ListenOnceStatus {
  if (s.reason === "needs-models") return { ...s, detail: "Download the speech models below first." };
  if (s.reason === "voice-error") return { ...s, detail: "Check the microphone and the voice status above." };
  if (s.detail === LISTEN_ONCE_DOUBT) return { ...s, detail: LISTEN_ONCE_DOUBT_SETTINGS };
  return s;
}

/**
 * Whether a question up holds Listen once back for a control (Ask's, or Home's): it does, but never that control's own
 * Listen once under way (`own`: the voice's status, given only while the request being heard is that control's), whose
 * Cancel listening stays (companion-r1: a question that came mid-request turned it into a dimmed Listen once that took
 * no press, while the microphone still listened).
 */
export function questionHoldsListen(question: boolean, own: ListenOnceStatus | undefined): boolean {
  return question && !(own?.phase === "starting" || own?.phase === "listening" || own?.phase === "checking");
}

/**
 * Listen once's line while a question holds it back (questionHoldsListen), given the microphone's state. While it is
 * open for a request (`active`: a conversation stays open while a question waits, so it can be answered by voice), the
 * line isn't said to screen readers (reason `listening`): said then, through the speakers, it was heard in the
 * conversation as a request or, with Voice Match on, as another voice, after which no spoken answer to that question was
 * taken (voice-listening-v4-1).
 */
export function heldByQuestion(mic: MicState | undefined): ListenOnceStatus {
  return { phase: "blocked", detail: "Answer Ember's question first.", ...(mic === "active" ? { reason: "listening" as const } : {}) };
}

/** Listen once's line on the control whose request a question ended, while that question is up (companion-r2-2). */
export const LISTEN_CUT_BY_QUESTION = "I stopped listening to ask you something. Answer it, then ask again.";

/**
 * The control (`source`: whose Listen once it is) whose request a question that comes now ends (main cancels a Listen once
 * under way for it), given the voice's status; null when none is under way.
 */
export function cutByQuestion(source: "ask" | "home" | undefined, status: ListenOnceStatus | undefined): "ask" | "home" | null {
  return source && !questionHoldsListen(true, status) ? source : null;
}

/**
 * What went wrong with the speech models' download, in plain words (a proxy's certificate, no network, a full disk…).
 * Never with Ember's name: Hear me more clearly's line says it under its switch while the wake word's microphone may be
 * open, and a screen reader saying "Ember can't reach the download site…" into it woke Ember and sent the rest as a
 * request in 37 of 40 real-model placements (voice-listening-v5-1).
 */
export function downloadHelp(message: string, bytes = VOICE_MODELS_BYTES): string {
  // Each line says what went wrong with the download, or at the site, never "this computer can't…": for a 5xx or a
  // transfer that stalled, the computer had reached github.com (voice-listening-w5-1).
  if (/ERR_CERT_|certificate|self.signed|issuer|SSL|TLS/i.test(message)) {
    return "The download couldn't verify github.com's certificate. If your organisation's network inspects secure traffic, ask IT to add its certificate, or to allow github.com.";
  }
  if (/ERR_PROXY_AUTH|HTTP 407/i.test(message)) return "The network proxy asks for a sign-in before downloads. Ask IT to allow downloads from github.com without one.";
  if (/HTTP 5\d\d/i.test(message)) return "The download site (github.com) had a problem. Try again later.";
  if (/nothing arrived for/i.test(message)) return "The download from github.com stalled. Check the network or proxy, then try again.";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|socket hang up|net::ERR_/i.test(message)) {
    return "The download couldn't reach github.com right now. Check the network or proxy, then try again.";
  }
  if (/HTTP 4\d\d/i.test(message)) return "The download site refused the request. Try again later; if it keeps happening, ask IT whether github.com downloads are blocked.";
  if (/ENOSPC|EDQUOT|no space left|quota exceeded/i.test(message)) return `There isn't enough free disk space for the speech models (about ${Math.round(bytes / 1e6)} MB).`;
  if (/EACCES|EPERM|EROFS|permission denied|read-only/i.test(message)) return "The speech models can't be written to the data folder (permission denied).";
  if (/checksum mismatch/i.test(message)) return "The download arrived damaged or changed, so it wasn't used. Try again; if it keeps happening, something on the network may be altering downloads.";
  // (Not an archive's name in a path, ".download-….tar.bz2": that is a file error, below.)
  if (/(?<!\.)\btar\b/i.test(message)) return "The download couldn't be unpacked. Try again.";
  // Never the raw message (main logs it): a file error carries the data folder's path, …/ember/models, and said into the
  // wake word's microphone that woke Ember (voice-listening-w5-2). EBUSY: on Windows, still held after RENAME_WAIT_MS.
  if (/\b(EBUSY|ENOTEMPTY|EEXIST|ENOENT|EMFILE|ENFILE|EXDEV|EIO|EISDIR|ENOTDIR)\b/.test(message)) {
    return "The download couldn't be saved in the data folder. Try again; if it keeps happening, restart this computer.";
  }
  return "Something went wrong with the download. Try again.";
}

/** The microphone's error in plain words; `hint` says where to allow it when the system refused it. */
export function micHelp(message: string, hint?: string): string {
  if (/NotAllowed|Permission/i.test(message)) return hint ? `Ember wasn't allowed to use the microphone. ${hint}` : "Ember wasn't allowed to use the microphone.";
  if (/NotFound|DevicesNotFound/i.test(message)) return "No microphone was found.";
  if (/NotReadable|TrackStart|AbortError/i.test(message)) return "The microphone is in use by another app or unavailable.";
  return message;
}

/** Session permission checks: only the mic window may use media, audio only. */
export function voicePermissions(voice: () => VoiceService | null): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const v = voice();
    cb(permission === "media" && !!v && v.allowsMedia(wc, (details as { mediaTypes?: string[] }).mediaTypes));
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === "media" && !!wc && !!voice()?.allowsMedia(wc, ["audio"]));
  // System audio for the mic page's level meter (app/renderer/mic/output-watch.ts). Chromium gives it only with a screen's
  // video, which the page stops at once. Anyone else asking gets nothing.
  ses.setDisplayMediaRequestHandler((request, cb) => {
    const page = request.frame ? webContents.fromFrame(request.frame) : null;
    if (!voice()?.allowsOutputLevel(page)) { cb({}); return; }
    desktopCapturer.getSources({ types: ["screen"] }).then(s => cb(s[0] ? { video: s[0], audio: "loopback" } : {}), () => cb({}));
  });
}
