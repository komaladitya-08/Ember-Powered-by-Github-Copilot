/**
 * Asking (docs/MEMORY.md step 5): Ember notices the names in the user's requests that recall keeps finding nothing
 * about, and, at most once a day while the user is idle and nothing is under way, asks about the one it missed most
 * ("Who or what is “Priya”?"). The answer, in the user's own words, is a `user` fact about that name. The question is
 * built here from the name alone (words from the user's own requests, never from the screen); no model writes it.
 *
 * Also "forget that": forgets what Ember learned or was told last, within a few minutes, without a model turn.
 * Pure: MemoryLearning (./learning.ts) decides when.
 */

import { APP_NAMES } from "../../shared/apps";
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
/**
 * "…I said", "…what I told you", "…I mentioned it", "…we talked about Atlas": what the user said just now, which
 * "forget" lets go of as "never mind" (memory-c1-1).
 */
const SAID = String.raw`(?!\s+(?:even\s+|ever\s+|just\s+)?(?:said|say|told|asked|ask|wrote|typed|meant|mean|just|was\s+saying|mentioned|mention|brought|bring|talked|talk|spoke|discussed|ever|even|sent|were\s+(?:saying|talking))\b)`;
/**
 * "Remember that…", "don't forget my…", "keep in mind…", "make a note that…", and what follows. Never "remember to…"
 * or "don't forget to…" (reminders), "remember when, what, how…" or "remember me" (questions about what Ember knows),
 * nor "make a note in…" (a note in an app).
 */
const REMEMBER_ASK = new RegExp(String.raw`${LEAD}(?:remember|don'?t\s+forget|do\s+not\s+forget|keep\s+in\s+mind|keep\s+(?:this|that)\s+in\s+mind|make\s+a\s+(?:mental\s+)?note(?:\s+(?:that|of)\b|(?=\s*:))`
  // "Add to your memory that I'm vegetarian" (memory-r3-2).
  + String.raw`|(?:add|save|put|store|write|keep)\s+(?:to|in|into)\s+(?:(?:your|ember['’]s)\s+)?memory(?:\s+that)?\b)\s*(?!to\b|when\b|what\b|how\b|who\b|where\b|which\b|whether\b|if\b|me\b)(\S.*)$`, "is");
/** "Remember," "keep in mind," or "remember -" with a pause after it. */
const REMEMBER_PAUSE = new RegExp(String.raw`^(${LEAD.slice(1)}(?:remember|keep\s+in\s+mind|don'?t\s+forget|do\s+not\s+forget))\s*(?:,|\s[-–—]+)\s*`, "i");
/**
 * What may come before "remember" and leave it a request to keep something (memory-r3-2): "okay", "so", "always", "in
 * future", "I want you to", "I'd like you to" ("Always remember that I'm vegetarian", "In future, remember…").
 */
const REMEMBER_LEAD = new RegExp(String.raw`^((?:(?:hey\s+)?ember[,.!]?\s+)?)(?:(?:ok(?:ay)?|so|and|also|now|right|alright|well|oh)\b[,.!]?\s+)*`
  + String.raw`(?:(?:always|in\s+(?:the\s+)?future|from\s+now\s+on|going\s+forward|for\s+(?:the\s+)?future)\b,?\s+)?(?:i\s+(?:want|need)\s+you\s+to\s+|i(?:['’]d|\s+would)\s+like\s+you\s+to\s+)?`
  + String.raw`(?=(?:please\s+)?(?:remember|keep\s+(?:in|this|that)\b|don'?t\s+forget|do\s+not\s+forget|make\s+a\s+(?:mental\s+)?note|add\s+to\b)\b)`, "i");
/**
 * "Remember that", "keep this in mind", "add that to your memory", "save it to memory": a request to keep what was just
 * said, which names nothing more (memory-r3-2). Never "save that to the memory card".
 */
const KEEP_THAT = new RegExp(String.raw`${LEAD}(?:(?:remember|memori[sz]e)\s+(?:this|that|it)|keep\s+(?:this|that|it)\s+in\s+mind`
  + String.raw`|(?:add|save|put|store|keep|commit|write)\s+(?:this|that|it)\s+(?:to|in|into)\s+(?:(?:your|ember['’]s)\s+)?(?:long[-\s]term\s+)?memory)`
  + String.raw`(?:\s+(?:please|for\s+me|for\s+later|too|as\s+well))?$`, "i");
