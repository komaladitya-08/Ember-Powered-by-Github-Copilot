/**
 * Spoken answers to Ember's questions (owner decision of 2026-11-02, PLAN.md §2 "Approvals"): while a question is up,
 * "Hey Ember, allow" (or "yes", "go ahead") answers it as Allow, and "not now" (or "no", "don't") as Not now.
 *
 * The rules, judged here from what main knows of the utterance, so they are unit-tested without Electron:
 * - only while a question is up (anything else is an ordinary request for the conversation);
 * - only the whole utterance, and only these short phrases: never "Always", never words inside a longer request;
 * - never Ember's own voice: nothing heard while Ember spoke, or just after, counts (the echo guard, review #112);
 * - a yes only from the owner's voice: Voice Match on, enrolled, and this utterance verified as theirs (match.ts);
 *   otherwise the bubble says how to set Voice Match up and the question stays;
 * - "Not now" from anyone (it is the safer way, as anyone may stop Ember).
 * Typed text and the model never come here: main calls it only from the voice process's utterances.
 */

/** Before the answer: "hey Ember" (the name as the recognizer may write it), "ok", "so", "um", "please". */
const LEAD = /^(?:(?:hey|ok|okay|so|oh|um|uh|well|alright)\s+)*(?:(?:ember|amber|emma)\s+)?(?:(?:ok|okay|so|oh|um|uh|well)\s+)*(?:please\s+)?/;
/** After it: "please", "thanks", the name again. */
const TAIL = /(?:\s+(?:please|thanks|thank you|ember|amber))*$/;

/**
 * The yeses, each a whole utterance: never "Always", never a yes with more asked after it ("yes and also delete…").
 * The recognizer's ways with the words count too ("aloud", "a low", "go a head"): a yes still needs the owner's
 * verified voice, and none of them sounds like a no.
 */
const YES = new Set([
  "allow", "allow it", "allow that", "allow this", "allow that one", "yes allow", "yes allow it", "yes allow that", "yes", "yes yes", "yes please",
  "yeah", "yep", "yup", "okay", "ok", "alright", "sure", "sure thing", "sure go ahead", "yeah sure", "yes sure", "of course",
  "go ahead", "go on", "yes go ahead", "yeah go ahead", "yep go ahead", "okay go ahead", "ok go ahead", "alright go ahead", "fine go ahead",
  "that's fine go ahead", "go for it", "do it", "yes do it", "yeah do it", "okay do it", "ok do it", "please do", "yes please do",
  "you may", "yes you may", "you can", "yes you can", "approve", "approve it", "approved", "proceed", "yes proceed", "that's fine", "yes that's fine",
  // Misheard (Moonshine): "allow" as "aloud", "a loud", "a low" or "allowed"; "go ahead" as "go a head".
  "aloud", "a loud", "a low", "allowed", "yes aloud", "go a head", "yes go a head",
  // Longer ways to say it, so Voice Match has enough of the voice to vouch for it (match.ts APPROVAL_MIN_SECONDS).
  "yes go ahead and allow it", "yes go ahead and allow that", "yes please allow it", "yes please allow that", "yes you can go ahead", "yes you may go ahead",
  "yes please go ahead", "yes please go ahead and allow it", "yes please go ahead and allow that", "go ahead and allow it", "go ahead and allow that",
  "yes that's fine go ahead and allow it", "yes that's fine please go ahead",
]);
const NO = new Set([
  "not now", "no", "no no", "no thanks", "no thank you", "nope", "nah", "no way", "don't", "do not", "don't do it", "no don't", "no don't do it",
  "deny", "deny it", "not now thanks", "no not now", "not yet", "no not yet", "not right now", "no not right now",
  "don't allow", "don't allow it", "don't allow that", "do not allow it", "no don't allow it",
]);

/** Lower case, straight apostrophes, no closing punctuation, single spaces. */
const norm = (text: string) => text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[\s?!.…]+$/u, "").replace(/\s+/g, " ").replace(/,(?=\S)/g, ", ");

/** The answer a whole utterance gives: "allow", "deny", or null (anything else, or longer than a short answer). */
export function spokenAnswer(text: string): "allow" | "deny" | null {
  const t = norm(text);
  if (!t || t.length > 60) return null;
  // Punctuation first ("Hey, Ember. Allow."), then what leads and trails the answer.
  const core = t.replace(/[,.!;:]/g, " ").replace(/\s+/g, " ").trim().replace(LEAD, "").replace(TAIL, "").trim();
  if (YES.has(core)) return "allow";
  if (NO.has(core)) return "deny";
  return null;
}

