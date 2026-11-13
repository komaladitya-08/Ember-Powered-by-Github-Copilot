/**
 * Spoken answers to Ember's questions (owner decisions of 2026-11-02 and 2026-11-12, PLAN.md §2 "Approvals"): while a
 * question is up, "allow" (or "yes", "okay, go with it", "go ahead"…) answers it as Allow, and "not now" (or "no",
 * "don't") as Not now.
 *
 * The rules, judged here from what main knows of the utterance, so they are unit-tested without Electron:
 * - only while a question is up (anything else is an ordinary request for the conversation);
 * - only the whole utterance, and only these short phrases: never "Always", never words inside a longer request;
 * - never Ember's own voice: nothing heard while Ember spoke, or just after, counts (the echo guard, review #112);
 * - a yes from anyone heard while Voice Match is switched off, its default (owner decision of 2026-11-12: "it doesn't
 *   really need my voice to be matched for it"), the Confirmer then holding it to what the approve key may do;
 * - while Voice Match is switched on, a yes only from the owner's voice: enrolled, and this utterance verified as
 *   theirs (match.ts); switched on but not ready, no yes at all, and the bubble says how to finish it or turn it off;
 * - or, with Voice Match on, a yes too short for it to vouch for, to a question of a task the owner asked for in a
 *   verified voice (owner decision of 2026-11-03, "also trust the task's voice": TaskVoiceTrust below), unless its own
 *   score says it is clearly another voice (SHORT_YES_FLOOR);
 * - "Not now" from anyone (it is the safer way, as anyone may stop Ember).
 * Typed text and the model never come here: main calls it only from the voice process's utterances.
 */

import { spokenAnswer } from "../../shared/spoken-answer";

/**
 * A short yes whose own voiceprint score (match.ts `restScore`) is under this is another voice, and never taken on a
 * task's trust. Measured on LibriSpeech dev-clean (33 speakers, pieces of 0.5 s of voice): 1.1 % of the owner's own
 * score under it, and 52 % of other voices' (at 0.6: 6.8 % and 82 %; 0.5 keeps the owner's short yes working). With
 * the whole pipeline (40 speakers, a 0.3–0.6 s "allow"): the owner's short yes is taken 97.5–100 %, another person's
 * whole "Hey Ember, allow" 2.2–2.5 %, another's "allow" after the owner's recorded "Hey Ember" 35–40 % (at 0.6:
 * 12–19 %, but a quarter of the owner's 0.3 s yeses refused). With no score (under 0.25 s of voiced frames) a yes is
 * refused: the recorded wake and a 0.15 s yes 8.8 % (78 % when it was taken), a quiet one 0.3 % (8.3 %), the owner's
 * own 0.15 s yes 17.5 % (95 %). PLAN.md §2 "Approvals" records the owner's choice.
 */
export const SHORT_YES_FLOOR = 0.5;

/**
 * Is a heard request not to count as the user's own words for commands (UserRequest.voiceUnchecked)? So when a click opened
 * the window, where Ember can't tell the user from its speakers, and over other sound without a full match: there
 * OVER_SOUND_MATCH only lets it be heard, and other voices score above it, so a song's "delete…" must not pass for the user's.
 */
export const heardUnchecked = (u: { overSound?: boolean; verified?: boolean }, manual: boolean, rejectsSpeakers: boolean): boolean =>
  manual || !rejectsSpeakers || (u.overSound === true && u.verified !== true);
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

/**
 * The answer a whole utterance gives ("allow", "deny" or null): shared with the voice process's engine, which lets such
 * an utterance through to main while a question waits (app/shared/spoken-answer.ts holds the lists).
 */
export { spokenAnswer };

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
  /** Voice Match is on and has the owner's voiceprint (settings.voice.match and voiceprint.json), and its model is in. */
  matchOn: boolean;
  /**
   * Voice Match is switched off (settings.voice.match false, its default): a yes is taken from anyone heard (owner
   * decision of 2026-11-12). False while it is switched on, in use or not: then only the owner's verified voice (or a
   * short yes on its task's trust) can say yes, and while it isn't in use yet (never taught, or its model isn't in) no
   * spoken yes at all, with words saying so. Read from the switch itself, never from whether it is ready, so a Voice
   * Match that can't run never lets anyone in (fail closed).
   */
  matchOff: boolean;
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
export type VoiceAnswerRefusal = "voice-match-unready" | "unverified" | "own-voice" | "too-short";