/**
 * What follows "remember…" says something to keep: "that…", "I'm vegetarian", "my wife's birthday is 12 March", "the
 * deadline is Friday". "Remember the file I mentioned", "don't forget my umbrella" and "remember this" refer to
 * something, or ask for a reminder: Ember adds no "I won't keep this" after them (memory-r8).
 */
const STATES = /^(?:that\b|i\b|i['’]|we\b|we['’]|(?:they|you)\s+[a-z])|\b(?:is|are|was|were|am|isn['’]t|aren['’]t|wasn['’]t|has|have)\b|\b(?:it|that|there|he|she|they|what|who|this|here)['’]s\b|['’](?:re|m|ve)\b/i;
/** Words that open a noun phrase ("the file", "my umbrella"): the word straight after one names a thing. */
const DETERMINER = /^(?:the|my|our|your|his|her|their|this|that|these|those|a|an|some|its)$/i;
/** Who does something: after a thing named ("the file I mentioned", "the time we went") they describe that thing. */
const PRONOUN = /^(?:i|you|we|he|she|they|it)$/i;
/** Words that start a description of a thing named ("the tests that failed", "the client who called"): memory-r8. */
const RELATIVE = /^(?:that|which|who|whom|whose)$/i;
/** Participles that describe a thing named after it, not what happened ("the file attached", "the documents enclosed"). */
const DESCRIBES = /^(?:attached|enclosed|included|mentioned|listed|linked|shared|selected|highlighted|provided|uploaded|quoted|cited|shown|given|requested|specified|described|referenced)$/i;
/** Things people ask not to forget, whose "-s" is a plural, not a verb, before a place ("my car keys on the table"). */
const THINGS = /^(?:keys|glasses|sunglasses|shoes|boots|books|papers|documents|docs|notes|tickets|passports|bags|clothes|things|files|gloves|headphones|earbuds|pills|meds|medications|vitamins|chargers|cables|cards|photos|snacks|lunches|groceries)$/i;
/** What may stand before a number that only says when or where ("my meeting at 3"). */
const PREPOSITION = /^(?:at|on|in|by|for|from|to|of|with|about|until|till|after|before|around|near|under|over)$/i;
/** Past forms without "-ed" ("the standup got moved", "Priya left Globex"). */
const PAST = new Set([
  "went", "left", "came", "got", "had", "made", "said", "took", "gave", "began", "ran", "saw", "met", "found", "told", "thought", "brought",
  "bought", "sent", "kept", "felt", "knew", "grew", "wrote", "won", "lost", "paid", "sold", "did", "fell", "drove", "flew", "broke", "chose",
  "spent", "built", "taught", "caught", "became", "forgot", "led", "meant",
]);
/** What says something will, can or won't happen ("Priya will lead it", "Bob can't come"). */
const MODAL = /^(?:will|would|can|could|should|must|might|shall|won['’]t|can['’]t|cannot|doesn['’]t|don['’]t|didn['’]t|wouldn['’]t)$/i;
/**
 * After a name's "'s", the words that make it "is" ("Priya's my manager", "Bob's off on Friday", "Priya's leaving"), not
 * "Priya's birthday" or "Monday's meeting".
 */
const IS_AFTER = /^(?:my|our|the|a|an|his|her|their|your|not|off|on|in|at|out|away|back|from|over|here|there|always|never|still|now|leaving|going|coming|moving|starting|joining|working|staying|visiting|arriving|retiring|travelling|traveling|flying)$/i;

/**
 * Whether what follows "remember…" says something to keep (memory-r3-2): a statement with a verb after who or what it is
 * about ("my wife likes tulips", "Priya leads the platform team", "the standup moved to 4 pm", "Priya's my manager", "my
 * kids love pizza": memory-v4-4), a
 * label and its value ("my birthday: 12 March", "my phone number 07700 900123"), or STATES's words. Never what only points
 * at something: "the file I mentioned", "the documents Priya sent", "my keys", "my meeting at 3" (memory-r8).
 */
function statesSomething(rest: string): boolean {
  if (STATES.test(rest) || /\p{L}\s*:\s*\S/u.test(rest)) return true;
  const words = rest.split(/\s+/).map(w => w.replace(/^[^\p{L}\p{N}£$€]+|[^\p{L}\p{N}'’]+$/gu, "")).filter(Boolean);
  if (words.some((w, i) => /^\p{Lu}.*['’]s$/u.test(w) && IS_AFTER.test(words[i + 1] ?? ""))) return true;
  if (manySay(words)) return true;
  // A noun phrase's first word after its determiner is the thing itself ("my keys", "the steps"), never its verb.
  const from = DETERMINER.test(words[0] ?? "") ? 2 : 1;
  for (let v = from; v < words.length; v++) {
    const w = words[v]!;
    const next = words[v + 1];
    const ed = (x = "") => /^\p{Ll}{2,}ed$/u.test(x) || PAST.has(x);
    // "Remember Sam drives": a name and its verb, the request's last word (memory-r3-2), never an app's, a tool's or a
    // day's ("Remember Chrome updates", "Remember Monday standups": memory-v5-6).
    const named = v === 1 && words.length === 2 && /^\p{Lu}\p{Ll}+$/u.test(words[0]!) && isName(words[0]!);
    // "the issues users reported": who did what to the thing named, a description (memory-r8).
    if (v + 2 === words.length && /^\p{Ll}+s$/u.test(w) && !MODAL.test(w) && ed(next)) return false;
    // "my car keys on the table": a plural before a place, not a verb.
    const plural = THINGS.test(w) && (next === undefined || PREPOSITION.test(next));
    const verb = /^\p{Ll}/u.test(w) && (MODAL.test(w) || ed(w) || (/^\p{Ll}+[^siu'’]s$/u.test(w) && (next !== undefined || named) && !plural));
    const value = /^[£$€]?\d/u.test(w) && !PREPOSITION.test(words[v - 1]!) && !DETERMINER.test(words[v - 1]!);
    if (!verb && !value) continue;
    // "the file attached", "the documents enclosed": a thing described (memory-r8).
    if (DESCRIBES.test(w) && (next === undefined || PREPOSITION.test(next))) return false;
    const between = words.slice(from, v);
    // "the file I mentioned", "the tab I had open", "the documents Priya sent", "the tests that failed": a thing
    // described, not a fact.
    return !between.some(x => PRONOUN.test(x) || RELATIVE.test(x)) && !(v === words.length - 1 && between.some(x => /^\p{Lu}/u.test(x)));
  }
  return false;
}
/** Plurals without "-s" ("my children love it"). */
const PLURAL = /^(?:children|grandchildren|people|men|women|folks)$/i;
/** Words after a plural that aren't its verb ("my keys tomorrow morning"). */
const NOT_A_VERB = /^(?:and|or|but|then|too|also|please|today|tomorrow|tonight|yesterday|next|last|this|every|each)$/i;
/**
 * Whether `words` say what more than one does (memory-v4-4): "my kids love pizza", "our clients always want a summary",
 * "my wife and I prefer window seats", "Priya and I lead the team", a verb in its plain form with more words after it.
 * Never "my keys tomorrow morning", "my glasses case", "the steps you did" or "the time Priya and I went to Paris".
 */
function manySay(words: readonly string[]): boolean {
  const head = DETERMINER.test(words[0] ?? "") ? 1 : 0;
  const pair = /^and$/i.test(words[head + 1] ?? "") && /^(?:i|we)$/i.test(words[head + 2] ?? "") && (head === 1 || /^\p{Lu}\p{Ll}+$/u.test(words[0] ?? ""));
  // "my in-laws visit in May", "people call me Ram" (memory-r3-2).
  const many = pair || (head === 1 && (/^\p{Ll}[\p{Ll}-]+[^siu'’]s$/u.test(words[1] ?? "") || PLURAL.test(words[1] ?? ""))) || (head === 0 && PLURAL.test(words[0] ?? ""));
  const at = pair ? head + 3 : head + 1;
  const w = words[at] ?? "";
  // A plural's verb never ends in one "s": "the issues users reported" is a description (memory-r8).
  return many && at + 1 < words.length && /^\p{Ll}+$/u.test(w) && !/ing$/.test(w) && !/[^s]s$/.test(w)
    && ![PREPOSITION, DETERMINER, PRONOUN, NOT_A_VERB].some(list => list.test(w));
}
/**
 * What someone tells Ember about themselves after "my" or "our": "my address", "my wife's birthday", "my favourite
 * colour", "my old phone number". Only these, since "forget" is also the system's word for a device or a network ("my
 * AirPods", "my home Wi-Fi network") and the conversation's for an app's things ("my reminder", "my email to Bob") and
 * its own words ("my last message"): those reach the conversation (memory-c1-1).
 */
const ABOUT_ME = String.raw`(?:(?:full|first|last|middle|maiden|old|new|current|previous|real|legal|home|work|personal|private|mobile|postal|email|e-mail)\s+)?`
  + String.raw`(?:names?|nickname|surname|initials|age|birthdays?|birth\s*date|date\s+of\s+birth|pronouns|gender|nationality|religion|address(?:es)?|`
  // "My email" alone is the address ("forget my email"); with more after it, a message ("forget my email to Bob").
  + String.raw`(?:phone|mobile|cell)\s+numbers?|number|email\s+address(?:es)?|e-mail\s+address(?:es)?|e-?mail(?=\s*$)|home\s*town|location|post\s*code|zip\s*code|time\s*zone|`
  + String.raw`job(?:\s+title)?|title|role|employer|company|workplace|boss|manager|salary|profession|occupation|wife|husband|partner|spouse|girlfriend|boyfriend|`
  + String.raw`fianc[eé]e?|kids?|children|child|sons?|daughters?|baby|family|mum|mom|mother|dad|father|parents?|sisters?|brothers?|siblings?|`
  + String.raw`grand(?:ma|pa|mother|father|parents?)|friends?|pets?|dog|cat|preferences?|favou?rites?|favou?rite\s+\S+|likes|dislikes|allerg(?:y|ies)|diet|`
  + String.raw`hobb(?:y|ies)|interests|habits|details|personal\s+details|info|information|data|personal\s+data|profile|health|medications?|anniversary)\b`;
/**
 * "My address", "my wife's birthday", "my phone number and my address", "my manager is Priya": ABOUT_ME's words to the
 * end, a possessive only before another of them, never "my wife's AirPods", "my manager's email", "my data in Chrome"
 * or "my birthday party" (memory-v4-2).
 */
const MY_DETAIL = String.raw`(?:my|our)\s+(?:${ABOUT_ME}['’]s?\s+(?!e-?mail\s*$))?${ABOUT_ME}`;
/** The end of a forget request: "please" or a polite "?" at most. */
const END = String.raw`(?:\s+please)?\s*\??$`;
const ABOUT_MY = String.raw`${MY_DETAIL}(?:\s+(?:and|&)\s+${MY_DETAIL})*(?:\s+(?:is|are|was|were)\b.*)?${END}`;
/** "You", "you've", "that you have": who keeps it, before what Ember knows (KNOWS) or saved (SAVED). */
const YOU = String.raw`(?:that\s+)?you(?:['’]ve|\s+have|['’]d|\s+had)?\s+`;
const KNOWS = String.raw`know|knew|learned|learnt|remember|remembered`;
const SAVED = String.raw`saved|kept|stored|noted`;
/** What Ember keeps about someone, after "everything you know about…": "me", "us", "my wife", "Priya". */
const YOU_KEPT = String.raw`(?:${YOU})?(?:${KNOWS}|${SAVED})`;
/**
 * "Forget that I…", "forget my address", "forget where I live", "forget everything about me", "forget what you know
 * about me", "clear my memory", "don't remember that Priya is my manager": the user asking Ember to stop knowing
 * something about them, or to empty its memory, and nothing else. Never "forget the…", "forget what I said" or "forget
 * that email" (the conversation's: "never mind", or another request), nor "forget about…" or "forget to…"; never "clear
 * all" or "delete everything" alone (the conversation's: a list on the screen, a folder's files): memory-r3-1.
 */
const FORGET_ASK = new RegExp(String.raw`${LEAD}(?:(?:forget|don'?t\s+remember|do\s+not\s+remember|stop\s+remembering|unlearn)\s+(?:`
  // "…that I work at Globex", "…I'm vegetarian", "…my wife's birthday" (never "…I said that", "…my last message", "…my AirPods").
  + String.raw`(?:(?:the\s+fact\s+)?that\s+)?(?:i\b${SAID}|i['’](?:m|ve|d)\b|${ABOUT_MY}|we\b${SAID})`
  // "…where I live", "…who my manager is", "…what I like" (never "…what I said", "…where I put it").
  + String.raw`|(?:where|what|who|when|how)\s+(?:my\b|i['’]m\b|i\s+(?:live|work|am|do|like|love|hate|prefer|eat|drink|study|come|grew|was\s+born|take|use|stay)\b)`
  // "…that Priya is my manager", "…that the office is in Leeds": a statement, never "…that email" or "…that file".
  + String.raw`|that\s+(?:\S+\s+){1,3}?(?:is|are|was|were|has|have|works|lives|likes|leads|uses|prefers)\b`
  // "…everything about me", "…all you know about me", "…things about my wife", "…me" (never "…all about my last request"
  // or "…everything saved about me in Firefox": memory-v4-1).
  + String.raw`|(?:everything|all|things|stuff|anything)\s+(?:${YOU_KEPT}\s+)?about\s+(?:(?:me|us)${END}|${ABOUT_MY})|me\b)`
  // "Forget what you know about Python", "delete everything you've learned about me" (memory-v1), "delete everything
  // you've saved about me"; never without "you", nor "delete what you saved about the project", which may be a task's
  // files, a customer's or a browser's (memory-v4-1).
  + String.raw`|forget\s+(?:everything|all|anything|what|whatever)\s+${YOU}(?:${KNOWS}|${SAVED})\s+about\s+\S`
  + String.raw`|(?:erase|delete|clear|wipe|remove)\s+(?:everything|all|anything|what|whatever)\s+${YOU}(?:(?:${KNOWS})\s+about\s+\S|(?:${SAVED})\s+about\s+(?:me|us)${END})`
  // "Erase your memory", "clear my memory", "delete all my memories", "reset memory" (never "…your memory cache").
  + String.raw`|(?:forget|erase|delete|clear|wipe|reset|empty)\s+(?:all\s+(?:of\s+)?)?(?:(?:your|ember['’]s|my)\s+)?(?:memory|memories)(?:\s+(?:of|about)\s+\S.*)?$`
  // "Forget everything", "…everything you know", "delete everything you remember" (never "…everything I said", nor "delete
  // everything you saved", which may be a task's files).
  + String.raw`|forget\s+(?:everything|all)(?:\s+${YOU_KEPT})?\s*$`
  + String.raw`|(?:erase|delete|clear|wipe)\s+(?:everything|all)\s+(?:(?:that\s+)?you(?:['’]ve|\s+have)?\s+)?(?:know|knew|learned|learnt|remember)\s*$`
  // "Remove Priya from your memory", "remove my address from memory": "from memory" alone only after the user's own
  // details or a name (FORGET_FROM), never "remove this tab from memory" (memory-c4-1).
  + String.raw`|(?:remove|delete|erase|drop|clear|wipe)\s+(?:\S+\s+){1,4}?from\s+(?:your|ember['’]s|my)\s+(?:memory|memories)\b`
  + String.raw`|(?:remove|delete|erase|drop|clear|wipe)\s+${MY_DETAIL}(?:\s+(?:and|&)\s+${MY_DETAIL})*\s+from\s+(?:memory|memories)${END})`, "i");
/** "Remove Priya from memory": a name, as FORGET_NAME takes one (memory-c4-1). */
const FORGET_FROM = new RegExp(String.raw`${LEAD}(?:remove|delete|erase|drop|clear|wipe)\s+(\S+(?:\s+\S+)?)\s+from\s+(?:memory|memories)${END}`, "i");
/**
 * A photo app's or a social site's memories ("my memories of Paris in Photos", "…on Facebook"): never Ember's
 * (memory-c4-1). Only by that app's name, never a place, a company or a month after "in", "on" or "from", and never
 * "your" or "Ember's" memories ("Delete your memories about Priya from Acme" is Ember's: memory-v5-5).
 */
const APP_MEMORIES = /(?<!\b(?:[Yy]our|[Ee]mber['’]s)\s+)\bmemor(?:y|ies)\s+(?:of|about)\s+.*\s(?:in|on|from)\s+(?:the\s+)?(?:(?:Google|Apple|Amazon)\s+)?(?:Photos|iCloud|Facebook|Instagram|Snapchat|Flickr|OneDrive|Gallery|Timehop)\b/u;
/**
 * "Forget Priya", "forget Priya Shah", "forget Priya's birthday", "forget everything about Priya": a name, capitalised as
 * names are, never a word of the conversation ("Forget It", "Forget The last part"): memory-v1. Never an app, a day, a
 * folder, a device or a network ("Forget Outlook", "Forget Monday", "Forget AirPods", "Forget HomeNet"): memory-r3-1.
 */
const FORGET_NAME = new RegExp(String.raw`${LEAD}forget\s+((?:everything|all)\s+(?:${YOU_KEPT}\s+)?about\s+)?(\S+(?:\s+\S+)?)$`, "i");
const FORGET_NAMES_DETAIL = new RegExp(String.raw`${LEAD}(?:forget|unlearn)\s+(\S+(?:\s+\S+)?)['’]s\s+${ABOUT_ME}$`, "i");
const NOT_A_NAME = /^(?:it|that|this|the|a|an|about|what|where|when|who|how|my|our|your|everything|all|me|i|we|to|them|him|her|those|these|instead)$/i;
/** A word of a name as people write one: "Priya", "Jean-Luc", "O'Brien". Never "HomeNet", "AirPods" or "iPhone". */
const NAME_WORD = /^(?:\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?|\p{Lu}['’]\p{Lu}\p{Ll}+)$/u;
/** Capitalised words that name an app, a day, a folder, a device or a network, not someone Ember knows (memory-r3-1). */
const NOT_SOMEONE = new Set([
  ...Object.values(APP_NAMES).flatMap(names => Object.values(names)).flatMap(name => [name, ...name.split(/\s+/)]),
  "outlook", "teams", "slack", "firefox", "chrome", "edge", "safari", "word", "excel", "jira", "confluence", "zoom", "skype", "spotify",
  "discord", "telegram", "signal", "notion", "trello", "asana", "gmail", "thunderbird", "terminal", "settings", "files", "finder", "mail",
  "calendar", "notes", "photos", "music", "maps", "messages", "reminders", "contacts", "python", "java", "docker", "linux", "ubuntu",
  "windows", "fedora", "steam", "netflix", "amazon", "facebook", "twitter", "reddit", "google", "copilot", "gimp", "inkscape", "blender",
  "dropbox", "drive", "sheets", "docs", "evernote", "todoist", "kubernetes", "terraform", "postgres", "mysql", "redis", "nginx", "figma",
  "gitlab", "bitbucket", "jupyter", "eduroam", "starbucks", "git", "github",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december", "today", "tomorrow", "yesterday", "tonight", "weekend", "christmas",
  "downloads", "documents", "desktop", "pictures", "videos", "home", "trash",
  "wi-fi", "wifi", "bluetooth", "buds", "earbuds", "headphones", "headset", "speaker", "speakers", "keyboard", "mouse", "printer", "scanner",
  "phone", "pixel", "galaxy", "watch", "monitor", "display", "network", "hotspot", "router", "ethernet", "vpn", "connection", "device",
  "mac", "macbook", "laptop", "computer", "tablet", "kindle", "echo", "alexa", "siri", "chromecast", "roku", "xbox", "playstation",
].map(fold));
/** Months that are given names too ("June's birthday", "May Smith"). */
const NAMED_MONTHS = new Set(["april", "may", "june", "august"]);
/** Capitalised words after a month that name what happens then, never a surname ("May Day", "June Sprint"): memory-v5-6. */
const MONTH_THINGS = new Set(["day", "days", "sprint", "sprints", "release", "releases", "bank", "holiday", "holidays", "fools", "fool",
  "meeting", "meetings", "review", "reviews", "report", "reports", "budget", "deadline", "launch", "update", "updates", "payroll", "rent",
  "invoice", "invoices", "sale", "sales", "plan", "plans", "schedule", "trip", "party", "event", "events", "quarter", "close", "newsletter",
  "issue", "edition", "numbers", "figures", "results", "targets", "goals", "demo", "retro", "offsite", "conference", "bills", "bill", "exams",
  "exam", "term", "break", "recap", "roadmap", "rollout", "sync", "standup", "deploy", "deployment", "milestone", "cycle", "batch", "cohort",
  "intake", "vacation", "festival", "fair", "summit", "hackathon", "payday", "rota", "calendar", "challenge", "retreat", "showers", "wedding"]);
/**
 * Whether `words` ("Priya", "Priya Shah") are a name Ember may keep facts about. April, May, June and August are names
 * with a surname, or as `named` (a detail or "everything about" after them), never alone ("Forget June"): memory-c4-3;
 * nor before a word for what happens then ("Forget May Day", "Forget June Sprint"): memory-v5-6.
 */
function isName(words: string, named = false): boolean {
  const ws = words.split(/\s+/);
  const month = (w: string, i: number) => NAMED_MONTHS.has(fold(w))
    && (named || (i === 0 && ws.length > 1 && !NAMED_MONTHS.has(fold(ws[1]!)) && !MONTH_THINGS.has(fold(ws[1]!))));
  return ws.every((w, i) => NAME_WORD.test(w) && !NOT_A_NAME.test(w) && (!NOT_SOMEONE.has(fold(w)) || month(w, i)))
    && (!NOT_SOMEONE.has(fold(words)) || (ws.length === 1 && month(ws[0]!, 0)));
}
/** More than the one request: another sentence, or more after a comma, a semicolon or a dash (the conversation takes those). */
const MORE = /[.!?]\s+\S|[,;]\s*\S|\s[-–—]+\s*\S/;
/**
 * Another request after "and" or "then" ("Forget my last request and open Firefox instead", "…then open Thunderbird"):
 * the conversation takes the whole of it (memory-c1-1).
 */
const AND_MORE = /\s(?:and|then|&)\s+(?:(?:then|also|instead|just|please)\s+)*(?:open|show|start|run|send|write|draft|find|search|tell|close|play|stop|remind|set|turn|make|create|delete|remove|email|mail|message|call|book|schedule|check|move|copy|rename|install|launch|reply|forward|share|post|upload|download|print|save|add|go|use|summari[sz]e|give|try|read|reopen|redo|undo|do|help|explain|translate|fix|list|type|paste|let['’]?s|look|answer|switch|change|edit|update|restart|continue|put|get|bring|take)\b/i;

/**
 * Whether `text` is only a request for Ember to remember something (`remember`) or to forget something it keeps about
 * the user (`forget`), or neither. A question ("Remember when we talked about Atlas?", "Remember me?") and a request
 * with more in it ("Forget what I said, open Firefox instead") are neither (memory-c1-1). While memory isn't in force,
 * only a forget request is answered in code (memory-v1); a remember request still goes to the conversation, which
 * keeps it until Ember closes, and Ember says after the answer that memory won't (`rememberNote`).
 */
export function memoryAsk(text: string): "remember" | "forget" | null {
  // "Remember, I'm vegetarian": the comma a pause after the verb, not more after the request; "In future, remember…":
  // what came before it is no more either (memory-r3-2).
  const t = text.trim().replace(REMEMBER_LEAD, "$1").replace(REMEMBER_PAUSE, "$1 ");
  // (After "Ember," or "Hey Ember." the request starts: that comma is no more.)
  const body = t.replace(/^(?:hey\s+)?ember[,.!]?\s+/i, "").replace(/[.!?]+$/, "");
  if (MORE.test(body) || AND_MORE.test(body)) return null;
  // Asked as a question, unless it is a request put politely ("Can you remember that I'm vegetarian?").
  if (/\?$/.test(t) && !POLITE.test(t)) return null;
  if (KEEP_THAT.test(t.replace(/[.!?]+$/, ""))) return "remember";
  const kept = REMEMBER_ASK.exec(t.replace(/[.!?]+$/, ""));
  // "Make a note: I prefer email": what follows the colon (memory-r3-2).
  if (kept) return statesSomething(kept[1]!.trim().replace(/^:\s*/, "")) ? "remember" : null;
  return forgets(t.replace(/[.!]+$/, "")) ? "forget" : null;
}

/** Whether `t` (no more in it) asks Ember to forget something about the user, everything, or a name. */
function forgets(t: string): boolean {
  if (APP_MEMORIES.test(t)) return false;
  if (FORGET_ASK.test(t)) return true;
  const name = FORGET_NAME.exec(t);
  if (name && isName(name[2]!, !!name[1])) return true;
  const detail = FORGET_NAMES_DETAIL.exec(t);
  if (detail && isName(detail[1]!, true)) return true;
  const from = FORGET_FROM.exec(t);
  return !!from && isName(from[1]!);
}

/**
 * A forget request with more after it ("Forget my address and open Firefox"): the conversation takes the whole of it,
 * and Ember says after its answer that memory can't change what's saved while it isn't in force (`forgetNote`).
 */
export function forgetsWithMore(text: string): boolean {
  const t = text.trim().replace(/[.!]+$/, "");
  if (memoryAsk(t) !== null || /\?$/.test(t)) return false;
  const first = t.split(/[.!?]\s|[,;]|\s[-–—]+\s|\s(?:and|then|&)\s/i)[0]!.trim();
  // "Forget everything and start over" is as likely "never mind": no note after it.
  return !new RegExp(String.raw`${LEAD}forget\s+(?:everything|all)$`, "i").test(first) && forgets(first);
}

/** A statement, then a request to keep it ("…, remember that", "…. Remember that", "… - don't forget"). */
const REMEMBER_AFTER = /^(.*?\S)[.!]?\s*(?:[,;.!]|\s[-–—]+)\s*(?:(?:and|so|please|but|just)\s+)?(?:remember|keep\s+(?:this|that|it)\s+in\s+mind|don'?t\s+forget|do\s+not\s+forget)(?:\s+(?:this|that|it))?(?:\s+(?:please|ok(?:ay)?|for\s+me|for\s+later|too))?[.!]*$/is;

/** Filler after a comma, which says nothing to keep ("Remember the tab I had open, please"). */
const FILLER = /^(?:please|thanks|thank\s+you|ok|okay|right|alright|yeah|yes|now|too|as\s+well|for\s+me|for\s+later)$/i;

/**
 * A remember request with more after it (memory-r3-2): "Remember that I'm vegetarian and book a table" (the first part
 * says something to keep), or "Remember my wife's name, Sam" (a value after a comma or a dash). The conversation takes
 * the whole of it, and Ember says after its answer that memory won't keep it (`rememberNote`).
 */
export function remembersWithMore(text: string): boolean {
  const t = text.trim().replace(/[.!]+$/, "");
  if (memoryAsk(t) !== null || (/\?$/.test(t) && !POLITE.test(t))) return false;
  // "I'm vegetarian, remember that", "My wife's birthday is 12 March, don't forget" (memory-r3-2).
  const after = REMEMBER_AFTER.exec(t);
  if (after) return statesSomething(after[1]!) && !looksLikeRequest(after[1]!);
  // "My wife and I prefer…" is one subject, not more after the request (memory-v4-4).
  const first = t.split(/[.!?]\s|[,;]|\s[-–—]+\s|\s(?:and|then|&)\s(?!(?:i|we)\s)/i)[0]!.trim();
  if (memoryAsk(first) === "remember") return true;
  const sep = /^\s*(?:,|\s[-–—]+\s)\s*(.+)$/.exec(t.slice(first.length));
  const value = sep?.[1]!.trim() ?? "";
  return !!sep && !!REMEMBER_ASK.exec(first) && value.split(/\s+/).length <= 4 && !FILLER.test(value) && !looksLikeRequest(value)
    && !MORE.test(value) && !AND_MORE.test(` and ${value}`);
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
  /** Where Open Memory opens Settings › Memory: at its list (and Forget) after a forget request, else at its note. */
  at?: "list";
}

/** The bubble's Open Memory after a note, by where it opens Settings › Memory (memory-r3-4). */
const OPEN_MEMORY = { note: "ui:memory", list: "ui:memory-list" } as const;
/** The bubble's button after `n`: Open Memory where the note says, or none. */
export const memoryNoteActions = (n: MemoryNote) => (n.open ? [{ id: OPEN_MEMORY[n.at ?? "note"], label: "Open Memory" }] : []);
/** Where a bubble action opens Settings › Memory, or null for any other action. */
export function memoryActionOpens(id: string): "list" | "note" | null {
  return id === OPEN_MEMORY.list ? "list" : id === OPEN_MEMORY.note ? "note" : null;
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
 * The truth after the conversation answered a forget request with more in it while memory can't change what's saved
 * (memory-c1-1): the bubble offers Open Memory where `forgetReply` would open it, at the list and its Forget, never at
 * the note (memory-r3-4).
 */
export function forgetNote(why: MemoryNotNow): MemoryNote {
  return { title: rememberNote(why).title, text: `${NOT_NOW[why]}, so I can't change what's saved.`, open: forgetReply(why).open, at: "list" };
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
