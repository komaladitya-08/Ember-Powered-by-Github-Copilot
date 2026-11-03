/**
 * Voice Match in the voice process (see voiceprint.ts): VoiceGate holds each request the engine heard until its
 * voiceprint has been compared with the owner's, then lets it through or turns it away; Enrolment takes the owner's
 * phrases and makes their voiceprint. The model is behind Printer, so both are tested without it.
 */

import { BARE_NAME, type VoiceEvent } from "./engine";
import { ENROL_MIN_SECONDS, ENROL_PHRASES, VOICE_MATCH_THRESHOLD, WAKE_MATCH_THRESHOLD, averagePrint, consistentPrints, similarity } from "./voiceprint";
import { gateMatches } from "./adapt";

/** Makes a voiceprint (unit length) of 16 kHz audio. */
export interface Printer {
  print(samples: Float32Array): Promise<Float32Array>;
}

/** What enrolment tells main: `got` of `of` phrases kept; `again`: the last one wasn't kept (`why`). */
export type EnrolState =
  | { state: "listening" | "heard"; got: number; of: number }
  | { state: "again"; got: number; of: number; why: "short" | "unlike" | "failed" }
  | { state: "done"; got: number; of: number; print: Float32Array }
  | { state: "cancelled"; got: number; of: number };

/**
 * The least voice a request needs for Voice Match to vouch for it (`verified`, what a spoken yes and turning "Work
 * without asking" on need): VOICE_MATCH_THRESHOLD was tuned on requests of about 2.5 s (voiceprint.ts), and a bare
 * "allow" (0.4 s) is too short to tell voices apart (security review of #127).
 */
export const APPROVAL_MIN_SECONDS = 1.5;

/** The voice process's frames (32 ms at 16 kHz): voice is counted frame by frame. */
const FRAME = 512;
/** A frame is voiced at this RMS or more, and at least this share of the clip's loudest frame (silence padding isn't). */
const VOICED_RMS = 0.003;
const VOICED_SHARE = 0.125;
/** "Hey Ember" takes about this much voice (measured on the test clips: 0.55–0.75 s); what follows it is the request. */
const WAKE_VOICED_SECONDS = 0.8;

/** Which frames of `audio` carry voice (by loudness against the clip's loudest frame: no VAD runs in this thread). */
export function voicedFrames(audio: Float32Array): boolean[] {
  const rms: number[] = [];
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    let sum = 0;
    for (let j = i; j < i + FRAME; j++) sum += audio[j] * audio[j];
    rms.push(Math.sqrt(sum / FRAME));
  }
  const peak = rms.reduce((m, x) => Math.max(m, x), 0);
  return rms.map(x => x >= VOICED_RMS && x >= peak * VOICED_SHARE);
}

/** How many seconds of `audio` carry voice (silence before, after or between words isn't counted). */
export function voicedSeconds(audio: Float32Array): number {
  return (voicedFrames(audio).filter(Boolean).length * FRAME) / 16_000;
}

/**
 * What follows the wake phrase in a request's audio: when it starts with it (`withWake`: "Hey Ember, allow"), the clip
 * from just after its first WAKE_VOICED_SECONDS of voice; otherwise the clip as it is (the same object).
 */
export function afterWakePhrase(audio: Float32Array, withWake: boolean): Float32Array {
  if (!withWake) return audio;
  const voiced = voicedFrames(audio);
  let seen = 0;
  for (let f = 0; f < voiced.length; f++) {
    if (voiced[f]) seen++;
    if ((seen * FRAME) / 16_000 >= WAKE_VOICED_SECONDS) return audio.subarray((f + 1) * FRAME);
  }
  return audio.subarray(audio.length);
}

