/**
 * Personal vocabulary for recognition (docs/ASSISTANT.md "Personalisation"): Moonshine runs offline and can't be told
 * which names to expect, so what it heard is corrected after it, against the user's own words: Ember's name at the start
 * of a request ("Amber, …" → "Ember, …"), the apps installed here, the names in what the user told Ember to remember
 * (memory in force, `user` facts only), the corrections the user taught it ("That's not what I said"), and, a little
 * more readily, the words of what Ember expects them to say next (predict.ts).
 *
 * It corrects only when it is sure: a near-miss that sounds and reads like one entry (phonetic.ts `soundsLike` at
 * FUZZY_MIN or more) clearly ahead of any other, never a common word on its own, never digits. A request that is about
 * something risky (sending, deleting, paying…: policy's own words) or that addresses someone (message, tell, call,
 * invite…: ADDRESSES, where a corrected name would change who gets it) is left as heard but for Ember's name, and a
 * correction that would make a request risky is undone whole: policy and the conversation get the raw words then.
 * Pure: main passes the lexicon and the risk test, and logs what changed as counts only (never the words).
 */

import { letters, soundsLike } from "./phonetic";

/** Where an entry comes from (what the log counts). */
export type LexiconSource = "name" | "app" | "memory" | "learned" | "predicted";

/** A word or name the user is likely to say, as it should be written ("Priya", "VS Code"), from where. */
export interface LexiconEntry { text: string; source: Exclude<LexiconSource, "name" | "learned"> }

/** A correction the user taught: what Ember heard (as the recogniser wrote it) and what they meant. */
export interface LearnedCorrection { heard: string; meant: string }

export interface Lexicon {
  entries: readonly LexiconEntry[];
  learned: readonly LearnedCorrection[];
}

export interface Corrected {
  /** What the conversation and policy get. */
  text: string;
  /** What the recogniser wrote. */
  raw: string;
  /** Corrections made, by source (counts only: what the log says). */
  counts: Partial<Record<LexiconSource, number>>;
  /**
   * Left as heard: the request is about something risky ("risky"), addresses someone ("addressed"), or a correction
   * would have made it risky ("newly-risky").
   */
  held?: "risky" | "addressed" | "newly-risky";
}

/**
 * The least `soundsLike` for a correction, and the lead it needs over the next entry. Measured on the synthesised name
 * clips (docs/ASSISTANT.md): real near-misses scored 0.86 and more, different words 0.78 at most.
 */
export const FUZZY_MIN = 0.85;
export const FUZZY_LEAD = 0.05;
/** The words Ember expects next are taken a little more readily (lightly biased towards: predict.ts). */
export const PREDICTED_BONUS = 0.03;
/** A word shorter than this (letters) is too short to correct by sound: "Al", "Jo", "it". */
const MIN_LETTERS = 4;

/**
 * Common English words and Ember's own request words: never corrected on their own into a name ("close" stays "close",
 * not "Clocks"). Only a run of them written together as a name is ("fire fox" → "Firefox").
 */
export const COMMON = new Set(`a about above after again all also am an and any are as at back be because been before being below
between both but by can could did do does doing done down during each few for from further had has have having he her here
hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same
she should so some such than that the their them then there these they this those through to too under until up very was we
were what when where which while who whom why will with would you your yours yourself
open close closed show find search play pause stop start turn read write say tell send make give take keep put set move copy
paste save print call mail email message note notes file files folder folders window windows tab tabs page pages screen music
song video photo photos picture pictures text word words document documents settings setting light night dark mode volume
sound brighter dimmer bigger smaller louder quieter next last first previous same again please thanks thank okay yes yeah
time today tomorrow morning evening afternoon week month year minute minutes hour hours timer alarm reminder remind remember
calendar meeting weather news home work office desk desktop computer phone app apps program programs browser web site link
new old other another this that those one two three four five six seven eight nine ten
fire fox code team teams chrome edge word excel outlook mail maps clock clocks photo calculator terminal`.split(/\s+/).filter(Boolean));

