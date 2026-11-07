/**
 * Asking (docs/MEMORY.md step 5): Ember notices the names in the user's requests that recall keeps finding nothing
 * about, and, at most once a day while the user is idle and nothing is under way, asks about the one it missed most
 * ("Who or what is “Priya”?"). The answer, in the user's own words, is a `user` fact about that name. The question is
 * built here from the name alone (words from the user's own requests, never from the screen); no model writes it.
 *
 * Also "forget that": forgets what Ember learned or was told last, within a few minutes, without a model turn.
 * Pure: MemoryLearning (./learning.ts) decides when.
 */

import type { NewFact } from "./graph";
import { soundsLikeInstruction } from "./learn";
import { fold, nameKey } from "./text";

/** A gap is asked about once recall has missed it in this many requests. */
export const GAP_MISSES = 2;
/** At most one question in this long (ms). */
export const QUESTION_EVERY_MS = 24 * 3_600_000;
/** How long a question waits for its answer (ms). */
export const ANSWER_WAIT_MS = 10 * 60_000;
/** "Forget that" reaches back this far (ms). */
export const FORGET_THAT_MS = 10 * 60_000;

/** Capitalised words that are seldom names. */
const COMMON = new Set([
  "i", "ember", "hey", "ok", "okay", "please", "thanks", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
  "december", "today", "tomorrow", "yesterday", "settings", "english", "the", "a", "an", "what", "who", "where", "when",
  "why", "how", "can", "could", "would", "will", "is", "are", "do", "does", "open", "show", "tell", "find", "send", "make",
]);

/** The most words a name has. */
export const MAX_NAME_WORDS = 3;

/** The names in a request: capitalised words not at its start (and runs of them: "Priya Shah"). */
export function namesIn(request: string): string[] {
  const out: string[] = [];
  for (const sentence of request.split(/[.!?\n]+/)) {
    const words = sentence.trim().split(/\s+/);
    let run: string[] = [];
    // At most three words: a longer capitalised run is a title or a heading, not a name (review of PR #142).
    const end = () => { if (run.length && run.length <= MAX_NAME_WORDS) out.push(run.join(" ")); run = []; };
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^\p{L}]+|[^\p{L}\p{N}]+$/gu, "").replace(/'s$/, "");
      if (i > 0 && /^\p{Lu}[\p{L}\p{N}-]{1,30}$/u.test(w) && !COMMON.has(fold(w))) run.push(w);
      else end();
    });
    end();
  }
  return [...new Set(out)].slice(0, 5);
}

/** Names recall missed, counted per request. */
export class Gaps {
  private misses = new Map<string, { name: string; n: number }>();

  /** Recall found nothing for `request`; `known`: whether memory already knows a name. */
  missed(request: string, known: (name: string) => boolean): void {
    for (const name of namesIn(request)) {
      // A name that reads like an order ("Always Approve Wire Transfers") is never asked about.
      if (known(name) || soundsLikeInstruction(name)) continue;
      const key = nameKey(name);
      const m = this.misses.get(key) ?? { name, n: 0 };
      this.misses.set(key, { name: m.name, n: m.n + 1 });
    }
    if (this.misses.size > 50) this.misses.delete(this.misses.keys().next().value!);
  }

  /** The gap missed most (at least GAP_MISSES times), or null. */
  top(): string | null {
    let best: { name: string; n: number } | null = null;
    for (const m of this.misses.values()) if (m.n >= GAP_MISSES && (!best || m.n > best.n)) best = m;
    return best?.name ?? null;
  }

  /** Asked about (or learned): not asked again. */
  drop(name: string): void { this.misses.delete(nameKey(name)); }
  clear(): void { this.misses.clear(); }
}

/** Ember's question about a gap. */
export function gapQuestion(name: string): string {
  return `You've mentioned “${name.replace(/[“”"<>]/g, "")}” a few times. Who or what is that? I'll remember your answer, or say “skip”.`;
}

