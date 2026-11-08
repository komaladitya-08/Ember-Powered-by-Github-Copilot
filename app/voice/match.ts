/**
 * Voice Match in the voice process (see voiceprint.ts): VoiceGate holds each request the engine heard until its
 * voiceprint has been compared with the owner's, then passes it on, saying whether Voice Match vouches for it; Enrolment
 * takes the owner's phrases and makes their voiceprint. The model is behind Printer, so both are tested without it.
 *
 * It never decides whether Ember hears someone (owner decision of 2026-11-05). It used to: on a real laptop's microphone
 * the owner's own requests of about a second scored 0.50–0.74, under the 0.75 measured on 2.5 s of clean LibriSpeech, and
 * 45 of 112 requests and wakes in one evening were turned away: Ember showed "Listening…" and stopped. Other people's
 * voices score in that same range, so no threshold tells them apart there. What Voice Match still decides is what a voice
 * may approve (`verified`): a request it doesn't vouch for is heard like one with Voice Match off.
 */

import type { VoiceEvent } from "./engine";
import { ENROL_MIN_SECONDS, ENROL_PHRASES, VOICE_MATCH_THRESHOLD, averagePrint, consistentPrints, similarity } from "./voiceprint";
import { gateMatches } from "./adapt";

/** Makes a voiceprint (unit length) of 16 kHz audio. */
export interface Printer {
  print(samples: Float32Array): Promise<Float32Array>;
}

/**
 * Why teaching ended without a voiceprint, when it wasn't the user's Cancel: `timeout` (ENROL_LIMITS), `stopped` ("Ember,
 * stop"), `gave-up` (too many phrases unlike the others).
 */
export type EnrolEnd = "timeout" | "stopped" | "gave-up";

/**
 * Why a phrase is asked for again: too short, unlike the others, not heard clearly, or (`over`, while a screen reader
 * runs) said while the screen reader was still reading its prompt, so the two came as one.
 */
export type EnrolAgain = "short" | "unlike" | "failed" | "over";

/** What enrolment tells main: `got` of `of` phrases kept; `again`: the last one wasn't kept (`why`). */
export type EnrolState =
  | { state: "listening" | "heard"; got: number; of: number }
  | { state: "again"; got: number; of: number; why: EnrolAgain }
  | { state: "done"; got: number; of: number; print: Float32Array }
  | { state: "cancelled"; got: number; of: number; why?: EnrolEnd };

/**
 * How long teaching waits (ms): `quietMs` with no phrase heard, `totalMs` in all. It had no limit: someone who walked
 * away from Settings left Ember deaf to its name for good, and whatever was said next became the voiceprint
 * (voice-listening-v1). Four phrases and a few said again take well under a minute.
 */
export const ENROL_LIMITS = { quietMs: 45_000, totalMs: 180_000 } as const;

/**
 * The least voice what follows the wake phrase needs for Voice Match to vouch for it (`verified`, what a spoken yes and
 * turning "Work without asking" on need), checked on its own at VOICE_MATCH_THRESHOLD (owner decision of 2026-11-03;
 * it was 1.5 s, which almost no natural yes reached). Measured on LibriSpeech dev-clean (33 speakers, enrolled from four
 * 3 s phrases, pieces cut by voiced length): at 0.5 s another voice passes 0.5 % of the time and the owner's is turned
 * away 52 %; at 1.5 s, 1.9 % and 6.5 %. A shorter piece makes another voice no easier to pass, only the owner's harder.
 * A shorter or weaker match is `short`, which only a task the owner asked for by voice may still take (TaskVoiceTrust).
 * Never the whole request with the wake phrase in it: the owner's recorded "Hey Ember" then another voice passed 65 %.
 */
export const APPROVAL_MIN_SECONDS = 0.5;
/**
 * What follows the wake phrase is scored on its own (`restScore`) when it holds this much voice: under it, too few
 * frames for the voiceprint to say anything.
 */
export const SCORE_MIN_SECONDS = 0.25;

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

/**
 * How like the owner something said over other sound must be for Ember to hear it unnamed. This only decides hearing, never
 * approving. The owner's own requests on a laptop's microphone scored 0.50–0.75 (log of 2026-11-05).
 */
