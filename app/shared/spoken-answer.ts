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
]);

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
  // (The tail first: a lone "okay" before "thanks" is the answer, not a filler leading into one. "Okay, thanks." was no
  // answer where "Sounds good, thanks." was one: V2-S10.)
  const words = withoutLead(withoutTail(spoken));
  // "Please" leads many answers ("please go ahead"), and is part of one ("please do").
  const cores = [words.join(" "), ...(words[0] === "please" ? [words.slice(1).join(" ")] : [])];
  if (cores.some(c => SPOKEN_NO.has(c))) return "deny";
  if (!cores.some(c => SPOKEN_YES.has(c))) return null;
  // "Please" once in all: "please please do" pads a short yes past the length check (security review of #143).
  if (spoken.filter(w => w === "please").length > 1) return null;
  // Asked as a question, whatever follows the "?" ("Allow it?!", "Allow?."): not a yes.
  return /[?？]$/.test(text.trim().replace(/[\s.!…"”’')\]]+$/u, "")) ? null : "allow";
}
