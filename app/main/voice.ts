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

import { app, BrowserWindow, MessageChannelMain, ipcMain, net, session, utilityProcess, type UtilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureModel, ensureModels, forgetModels, LISTENING_MODELS, modelPaths, modelReady, modelsBytes, NATURAL_VOICE, VOICE_MODELS, VOICE_MODELS_BYTES, type Downloader, type ModelFile, type ModelId, type ModelsProgress } from "../voice/models";
import type { ModelPaths } from "../voice/sherpa";
import type { VoiceEvent } from "../voice/engine";
import type { VoiceProcessMessage } from "../voice/process";
import type { TtsProcessMessage, VoiceInfo } from "../voice/tts-process";
import { nativePackage } from "../voice/runtime";
import { NATURAL_COST, NATURAL_MAX_RTF } from "../voice/tts";
import { FrameWatchdog } from "../voice/watchdog";
import { withoutOwnPhrases } from "../voice/spoken";
import { VOICE, type MicState, type MicStatus, type SpeakRequest, type SpeechAudio, type SpeechPlayed } from "../shared/voice";
import type { Logger } from "./logger";
import { pageUrl } from "./page-url";

const appDir = __dirname;
/** A download that sends nothing for this long has stalled (ms). */
const STALL_MS = 30_000;
/** From speak() until speech starts; if it never does (no voices), a follow-up stops waiting for it (ms). */
const SPEECH_START_MS = 3000;
/** The same while Ember's own voice is still loading (its first reply: 1–2.5 s to load, then its first sentence; ms). */
const VOICE_START_MS = 8000;
/** Ember's own voice failing this many times (it stopped, or couldn't say a reply) leaves replies to the system's voice until Ember restarts. */
const VOICE_FAILURES = 3;
/** Longest Ember counts as speaking without hearing so again (the mic window repeats it while it speaks; ms). */
const SPEAKING_MAX_MS = 60_000;
/** A request heard this soon after a cancel (the kill switch) was already on its way: it's dropped (ms). */
const CANCEL_GRACE_MS = 1000;
/** Listening that broke starts again after 1 s, 5 s, then every 30 s (ms). */
const RESTART_MS = [1000, 5000, 30_000];
/**
 * A ready voice process that says nothing for this long is stuck or suspended (it says it's alive every second; its
 * longest piece of work, 21 s of speech to transcribe, took 1.4 s as measured; ms).
 */
const ALIVE_MS = 15_000;
/** What the voice line says while the screen is locked (review #81). */
const LOCKED_TEXT = "Not listening while the screen is locked.";
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
  onEvent: (e: VoiceEvent) => void;
  onState: (s: MicState, detail?: string) => void;
  /** A reply was heard (true), or no voice spoke (false): the speaking page tells it when that changes (review #101). */
  onSpeech?: (ok: boolean) => void;
  /** Speak in Ember's own neural voice once its model is in (app/voice/tts.ts); otherwise always the system's voice. */
  neuralVoice?: boolean;
  /**
   * The user turned on the natural voice (Kokoro, models.ts NATURAL_VOICE): it is fetched in the background and
   * speaks where speech runs natively and the Piper voice shows this computer is fast enough for it. Changed later
   * with setNaturalVoice.
   */
  naturalVoice?: boolean;
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
  /** Enrolment's progress (Voice Match); at "done", `print` is the voiceprint to keep. */
  onEnrol?: (e: EnrolProgress) => void;
  /** Which models are in changed (a download finished, one turned out damaged): settings shows it. */
  onModels?: () => void;
}

/** What settings shows of enrolment: phrases kept so far, and whether the last must be said again (and why). */
export type EnrolProgress = Extract<VoiceProcessMessage, { type: "enrol" }>;

/** Downloads with Chromium's network stack (system proxy settings apply). A stalled connection fails, so "Downloading…" can't stay up forever. */
export const electronDownloader: Downloader = async (url, dest, progress) => {
  const ac = new AbortController();
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
    throw ac.signal.aborted ? new Error(`nothing arrived for ${STALL_MS / 1000} seconds (check the network or proxy)`) : err;
  } finally {
    clearTimeout(timer);
  }
};

/** A hidden window that only speaks (its page, the sender to recognize it by, and whether it's speaking). */
type Speaker = { win: BrowserWindow; wc: Electron.WebContents; loaded: Promise<void>; saying: boolean };
/** Sends to the page that speaks a reply (the same one for all of it, should listening start or stop meanwhile). */
type PageSend = (channel: string, payload: unknown) => void;

