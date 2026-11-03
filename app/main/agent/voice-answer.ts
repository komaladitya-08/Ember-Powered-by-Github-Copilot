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
 * - or, a yes too short for Voice Match to vouch for, to a question of a task the owner asked for in a verified voice
 *   (owner decision of 2026-11-03, "also trust the task's voice": TaskVoiceTrust below), unless its own score says it
 *   is clearly another voice (SHORT_YES_FLOOR);
 * - "Not now" from anyone (it is the safer way, as anyone may stop Ember).
 * Typed text and the model never come here: main calls it only from the voice process's utterances.
 */

/**
 * A short yes whose own voiceprint score (match.ts `restScore`) is under this is another voice, and never taken on a
 * task's trust. Measured on LibriSpeech dev-clean (33 speakers, pieces of 0.5 s of voice): 1.1 % of the owner's own
 * score under it, and 52 % of other voices' (at 0.6: 6.8 % and 82 %; 0.5 keeps the owner's short yes working). With
 * the whole pipeline (40 speakers, a 0.3–0.6 s "allow"): the owner's short yes is taken 97.5–100 %, another person's
 * whole "Hey Ember, allow" 2.2–2.5 %, another's "allow" after the owner's recorded "Hey Ember" 41–43 % (at 0.6:
 * about 20 %, but a quarter of the owner's 0.3 s yeses refused). PLAN.md §2 "Approvals" records the owner's choice.
 */
export const SHORT_YES_FLOOR = 0.5;
/**
 * How long after the owner's verified request a task's short yeses are trusted: 10 minutes. Most tasks ask their
 * questions within a few minutes of being asked (a worker stops at 20); it is the window in which host.ts already folds
 * the user's answers into a request (userWordsOf), and it bounds how long a mistaken trust can outlive the request.
 */
export const TASK_VOICE_MS = 10 * 60_000;

/**
 * Why a task's voice trust ended: its time ran out, Voice Match turned a voice away, the task was changed by an
 * unverified request, or the owner's voiceprint was forgotten or taught again (it was granted against the old one).
 */
export type TrustEnd = "expired" | "other-voice" | "steered" | "voice-changed";

/**
 * Does Voice Match turning a wake away (VoiceEvent "rejected") end every task's trust? Only when it was another voice
 * ("voice"): not Ember's own speech, the speakers' stream or a failed check of the name. Pure, so main's wiring is tested.
 */
export function rejectionEndsTrust(reason: "self" | "speakers" | "check" | "voice"): boolean {
  return reason === "voice";
}

/**
 * Does a spoken answer's outcome end every task's trust? A yes turned away as not the owner's voice does ("unverified":
 * a clear mismatch, or a request Voice Match couldn't check), since Ember can't tell whose question it was after. A
 * "no", a yes that was merely too short, another task's question or any other refusal doesn't. Pure, as above.
 */
export function refusalEndsTrust(result: string, answer: "allow" | "deny"): boolean {
  return answer === "allow" && result === "unverified";
}

/**
 * Which tasks the owner asked for in a verified voice, so a short spoken yes to one of their own questions may be taken
 * (owner decision of 2026-11-03). A task holds it from the verified request that started it (`grant`) for
 * TASK_VOICE_MS; it ends for good when Voice Match turns any voice away or a spoken yes is refused as another voice
 * (`endAll`: Ember can't tell which task that voice was after), or when the task is changed by a request that wasn't
 * verified (`end`). In memory only; nothing about a voice is kept.
 */
export class TaskVoiceTrust {
  private grants = new Map<string, { at: number; ended?: TrustEnd }>();

  constructor(private now: () => number = Date.now, private maxMs = TASK_VOICE_MS) {}

  /** Task `task` was started by the owner's request, verified at `verifiedAt`. */
  grant(task: string, verifiedAt: number): void {
    this.grants.set(task, { at: verifiedAt });
    // Bounded: the oldest go (their time is long out by then).
    while (this.grants.size > 64) this.grants.delete(this.grants.keys().next().value!);
  }

  /** Task `task`'s trust ends for good (nothing if it had none). */
  end(task: string, why: TrustEnd): void {
    const g = this.grants.get(task);
    if (g && !g.ended) g.ended = why;
  }

  /** Every task's trust ends for good: Voice Match heard another voice. */
  endAll(why: TrustEnd): void {
    for (const g of this.grants.values()) g.ended ??= why;
  }

  /** Does task `task` hold its trust now? (Absent task: a question no task raised, which never does.) */
  holds(task: string | undefined): boolean {
    if (!task) return false;
    const g = this.grants.get(task);
    if (!g || g.ended) return false;
    const age = this.now() - g.at;
    if (age < 0 || age > this.maxMs) { g.ended = "expired"; return false; }
    return true;
  }
}

/** The name as the recognizer may write it. */
const NAMES = new Set(["ember", "amber", "emma"]);
/** Words that only lead into an answer: one of them may ("Okay, go ahead"), never a run of them (review of #143). */
const FILLERS = new Set(["ok", "okay", "so", "oh", "um", "uh", "well", "alright"]);

/**
 * The answer without what leads it: "hey", the name and one filler word, each at most once ("Hey Ember, um, allow").
 * More than that is left in, so it isn't an answer: "Okay, okay, okay, okay." and "Um, um, um, yes." pad a short yes
 * past Voice Match's length check without saying more (review of #143).
 */
function withoutLead(words: string[]): string[] {
  let hey = false, name = false, filler = false, i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === "hey" && !hey && !name) hey = true;
    else if (NAMES.has(w) && !name) name = true;
    else if (FILLERS.has(w) && !filler) filler = true;
    else break;
  }
  return words.slice(i);
}