export class VoiceGate {
  private owner: Float32Array | null = null;
  /**
   * What Voice Match learnt (adapt.ts): the enrolment's own print, which a request must match by ADAPT.anchorFloor too,
   * and the threshold for the print in use (adaptedThreshold). Null and the constructor's threshold: nothing learnt.
   */
  private anchor: Float32Array | null = null;
  private learntThreshold: number | null = null;
  /** Requests waiting for their check finish in order (a later one never overtakes an earlier). */
  private queue: Promise<void> = Promise.resolve();
  /** A wake being looked at (WAKE_MATCH_THRESHOLD): it and what followed it wait, but for a stop. */
  private held: { e: VoiceEvent; audio: Float32Array | null; withWake: boolean }[] | null = null;
  /** A turned-away wake's window is being cancelled: what it emits meanwhile goes nowhere. */
  private dropping = false;
  /**
   * Told of each request that matched the owner and was `verified` (sent first), with its voiceprint, its score and its
   * audio: what Voice Match may learn from (adapt-sample.ts, adapt.ts). Null: nothing is.
   */
  onSample: ((print: Float32Array, score: number, audio: Float32Array) => void) | null = null;

  /** `cancelWindow`: ends the engine's listening window (a wake turned away at its first look); it emits synchronously. */
  constructor(
    private printer: () => Printer,
    private send: (e: VoiceEvent) => void,
    private onError: (err: unknown) => void,
    private threshold = VOICE_MATCH_THRESHOLD,
    private cancelWindow?: () => void,
    private wakeThreshold = WAKE_MATCH_THRESHOLD,
  ) {}

  /**
   * The owner's voiceprint (null: Voice Match off, every voice is heard). `learnt`: it learnt from the owner's requests
   * since enrolment (adapt.ts), so the enrolment is checked too and the threshold is the learnt print's.
   */
  setOwner(print: Float32Array | null, learnt?: { anchor: Float32Array; threshold: number } | null): void {
    this.owner = print;
    this.anchor = print && learnt ? learnt.anchor : null;
    this.learntThreshold = print && learnt ? Math.max(this.threshold, learnt.threshold) : null;
  }

  /** The owner's match for a request's voiceprint (adapt.ts gateMatches). */
  private matches(print: Float32Array, owner: Float32Array): boolean {
    return gateMatches(print, owner, this.learntThreshold ?? this.threshold, this.anchor);
  }

  get on(): boolean {
    return !!this.owner;
  }

  /** The owner's voiceprint in use (null: Voice Match off). */
  get ownerPrint(): Float32Array | null {
    return this.owner;
  }

  /**
   * An event from the engine. A request ("utterance") is checked when Voice Match is on and its audio is known; a
   * stop never is (anyone may stop Ember), nor is anything else. A request turned away is followed by the end of its
   * window as main knows it for a wake taken back ("rejected"), so the bubble goes back to what it showed.
   */
  event(e: VoiceEvent, audio: Float32Array | null, withWake = false): void {
    if (this.dropping) { if (e.type === "stop") this.send(e); return; }
    if (this.held) { if (e.type === "stop") this.send(e); else this.held.push({ e, audio, withWake }); return; }
    const owner = this.owner;
    // First look, at the wake phrase: a clearly other voice is turned away before main shows Ember listening. (The bare
    // name shows with its request, which is checked as it comes.)
    if (e.type === "wake" && owner && audio?.length && e.keyword !== BARE_NAME) { this.lookAtWake(e, audio, owner); return; }
    if (e.type !== "utterance" || !owner || !audio?.length) { this.send(e); return; }
    const check = this.printer().print(audio);
    // It is awaited only when the requests before it are done: a failure meanwhile would be an unhandled rejection,
    // which ends the voice process. The await below still sees it.
    check.catch(() => undefined);
    this.queue = this.queue.then(async () => {
      let score: number, print: Float32Array;
      try {
        print = await check;
        score = similarity(print, owner);
      } catch (err) {
        // The model failed: the request is heard (Voice Match failing must not leave Ember deaf), and main is told.
        this.onError(err);
        this.send(e);
        return;
      }
      // Matched: said so, so a spoken yes to a question can be taken (main's voice-answer.ts). A request heard without a
      // check (Voice Match off, or the model failed above) carries no `verified`, and can't approve anything.
      // (Only with enough voice to go on, APPROVAL_MIN_SECONDS of voiced frames after the wake phrase, checked on its
      // own: the threshold was tuned on 2.5 s requests, a bare "allow" is too short to tell voices apart, and a recording
      // of the owner's "Hey Ember" mustn't make up the rest. Such a match says `short`.)
      if (this.matches(print, owner)) {
        const heard = await this.vouched(e, audio, owner, withWake);
        this.send(heard);
        if (heard.type === "utterance" && heard.verified) this.onSample?.(print, score, audio);
        return;
      }
      this.send({ type: "rejected", keyword: "", reason: "voice", score: Math.round(score * 1000) / 1000 });
      this.send({ type: "listening", on: false, reason: "rejected", window: e.window });
    });
  }

