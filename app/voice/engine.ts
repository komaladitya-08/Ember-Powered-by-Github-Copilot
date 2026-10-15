/**
 * Ember's ears. Everything here runs on this computer: audio never leaves it,
 * and nothing is kept, before the wake word.
 *
 * Always: keyword spotting for "hey ember" (wake) and "ember stop" (kill).
 * After a wake: voice activity detection finds the end of what was said, then
 * an offline recognizer transcribes the whole utterance at once (accurate,
 * punctuated). A short pre-roll means "Hey Ember, turn on Night Light" works
 * in one breath; the wake phrase is stripped from the transcript.
 * After Ember answers: a follow-up window where no wake word is needed.
 * While Ember itself is speaking, or when the same wake phrase is playing
 * through the speakers, wake words are ignored.
 */

export const SAMPLE_RATE = 16_000;

/** The recognizers, behind an interface so the state machine is testable. */
export interface VoiceBackend {
  /** Keywords spotted in this frame ("hey_ember", "ember_stop"…). */
  spot(frame: Float32Array): string[];
  /** Starts the spotter afresh (after a pause, so half-heard words don't carry over). */
  resetSpot?(): void;
  /** Keywords spotted in speaker output (for rejecting wake words from videos); optional. */
  spotMonitor?(frame: Float32Array): string[];
  /** Feeds voice activity detection; returns finished speech segments. */
  vad(frame: Float32Array): Float32Array[];
  /** True while VAD hears speech. */
  speaking(): boolean;
  /** Ends any segment in progress and returns it. */
  flushVad(): Float32Array[];
  resetVad(): void;
  transcribe(samples: Float32Array): string;
}

export type VoiceEvent =
  | { type: "wake"; keyword: string }
  | { type: "stop" }
  | { type: "listening"; on: boolean; reason: "wake" | "follow-up" | "timeout" | "done" | "stop" | "rejected" }
  | { type: "speech"; on: boolean }
  | { type: "level"; rms: number }
  | { type: "utterance"; text: string; ms: number }
  | { type: "rejected"; keyword: string; reason: "self" | "speakers" | "check"; heard?: string };

export interface EngineOptions {
  /** Audio kept before a wake so a one-breath command isn't cut (seconds). */
  preRoll?: number;
  /** How long to wait for speech after a wake before giving up (ms). */
  waitForSpeechMs?: number;
  /** Speaker-output matches within this window reject a wake (ms). The speakers' own stream hears the same audio at almost the same moment. */
  rejectWindowMs?: number;
  /** Frames quieter than this (RMS), or than the room's own noise floor, count as silence; keyword spotting pauses in long silences. */
  silenceRms?: number;
  /** Second-stage check: transcribe the wake word and reject near-misses ("Amber"). Default on. */
  verifyWake?: boolean;
  now?: () => number;
}

/**
 * Second stage: the keyword spotter can't always tell "Ember" from words that
 * sound like it. If the recognizer clearly heard one of those (and not
 * "Ember"), it wasn't a wake. Only clear near-misses are rejected, so a
 * mumbled real wake still counts.
 */
export function heardOtherWord(transcript: string): boolean {
  const t = transcript.toLowerCase();
  if (/\bember\b|\bembers\b/.test(t)) return false;
  return /\b(amber|ambers|remember|remembers|member|members|september|november|december|timber|number|chamber|hammer)\b/.test(t);
}

/** "Hey Ember, turn on Night Light." → "turn on Night Light." */
export function stripWake(text: string): string {
  return text
    .replace(/^\s*((hey|hi|ok|okay|hay)[\s,.!]+)?(ember|amber|embers|member)\b[\s,.!?:;-]*/i, "")
    .trim()
    .replace(/^[a-z]/, c => c.toUpperCase());
}

/** A fixed-length ring of recent samples. */
export class Ring {
  private buf: Float32Array;
  private at = 0;
  private full = false;

  constructor(seconds: number, rate = SAMPLE_RATE) {
    this.buf = new Float32Array(Math.max(1, Math.round(seconds * rate)));
  }

  push(frame: Float32Array): void {
    for (let i = 0; i < frame.length; i++) {
      this.buf[this.at] = frame[i];
      this.at = (this.at + 1) % this.buf.length;
      if (this.at === 0) this.full = true;
    }
  }

  /** Oldest to newest. */
  read(): Float32Array {
    if (!this.full) return this.buf.slice(0, this.at);
    const out = new Float32Array(this.buf.length);
    out.set(this.buf.subarray(this.at), 0);
    out.set(this.buf.subarray(0, this.at), this.buf.length - this.at);
    return out;
  }