export type VoiceAnswerOutcome =
  /** Not an answer: an ordinary request (no question up, or other words). */
  | { kind: "none" }
  /**
   * `trust`: a short yes taken on its task's voice trust (verified false), for the Confirmer to check and the audit to
   * say. `anyone`: a yes from whoever was heard, Voice Match being off (verified false), which the Confirmer takes only
   * when main passes it on.
   */
  | { kind: "answer"; answer: "allow" | "deny"; verified: boolean; trust?: "task-voice"; anyone?: true }
  | { kind: "refused"; answer: "allow" | "deny"; why: VoiceAnswerRefusal };

/** Is this utterance an answer to the question up, and may it be taken? */
export function voiceAnswer(i: VoiceAnswerInput): VoiceAnswerOutcome {
  if (!i.questionUp) return { kind: "none" };
  const answer = spokenAnswer(i.text);
  if (!answer) return { kind: "none" };
  // Voice Match switched on but not in use: no yes can be taken, so the refusal never asks for it again (cause 5 of the
  // owner's report of 2026-11-12: "I was still speaking… Say it again" came first, and saying it again could only fail).
  const anyone = i.matchOff && !i.matchOn;
  if (answer === "allow" && !anyone && !i.matchOn) return { kind: "refused", answer, why: "voice-match-unready" };
  // Ember's own voice from the speakers (it reads the question out, keys and all) is never an answer, either way.
  if (i.selfSpoke) return { kind: "refused", answer, why: "own-voice" };
  const verified = i.matchOn && i.verified;
  if (answer === "deny") return { kind: "answer", answer, verified };
  // Voice Match off, its default: a yes from anyone heard (owner decision of 2026-11-12), as the approve key would be.
  if (anyone) return { kind: "answer", answer, verified: false, anyone: true };
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
export type VoiceAnswerNote = VoiceAnswerRefusal | "click-only" | "not-yet" | "stale" | "locked" | "heard-over" | "over-sound" | "name-doubted" | "sound-unknown" | "unclear";

/**
 * What the bubble says under the question when a spoken answer wasn't taken (the question stays up): what happened,
 * and exactly what to do instead. Ember says it too (voiceAnswerSaid), where it speaks, and then listens for the answer
 * without its name (the answer window): so none ends on words that read as an answer, which the microphone might
 * still catch of Ember's own voice as that window opens (owner's report of 2026-11-12).
 */
export const VOICE_ANSWER_REFUSED: Readonly<Record<VoiceAnswerNote, string>> = {
  "voice-match-unready": "Voice Match is on but isn't ready yet, so I can't take a yes by voice: finish setting it up in Settings › Voice, or turn it off. Until then, click Allow or use the keys.",
  unverified: "That didn't sound like you, so I didn't take it as a yes. Say it again, or click Allow or use the keys.",
  "own-voice": "I was still speaking, so I didn't take that as an answer. Say it again now.",
  "click-only": "This one needs a click: I can't take a yes by voice here.",
  "not-yet": "Read it through first, then say yes again.",
  "too-short": "I couldn't hear enough of your voice to be sure it's you. Say it a little longer, like “Yes, please go ahead”, so I can tell.",
  stale: "That was said before this question came up, so I didn't take it. Say it again.",
  locked: "I heard a voice that isn't yours, so for this question I'll take a click or the keys only.",
  "heard-over": "I heard you over my own voice, so I didn't take it. Say it again now that I've stopped.",
  // A nameless answer over a song or a video, which the voice gate drops without a voiceprint (match.ts "dropped"). So
  // for a yes said a pause after "Hey Ember" (V2-S6): the name was said, so the line asks for both in one go.
  "over-sound": "Something else was playing, so I couldn't tell that was for me: say your answer right after my name, in one go.",
  // So for one said right after the name, whose "Ember" couldn't be told from what the speakers were playing (engine.ts
  // namedByUser): asking for the name the user had just said told them to do what they did (voice-safety-x9-4).
  "name-doubted": "Something else was playing, and I couldn't tell whether you or it said my name: click Allow, or say it once more.",
  // A nameless yes where nothing can tell whether other sound plays (macOS, Linux without parec, Windows before its
  // output watch has looked: engine.ts soundKnown), which the gate drops without a voiceprint as over other sound.
  "sound-unknown": "I can't tell here whether something else is playing, so I didn't take that as a yes: say my name first, then your answer.",
  // A word or two in the answer window that read as no answer (engine.ts "unclear"): most likely one misheard.
  unclear: "I didn't catch that as an answer. Say “allow” or “not now” once more, or click on the question.",
};

/**
 * Those of the lines that name the keys, as they read where Ember holds none (another app took them): a shortcut is named
 * only while Ember holds it, and none ends on an answer (owner's report of 2026-11-12: "…click Allow or use the keys."
 * showed with no key to use).
 */
const WITHOUT_KEYS: Readonly<Partial<Record<VoiceAnswerNote, string>>> = {
  "voice-match-unready": "Voice Match is on but isn't ready yet, so I can't take a yes by voice: finish setting it up in Settings › Voice, or turn it off. Until then, click Allow on the question.",
  unverified: "That didn't sound like you, so I didn't take it as a yes. Say it again, or click Allow on the question.",
  locked: "I heard a voice that isn't yours, so for this question I'll take a click only.",
};

/** The note for `why` as the question shows it: the keys are named only while Ember holds them (`keysHeld`). */
export function refusalLine(why: VoiceAnswerNote, keysHeld: boolean): string {
  return (!keysHeld && WITHOUT_KEYS[why]) || VOICE_ANSWER_REFUSED[why];
}

/** The lines that point to a click or the keys: said aloud, they name the keys Ember holds too (tasks-approvals-6). */
const POINTS_TO_KEYS: ReadonlySet<VoiceAnswerNote> = new Set(["voice-match-unready", "unverified", "locked"]);

/**
 * The note for a spoken answer that wasn't taken (`why`), as the question stands: a yes to a question locked to clicks
 * and keys (Voice Match turned another voice away during it) says so, never to say it again, which could only fail
 * (cause 9 of the owner's report of 2026-11-12); with Voice Match switched on but not ready, a yes says how to finish
 * it or turn it off. A consent card's own note stands.
 */
export function refusalNote(why: VoiceAnswerNote, o: { answer: "allow" | "deny"; locked: boolean; unready: boolean }): VoiceAnswerNote {
  if (o.answer !== "allow" || why === "click-only") return why;
  if (o.unready) return "voice-match-unready";
  return o.locked ? "locked" : why;
}

/**
 * The same, as Ember says it aloud: "Settings › Voice" as "Settings, then Voice", without the quotes. Every line Ember
 * says here is one of these fixed sentences: what the user said is never repeated back. `keys`: the question keys Ember
 * holds now, as said ("Control Alt Y to allow"; none when another app holds them), named after a line that points to
 * a click or the keys, so someone answering without the mouse hears how (tasks-approvals-6).
 */
export function voiceAnswerSaid(why: VoiceAnswerNote, keys: readonly string[] = []): string {
  const line = refusalLine(why, keys.length > 0).replace(/\s*›\s*/g, ", then ").replace(/[“”]/g, "");
  if (!keys.length || !POINTS_TO_KEYS.has(why)) return line;
  const said = keysSaid(keys);
  return `${line} ${why === "locked" ? said : `Or, ${said.charAt(0).toLowerCase()}${said.slice(1)}`}`;
}

/**
 * The question keys Ember holds, as said ("Control Alt Y to allow", "Control Alt N for not now"), in one sentence that
 * ends on a key and never on an answer: "To allow, press Control Alt Y; for not now, press Control Alt N." The end of
 * Ember's own voice is what the microphone may still catch as a question's answer window opens, and "…or Control Alt N
 * for not now" ended on a no (owner's report of 2026-11-12). "" for none.
 */
export function keysSaid(keys: readonly string[]): string {
  const parts = keys.map(k => {
    const m = /^(.+?) ((?:to|for) .+)$/.exec(k);
    return m ? `${m[2]}, press ${m[1]}` : `press ${k}`;
  });
  if (!parts.length) return "";
  const s = parts.join("; ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}
