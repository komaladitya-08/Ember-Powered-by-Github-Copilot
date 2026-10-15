/**
 * Keeps the microphone captured. The device can go away (unplugged, or a track that stays muted), the
 * default device can change (a headset plugged in), and the audio context can stop: each starts capture
 * again. A device that keeps failing is tried after 1 s, 5 s, then every 30 s (sooner when devices change),
 * and main is told meanwhile ("lost") so the user sees it. A microphone that never opened is an error for
 * main to show, not retried here.
 */

import type { MicStatus } from "../../shared/voice";

/** What capture needs from the page (stand-ins in tests). */
export interface CaptureDeps {
  getUserMedia(): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  onDeviceChange(fn: () => void): void;
  /** The audio graph that sends the stream's frames on; resolves once it's running. */
  graph(stream: MediaStream): Promise<AudioContext>;
  status(s: MicStatus): void;
}

const RETRY_MS = [1000, 5000, 30_000];
/** A track muted this long has lost its sound (a short mute, e.g. while devices switch, is waited out). */
const MUTE_GRACE_MS = 2000;
/** Devices settle this long before the default is checked; a suspended context gets this long to resume. */
const SETTLE_MS = 500;
const RESUME_MS = 2000;

export class Capture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  /** The default input when capture started (to notice it change). */
  private device = "";
  private worked = false;
  private since = 0;
  private failures = 0;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private d: CaptureDeps) {
    let settle: ReturnType<typeof setTimeout> | undefined;
    d.onDeviceChange(() => { clearTimeout(settle); settle = setTimeout(() => void this.devicesChanged(), SETTLE_MS); });
  }

  async start(): Promise<void> {
    clearTimeout(this.retry);
    this.retry = undefined;
    const attempt = ++this.attempt;
    this.release();
    let stream: MediaStream | null = null;
    try {
      stream = await this.d.getUserMedia();
      const ctx = await this.d.graph(stream);
      if (attempt !== this.attempt) { stopTracks(stream); void ctx.close().catch(() => undefined); return; } // superseded meanwhile
      this.stream = stream;
      this.ctx = ctx;
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => { if (this.stream === stream) this.lost("The microphone was disconnected."); };
        let muted: ReturnType<typeof setTimeout> | undefined;
        track.onmute = () => { muted = this.later(() => { if (this.stream === stream && track.muted) this.lost("The microphone stopped sending sound."); }, MUTE_GRACE_MS); };
        track.onunmute = () => clearTimeout(muted);
      }
      ctx.onstatechange = () => this.contextChanged(ctx);
      this.device = await this.defaultInput();
      this.worked = true;
      this.since = Date.now();
      this.d.status({ state: "capturing", device: track?.label ?? "", rate: ctx.sampleRate, context: ctx.state });
    } catch (err) {
      if (stream && this.stream !== stream) stopTracks(stream);
      if (attempt !== this.attempt) return;
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (this.worked) this.lost(message);
      else this.d.status({ state: "error", message });
    }
  }

  /** Releases the microphone for good (the page is closing). */
  stop(): void {
    this.attempt++;
    clearTimeout(this.retry);
    for (const t of this.timers) clearTimeout(t);
    this.release();
  }

  /** Sound went away: main is told, and capture starts again (1 s, 5 s, then every 30 s while it keeps failing). */
  private lost(reason: string): void {
    this.release();
    if (Date.now() - this.since > 60_000) this.failures = 0; // it had been working: start the backoff over
    this.d.status({ state: "lost", message: reason });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]);
  }

  private contextChanged(ctx: AudioContext): void {
    if (ctx !== this.ctx) return;
    if (ctx.state === "closed") { this.lost("The audio stopped."); return; }
    if (ctx.state !== "suspended") return;
    void ctx.resume().catch(() => undefined);
    this.later(() => { if (ctx === this.ctx && ctx.state !== "running") this.lost("The audio stopped."); }, RESUME_MS);
  }

  private async devicesChanged(): Promise<void> {
    // Waiting to try again after a loss: a device just appeared, so try now.
    if (this.retry) { void this.start(); return; }
    if (!this.ctx) return;
    // A new default device (a headset plugged in): follow it. Other changes don't interrupt.
    if ((await this.defaultInput()) !== this.device) void this.start();
  }

  /** Which device "default" is now. */
  private async defaultInput(): Promise<string> {
    try {
      const inputs = (await this.d.enumerateDevices()).filter(x => x.kind === "audioinput");
      const def = inputs.find(x => x.deviceId === "default") ?? inputs[0];
      return def ? `${def.groupId}|${def.label}` : "";
    } catch {
      return "";
    }
  }

  private release(): void {
    const stream = this.stream, ctx = this.ctx;
    this.stream = null;
    this.ctx = null;
    if (stream) stopTracks(stream);
    if (ctx) { ctx.onstatechange = null; void ctx.close().catch(() => undefined); }
  }

  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }
}

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) { t.onended = t.onmute = t.onunmute = null; t.stop(); }
}
