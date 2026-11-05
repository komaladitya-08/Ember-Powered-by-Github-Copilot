/**
 * Voice Match: Ember answers only its owner's voice, as phone assistants do. The owner says a few short phrases once
 * (enrolment); each is turned into a voiceprint, a 256-number summary of how a voice sounds (WeSpeaker's ResNet34,
 * trained on VoxCeleb), and their average is kept on this computer. Every request heard after that is turned into a
 * voiceprint too and compared with it (cosine similarity): one that isn't close enough is ignored. "Ember, stop" is never
 * checked: anyone may stop Ember. Nothing of the voice leaves the computer, and the stored voiceprint can't be turned
 * back into speech. Pure helpers here; the model runs in a worker thread of the voice process (voiceprint-worker.ts).
 */

import { fbank } from "./fbank";

/**
 * How close a request's voiceprint must be to the owner's. Measured on LibriSpeech dev-clean (40 real speakers;
 * voiceprints from four 3 s phrases, requests 2.5 s): 0.75 turned away 3–4 % of the owner's requests and took 2–3 %
 * of others'; 0.7 turned away under 1 % and took 8–11 %; 0.78 turned away 7 % and took 1 %.
 */
export const VOICE_MATCH_THRESHOLD = 0.75;
/** What enrolment asks the owner to say: short requests with the name, as they will talk to Ember. */
export const ENROL_PHRASES = [
  "Ember, what's the weather like today?",
  "Hey Ember, open my calendar.",
  "Ember, turn on Do Not Disturb.",
  "Ember, set a timer for ten minutes.",
];
/** A phrase shorter than this (s) says too little about the voice; one heard is cut to this much at most (s). */
export const ENROL_MIN_SECONDS = 1;
export const PRINT_MAX_SECONDS = 4;
/**
 * An enrolment phrase this unlike the others (cosine to their average) is said again: someone else spoke, or noise
 * covered it. Measured on LibriSpeech dev-clean (40 speakers, 160 phrases): the owner's own came to 0.64 at the least,
 * so none was asked again, and 71 % of another voice's phrases slipped in among them were.
 */
export const ENROL_CONSISTENCY = 0.6;
const SAMPLE_RATE = 16_000;

/**
 * The model's input for 16 kHz `samples` ([-1, 1]): log mel filterbank frames (fbank.ts) of the samples at 16-bit
 * scale, as WeSpeaker computes them (no mean taken off), flattened row by row, and the frame count.
 */
export function printFeatures(samples: Float32Array): { data: Float32Array; frames: number } {
  const scaled = new Float32Array(Math.min(samples.length, PRINT_MAX_SECONDS * SAMPLE_RATE));
  for (let i = 0; i < scaled.length; i++) scaled[i] = samples[i] * 32768;
  const rows = fbank(scaled);
  const data = new Float32Array(rows.length * 80);
  rows.forEach((r, i) => data.set(r, i * 80));
  return { data, frames: rows.length };
}

/** `v` scaled to length 1 (a zero vector stays zero). */
export function unit(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, x => x / n);
}

export function similarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let c = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { c += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? c / Math.sqrt(na * nb) : 0;
}

/** The owner's voiceprint: the average of their phrases' (each made unit length first), unit length. */
export function averagePrint(prints: ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(prints[0]?.length ?? 0);
  for (const p of prints) { const u = unit(p); for (let i = 0; i < out.length; i++) out[i] += u[i]; }
  return unit(out);
}

/**
 * Enrolment's phrases so far: which to keep. With three or more, one far from the others' average is dropped (it's
 * asked for again): `keep` holds the indexes of those kept.
 */
export function consistentPrints(prints: ArrayLike<number>[]): { keep: number[]; dropped: number | null } {
  const all = prints.map((_, i) => i);
  if (prints.length < 3) return { keep: all, dropped: null };
  let worst = -1, worstScore = Infinity;
  for (const i of all) {
    const others = averagePrint(prints.filter((_, j) => j !== i));
    const s = similarity(prints[i], others);
    if (s < worstScore) { worstScore = s; worst = i; }
  }
  return worstScore < ENROL_CONSISTENCY ? { keep: all.filter(i => i !== worst), dropped: worst } : { keep: all, dropped: null };
}

/** A voiceprint as stored (base64 of its float32s), and back; null for anything that isn't one of `dims` numbers. */
export function encodePrint(p: Float32Array): string {
  return Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString("base64");
}

export function decodePrint(s: unknown, dims = 256): Float32Array | null {
  if (typeof s !== "string") return null;
  const b = Buffer.from(s, "base64");
  if (b.length !== dims * 4) return null;
  const p = new Float32Array(dims);
  new Uint8Array(p.buffer).set(b);
  return p.every(Number.isFinite) ? p : null;
}