export const OVER_SOUND_MATCH = 0.45;

export class VoiceGate {
  private revision = 0;
  /** Pending work belongs to this cancellation/identity revision, including asynchronous learning checks. */
  get generation(): number { return this.revision; }

  /** Drop held events and detach old promises, so a fresh request never waits for cancelled inference. */
  cancel(): void {
    this.revision++;
    this.queue = Promise.resolve();
  }

  private owner: Float32Array | null = null;
  /**
   * What Voice Match learnt (adapt.ts): the enrolment's own print, which a request must match by ADAPT.anchorFloor too,
   * and the threshold for the print in use (adaptedThreshold). Null and the constructor's threshold: nothing learnt.
   */
  private anchor: Float32Array | null = null;
  private learntThreshold: number | null = null;
  /** Requests waiting for their check finish in order (a later one never overtakes an earlier). */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Told of each request that matched the owner and was `verified` (sent first), with its voiceprint, its score and the
   * audio that follows its wake phrase (the part that vouched for it): what Voice Match may learn from (adapt-sample.ts,
   * adapt.ts). Null: nothing is.
   */
  onSample: ((print: Float32Array, score: number, rest: Float32Array) => void) | null = null;

  constructor(
    private printer: () => Printer,
    private send: (e: VoiceEvent) => void,
    private onError: (err: unknown) => void,
    private threshold = VOICE_MATCH_THRESHOLD,
  ) {}

  /**
   * The owner's voiceprint (null: Voice Match off, every voice is heard). `learnt`: it learnt from the owner's requests
   * since enrolment (adapt.ts), so the enrolment is checked too and the threshold is the learnt print's.
   * Only a routine adaptation refresh preserves pending work; replacement, removal and toggles revoke it.
   */
  setOwner(print: Float32Array | null, learnt?: { anchor: Float32Array; threshold: number } | null, refresh = false): void {
    if (!refresh) this.cancel();
    this.owner = print;
    this.anchor = print && learnt ? learnt.anchor : null;
    this.learntThreshold = print && learnt ? Math.max(this.threshold, learnt.threshold) : null;
  }