  clear(): void {
    this.at = 0;
    this.full = false;
  }
}

/** Frames of 32 ms. The spotter reports a phrase about 460 ms after it ends. */
const MIC_REST_FRAMES = 32;
const MIC_REPLAY_FRAMES = 24;
const SPEAKERS_TAIL_FRAMES = 48;
/** Speakers silent this long before a wake can't have played "Hey Ember" (phrase + spotter delay). */
const SPEAKERS_QUIET_MS = 1500;

type Mode = { kind: "idle" } | { kind: "listening"; until: number; heardSpeech: boolean; reason: "wake" | "follow-up" };

export class VoiceEngine {
  private mode: Mode = { kind: "idle" };
  private ring: Ring;
  private selfSpeakingUntil = 0;
  private monitorHits: { keyword: string; at: number }[] = [];
  /** A spotted wake word waiting out the speakers check, with the audio as it was when it was heard. */
  private pendingWake: { keyword: string; at: number; audio: Float32Array } | null = null;
  /** When the speakers last made a sound (their stream is only spotted while they do). */
  private monitorSoundAt = Number.NEGATIVE_INFINITY;
  private monitorQuietRun = 0;
  private wasSpeaking = false;
  private frames = 0;
  /** Quiet frames in a row, and the most recent ones (replayed to the spotter when sound returns). */
  private quietRun = 0;
  /** The room's noise level (RMS): follows the quietest frames down at once and rises only slowly. */
  private floor = 0;
  private quietTail: Float32Array[] = [];
  /** Frames the keyword spotter actually decoded (for CPU accounting and tests). */
  spotted = 0;
  private now: () => number;

  constructor(private backend: VoiceBackend, private emit: (e: VoiceEvent) => void, private o: EngineOptions = {}) {
    this.ring = new Ring(o.preRoll ?? 1.6);
    this.now = o.now ?? Date.now;
  }

  get listening(): boolean {
    return this.mode.kind === "listening";
  }

  /** Ember is speaking (TTS): ignore wake words until `ms` from now (plus a short tail). */
  selfSpeaking(on: boolean, tailMs = 400): void {
    this.selfSpeakingUntil = on ? Number.POSITIVE_INFINITY : this.now() + tailMs;
  }

  /** Listen for a follow-up without the wake word. */
  followUp(ms = 8000): void {
    if (this.mode.kind === "listening") { this.mode.until = Math.max(this.mode.until, this.now() + ms); return; }
    this.backend.resetVad();
    this.mode = { kind: "listening", until: this.now() + ms, heardSpeech: false, reason: "follow-up" };
    this.emit({ type: "listening", on: true, reason: "follow-up" });
  }

  /** Stop listening for a command (e.g. the user pressed Esc). */
  cancel(): void {
    if (this.mode.kind === "listening") this.endListening("done");
  }

  /** Speaker output (PulseAudio monitor), for rejecting wake words that come from videos. */
  feedMonitor(frame: Float32Array): void {
    const at = this.now();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    // Nothing playing: nothing to spot (most of the speakers stream's CPU). The spotter keeps
    // running for a while after the sound stops, since it reports a phrase about half a second late.
    if (Math.sqrt(sum / Math.max(1, frame.length)) < (this.o.silenceRms ?? 0.0008)) {
      if (++this.monitorQuietRun > SPEAKERS_TAIL_FRAMES) return;
    } else {
      this.monitorQuietRun = 0;
      this.monitorSoundAt = at;
    }
    const hits = this.backend.spotMonitor?.(frame) ?? [];
    for (const keyword of hits) this.monitorHits.push({ keyword, at });
    this.monitorHits = this.monitorHits.filter(h => at - h.at < 5000);
  }

