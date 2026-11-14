/**
 * What counts as a spoken answer to one of Ember's questions (PLAN.md §2 "Approvals", "Spoken answers"): the yeses and
 * noes, as a whole short utterance. One list for the two places that read it: main's voice-answer.ts (whether an
 * utterance answers the question up, and may be taken) and the voice process's engine.ts (which lets such an utterance
 * through to main while a question waits, where it would otherwise be a closer or a "yeah" said over Ember). Pure, with
 * no Electron and no Node, so both load it.
 */

/** The name as the recognizer may write it. */
const NAMES = new Set(["ember", "amber", "emma"]);
/** Words that only lead into an answer: one of them may ("Okay, go ahead"), never a run of them (review of #143). */
const FILLERS = new Set(["ok", "okay", "so", "oh", "um", "uh", "well", "alright"]);

/**
 * The answer without what leads it: "hey", the name and one filler word, each at most once ("Hey Ember, um, allow").
 * More than that is left in, so it isn't an answer: "Okay, okay, okay, okay." and "Um, um, um, yes." pad a short yes
 * past Voice Match's length check without saying more (review of #143). A filler that is the last word stays: a bare
 * "Okay." is itself a yes (settled 2026-11-12, point 9).
 */
function withoutLead(words: string[]): string[] {
  let hey = false, name = false, filler = false, i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === "hey" && !hey && !name) hey = true;
    else if (NAMES.has(w) && !name) name = true;
    else if (FILLERS.has(w) && !filler && i < words.length - 1) filler = true;
    else break;
  }
  return words.slice(i);
}

/**
 * The answer without what trails it: "please", "thanks" or "thank you", and the name, each at most once. Taken off
 * before what leads it (withoutLead), so a filler left as the last word is the answer itself ("Okay, thanks.").
 */
function withoutTail(words: string[]): string[] {
  const w = [...words];
  const seen = new Set<string>();
  for (;;) {
    const last = w[w.length - 1];
    if (last === "you" && w[w.length - 2] === "thank" && !seen.has("thanks")) { w.splice(-2); seen.add("thanks"); continue; }
    const kind = last === "please" || last === "thanks" ? last : NAMES.has(last) ? "name" : null;
    if (!kind || seen.has(kind)) return w;
    w.pop();
    seen.add(kind);
  }
}

/**
 * The yeses, each a whole utterance: never "Always", never a yes with more asked after it ("yes and also delete…").
 * The recognizer's ways with the words count too ("aloud", "a low", "go a head"): none of them sounds like a no. A bare
 * "okay", "alright" or "go on" is one too while a question is up (settled 2026-11-12 by the integrator on the owner's
 * direction, point 9; they were left out as acknowledgements by review of #143), and so are "accept", "continue",
 * "confirm", "go with it", "sounds good" and "fine" (owner decision of 2026-11-12: "I can say allow or deny, or okay, go
 * with it and other things"). "You can" alone still isn't.
 */
export const SPOKEN_YES: ReadonlySet<string> = new Set([
  "allow", "allow it", "allow that", "allow this", "allow that one", "yes allow", "yes allow it", "yes allow that", "yes", "yes yes", "yes please",
  "yeah", "yep", "yup", "sure", "sure thing", "sure go ahead", "yeah sure", "yes sure", "of course",
  "go ahead", "yes go ahead", "yeah go ahead", "yep go ahead", "okay go ahead", "ok go ahead", "alright go ahead", "fine go ahead",
  "that's fine go ahead", "go for it", "do it", "yes do it", "yeah do it", "okay do it", "ok do it", "please do", "yes please do",
  "you may", "yes you may", "yes you can", "approve", "approve it", "approved", "proceed", "yes proceed", "that's fine", "yes that's fine",
  // Owner decision of 2026-11-12 and settled point (9): the everyday ways people say yes to a question.
  "okay", "ok", "alright", "all right", "fine", "sounds good", "that sounds good", "go on", "yes go on",
  "go with it", "yes go with it", "let's go with it", "accept", "accept it", "i accept", "yes i accept", "continue", "yes continue",
  "confirm", "i confirm", "yes confirm", "confirmed",
  // The symmetric forms of those already here (V2-F7: "You may." and "Approved." were answers, "You may go ahead." and
  // "Accepted." weren't). None of them reads both ways; "You can" alone still isn't one.
  "you may go ahead", "you can go ahead", "i approve", "accepted", "go right ahead", "yes okay", "yeah okay", "sure okay",
  "yeah fine", "yes of course", "i agree",
  // Misheard (Moonshine): "allow" as "aloud", "a loud", "a low" or "allowed"; "go ahead" as "go a head".
  "aloud", "a loud", "a low", "allowed", "yes aloud", "go a head", "yes go a head",
  // Longer ways to say it, so Voice Match has enough of the voice to vouch for it (match.ts APPROVAL_MIN_SECONDS).
  "yes go ahead and allow it", "yes go ahead and allow that", "yes please allow it", "yes please allow that", "yes you can go ahead", "yes you may go ahead",
  "yes please go ahead", "yes please go ahead and allow it", "yes please go ahead and allow that", "go ahead and allow it", "go ahead and allow that",
  "yes that's fine go ahead and allow it", "yes that's fine please go ahead",
]);

