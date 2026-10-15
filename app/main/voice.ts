/**
 * VoiceService: the microphone window, the voice process and the models.
 * The mic is opened only when the user turned listening on, agreed to it,
 * the models are verified and Ember isn't muted; muting closes the stream,
 * which releases the microphone (GNOME's mic indicator goes away).
 * Replies are spoken from the mic window (so echo cancellation removes them),
 * or, while listening is off, from a hidden window that never opens the mic.
 */

import { app, BrowserWindow, MessageChannelMain, ipcMain, net, session, utilityProcess, type UtilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureModels, modelPaths, modelsReady, VOICE_MODELS_BYTES, type Downloader } from "../voice/models";
import type { VoiceEvent } from "../voice/engine";
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

export interface VoiceOptions {
  log: Logger;
  modelsRoot: string;
  /** Speaker-output rejection (needs parec). */
  monitor: boolean;
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

/** A hidden window that only speaks (its page and the sender to recognize it by). */
type Speaker = { win: BrowserWindow; wc: Electron.WebContents; loaded: Promise<void> };

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
  /** A follow-up window (ms) waiting for Ember to finish speaking, and its timer. */
  private followUpMs = 0;
  private followUpTimer: NodeJS.Timeout | null = null;
  private cancelledAt = Number.NEGATIVE_INFINITY;

  constructor(private o: VoiceOptions) {
    ipcMain.on(VOICE.status, (e, s: MicStatus) => {
      if (!this.mic || e.sender !== this.mic.webContents) return;
      if (s.state === "error") { this.o.log.error("voice.mic_error", { message: s.message }); this.setState("error", micHelp(s.message)); this.teardown(); }
      else this.o.log.info("voice.mic", { device: s.device, rate: s.rate, context: s.context });
    });
    ipcMain.on(VOICE.speaking, (e, on: boolean) => {
      if (!(this.mic && e.sender === this.mic.webContents) && e.sender !== this.speaker?.wc) return;
      this.proc?.postMessage({ type: "self-speaking", on: !!on });
      this.speakingUntil = on ? Date.now() + SPEAKING_MAX_MS : 0;
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
    if (!on) { this.teardown(); this.setState("off"); return; }
    await this.start();
  }

  setMuted(on: boolean): void {
    this.muted = on;
    if (on) { this.teardown(); this.setState("muted"); } else void this.start();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Rejects if the download fails; the state has then already gone back (with what went wrong as its detail). */
  async downloadModels(progress: (done: number, total: number) => void): Promise<void> {
    if (!this.downloading && !this.modelsReady) {
      this.setState("downloading");
      this.downloading = ensureModels(this.o.modelsRoot, electronDownloader, progress)
        .then(() => { this.o.log.info("voice.models_ready", { bytes: VOICE_MODELS_BYTES }); })
        .catch((err: unknown) => {
          // Never left on "Downloading…": back to what it was, saying why (the download button offers a retry).
          const message = err instanceof Error ? err.message : String(err);
          this.o.log.warn("voice.download_failed", { message });
          this.setState(!this.wanted ? "off" : this.muted ? "muted" : "needs-models", `Couldn't download the speech models: ${message}`);
          throw err;
        })
        .finally(() => { this.downloading = null; });
    }
    await this.downloading;
    if (this.wanted) await this.start();
    else if (this.state === "downloading") this.setState("off");
  }

  /** A follow-up window (no wake word needed). It opens once Ember has finished speaking its answer, or it would hear itself. */
  followUp(ms = 8000): void {
    this.followUpMs = ms;
    this.openFollowUp();
  }

  private openFollowUp(): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
    if (!this.followUpMs) return;
    const wait = this.speakingUntil - Date.now();
    if (wait > 0) { this.followUpTimer = setTimeout(() => this.openFollowUp(), wait); return; }
    this.proc?.postMessage({ type: "follow-up", ms: this.followUpMs });
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
    this.speaker = { win, wc: win.webContents, loaded: win.loadFile(path.join(appDir, "renderer", "mic", "index.html")) };
    return this.speaker;
  }

  private async start(): Promise<void> {
    if (!this.wanted || this.proc) return;
    if (this.muted) { this.setState("muted"); return; }
    if (!this.modelsReady) { this.setState(this.downloading ? "downloading" : "needs-models"); return; }
    this.setState("starting");
    const proc = utilityProcess.fork(path.join(appDir, "voice.cjs"), [], { serviceName: "Ember voice", stdio: "pipe" });
    this.proc = proc;
    proc.stderr?.on("data", (d: Buffer) => this.o.log.debug("voice.stderr", { line: d.toString().slice(0, 300) }));
    proc.on("exit", code => {
      if (this.proc === proc) { this.proc = null; this.closeMic(); if (this.wanted && !this.muted) { this.o.log.warn("voice.exit", { code }); this.setState("error", "The voice process stopped."); } }
    });
    proc.on("message", (m: VoiceEvent | { type: "ready"; loadMs: number; monitor: boolean } | { type: "error"; message: string } | { type: "stats"; cpuMs: number; audioMs: number; peak: number }) => {
      if (this.proc !== proc) return; // a process being replaced: only the current one speaks for the mic
      if (m.type === "ready") { this.o.log.info("voice.ready", { loadMs: m.loadMs, speakerRejection: m.monitor }); this.setState("waiting"); return; }
      if (m.type === "error") { this.o.log.error("voice.error", { message: m.message }); this.setState("error", m.message); this.teardown(); return; }
      if (m.type === "stats") { this.o.log.info("voice.cpu", { percent: Math.round((m.cpuMs / m.audioMs) * 1000) / 10, audioMs: m.audioMs, peak: m.peak }); return; }
      if (m.type === "utterance" && Date.now() - this.cancelledAt < CANCEL_GRACE_MS) { this.o.log.info("voice.dropped", { reason: "cancelled" }); return; }
      if (m.type === "wake") this.dropFollowUp(); // a new request: the old answer's follow-up is moot
      if (m.type === "listening") this.setState(m.on ? "active" : "waiting");
      if (m.type === "rejected") this.o.log.info("voice.rejected", { keyword: m.keyword, reason: m.reason });
      if (m.type !== "level") this.o.log.debug("voice.event", { type: m.type });
      this.o.onEvent(m);
    });
    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ type: "init", models: modelPaths(this.o.modelsRoot), monitor: this.o.monitor, dev: !app.isPackaged }, [port1]);

    this.mic = hiddenWindow("Ember microphone");
    const mic = this.mic;
    await mic.loadFile(path.join(appDir, "renderer", "mic", "index.html"));
    if (mic.isDestroyed()) return;
    mic.webContents.postMessage(VOICE.port, null, [port2]);
  }

  private closeMic(): void {
    if (this.mic && !this.mic.isDestroyed()) this.mic.destroy();
    this.mic = null;
  }

  private teardown(): void {
    this.closeMic();
    this.dropFollowUp();
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }

  stop(): void {
    this.wanted = false;
    this.teardown();
    if (this.speaker && !this.speaker.win.isDestroyed()) this.speaker.win.destroy();
    this.speaker = null;
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

function micHelp(message: string): string {
  if (/NotAllowed|Permission/i.test(message)) return "Ember wasn't allowed to use the microphone.";
  if (/NotFound|DevicesNotFound/i.test(message)) return "No microphone was found.";
  if (/NotReadable|TrackStart/i.test(message)) return "The microphone is in use by another app or unavailable.";
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