export class VoiceService {
  private proc: UtilityProcess | null = null;
  private mic: BrowserWindow | null = null;
  /** Speaks replies while listening is off (loaded on first use; it never opens the microphone). */
  private speaker: Speaker | null = null;
  private state: MicState = "off";
  private muted = false;
  private wanted = false;
  /** The screen is locked: no listening and no speech until it's unlocked. */
  private locked = false;
  private downloading: Promise<void> | null = null;
  /** Until when Ember is speaking, or about to: a follow-up window waits until it's done. */
  private speakingUntil = 0;
  /** A follow-up window (ms) waiting for Ember to finish speaking, its timer, and whether the answer asked something. */
  private followUpMs = 0;
  private followUpAsked = false;
  private followUpTimer: NodeJS.Timeout | null = null;
  private cancelledAt = Number.NEGATIVE_INFINITY;
  /** The microphone went away and the mic page is getting it back (its frames stop meanwhile). */
  private micLost = false;
  /** The microphone sends only digital silence (the voice line says so until sound comes back). */
  private micSilent = false;
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
  private ttsFailures = 0;
  /** Replies are numbered; those up to `ttsHushed` were hushed (their late audio is dropped). */
  private ttsId = 0;
  private ttsHushed = 0;
  /** Replies given to Ember's voice and not yet done: their words (for the system's voice, should it fail) and their page. */
  private ttsPending = new Map<number, { text: string; send: PageSend }>();
  /** Enrolment (Voice Match) is under way in the voice process. */
  private enrolling = false;
  /** The voice and speech processes run on WebAssembly: one died loading natively (reset when the models change). */
  private wasmOnly = { voice: false, speech: false };
  /**
   * The natural voice: being fetched, or not to be used this session (it was too slow here, or couldn't be fetched);
   * `switchVoice`: fetched, so the speech process starts again with it once it has nothing left to say.
   */
  private naturalFetch: Promise<void> | null = null;
  /** The natural voice is wanted (the setting). */
  private naturalWanted: boolean;
  private naturalOff = false;
  private switchVoice = false;
  /** Whether the log last said that Ember speaks (voice.self_speaking). */
  private saidSpeaking = false;

  constructor(private o: VoiceOptions) {
    this.naturalWanted = !!o.naturalVoice;
    this.bundledRoot = o.bundled ? o.modelsRoot : null;
    this.userRoot = o.bundled?.userRoot ?? o.modelsRoot;
    ipcMain.on(VOICE.status, (e, s: MicStatus) => {
      if (!this.mic || e.sender !== this.mic.webContents) return;
      if (s.state === "error") { this.o.log.error("voice.mic_error", { message: s.message }); this.setState("error", micHelp(s.message, this.o.micHint)); this.teardown(); }
      else if (s.state === "lost") { this.o.log.warn("voice.mic_lost", { message: s.message }); this.micLost = true; this.setState("error", `${micHelp(s.message, this.o.micHint)} Trying again…`); }
      else {
        this.o.log.info("voice.mic", { device: s.device, rate: s.rate, context: s.context });
        if (this.micLost) { this.micLost = false; this.setState("waiting"); }
      }
    });
    ipcMain.on(VOICE.speech, (e, ok: unknown) => {
      if (!(this.mic && e.sender === this.mic.webContents) && e.sender !== this.speaker?.wc) return;
      this.o.onSpeech?.(ok === true);
    });
    ipcMain.on(VOICE.played, (e, p: SpeechPlayed) => {
      const page = this.mic && e.sender === this.mic.webContents ? "mic" : e.sender === this.speaker?.wc ? "speaker" : null;
      if (page) this.o.log.info("voice.audio_played", { id: Number(p?.id), seconds: Number(p?.seconds), page });
    });
    ipcMain.on(VOICE.speaking, (e, on: boolean) => {
      if (!(this.mic && e.sender === this.mic.webContents) && e.sender !== this.speaker?.wc) return;
      // (Repeated every 20 s while it lasts: the voice process is told each time, the log only when it changes.)
      if (!!on !== this.saidSpeaking) { this.saidSpeaking = !!on; this.o.log.info("voice.self_speaking", { on: !!on, listening: !!this.proc }); }
      this.proc?.postMessage({ type: "self-speaking", on: !!on });
      this.speakingUntil = on ? Date.now() + SPEAKING_MAX_MS : 0;
      if (this.speaker && e.sender === this.speaker.wc) {
        this.speaker.saying = !!on;
        // Listening started while it spoke: the mic window speaks from now on.
        if (!on && this.mic) this.closeSpeaker();
      }
      this.openFollowUp();
    });
  }