  /** One frame of microphone audio, 16 kHz mono. */
  feed(frame: Float32Array): void {
    const now = this.now();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    if (++this.frames % 4 === 0) this.emit({ type: "level", rms });

    // In a silent room nobody is saying "Hey Ember": skip the spotter (most of the idle CPU)
    // after a second of silence (longer than a pause inside "Hey… Ember", and than the spotter's
    // own delay), and replay the last few quiet frames when sound returns.
    // A steady fan or hum isn't speech either: compare with the room's noise floor (minimum
    // statistics, so continuous speech or TV, which dips between words, can't drag it up).
    const base = this.o.silenceRms ?? 0.0008;
    this.floor = Math.min(rms, (this.floor || base) * 1.003);
    const quiet = rms < Math.max(base, this.floor * 2.5);
    this.quietRun = quiet ? this.quietRun + 1 : 0;
    let toSpot: Float32Array[] = [frame];
    if (quiet && this.quietRun > MIC_REST_FRAMES && this.mode.kind === "idle") {
      this.quietTail.push(frame);
      if (this.quietTail.length > MIC_REPLAY_FRAMES) this.quietTail.shift();
      toSpot = [];
    } else if (this.quietTail.length) {
      this.backend.resetSpot?.();
      toSpot = [...this.quietTail, frame];
      this.quietTail = [];
    }
    const keywords: string[] = [];
    for (const f of toSpot) { this.spotted++; keywords.push(...this.backend.spot(f)); }

    for (const keyword of keywords) {
      if (keyword === "ember_stop") {
        // The kill phrase works in every state and never waits for anything.
        this.emit({ type: "stop" });
        if (this.mode.kind === "listening") this.endListening("stop");
        this.pendingWake = null;
        continue;
      }
      if (now < this.selfSpeakingUntil) { this.emit({ type: "rejected", keyword, reason: "self" }); continue; }
      if (this.mode.kind === "idle" && !this.pendingWake) this.pendingWake = { keyword, at: now, audio: this.ring.read() };
    }

    // A wake is accepted once we're sure the speakers didn't just say it.
    if (this.pendingWake) {
      const w = this.pendingWake;
      const window = this.o.rejectWindowMs ?? 150;
      if (this.monitorHits.some(h => h.keyword === w.keyword && Math.abs(h.at - w.at) <= window)) {
        this.pendingWake = null;
        this.emit({ type: "rejected", keyword: w.keyword, reason: "speakers" });
      } else if (!this.backend.spotMonitor || now - w.at >= window || now - this.monitorSoundAt > SPEAKERS_QUIET_MS) {
        // (Speakers that were quiet for the whole phrase can't have said it: no need to wait.)
        this.pendingWake = null;
        // Ember shows it's listening at once; the transcript check (a few hundred ms of work) runs
        // next and takes the wake back if the recognizer clearly heard another word ("Amber").
        this.announceWake(w.keyword);
        const heard = this.o.verifyWake === false ? "" : this.backend.transcribe(w.audio);
        if (heard && heardOtherWord(heard)) {
          this.emit({ type: "rejected", keyword: w.keyword, reason: "check", heard });
          this.ring.clear();
          this.endListening("rejected");
        } else {
          this.replayPreRoll();
        }
      }
    }

    if (this.mode.kind === "idle") {
      this.ring.push(frame);
      return;
    }

    const segments = this.backend.vad(frame);
    const speaking = this.backend.speaking();
    if (speaking !== this.wasSpeaking) {
      this.wasSpeaking = speaking;
      this.emit({ type: "speech", on: speaking });
      if (speaking && this.mode.kind === "listening") this.mode.heardSpeech = true;
    }
    for (const seg of segments) this.handleSegment(seg);
    if (this.mode.kind === "listening" && !speaking && now > this.mode.until) {
      for (const seg of this.backend.flushVad()) this.handleSegment(seg);
      if (this.mode.kind === "listening") this.endListening("timeout");
    }
  }

  private announceWake(keyword: string): void {
    this.emit({ type: "wake", keyword });
    this.backend.resetVad();
    this.mode = { kind: "listening", until: this.now() + (this.o.waitForSpeechMs ?? 6000), heardSpeech: false, reason: "wake" };
    this.emit({ type: "listening", on: true, reason: "wake" });
  }

  /** Replays what was said just before (and during) the wake word, so a one-breath request isn't cut. */
  private replayPreRoll(): void {
    const pre = this.ring.read();
    this.ring.clear();
    for (let i = 0; i < pre.length; i += 512) for (const seg of this.backend.vad(pre.subarray(i, i + 512))) this.handleSegment(seg);
  }

  private handleSegment(seg: Float32Array): void {
    if (this.mode.kind !== "listening") return;
    const t0 = this.now();
    const text = stripWake(this.backend.transcribe(seg));
    if (!text || /^[\s.,!?]*$/.test(text)) {
      // Only the wake phrase (or a cough): keep listening for the request.
      this.mode.until = Math.max(this.mode.until, this.now() + 4000);
      return;
    }
    this.emit({ type: "utterance", text, ms: this.now() - t0 });
    this.endListening("done");
  }

  private endListening(reason: "timeout" | "done" | "stop" | "rejected"): void {
    this.mode = { kind: "idle" };
    this.wasSpeaking = false;
    this.backend.resetVad();
    this.emit({ type: "listening", on: false, reason });
  }
}