/** The noes, each a whole utterance. "Cancel" and "never mind" aren't among them: they are requests of their own (review of #127). */
export const SPOKEN_NO: ReadonlySet<string> = new Set([
  "not now", "no", "no no", "no thanks", "no thank you", "nope", "nah", "no way", "don't", "do not", "don't do it", "no don't", "no don't do it",
  "deny", "deny it", "not now thanks", "no not now", "not yet", "no not yet", "not right now", "no not right now",
  "don't allow", "don't allow it", "don't allow that", "do not allow it", "no don't allow it",
  // The symmetric forms (V2-F7: "Don't do it." and "Deny." were answers, "Don't do that." and "Denied." weren't).
  "don't do that", "do not do it", "do not do that", "denied", "do not allow", "do not allow that", "don't allow this",
  "absolutely not", "not today", "no no no",
  // Everyday refusals that don't start with a no word (voice-listening-r10-1): they vanished in the answer window, or
  // went to Copilot as a request while the question waited. A no is anyone's and declining is the safe side, so noes
  // are heard more widely than yeses.
  "of course not", "certainly not", "definitely not", "hell no", "i said no", "i said not now", "i said don't", "never", "no never",
  "leave it", "no leave it", "leave it alone", "not at all", "rather not", "i'd rather not", "i would rather not", "better not",
  "i don't think so", "no i don't think so", "not a chance", "no chance",
]);

/**
 * The ways `words` may read as an answer: without what leads and trails it, and without a "please" that leads it, which
 * leads many answers ("please go ahead") and is part of one ("please do"). (The tail first: a lone "okay" before
 * "thanks" is the answer, not a filler leading into one. "Okay, thanks." was no answer where "Sounds good, thanks." was
 * one: V2-S10.)
 */
function coresOf(spoken: string[]): string[] {
  const words = withoutLead(withoutTail(spoken));
  return [words.join(" "), ...(words[0] === "please" ? [words.slice(1).join(" ")] : [])];
}

/** What may lead a no and no yes ("Just leave it.", "I said leave it.", "Thanks, leave it."): r10-voice-x10-1. */
const NO_LEADS = [["just"], ["i", "said"], ["thanks"], ["thank", "you"]];
/** What may trail a no and no yes ("Leave it for now.", "Leave it be."): r10-voice-x10-1. */
const NO_TAILS = [["for", "now"], ["be"], ["alone"]];

/**
 * The ways `spoken` may read as a no: as an answer (coresOf), and without a word or two around it that only a no takes
 * here, each at most once. Only for noes: "Thanks, go ahead." and "Just do it." are no more a yes than before, so a
 * refusal is heard more widely than an assent, the safe side.
 */
function noCoresOf(spoken: string[]): string[] {
  const cores = coresOf(spoken);
  let words = withoutLead(withoutTail(spoken));
  for (const lead of NO_LEADS) if (lead.every((w, i) => words[i] === w) && words.length > lead.length) words = words.slice(lead.length);
  for (const tail of NO_TAILS) if (tail.every((w, i) => words[words.length - tail.length + i] === w) && words.length > tail.length) words = words.slice(0, -tail.length);
  return [...cores, words.join(" ")];
}

/** The noes of more than one word ("leave it", "rather not"), found inside a near-miss (nearAnswer). */
const NO_PHRASES = [...SPOKEN_NO].filter(n => n.includes(" ")).map(n => ` ${n} `);

/** Lower case, straight apostrophes, no closing punctuation, single spaces. */
const norm = (text: string) => text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[\s?!.…]+$/u, "").replace(/\s+/g, " ").replace(/,(?=\S)/g, ", ");

/**
 * The answer a whole utterance gives: "allow", "deny", or null (anything else, or longer than a short answer). A yes
 * asked as a question ("Proceed?", "Ember, you can go ahead?") isn't one (review of #143); a no is one either way.
 */
