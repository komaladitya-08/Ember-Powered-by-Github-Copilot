/**
 * Ember's Kitten Nano voice runs natively in its own utility process, so speaking never holds up listening. Optional
 * Kokoro uses that same path. Replies stream as clauses and sentences; when native speech is unavailable, too slow
 * or fails, a voice that runs locally on the operating system speaks instead. Pure helpers; no model loads here.
 */

import { speechMarkupOpen, spokenText } from "./spoken";

/** Persisted preference names; Kitten is the default, with Kokoro as the optional alternative. */
export type NaturalVoiceModel = "kokoro" | "supertonic" | "kitten";

/** Neural speech must be made in at most half its playback duration, keeping streamed sentences ahead of playback. */
export const NATURAL_MAX_RTF = 0.5;
/** Approximate preflight cost of optional Kokoro relative to Kitten; Kokoro's own probe still decides before use. */
export const NATURAL_COST = 3.5;
/** A laptop timed on battery or while busy gets another try after a week, without loading a slow model every start. */
export const NATURAL_RECHECK_MS = 7 * 24 * 3_600_000;

/** The cached slow voice's real-time factor, or null when the verdict is missing, damaged, future-dated or expired. */
export function rememberedSlow(value: string | undefined, now: number): number | null {
  const m = /^slow:(\d+(?:\.\d+)?):(\d+)$/.exec(value ?? "");
  if (!m) return null;
  const rtf = Number(m[1]), at = Number(m[2]);
  return Number.isFinite(rtf) && rtf > NATURAL_MAX_RTF && at <= now && now - at < NATURAL_RECHECK_MS ? rtf : null;
}

/** A verdict to remember after the natural voice was timed too slow at `now`. */
export function slowVerdict(rtf: number, now: number): string {
  return `slow:${rtf}:${Math.round(now)}`;
}

/**
 * Cut a long first sentence at an early clause break: useful speech can start before the entire sentence is made.
 * Keep the first clause substantial enough to sound complete. scripts/voice/bench.mjs measures the current voice.
 */
const FIRST_SOON = 48;
const FIRST_MAX = 90;
const FIRST_MIN = 18;
/** A streamed answer's first clause is said on its own only with at least this many words ("Sure, …" waits). */
const FIRST_WORDS = 4;
/**
 * Longer chunks are cut at a comma (or before a joining word): the voice's pace and pitch hold better over a clause than
 * over a paragraph, and a chunk being made can't be stopped, so a new answer that cuts in waits for it (about 7 s of
 * speech here; 240 characters waited about a second more on a 2.1 GHz computer: voice-speaking-10).
 */
const CHUNK_MAX = 120;
/** A chunk this short ("Done.", "OK.") goes with the next, unless it's the first (it then plays at once). */
const CHUNK_MIN = 12;

/**
 * The most of one answer Ember says aloud, in characters of speech: roughly a minute. Past it, the rest is left to the bubble, which shows all of it, as voice assistants summarise
 * rather than read a page out. Ember's persona keeps replies short, so this is for the long ones that slip through.
 */
