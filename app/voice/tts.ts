/**
 * Ember's own voice: a neural (VITS/Piper) voice run by sherpa-onnx's WebAssembly build in its own utility process
 * (app/voice/tts-process.ts), so speaking never holds up listening. A reply is spoken sentence by sentence as it is
 * made, and a streamed answer as its sentences arrive (SpeechStream): the first words play within about half a second.
 * Without the voice's model (not downloaded yet), or should it fail, the system's voice speaks (speechSynthesis).
 * Pure helpers here; nothing in this file loads a model.
 */

import { spokenText } from "./spoken";

/** A first chunk longer than this is cut at its first comma (or semicolon, or dash) past FIRST_MIN: its sound comes sooner. */
const FIRST_MAX = 90;
const FIRST_MIN = 25;
/** Longer chunks are cut at a comma: the voice's pace and pitch hold better over a clause than over a paragraph. */
const CHUNK_MAX = 240;
/** A chunk this short ("Done.", "OK.") goes with the next, unless it's the first (it then plays at once). */
const CHUNK_MIN = 12;

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|fig)\.$/i;

/** Where `text` can be cut after a sentence (or a paragraph): the indexes just past each ending, in order. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  const re = /[.!?…]+["”’')\]]*(?=\s)|\n[ \t]*\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    const before = text.slice(0, end);
    // "e.g." and "Dr." don't end a sentence, nor does a numbered list's "1." at the start of a line.
    if (m[0].startsWith(".") && (ABBREVIATIONS.test(before) || /(?:^|\n)[ \t]*\d+\.$/.test(before))) continue;
    ends.push(end);
  }
  return ends;
}

/** Cuts `chunk` at its first clause break (", " "; " " — ") between `min` and `max` characters, or returns it whole. */
function cutAtClause(chunk: string, min: number, max: number): [string, string] | null {
  const re = /[,;:]\s+|\s+[—–-]\s+/g;
  for (let m = re.exec(chunk); m; m = re.exec(chunk)) {
    if (m.index < min) continue;
    if (m.index > max) break;
    const at = m.index + m[0].length;
    return [chunk.slice(0, at).trim(), chunk.slice(at).trim()];
  }
  return null;
}

/**
 * Plain text (already spokenText) as the pieces the voice says one after another: sentences, the first one short so
 * the sound starts soon ("I opened the terminal, ran the tests and…" starts with "I opened the terminal,"), long ones
 * cut at a comma, and very short ones joined to the next.
 */
export function speechChunks(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const sentences: string[] = [];
  let from = 0;
  for (const end of sentenceEnds(t)) { sentences.push(t.slice(from, end).trim()); from = end; }
  if (from < t.length) sentences.push(t.slice(from).trim());
  const out: string[] = [];
  for (const s of sentences.filter(Boolean)) {
    let rest = s;
    for (;;) {
      const first = out.length === 0, max = first ? FIRST_MAX : CHUNK_MAX;
      const cut = rest.length > max ? cutAtClause(rest, first ? FIRST_MIN : CHUNK_MAX / 2, max) : null;
      if (!cut) break;
      out.push(cut[0]);
      rest = cut[1];
    }
    const last = out.length - 1;
    if (last > 0 && out[last].length < CHUNK_MIN) out[last] = `${out[last]} ${rest}`;
    else out.push(rest);
  }
  return out;
}

/**
 * An answer as the model streams it (Markdown), as sentences to speak as soon as each is complete. A sentence ends
 * outside a code block and a table (those are shown, not read: spokenText says so once they're whole); what was
 * spoken is never spoken again, and finish() gives what's left once the whole answer is in.
 */
export class SpeechStream {
  private raw = "";
  /** How much of `raw` has been spoken. */
  private said = 0;

  /** More of the answer: the sentences it completed, as spoken text (none, often). */
  push(delta: string): string[] {
    this.raw += delta;
    const cut = this.safeCut();
    if (cut <= this.said) return [];
    const spoken = spokenText(this.raw.slice(this.said, cut));
    this.said = cut;
    return spoken.trim() ? [spoken] : [];
  }

  /**
   * The answer is complete (`full`: the whole of it, as the model's message has it): what is left to say. Nothing
   * streamed: all of it.
   */
  finish(full?: string): string[] {
    const text = full ?? this.raw;
    let rest: string;
    if (!this.said) rest = text;
    else if (text.startsWith(this.raw.slice(0, this.said))) rest = text.slice(this.said);
    else rest = full === undefined ? this.raw.slice(this.said) : "";
    this.reset();
    const spoken = spokenText(rest);
    return spoken.trim() ? [spoken] : [];
  }

  /** Whether any of the answer has been spoken. */
  get started(): boolean {
    return this.said > 0;
  }

  reset(): void {
    this.raw = "";
    this.said = 0;
  }

  /** The last place a sentence ends with no code block or table open (0: none yet). */
  private safeCut(): number {
    let best = 0;
    for (const end of sentenceEnds(this.raw)) {
      if (end <= this.said) continue;
      const before = this.raw.slice(0, end);
      const fences = (before.match(/(^|\n)[ \t]*(```|~~~)/g) ?? []).length;
      if (fences % 2) continue;
      // In a table (a line that starts with "|"), or right after one: wait for the line after it.
      const line = before.slice(before.lastIndexOf("\n") + 1);
      if (/^[ \t]*\|/.test(line)) continue;
      best = end;
    }
    return best;
  }
}