  /**
   * The owner's request (it matched as a whole) as main gets it: `verified` when what follows the wake phrase holds at
   * least APPROVAL_MIN_SECONDS of voice and matches the owner on its own; otherwise `short`. A check that fails says
   * neither (heard, but it can't approve anything).
   */
  private async vouched(e: Extract<VoiceEvent, { type: "utterance" }>, audio: Float32Array, owner: Float32Array, withWake: boolean): Promise<VoiceEvent> {
    const rest = afterWakePhrase(audio, withWake);
    if (voicedSeconds(rest) < APPROVAL_MIN_SECONDS) return { ...e, short: true };
    if (rest === audio) return { ...e, verified: true };
    try {
      return this.matches(await this.printer().print(rest), owner) ? { ...e, verified: true } : { ...e, short: true };
    } catch (err) {
      this.onError(err);
      return e;
    }
  }

  private lookAtWake(e: Extract<VoiceEvent, { type: "wake" }>, audio: Float32Array, owner: Float32Array): void {
    this.held = [];
    const look = this.printer().print(audio).then(p => similarity(p, owner), (err: unknown) => {
      // The model failed: the wake stands (its request is checked as it comes), and main is told.
      this.onError(err);
      return 1;
    });
    this.queue = this.queue.then(async () => {
      const score = await look;
      const held = this.held ?? [];
      this.held = null;
      if (score >= this.wakeThreshold) {
        this.send(e);
        for (const h of held) this.event(h.e, h.audio, h.withWake);
        return;
      }
      // Main never saw this wake: nothing it held is sent, and the engine's window ends unseen.
      this.send({ type: "rejected", keyword: e.keyword, reason: "voice", score: Math.round(score * 1000) / 1000 });
      if (held.some(h => h.e.type === "listening" && !h.e.on)) return;
      this.dropping = true;
      try { this.cancelWindow?.(); } finally { this.dropping = false; }
    });
  }
}

/** Enrolment: the owner says `of` phrases (any speech the VAD hands over counts as one); their voiceprint comes at the end. */
export class Enrolment {
  private prints: Float32Array[] = [];
  private tries = 0;
  private finished = false;
  /** Gives up after this many phrases heard (some kept, some said again). */
  private readonly maxTries: number;

  constructor(private printer: Printer, private tell: (s: EnrolState) => void, readonly of = ENROL_PHRASES.length) {
    this.maxTries = of * 3;
    tell({ state: "listening", got: 0, of });
  }

  /** A phrase the VAD heard. */
  async heard(samples: Float32Array): Promise<void> {
    if (this.finished) return;
    if (samples.length < ENROL_MIN_SECONDS * 16_000) { this.again("short"); return; }
    this.tries++;
    let print: Float32Array;
    try {
      print = await this.printer.print(samples);
    } catch {
      this.again("failed");
      return;
    }
    if (this.finished) return;
    this.prints.push(print);
    const { keep, dropped } = consistentPrints(this.prints);
    this.prints = keep.map(i => this.prints[i]);
    if (dropped !== null) { this.again("unlike"); return; }
    if (this.prints.length >= this.of) {
      this.finished = true;
      this.tell({ state: "done", got: this.prints.length, of: this.of, print: averagePrint(this.prints) });
      return;
    }
    this.tell({ state: "heard", got: this.prints.length, of: this.of });
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.tell({ state: "cancelled", got: this.prints.length, of: this.of });
  }

  get done(): boolean {
    return this.finished;
  }

  private again(why: "short" | "unlike" | "failed"): void {
    if (this.tries >= this.maxTries) { this.cancel(); return; }
    this.tell({ state: "again", got: this.prints.length, of: this.of, why });
  }
}