export const SPOKEN_MAX = 700;
/** What Ember says where it stops reading a long answer out. */
export const REST_IN_BUBBLE = "The rest is in the bubble.";

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|fig|a\.m|p\.m)\.$/i;
/** A day's or a month's short name ("on Tue.", "Jan. 5"), with its capital: "We sat." still ends a sentence. */
const SHORT_NAMES = /(?:^|\s)(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/;

/**
 * Where `text` can be cut after a sentence (or a paragraph): the indexes just past each ending, in order. A list's item
 * and a heading end at their line too, and a numbered step starts its own piece ("2. Choose Privacy"): its number is
 * never said at the end of the step before it (voice-speaking-v1).
 */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  const re = /[.!?…]+["”’')\]]*(?=\s)|\n[ \t]*\n|\n(?=[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S)|(?<=^[ \t]{0,3}#{1,6}[ \t]+\S[^\n]*)\n/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    const before = text.slice(0, end);
    // "e.g." and "Dr." don't end a sentence, nor does a numbered list's "1." at the start of a line.
    if (m[0].startsWith(".") && (ABBREVIATIONS.test(before) || SHORT_NAMES.test(before) || /(?:^|\n)[ \t]*\d+\.$/.test(before))) continue;
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
 * Words a long sentence with no comma can be cut before: the voice pauses there as a speaker would ("I looked through
 * the folder you mentioned | and found…").
 */
const JOINS = /\s+(?=(?:and|but|or|so|because|which|that|while|when|where|until|after|before|with|from|for|to|together)\s)/gi;

/**
 * Where to cut `chunk`: before its first joining word between `min` and `max` characters that leaves FIRST_WORDS words
 * or more before it, else at its last space before `max` (voice-speaking-8); -1 when neither fits.
 */
function joinAt(chunk: string, min: number, max: number): number {
  for (const m of chunk.matchAll(JOINS)) {
    if (m.index < min) continue;
    if (m.index > max) break;
    if ((chunk.slice(0, m.index).match(/[\p{L}\p{N}]+/gu) ?? []).length >= FIRST_WORDS) return m.index;
  }
  const at = chunk.lastIndexOf(" ", max);
  return at > min ? at : -1;
}

/** `chunk` cut where joinAt says, or null. */
function cutAtJoin(chunk: string, min: number, max: number): [string, string] | null {
  const at = joinAt(chunk, min, max);
  return at < 0 ? null : [chunk.slice(0, at).trim(), chunk.slice(at).trim()];
}

/**
 * Plain text (already spokenText) as the pieces the voice says one after another: sentences, the first one short so
 * the sound starts soon ("I opened the terminal, ran the tests and…" starts with "I opened the terminal,"), long ones
 * cut at a comma, and very short ones joined to the next.
 */
export function speechChunks(text: string): string[] {
  // The ends are found before line breaks become spaces: a numbered step's "2." at the start of its line is no end.
  const t = text.trim();
  if (!t) return [];
  const sentences: string[] = [];
  let from = 0;
  for (const end of sentenceEnds(t)) { sentences.push(t.slice(from, end)); from = end; }
  if (from < t.length) sentences.push(t.slice(from));
  const out: string[] = [];
  for (const s of sentences.map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    let rest = s;
    for (;;) {
      const first = out.length === 0, max = first ? FIRST_MAX : CHUNK_MAX;
      const min = first ? FIRST_MIN : CHUNK_MAX / 2;
      // A comma from FIRST_SOON (the first piece) or CHUNK_MAX; with none, a joining word or a space once past `max`.
      const cut = (rest.length > (first ? FIRST_SOON : max) ? cutAtClause(rest, min, max) : null) ?? (rest.length > max ? cutAtJoin(rest, min, max) : null);
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
  /** How many characters of speech were given out, and whether the rest was left to the bubble (SPOKEN_MAX). */
  private spokenChars = 0;
  private capped = false;
  /** Past the cap, the last of the answer left unsaid (its closing question may still be said). */
  private dropped = "";

  /** `maxChars`: the most of an answer said aloud (SPOKEN_MAX); the rest is left to the bubble, which shows it all. */
  constructor(private maxChars = SPOKEN_MAX) {}

  /** More of the answer: the sentences it completed, as spoken text (none, often). */
  push(delta: string): string[] {
    this.raw += delta;
    const cut = this.safeCut();
    if (cut <= this.said) return [];
    const spoken = spokenText(this.raw.slice(this.said, cut));
    this.said = cut;
    return spoken.trim() ? this.budget(spoken) : [];
  }

  /**
   * `spoken`, as much of it as fits what is left of the answer's spoken length: past it, up to the last sentence that
   * fits, then "The rest is in the bubble." once, and nothing after (a long answer isn't read out whole).
   */
  private budget(spoken: string): string[] {
    if (this.capped) { this.dropped = spoken; return []; }
    const room = this.maxChars - this.spokenChars;
    if (spoken.length <= room) { this.spokenChars += spoken.length; return [spoken]; }
    this.capped = true;
    const ends = sentenceEnds(`${spoken} `).filter(e => e <= room);
    // Nothing said yet and not one sentence fits: the words that do, then the note.
    const at = ends.length ? ends[ends.length - 1] : 0;
    const head = ends.length ? spoken.slice(0, at).trim() : this.spokenChars ? "" : `${spoken.slice(0, room).replace(/\s+\S*$/, "")}…`;
    this.dropped = spoken.slice(at);
    return [head ? `${head} ${REST_IN_BUBBLE}` : REST_IN_BUBBLE];
  }

  /**
   * The answer's closing question, when the cap left it unsaid ("Which one shall I open?"): it is still said, after the
   * note, since the follow-up window that opens after it waits for the reply (review of #143). Null otherwise.
   */
  private closingQuestion(): string | null {
    const text = this.dropped.trim();
    if (!this.capped || !/\?["”’')\]]*$/.test(text)) return null;
    const ends = sentenceEnds(`${text} `).filter(e => e < text.length);
    const last = text.slice(ends.length ? ends[ends.length - 1] : 0).trim();
    return last.length <= 300 ? last : null;
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
    const spoken = spokenText(rest);
    const out = spoken.trim() ? this.budget(spoken) : [];
    const question = this.closingQuestion();
    if (question) out.push(question);
    this.reset();
    return out;
  }

  /** Whether any of the answer has been spoken. */
  get started(): boolean {
    return this.said > 0;
  }

  reset(): void {
    this.raw = "";
    this.said = 0;
    this.spokenChars = 0;
    this.capped = false;
    this.dropped = "";
  }

  /**
   * The last place a sentence ends with no code block or table open (0: none yet). Before anything is said, the first
   * clause will do (FIRST_MIN characters or more, at least FIRST_WORDS words, then ", " "; " ": " or a dash): Ember
   * starts talking while Copilot is still writing the rest of a long first sentence, not after it.
   */
  private safeCut(): number {
    const best = this.sentenceCut();
    return best || this.said ? best : this.clauseCut() || this.joinCut();
  }

  /**
   * A first sentence past FIRST_MAX characters with no comma yet: before its first joining word, else its last space,
   * as speechChunks cuts it (voice-speaking-8). 0 while it is shorter, or inside Markdown that isn't whole yet.
   */
  private joinCut(): number {
    if (this.raw.length <= FIRST_MAX) return 0;
    const head = this.raw.slice(0, FIRST_MAX + 1);
    // Only on the answer's first line, as a sentence: not in a list, a heading, a quote or a table.
    if (head.includes("\n") || speechMarkupOpen(head) || /^[ \t]*(?:[|#>*+-]|\d+[.)])/.test(head)) return 0;
    return Math.max(0, joinAt(this.raw, FIRST_MIN, FIRST_MAX));
  }

  /** The first clause break of the answer, when it can be said on its own (0: none yet). */
  private clauseCut(): number {
    const re = /[,;:]\s+|\s+[—–-]\s+/g;
    for (let m = re.exec(this.raw); m; m = re.exec(this.raw)) {
      if (m.index < FIRST_MIN) continue;
      const before = this.raw.slice(0, m.index);
      // Not inside Markdown that isn't whole yet: a code span or block, a link's text or address, a table, a list's
      // first line (it reads better as a whole), or a heading.
      if (speechMarkupOpen(before)) return 0;
      if (/^[ \t]*(?:[|#>*+-]|\d+[.)])/m.test(before)) return 0;
      if ((before.match(/[\p{L}\p{N}]+/gu) ?? []).length < FIRST_WORDS) continue;
      return m.index + m[0].length;
    }
    return 0;
  }

  private sentenceCut(): number {
    let best = 0;
    for (const end of sentenceEnds(this.raw)) {
      if (end <= this.said) continue;
      const before = this.raw.slice(0, end);
      if (speechMarkupOpen(before)) continue;
      // In a table (a line that starts with "|"), or right after one: wait for the line after it.
      const line = before.slice(before.lastIndexOf("\n") + 1);
      if (/^[ \t]*\|/.test(line)) continue;
      best = end;
    }
    return best;
  }
}
