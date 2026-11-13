/**
 * The user's profile told in conversation (memory-r9-5): what to call them and how long answers should be go first
 * with every request (`profileFacts`, ./service.ts), as the open `user` facts under Tell Ember about you's own
 * relations (`called`, `answer_length`). When the user's own words in a turn say a new one ("Call me Sam from now
 * on", "Stop being so brief, I want the full detail") and the fact a model saves for it says the same, the fact kept
 * is that relation's, under Ember's own label with the user's own word, as the spoken interview keeps an answer
 * (./intro.ts): theirs, so it replaces the one before, however the model worded it or named the relation.
 *
 * The user's words decide, never the model's: no name statement in what they said (a question, "don't call me…",
 * "call me back", unchecked speech, which reaches here as no words at all), or a fact that says another name, and
 * nothing here applies. Pure.
 */

import type { NewFact } from "./graph";
import { introFacts } from "./intro";
import { soundsLikeInstruction } from "./learn";
import { fold, negated } from "./text";

/** What comes before a name the user asks to be called by. */
const NAME_LEADS = [
  /\b(?:(?:you\s+can|please|just|do)\s+)?call\s+me\s+(.+)$/iu,
  /\bmy\s+name(?:\s+is(?:\s+now)?|['’]s)\s+(.+)$/iu,
  /\bi\s+go\s+by\s+(.+)$/iu,
  /\bi(?:['’]d|\s+would)\s+(?:like|prefer|love)\s+to\s+be\s+called\s+(.+)$/iu,
  /\bi\s+(?:like|prefer|want)\s+to\s+be\s+called\s+(.+)$/iu,
];
/** What may follow the name ("Sam from now on", "Sam instead, please"). */
const NAME_TAIL = /(?:[,\s]+(?:from\s+now\s+on|from\s+here\s+on|going\s+forward|in\s+future|now|instead|please|thanks|thank\s+you|actually|is\s+fine|will\s+do|ok(?:ay)?))+$/iu;
/** Words after "call me" that name no one ("call me a taxi", "call me back", "call me when it's done"). */
const NOT_A_NAME = /^(?:a|an|the|back|later|when|if|at|on|in|after|before|tomorrow|tonight|today|now|soon|about|to|up|out|again|once|whenever|maybe|sometime|and|or|not|what|whatever|anything|something|it|that|this|you|me|him|her|them|us|by|with|for|from|is|are|was)$/iu;
/** A clause that asks, supposes or reports rather than tells Ember what to call the user. */
const NOT_TOLD = /^(?:if|when|unless|why|what|who|where|how|do|does|did|can|could|would|will|should|is|are|people|everyone|they|he|she)\b/iu;

/**
 * The name the user asks to be called by in `said`, or null: "Call me Sam from now on", "my name is Sam", "I go by
 * Sam now", "I'd like to be called Sam". One to three words, the further ones capitalised as names are. Never a
 * question, a negation ("don't call me Sam"), a condition, or "call me back", "call me a taxi".
 */
export function nameSaid(said: string): string | null {
  for (const sentence of said.match(/[^.;!?\n]+[.;!?]*/gu) ?? []) {
    const clause = sentence.replace(/[.;!]+$/u, "").replace(/^\s*(?:(?:hey\s+)?ember[,.!]?\s+)?(?:(?:ok(?:ay)?|so|oh|well|actually|also|and|please)[,\s]+)*/iu, "").trim();
    if (!clause || /\?$/u.test(sentence.trim()) || negated(clause) || NOT_TOLD.test(clause)) continue;
    for (const lead of NAME_LEADS) {
      const m = lead.exec(clause);
      if (!m) continue;
      const words = m[1]!.replace(NAME_TAIL, "").replace(/[\s,;:]+$/u, "").split(/\s+/u).filter(Boolean);
      const named = words.length >= 1 && words.length <= 3 && words.every(w => /^\p{L}[\p{L}'’-]{0,29}$/u.test(w) && !NOT_A_NAME.test(w))
        && words.slice(1).every(w => /^\p{Lu}/u.test(w));
      if (named) return words.join(" ");
    }
  }
  return null;
}

/** A clause about Ember's answers: it names them, or tells Ember how to be ("be brief", "stop being so wordy"). */
const ABOUT_ANSWERS = /\b(?:answers?|repl(?:y|ies)|responses?|explanations?)\b|\b(?:be|being)\s+(?:(?:so|too|more|less|a\s+bit|very|that)\s+)*(?:short|brief|concise|detailed|thorough|wordy|verbose|terse|long-winded)\b(?!\s+(?:with|to|about|on)\s+(?!me\b))/iu;
const SHORT = /\b(?:short(?:er)?|brief(?:er)?|concise|terse|to\s+the\s+point)\b/iu;
const LONG = /\b(?:detailed|long(?:er)?|thorough|in\s+depth|full(?:er)?\s+detail|more\s+detail|wordy|verbose|long-winded)\b/iu;
/** Words that turn a length round ("stop being so brief", "too long", "not so short"). */
const FLIP = /\b(?:stop|quit|not|no|never|less|too|enough)\b|n['’]t\b/iu;

type Length = "short" | "detailed";
const lengthOf = (clause: string): Length | null => {
  const short = SHORT.test(clause), long = LONG.test(clause);
  if (short === long) return null;
  return short !== FLIP.test(clause) ? "short" : "detailed";
};

/**
 * How long the user says Ember's answers should be in `said`, or null: only from words about its answers ("your
 * answers are too long", "be brief", "I prefer detailed answers"), read the right way round, and only when every
 * clause that says a length says the same one. "Write a short email" and "the meeting was too long" say none.
 */
export function lengthSaid(said: string): Length | null {
  const found = new Set<Length>();
  let about = false;
  for (const clause of said.split(/[.;!?\n,]+|\s+(?:but|and)\s+/u)) {
    if (ABOUT_ANSWERS.test(clause)) about = true;
    const length = lengthOf(clause);
    if (length) found.add(length);
  }
  return about && found.size === 1 ? [...found][0]! : null;
}

/** A fact about what to call someone, and one about how long answers should be. */
const NAME_FACT = /\b(?:called|calls?\s+(?:them|him|her)|names?|named|goes\s+by|known\s+as|nickname)\b/iu;
const LENGTH_FACT = /\b(?:answers?|repl(?:y|ies)|responses?|explanations?|detail)\b/iu;

/** Which of the profile's relations a fact's words are about, or null. */
export function profileKind(fact: string): "called" | "answer_length" | null {
  if (NAME_FACT.test(fact)) return "called";
  return LENGTH_FACT.test(fact) && lengthOf(fact) ? "answer_length" : null;
}

/**
 * The profile's own fact for `fact` when the user's own words `said` in that turn say it (see the module comment), or
 * null: the fact is about what to call them and holds the name they said, or about answer length and says the length
 * they said. Never a name that reads like an order. `theirs`: the fact is already mostly the user's own words
 * (`ownFact`), so an answer length keeps them ("Prefers long answers") under the profile's relation.
 */
export function profileSaid(fact: string, said: string, theirs = false): NewFact | null {
  if (!said.trim()) return null;
  const kind = profileKind(fact);
  if (kind === "called" && !negated(fact)) {
    const name = nameSaid(said);
    const escaped = name ? fold(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
    if (name && !soundsLikeInstruction(name) && new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(fold(fact))) return introFacts({ name })[0] ?? null;
  }
  if (kind === "answer_length") {
    const length = lengthSaid(said);
    const kept = length && lengthOf(fact) === length ? introFacts({ length })[0] : undefined;
    if (kept) return theirs ? { ...kept, text: fact } : kept;
  }
  return null;
}