/** The answer without what trails it: "please", "thanks" or "thank you", and the name, each at most once. */
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
 * The recognizer's ways with the words count too ("aloud", "a low", "go a head"): a yes still needs the owner's
 * verified voice, and none of them sounds like a no. Not a bare acknowledgement ("okay", "alright", "go on", "you
 * can"), which people say while they listen, not to allow something (review of #143).
 */
const YES = new Set([
  "allow", "allow it", "allow that", "allow this", "allow that one", "yes allow", "yes allow it", "yes allow that", "yes", "yes yes", "yes please",
  "yeah", "yep", "yup", "sure", "sure thing", "sure go ahead", "yeah sure", "yes sure", "of course",
  "go ahead", "yes go ahead", "yeah go ahead", "yep go ahead", "okay go ahead", "ok go ahead", "alright go ahead", "fine go ahead",
  "that's fine go ahead", "go for it", "do it", "yes do it", "yeah do it", "okay do it", "ok do it", "please do", "yes please do",
  "you may", "yes you may", "yes you can", "approve", "approve it", "approved", "proceed", "yes proceed", "that's fine", "yes that's fine",
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

/**
 * The answer a whole utterance gives: "allow", "deny", or null (anything else, or longer than a short answer). A yes
 * asked as a question ("Proceed?", "Ember, you can go ahead?") isn't one (review of #143); a no is one either way.
 */
export function spokenAnswer(text: string): "allow" | "deny" | null {
  const t = norm(text);
  if (!t || t.length > 60) return null;
  // Punctuation first ("Hey, Ember. Allow."), then what leads and trails the answer.
  const spoken = t.replace(/[,.!;:]/g, " ").split(/\s+/).filter(Boolean);
  const words = withoutTail(withoutLead(spoken));
  // "Please" leads many answers ("please go ahead"), and is part of one ("please do").
  const cores = [words.join(" "), ...(words[0] === "please" ? [words.slice(1).join(" ")] : [])];
  if (cores.some(c => NO.has(c))) return "deny";
  if (!cores.some(c => YES.has(c))) return null;
  // "Please" once in all: "please please do" pads a short yes past the length check (security review of #143).
  if (spoken.filter(w => w === "please").length > 1) return null;
  // Asked as a question, whatever follows the "?" ("Allow it?!", "Allow?."): not a yes.
  return /[?？]$/.test(text.trim().replace(/[\s.!…"”’')\]]+$/u, "")) ? null : "allow";
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
  /** A short one's own score, after the wake phrase (VoiceEvent utterance `restScore`; absent: too little voice to score). */
  restScore?: number;
  /** The question up was raised by a task that holds its voice trust (TaskVoiceTrust.holds). */
  taskTrust?: boolean;
  /** Ember made sound while this was being said, or just before (VoiceService.selfSpokeSince). */
  selfSpoke: boolean;
}

/** Why a spoken answer wasn't taken. */
export type VoiceAnswerRefusal = "voice-match-off" | "voice-match-unready" | "unverified" | "own-voice" | "too-short";

export type VoiceAnswerOutcome =
  /** Not an answer: an ordinary request (no question up, or other words). */
  | { kind: "none" }
  /** `trust`: a short yes taken on its task's voice trust (verified false), for the Confirmer to check and the audit to say. */
  | { kind: "answer"; answer: "allow" | "deny"; verified: boolean; trust?: "task-voice" }
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
  if (i.verified) return { kind: "answer", answer, verified: true };
  // Too short to vouch for: its own score, where it has one, says whether it is clearly another voice.
  const otherVoice = i.restScore !== undefined && i.restScore < SHORT_YES_FLOOR;
  if (!i.short || otherVoice) return { kind: "refused", answer, why: "unverified" };
  // No score at all (under SCORE_MIN_SECONDS of voiced frames after the wake phrase: very quiet or clipped, next to a loud
  // "Hey Ember") is never taken on trust: the floor could never apply to it, and only the whole clip, mostly the wake
  // phrase, was matched (security review of #143).
  if (i.restScore === undefined) return { kind: "refused", answer, why: "too-short" };
  if (i.taskTrust) return { kind: "answer", answer, verified: false, trust: "task-voice" };
  return { kind: "refused", answer, why: "too-short" };
}

/** Every reason a spoken answer can be turned away: voiceAnswer's, the Confirmer's, and an answer said over Ember's voice. */
export type VoiceAnswerNote = VoiceAnswerRefusal | "click-only" | "not-yet" | "stale" | "locked" | "heard-over";

/**
 * What the bubble says under the question when a spoken answer wasn't taken (the question stays up): what happened,
 * and exactly what to do instead. Ember says it too (voiceAnswerSaid), where it speaks.
 */
export const VOICE_ANSWER_REFUSED: Readonly<Record<VoiceAnswerNote, string>> = {
  "voice-match-off": "To answer yes by voice, set up Voice Match in Settings › Voice, so I know it's you. For now, click Allow.",
  "voice-match-unready": "Voice Match isn't ready yet: finish setting it up in Settings › Voice, to answer yes by voice. For now, click Allow.",
  unverified: "That didn't sound like you, so I didn't take it as a yes. Say it again, or click Allow.",
  "own-voice": "I was still speaking, so I didn't take that as an answer. Say it again now.",
  "click-only": "This one needs a click: I can't take a yes by voice here.",
  "not-yet": "Read it through first, then say yes again.",
  "too-short": "I couldn't hear enough of your voice to be sure it's you. Say it a little longer, like “Yes, please go ahead.”",
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
