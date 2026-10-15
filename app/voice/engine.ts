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
 * through the speakers, wake words are ignored; a listening window waits
 * until Ember has finished speaking.
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
  /**
   * Is someone speaking? An eager voice check with its own state (not vad()'s), which decides when the spotter
   * runs while Ember waits for its name; optional (without it, loudness against the room's noise decides).
   */
  hearsSpeech?(frame: Float32Array): boolean;
  /** Starts that check afresh (it rested while the room was steady). */
  resetHearsSpeech?(): void;
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
  /** `window`: which listening window this is (a follow-up's timeout shouldn't clear the answer it follows). */
  | { type: "listening"; on: boolean; reason: "wake" | "follow-up" | "timeout" | "done" | "stop" | "rejected"; window: "wake" | "follow-up" }
  | { type: "speech"; on: boolean }
  | { type: "level"; rms: number }
  | { type: "utterance"; text: string; ms: number }
  | { type: "rejected"; keyword: string; reason: "self" | "speakers" | "check"; heard?: string };

export interface EngineOptions {
  /** Audio kept before a wake so a one-breath command isn't cut (seconds). */
  preRoll?: number;
  /** How long to wait for speech after a wake before giving up (ms). */
  waitForSpeechMs?: number;
  /**
   * Speaker-output matches within this window reject a wake (ms). The speakers' own stream hears the same
   * audio at almost the same moment, but either spotter can report it a few chunks later (measured: 150 ms
   * let half of a video's "Hey Ember"s through). Only waited out while something is playing.
   */
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

/** The wake phrase as the recognizer writes it ("Hey, Ember." "hey Emmer" "OK Amber"). */
const WAKE = String.raw`((hey|hi|ok|okay|hay)[\s,.!]+)?(ember|embers|emmer|amber|member)\b[\s,.!?:;-]*`;
const WAKE_AT_START = new RegExp(String.raw`^\s*` + WAKE, "i");
/** Right after a wake, the pre-roll can start with the end of what was said before it: "Lunch, hey Ember, …". */
const WAKE_IN_FIRST_WORDS = new RegExp(String.raw`^\s*(\S+\s+){0,5}?` + WAKE, "i");

/**
 * "Hey Ember, turn on Night Light." → "Turn on Night Light." With `afterWake` (the first thing heard after a
 * wake), words said just before the wake phrase go too: nothing said before "Hey Ember" is sent anywhere.
 */
export function stripWake(text: string, afterWake = false): string {
  return text
    .replace(afterWake ? WAKE_IN_FIRST_WORDS : WAKE_AT_START, "")
    .trim()
    .replace(/^[a-z]/, c => c.toUpperCase());
}

/** "Hey Ember, stop." / "Never mind": the whole request is to stop, handled here like "Ember, stop" (never sent to the model). */
export function isStop(text: string): boolean {
  return /^(please[\s,]+)?(stop|cancel|never\s?mind|be quiet|quiet|hush)([\s,.!]+(stop|it|that|now|please|talking|ember))*[\s.!,]*$/i.test(text);
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

/**
 * Frames of 32 ms. The spotter gets half a second without speech after it (enough for its
 * own delay), then rests and is reset when speech returns: a stream fed long silence after
 * a detection stops recognizing the next "Hey Ember" (measured: 1 s of it misses wakes).
 * The frames it missed are replayed then, from 12 frames before the sound started: where
 * its stream starts changes what it hears (measured: a few frames either way costs wakes and
 * lets "Hey Amber" through). Speech too quiet to stand out gets the last 24 frames.
 */
const MIC_REST_FRAMES = 16;
const MIC_REPLAY_FRAMES = 12;
const MIC_QUIET_REPLAY_FRAMES = 24;
/** Frames kept while the spotter rests (the voice check's delay is well within it). */
const MIC_TAIL_FRAMES = 32;
/** The voice check wakes on a frame this far above the room's noise, runs for 2 s after the last one, and starts with 8 frames of context. */
const CHECK_WAKE_RATIO = 1.3;
const CHECK_HANG_FRAMES = 63;
const CHECK_CONTEXT_FRAMES = 8;
/** The room's noise is learned in its first 3 s (a noisy room in about 2 s), then follows slowly. */
const FLOOR_LEARN_FRAMES = 94;
const SPEAKERS_TAIL_FRAMES = 16;
/** Speakers silent this long before a wake can't have played "Hey Ember" (phrase + spotter delay). */
const SPEAKERS_QUIET_MS = 1500;
/** Longest Ember counts as speaking without hearing so again (the mic window repeats it while it speaks). */
const SELF_SPEAKING_MAX_MS = 60_000;

/** `ms`: the window's length (it starts again after Ember speaks); `first`: nothing heard yet since the wake. */
type Mode = { kind: "idle" } | { kind: "listening"; until: number; ms: number; heardSpeech: boolean; first: boolean; reason: "wake" | "follow-up" };

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
  /** Where in the tail the sound started (the first frame well above the room's noise), or -1. */
  private loudAt = -1;
  /** Frames left before the voice check rests (the room was steady), and the frame it last heard. */
  private unsteady = 0;
  private checkedAt = -1;
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

  /**
   * Ember is speaking (TTS): ignore wake words, and what a listening window hears, until it stops (plus a short
   * tail). Capped, so a lost "stopped" can't deafen Ember for good. A "stopped" while silent changes nothing.
   */
  selfSpeaking(on: boolean, tailMs = 400): void {
    const now = this.now();
    if (!on) { this.selfSpeakingUntil = Math.min(this.selfSpeakingUntil, now + tailMs); return; }
    this.selfSpeakingUntil = now + SELF_SPEAKING_MAX_MS;
    if (this.mode.kind !== "listening") return;
    // What the VAD heard so far is Ember's voice, or was cut by it: start afresh once Ember is done.
    this.backend.resetVad();
    if (this.wasSpeaking) { this.wasSpeaking = false; this.emit({ type: "speech", on: false }); }
  }

  /** Listen for a follow-up without the wake word (the window starts once Ember has finished speaking). */
  followUp(ms = 8000): void {
    if (this.mode.kind === "listening") { this.mode.until = Math.max(this.mode.until, this.now() + ms); return; }
    this.backend.resetVad();
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: false, reason: "follow-up" };
    this.emit({ type: "listening", on: true, reason: "follow-up", window: "follow-up" });
  }

