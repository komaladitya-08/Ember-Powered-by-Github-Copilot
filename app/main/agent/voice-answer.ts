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

/** Before the answer: the name, "hey Ember", "ok", "so". */
const LEAD = /^(?:(?:hey|ok|okay|so)[,\s]+)?(?:ember[,\s]+)?/;
/** After it: "please", "thanks", the name again. */
const TAIL = /(?:[,\s]+(?:please|thanks|thank you|ember))*$/;

const YES = new Set([
  "allow", "allow it", "allow that", "yes allow", "yes allow it", "yes", "yes please", "yeah", "yep", "go ahead", "yes go ahead",
  "okay go ahead", "ok go ahead", "go for it", "do it", "yes do it", "you may", "approve", "approved", "sure", "sure go ahead",
  // Longer ways to say it, so Voice Match has enough of the voice to vouch for it (match.ts APPROVAL_MIN_SECONDS).
  "yes go ahead and allow it", "yes go ahead and allow that", "yes please allow it", "yes please allow that", "yes you can go ahead", "yes you may go ahead",
]);
const NO = new Set([
  "not now", "no", "no thanks", "no thank you", "nope", "don't", "do not", "don't do it", "no don't", "no don't do it",
  "deny", "not now thanks", "no not now",
]);

/** Lower case, straight apostrophes, no closing punctuation, single spaces. */
const norm = (text: string) => text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[\s?!.…]+$/u, "").replace(/\s+/g, " ").replace(/,(?=\S)/g, ", ");

/** The answer a whole utterance gives: "allow", "deny", or null (anything else, or longer than a short answer). */
export function spokenAnswer(text: string): "allow" | "deny" | null {
  const t = norm(text);
  if (!t || t.length > 40) return null;
  const core = t.replace(LEAD, "").replace(TAIL, "").replace(/[,.!]/g, "").replace(/\s+/g, " ").trim();
  if (YES.has(core)) return "allow";
  if (NO.has(core)) return "deny";
  return null;
}

/** What main knows of an utterance when a question may be up. */
export interface VoiceAnswerInput {
  text: string;
  /** A question is up now (Confirmer.waiting). */
  questionUp: boolean;
  /** Voice Match is on and has the owner's voiceprint (settings.voice.match and voiceprint.json). */
  matchOn: boolean;
  /** The voice process verified this utterance as the owner's (VoiceEvent utterance `verified`). */
  verified: boolean;
  /** It matched the owner's voice but was too short to vouch for (VoiceEvent utterance `short`). */
  short?: boolean;
  /** Ember made sound while this was being said, or just before (VoiceService.selfSpokeSince). */
  selfSpoke: boolean;
}

/** Why a spoken answer wasn't taken. */
export type VoiceAnswerRefusal = "voice-match-off" | "unverified" | "own-voice" | "too-short";

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
  if (!i.matchOn) return { kind: "refused", answer, why: "voice-match-off" };
  if (!i.verified) return { kind: "refused", answer, why: i.short ? "too-short" : "unverified" };
  return { kind: "answer", answer, verified: true };
}

/** What the bubble says under the question when a spoken answer wasn't taken (the question stays up). */
export const VOICE_ANSWER_REFUSED: Readonly<Record<VoiceAnswerRefusal | "click-only" | "not-yet" | "stale" | "locked", string>> = {
  "voice-match-off": "I can take a yes by voice only once Voice Match knows your voice: turn it on in Settings › Voice. Click Allow for now.",
  unverified: "That didn't sound like you, so I didn't take it as a yes. Click Allow, or say it again.",
  "own-voice": "I was still speaking, so I didn't take that as an answer. Say it again.",
  "click-only": "This one needs a click: I can't take a yes by voice here.",
  "not-yet": "Read it through first, then say “Allow” again.",
  "too-short": "Say a little more so I can be sure it's you: “Ember, yes, go ahead and allow it.”",
  stale: "That was said before this question came up, so I didn't take it. Say it again.",
  locked: "I heard a voice that isn't yours, so for this question I'll take a click or the keys only.",
};