/**
 * What the recognizer heard round a wake word that Ember turned away because it was speaking (VoiceEvent "rejected",
 * reason "self": where it can't tell its own voice from the user's, on Windows and macOS, "Ember, allow" said over the
 * question it reads out is dropped): the answer it was, when the name came with an answer and nothing more, else null.
 * Never taken as an answer (it may be Ember's own words): main stops speaking and asks for it again.
 */
export function heardAnswer(heard: string): "allow" | "deny" | null {
  const m = /\b(?:ember|amber|emma)\b[\s,.!?:;-]*(.*)$/i.exec(heard.trim());
  return m?.[1] ? spokenAnswer(m[1]) : null;
}

/** What main knows of an utterance when a question may be up. */
export interface VoiceAnswerInput {
  text: string;
  /** A question is up now (Confirmer.waiting). */
  questionUp: boolean;
  /** Voice Match is on and has the owner's voiceprint (settings.voice.match and voiceprint.json). */
  matchOn: boolean;
  /**
   * Voice Match is turned on, but isn't in use yet: no voiceprint kept (teaching it was never finished), or its model
   * isn't in (downloading, or damaged). A yes is refused with words saying so, not "turn it on".
   */
  matchUnready?: boolean;
  /** The voice process verified this utterance as the owner's (VoiceEvent utterance `verified`). */
  verified: boolean;
  /** It matched the owner's voice but was too short to vouch for (VoiceEvent utterance `short`). */
  short?: boolean;
  /** Ember made sound while this was being said, or just before (VoiceService.selfSpokeSince). */
  selfSpoke: boolean;
}

/** Why a spoken answer wasn't taken. */
export type VoiceAnswerRefusal = "voice-match-off" | "voice-match-unready" | "unverified" | "own-voice" | "too-short";

export type VoiceAnswerOutcome =
  /** Not an answer: an ordinary request (no question up, or other words). */
  | { kind: "none" }
  | { kind: "answer"; answer: "allow" | "deny"; verified: boolean }
  | { kind: "refused"; answer: "allow" | "deny"; why: VoiceAnswerRefusal };

/** Is this utterance an answer to the question up, and may it be taken? */
export function voiceAnswer(i: VoiceAnswerInput): VoiceAnswerOutcome {
  if (!i.questionUp) return { kind: "none" };
  const answer = spokenAnswer(i.text);
  if (!answer) return { kind: "none" };
  // Ember's own voice from the speakers (it reads the question out, keys and all) is never an answer, either way.
  if (i.selfSpoke) return { kind: "refused", answer, why: "own-voice" };
  const verified = i.matchOn && i.verified;
  if (answer === "deny") return { kind: "answer", answer, verified };
  if (!i.matchOn) return { kind: "refused", answer, why: i.matchUnready ? "voice-match-unready" : "voice-match-off" };
  if (!i.verified) return { kind: "refused", answer, why: i.short ? "too-short" : "unverified" };
  return { kind: "answer", answer, verified: true };
}

/** Every reason a spoken answer can be turned away: voiceAnswer's, the Confirmer's, and an answer said over Ember's voice. */
export type VoiceAnswerNote = VoiceAnswerRefusal | "click-only" | "not-yet" | "stale" | "locked" | "heard-over";

/**
 * What the bubble says under the question when a spoken answer wasn't taken (the question stays up): what happened,
 * and exactly what to do instead. Ember says it too (voiceAnswerSaid), where it speaks.
 */
export const VOICE_ANSWER_REFUSED: Readonly<Record<VoiceAnswerNote, string>> = {
  "voice-match-off": "To answer yes by voice, set up Voice Match in Settings › Voice, so I know it's you. For now, click Allow.",
  "voice-match-unready": "Voice Match isn't ready yet: finish setting it up in Settings › Voice to answer yes by voice. For now, click Allow.",
  unverified: "That didn't sound like you, so I didn't take it as a yes. Say it again, or click Allow.",
  "own-voice": "I was still speaking, so I didn't take that as an answer. Say it again now.",
  "click-only": "This one needs a click: I can't take a yes by voice here.",
  "not-yet": "Read it through first, then say yes again.",
  "too-short": "Say a little more so I can be sure it's you, like “Yes, please go ahead and allow that.”",
  stale: "That was said before this question came up, so I didn't take it. Say it again.",
  locked: "I heard a voice that isn't yours, so for this question I'll take a click or the keys only.",
  "heard-over": "I heard you over my own voice, so I didn't take it. Say it again now that I've stopped.",
};

/**
 * The same, as Ember says it aloud: "Settings › Voice" as "Settings, then Voice", without the quotes. Every line Ember
 * says here is one of these fixed sentences: what the user said is never repeated back.
 */
export function voiceAnswerSaid(why: VoiceAnswerNote): string {
  return VOICE_ANSWER_REFUSED[why].replace(/\s*›\s*/g, ", then ").replace(/[“”]/g, "");
}