  /** Stop listening for a command, and drop a wake still being checked (the kill switch, Esc). */
  cancel(): void {
    this.pendingWake = null;
    this.ring.clear();
    if (this.mode.kind === "listening") this.endListening("stop");
    else this.backend.resetVad();
  }

  /** Speaker output (PulseAudio monitor), for rejecting wake words that come from videos. */
  feedMonitor(frame: Float32Array): void {
    const at = this.now();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    // Nothing playing: nothing to spot (most of the speakers stream's CPU).
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

    // Nobody is saying "Hey Ember" unless someone is speaking: the spotter (most of the idle CPU) rests
    // after half a second without speech, and the frames it missed are replayed when speech returns.
    // True silence is never speech. Otherwise the voice check decides: it hears speech under a fan,
    // where loudness can't (measured: wakes at 3–6 dB SNR were all missed). It only runs while the room
    // isn't steady, so a quiet room costs nothing. The room's noise floor is minimum statistics, so
    // continuous speech or TV, which dips between words, can't drag it up.
    const base = this.o.silenceRms ?? 0.0008;
    this.floor = Math.min(rms, Math.max(this.floor, base / 4) * (this.frames <= FLOOR_LEARN_FRAMES ? 1.05 : 1.003));
    const quiet = rms < base || (this.mode.kind === "idle" && !this.maybeSpeech(frame, rms));
    this.quietRun = quiet ? this.quietRun + 1 : 0;
    let toSpot: Float32Array[] = [frame];
    const loud = rms >= Math.max(base, this.floor * 2.5);
    if (quiet && this.quietRun > MIC_REST_FRAMES && this.mode.kind === "idle") {
      this.quietTail.push(frame);
      if (loud && this.loudAt < 0) this.loudAt = this.quietTail.length - 1;
      if (this.quietTail.length > MIC_TAIL_FRAMES) { this.quietTail.shift(); this.loudAt--; }
      toSpot = [];
    } else if (this.quietTail.length) {
      this.backend.resetSpot?.();
      const from = this.loudAt >= 0 ? this.loudAt - MIC_REPLAY_FRAMES : loud ? this.quietTail.length - MIC_REPLAY_FRAMES : this.quietTail.length - MIC_QUIET_REPLAY_FRAMES;
      toSpot = [...this.quietTail.slice(Math.max(0, from)), frame];
      this.quietTail = [];
      this.loudAt = -1;
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
      const window = this.o.rejectWindowMs ?? 400;
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
    if (now < this.selfSpeakingUntil) {
      // Ember's own voice (echo cancellation leaves some) is not a request: the VAD isn't fed, and the
      // window stays open until Ember has finished. Otherwise Ember answers itself, again and again.
      this.mode.until = Math.max(this.mode.until, now + this.mode.ms);
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

  /** Idle: might someone be speaking? (See feed.) */
  private maybeSpeech(frame: Float32Array, rms: number): boolean {
    if (!this.backend.hearsSpeech) return rms >= this.floor * 2.5;
    if (rms >= this.floor * CHECK_WAKE_RATIO) this.unsteady = CHECK_HANG_FRAMES;
    else if (this.unsteady > 0) this.unsteady--;
    if (!this.unsteady) return false;
    if (this.checkedAt !== this.frames - 1) {
      // Starting afresh (it rested, or Ember was listening): a moment of what came before, for context.
      this.backend.resetHearsSpeech?.();
      const pre = this.ring.read();
      for (let i = Math.max(0, pre.length - CHECK_CONTEXT_FRAMES * 512); i < pre.length; i += 512) this.backend.hearsSpeech(pre.subarray(i, i + 512));
    }
    this.checkedAt = this.frames;
    return this.backend.hearsSpeech(frame);
  }

  private announceWake(keyword: string): void {
    this.emit({ type: "wake", keyword });
    this.backend.resetVad();
    const ms = this.o.waitForSpeechMs ?? 6000;
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: true, reason: "wake" };
    this.emit({ type: "listening", on: true, reason: "wake", window: "wake" });
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
    const text = stripWake(this.backend.transcribe(seg), this.mode.first);
    this.mode.first = false;
    if (!text || /^[\s.,!?]*$/.test(text)) {
      // Only the wake phrase (or a cough): keep listening for the request.
      this.mode.until = Math.max(this.mode.until, this.now() + 4000);
      return;
    }
    if (isStop(text)) {
      // "Hey Ember, stop": the kill phrase in other words, handled here and never sent anywhere.
      this.emit({ type: "stop" });
      this.endListening("stop");
      return;
    }
    this.emit({ type: "utterance", text, ms: this.now() - t0 });
    this.endListening("done");
  }

  private endListening(reason: "timeout" | "done" | "stop" | "rejected"): void {
    const window = this.mode.kind === "listening" ? this.mode.reason : "wake";
    this.mode = { kind: "idle" };
    this.wasSpeaking = false;
    this.backend.resetVad();
    this.emit({ type: "listening", on: false, reason, window });
  }
}
