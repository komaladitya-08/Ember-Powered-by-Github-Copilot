/**
 * The user's profile told in conversation (memory-r9-5): what to call them and how long answers should be go first
 * with every request (`profileFacts`, ./service.ts), as the open `user` facts under Tell Ember about you's own
 * relations (`called`, `answer_length`). When the user's own words in a turn tell Ember a new one ("Call me Sam from
 * now on", "Stop being so brief, I want the full detail") and the fact a model saves for it says the same, the fact
 * kept is that relation's, under Ember's own label with the user's own word, as the spoken interview keeps an answer
 * (./intro.ts): theirs, so it replaces the one before, however the model worded it or named the relation.
 *
 * It is the one place a fact that isn't mostly the user's own words becomes theirs, and it goes with every request, so
 * both sides must say it plainly or nothing here applies (memory-x9-1):
 * - the user's words tell Ember, in a clause that begins with the telling: never words the request only contains (a
 *   report, "My boss said call me Dave"; an errand, "Tell Priya to call me Sam", "Play Call Me Al"; what follows a
 *   colon or stands in quotes, "Write to Priya: my name is Bob"; a page or a letter handed over to work on), never a
 *   question, "don't call me…", "call me back", nor unchecked speech, which reaches here as no words at all; a length
 *   only from words about Ember's answers to them, never "my replies to customers" or "a short reply to Priya";
 * - the fact is about the user alone (`aboutUser`) and says only that (`profileKind`): the name they said, or the
 *   length they said, of nobody and nothing else.
 * Anything else is kept as the model gave it, whose it is by the usual rule (`ownFact`, ./service.ts). Pure.
 */

import type { NewFact } from "./graph";
import { introFacts } from "./intro";
import { soundsLikeInstruction } from "./learn";
import { fold, negated } from "./text";

/** A turn longer than this, or of more than one line, is a page or a letter, never the user telling Ember about themselves. */
export const TOLD_MAX_CHARS = 200;

/** What a telling may open with: Ember's name, a greeting, a word that turns to it. */
const OPENERS = /^\s*(?:(?:hey|hi|hello|ok(?:ay)?|so|oh|well|right|look|listen|actually|also|and|but|no(?=\s*,)|sorry|please|thanks|thank\s+you|by\s+the\s+way|btw|from\s+now\s+on|in\s+future|going\s+forward|one\s+more\s+thing|ember)\b[,.!\s]*)+/iu;
/** Words in quotes: someone else's, a title or what to write, never the user's own telling. */
const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*[’]|«[^»]*»|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])/gu;
/**
 * Verbs that hand Ember words to work on or to pass on ("Summarise this email…", "Translate…", "Play…", "Remind
 * me…"): a name in such a turn is the page's, the song's or the message's, so none is taken from it.
 */
const HANDS_OVER = /\b(?:summari[sz]e|translate|proofread|rewrite|rephrase|reword|paraphrase|draft|reply|respond|write|compose|dictate|transcribe|type|read|forward|send|e-?mail|text|message|post|search|google|look\s+up|play|sing|remind|sign|fill|paste|copy|explain|check|fix|correct|edit|review|quote|lyrics?|song)\b/iu;
/** Words that report what someone said. */
const REPORTS = /\b(?:said|says|say|told|tells|tell|asked|asks|ask|wrote|writes|replied|answered)\b/iu;

/**
 * The part of a turn that can be the user telling Ember about themselves, or null: one line of at most TOLD_MAX_CHARS,
 * without what follows a colon ("Write to Priya: …", "Summarise this: …") or stands in quotes.
 */