export function spokenAnswer(text: string): "allow" | "deny" | null {
  const t = norm(text);
  if (!t || t.length > 60) return null;
  // Punctuation first ("Hey, Ember. Allow."), then what leads and trails the answer.
  const spoken = t.replace(/[,.!;:]/g, " ").split(/\s+/).filter(Boolean);
  const cores = coresOf(spoken);
  if (noCoresOf(spoken).some(c => SPOKEN_NO.has(c))) return "deny";
  // A no said in short parts, each a no ("No thank you, leave it.", "Nope, not today."): a refusal (voice-listening-r10-1).
  // Only noes: a yes said so ("Yes, go on, do it.") is no more one than before, and a no with a yes or a request in it
  // ("No, do it.", "No, leave it open and send it.") is no answer.
  // ("Hey Ember, no thanks, leave it.", "Not now, thanks, leave it.": a part that only calls Ember or thanks it is no part
  // of the answer.)
  const parts = t.split(/[,.!;:]/).map(p => p.trim().split(/\s+/).filter(Boolean)).filter(p => p.length && withoutTail(p).length);
  while (parts.length > 1 && withoutLead(parts[0]).length === 0) parts.shift();
  if (parts.length > 1 && parts.every(p => noCoresOf(p).some(c => SPOKEN_NO.has(c)))) return "deny";
  if (!cores.some(c => SPOKEN_YES.has(c))) return null;
  // "Please" once in all: "please please do" pads a short yes past the length check (security review of #143).
  if (spoken.filter(w => w === "please").length > 1) return null;
  // Asked as a question, whatever follows the "?" ("Allow it?!", "Allow?."): not a yes.
  return /[?？]$/.test(text.trim().replace(/[\s.!…"”’')\]]+$/u, "")) ? null : "allow";
}

/** The words a near-miss answer starts with (nearAnswer). */
const ANSWER_LEADS = new Set(["yes", "yeah", "yep", "okay", "ok", "sure", "fine", "allow", "no", "nope", "don't", "not", "absolutely", "deny"]);

/** The words main's stop takes (stopRequest in app/main/agent/status.ts): what holds one is never a near-miss answer. */
const STOP_WORDS = new Set(["stop", "cancel", "abort", "halt"]);

/** The words that hold a no wherever they come (nearAnswer): "That's not what I meant.", "I never said that." */
const NO_WORDS = new Set(["no", "not", "don't", "dont", "never", "nope", "nah"]);
/** A hold, said whole ("Wait.", "Hang on a second."): the user hasn't answered yet (nearAnswer). */
const HOLD = /^(?:(?:no|okay|ok|um|uh|oh|well|just|so)\s+)*(?:wait|hold on|hang on|one moment|one sec|one second|just a moment|just a second|give me a (?:moment|second|sec|minute))(?:\s+(?:a\s+)?(?:moment|second|sec|minute|please))*$/;
/** The words of an assent that isn't a yes ("Okay then.", "Perfect.", "Sounds great.": nearAnswer). */
const ASSENT = new Set(["okay", "ok", "alright", "all", "right", "great", "perfect", "cool", "nice", "awesome", "wonderful", "excellent", "good", "fine", "sounds", "works", "got", "it", "that's", "that", "then", "so", "oh", "well", "um", "uh", "very", "for", "me"]);
const ASSENT_CORE = new Set(["okay", "ok", "alright", "right", "great", "perfect", "cool", "nice", "awesome", "wonderful", "excellent", "good", "fine", "works", "got"]);

/**
 * A few words that sound like an answer and aren't one, which while a question waits are most likely one misheard or
 * hedged: the voice process sends nothing and the question says once how to answer (V2-F5). They are:
 * - up to four words, after "hey" and the name, the first a yes or no word ("do not" too): "Yes, but wait.", "No, hang
 *   on.", "Sure, why?";
 * - up to six with a no word anywhere, or a no of more than one word ("leave it"), not asked as a question: "No, I
 *   don't want that.", "That's not what I meant.", "Leave it, I said." (voice-listening-r10-1, r10-voice-x10-1: they
 *   went to Copilot as a request while the question waited);
 * - a hold ("Wait.", "Hold on.") or an assent that isn't a yes ("Okay then.", "Perfect.", "Sounds great."), which
 *   vanished as closers.
 * "Why?", "Why not?" and "Which file?" are requests as ever. Never words that hold a stop ("No, stop the task.", "Okay,
 * stop typing."): main stops everything on those while a task is at work, and as near-misses they stopped nothing
 * (voice-product-y9-1).
 */
export function nearAnswer(text: string): boolean {
  if (spokenAnswer(text) !== null) return false;
  const words = norm(text).replace(/[,.!;:?？]/g, " ").split(/\s+/).filter(Boolean);
  let i = 0;
  if (words[i] === "hey") i++;
  if (NAMES.has(words[i])) i++;
  const rest = words.slice(i);
  if (!rest.length || rest.length > 6) return false;
  if (rest.some(w => STOP_WORDS.has(w))) return false;
  // "No, never mind." stays a near-miss as before, said once in the answer window (r10-voice-y10-2); elsewhere the
  // engine stops on it first.
  if (rest.length <= 4 && (ANSWER_LEADS.has(rest[0]) || (rest[0] === "do" && rest[1] === "not"))) return true;
  // ("Never mind." is a request of its own, as "cancel" is: review of #127.)
  if (/\bnever mind\b/.test(rest.join(" "))) return false;
  if (HOLD.test(rest.join(" "))) return true;
  if (rest.length <= 4 && rest.every(w => ASSENT.has(w)) && rest.some(w => ASSENT_CORE.has(w))) return true;
  // A no of more than one word inside, too ("Please just leave it there.", "Leave it, I said."): r10-voice-x10-1.
  return !/[?？]/.test(text) && (rest.some(w => NO_WORDS.has(w)) || NO_PHRASES.some(n => ` ${rest.join(" ")} `.includes(n)));
}

/** A yes asked as a question ("Okay?", "Ember, go ahead?"): never a yes (spokenAnswer), and never a request either (V2-F7). */
export function askedYes(text: string): boolean {
  return spokenAnswer(text) === null && /[?？]/.test(text) && spokenAnswer(text.replace(/[?？]/g, ".")) === "allow";
}
