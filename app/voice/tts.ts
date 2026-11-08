/**
 * Ember's Kitten Nano voice runs natively in its own utility process, so speaking never holds up listening. Optional
 * Kokoro uses that same path. Replies stream as clauses and sentences; when native speech is unavailable, too slow
 * or fails, a voice that runs locally on the operating system speaks instead. Pure helpers; no model loads here.
 */

import { labelLine, speechMarkupOpen, spokenText } from "./spoken";

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

/**
 * How far back from what has come a full stop on the last line is judged for good (a run of "…" or of closing quotes
 * may still be growing). A possible end before the last line break is judged for good too: a line break's own ending
 * (a paragraph's, a list item's) is decided by the line after it.
 */
const SCAN_BACK = 64;
/** A line that opens or closes a code block. */
const FENCE_LINE = /^[ \t]*(?:```|~~~)/;
/** A heading's line, as Markdown writes it ("## Totals"). */
const HEADING_LINE = /^[ \t]{0,3}#{1,6}[ \t]+\S/;

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|fig|a\.m|p\.m)\.$/i;
/** A day's or a month's short name ("on Tue.", "Jan. 5"), with its capital: "We sat." still ends a sentence. */
const SHORT_NAMES = /(?:^|\s)(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/;

/**
 * Where `text` can be cut after a sentence (or a paragraph): the indexes just past each ending after `from`, in order.
 * A list's item and a heading end at their line too, and a numbered step starts its own piece ("2. Choose Privacy"):
 * its number is never said at the end of the step before it (voice-speaking-v1). So do a line ending with a colon, and
 * a line before a heading or a labelled step ("Step 2: …"), as spokenText ends them: labelled steps were said only once
 * the whole answer was in (voice-speaking-c4-1). Each ending is checked by the few characters around it, never by all
 * the text before it, so a long answer streams cheaply (voice-speaking-r4: a heading's lookbehind made a
 * 3,000-character paragraph cost 4 s). `seen` is told where every possible ending was looked at, ending or not: a scan
 * started there again finds the same endings after it.
 */
function sentenceEnds(text: string, from = 0, seen?: (end: number) => void): number[] {
  const ends: number[] = [];
  const re = /[.!?…]+["”’')\]]*(?=\s)|\n[ \t]*\n|\n(?=[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S)|:[ \t]*\n(?![ \t]*\n)|(\n)/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    seen?.(end);
    // A lone line break ends a heading's line ("## Totals"), and the line before a heading or a label. (A label's colon
    // and the word after it are within 40 characters of its line's start, and a heading's first word within 12.)
    if (m[1]) {
      const start = text.lastIndexOf("\n", m.index - 1) + 1;
      if (!HEADING_LINE.test(text.slice(start, Math.min(m.index, start + 12))) && !HEADING_LINE.test(text.slice(end, end + 12)) && !labelLine(text.slice(end, end + 40))) continue;
    }
    // "e.g." and "Dr." don't end a sentence, nor does a numbered list's "1." at the start of a line (the longest of
    // them is "approx.", so 16 characters show it whole, with what is before it).
    if (m[0].startsWith(".")) {
      const near = text.slice(Math.max(0, end - 16), end);
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, end);
      if (ABBREVIATIONS.test(near) || SHORT_NAMES.test(near) || (line.length <= 16 && /^[ \t]*\d+\.$/.test(line))) continue;
    }
    ends.push(end);
  }
  return ends;
}

/**
 * Whether the clause break `m` in `text` is a dash between two numbers or amounts ("50 dollars - 100 dollars", "$1,500 -
 * $200"): cut there, they were heard as two prices, "fifty dollars." then "One hundred dollars" (voice-speaking-c3-1).
 */
const betweenAmounts = (text: string, m: RegExpExecArray) =>
  /[—–-]/.test(m[0]) && /\d(?:[ \t]?[\p{L}]+)?$/u.test(text.slice(Math.max(0, m.index - 24), m.index)) && /^[$£€¥]?\d/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 2));

/** Cuts `chunk` at its first clause break (", " "; " " — ") between `min` and `max` characters, or returns it whole. */
function cutAtClause(chunk: string, min: number, max: number): [string, string] | null {
  const re = /[,;:]\s+|\s+[—–-]\s+/g;
  for (let m = re.exec(chunk); m; m = re.exec(chunk)) {
    if (m.index < min || betweenAmounts(chunk, m)) continue;
    if (m.index > max) break;
    const at = m.index + m[0].length;
    return [chunk.slice(0, at).trim(), chunk.slice(at).trim()];
  }
  return null;
}

/**
 * Words a long sentence with no comma can be cut before: the voice pauses there as a speaker would ("I looked through
 * the folder you mentioned | and found…"). Not "to", "for", "from" or "with", which so often follow a verb ("is going
 * | to take" was said with a full stop's fall: voice-speaking-r2), "until", "after" and "before" only where a clause
 * follows them ("until it finishes", never "from two | until four"), and never "between two | and four".
 */
const JOINS = /(?<!\bbetween\s+[\p{L}\p{N}']+)\s+(?=(?:and|but|or|so|because|which|that|while|when|where|together)\s|(?:until|after|before)\s+(?:I|you|he|she|it|we|they|this|there)\b)/giu;
/**
 * Where a phrase starts, for a long sentence with no joining word: before a preposition, though not one just after
 * "is" or "going" ("is | at"), rather than at a space inside a phrase ("installing on | this computer", "in the large
 * | room": voice-speaking-r2).
 */
const PHRASES = /(?<!\b(?:is|are|was|were|be|been|am|going|get|got|go|come))\s+(?=(?:in|on|at|for|from|with|about|into|onto|over|under|between|through|during|near|by|across|behind)\s)/gi;

/**
 * Where to cut `chunk`: before its first joining word between `min` and `max` characters that leaves FIRST_WORDS words
 * or more before it, else before its last phrase there, else at its last space before `max` (voice-speaking-8); -1 when
 * none fits. `ok`: whether a cut there may be made (a stream's Markdown is closed there: voice-speaking-r2).
 */
function joinAt(chunk: string, min: number, max: number, ok: (at: number) => boolean = () => true): number {
  const enough = (at: number) => (chunk.slice(0, at).match(/[\p{L}\p{N}]+/gu) ?? []).length >= FIRST_WORDS && ok(at);
  for (const m of chunk.matchAll(JOINS)) {
    if (m.index < min) continue;
    if (m.index > max) break;
    if (enough(m.index)) return m.index;
  }
  let phrase = -1;
  for (const m of chunk.matchAll(PHRASES)) {
    if (m.index > max) break;
    if (m.index > min && enough(m.index)) phrase = m.index;
  }
  if (phrase > 0) return phrase;
  for (let at = chunk.lastIndexOf(" ", max); at > min; at = chunk.lastIndexOf(" ", at - 1)) if (ok(at)) return at;
  return -1;
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
  // A line ending with a colon ends its piece too (sentenceEnds), so the line it leads into is never cut after its own
  // label ("To do this:\nStep 1: Open…" was said "To do this: Step 1:", then the step: voice-speaking-c3-2).
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
  /** Where sentenceCut looks for sentence ends again: none before it can be cut, then or later (voice-speaking-r4). */
  private scanFrom = 0;
  /** The start of each whole line of `raw` that opens or closes a code block, and of the first line not looked at yet. */
  private fences: number[] = [];
  private fenceScan = 0;

  /** `maxChars`: the most of an answer said aloud (SPOKEN_MAX); the rest is left to the bubble, which shows it all. */
  constructor(private maxChars = SPOKEN_MAX) {}

  /** More of the answer: the sentences it completed, as spoken text (none, often). */
  push(delta: string): string[] {
    this.raw += delta;
    const cut = this.safeCut();
    if (cut <= this.said) return [];
    const spoken = spokenText(this.raw.slice(this.said, cut), { ledIn: this.ledIn(), lineStart: this.lineStart(), afterLabel: this.afterLabel() });
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
    const spoken = spokenText(rest, { ledIn: this.ledIn(), lineStart: this.lineStart(), afterLabel: this.afterLabel() });
    const out = spoken.trim() ? this.budget(spoken) : [];
    const question = this.closingQuestion();
    if (question) out.push(question);
    this.reset();
    return out;
  }

  /**
   * Whether what is said next starts on the line after one ending with a colon that was said already ("Here's what I'll
   * do:" said on its own, then its steps): spokenText ends those lines as a list's (voice-speaking-3). They were said in
   * one breath, the steps cut from the line that leads into them.
   */
  private ledIn(): boolean {
    return /:[ \t]*\n(?:[ \t]*\n)?[ \t]*$/.test(this.raw.slice(Math.max(0, this.said - SCAN_BACK), this.said));
  }

  /**
   * The start of the line what is said next starts inside, said already ("" at a line's start): a long first sentence
   * cut at a space before an arrow ("…System Services" | " → Accessibility…") goes on with its "to" (voice-speaking-v4-3),
   * and the rest of a labelled step cut at its comma ("Step 1: Open Settings," | "then go to Privacy\nStep 2: …") ends
   * before the next label (voice-speaking-v4-4).
   */
  private lineStart(): string {
    return this.said ? this.raw.slice(this.raw.lastIndexOf("\n", this.said - 1) + 1, this.said) : "";
  }

  /**
   * Whether what is said next starts on the line after a labelled step said already ("Step 1: …" said once "Step 2:"
   * came): that step ends as the list's next one does, the last of them too (voice-speaking-c4-1).
   */
  private afterLabel(): boolean {
    if (this.raw[this.said - 1] !== "\n") return false;
    return labelLine(this.raw.slice(this.raw.lastIndexOf("\n", this.said - 2) + 1, this.said - 1));
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
    this.scanFrom = 0;
    this.fences = [];
    this.fenceScan = 0;
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
    // (A line break before the answer's words is no line of it: voice-speaking-r4-1.)
    const lead = /^\s*/.exec(this.raw)?.[0].length ?? 0;
    if (this.raw.length <= lead + FIRST_MAX) return 0;
    const head = this.raw.slice(lead, lead + FIRST_MAX + 1);
    // Only on the answer's first line, as a sentence: not in a list, a heading, a quote or a table.
    if (head.includes("\n") || /^[ \t]*(?:[|#>*+-]|\d+[.)])/.test(head)) return 0;
    // Never inside a code span or a link's words: cut there, its backtick or its address would be said (voice-speaking-r2).
    // Nor just after an arrow, which ended the piece with "right arrow" (voice-speaking-2: a third of long paths).
    return Math.max(0, joinAt(this.raw, lead + FIRST_MIN, lead + FIRST_MAX, at => !/(?:[←→↑↓]|->)[ \t]*$/.test(this.raw.slice(Math.max(0, at - 4), at)) && !speechMarkupOpen(this.raw.slice(0, at))));
  }

  /**
   * The first clause break of the answer, when it can be said on its own (0: none yet). Only on its first line: past it,
   * a line said without the lines beside it can't be told from a list's ("Step 1: Open Settings\nStep 2:" said "Open
   * Settings Step 2": voice-speaking-c3-2), as joinCut's first sentence is. A line break before the answer's words, or
   * a first line of its own ("OK", "Here's what I found") with no label or colon, is no list, so the first clause of
   * the line after it is said too, when that line is no label and its words before the clause are more than a list's
   * short line has: they held the first sound until the whole first sentence had come (voice-speaking-r4-1).
   */
  private clauseCut(): number {
    const re = /[,;:]\s+|\s+[—–-]\s+/g;
    for (let m = re.exec(this.raw); m; m = re.exec(this.raw)) {
      if (m.index < FIRST_MIN || betweenAmounts(this.raw, m)) continue;
      // (A dash is judged by what comes after it: wait for that.)
      if (/[—–-]/.test(m[0]) && m.index + m[0].length + 2 > this.raw.length) return 0;
      const before = this.raw.slice(0, m.index);
      const lines = before.trimStart().split("\n");
      if (lines.length > 2) return 0;
      if (lines.length === 2 && (labelLine(lines[0]) || /:[ \t]*$/.test(lines[0]) || labelLine(lines[1]) || lines[1].trim().split(/\s+/).length <= 4)) return 0;
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
    for (let nl = this.raw.indexOf("\n", this.fenceScan); nl >= 0; nl = this.raw.indexOf("\n", this.fenceScan)) {
      if (FENCE_LINE.test(this.raw.slice(this.fenceScan, nl))) this.fences.push(this.fenceScan);
      this.fenceScan = nl + 1;
    }
    const tail = FENCE_LINE.test(this.raw.slice(this.fenceScan)) ? this.fenceScan : -1;
    // A possible end judged for good (SCAN_BACK): sentenceEnds looks again only after the last of them, never at all of
    // a long table or code block on every delta (voice-speaking-r4: a 12,000-character table cost 20 s of main's time).
    const lastBreak = this.fenceScan - 1;
    const settled = (at: number) => at <= lastBreak || (at > lastBreak + 1 && at <= this.raw.length - SCAN_BACK);
    let best = 0, fence = 0, scanned = this.scanFrom;
    for (const end of sentenceEnds(this.raw, Math.max(this.said, this.scanFrom), at => { if (settled(at)) scanned = at; })) {
      if (end <= this.said) continue;
      // Inside a code block: as many fence lines start before it as speechMarkupOpen would count, and an odd number.
      while (fence < this.fences.length && this.fences[fence] < end) fence++;
      if ((fence + (tail >= 0 && tail < end ? 1 : 0)) % 2 !== 0) continue;
      const before = this.raw.slice(0, end);
      // In a table (a line that starts with "|"), or right after one: wait for the line after it.
      const line = before.slice(before.lastIndexOf("\n") + 1);
      if (/^[ \t]*\|/.test(line)) continue;
      if (speechMarkupOpen(before)) continue;
      best = end;
    }
    // Every end before `scanned` was cut at (`said` is past it) or can't be: they aren't looked at again.
    this.scanFrom = Math.max(this.scanFrom, scanned);
    return best;
  }
}