  /**
   * The owner's match for a request's voiceprint (adapt.ts gateMatches); `strict`: to be `verified`, the enrolment at
   * its own threshold too.
   */
  matches(print: Float32Array, owner: Float32Array, strict = false): boolean {
    return gateMatches(print, owner, this.learntThreshold ?? this.threshold, this.anchor, strict);
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
   * stop never is (anyone may stop Ember), nor is anything else, nor a request said over Ember's own voice (no print of
   * it would be the speaker's alone: it goes as it is, vouched for by nobody). One that doesn't match is said ("rejected",
   * for what main keeps of a voice's trust) and then heard all the same, unverified.
   */
  event(e: VoiceEvent, audio: Float32Array | null, withWake = false): void {
    if (e.type === "stop") { this.cancel(); this.send(e); return; }
    const generation = this.revision;
    const owner = this.owner;
    // Over a song with no name said: only a voice that can be told apart from it is heard.
    if (e.type === "utterance" && e.overSound && (!owner || !audio?.length)) { this.send({ type: "dropped", reason: "over-sound" }); return; }
    if (e.type !== "utterance" || e.overEmber || !owner || !audio?.length) { this.send(e); return; }
    // Capture one immutable configuration for the whole request, including its post-wake check.
    const anchor = this.anchor;
    const threshold = this.learntThreshold ?? this.threshold;
    const matches = (p: Float32Array, strict = false) => gateMatches(p, owner, threshold, anchor, strict);
    const check = this.printer().print(audio);
    // It is awaited only when the requests before it are done: a failure meanwhile would be an unhandled rejection,
    // which ends the voice process. The await below still sees it.
    check.catch(() => undefined);
    this.queue = this.queue.then(async () => {
      if (generation !== this.revision) return;
      let score: number, print: Float32Array;
      try {
        print = await check;
        score = similarity(print, owner);
      } catch (err) {
        if (generation !== this.revision) return;
        // The model failed: the request is heard (Voice Match failing must not leave Ember deaf), and main is told.
        this.onError(err);
        if (!e.overSound) this.send(e);
        return;
      }
      if (e.overSound && score < OVER_SOUND_MATCH) { if (generation === this.revision) this.send({ type: "dropped", reason: "over-sound" }); return; }
      // Matched: said so, so a spoken yes to a question can be taken (main's voice-answer.ts). A request heard without a
      // check (Voice Match off, or the model failed above) carries no `verified`, and can't approve anything.
      // (Only with enough voice to go on, APPROVAL_MIN_SECONDS of voiced frames after the wake phrase, checked on its
      // own: a recording of the owner's "Hey Ember" mustn't make up the rest. Such a match says `short`.)
      if (generation !== this.revision) return;
      if (matches(print)) {
        const heard = await this.vouched(e, audio, owner, withWake, print, anchor, matches, generation);
        if (generation !== this.revision) return;
        this.send(heard);
        if (generation === this.revision && heard.type === "utterance" && heard.verified) this.onSample?.(print, score, afterWakePhrase(audio, withWake));
        return;
      }
      // (Over a song the score says little of a stranger: nothing is said, and no trust ends.)
      if (!e.overSound) this.send({ type: "rejected", keyword: "", reason: "voice", score: Math.round(score * 1000) / 1000 });
      this.send(e);
    });
  }

  /**
   * The owner's request (it matched as a whole) as main gets it: `verified` when what follows the wake phrase holds at
   * least APPROVAL_MIN_SECONDS of voice and matches the owner on its own; otherwise `short`, with that part's own score
   * (`restScore`) when it held SCORE_MIN_SECONDS of voice or more (`print`: the whole request's voiceprint, which is that
   * part's when there was no wake phrase). A check that fails says neither (heard, but it can't approve anything).
   *
   * `verified` needs `matches(…, strict)` (adapt.ts): the learnt print at its raised threshold AND the enrolment at its own
   * threshold, so what Voice Match learnt never lowers the bar for a spoken yes. `restScore` goes out unrounded and is
   * the cosine to the ENROLLED voiceprint (the one VOICE_MATCH_THRESHOLD and main's SHORT_YES_FLOOR are measured against),
   * or, once the print learnt, the lower of that and the cosine to the print in use: what was learnt never makes a short
   * yes score higher (voice-answer.ts SHORT_YES_FLOOR is compared with exactly this number).
   */
  private async vouched(e: Extract<VoiceEvent, { type: "utterance" }>, audio: Float32Array, owner: Float32Array, withWake: boolean, print: Float32Array, anchor: Float32Array | null, matches: (p: Float32Array, strict?: boolean) => boolean, generation: number): Promise<VoiceEvent> {
    const enrolled = anchor ?? owner;
    const scored = (p: Float32Array) => Math.min(similarity(p, owner), similarity(p, enrolled));
    const rest = afterWakePhrase(audio, withWake);
    const voiced = voicedSeconds(rest);
    if (rest === audio) {
      if (voiced < APPROVAL_MIN_SECONDS) return { ...e, short: true, ...(voiced >= SCORE_MIN_SECONDS ? { restScore: scored(print) } : {}) };
      return matches(print, true) ? { ...e, verified: true } : { ...e, short: true, restScore: scored(print) };
    }
    if (voiced < SCORE_MIN_SECONDS) return { ...e, short: true };
    let restPrint: Float32Array;
    try {
      restPrint = await this.printer().print(rest);
    } catch (err) {
      if (generation === this.revision) this.onError(err);
      return e;
    }
    return voiced >= APPROVAL_MIN_SECONDS && matches(restPrint, true) ? { ...e, verified: true } : { ...e, short: true, restScore: scored(restPrint) };
  }

}

/**
 * A segment that began this soon after a prompt showed (ms) is a screen reader reading it aloud: the owner has to hear
 * which phrase to say first (the shortest prompt read at 400 words a minute takes over a second). The VAD says speech
 * began about 0.2 s after it did.
 */
export const READER_LEAD_MS = 1500;
/** What a screen reader reads of a prompt (match-copy.ts), as the recognizer writes it: never how a phrase begins. */
const PROMPT_WORDS = /^\W*(?:say|says|said|heard|that|your\s+screen|wait|finish|learning)\b/i;

/**
 * While a screen reader runs, what it reads aloud of each prompt reaches the teaching microphone over speakers: `said`
 * (the recognizer), and `now` for when each prompt showed (ms, the clock `heard`'s `startedAt` counts on).
 */
export interface EnrolReader {
  said(samples: Float32Array): string;
  now?(): number;
}

/** The phrase's own longer words (not the name), each said twice when the owner's phrase ran on from the reading. */
function saidTwice(words: string, phrase: string): boolean {
  const heard = words.toLowerCase().replace(/whether/g, "weather");
  return phrase.toLowerCase().split(/[^a-z']+/).filter(w => w.length >= 5 && w !== "ember").some(w => heard.split(w).length > 2);
}

/**
 * Enrolment: the owner says `of` phrases (any speech the VAD hands over counts as one, but for a screen reader's reading
 * of a prompt while one runs: `reader`); their voiceprint comes at the end.
 */
export class Enrolment {
  private prints: Float32Array[] = [];
  private tries = 0;
  private finished = false;
  /** Gives up after this many phrases heard (some kept, some said again). */
  private readonly maxTries: number;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private readonly total: ReturnType<typeof setTimeout>;

  /** When the prompt now showing showed (`reader`'s clock). */
  private promptAt: number;

  constructor(private printer: Printer, private tell: (s: EnrolState) => void, readonly of = ENROL_PHRASES.length, private limits: { quietMs: number; totalMs: number } = ENROL_LIMITS, private reader?: EnrolReader) {
    this.maxTries = of * 3;
    this.total = setTimeout(() => this.cancel("timeout"), limits.totalMs);
    this.total.unref?.();
    this.waitQuietly();
    this.promptAt = this.now();
    tell({ state: "listening", got: 0, of });
  }

  private now(): number {
    return this.reader?.now?.() ?? Date.now();
  }

  /**
   * A phrase the VAD heard; `startedAt`: when its speech began (`reader`'s clock). While a screen reader runs, one begun
   * as a prompt showed, or in a prompt's words, is the screen reader's reading, and teaches nothing: a voiceprint learnt
   * from it was mostly the screen reader's, which Voice Match then took for the owner (voice-listening-r4-1).
   */
  async heard(samples: Float32Array, startedAt?: number): Promise<void> {
    if (this.finished) return;
    this.waitQuietly();
    if (this.reader) {
      const words = this.reader.said(samples);
      if ((startedAt !== undefined && startedAt - this.promptAt < READER_LEAD_MS) || PROMPT_WORDS.test(words)) {
        // (Its own reading says the phrase once; said twice, the owner's ran on from it, and is asked for again.)
        if (saidTwice(words, ENROL_PHRASES[Math.min(this.prints.length, ENROL_PHRASES.length - 1)])) { this.tries++; this.again("over"); }
        return;
      }
    }
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
      this.finish();
      this.tell({ state: "done", got: this.prints.length, of: this.of, print: averagePrint(this.prints) });
      return;
    }
    this.promptAt = this.now();
    this.tell({ state: "heard", got: this.prints.length, of: this.of });
  }

  /** Teaching stops: the user's Cancel (no `why`), or why it gave up (EnrolEnd). */
  cancel(why?: EnrolEnd): void {
    if (this.finished) return;
    this.finish();
    this.tell({ state: "cancelled", got: this.prints.length, of: this.of, ...(why ? { why } : {}) });
  }

  get done(): boolean {
    return this.finished;
  }

  private finish(): void {
    this.finished = true;
    clearTimeout(this.total);
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }

  /** Nothing heard for `quietMs` from now ends teaching. */
  private waitQuietly(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.cancel("timeout"), this.limits.quietMs);
    this.quiet.unref?.();
  }

  private again(why: EnrolAgain): void {
    if (this.tries >= this.maxTries) { this.cancel("gave-up"); return; }
    this.promptAt = this.now();
    this.tell({ state: "again", got: this.prints.length, of: this.of, why });
  }
}