/** An answer that declines the question. */
const DECLINE = /^(?:skip(?:\s+it)?|no(?:\s+thanks)?|not\s+now|never\s*mind|i'?d\s+rather\s+not(?:\s+say)?|don'?t\s+ask(?:\s+me)?(?:\s+that)?|i\s+don'?t\s+know|pass)[.!]*$/i;
export const declinesQuestion = (text: string) => DECLINE.test(text.trim());

/**
 * Whether `text` answers the question rather than asking something new: a short statement (at most 25 words, not a
 * question). A request ("open Mail") is passed on to the conversation, and the question is let go of.
 */
export function answersQuestion(text: string): boolean {
  const t = text.trim();
  return !!t && t.split(/\s+/).length <= 25 && !looksLikeRequest(t);
}

/** A request or a question to Ember, which goes to the conversation, never into memory as an answer. */
const REQUEST = /^(?:(?:hey\s+)?ember[,.!]?\s+)?(?:please\s+)?(?:(?:open|show|start|run|send|write|draft|find|search|tell|close|play|stop|remind|set|turn|make|create|delete|remove|email|mail|message|call|book|schedule|check|move|copy|rename|install|launch|reply|forward|share|post|upload|download|print|save|add|go)\s+(?!source\b)\S|(?:what|who|where|when|why|how|which|can|could|would|will|is|are|do|does|did)\b)/i;
export function looksLikeRequest(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || REQUEST.test(t);
}

/**
 * Whether an answer to "who or what is <name>?" is about the name: it names it, or starts as a description does ("She
 * leads the platform team", "Our billing service", "It's a project"). "The build is broken" isn't one.
 */
export function describes(text: string, name: string): boolean {
  const t = text.trim();
  if (fold(t).includes(fold(name))) return true;
  // "It's…" or "That…" alone describes nothing ("It's raining"): only with what it is ("It's our billing service").
  return /^(?:(?:she|he|they)(?:['’](?:s|re)\b|\s+\p{L}+)|(?:it|that|this)(?:['’]s|\s+is|\s+was)\s+(?:a|an|the|our|my|his|her|their|one\s+of)\s+\p{L}|(?:a|an|my|our|his|her|their|one\s+of)\s+\p{L})/iu.test(t);
}

/** The answer as a `user` fact about the name asked after. */
export function gapFact(name: string, answer: string): NewFact {
  const a = answer.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  return { text: `${name}: ${a}`, about: [{ name }, { name: "User", kind: "person" }], source: "user" };
}

/** "Forget that", "Ember, forget it", "please forget that". */
const FORGET_THAT = /^(?:(?:hey\s+)?ember[,.!]?\s+)?(?:please\s+)?(?:forget|don'?t\s+remember)\s+(?:that|it|this)(?:\s+please)?[.!]*$/i;
export const isForgetThat = (text: string) => FORGET_THAT.test(text.trim());

/** The reply to "forget that": the fact, and how many of Ember's own notes made from it went too (memory-3). */
export const forgotReply = (text: string, derived = 0) =>
  `Forgotten: “${text.replace(/[“”]/g, "")}”${derived ? `, and ${derived === 1 ? "a note" : `${derived} notes`} I made from it` : ""}.`;
export const NOTHING_TO_FORGET = "I haven't kept anything from just now. Say what to forget, or use Forget in Settings › Memory.";

/** "Ember, please", "can you": what may come before a remember or forget request. */
const LEAD = String.raw`^(?:(?:hey\s+)?ember[,.!]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
/** "Remember that…", "don't forget my…", "keep in mind…" (never "remember to…" or "don't forget to…": reminders). */
const REMEMBER_ASK = new RegExp(String.raw`${LEAD}(?:remember|don'?t\s+forget|do\s+not\s+forget|keep\s+in\s+mind|make\s+a\s+note)\s+(?!to\b)\S`, "i");
/** "Forget that I…", "forget my address", "don't remember where I live" (never "forget about…" or "forget to…"). */
const FORGET_ASK = new RegExp(String.raw`${LEAD}(?:forget|don'?t\s+remember|do\s+not\s+remember|stop\s+remembering|unlearn)\s+(?!to\b|about\b|it\b)\S`, "i");
/** More than the one request: another sentence, or ", and…" / "and then…" (the conversation takes those whole). */
const MORE = /[.!?]\s+\S|,\s*(?:and|then)\b|\band\s+then\b/i;

/**
 * Whether `text` is only a request for Ember to remember something (`remember`) or forget something it keeps
 * (`forget`), or neither: what Ember answers in code while memory isn't in force, so it never promises what it
 * can't do (memory-v1).
 */
export function memoryAsk(text: string): "remember" | "forget" | null {
  const t = text.trim();
  if (MORE.test(t.replace(/[.!]+$/, ""))) return null;
  if (REMEMBER_ASK.test(t)) return "remember";
  if (FORGET_ASK.test(t)) return "forget";
  return null;
}

/** What Ember says to "remember…" and "forget…" while memory is off; Settings › Memory opens at its switch. */
export const REMEMBER_OFF = "Memory is off, so I won't keep that after Ember closes. I've opened Memory in Settings.";
export const FORGET_OFF = "Memory is off, so I can't change what's saved. I've opened Memory in Settings.";
/** And to "forget…" while the organisation has turned memory off. */
export const FORGET_MANAGED = "Your organisation has turned memory off, so I can't change what's saved.";
