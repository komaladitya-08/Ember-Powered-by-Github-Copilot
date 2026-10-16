/**
 * Ember's ears. Everything here runs on this computer: audio never leaves it,
 * and nothing is kept, before the wake word.
 *
 * Always: keyword spotting for "hey ember" (wake) and "ember stop" (kill).
 * After a wake: voice activity detection finds the end of what was said, then
 * an offline recognizer transcribes the whole utterance at once (accurate,
 * punctuated). A short pre-roll means "Hey Ember, turn on Night Light" works
 * in one breath; the wake phrase is stripped from the transcript. Other people
 * talking in the background don't keep a request going: it ends when the
 * speaker's own voice does, and never runs past 10 s.
 * After Ember answers: a follow-up window where no wake word is needed ("Thanks"
 * ends it). The wake word is ignored while Ember itself is speaking, and it or
 * "Ember, stop" is ignored when it comes out of the speakers; a listening window
 * waits until Ember has finished speaking.
 */

export const SAMPLE_RATE = 16_000;

/** The recognizers, behind an interface so the state machine is testable. */
export interface VoiceBackend {
  /** Keywords spotted in this frame ("hey_ember", "ember_stop"…). */
  spot(frame: Float32Array): string[];
  /** Starts the spotter afresh (after a pause, so half-heard words don't carry over). */
  resetSpot?(): void;
  /** The speaker paused: the spotter decodes what it has (padded with silence) instead of waiting for more audio. */
  padSpot?(): string[];
  /** Keywords spotted in speaker output (for rejecting wake words from videos); optional. Only run while a wake or stop is checked. */
  spotMonitor?(frame: Float32Array): string[];
  /** The same as padSpot, for the speakers' stream. */
  padMonitor?(): string[];
  /** Ends that spotting (the next spotMonitor starts afresh). */
  resetMonitor?(): void;
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
  /** Ends any segment in progress and returns it (it ends with the last frame fed); the VAD starts afresh. */
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
  | { type: "utterance"; text: string; ms: number }
  | { type: "rejected"; keyword: string; reason: "self" | "speakers" | "check"; heard?: string };

export interface EngineOptions {
  /** Audio kept before a wake so a one-breath command isn't cut (seconds). */
  preRoll?: number;
  /** How long to wait for speech after a wake before giving up (ms). */
  waitForSpeechMs?: number;
  /**
   * Speaker-output matches within this window reject a wake or a stop (ms). The speakers' own stream hears the
   * same audio at almost the same moment, but either spotter can report it a few chunks later (measured: 150 ms
   * let half of a video's "Hey Ember"s through). Only waited out while something is playing.
   */
  rejectWindowMs?: number;
  /** Frames quieter than this (RMS), or than the room's own noise floor, count as silence; keyword spotting pauses in long silences. */
  silenceRms?: number;
  /** Second-stage check: transcribe the wake word (or the stop phrase) and reject near-misses ("Amber", "September stopped"). Default on. */
  verifyWake?: boolean;
  /**
   * The check waits this long after the spotter fires (ms). By default it doesn't when the spotter fired mid-speech
   * (0.45 s after the word), and waits 256 ms when it fired at a pause (0.1 s after it): the recognizer drops a
   * word cut at its very end ("Hey Amber" came out as nothing).
   */
  checkAfterMs?: number;
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

/**
 * The same for "Ember, stop": "September stopped being fun" and "December stop sign" are other words. The
 * recognizer often writes the name as "Amber" or "Emma", and the kill phrase as "Ember stopped"; a garbled
 * transcript still stops (stopping is the safe side).
 */
export function heardOtherStop(transcript: string): boolean {
  const t = transcript.toLowerCase();
  if (/\b(embers?|amber|emma|emmer)\b[^a-z]*(please\s+)?stop/.test(t)) return false;
  return /\b(sept|nov|dec|rem|m)ember\w*(\W+\w+){0,2}?\W+stop/.test(t);
}

/** The wake phrase as the recognizer writes it ("Hey, Ember." "hey Emmer" "OK Amber" "Hey, EmberStop." "Peyamber" "A. M. B."). */
const WAKE = String.raw`((hey|hi|ok|okay|hay|pay|pey|they)[\s,.!]*)?(embers?\b|ember(?=[a-z])|emmer\b|amber\b|member\b|emma\b|a[.\s-]*m[.\s-]*[br]\b\.?)[\s,.!?:;-]*`;
const WAKE_AT_START = new RegExp(String.raw`^\s*` + WAKE, "i");
/** Right after a wake, the pre-roll can start with the end of what was said before it: "Lunch, hey Ember, …". */
const WAKE_IN_FIRST_WORDS = new RegExp(String.raw`^\s*(\S+\s+){0,5}?` + WAKE, "i");
/** …or the name came out as another word: "Hey, ever, turn on…", "Hey, I'm return on…" ("hey" and the word after it are the wake phrase; not "okay", which often starts a request). */
const GREETING_IN_FIRST_WORDS = /^\s*(\S+\s+){0,2}?(hey|hi|hay|pay|they)[\s,.!]+\S+[\s,.!?:;-]*/i;

/**
 * "Hey Ember, turn on Night Light." → "Turn on Night Light." With `afterWake` (the first thing heard after a
 * wake), words said just before the wake phrase go too: nothing said before "Hey Ember" is sent anywhere.
 * A wake phrase said twice ("Hey Ember, Ember stop") goes both times.
 */
export function stripWake(text: string, afterWake = false): string {
  let t = text;
  if (afterWake) {
    const named = t.replace(WAKE_IN_FIRST_WORDS, "");
    t = named !== t ? named : t.replace(GREETING_IN_FIRST_WORDS, "");
  }
  for (let again = t.replace(WAKE_AT_START, ""); again !== t; again = t.replace(WAKE_AT_START, "")) t = again;
  return t.trim().replace(/^[a-z]/, c => c.toUpperCase());
}

/** "Hey Ember, stop." / "No, stop." / "Shut up." / "Never mind": the whole request is to stop, handled here like "Ember, stop" (never sent to the model). */
export function isStop(text: string): boolean {
  // A lone "stop" (or "quiet") heard short ("Stuff.", "Step.", "St", "Quite."): the recognizer's way with the word said alone.
  if (/^(the\s+)?(st|stop|stopped|stuff|step|stap|stob|stup|quite)[\s.!]*$/i.test(text)) return true;
  return /^((please|ok|okay|no|oh|ember)[\s,.!]+)*(stop|cancel|abort|never\s?mind|forget\s+(it|that)|be\s+quiet|quiet|hush|shut\s+up|that'?s\s+enough|enough)([\s,.!]+(stop|it|that|now|please|talking|everything|ember|already))*[\s.!,]*$/i.test(text);
}

/** "Thanks." "No, that's all." "Okay, great.": said in a follow-up window, the conversation is over (nothing is sent). */
export function isCloser(text: string): boolean {
  const word = String.raw`(thanks|thank\s+you(\s+very\s+much)?|cheers|great|perfect|cool|nice|awesome|wonderful|excellent|good|got\s+it|that'?s\s+(all|it|everything)|that\s+is\s+all|nothing(\s+else)?|no|nope|no\s+thanks|not\s+now|i'?m\s+(good|done|fine|all\s+set)|all\s+(good|set)|bye|goodbye)`;
  return new RegExp(String.raw`^((okay|ok|alright|all\s+right|oh|so|yeah|um|uh)[\s,.!]+)*${word}([\s,.!]+(${word}|ember|for\s+now|then|anyway))*[\s.!,]*$`, "i").test(text);
}

/** "Um." "Hmm.": a filler, not a request (the window keeps listening). */
export function isFiller(text: string): boolean {
  return /^((u+m+|u+h+|h*m+|mhm|a+h+|o+h+|e+r+m*)[\s,.!?…-]*)+$/i.test(text);
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
 * The frames it missed are replayed then, from 12 frames before the sound started (out of a
 * calm room): where its stream starts changes what it hears (measured: a few frames either way
 * costs wakes). Speech that doesn't stand out from the room's noise gets the last 24 frames.
 */
const MIC_REST_FRAMES = 16;
const MIC_REPLAY_FRAMES = 12;
const MIC_QUIET_REPLAY_FRAMES = 24;
/** Frames kept while the spotter rests (the voice check's delay is well within it); a room this many frames calm has a clear start of sound. */
const MIC_TAIL_FRAMES = 32;
const CALM_FRAMES = 8;
/** A pause is 3 quiet frames after at least 10 of sound; a word spotted then is checked 256 ms later. */
const PAUSE_FRAMES = 3;
const SOUND_FRAMES = 10;
const PAUSED_CHECK_MS = 256;
/** The voice check wakes on a frame this far above the room's noise, runs for 2 s after the last one, and starts with 8 frames of context. */
const CHECK_WAKE_RATIO = 1.3;
const CHECK_HANG_FRAMES = 63;
const CHECK_CONTEXT_FRAMES = 8;
/** The room's noise is learned in its first 3 s (a noisy room in about 2 s), then follows slowly. */
const FLOOR_LEARN_FRAMES = 94;
/**
 * The speakers' last 3 s are kept; their stream is only spotted (from a fresh stream, over those 3 s and then
 * as it plays) while a wake or a stop waits for the speakers check: spotting everything that plays cost 8–11 %
 * of a core. Speakers silent this long before a wake can't have played "Hey Ember" (phrase + spotter delay).
 */
const SPEAKERS_RING_FRAMES = 94;
const SPEAKERS_QUIET_MS = 1500;
/** Longest Ember counts as speaking without hearing so again (the mic window repeats it while it speaks). */
const SELF_SPEAKING_MAX_MS = 60_000;
/** The microphone's last 2 s, for the stop phrase's transcript check. */
const RECENT_SECONDS = 2;
/**
 * A request ends when the speaker's voice does, even while other people talk on (the VAD hears their speech
 * too). Loudness is the median frame of a stretch (a TV's loud syllables don't count, nor do the speaker's own
 * short pauses): the request's own is its loudest 0.3 s (9 frames) in this window, the wake phrase's included.
 * When the last half second (16 frames) stays 12 dB under that for 12 frames, the request is over: about 20
 * frames after the voice ends, just past the VAD's own 0.6 s of silence, so in a quiet room the VAD still ends
 * it. What goes to the recognizer keeps 10 frames around the voice (it drops a last word cut at its very end;
 * right after a wake, the voice starts where it's within 6 dB of that loudness: the wake phrase is said up close);
 * a cut segment with no 0.3 s that loud is other people's talk, and is dropped. Speech is cut after 10 s
 * whatever it is (the VAD's own maximum isn't a hard one: 53 s was seen), and never more than 12 s is
 * transcribed (the recognizer's time grows with it, and it loops).
 */
const QUIET_RATIO = 10 ** -1.2;
const CLOSE_RATIO = 10 ** -0.6;
const LOUDNESS_FRAMES = 16;
const QUIET_END_FRAMES = 12;
const LOUD_FRAMES = 9;
const KEEP_AFTER_FRAMES = 10;
const SPEECH_CAP_FRAMES = 313;
const MAX_TRANSCRIBE = 12 * SAMPLE_RATE;
/** Speech frames tracked per segment (the cap, plus the VAD's lead-in). */
const SEGMENT_FRAMES = SPEECH_CAP_FRAMES + 32;
/** Frames heard in the tail after Ember stops speaking (13 frames: 400 ms), replayed if the user was already replying: sound going on 8 frames past it. */
const TAIL_FRAMES = 13;
const TAIL_HOLD_FRAMES = 8;
/** The mic hears the speakers this much later than their own stream (latency and echo): the tail ends this long after they went quiet (ms). */
const SPEAKERS_ECHO_MS = 160;

/**
 * `ms`: the window's length (it starts again after Ember speaks); `first`: nothing heard yet since the wake;
 * `checkAt`: when the wake's transcript check runs (null: none pending), for `keyword`.
 */
type Mode =
  | { kind: "idle" }
  | { kind: "listening"; until: number; ms: number; heardSpeech: boolean; first: boolean; reason: "wake" | "follow-up"; checkAt: number | null; keyword: string };

export class VoiceEngine {
  private mode: Mode = { kind: "idle" };
  private ring: Ring;
  private recent = new Ring(RECENT_SECONDS);
  private selfSpeakingUntil = 0;
  /** When Ember said it had stopped speaking (the tail after it is under way), and the frames heard since. */
  private tailFrom = 0;
  private tail: { frame: Float32Array; energy: number; at: number }[] = [];
  private monitorHits: { keyword: string; at: number }[] = [];
  /** A spotted wake word waiting out the speakers check; a spotted stop waiting out it and its transcript check. */
  private pendingWake: { keyword: string; at: number; paused: boolean } | null = null;
  private pendingStop: { at: number; checkAt: number | null } | null = null;
  /** The speakers' recent frames, when they last made a sound and last sent a frame, and whether their spotter runs. */
  private speakers: { frame: Float32Array; at: number; sound: boolean }[] = [];
  private monitorSoundAt = Number.NEGATIVE_INFINITY;
  private monitorFrameAt = Number.NEGATIVE_INFINITY;
  private monitorSpotting = false;
  private wasSpeaking = false;
  private frames = 0;
  /** Quiet frames in a row, and the most recent ones (replayed to the spotter when sound returns). */
  private quietRun = 0;
  /** The room's noise level (RMS): follows the quietest frames down at once and rises only slowly. */
  private floor = 0;
  private quietTail: Float32Array[] = [];
  /** Where in the tail the sound started (the first frame well above a calm room's noise), or -1; and how long the room has been calm. */
  private loudAt = -1;
  private calmRun = 0;
  /** Frames of sound, then of quiet, in a row (a pause after speech lets the spotter finish early). */
  private soundRun = 0;
  private pauseRun = 0;
  /** Frames left before the voice check rests (the room was steady), and the frame it last heard. */
  private unsteady = 0;
  private checkedAt = -1;
  /** Listening: the window's speech at its loudest (median energy of 9 frames), the energies of the segment under way, and how long it has been quiet against it. */
  private peak = 0;
  private segment: number[] = [];
  private quietFor = 0;
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
    if (!on) {
      if (this.selfSpeakingUntil > now) this.tailFrom = now;
      this.selfSpeakingUntil = Math.min(this.selfSpeakingUntil, now + tailMs);
      return;
    }
    this.selfSpeakingUntil = now + SELF_SPEAKING_MAX_MS;
    this.tailFrom = 0;
    this.tail = [];
    if (this.mode.kind !== "listening") return;
    // What the VAD heard so far is Ember's voice, or was cut by it: start afresh once Ember is done.
    this.resetListening();
    if (this.wasSpeaking) { this.wasSpeaking = false; this.emit({ type: "speech", on: false }); }
  }

  /** Listen for a follow-up without the wake word (the window starts once Ember has finished speaking). */
  followUp(ms = 8000): void {
    if (this.mode.kind === "listening") { this.mode.until = Math.max(this.mode.until, this.now() + ms); return; }
    this.resetListening();
    this.peak = 0;
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: false, reason: "follow-up", checkAt: null, keyword: "" };
    this.emit({ type: "listening", on: true, reason: "follow-up", window: "follow-up" });
  }

  /** Stop listening for a command, and drop a wake or stop still being checked (the kill switch, Esc). */
  cancel(): void {
    this.pendingWake = null;
    this.pendingStop = null;
    this.ring.clear();
    if (this.mode.kind === "listening") this.endListening("stop");
    else this.resetListening();
  }

  /** Speaker output (PulseAudio monitor), for rejecting wake words and stops that come from videos (or Ember's own voice). */
  feedMonitor(frame: Float32Array): void {
    const at = this.now();
    this.monitorFrameAt = at;
    const sound = rmsOf(frame) >= (this.o.silenceRms ?? 0.0008);
    if (sound) this.monitorSoundAt = at;
    this.speakers.push({ frame, at, sound });
    if (this.speakers.length > SPEAKERS_RING_FRAMES) this.speakers.shift();
    if (this.monitorSpotting) this.spotSpeakers(frame, at);
  }

  /** One frame of microphone audio, 16 kHz mono. */
  feed(frame: Float32Array): void {
    const now = this.now();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const energy = sum / Math.max(1, frame.length);
    const rms = Math.sqrt(energy);
    this.frames++;
    this.recent.push(frame);

    // Nobody is saying "Hey Ember" unless someone is speaking: the spotter (most of the idle CPU) rests
    // after half a second without speech, and the frames it missed are replayed when speech returns.
    // True silence is never speech. Otherwise the voice check decides: it hears speech under a fan,
    // where loudness can't (measured: in steady noise at 3–6 dB SNR, most wakes were missed). It only runs while the room
    // isn't steady, so a quiet room costs nothing. The room's noise floor is minimum statistics, so
    // continuous speech or TV, which dips between words, can't drag it up.
    const base = this.o.silenceRms ?? 0.0008;
    this.floor = Math.min(rms, Math.max(this.floor, base / 4) * (this.frames <= FLOOR_LEARN_FRAMES ? 1.05 : 1.003));
    const quiet = rms < base || (this.mode.kind === "idle" && !this.maybeSpeech(frame, rms));
    this.quietRun = quiet ? this.quietRun + 1 : 0;
    let toSpot: Float32Array[] = [frame];
    const loud = rms >= Math.max(base, this.floor * 2.5) && this.calmRun >= CALM_FRAMES;
    this.calmRun = rms < Math.max(base, this.floor * CHECK_WAKE_RATIO) ? this.calmRun + 1 : 0;
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
    // A pause after speech: the spotter would otherwise wait for 0.3–0.45 s more audio before deciding on the
    // last words ("Hey Ember." then a pause: the cue came 0.44 s after the name; now 0.1 s).
    const sound = rms >= Math.max(base, this.floor * 2.5);
    let paused = false;
    if (sound) { if (this.pauseRun >= PAUSE_FRAMES) this.soundRun = 0; this.soundRun++; this.pauseRun = 0; }
    else if (++this.pauseRun === PAUSE_FRAMES && this.soundRun >= SOUND_FRAMES && toSpot.length && this.backend.padSpot) {
      const early = this.backend.padSpot();
      paused = early.length > 0;
      keywords.push(...early);
    }

    const checkAt = (at: number) => (this.o.verifyWake === false ? null : at + (this.o.checkAfterMs ?? (paused ? PAUSED_CHECK_MS : 0)));
    for (const keyword of keywords) {
      if (keyword === "ember_stop") {
        // The kill phrase works in every state (also while Ember speaks: that's when it's needed). It goes once
        // the speakers didn't say it and the recognizer heard "Ember, stop" (not "September stopped").
        if (!this.pendingStop) { this.pendingStop = { at: now, checkAt: checkAt(now) }; this.watchSpeakers(); }
        continue;
      }
      if (now < this.selfSpeakingUntil) { this.emit({ type: "rejected", keyword, reason: "self" }); continue; }
      if (this.mode.kind === "idle" && !this.pendingWake) { this.pendingWake = { keyword, at: now, paused }; this.watchSpeakers(); }
    }
    this.monitorHits = this.monitorHits.filter(h => now - h.at < 5000);
    this.decideStop(now);

    // A wake is accepted once we're sure the speakers didn't just say it.
    if (this.pendingWake) {
      const w = this.pendingWake;
      if (this.saidBySpeakers(w.keyword, w.at)) {
        this.pendingWake = null;
        this.emit({ type: "rejected", keyword: w.keyword, reason: "speakers" });
      } else if (this.speakersClear(w.at, now)) {
        this.pendingWake = null;
        // Ember shows it's listening at once. The transcript check takes the wake back if the recognizer
        // clearly heard another word ("Amber"). Mid-speech the spotter fires 0.45 s after the word, so it
        // checks at once (checking later took back more real wakes: of 90, 3 at once, 8 after 128 ms, 6 after
        // 256 ms); at a pause it fires sooner, and the check waits for what followed the word.
        this.announceWake(w.keyword, this.o.verifyWake === false ? null : w.at + (this.o.checkAfterMs ?? (w.paused ? PAUSED_CHECK_MS : 0)));
        if (this.mode.kind === "listening" && this.mode.checkAt === null) this.replayPreRoll();
      }
    }
    if (this.monitorSpotting && !this.pendingWake && !this.pendingStop) {
      this.monitorSpotting = false;
      this.backend.resetMonitor?.();
    }

    if (this.mode.kind === "idle") {
      this.ring.push(frame);
      return;
    }
    if (this.mode.checkAt !== null) {
      // What's heard is held (with the pre-roll) until the wake is checked, then replayed.
      this.ring.push(frame);
      if (now < this.mode.checkAt) return;
      this.mode.checkAt = null;
      const heard = this.backend.transcribe(this.ring.read());
      if (heard && heardOtherWord(heard) && isStop(stripWake(heard, true))) {
        // "Hey, Amber, stop.": whoever it was for, stopping is the safe side (and it's often "Ember" misheard).
        this.emit({ type: "stop" });
        this.ring.clear();
        this.endListening("stop");
      } else if (heard && heardOtherWord(heard)) {
        this.emit({ type: "rejected", keyword: this.mode.keyword, reason: "check", heard });
        this.ring.clear();
        this.endListening("rejected");
      } else {
        this.replayPreRoll();
      }
      return;
    }
    // The speakers went quiet (their own stream says so): Ember's voice is over, the tail can end now.
    if (this.tailFrom && now < this.selfSpeakingUntil && now - this.monitorFrameAt < 200 && now - this.monitorSoundAt >= SPEAKERS_ECHO_MS) this.selfSpeakingUntil = now;
    if (now < this.selfSpeakingUntil) {
      // Ember's own voice (it plays outside the browser's echo cancellation) is not a request: the VAD isn't fed,
      // and the window stays open until Ember has finished. Otherwise Ember answers itself, again and again.
      this.mode.until = Math.max(this.mode.until, now + this.mode.ms);
      if (this.tailFrom) { this.tail.push({ frame, energy, at: now }); if (this.tail.length > TAIL_FRAMES) this.tail.shift(); }
      return;
    }
    if (this.tailFrom && !this.afterTail(frame, energy, now)) return;
    this.listen(frame, energy);
    if (this.mode.kind === "listening" && now > this.mode.until && (!this.backend.speaking() || !this.segmentStandsOut())) {
      // Time's up, and nobody (or only the room's other talk) is speaking.
      for (const seg of this.backend.flushVad()) this.handleSegment(this.trim(seg));
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

  /** A wake or stop was spotted while the speakers play: spot what they played (their last 3 s, then as it comes). */
  private watchSpeakers(): void {
    if (this.monitorSpotting || !this.backend.spotMonitor || this.now() - this.monitorSoundAt > SPEAKERS_QUIET_MS) return;
    this.monitorSpotting = true;
    this.backend.resetMonitor?.();
    // Like the microphone's spotter, from 12 frames before their sound last started out of silence (a stream fed
    // a long silence first misses the phrase).
    let from = 0;
    for (let i = this.speakers.length - 1, quiet = 0, heard = false; i >= 0; i--) {
      heard ||= this.speakers[i].sound;
      quiet = this.speakers[i].sound || !heard ? 0 : quiet + 1;
      if (quiet > MIC_REST_FRAMES) { from = i + quiet - MIC_REPLAY_FRAMES; break; }
    }
    for (const s of this.speakers.slice(Math.max(0, from))) this.spotSpeakers(s.frame, s.at);
    // Decided on all they played up to now (the microphone's spotter may have decided early, at a pause).
    const at = this.speakers.at(-1)?.at ?? this.now();
    for (const keyword of this.backend.padMonitor?.() ?? []) this.monitorHits.push({ keyword, at });
  }

  private spotSpeakers(frame: Float32Array, at: number): void {
    for (const keyword of this.backend.spotMonitor?.(frame) ?? []) this.monitorHits.push({ keyword, at });
  }

  private saidBySpeakers(keyword: string, at: number): boolean {
    const window = this.o.rejectWindowMs ?? 400;
    return this.monitorHits.some(h => h.keyword === keyword && Math.abs(h.at - at) <= window);
  }

  /** The speakers can't have said what was spotted at `at`: their window has passed, or they were quiet all along. */
  private speakersClear(at: number, now: number): boolean {
    return !this.backend.spotMonitor || now - at >= (this.o.rejectWindowMs ?? 400) || now - this.monitorSoundAt > SPEAKERS_QUIET_MS;
  }

  private decideStop(now: number): void {
    const s = this.pendingStop;
    if (!s) return;
    if (this.saidBySpeakers("ember_stop", s.at)) {
      this.pendingStop = null;
      this.emit({ type: "rejected", keyword: "ember_stop", reason: "speakers" });
      return;
    }
    if (!this.speakersClear(s.at, now) || (s.checkAt !== null && now < s.checkAt)) return;
    this.pendingStop = null;
    if (s.checkAt !== null) {
      const heard = this.backend.transcribe(this.recent.read());
      if (heard && heardOtherStop(heard)) { this.emit({ type: "rejected", keyword: "ember_stop", reason: "check", heard }); return; }
    }
    this.emit({ type: "stop" });
    if (this.mode.kind === "listening") this.endListening("stop");
    this.pendingWake = null;
  }

  private announceWake(keyword: string, checkAt: number | null): void {
    this.emit({ type: "wake", keyword });
    this.resetListening();
    this.peak = 0;
    const ms = this.o.waitForSpeechMs ?? 6000;
    this.mode = { kind: "listening", until: this.now() + ms, ms, heardSpeech: false, first: true, reason: "wake", checkAt, keyword };
    this.emit({ type: "listening", on: true, reason: "wake", window: "wake" });
  }

  /** Replays what was said just before (and during) the wake word, so a one-breath request isn't cut. */
  private replayPreRoll(): void {
    const pre = this.ring.read();
    this.ring.clear();
    for (let i = 0; i < pre.length && this.mode.kind === "listening"; i += 512) {
      const f = pre.subarray(i, i + 512);
      let sum = 0;
      for (let k = 0; k < f.length; k++) sum += f[k] * f[k];
      this.listen(f, sum / Math.max(1, f.length));
    }
  }

  /**
   * Ember's tail is over. If the user was already replying, what they said during the tail is heard too: from
   * the speakers' own silence when their stream says when that was; otherwise, once the sound has gone on for
   * 8 frames past the tail (Ember's own voice, when it was said to have ended early, stops sooner), from where
   * it went quiet in the tail (2 quiet frames: a pause between Ember's own words is shorter). Returns whether
   * this frame is still to be heard (false: it's held, or was heard with the tail).
   */
  private afterTail(frame: Float32Array, energy: number, now: number): boolean {
    const quiet = (e: number) => Math.sqrt(e) < Math.max(this.o.silenceRms ?? 0.0008, this.floor * 2.5);
    const done = (from: number, then: { frame: Float32Array; energy: number }[] = []) => {
      const tail = this.tail;
      this.tail = [];
      this.tailFrom = 0;
      if (from >= 0) for (const t of [...tail.slice(from), ...then]) this.listen(t.frame, t.energy);
    };
    if (now - this.monitorFrameAt < 200) {
      const quietAt = this.monitorSoundAt + SPEAKERS_ECHO_MS;
      done(this.tail.findIndex(t => t.at >= quietAt));
      return true;
    }
    const held = this.tail.filter(t => t.at >= this.selfSpeakingUntil);
    if (quiet(energy)) { done(-1); return true; } // nothing, or only Ember's last sounds, went on past the tail
    this.tail.push({ frame, energy, at: now });
    if (held.length + 1 < TAIL_HOLD_FRAMES) return false;
    const tail = this.tail.slice(0, this.tail.length - held.length - 1);
    let from = tail.length;
    for (let i = tail.length - 1; i > 0; i--) if (quiet(tail[i].energy) && quiet(tail[i - 1].energy)) { from = i - 1; break; }
    done(from);
    return false;
  }

  /** Feeds a frame to the VAD, follows the speaker's loudness, and ends a request their voice has left (or that ran on too long). */
  private listen(frame: Float32Array, energy: number): void {
    const segments = this.backend.vad(frame);
    const speaking = this.backend.speaking();
    if (speaking !== this.wasSpeaking) {
      this.wasSpeaking = speaking;
      this.emit({ type: "speech", on: speaking });
      if (speaking && this.mode.kind === "listening") this.mode.heardSpeech = true;
    }
    if (speaking || segments.length) {
      this.segment.push(energy);
      if (this.segment.length > SEGMENT_FRAMES) this.segment.shift();
      const n = this.segment.length;
      if (speaking && n >= LOUD_FRAMES) this.peak = Math.max(this.peak, median(this.segment, n - LOUD_FRAMES, n));
      this.quietFor = median(this.segment, n - LOUDNESS_FRAMES, n) < this.peak * QUIET_RATIO ? this.quietFor + 1 : 0;
    }
    for (const seg of segments) this.handleSegment(this.trim(seg, false));
    if (segments.length && !speaking) this.endSegment();
    if (this.mode.kind !== "listening" || !speaking) return;
    if (this.quietFor >= QUIET_END_FRAMES || this.segment.length >= SPEECH_CAP_FRAMES) {
      for (const seg of this.backend.flushVad()) this.handleSegment(this.trim(seg));
      this.endSegment();
    }
  }

  private endSegment(): void {
    this.segment = [];
    this.quietFor = 0;
  }

  /** The VAD starts afresh (the window's loudest frame is kept). */
  private resetListening(): void {
    this.backend.resetVad();
    this.endSegment();
  }

  /** Does anything in the segment under way stand out like the speaker's own voice (within 12 dB of the request's loudness)? */
  private segmentStandsOut(): boolean {
    return this.loudFrames().first >= 0;
  }

  /**
   * The first and last frames of the segment under way loud enough to be the speaker's (the 9 frames around
   * them), or -1; and the first within 6 dB of the request's loudness (the wake phrase is said up close: what
   * the pre-roll heard before it, quieter, is someone else).
   */
  private loudFrames(): { first: number; last: number; close: number } {
    const e = this.segment, half = LOUD_FRAMES >> 1, threshold = this.peak * QUIET_RATIO, closeThreshold = this.peak * CLOSE_RATIO;
    let first = -1, last = -1, close = -1;
    for (let i = 0; i < e.length; i++) {
      const m = median(e, i - half, i + half + 1);
      if (m < threshold) continue;
      if (first < 0) first = i;
      if (close < 0 && m >= closeThreshold) close = i;
      last = i;
    }
    return { first, last, close };
  }

  /**
   * A segment as it goes to the recognizer: a flushed one (it ends with the last frame heard) loses what came
   * after the speaker's voice left (bar 10 frames) and before it began; one with none of it is dropped. Natural
   * ends (silence) are kept whole. Never more than 12 s.
   */
  private trim(seg: Float32Array, flushed = true): Float32Array | null {
    const { first, last, close } = this.loudFrames();
    if (first < 0 && this.segment.length) return null;
    let from = 0, to = seg.length;
    if (flushed && first >= 0) {
      const n = this.segment.length, start = this.mode.kind === "listening" && this.mode.first && close >= 0 ? close : first;
      to = Math.max(0, seg.length - Math.max(0, n - 1 - last - KEEP_AFTER_FRAMES) * 512);
      from = Math.max(0, seg.length - (n - start + KEEP_AFTER_FRAMES) * 512);
    }
    return seg.subarray(from, Math.min(to, from + MAX_TRANSCRIBE));
  }

  private handleSegment(seg: Float32Array | null): void {
    if (this.mode.kind !== "listening" || !seg?.length) return;
    const t0 = this.now();
    const text = stripWake(this.backend.transcribe(seg), this.mode.first);
    this.mode.first = false;
    if (!text || /^[\s.,!?]*$/.test(text) || isFiller(text)) {
      // Only the wake phrase (or a cough, or "um"): keep listening for the request.
      this.mode.until = Math.max(this.mode.until, this.now() + 4000);
      return;
    }
    if (isStop(text)) {
      // "Hey Ember, stop": the kill phrase in other words, handled here and never sent anywhere (once: the spotter may have heard it too).
      this.pendingStop = null;
      this.emit({ type: "stop" });
      this.endListening("stop");
      return;
    }
    if (this.mode.reason === "follow-up" && isCloser(text)) {
      // "Thanks.": nothing more to do (like a window that heard nothing).
      this.endListening("timeout");
      return;
    }
    this.emit({ type: "utterance", text, ms: this.now() - t0 });
    this.endListening("done");
  }

  private endListening(reason: "timeout" | "done" | "stop" | "rejected"): void {
    const window = this.mode.kind === "listening" ? this.mode.reason : "wake";
    this.mode = { kind: "idle" };
    this.wasSpeaking = false;
    this.tail = [];
    this.tailFrom = 0;
    this.resetListening();
    this.emit({ type: "listening", on: false, reason, window });
  }
}

/** The median of `e[from..to)` (clipped to it). */
function median(e: number[], from: number, to: number): number {
  const a = e.slice(Math.max(0, from), Math.min(e.length, to)).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
}

function rmsOf(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}