/**
 * Words that address someone or send something to them: a corrected name there would change who gets it ("Message Pria"
 * is not "Message Priya" unless the user says so). Policy's risky words don't all cover these ("tell", "call", "text").
 */
export const ADDRESSES = /\b(e-?mail(?:ed|ing|s)?|mail(?:ed|ing|s)?|message(?:d|s)?|messaging|text(?:ed|ing|s)?|tell(?:s|ing)?|told|dm(?:s|ed)?|write\s+(?:to|back)|writ(?:e|ing)\s+an?\s+(?:email|message|note)|call(?:s|ed|ing)?|ring|phone|invite(?:d|s)?|inviting|repl(?:y|ies|ied|ying)|respond|answer|send(?:s|ing)?|sent|forward(?:ed|ing|s)?|share(?:d|s)?|sharing|ping(?:ed|s)?|cc|bcc|contact|notify|chat\s+with|meet(?:ing)?\s+with)\b/i;

/**
 * A request that only looks something up: it starts (after Ember's name and politeness) with what, who, when, where,
 * find, search, show, look up or read. Only there may a word be corrected into a person's name from memory (or a
 * suggestion's): anything else (ask, remind, add, give, let, assign, book, Slack, Zoom…) may hand something to that
 * person, and no list of verbs covers them all, so a name there stays as heard (review of #145).
 */
export const LOOKS_UP = /^\W*(?:(?:hey|hi|ok|okay|oh)[\s,.!]+)?(?:ember[\s,.!]+)?(?:(?:please|so|and|um|uh)[\s,.!]+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:what|who|whose|when|where|find|search|show|look\s*up|read)\b/i;

