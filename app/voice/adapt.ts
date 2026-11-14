/**
 * Voice Match that keeps learning (docs/ASSISTANT.md "Personalisation"): the owner's voiceprint follows their voice
 * slowly, from their own requests that matched it well above the threshold, so a new microphone, a cold or a quieter
 * room doesn't wear Voice Match down. Pure: main decides when a sample may be taken (adaptGuard) and keeps the state in
 * voiceprint.json (voiceprint-store.ts); the voice process says how well each request matched (process.ts).
 *
 * The print is a running weighted mean of the enrolment (the anchor, weighted as its four phrases) and the last
 * ADAPT.maxClips samples, unit length, then held back twice: it moves at most ADAPT.maxStep (cosine) a sample, and never
 * further than ADAPT.anchorMin from the enrolment. A voice that isn't the owner's never gets near enough to be learnt
 * (it would have to match the print by ADAPT.margin more than the threshold, and the enrolment too), and even a run of
 * such samples can't carry the print away from the owner. Numbers only: no audio is kept.
 *
 * A print made from more of the owner's requests matches every voice a little more (an average is nearer the middle),
 * so the gate asks more of it (adaptedThreshold: up to ADAPT.raise above VOICE_MATCH_THRESHOLD), and a request must
 * still match the enrolment itself by ADAPT.anchorFloor (gateMatches): what was learnt can lower neither bar for long.
 */

import { VOICE_MATCH_THRESHOLD, averagePrint, similarity, unit } from "./voiceprint";

/**
 * The limits (measured on LibriSpeech dev-clean, 40 speakers, 12 requests learnt from and 8 tried each:
 * scripts/voice/match-bench.mjs, docs/ASSISTANT.md "Personalisation").
 * - `margin`: a sample matched the print by this much more than VOICE_MATCH_THRESHOLD (0.83 at 0.75). The owner's
 *   own 2.5 s requests came to 0.83 or more 70 % of the time; another voice's, 0.1 % (13 of 12,480).
 * - `anchorMatch`: it matched the enrolment itself by at least this much (the threshold's own).
 * - `maxClips`: the samples kept (the oldest goes).
 * - `anchorWeight`: the enrolment counts as this many samples in the mean (its four phrases).
 * - `maxStep`: the most the print moves for one sample (1 − cosine with the print before).
 * - `anchorMin`: the print stays at least this close to the enrolment (cosine).
 * - `raise`, `raiseClips`: the gate's threshold for a print that learnt from `raiseClips` samples or more is `raise`
 *   higher (in proportion before). Without it the learnt print let in 4.1 % of other voices against the enrolment's
 *   3.0 %; with it 1.8 %, and it turned the owner away 7.8 % of the time against 8.4 %.
 * - `anchorFloor`: a request must match the enrolment by this much too to be heard, whatever the print learnt. Against
 *   200 crafted samples per pair that each passed every limit (an attacker who already sounds 0.86 like the owner), it
 *   held other voices to 4.0 % (6.3 % at 0.72; 98 % with no limits at all).
 * - `verifiedFloor`: to be `verified` (what may answer a question by voice or choose a mode that asks less, while
 *   Voice Match is on), the enrolment's own threshold, as before Voice Match learnt: what it learnt can never lower that bar (review of #145).
 * - `minVoicedSeconds`: a sample has at least this much voice (a short answer says too little to learn a voice from,
 *   whatever APPROVAL_MIN_SECONDS asks of an answer).
 * - `minGapMs`: at most one sample in this long (a busy minute of talk teaches no more than one request).
 */
export const ADAPT = {
  margin: 0.08,
  anchorMatch: VOICE_MATCH_THRESHOLD,
  maxClips: 24,
  anchorWeight: 4,
  maxStep: 0.02,
  anchorMin: 0.95,
  raise: 0.03,
  raiseClips: 8,
  anchorFloor: 0.74,
  verifiedFloor: VOICE_MATCH_THRESHOLD,
  minVoicedSeconds: 2,
  minGapMs: 60_000,
} as const;

/** The gate's threshold for a print that learnt from `clips` samples (VOICE_MATCH_THRESHOLD for the enrolment's own). */
export function adaptedThreshold(clips: number, threshold: number = VOICE_MATCH_THRESHOLD): number {
  return threshold + ADAPT.raise * Math.min(1, Math.max(0, clips) / ADAPT.raiseClips);
}

/**
 * Whether a request's voiceprint is the owner's: it matches the print in use by `threshold` (adaptedThreshold), and,
 * when the print learnt anything (`anchor` given), the enrolment by ADAPT.anchorFloor too, or by ADAPT.verifiedFloor
 * when it is to be `verified` (`strict`).
 */
export function gateMatches(print: ArrayLike<number>, owner: ArrayLike<number>, threshold: number, anchor?: ArrayLike<number> | null, strict = false): boolean {
  const floor = strict ? Math.max(ADAPT.anchorFloor, ADAPT.verifiedFloor) : ADAPT.anchorFloor;
  return similarity(print, owner) >= threshold && (!anchor || similarity(print, anchor) >= floor);
}

/** What is kept: the enrolment, the samples (oldest first) and the print in use now (all unit length). */
export interface AdaptState {
  anchor: Float32Array;
  clips: Float32Array[];
  print: Float32Array;
}

/** A fresh state from enrolment: the print is the enrolment's. */
export function fromEnrolment(anchor: Float32Array): AdaptState {
  const a = unit(anchor);
  return { anchor: a, clips: [], print: a };
}

/**
 * The point on the great circle from `from` to `to` (unit vectors) whose cosine with `from` is `cos`: `to` itself when
 * it is that close already.
 */
