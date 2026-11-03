/**
 * The voice process's side of Voice Match that keeps learning (adapt.ts): whether a request that matched the owner well
 * is one voice throughout. A request long enough to tell (SPLIT_SECONDS of voice) is cut at the middle of its voice and
 * each half must match the owner on its own: someone talking over the owner, or a voice that only starts like theirs,
 * isn't learnt from (a busy room). Main decides the rest (adapt.ts adaptGuard) and keeps what is learnt.
 */

import { voicedFrames, type Printer } from "./match";
import { similarity } from "./voiceprint";

/** A request with at least this much voice is checked half by half (s); each half then has 1.5 s or more. */
export const SPLIT_SECONDS = 3;
const FRAME = 512;

/** True when `audio` (a request that matched `owner`) is one voice throughout, as far as can be told. */
export async function oneVoice(printer: Printer, audio: Float32Array, owner: Float32Array, threshold: number): Promise<boolean> {
  const voiced = voicedFrames(audio);
  const total = voiced.filter(Boolean).length;
  if ((total * FRAME) / 16_000 < SPLIT_SECONDS) return true;
  let seen = 0, mid = 0;
  for (let f = 0; f < voiced.length; f++) { if (voiced[f]) seen++; if (seen * 2 >= total) { mid = (f + 1) * FRAME; break; } }
  for (const half of [audio.subarray(0, mid), audio.subarray(mid)]) {
    if (similarity(await printer.print(half), owner) < threshold) return false;
  }
  return true;
}