  get micState(): MicState {
    return this.state;
  }

  /**
   * Ember listens and can tell its own voice (and the speakers') from the user's: the speakers' stream is arriving, so
   * a wake or stop phrase it says itself is rejected. False while not listening, and wherever speaker rejection doesn't
   * run (Windows, macOS, Linux without parec): Ember then never says those phrases (owner decision V1, review #251), and
   * a call, a video or Ember's own voice can say a request, so words heard then never count as asking for a dangerous
   * command (review #252).
   */
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

  /** Which folder model `id` is used from: the one that came with Ember, else the user's own; null when in neither. */
  private rootOf(id: ModelId): string | null {
    if (this.bundledRoot && !this.notBundled.has(id) && modelReady(this.bundledRoot, id)) return this.bundledRoot;
    return modelReady(this.userRoot, id) ? this.userRoot : null;
  }

  /** Each model's path, from the folder it is used from (the user's own for one that isn't in anywhere). */
  private paths(): ModelPaths {
    const at = (id: ModelId) => modelPaths(this.rootOf(id) ?? this.userRoot)[id];
    return { kws: at("kws"), vad: at("vad"), asr: at("asr"), tts: at("tts"), speaker: at("speaker"), natural: at("natural") };
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
    this.wanted = on;
    if (!on) { this.cancelRetry(); this.teardown(); this.setState("off"); return; }
    await this.start();
  }

  setMuted(on: boolean): void {
    this.muted = on;
    if (on) { this.cancelRetry(); this.teardown(); this.setState("muted"); } else void this.start();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * The screen locked, or this session isn't the one in front (review #81): no listening and no speech until it's back,
   * so nobody in the room talks to Ember (the wake word isn't the user's alone) or hears it read out the user's apps.
   */
  setLocked(on: boolean): void {
    if (on === this.locked) return;
    this.locked = on;
    if (!on) { void this.start(); return; }
    this.hush();
    this.cancelRetry();
    this.teardown();
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
      this.downloading = ensureModels(this.userRoot, electronDownloader, progress, ids)
        .then(() => {
          this.o.log.info("voice.models_ready", { models: ids, bytes: modelsBytes(missing) });
          for (const id of ids) this.notBundled.delete(id); // (the user's own copy is used: it verified)
          if (ids.includes("tts")) this.ttsFailures = 0;
          // New models: the native build is tried again (one that died loading may have died on a damaged model).
          this.wasmOnly = { voice: false, speech: false };
        })
        .catch((err: unknown) => {
          // Never left on "Downloading…": back to what it was, saying why (the download button offers a retry).
          const message = err instanceof Error ? err.message : String(err);
          this.o.log.warn("voice.download_failed", { message });
          const detail = `Couldn't download the speech models. ${downloadHelp(message, modelsBytes(missing))}`;
          this.setState(this.state !== "downloading" ? this.state : !this.wanted ? "off" : this.muted ? "muted" : "needs-models", detail);
          throw err;
        })
        .finally(() => { this.downloading = null; this.o.onModels?.(); });
      this.o.onModels?.(); // (settings hides the button and shows the download's progress)
    }
    await this.downloading;
    // Voice Match's model came in while listening: a kept voiceprint is used from now on.
    if (this.proc) this.setVoiceprint(this.o.voiceprint?.() ?? null);
    if (this.wanted) await this.start();
    else if (this.state === "downloading") this.setState("off");
  }

  /**
   * A follow-up window (no wake word needed). It opens once Ember has finished speaking its answer, or it would hear
   * itself. `afterQuestion`: the answer asked something, so "Okay." or "Fine." is a reply to send (not "that's all").
   */
  followUp(ms = 8000, o: { afterQuestion?: boolean } = {}): void {
    this.followUpMs = ms;
    this.followUpAsked = !!o.afterQuestion;
    this.openFollowUp();
  }