function ownTelling(said: string): string | null {
  const text = said.trim();
  if (!text || text.length > TOLD_MAX_CHARS || /[\r\n]/u.test(text)) return null;
  const plain = text.replace(/:(?!\d)[\s\S]*$/u, "").replace(QUOTED, " ~ ");
  // A quote left open can't be told from the user's own words.
  return /["“”«»]/u.test(plain) ? null : plain;
}

/** A name's word. */
const WORD = String.raw`\p{L}[\p{L}'’-]{0,29}`;
/** A title before a name ("Dr. Patel", "Mrs Shah"): memory-r10-2. */
const TITLE = String.raw`(?:(?:Dr|Mr|Mrs|Ms|Mx|Prof|Sir|Dame)\.?\s+)`;
/** A name of one to three words, the further ones capitalised as names are, perhaps after a title. */
const A_NAME = String.raw`${TITLE}?${WORD}(?:\s+\p{Lu}[\p{L}'’-]{0,29}){0,2}(?![\p{L}\p{N}'’-])`;
/** A sentence, never cut at a title's full stop ("Call me Dr. Patel please."). */
const SENTENCE = /(?:\b(?:Dr|Mr|Mrs|Ms|Mx|Prof)\.|[^.;!?])+[.;!?]*/gu;
const NAME = new RegExp(`^(${A_NAME})`, "u");
/** What begins a clause that tells Ember what to call the user; the rest of the clause is the name and what may follow it. */
const NAME_LEADS: readonly RegExp[] = [
  /^(?:you\s+(?:can|could|may|should)\s+)?(?:just\s+)?call\s+me\s+(.+)$/iu,
  /^my\s+name(?:\s+is|['’]s)(?:\s+(?:now|actually))?\s+(.+)$/iu,
  /^i\s+(?:now\s+)?go\s+by\s+(.+)$/iu,
  // What others call them, offered to Ember ("My friends call me Raj, and so can you"): only with the offer (memory-r10-2).
  /^(?:my\s+)?(?:friends|family|mates|colleagues|people|everyone|everybody|most\s+people)\s+calls?\s+me\s+(.+?)[,\s]+(?:and\s+)?(?:so\s+(?:can|could|should|may)\s+you|you\s+(?:can|could|should|may)\s+(?:too|as\s+well))$/iu,
  /^i(?:['’]d|\s+would)\s+(?:like|prefer|love)\s+to\s+be\s+called\s+(.+)$/iu,
  /^i\s+(?:like|prefer|want)\s+to\s+be\s+called\s+(.+)$/iu,
  /^i(?:(?:['’]d|\s+would)\s+(?:like|prefer|love)|\s+want|\s+need)\s+you\s+to\s+call\s+me\s+(.+)$/iu,
  /^i(?:['’]d|\s+would)\s+rather\s+(?:be\s+called|you\s+call(?:ed)?\s+me)\s+(.+)$/iu,
  // The old name refused and the new one given in one breath ("Don't call me Ram, call me Sam", "Stop calling me Ram, it's Sam").
  new RegExp(String.raw`^(?:don['’]?t|do\s+not|stop|never)\s+call(?:ing)?\s+me\s+${A_NAME}[,;]?\s+(?:(?:just|please|but)\s+)*(?:call\s+me|it['’]?s|i['’]?m|my\s+name(?:\s+is|['’]s))\s+(.+)$`, "iu"),
];
/** The polite way of asking for it, the one telling that is a question ("Can you call me Sam?", "Could you please call me Sam from now on?"). */
const ASKS_FOR = /^(?:can|could|would|will)\s+you\s+(?:(?:please|just)\s+)*call\s+me\s+(.+)$/iu;
/** "I'm Sam, not Ram": a name only when it is set against another, both written as names ("I'm tired, not hungry" names no one). */
const I_AM = /^i(?:['’]m|\s+am)\s+(.+)$/iu;
/**
 * "It's Raj, not Ram": the same, only against the name Ember has for the user now (memory-r10-2), since "It's Paris, not
 * London" and "It's March, not June" set two capitalised words against each other too (r10-memory-x10-3).
 */
const IT_IS = /^it(?:['’]s|\s+is)\s+(.+)$/iu;
/** A name set against another ("Sam, not Ram", "Sam instead of Ram"). */
const NOT_OTHER = new RegExp(String.raw`^,?\s+(?:and\s+)?(?:not|instead\s+of|rather\s+than)\s+(${A_NAME})`, "iu");
/** How the user goes on to something else after the name ("…and I work at Globex", "…, Ram is my middle name"). */
const GOES_ON = /^(?:\s*,|\s+(?:and|but|because|since|so)\b)\s*\S/iu;
const capitalised = (name: string) => name.split(/\s+/u).every(w => /^\p{Lu}/u.test(w));
/** What may follow the name ("Sam from now on", "Sam instead, please"). */
const NAME_TAIL = /^[,\s]+(?:these\s+days|nowadays|from\s+now\s+on|from\s+here\s+on|going\s+forward|in\s+future|now|instead|please|thanks|thank\s+you|actually|by\s+the\s+way|btw|is\s+fine|will\s+do|ok(?:ay)?)(?![\p{L}\p{N}'’-])/iu;
/** Words after "call me" that name no one ("call me a taxi", "call me back", "call me when it's done"). */
const NOT_A_NAME = /^(?:a|an|the|back|later|when|if|at|on|in|after|before|tomorrow|tonight|today|now|soon|about|to|up|out|again|once|whenever|maybe|sometime|and|or|not|what|whatever|anything|something|it|that|this|you|me|him|her|them|us|by|with|for|from|is|are|was|(?:mon|tues|wednes|thurs|fri|satur|sun)day)$/iu;
const named = (name: string) => !name.split(/\s+/u).some(w => NOT_A_NAME.test(w));

/**
 * The name a clause tells Ember to call the user by, or null: the clause begins with the telling (`asks`: its
 * sentence is a question, so only the polite request is one), and after the name holds only words that end it
 * ("from now on", "please"), another name it is set against ("not Ram", "instead of Ram"), or how the user goes on
 * ("and I work at Globex"), never a report (memory-x9-4).
 */
function nameIn(clause: string, asks: boolean, current: string | null): string | null {
  for (const lead of asks ? [ASKS_FOR] : [...NAME_LEADS, I_AM, IT_IS]) {
    const m = lead.exec(clause);
    const name = m ? NAME.exec(m[1]!)?.[1] : undefined;
    if (!m || !name || !named(name)) continue;
    let rest = m[1]!.slice(name.length);
    const against = NOT_OTHER.exec(rest)?.[1];
    if (against) rest = rest.slice(NOT_OTHER.exec(rest)![0].length);
    // "I'm …" and "It's …" name the user only against another name, both written as names.
    if ((lead === I_AM || lead === IT_IS) && !(against && capitalised(name) && capitalised(against) && named(against))) continue;
    if (lead === IT_IS && !(current && fold(against!) === fold(current))) continue;
    for (let tail = NAME_TAIL.exec(rest); tail; tail = NAME_TAIL.exec(rest)) rest = rest.slice(tail[0].length);
    if (!rest.replace(/[\s,;:]+$/u, "")) return name;
    // The user goes on to something else: only after a name written as one, and never into a report ("…, said my boss").
    if (GOES_ON.test(rest) && capitalised(name) && !REPORTS.test(rest)) return name;
  }
  return null;
}

/**
 * The name the user tells Ember to call them by in `said`, or null: "Call me Sam from now on", "my name is Sam", "I go
 * by Sam now", "I'd like to be called Sam", and the other ways people say it (memory-x9-4): asked politely ("Can you
 * call me Sam?"), set against the old one ("Call me Sam, not Ram", "I'm Sam, not Ram", "Don't call me Ram, call me
 * Sam"), "I'd rather be called Sam", or before going on ("My name is Sam and I work at Globex"). Only from a clause
 * that begins with it (after "Ember,", "Actually,", "Please"…): never a report ("My boss said call me Dave"), an
 * errand ("Tell Priya to call me Sam", "Play Call Me Al"), any other question, a negation alone ("don't call me
 * Sam"), a condition, "call me back", "call me a taxi", what follows a colon or stands in quotes, nor a turn that
 * hands Ember words to work on (memory-x9-1).
 */
export function nameSaid(said: string, current: string | null = null): string | null {
  const own = ownTelling(said);
  if (own === null || HANDS_OVER.test(own)) return null;
  for (const sentence of own.match(SENTENCE) ?? []) {
    const name = nameIn(sentence.replace(/[.;!?\s]+$/u, "").replace(OPENERS, "").trim(), /\?\s*$/u.test(sentence), current);
    if (name) return name;
  }
  return null;
}

const SHORT = /\b(?:short(?:er)?|brief(?:er)?|concise|terse|to\s+the\s+point)\b/iu;
const LONG = /\b(?:detailed|long(?:er)?|thorough|in\s+depth|full(?:er)?\s+detail|more\s+detail|wordy|verbose|long-winded)\b/iu;
/** Words that turn a length round ("stop being so brief", "too long", "not so short", "I hate long answers"). */
const FLIP = /\b(?:stop|quit|not|no|never|less|too|enough|hate[sd]?|dislike[sd]?|bor(?:e|es|ed|ing)|annoy\w*|sick\s+of|tired\s+of|fed\s+up)\b|n['’]t\b/iu;

type Length = "short" | "detailed";
const lengthOf = (clause: string): Length | null => {
  const short = SHORT.test(clause), long = LONG.test(clause);
  if (short === long) return null;
  return short !== FLIP.test(clause) ? "short" : "detailed";
};

/** How Ember is ("so", "too", "a bit"…) before a word of length. */
const DEGREE = String.raw`(?:(?:so|too|far\s+too|way\s+too|more|less|a\s+bit|a\s+little|very|that|quite)\s+)*`;
const LENGTH_WORD = String.raw`(?:short|brief|concise|detailed|thorough|wordy|verbose|terse|long-winded)\b(?!\s+(?:with|to|about|on|in|for)\s+(?!me\b))`;
/** Ember told how to be: "Be brief", "Stop being so wordy", "You're too long-winded". Never "The talk should be brief", "Be brief with Bob". */
const BE_SO = new RegExp(String.raw`^(?:(?:(?:please|just|try\s+to|(?:can|could|would|will)\s+you|you\s+(?:can|could|should|need\s+to))\s+)*(?:stop\s+being|quit\s+being|don['’]?t\s+be|do\s+not\s+be|be)|you(?:['’]re|\s+are)(?:\s+being)?)\s+${DEGREE}${LENGTH_WORD}`, "iu");
/** How a clause about Ember's answers begins: the user speaking of themselves or to Ember, or the length itself ("Shorter answers, please"). */
const TO_EMBER = new RegExp(String.raw`^(?:i\b|you\b|your\b|(?:(?:please|just)\s+)*(?:give|keep|make|stop|quit|don['’]?t|do\s+not|no\s+more|start|try|use|(?:can|could|would|will)\s+you)\b|(?:(?:much|far|a\s+bit|slightly|more|less)\s+)*(?:short(?:er)?|brief(?:er)?|concise|long(?:er)?|detailed|thorough)\b)`, "iu");
/** Ember's answers, as a kind: never one answer or a reply to write ("a short reply to Priya"). */
const ANSWERS = /^(.*?)\b(?:answers|replies|responses|explanations)\b(.*)$/iu;
/** Whose they are, when not Ember's ("my replies", "Priya's answers"). */
const SOMEONE_S = /^(?:my|our|his|her|their|its|whose)$|(?<!\bember)['’]s$/iu;
/** Writing of the user's own, or for someone, which a length in the same clause describes. */
const WRITING = /\b(?:writ(?:e|es|ing)|wrote|draft\w*|compos\w+|send(?:s|ing)?|sent|translat\w+|rewrit\w+|proofread\w*|e-?mail(?:s|ed|ing)?|post(?:s|ed|ing)?|summar\w+)\b/iu;
/** Someone they are given or sent to ("Give Priya short answers"). */
const TO_SOMEONE = /\b(?:[Gg]ive|[Ss]end|[Tt]ell|[Ww]rite)\s+(?:\p{Lu}\p{L}+|him|her|them|the\s+\p{L}+)\s/u;

/**
 * A clause about Ember's answers to the user (memory-x9-1): it tells Ember how to be ("be brief", "stop being so
 * wordy"), or speaks of its answers as the user's to get ("your answers", "give me long answers", "I prefer detailed
 * answers"). Never someone else's or the user's own writing ("my replies to customers", "Priya's answers", "replies
 * to my manager", "I write detailed replies"), someone else's wish ("Priya wants short answers") or a report.
 */
function aboutAnswers(clause: string): boolean {
  if (WRITING.test(clause) || REPORTS.test(clause) || TO_SOMEONE.test(clause)) return false;
  if (BE_SO.test(clause)) return true;
  const m = ANSWERS.exec(clause);
  if (!m || !(TO_EMBER.test(clause) || /\byou(?:r|['’]re|['’]ve)?\b/iu.test(clause))) return false;
  if (m[1]!.trim().split(/\s+/u).slice(-3).some(w => SOMEONE_S.test(w))) return false;
  return !/^\s+(?:to|for|in|on|about|with|from|of|at)\s+(?!me\b|my\s+questions?\b|now\s+on\b)/iu.test(m[2]!);
}

/**
 * How long the user says Ember's answers should be in `said`, or null: only from clauses about its answers to them
 * (`aboutAnswers`: "your answers are too long", "be brief", "I prefer detailed answers"), read the right way round,
 * and only when each of them that says a length says the same one. "Write a short email", "Keep my replies to
 * customers short", "the meeting was too long", a question that isn't a request, and what follows a colon or stands
 * in quotes say none (memory-x9-1).
 */
export function lengthSaid(said: string): Length | null {
  const own = ownTelling(said);
  if (own === null) return null;
  const found = new Set<Length>();
  for (const sentence of own.match(/[^.;!?]+[.;!?]*/gu) ?? []) {
    const asks = /\?\s*$/u.test(sentence);
    for (const part of sentence.replace(/[.;!?\s]+$/u, "").split(/,+|\s+(?:but|and)\s+/u)) {
      const clause = part.replace(OPENERS, "").trim();
      // A question tells nothing ("Why are your answers so short?") unless it asks Ember for it ("Can you give me shorter answers?").
      if (!clause || (asks && !/^(?:can|could|would|will)\s+you\b/iu.test(clause))) continue;
      const length = aboutAnswers(clause) ? lengthOf(clause) : plainOrder(clause, own);
      if (length) found.add(length);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** Ember told to be shorter without naming its answers ("Stop rambling", "Less waffle please", "No more waffling"). */
const CUT_SHORT = /^(?:(?:please|just)\s+)*(?:stop|quit|no\s+more|less|cut(?:\s+out)?(?:\s+the)?|enough(?:\s+of\s+the)?)\s+(?:rambling|waffl(?:e|ing)|padding|fluff|essays|walls?\s+of\s+text)(?:\s+please)?$/iu;
/** "Keep it brief", "Keep it short please": "it" being Ember's answers, alone in the clause. */
const KEEP_IT = new RegExp(String.raw`^(?:(?:please|just)\s+)*keep\s+(?:it|them|things|everything)\s+${DEGREE}(short|brief|concise|detailed|thorough)(?:\s+please)?$`, "iu");

/**
 * A length told plainly without naming Ember's answers (memory-r10-2), or null: "Keep it brief", "Stop rambling". Never
 * a length alone ("Shorter, please", "More detail"), which may ask for one answer, a draft's or a letter's, again
 * shorter, and would then overwrite what the user set in Tell Ember about you (r10-memory-x10-3). Never in a turn that hands Ember words to work on or to pass on, speaks
 * of someone else or reports ("Write to Priya and keep it brief", "Tell Bob to stop rambling", "Priya said stop
 * rambling"), nor beside anything else the turn asks for ("Make a toast, keep it short"), so "it" can only be Ember's
 * answers.
 */
function plainOrder(clause: string, own: string): Length | null {
  if (WRITING.test(own) || HANDS_OVER.test(own) || REPORTS.test(own) || TO_SOMEONE.test(own)) return null;
  // Only when the turn says nothing else: beside any other ask ("Make a toast, keep it short", "What's the capital of
  // Peru? Keep it short.") "it" is that one answer, never the user's length (r10-memory-y10-1).
  const others = (own.match(/[^.;!?]+[.;!?]*/gu) ?? []).flatMap(sentence => sentence.replace(/[.;!?\s]+$/u, "").split(/,+|\s+(?:but|and)\s+/u));
  if (!others.every(part => { const c = part.replace(OPENERS, "").trim(); return !c || CUT_SHORT.test(c) || KEEP_IT.test(c); })) return null;
  if (CUT_SHORT.test(clause)) return "short";
  const keep = KEEP_IT.exec(clause);
  return keep ? (/^(?:short|brief|concise)$/iu.test(keep[1]!) ? "short" : "detailed") : null;
}

/** Who a fact about the user is said of, when it says: "The user's…", "User…", "Their…". */
const OF_USER = String.raw`(?:(?:the\s+)?user(?:['’]s)?\s+|their\s+|they\s+)?`;
const WISHES = String.raw`(?:now\s+)?(?:likes?|prefers?|wants?|wishes|asks?|asked|has\s+asked|would\s+(?:like|prefer|rather)|should)\s+`;
/** A fact that says what to call the user and nothing else, with the name last ("Likes to be called Sam", "Name is Sam", "The user's preferred name is Sam", "Goes by Sam"). */
const NAME_FACT = new RegExp(String.raw`^${OF_USER}(?:`
  + String.raw`(?:(?:preferred|first|given|chosen|new|nick)\s*)?name(?:\s+is(?:\s+now)?|\s*:)|nickname(?:\s+is|\s*:)`
  + String.raw`|(?:is\s+)?(?:now\s+)?(?:called|named|known\s+as)|(?:now\s+)?goes\s+by(?:\s+the\s+name)?`
  + String.raw`|${WISHES}(?:to\s+be|being|be)\s+(?:called|known\s+as|addressed\s+as)`
  + String.raw`|(?:${WISHES})?(?:ember|you|people|everyone|others)\s+to\s+call\s+them|calls?\s+(?:themselves|themself|himself|herself)`
  + String.raw`)\s+["“‘']?(.+?)["”’']?(?:\s+(?:from\s+now\s+on|now|instead))?[.!]?$`, "iu");
/** Every word a fact about how long Ember's answers should be may hold: no one else, and nothing they are about. */
const LENGTH_FACT_WORDS = new Set(("user the their they prefers prefer preferred wants want wanted likes like would to be get finds find short shorter brief briefer "
  + "concise terse detailed long longer thorough full fuller more less detail in depth answers answer replies reply responses response explanations explanation "
  + "from ember keep kept them and not so too much very a bit of with it now point that are is as than s").split(" "));
const ANSWER_WORD = /\b(?:answers?|repl(?:y|ies)|responses?|explanations?|detail)\b/iu;

/** The name a fact sets the user's against, last in it ("…Sam, not Ram", "…Sam instead of Ram"). */
const AGAINST = new RegExp(String.raw`,?\s+(?:and\s+)?(?:not|instead\s+of|rather\s+than)\s+${WORD}(?:\s+${WORD}){0,2}[.!]?$`, "iu");

/** The name a fact says to call the user by, when it says that and nothing else (but the name it is no longer); or null. */
export function nameInFact(fact: string): string | null {
  const says = fact.trim().replace(AGAINST, "");
  const name = NAME_FACT.exec(says)?.[1];
  return name && !negated(says) && new RegExp(String.raw`^${TITLE}?${WORD}(?:\s+${WORD}){0,2}$`, "u").test(name) && named(name) ? name : null;
}

/** The length a fact says Ember's answers should be, when it says that and nothing else; or null. */
function lengthInFact(fact: string): Length | null {
  if (!ANSWER_WORD.test(fact) || !(fold(fact).match(/[\p{L}\p{N}]+/gu) ?? []).every(w => LENGTH_FACT_WORDS.has(w))) return null;
  return lengthOf(fact);
}

/**
 * Which of the profile's relations a fact is wholly about, or null: what to call the user ("Likes to be called Sam"),
 * or how long Ember's answers should be ("Prefers short answers"). A fact that says it of someone or something else,
 * or says more ("Boss likes to be called Dave", "Has a brother called Sam", "Prefers short, polite replies to
 * customers"), is neither (memory-x9-1).
 */
export function profileKind(fact: string): "called" | "answer_length" | null {
  if (nameInFact(fact)) return "called";
  return lengthInFact(fact) ? "answer_length" : null;
}

/** What a fact is said to be about: a name, with its kind when the model gave one. */
type Ref = { name: string; kind?: string };
/** The names a fact about the user goes under. */
const USER_NAMES = new Set(["user", "the user", "me", "myself"]);
const refName = (a: Ref) => fold(a.name).replace(/\s+/gu, " ").trim();

/**
 * Whether a fact is about the user alone (memory-x9-1): the user first, and beside them at most Ember or `name`, the
 * name the fact gives them. A fact about anyone or anything else is never the user's profile.
 */
export function aboutUser(about: readonly Ref[], name?: string): boolean {
  if (!about.length || !USER_NAMES.has(refName(about[0]!))) return false;
  return about.slice(1).every(a => USER_NAMES.has(refName(a)) || refName(a) === "ember" || (!!name && refName(a) === fold(name)));
}

/**
 * The profile's own fact for `fact` when the user's own words `said` in that turn tell it (see the module comment), or
 * null: the fact is about the user alone (`about`), says only what to call them and gives the name they said, or says
 * only how long answers should be and gives the length they said. Never a name that reads like an order. `theirs`: the
 * fact is already mostly the user's own words (`ownFact`), so an answer length keeps them ("Prefers long answers")
 * under the profile's relation. `current`: the name Ember has for the user now, which "It's Raj, not Ram" must name.
 */
export function profileSaid(fact: string, about: readonly Ref[], said: string, theirs = false, current: string | null = null): NewFact | null {
  if (!said.trim()) return null;
  const called = nameInFact(fact);
  if (called) {
    const name = nameSaid(said, current);
    if (name && fold(name) === fold(called) && !soundsLikeInstruction(name) && aboutUser(about, name)) return introFacts({ name })[0] ?? null;
    return null;
  }
  const length = lengthInFact(fact);
  if (length && aboutUser(about) && lengthSaid(said) === length) {
    const kept = introFacts({ length })[0];
    if (kept) return theirs ? { ...kept, text: fact } : kept;
  }
  return null;
}