/** Ember's name as the recogniser writes it at the start of a request (engine.ts takes these for the wake already). */
const NAME_START = /^(\W*(?:(?:hey|hi|ok|okay|oh)[\s,.!]+)?)(amber|emma|emmer|umber|anber|embre|ember)\b(?!['’]s\b)/i;

interface Token { word: string; sep: string }

/** Words and what follows each (spaces, punctuation), so the text goes back together as it was. */
function tokens(s: string): { lead: string; list: Token[] } {
  const lead = /^[^\p{L}\p{N}]*/u.exec(s)?.[0] ?? "";
  const list: Token[] = [];
  const re = /([\p{L}\p{N}][\p{L}\p{N}'’-]*)([^\p{L}\p{N}]*)/gu;
  let m: RegExpExecArray | null;
  re.lastIndex = lead.length;
  while ((m = re.exec(s))) list.push({ word: m[1], sep: m[2] });
  return { lead, list };
}

const key = (ws: readonly string[]) => ws.map(letters).join(" ");

/** Each entry once, with its letters and word count; entries too short to correct by sound are left out. */
function prepared(entries: readonly LexiconEntry[]) {
  const seen = new Map<string, { text: string; source: LexiconEntry["source"]; joined: string; words: number }>();
  for (const e of entries) {
    const text = e.text.trim().replace(/\s+/g, " ");
    const joined = letters(text);
    if (joined.length < MIN_LETTERS || text.length > 40) continue;
    const words = text.split(" ").length;
    if (words > 3) continue;
    const had = seen.get(joined);
    // The user's own (memory) wins over an app's spelling, and either over a prediction's.
    const rank = (s: LexiconEntry["source"]) => (s === "memory" ? 3 : s === "app" ? 2 : 1);
    if (!had || rank(e.source) > rank(had.source)) seen.set(joined, { text, source: e.source, joined, words });
  }
  return [...seen.values()];
}

/**
 * The transcript `raw` corrected against `lex`. `risky` says whether words are about something risky (main passes
 * policy's isRiskyLabel for its OS).
 */
export function correctTranscript(raw: string, lex: Lexicon, risky: (words: string) => boolean): Corrected {
  const counts: Partial<Record<LexiconSource, number>> = {};
  const count = (s: LexiconSource) => { counts[s] = (counts[s] ?? 0) + 1; };
  // Ember's name first: it changes no meaning, so it is fixed even in a risky request.
  let text = raw;
  const name = NAME_START.exec(raw);
  if (name && name[2] !== "Ember") { text = raw.slice(0, name[1].length) + "Ember" + raw.slice(name[0].length); count("name"); }
  if (risky(raw)) return { text, raw, counts, held: "risky" };
  if (ADDRESSES.test(raw)) return { text, raw, counts, held: "addressed" };

  const { lead, list } = tokens(text);
  const out: Token[] = [];
  // A name from memory (or a suggestion's) is only ever corrected into in a request that just looks something up.
  const lookup = LOOKS_UP.test(raw);
  const entries = prepared(lex.entries).filter(e => lookup || (e.source !== "memory" && e.source !== "predicted"));
  // (A correction kept before the rules below, or written by hand, is held to them too.)
  const learned = lex.learned.filter(l => learnable(l.heard.split(/\s+/), l.meant.split(/\s+/)))
    .map(l => ({ heard: key(l.heard.split(/\s+/).filter(Boolean)), meant: l.meant.trim(), n: l.heard.split(/\s+/).filter(Boolean).length })).filter(l => l.n > 0 && l.n <= 4 && l.meant);
  let i = 0;
  while (i < list.length) {
    // A run may only cover words with nothing but spaces between them (no punctuation inside a name).
    const runMax = (n: number) => { for (let k = i; k < i + n - 1; k++) if (k >= list.length || /[^\s]/.test(list[k].sep)) return false; return i + n <= list.length; };
    let done = false;
    // What the user taught, longest first.
    for (const l of [...learned].sort((a, b) => b.n - a.n)) {
      if (!runMax(l.n) || key(list.slice(i, i + l.n).map(t => t.word)) !== l.heard) continue;
      out.push({ word: l.meant, sep: list[i + l.n - 1].sep });
      count("learned");
      i += l.n;
      done = true;
      break;
    }
    if (done) continue;
    // A near-miss of one entry, over one to three words.
    let best: { score: number; n: number; e: (typeof entries)[number] } | null = null;
    let second = 0;
    for (let n = 3; n >= 1; n--) {
      if (!runMax(n)) continue;
      const ws = list.slice(i, i + n).map(t => t.word);
      if (ws.some(w => /\d/.test(w))) continue;
      const joined = ws.map(letters).join("");
      if (joined.length < MIN_LETTERS) continue;
      const allCommon = ws.every(w => COMMON.has(letters(w)));
      for (const e of entries) {
        if (e.words > n + 1 || n > e.words + 1) continue;
        const ratio = joined.length / e.joined.length;
        if (ratio < 0.7 || ratio > 1.4) continue;
        // Common words become a name only when written as it is ("fire fox" → "Firefox"), never by sound.
        const score = joined === e.joined ? 1 : allCommon ? 0 : soundsLike(joined, e.joined) + (e.source === "predicted" ? PREDICTED_BONUS : 0);
        if (!best || score > best.score) { if (best && best.e !== e) second = Math.max(second, best.score); best = { score, n, e }; }
        else if (best.e !== e) second = Math.max(second, score);
      }
    }
    if (best && best.score >= FUZZY_MIN && best.score - second >= FUZZY_LEAD) {
      const heard = list.slice(i, i + best.n).map(t => t.word).join(" ");
      // Already written so (case aside): nothing to correct.
      if (heard.toLowerCase() === best.e.text.toLowerCase()) { out.push(...list.slice(i, i + best.n)); i += best.n; continue; }
      out.push({ word: best.e.text, sep: list[i + best.n - 1].sep });
      count(best.e.source);
      i += best.n;
      continue;
    }
    out.push(list[i]);
    i++;
  }
  const corrected = lead + out.map(t => t.word + t.sep).join("");
  // A correction mustn't make the request risky: as heard, then (the name aside, which risks nothing).
  if (risky(corrected)) return { text: raw, raw, counts: {}, held: "newly-risky" };
  return { text: corrected, raw, counts };
}

/**
 * Names in what the user told Ember to remember (memory's `user` facts only): capitalised words that aren't common ones,
 * and words with inner capitals or digits ("EmberLab", "Q3"); at most `max`.
 */
export function memoryNames(facts: readonly { text: string; source: string }[], max = 200): string[] {
  const out = new Set<string>();
  for (const f of facts) {
    if (f.source !== "user") continue;
    for (const m of f.text.matchAll(/\b[\p{Lu}][\p{L}'’-]{2,}(?:\s+[\p{Lu}][\p{L}'’-]{2,}){0,2}\b/gu)) {
      const words = m[0].split(/\s+/).filter(w => !COMMON.has(letters(w)));
      if (words.length) out.add(words.join(" "));
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}

/**
 * Words a request turns on: changing one changes what is asked ("open" → "close", "allow" → "deny"), which no
 * mishearing correction may do.
 */
export const REQUEST_VERBS = new Set(`open close show hide start stop quit exit launch run play pause resume allow deny accept decline approve reject
turn switch enable disable add remove delete erase clear save send move copy paste cut undo redo read write call message
email mail reply forward install uninstall update lock unlock mute unmute yes no not dont don't cancel keep go do make
create set reset find search buy pay order book sign log share post submit print rename archive empty`.split(/\s+/).filter(Boolean));

/**
 * Number words, which a correction may never swap ("fifteen" for "fifty" changes what is asked): zero to nineteen, the
 * tens (also written with a hyphen: "twenty-five"), hundred, thousand, million, billion, the ordinals, half, double,
 * dozen, and "a" or "an" as a quantity.
 */
export const NUMBER_WORD = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|double|twice|a|an|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|thousandth)$/;

/** Whether `word` is, or is written with, a number: digits, or a number word (also "twenty-five", word by word). */
export const isNumberWord = (word: string): boolean => /\d/.test(word) || word.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).some(w => NUMBER_WORD.test(w));

/**
 * Whether a correction may be kept and used: the heard and meant words aren't all common ones (a mishearing is of a
 * name or an unusual word, never "open" for "close"), no verb a request turns on is among them, and none is a number
 * word or digit ("fifteen" for "fifty").
 */
export function learnable(heard: readonly string[], meant: readonly string[]): boolean {
  if ([...heard, ...meant].some(isNumberWord)) return false;
  const h = heard.map(letters).filter(Boolean), m = meant.map(letters).filter(Boolean);
  if (!h.length || !m.length) return false;
  if ([...h, ...m].every(w => COMMON.has(w))) return false;
  return ![...h, ...m].some(w => REQUEST_VERBS.has(w));
}

/**
 * What the user taught by retyping a request ("That's not what I said"): the words that differ between what Ember
 * heard and what they meant, as one correction (at most four words heard, six meant), or null when nothing does, too
 * much does (a different request, not a mishearing), the meant words are risky where the heard ones weren't (a
 * correction must never teach Ember to hear a risky request), or it isn't `learnable` (common words, a verb changed).
 */
export function learnFrom(heard: string, meant: string, risky: (words: string) => boolean): LearnedCorrection | null {
  const a = tokens(heard).list.map(t => t.word), b = tokens(meant).list.map(t => t.word);
  let s = 0;
  while (s < a.length && s < b.length && letters(a[s]) === letters(b[s])) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && letters(a[a.length - 1 - e]) === letters(b[b.length - 1 - e])) e++;
  const h = a.slice(s, a.length - e), m = b.slice(s, b.length - e);
  if (!h.length || !m.length || h.length > 4 || m.length > 6) return null;
  // More than half the request changed: it's another request, not a word misheard.
  if (h.length > Math.max(2, a.length / 2)) return null;
  const hw = h.join(" "), mw = m.join(" ");
  if (letters(hw).length < 2 || (risky(mw) && !risky(hw)) || !learnable(h, m)) return null;
  return { heard: hw.toLowerCase(), meant: mw };
}