  private openFollowUp(): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
    if (!this.followUpMs) return;
    const wait = this.speakingUntil - Date.now();
    if (wait > 0) { this.followUpTimer = setTimeout(() => this.openFollowUp(), wait); return; }
    if (this.proc) this.o.log.info("voice.follow_up", { ms: this.followUpMs, afterQuestion: this.followUpAsked });
    this.proc?.postMessage({ type: "follow-up", ms: this.followUpMs, ...(this.followUpAsked ? { afterQuestion: true } : {}) });
    this.followUpMs = 0;
  }

  private dropFollowUp(): void {
    this.followUpMs = 0;
    this.openFollowUp();
  }

  /**
   * Voice Match: starts enrolment (the owner's phrases; nothing heard meanwhile is a request). False when Ember isn't
   * listening (enrolment needs the microphone) or its voiceprint model isn't there.
   */
  enrol(): boolean {
    if (!this.proc || !this.readyAt || !this.matchReady) return false;
    this.enrolling = true;
    this.proc.postMessage({ type: "enrol" });
    return true;
  }

  cancelEnrol(): void {
    if (!this.enrolling) return;
    this.enrolling = false;
    this.proc?.postMessage({ type: "enrol-cancel" });
  }

  /**
   * Voice Match turned on (the owner's voiceprint) or off (null): the voice process checks requests from now on, or
   * doesn't. Without its model, it stays off.
   */
  setVoiceprint(print: string | null): void {
    this.proc?.postMessage({ type: "voiceprint", print: this.matchReady ? print : null });
  }

  /** Stops listening for a request at once (the kill switch): a wake being checked, a waiting follow-up and a request already on its way are dropped. */
  cancelListening(): void {
    this.cancelledAt = Date.now();
    this.dropFollowUp();
    this.proc?.postMessage({ type: "cancel" });
  }

  /**
   * Says `text` (plain words: spokenText). `append`: after what Ember is saying (the next sentences of an answer that is
   * still streaming), instead of cutting it off.
   */
  speak(text: string, o: { append?: boolean } = {}): void {
    if (this.locked || !text.trim()) return;
    // Listening without the speakers' stream, the microphone would take Ember's own "Ember, stop" for the user's.
    if (this.mic && !this.rejectsSpeakers) text = withoutOwnPhrases(text);
    const neural = this.neuralVoice;
    if (neural && !o.append) this.hush();
    this.speakingUntil = Math.max(this.speakingUntil, Date.now() + (neural && !this.tts?.ready ? VOICE_START_MS : SPEECH_START_MS));
    const send = this.pageSend();
    if (!neural) { send(VOICE.speak, { text, ...(o.append ? { append: true } : {}) } satisfies SpeakRequest); return; }
    const id = ++this.ttsId;
    this.ttsPending.set(id, { text, send });
    this.voiceProcess().postMessage({ type: "say", id, text });
  }

  /**
   * The natural voice turned on or off (the setting): the speech process starts again once it has nothing left to say,
   * with Kokoro (fetched first, where this computer is fast enough for it) or without.
   */
  setNaturalVoice(on: boolean): void {
    if (on === this.naturalWanted) return;
    this.naturalWanted = on;
    this.naturalOff = false;
    this.o.log.info("voice.natural_wanted", { on });
    this.switchVoice = true;
    this.switchWhenIdle();
  }

  hush(): void {
    this.speakingUntil = 0;
    if (this.ttsId > this.ttsHushed) {
      this.ttsHushed = this.ttsId;
      this.ttsPending.clear();
      this.tts?.proc.postMessage({ type: "hush", id: this.ttsHushed });
    }
    for (const w of [this.mic, this.speaker?.win]) if (w && !w.isDestroyed()) w.webContents.send(VOICE.hush);
  }

  /**
   * Loads Ember's voice ahead of its first reply (2 s or so), once someone has called Ember: until then it costs no
   * memory. It stays loaded from then on.
   */
  warmVoice(): void {
    if (this.neuralVoice && !this.locked) this.voiceProcess();
  }

  /** Whether replies are said in Ember's own voice: wanted, its model is in, and it hasn't kept failing. */
  private get neuralVoice(): boolean {
    return !!this.o.neuralVoice && this.ttsFailures < VOICE_FAILURES && this.rootOf("tts") !== null;
  }

  /** The page that speaks now: the mic window while listening, otherwise one that only speaks (listening is off). */
  private pageSend(): PageSend {
    const mic = this.mic;
    if (mic && !mic.isDestroyed()) return (channel, payload) => { if (!mic.isDestroyed()) mic.webContents.send(channel, payload); };
    const s = this.speakerWindow();
    return (channel, payload) => {
      s.loaded.then(() => { if (!s.win.isDestroyed()) s.win.webContents.send(channel, payload); }, (err: unknown) => this.o.log.warn("voice.speaker_failed", { message: String(err) }));
    };
  }

  /** Speech can run natively here (runtime.ts). */
  private get native(): boolean {
    return this.o.native ?? nativePackage() !== null;
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
      if (!tts.ready && this.native && !this.wasmOnly.speech) {
        // It died loading, natively: started again on WebAssembly, with what it had to say.
        this.o.log.warn("voice.tts_native_failed", { code });
        this.wasmOnly.speech = true;
        this.tts = null;
        const next = this.voiceProcess();
        for (const [id, p] of this.ttsPending) next.postMessage({ type: "say", id, text: p.text });
        return;
      }
      this.o.log.warn("voice.tts_exit", { code });
      this.ttsFailures++;
      this.voiceFailed();
    });
    proc.on("message", (m: TtsProcessMessage) => {
      if (this.tts !== tts) return;
      if (m.type === "ready") { tts.ready = true; this.voiceReady(m.loadMs, m.rate, m.voice); return; }
      if (m.type === "error") { this.o.log.error("voice.tts_error", { message: m.message }); this.ttsFailures = VOICE_FAILURES; this.voiceFailed(); return; }
      const pending = this.ttsPending.get(m.id);
      if (m.id <= this.ttsHushed || !pending) return;
      if (m.type === "audio") { pending.send(VOICE.audio, { id: m.id, samples: m.samples, rate: m.rate } satisfies SpeechAudio); return; }
      if (m.type === "failed") { this.o.log.warn("voice.tts_failed", { message: m.message }); this.ttsFailures++; }
      this.ttsPending.delete(m.id);
      pending.send(VOICE.audioDone, m.id);
      this.switchWhenIdle();
    });
    const natural = this.naturalWanted && this.native && !this.naturalOff && this.rootOf("natural") !== null ? this.paths().natural : null;
    proc.postMessage({ type: "init", model: this.paths().tts, natural, ...(this.wasmOnly.speech ? { wasm: true } : {}) });
    return proc;
  }

  /**
   * Ember's voice loaded: which voice, on which build and how fast (logged). Where it runs natively on the Piper voice
   * fast enough for the natural voice, that is fetched (once a session).
   */
  private voiceReady(loadMs: number, rate: number, v: VoiceInfo | undefined): void {
    this.o.log.info("voice.tts_ready", { loadMs, rate, ...(v ? { voice: v.voice, backend: v.backend, detail: v.detail, provider: v.provider, threads: v.threads, rtf: v.rtf, tried: v.tried, natural: v.natural } : {}) });
    if (!v || !this.naturalWanted || this.naturalFetch || this.naturalOff) return;
    // Downloaded, but too slow here or it wouldn't load: the Piper voice speaks for the rest of the session.
    if (v.natural) { this.naturalOff = true; return; }
    if (v.backend !== "native" || v.voice !== "piper" || v.rtf === undefined) return;
    if (v.rtf * NATURAL_COST > NATURAL_MAX_RTF) {
      this.o.log.info("voice.natural_skipped", { rtf: v.rtf, needs: Math.round((NATURAL_MAX_RTF / NATURAL_COST) * 1000) / 1000 });
      this.naturalOff = true;
      return;
    }
    if (this.rootOf("natural") !== null) return;
    this.o.log.info("voice.natural_fetching", { rtf: v.rtf, bytes: NATURAL_VOICE.bytes });
    // Into the user's own models folder (one that came with Ember is never changed).
    this.naturalFetch = ensureModel(this.userRoot, NATURAL_VOICE, this.o.downloader ?? electronDownloader)
      .then(() => { this.o.log.info("voice.natural_ready", { root: this.userRoot }); this.switchVoice = true; this.switchWhenIdle(); })
      .catch((err: unknown) => { this.naturalOff = true; this.o.log.warn("voice.natural_download_failed", { message: err instanceof Error ? err.message : String(err) }); });
  }

  /** The natural voice was fetched: the speech process stops once it has nothing to say, and the next reply starts it with that voice. */
  private switchWhenIdle(): void {
    if (!this.switchVoice || !this.tts || this.ttsPending.size) return;
    this.switchVoice = false;
    const t = this.tts;
    this.tts = null;
    t.proc.removeAllListeners("exit");
    t.proc.kill();
  }

  /**
   * Ember's voice stopped or couldn't load: the replies it hadn't finished are said by the system's voice (from where
   * they were: a reply it had begun is said whole), and the next reply starts it again, unless it keeps failing.
   */
  private voiceFailed(): void {
    const tts = this.tts;
    this.tts = null;
    if (tts) { tts.proc.removeAllListeners("exit"); tts.proc.kill(); }
    const pending = [...this.ttsPending.entries()];
    this.ttsPending.clear();
    for (const [id, p] of pending) {
      p.send(VOICE.audioDone, id);
      p.send(VOICE.speak, { text: p.text, append: true } satisfies SpeakRequest);
    }
  }

  private speakerWindow(): Speaker {
    if (this.speaker && !this.speaker.win.isDestroyed()) return this.speaker;
    // The mic page without its audio port: it speaks, and never asks for the microphone.
    const win = hiddenWindow("Ember speech");
    this.speaker = { win, wc: win.webContents, loaded: win.loadURL(pageUrl(path.join(appDir, "renderer", "mic", "index.html"))), saying: false };
    return this.speaker;
  }

  private async start(): Promise<void> {
    if (!this.wanted || this.proc) return;
    this.cancelRetry();
    if (this.muted) { this.setState("muted"); return; }
    if (this.locked) { this.setState("off", LOCKED_TEXT); return; }
    if (!this.modelsReady) { this.setState(this.downloading ? "downloading" : "needs-models"); return; }
    this.setState("starting");
    this.readyAt = 0;
    this.micLost = false;
    this.micSilent = false;
    this.monitorOn = false;
    const proc = utilityProcess.fork(path.join(appDir, "voice.cjs"), [], { serviceName: "Ember voice", stdio: "pipe" });
    this.proc = proc;
    proc.stderr?.on("data", (d: Buffer) => this.o.log.debug("voice.stderr", { line: d.toString().slice(0, 300) }));
    proc.on("exit", code => {
      if (this.proc !== proc) return;
      if (!this.readyAt && this.native && !this.wasmOnly.voice) {
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
        this.o.log.info("voice.ready", { loadMs: m.loadMs, ...(b ? { backend: b.backend, detail: b.detail, provider: b.provider, threads: b.threads, tried: b.tried } : {}) });
        this.readyAt = Date.now(); this.watchAlive(proc); this.setState("waiting"); return;
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
          this.wasmOnly = { voice: false, speech: false };
          if (this.modelsReady) void this.start(); // the user's own copy is there: it's tried
          else this.setState("needs-models", "The speech models look damaged. Download them again.");
          return;
        }
        this.setState("error", m.message);
        return;
      }
      if (m.type === "enrol") { this.enrolling = m.state !== "done" && m.state !== "cancelled"; this.o.onEnrol?.(m); return; }
      if (m.type === "voice-match-error") { this.o.log.warn("voice.match_error", { message: m.message }); return; }
      if (m.type === "stats") { this.o.log.info("voice.cpu", { percent: Math.round((m.cpuMs / m.audioMs) * 1000) / 10, audioMs: m.audioMs, peak: m.peak }); return; }
      // The recognizers failed on some audio; the process carried on (it heard nothing in that audio).
      if (m.type === "engine-error") { this.o.log.warn("voice.engine_error", { message: m.message, count: m.count }); return; }
      // They keep failing (unusable until loaded again): started again, with the backoff.
      if (m.type === "engine-broken") { this.o.log.error("voice.engine_broken", { message: m.message }); this.restartLater("The speech recognizer kept failing."); return; }
      if (m.type === "monitor") { this.monitorOn = m.on; this.o.log.info("voice.speaker_rejection", { on: m.on, reason: m.reason }); return; }
      if (m.type === "silent") {
        // Frames still arrive (the watchdog is content), but nothing can be heard in them: said, not restarted.
        this.o.log.warn("voice.silent", { on: m.on });
        const was = this.micSilent;
        this.micSilent = m.on;
        if (m.on) this.setState("error", SILENT_TEXT);
        else if (was && this.state === "error") this.setState("waiting"); // (not another error, such as a lost microphone)
        return;
      }
      if (m.type === "stalled") {
        // The mic page says when it lost the microphone (and gets it back itself); otherwise audio just stopped.
        if (!this.micLost) { this.o.log.warn("voice.stalled", { ms: m.ms }); this.restartLater("No sound is arriving from the microphone."); }
        return;
      }
      if (m.type === "utterance" && Date.now() - this.cancelledAt < CANCEL_GRACE_MS) { this.o.log.info("voice.dropped", { reason: "cancelled" }); return; }
      if (m.type === "wake") { this.o.log.info("voice.wake", { keyword: m.keyword }); this.dropFollowUp(); this.warmVoice(); } // a new request: the old answer's follow-up is moot
      if (m.type === "stop") this.o.log.info("voice.stop");
      if (m.type === "listening") this.setState(m.on ? "active" : "waiting");
      if (m.type === "rejected") this.o.log.info("voice.rejected", { keyword: m.keyword, reason: m.reason, ...(m.score !== undefined ? { score: m.score } : {}) });
      this.o.log.debug("voice.event", { type: m.type });
      this.o.onEvent(m);
    });
    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ type: "init", models: this.paths(), monitor: this.o.monitor, dev: !app.isPackaged, voiceprint: this.voiceprint(), ...(this.wasmOnly.voice ? { wasm: true } : {}) }, [port1]);

    this.mic = hiddenWindow("Ember microphone");
    const mic = this.mic;
    // The mic window speaks from now on: the speech-only window isn't needed (once it has finished).
    if (!this.speaker?.saying) this.closeSpeaker();
    mic.webContents.on("render-process-gone", (_e, d) => {
      if (this.mic === mic) { this.o.log.warn("voice.mic_gone", { reason: d.reason }); this.restartLater("The microphone page stopped."); }
    });
    await mic.loadURL(pageUrl(path.join(appDir, "renderer", "mic", "index.html"))).catch(() => undefined);
    if (mic.isDestroyed() || this.mic !== mic) return;
    mic.webContents.postMessage(VOICE.port, null, [port2]);
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
    if (mic && !mic.isDestroyed()) mic.destroy();
  }

  private teardown(): void {
    this.enrolling = false;
    this.closeMic();
    this.dropFollowUp();
    this.stopWatchingAlive();
    this.monitorOn = false;
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    p.kill();
    // Not started yet (no pid): kill() does nothing then, and with its handle dropped the process would live on, models
    // loaded, until Ember quits. It goes as soon as it has started (review #256).
    if (p.pid === undefined) p.once("spawn", () => p.kill());
  }

  stop(): void {
    this.wanted = false;
    this.cancelRetry();
    this.teardown();
    this.closeSpeaker();
    const tts = this.tts;
    this.tts = null;
    this.ttsPending.clear();
    tts?.proc.kill();
  }

  private closeSpeaker(): void {
    const s = this.speaker;
    this.speaker = null;
    if (s && !s.win.isDestroyed()) s.win.destroy();
  }

  private setState(s: MicState, detail?: string): void {
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

/** What went wrong with the speech models' download, in plain words (a proxy's certificate, no network, a full disk…). */
export function downloadHelp(message: string, bytes = VOICE_MODELS_BYTES): string {
  if (/ERR_CERT_|certificate|self.signed|issuer|SSL|TLS/i.test(message)) {
    return "Ember can't verify the download site's certificate. If your organisation's network inspects secure traffic, ask IT to add its certificate, or to allow github.com.";
  }
  if (/ERR_PROXY_AUTH|HTTP 407/i.test(message)) return "The network proxy asked for a sign-in Ember can't give. Ask IT to allow github.com for Ember.";
  if (/nothing arrived for|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|socket hang up|net::ERR_|HTTP 5\d\d/i.test(message)) {
    return "Ember can't reach the download site (github.com) right now. Check the network or proxy, then try again.";
  }
  if (/HTTP 4\d\d/i.test(message)) return "The download site refused the request. Try again later; if it keeps happening, ask IT whether github.com downloads are blocked.";
  if (/ENOSPC|no space left/i.test(message)) return `There isn't enough free disk space for the speech models (about ${Math.round(bytes / 1e6)} MB).`;
  if (/EACCES|EPERM|EROFS|permission denied|read-only/i.test(message)) return "Ember can't write the speech models to its data folder (permission denied).";
  if (/checksum mismatch/i.test(message)) return "The download arrived damaged or changed, so it wasn't used. Try again; if it keeps happening, something on the network may be altering downloads.";
  if (/\btar\b/i.test(message)) return "The download couldn't be unpacked. Try again.";
  return message;
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
}
