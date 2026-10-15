/**
 * VoiceService: the microphone window, the voice process and the models.
 * The mic is opened only when the user turned listening on, agreed to it,
 * the models are verified and Ember isn't muted; muting closes the stream,
 * which releases the microphone (GNOME's mic indicator goes away).
 */

import { BrowserWindow, MessageChannelMain, ipcMain, net, session, utilityProcess, type UtilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureModels, modelPaths, modelsReady, VOICE_MODELS_BYTES, type Downloader } from "../voice/models";
import type { VoiceEvent } from "../voice/engine";
import { VOICE, type MicState, type MicStatus } from "../shared/voice";
import type { Logger } from "./logger";

const appDir = __dirname;

export interface VoiceOptions {
  log: Logger;
  modelsRoot: string;
  /** Speaker-output rejection (needs parec). */
  monitor: boolean;
  onEvent: (e: VoiceEvent) => void;
  onState: (s: MicState, detail?: string) => void;
}

/** Downloads with Chromium's network stack (system proxy settings apply). */
export const electronDownloader: Downloader = async (url, dest, progress) => {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  let bytes = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (c: Buffer) => { bytes += c.length; progress(bytes); });
  await pipeline(body, fs.createWriteStream(dest));
};

export class VoiceService {
  private proc: UtilityProcess | null = null;
  private mic: BrowserWindow | null = null;
  private state: MicState = "off";
  private muted = false;
  private wanted = false;
  private downloading: Promise<void> | null = null;

  constructor(private o: VoiceOptions) {
    ipcMain.on(VOICE.status, (e, s: MicStatus) => {
      if (!this.mic || e.sender !== this.mic.webContents) return;
      if (s.state === "error") { this.o.log.error("voice.mic_error", { message: s.message }); this.setState("error", micHelp(s.message)); this.teardown(); }
      else this.o.log.info("voice.mic", { device: s.device, rate: s.rate, context: s.context });
    });
    ipcMain.on(VOICE.speaking, (e, on: boolean) => {
      if (this.mic && e.sender === this.mic.webContents) this.proc?.postMessage({ type: "self-speaking", on: !!on });
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

  async downloadModels(progress: (done: number, total: number) => void): Promise<void> {
    if (!this.downloading) {
      this.setState("downloading");
      this.downloading = ensureModels(this.o.modelsRoot, electronDownloader, progress)
        .then(() => { this.o.log.info("voice.models_ready", { bytes: VOICE_MODELS_BYTES }); })
        .finally(() => { this.downloading = null; });
    }
    await this.downloading;
    if (this.wanted) await this.start();
  }

  followUp(ms = 8000): void {
    this.proc?.postMessage({ type: "follow-up", ms });
  }

  cancelListening(): void {
    this.proc?.postMessage({ type: "cancel" });
  }

  speak(text: string): void {
    if (this.mic && !this.mic.isDestroyed()) this.mic.webContents.send(VOICE.speak, text);
  }

  hush(): void {
    if (this.mic && !this.mic.isDestroyed()) this.mic.webContents.send(VOICE.hush);
  }

  private async start(): Promise<void> {
    if (!this.wanted || this.muted || this.proc) return;
    if (!this.modelsReady) { this.setState(this.downloading ? "downloading" : "needs-models"); return; }
    this.setState("starting");
    const proc = utilityProcess.fork(path.join(appDir, "voice.cjs"), [], { serviceName: "Ember voice", stdio: "pipe" });
    this.proc = proc;
    proc.stderr?.on("data", (d: Buffer) => this.o.log.debug("voice.stderr", { line: d.toString().slice(0, 300) }));
    proc.on("exit", code => {
      if (this.proc === proc) { this.proc = null; this.closeMic(); if (this.wanted && !this.muted) { this.o.log.warn("voice.exit", { code }); this.setState("error", "The voice process stopped."); } }
    });
    proc.on("message", (m: VoiceEvent | { type: "ready"; loadMs: number; monitor: boolean } | { type: "error"; message: string } | { type: "stats"; cpuMs: number; audioMs: number; peak: number }) => {
      if (m.type === "ready") { this.o.log.info("voice.ready", { loadMs: m.loadMs, speakerRejection: m.monitor }); this.setState("waiting"); return; }
      if (m.type === "error") { this.o.log.error("voice.error", { message: m.message }); this.setState("error", m.message); this.teardown(); return; }
      if (m.type === "stats") { this.o.log.info("voice.cpu", { percent: Math.round((m.cpuMs / m.audioMs) * 1000) / 10, audioMs: m.audioMs, peak: m.peak }); return; }
      if (m.type === "listening") this.setState(m.on ? "active" : "waiting");
      if (m.type === "rejected") this.o.log.info("voice.rejected", { keyword: m.keyword, reason: m.reason });
      if (m.type !== "level") this.o.log.debug("voice.event", { type: m.type });
      this.o.onEvent(m);
    });
    const { port1, port2 } = new MessageChannelMain();
    proc.postMessage({ type: "init", models: modelPaths(this.o.modelsRoot), monitor: this.o.monitor }, [port1]);

    this.mic = new BrowserWindow({
      show: false, width: 1, height: 1, skipTaskbar: true, focusable: false, title: "Ember microphone",
      webPreferences: {
        preload: path.join(appDir, "preload", "mic.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, spellcheck: false,
        // A hidden window never gets a user gesture; without this its AudioContext stays suspended.
        autoplayPolicy: "no-user-gesture-required",
      },
    });
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
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }

  stop(): void {
    this.wanted = false;
    this.teardown();
  }

  private setState(s: MicState, detail?: string): void {
    this.state = s;
    this.o.onState(s, detail);
  }
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
