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
import type { MemoryOwnerReason } from "./owner";
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
export const forgotReply = (text: string, derived = 0, back: readonly string[] = []) =>
  `Forgotten: “${text.replace(/[“”]/g, "")}”${derived ? `, and ${derived === 1 ? "a note" : `${derived} notes`} I made from it` : ""}.${back.length ? ` I remember ${quotedAnd(back)} again.` : ""}`;
/** “A”, “A” and “B”, “A”, “B” and “C”: what is current again after a Forget (memory-12). */
const quotedAnd = (texts: readonly string[]) => {
  const q = texts.map(t => `“${t.replace(/[“”]/g, "")}”`);
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q.at(-1)}` : q.join("");
};
export const NOTHING_TO_FORGET = "I haven't kept anything from just now. Say what to forget, or use Forget in Settings › Memory.";

/** "Ember, please", "can you": what may come before a remember or forget request. */
const LEAD = String.raw`^(?:(?:hey\s+)?ember[,.!]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
/** "Can you…", "could you please…": a request put politely, which may end with "?" and still be no question. */
const POLITE = /^(?:(?:hey\s+)?ember[,.!]?\s+)?(?:please\s+)?(?:can|could|would|will)\s+you\b/i;
/** "…I said", "…what I told you": what the user said just now, which "forget" lets go of as "never mind". */
const SAID = String.raw`(?!\s+(?:said|say|told|asked|ask|wrote|typed|meant|mean|just|was\s+saying)\b)`;
/**
 * "Remember that…", "don't forget my…", "keep in mind…", "make a note that…". Never "remember to…" or "don't forget
 * to…" (reminders), "remember when, what, how…" or "remember me" (questions about what Ember knows), nor "make a note
 * in…" (a note in an app).
 */
const REMEMBER_ASK = new RegExp(String.raw`${LEAD}(?:remember|don'?t\s+forget|do\s+not\s+forget|keep\s+in\s+mind|make\s+a\s+(?:mental\s+)?note\s+(?:that|of)\b)\s*(?!to\b|when\b|what\b|how\b|who\b|where\b|which\b|whether\b|if\b|me\b)\S`, "i");
/**
 * "Forget that I…", "forget my address", "forget where I live", "forget everything about me", "don't remember that
 * Priya is my manager": the user asking Ember to stop knowing something about them, and nothing else. Never "forget
 * the…", "forget what I said" or "forget that email" (the conversation's: "never mind", or another request), nor
 * "forget about…" or "forget to…".
 */
const FORGET_ASK = new RegExp(String.raw`${LEAD}(?:forget|don'?t\s+remember|do\s+not\s+remember|stop\s+remembering|unlearn)\s+(?:`
  // "…that I work at Globex", "…I'm vegetarian", "…my wife's birthday" (never "…I said that").
  + String.raw`(?:that\s+)?(?:i\b${SAID}|i['’](?:m|ve|d)\b|my\b|we\b|our\b)`
  // "…where I live", "…who my manager is" (never "…what I said").
  + String.raw`|(?:where|what|who|when|how)\s+(?:i|my)\b${SAID}`
  // "…that Priya is my manager", "…that the office is in Leeds": a statement, never "…that email" or "…that file".
  + String.raw`|that\s+(?:\S+\s+){1,3}?(?:is|are|was|were|has|have|works|lives|likes|leads|uses|prefers)\b`
  // "…everything about me", "…all you know about me", "…me".
  + String.raw`|(?:everything|all)\s+(?:(?:you\s+)?(?:know|knew|learned|learnt|remember)\s+)?about\s+me\b|me\b)`, "i");
/** More than the one request: another sentence, or more after a comma or a semicolon (the conversation takes those). */
const MORE = /[.!?]\s+\S|[,;]\s*\S/;

/**
 * Whether `text` is only a request for Ember to remember something (`remember`) or to forget something it keeps about
 * the user (`forget`), or neither. A question ("Remember when we talked about Atlas?", "Remember me?") and a request
 * with more in it ("Forget what I said, open Firefox instead") are neither (memory-c1-1). While memory isn't in force,
 * only a forget request is answered in code (memory-v1); a remember request still goes to the conversation, which
 * keeps it until Ember closes, and Ember says after the answer that memory won't (`rememberNote`).
 */
export function memoryAsk(text: string): "remember" | "forget" | null {
  const t = text.trim();
  // (After "Ember," or "Hey Ember." the request starts: that comma is no more.)
  if (MORE.test(t.replace(/^(?:hey\s+)?ember[,.!]?\s+/i, "").replace(/[.!?]+$/, ""))) return null;
  // Asked as a question, unless it is a request put politely ("Can you remember that I'm vegetarian?").
  if (/\?$/.test(t) && !POLITE.test(t)) return null;
  if (REMEMBER_ASK.test(t)) return "remember";
  if (FORGET_ASK.test(t)) return "forget";
  return null;
}

/**
 * Why memory can't be used now: off, turned off by the organisation (`managed`), on under an earlier note the user
 * hasn't reviewed (`note`, memory-r4), or on but paused (MemoryOwnerReason, memory-2).
 */
export type MemoryNotNow = "off" | "managed" | "note" | MemoryOwnerReason;
/** The start of Ember's sentence saying why it can't use memory now. */
const NOT_NOW: Record<MemoryNotNow, string> = {
  off: "Memory is off",
  managed: "Your organisation has turned memory off",
  note: "Memory is paused until you review its updated note",
  checking: "I'm still checking your GitHub account",
  "signed-out": "Memory needs you signed in with GitHub",
  "own-provider": "Memory is paused while I use your own model provider",
  "org-provider": "Memory is paused while I use your organisation's model service",
  unverified: "I couldn't check your GitHub account",
  "other-account": "The memory saved on this computer isn't matched to your GitHub account",
  unowned: "The memory saved on this computer isn't matched to your GitHub account",
};

/** What Ember adds after its answer to "remember…" while memory isn't in force: a bubble and a line. */
export interface MemoryNote {
  title: string;
  text: string;
  /** The bubble offers Open Memory (Settings › Memory): never when the organisation turned memory off. */
  open: boolean;
}

/**
 * The truth after the conversation answered "remember…" while memory can't keep it (memory-c1-1): it knows what was
 * said until Ember closes, never after. Ember's words, never the model's.
 */
export function rememberNote(why: MemoryNotNow): MemoryNote {
  return {
    title: why === "off" || why === "managed" ? "Memory is off" : "Memory paused",
    text: `${NOT_NOW[why]}, so I won't keep this after Ember closes.`,
    open: why !== "managed",
  };
}

/**
 * Ember's answer to "forget…" while memory can't change what's saved, and whether Settings › Memory opens (where the
 * list and its Forget still are while memory is off): only for memory that is off, waits for its note, or isn't
 * matched to the account.
 */
export function forgetReply(why: MemoryNotNow): { text: string; open: boolean } {
  const open = why === "off" || why === "note" || why === "other-account" || why === "unowned";
  return { text: `${NOT_NOW[why]}, so I can't change what's saved.${open ? " I've opened Memory in Settings." : ""}`, open };
}

/** What Ember says to "forget…" while memory is off; Settings › Memory opens at its list. */
export const FORGET_OFF = forgetReply("off").text;
/** And to "forget…" while the organisation has turned memory off. */
export const FORGET_MANAGED = forgetReply("managed").text;
/** And to "get to know me" while memory waits for its updated note to be reviewed (memory-r4). */
export const INTRO_NOTE = "Memory is paused until you review its updated note. I've opened Memory in Settings.";
