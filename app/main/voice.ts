/**
 * VoiceService: the microphone window, the voice process and the models.
 * The mic is opened only when the user turned listening on, agreed to it,
 * the models are verified and Ember isn't muted; muting closes the stream,
 * which releases the microphone (GNOME's mic indicator goes away).
 * Replies are spoken from the mic window, or, while listening is off, from a
 * hidden window that never opens the mic. The browser's echo cancellation
 * doesn't remove them (speech-dispatcher plays outside Chromium): the voice
 * process is told while Ember speaks and doesn't take what it hears then as a
 * request.
 */

import { app, BrowserWindow, MessageChannelMain, ipcMain, net, session, utilityProcess, type UtilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureModels, forgetModels, modelPaths, modelsReady, VOICE_MODELS_BYTES, type Downloader, type ModelsProgress } from "../voice/models";
import type { VoiceEvent } from "../voice/engine";
import type { VoiceProcessMessage } from "../voice/process";
import { FrameWatchdog } from "../voice/watchdog";
import { VOICE, type MicState, type MicStatus } from "../shared/voice";
import type { Logger } from "./logger";

const appDir = __dirname;
/** A download that sends nothing for this long has stalled (ms). */
const STALL_MS = 30_000;
/** From speak() until speech starts; if it never does (no voices), a follow-up stops waiting for it (ms). */
const SPEECH_START_MS = 3000;
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
/** What the voice line says while the microphone sends only digital silence (review #255). */
const SILENT_TEXT = "The microphone is sending only silence. Check that the right microphone is chosen, and not muted, in the sound settings.";

export interface VoiceOptions {
  log: Logger;
  modelsRoot: string;
  /** Speaker-output rejection (needs parec). */
  monitor: boolean;
  /**
   * Where the user allows Ember the microphone when the system refused it (Windows Settings, macOS System Settings),
   * added to that refusal's text. Absent on Linux, where nothing asks first.
   */
  micHint?: string;
  onEvent: (e: VoiceEvent) => void;
  onState: (s: MicState, detail?: string) => void;
}

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

export class VoiceService {
  private proc: UtilityProcess | null = null;
  private mic: BrowserWindow | null = null;
  /** Speaks replies while listening is off (loaded on first use; it never opens the microphone). */
  private speaker: Speaker | null = null;
  private state: MicState = "off";
  private muted = false;
  private wanted = false;
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
  /** Starting again after listening broke: the timer, how many times in a row, and when the current process got ready. */
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;
  private readyAt = 0;
  /** Whether the ready voice process still answers: what it last sent, checked every second (review #257). */
  private alive: { watch: FrameWatchdog; timer: NodeJS.Timeout } | null = null;

