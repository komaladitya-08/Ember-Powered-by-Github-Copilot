/**
 * The voice process's side of Voice Match that keeps learning (adapt.ts): whether a request that matched the owner well
 * says enough to learn from (ADAPT.minVoicedSeconds of voice: never a short answer) and is one voice throughout. A
 * request long enough to tell (SPLIT_SECONDS of voice) is cut at the middle of its voice and each half must match the
 * owner on its own, as the gate would (its learnt threshold and the enrolment): someone talking over the owner, or a
 * voice that only starts like theirs, isn't learnt from (a busy room). Main decides the rest (adapt.ts adaptGuard).
 */

import { voicedFrames, voicedSeconds, type Printer } from "./match";
import { ADAPT } from "./adapt";
import { VOICE_MATCH_THRESHOLD } from "./voiceprint";

/** A request with at least this much voice is checked half by half (s); each half then has 1.5 s or more. */
export const SPLIT_SECONDS = 3;
const FRAME = 512;

/**
 * Whether what follows the wake phrase (`rest`: the wake phrase's own voice is no part of what is learnt from) has enough
 * voice to learn a voice from (ADAPT.minVoicedSeconds), however short an answer may be.
 */
export const longEnough = (rest: Float32Array): boolean => voicedSeconds(rest) >= ADAPT.minVoicedSeconds;

/**
 * Whether the voice process offers a verified request to main as a sample: Keep learning is on, Voice Match is, it matched
 * the print by ADAPT.margin over the threshold, `rest` (what follows the wake phrase) has enough voice, and the last
 * sample was ADAPT.minGapMs ago (`now`, `sampledAt`). Main checks the voice and the gap again (adaptGuard): a change here
 * alone can't make Ember learn from less.
 */
export function sampleOffered(o: { learning: boolean; hasOwner: boolean; score: number; rest: Float32Array; now: number; sampledAt: number }): boolean {
  return o.learning && o.hasOwner && o.score >= VOICE_MATCH_THRESHOLD + ADAPT.margin && longEnough(o.rest) && o.now - o.sampledAt >= ADAPT.minGapMs;
}

/** True when `audio` (a request the gate let in) is one voice throughout, as far as can be told: `matches` is the gate's test. */
export async function oneVoice(printer: Printer, audio: Float32Array, matches: (print: Float32Array) => boolean): Promise<boolean> {
  const voiced = voicedFrames(audio);
  const total = voiced.filter(Boolean).length;
  if ((total * FRAME) / 16_000 < SPLIT_SECONDS) return true;
  let seen = 0, mid = 0;
  for (let f = 0; f < voiced.length; f++) { if (voiced[f]) seen++; if (seen * 2 >= total) { mid = (f + 1) * FRAME; break; } }
  for (const half of [audio.subarray(0, mid), audio.subarray(mid)]) {
    if (!matches(await printer.print(half))) return false;
  }
  return true;
}
