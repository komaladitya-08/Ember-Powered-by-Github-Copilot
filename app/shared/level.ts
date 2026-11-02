/**
 * Sound levels for Ember's presence (docs/DESIGN.md "Presence"): the microphone's while Ember hears a request, and
 * Ember's own voice while it plays. Only a level in eight steps ever leaves the page that hears or plays the sound,
 * never audio, and at most 20 times a second, only when it changed: the overlay is always on screen on a CPU-only
 * desktop, so a meter that redraws on every frame or animates on silence would cost CPU and tell the user nothing.
 * Pure (no DOM, no Electron), so the mic page, main and the overlay share it and it is unit-tested.
 */

/** The steps a level is shown in (0: silence, LEVEL_STEPS: loud). */
export const LEVEL_STEPS = 8;
/** The quickest a level is sent again (ms): 20 a second at most (the microphone's, which answers the user's voice). */
export const LEVEL_MS = 50;
/**
 * How often Ember's own voice level is read while it plays (ms): 10 a second, which still follows its syllables. At 20
 * the overlay's five bars cost about 4 points of a core while Ember spoke, at 10 about 2 (measured under Xvfb).
 */
export const VOICE_LEVEL_MS = 100;

/** A level from the page that hears or plays: `mic` while Ember hears a request, `voice` while its own voice plays; null: that stream ended. */
export interface SoundLevel {
  mic?: number | null;
  voice?: number | null;
}

/** Quiet speech sits near −45 dBFS on a laptop's microphone; a raised voice near −10. Below the floor reads as silence. */
const FLOOR_DB = -55;
const TOP_DB = -12;

/** An RMS (0–1) as a step of 0–LEVEL_STEPS, on a decibel scale (a meter that follows the ear, not the waveform). */
export function levelStep(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const t = (db - FLOOR_DB) / (TOP_DB - FLOOR_DB);
  return Math.max(0, Math.min(LEVEL_STEPS, Math.round(t * LEVEL_STEPS)));
}

/** The RMS of a block of samples. */
export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** A level as sent and received, checked (anything else from a page is dropped). */
export function validLevel(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= LEVEL_STEPS);
}

/** A SoundLevel from a page, checked: only its known keys, each a valid level; null when it is anything else. */
export function readLevel(v: unknown): SoundLevel | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!keys.length || keys.some(k => k !== "mic" && k !== "voice")) return null;
  const out: SoundLevel = {};
  for (const k of keys as ("mic" | "voice")[]) {
    if (!validLevel(o[k])) return null;
    out[k] = o[k] as number | null;
  }
  return out;
}

/**
 * Turns a stream of RMS readings into the levels sent on: at most one each LEVEL_MS, only when the step changed, and
 * a final null when the stream ends (so the meter stops at once, never left lit on silence).
 */
export class LevelMeter {
  private sent: number | null = null;
  private sentAt = -Infinity;
  /** A changed step not yet sent (it came too soon after the last): sent with the next reading after the gap. */
  private owed: number | null = null;

  constructor(private readonly send: (level: number | null) => void, private readonly gapMs = LEVEL_MS) {}

  /** A reading (RMS, 0–1) at `now` (ms). */
  push(value: number, now: number): void {
    const step = levelStep(value);
    if (step === this.sent) { this.owed = null; return; }
    if (now - this.sentAt < this.gapMs) { this.owed = step; return; }
    this.owed = null;
    this.sent = step;
    this.sentAt = now;
    this.send(step);
  }

  /** The stream ended: null is sent once (nothing if nothing was). */
  end(): void {
    this.owed = null;
    if (this.sent === null) return;
    this.sent = null;
    this.sentAt = -Infinity;
    this.send(null);
  }

  /** A step is waiting for the gap to pass (the caller may come back for it). */
  get pending(): boolean {
    return this.owed !== null;
  }

  /** Sends a step that waited, once its gap has passed (for a caller that reads on a timer). */
  flush(now: number): void {
    if (this.owed === null || now - this.sentAt < this.gapMs) return;
    const step = this.owed;
    this.owed = null;
    this.sent = step;
    this.sentAt = now;
    this.send(step);
  }
}

/** The envelope of a chunk of Ember's voice: one RMS per LEVEL_MS of it, so playback can look its level up by time. */
export function envelope(samples: Float32Array, rate: number, stepMs = LEVEL_MS): number[] {
  const n = Math.max(1, Math.round((rate * stepMs) / 1000));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += n) out.push(rms(samples.subarray(i, Math.min(samples.length, i + n))));
  return out;
}

/** Ember's voice scheduled to play: when each chunk starts (s, on the audio clock) and its envelope. */
export interface VoiceSpan { at: number; env: number[]; stepS: number }

/** Ember's voice level at `time` (s, on the audio clock): the RMS of the chunk playing then, or null when none plays. */
export function voiceAt(spans: readonly VoiceSpan[], time: number): number | null {
  for (const s of spans) {
    const i = Math.floor((time - s.at) / s.stepS);
    if (i >= 0 && i < s.env.length) return s.env[i];
  }
  return null;
}

/** Every meter stopped: sent to the overlay as Ember shows again, so a level from before it hid is never shown stale. */
export const NO_LEVEL: Readonly<SoundLevel> = { mic: null, voice: null };

/**
 * What of a level reaches the overlay: all of it while Ember shows; while it is hidden only the streams that ended
 * (null), so a meter never stays lit (a level and an end sent together keep the end). Null when nothing passes.
 */
export function levelForOverlay(l: SoundLevel, hidden: boolean): SoundLevel | null {
  if (!hidden) return l;
  const ended: SoundLevel = {};
  if (l.mic === null) ended.mic = null;
  if (l.voice === null) ended.voice = null;
  return Object.keys(ended).length ? ended : null;
}