export function towards(from: Float32Array, to: Float32Array, cos: number): Float32Array {
  const c = similarity(from, to);
  if (c >= cos) return unit(to);
  // The part of `to` at right angles to `from`, then the point at angle acos(cos) from `from` in that direction.
  const perp = new Float32Array(from.length);
  for (let i = 0; i < from.length; i++) perp[i] = to[i] - c * from[i];
  const p = unit(perp);
  const s = Math.sqrt(Math.max(0, 1 - cos * cos));
  return unit(Float32Array.from(from, (x, i) => cos * x + s * p[i]));
}

/** The mean of the enrolment (ADAPT.anchorWeight times) and the samples, unit length. */
export function weightedMean(anchor: Float32Array, clips: readonly Float32Array[], anchorWeight: number = ADAPT.anchorWeight): Float32Array {
  const out = Float32Array.from(anchor, x => x * anchorWeight);
  for (const c of clips) for (let i = 0; i < out.length; i++) out[i] += c[i];
  return unit(out);
}

/** Why a sample wasn't learnt from, or "learnt". */
export type AdaptOutcome = "learnt" | "weak" | "unlike-enrolment";

/**
 * One sample (a request's voiceprint, unit length) and how it matched the print in use (`score`): the state after it,
 * and what happened. A sample that matched by less than the threshold plus ADAPT.margin, or doesn't match the enrolment
 * by ADAPT.anchorMatch, changes nothing. `o` overrides the limits (the measurements' ablations only).
 */
export function adapt(s: AdaptState, sample: Float32Array, score: number, o: Partial<typeof ADAPT> & { threshold?: number } = {}): { state: AdaptState; outcome: AdaptOutcome } {
  const k = { ...ADAPT, ...o };
  const threshold = o.threshold ?? VOICE_MATCH_THRESHOLD;
  if (!(score >= threshold + k.margin)) return { state: s, outcome: "weak" };
  const u = unit(sample);
  if (!(similarity(u, s.anchor) >= k.anchorMatch)) return { state: s, outcome: "unlike-enrolment" };
  const clips = [...s.clips, u].slice(-k.maxClips);
  let print = weightedMean(s.anchor, clips, k.anchorWeight);
  // Held back: a step at a time, and within reach of the enrolment.
  print = towards(s.print, print, 1 - k.maxStep);
  if (similarity(print, s.anchor) < k.anchorMin) print = towards(s.anchor, print, k.anchorMin);
  return { state: { anchor: s.anchor, clips, print }, outcome: "learnt" };
}

/** The state as a check would want it: a print that can't be used (wrong size, not finite) falls back to the enrolment. */
export function sane(s: AdaptState): AdaptState {
  const ok = (p: Float32Array) => p.length === s.anchor.length && p.every(Number.isFinite);
  const clips = s.clips.filter(ok).slice(-ADAPT.maxClips);
  if (ok(s.print) && similarity(s.print, s.anchor) >= ADAPT.anchorMin - 1e-4) return { anchor: s.anchor, clips, print: s.print };
  // A print out of reach of the enrolment (the file was changed): made again from what is kept, within reach.
  const mean = weightedMean(s.anchor, clips);
  return { anchor: s.anchor, clips, print: similarity(mean, s.anchor) < ADAPT.anchorMin ? towards(s.anchor, mean, ADAPT.anchorMin) : mean };
}

/** What main knows of a request when the voice process says it matched well (process.ts `voice-sample`). */
export interface SampleContext {
  /** Settings › Voice › Keep learning my voice. */
  learning: boolean;
  /** Voice Match is on and in force (its model is in, a print kept). */
  matchOn: boolean;
  /** The request was `verified` (it matched as a whole, and after the wake phrase on its own). */
  verified: boolean;
  /** Ember spoke since the request's wake (its own voice could be in it: VoiceService.selfSpokeSince). */
  selfSpoke: boolean;
  /** Voice Match turned another voice away within ADAPT_QUIET_MS before (someone else is about), or while a question it locked was up. */
  strangerNear: boolean;
  /** The request ran on past the longest Ember listens (`cut`: talk in the background), or its two halves didn't both match. */
  busyRoom: boolean;
  /** The kill switch was pulled within ADAPT_QUIET_MS (a stop is a moment to learn nothing). */
  stoppedLately: boolean;
  /** Seconds of voice that follow the request's wake phrase (the voice process measures them): ADAPT.minVoicedSeconds at least. */
  voicedSeconds: number;
  /** When the last sample was learnt (ms since the epoch; 0: never) and now. */
  lastAt: number;
  now: number;
}

/** Another voice turned away, or a stop, this recently (ms) holds learning back. */
export const ADAPT_QUIET_MS = 120_000;

/** Whether a request may teach Voice Match (null) or why not, as a reason word for the log (counts only, no words). */
export function adaptGuard(c: SampleContext): null | "off" | "unverified" | "short" | "self" | "stranger" | "busy" | "stopped" | "too-soon" {
  if (!c.learning || !c.matchOn) return "off";
  if (!c.verified) return "unverified";
  // Never a short answer or a bare command: too little voice to learn a voice from (also checked in the voice process).
  if (!(c.voicedSeconds >= ADAPT.minVoicedSeconds)) return "short";
  if (c.selfSpoke) return "self";
  if (c.strangerNear) return "stranger";
  if (c.busyRoom) return "busy";
  if (c.stoppedLately) return "stopped";
  if (c.lastAt && c.now - c.lastAt < ADAPT.minGapMs) return "too-soon";
  return null;
}

/** Enrolment's own average, for tests and the measurements: the anchor a state starts from. */
export const enrolmentPrint = (prints: ArrayLike<number>[]): Float32Array => averagePrint(prints);