  constructor(private o: VoiceOptions) {
    ipcMain.on(VOICE.status, (e, s: MicStatus) => {
      if (!this.mic || e.sender !== this.mic.webContents) return;
      if (s.state === "error") { this.o.log.error("voice.mic_error", { message: s.message }); this.setState("error", micHelp(s.message, this.o.micHint)); this.teardown(); }
      else if (s.state === "lost") { this.o.log.warn("voice.mic_lost", { message: s.message }); this.micLost = true; this.setState("error", `${micHelp(s.message, this.o.micHint)} Trying again…`); }
      else {
        this.o.log.info("voice.mic", { device: s.device, rate: s.rate, context: s.context });
        if (this.micLost) { this.micLost = false; this.setState("waiting"); }
      }
    });
    ipcMain.on(VOICE.speaking, (e, on: boolean) => {
      if (!(this.mic && e.sender === this.mic.webContents) && e.sender !== this.speaker?.wc) return;
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

  get modelsReady(): boolean {
    return modelsReady(this.o.modelsRoot);
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

  /** Rejects if the download fails; the state has then already gone back (with what went wrong as its detail). */
  async downloadModels(progress: ModelsProgress): Promise<void> {
    if (!this.downloading && !this.modelsReady) {
      this.setState("downloading");
      this.downloading = ensureModels(this.o.modelsRoot, electronDownloader, progress)
        .then(() => { this.o.log.info("voice.models_ready", { bytes: VOICE_MODELS_BYTES }); })
        .catch((err: unknown) => {
          // Never left on "Downloading…": back to what it was, saying why (the download button offers a retry).
          const message = err instanceof Error ? err.message : String(err);
          this.o.log.warn("voice.download_failed", { message });
          this.setState(!this.wanted ? "off" : this.muted ? "muted" : "needs-models", `Couldn't download the speech models. ${downloadHelp(message)}`);
          throw err;
        })
        .finally(() => { this.downloading = null; });
    }
    await this.downloading;
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
    this.proc?.postMessage({ type: "follow-up", ms: this.followUpMs, ...(this.followUpAsked ? { afterQuestion: true } : {}) });
    this.followUpMs = 0;
  }

  private dropFollowUp(): void {
    this.followUpMs = 0;
    this.openFollowUp();
  }

  /** Stops listening for a request at once (the kill switch): a wake being checked, a waiting follow-up and a request already on its way are dropped. */
  cancelListening(): void {
    this.cancelledAt = Date.now();
    this.dropFollowUp();
    this.proc?.postMessage({ type: "cancel" });
  }

  speak(text: string): void {
    this.speakingUntil = Math.max(this.speakingUntil, Date.now() + SPEECH_START_MS);
    if (this.mic && !this.mic.isDestroyed()) { this.mic.webContents.send(VOICE.speak, text); return; }
    // Listening is off: "Speak replies" still works, from a window that only speaks.
    const s = this.speakerWindow();
    s.loaded.then(() => { if (!s.win.isDestroyed()) s.win.webContents.send(VOICE.speak, text); }, (err: unknown) => this.o.log.warn("voice.speaker_failed", { message: String(err) }));
  }

  hush(): void {
    this.speakingUntil = 0;
    for (const w of [this.mic, this.speaker?.win]) if (w && !w.isDestroyed()) w.webContents.send(VOICE.hush);
  }

  private speakerWindow(): Speaker {
    if (this.speaker && !this.speaker.win.isDestroyed()) return this.speaker;
    // The mic page without its audio port: it speaks, and never asks for the microphone.
    const win = hiddenWindow("Ember speech");
    this.speaker = { win, wc: win.webContents, loaded: win.loadFile(path.join(appDir, "renderer", "mic", "index.html")), saying: false };
    return this.speaker;
  }

  private async start(): Promise<void> {
    if (!this.wanted || this.proc) return;
    this.cancelRetry();
    if (this.muted) { this.setState("muted"); return; }
    if (!this.modelsReady) { this.setState(this.downloading ? "downloading" : "needs-models"); return; }
    this.setState("starting");
    this.readyAt = 0;
    this.micLost = false;
    this.micSilent = false;
    const proc = utilityProcess.fork(path.join(appDir, "voice.cjs"), [], { serviceName: "Ember voice", stdio: "pipe" });
    this.proc = proc;
    proc.stderr?.on("data", (d: Buffer) => this.o.log.debug("voice.stderr", { line: d.toString().slice(0, 300) }));
    proc.on("exit", code => {
      if (this.proc === proc) { this.o.log.warn("voice.exit", { code }); this.restartLater("The voice process stopped."); }
    });
    proc.on("message", (m: VoiceProcessMessage) => {
      if (this.proc !== proc) return; // a process being replaced: only the current one speaks for the mic
      this.alive?.watch.frame();
      if (m.type === "alive") return;
      if (m.type === "ready") { this.o.log.info("voice.ready", { loadMs: m.loadMs }); this.readyAt = Date.now(); this.watchAlive(proc); this.setState("waiting"); return; }
      if (m.type === "error") {
        this.o.log.error("voice.error", { message: m.message, models: !!m.models });
        this.teardown();
        // Models that won't load are damaged: they count as missing from now, and settings offers the download again.
        if (m.models) {
          if (forgetModels(this.o.modelsRoot)) this.setState("needs-models", "The speech models look damaged. Download them again.");
          else this.setState("error", "The speech models look damaged, and Ember can't replace them. Reinstall Ember's speech models.");
          return;
        }
        this.setState("error", m.message);
        return;
      }
      if (m.type === "stats") { this.o.log.info("voice.cpu", { percent: Math.round((m.cpuMs / m.audioMs) * 1000) / 10, audioMs: m.audioMs, peak: m.peak }); return; }
      // The recognizers failed on some audio; the process carried on (it heard nothing in that audio).
      if (m.type === "engine-error") { this.o.log.warn("voice.engine_error", { message: m.message, count: m.count }); return; }
      if (m.type === "monitor") { this.o.log.info("voice.speaker_rejection", { on: m.on, reason: m.reason }); return; }
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
      if (m.type === "wake") this.dropFollowUp(); // a new request: the old answer's follow-up is moot
      if (m.type === "listening") this.setState(m.on ? "active" : "waiting");
      if (m.type === "rejected") this.o.log.info("voice.rejected", { keyword: m.keyword, reason: m.reason });
      this.o.log.debug("voice.event", { type: m.type });
      this.o.onEvent(m);
    });
    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ type: "init", models: modelPaths(this.o.modelsRoot), monitor: this.o.monitor, dev: !app.isPackaged }, [port1]);

    this.mic = hiddenWindow("Ember microphone");
    const mic = this.mic;
    // The mic window speaks from now on: the speech-only window isn't needed (once it has finished).
    if (!this.speaker?.saying) this.closeSpeaker();
    mic.webContents.on("render-process-gone", (_e, d) => {
      if (this.mic === mic) { this.o.log.warn("voice.mic_gone", { reason: d.reason }); this.restartLater("The microphone page stopped."); }
    });
    await mic.loadFile(path.join(appDir, "renderer", "mic", "index.html")).catch(() => undefined);
    if (mic.isDestroyed() || this.mic !== mic) return;
    mic.webContents.postMessage(VOICE.port, null, [port2]);
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
    this.closeMic();
    this.dropFollowUp();
    this.stopWatchingAlive();
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
export function downloadHelp(message: string): string {
  if (/ERR_CERT_|certificate|self.signed|issuer|SSL|TLS/i.test(message)) {
    return "Ember can't verify the download site's certificate. If your organisation's network inspects secure traffic, ask IT to add its certificate, or to allow github.com.";
  }
  if (/ERR_PROXY_AUTH|HTTP 407/i.test(message)) return "The network proxy asked for a sign-in Ember can't give. Ask IT to allow github.com for Ember.";
  if (/nothing arrived for|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|socket hang up|net::ERR_|HTTP 5\d\d/i.test(message)) {
    return "Ember can't reach the download site (github.com) right now. Check the network or proxy, then try again.";
  }
  if (/HTTP 4\d\d/i.test(message)) return "The download site refused the request. Try again later; if it keeps happening, ask IT whether github.com downloads are blocked.";
  if (/ENOSPC|no space left/i.test(message)) return `There isn't enough free disk space for the speech models (about ${Math.round(VOICE_MODELS_BYTES / 1e6)} MB).`;
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
