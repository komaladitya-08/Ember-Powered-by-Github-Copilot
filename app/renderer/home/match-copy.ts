/**
 * Voice Match (in Voice): what the settings window shows, says to screen readers and focuses for each state, as plain
 * data. home/main.ts applies it to the page; the tests read it without a DOM.
 */
import type { VoiceMatchStatus } from "../../shared/ipc";

/** Voice Match's words. */
export const MATCH_TEXT = {
  label: "Only my voice can say yes (Voice Match)",
  // Off, its default, anyone heard can answer a question by voice; on, only the owner's voice can say yes, and anyone
  // can still say no (owner decision of 2026-11-12, PLAN.md §2 "Approvals").
  none: "Ember hears anyone who talks to it, and anyone near the computer can answer its questions out loud. Teach it your voice, and only yours can agree to them. “Ember, stop” works for anyone.",
  on: "On: only your voice can agree to Ember's questions out loud; anyone can still say “not now”. Ember still hears everyone. Your voiceprint stays on this computer.",
  off: "Off: anyone near the computer can answer Ember's questions out loud. Ember keeps your voiceprint until you forget it.",
  /**
   * enrolVoice() said no: Ember isn't listening just now (muted, starting, or the microphone not working, which the voice
   * line above says: voice-listening-r7-1), so it can't hear the phrases. Shown, and said as Teach is pressed, also while
   * listening starts, so without the name: "Ember isn't listening just now, so it can't learn your voice. Try again once
   * it's listening for “Ember”." woke Ember and was sent as a request in 3 of 4 real-model placements, this line in 0
   * of 20 (voice-listening-r6-3, voice-listening-c7-1).
   */
  notListening: "Not listening just now, so your voice can't be learnt. Check the microphone and the voice status above, then try again.",
  say: "Say:",
  again: { short: "That was too short. Say it again:", unlike: "That didn't sound like the others (another voice, or noise). Say it again:", failed: "That wasn't heard clearly. Say it again:", over: "Your screen reader was still reading. Wait for it to finish, then say:" },
  /** Without the name: focus is moved to this button, and a screen reader then reads it (voice-listening-r6-2). */
  teach: "Teach my voice",
  teachAgain: "Teach my voice again",
  cancel: "Cancel",
  forget: "Forget my voice",
  learnt: "Ember knows your voice now.",
  stopped: "Stopped teaching Ember your voice.",
  /** Forget my voice deletes the words learnt from what the user said too (personal/service.ts forgetVoice): said so. */
  forgot: "Ember forgot your voice and the words it learnt.",
  forgetHint: "Also forgets the words Ember learnt from what you said.",
  progressLabel: "Phrases Ember has heard",
  /** Teaching ended before Ember learnt the voice, and not by the user's Cancel (VoiceMatchStatus.ended). */
  ended: {
    "gave-up": "Ember couldn't learn your voice: too many phrases didn't sound alike. Try again somewhere quiet, with only you speaking.",
    timeout: "Teaching stopped because Ember didn't hear a phrase for a while. Try again when you're ready.",
    interrupted: "Teaching stopped because Ember stopped listening. Try again once it's listening for “Ember”.",
  },
} as const;

/**
 * What a screen reader is told as teaching ends or the voice is forgotten (matchAnnouncement): the news of the lines
 * shown, worded without Ember's name and without a phrase it answers. Said into the wake word's microphone, "Ember knows
 * your voice now. …" woke Ember and was sent as a request in 22 of 40 placements and "Ember forgot your voice…" in 24,
 * and the line shown for no voice quotes “Ember, stop”, which stops it (voice-listening-r5-1). Nor with an "it" for
 * Ember: heard alone, "…forgotten. Anyone who talks to it is heard. Teach it your voice…" read as the person's own
 * voice (voice-listening-x6-4). Nor with more listening than the line shown says: right after Forget my voice,
 * "Everyone who talks is heard." said all talk near the computer is, where the line shown says only that anyone who
 * talks to Ember is heard (voice-listening-y6-3). `none` is said only after teaching or forgetting, so "again".
 *
 * The Teach button's description is in these words too (`teach` where no voice is known, without the "again";
 * matchView's `teach.said`): Home moves focus to Teach after Cancel, as teaching ends and after Forget my voice, and a
 * screen reader then reads the button's name and description. With the line shown as the description, "Teach Ember my
 * voice, button. Ember hears anyone who talks to it. Teach it your voice…" woke Ember and was sent as a request in 18 of
 * 20 real-model placements, and the name alone in 14 (voice-listening-r6-2, voice-listening-q6-1); these in 0 of 20.
 */
export const MATCH_SAID = {
  none: "Requests from any voice are heard, and any voice can answer questions out loud. Teach your voice again, and only yours can agree to them.",
  teach: "Requests from any voice are heard, and any voice can answer questions out loud. Teach your voice, and only yours can agree to them.",
  on: "On: only your voice can agree to questions out loud. Everyone is still heard. Your voiceprint stays on this computer.",
  off: "Off: any voice can answer questions out loud. Your voiceprint is kept until you forget it.",
  noModel: "Voice Match's model is missing or was damaged. Download it above to put that right.",
  learnt: "Your voice is learnt.",
  stopped: "Stopped teaching your voice.",
  forgot: "Your voiceprint and the words learnt from what you said are forgotten.",
  ended: {
    "gave-up": "Your voice wasn't learnt: too many phrases didn't sound alike. Try again somewhere quiet, with only you speaking.",
    timeout: "Teaching stopped because no phrase was heard for a while. Try again when you're ready.",
    interrupted: "Teaching stopped because listening stopped. Try again once listening starts again.",
  },
} as const;

/** `matchText`'s news as a screen reader is told it (MATCH_SAID). `none`: the words for no voice known. */
function matchSaid(m: VoiceMatchStatus, none: string = MATCH_SAID.none): string {
  if (noModel(m)) return MATCH_SAID.noModel;
  const state = !m.enrolled ? none : m.on ? MATCH_SAID.on : MATCH_SAID.off;
  const ended = m.ended === "gave-up" || m.ended === "timeout" || m.ended === "interrupted" ? MATCH_SAID.ended[m.ended] : null;
  return ended ? `${ended} ${state}` : state;
}

export interface MatchView {
  /** The whole group: hidden without a match status, while listening is off, or while the organisation turned voice off. */
  hidden: boolean;
  busy: boolean;
  checked: boolean;
  disabled: boolean;
  text: string;
  /** The phrase to say ("" when not enrolling). */
  prompt: string;
  progress: { value: number; max: number; text: string } | null;
  /** `said`: the description a screen reader reads with the button, in MATCH_SAID's words (never the line shown). */
  teach: { hidden: boolean; label: string; said: string };
  cancelHidden: boolean;
  forgetHidden: boolean;
  /** Where focus goes when the control that had it is hidden or disabled by this state (first shown wins). */
  focus: string[];
}

/**
 * Voice Match without its model (missing, or damaged): that while it is wanted no spoken yes is taken (voice-answer.ts
 * "voice-match-unready"; everyone is still heard, as Voice Match never decides who is), or why it can't be taught yet.
 * "Off for now…" read as if anyone could say yes meanwhile (owner's report of 2026-11-12). `bytes`: the model's size,
 * when it alone is missing.
 */
export function matchNoModelText(wanted: boolean, bytes: number | null = null): string {
  const size = bytes ? ` (${Math.max(1, Math.round(bytes / 1e6))} MB)` : "";
  return wanted
    ? `Voice Match can't work for now: its model is missing or was damaged, so Ember takes no spoken yes. Download it above${size} to put that right.`
    : `Voice Match needs its own model, which isn't on this computer. Download it above${size}, then teach Ember your voice.`;
}

/** Voice Match can't run: its model isn't in (a status from before this field says it is). */
const noModel = (m: VoiceMatchStatus) => m.model === false && !m.enrolling;

export function matchText(m: VoiceMatchStatus, speakerBytes: number | null = null): string {
  if (m.enrolling) return `Say each phrase as you would ask Ember (${m.enrolling.got} of ${m.enrolling.of} heard).`;
  if (noModel(m)) return matchNoModelText(!!m.wanted, speakerBytes);
  const state = !m.enrolled ? MATCH_TEXT.none : m.on ? MATCH_TEXT.on : MATCH_TEXT.off;
  // Why the last teaching didn't learn the voice, until it is taught again (an earlier voiceprint is still in use).
  const ended = m.ended === "gave-up" || m.ended === "timeout" || m.ended === "interrupted" ? MATCH_TEXT.ended[m.ended] : null;
  return ended ? `${ended} ${state}` : state;
}

export function matchPrompt(e: NonNullable<VoiceMatchStatus["enrolling"]>): string {
  return `${e.again ? MATCH_TEXT.again[e.again] : MATCH_TEXT.say} “${e.phrase}”`;
}

/**
 * Whether a refused Teach's line (MATCH_TEXT.notListening) still holds: until Ember listens again (`state`: the voice
 * status's) or teaching starts. With no microphone the voice status is sent again at every retry (after 1 s, 5 s, then
 * every 30 s), and the line was wiped at the next one, the row reading "…Teach it your voice…" again as if Teach could
 * work (voice-listening-x7-2).
 */
export function matchRefusalHolds(state: string | undefined, m: VoiceMatchStatus | undefined): boolean {
  return state !== "waiting" && state !== "active" && !m?.enrolling;
}

/**
 * `speakerBytes`: Voice Match's model's size, when it alone is missing (said in the note about it). `refused`: Teach
 * was pressed and refused, and that still holds (matchRefusalHolds), so the line says why.
 */
export function matchView(m: VoiceMatchStatus | undefined, o: { listening: boolean; managed: boolean; speakerBytes?: number | null; refused?: boolean }): MatchView {
  const hidden = !m || o.managed || !o.listening;
  const e = m?.enrolling ?? null;
  const busy = !!e;
  // Its model missing or damaged: off until the download brings it back; nothing to switch on or teach meanwhile.
  const blocked = !!m && noModel(m);
  return {
    hidden,
    busy,
    checked: !!m && (m.on || busy),
    disabled: busy || blocked,
    text: !m ? "" : o.refused && !e ? MATCH_TEXT.notListening : matchText(m, o.speakerBytes ?? null),
    prompt: e ? matchPrompt(e) : "",
    progress: e ? { value: e.got, max: e.of, text: `${e.got} of ${e.of} heard` } : null,
    teach: { hidden: busy || blocked, label: m?.enrolled ? MATCH_TEXT.teachAgain : MATCH_TEXT.teach, said: m ? matchSaid(m, MATCH_SAID.teach) : "" },
    cancelHidden: !busy,
    forgetHidden: busy || !m?.enrolled,
    // Teaching: Cancel is the one button there. Otherwise Teach; with the whole group gone (listening off), the listening
    // switch. Without its model, while Ember listens: Download, or Listen once, never the switch, whose name read aloud
    // ("Listen for “Hey Ember”, switch, on") wakes Ember (voice-listening-r7-2).
    focus: hidden ? ["wake"] : busy ? ["match-cancel"] : blocked ? ["voice-download", "voice-listen-once", "wake"] : ["match-teach", "match-on", "wake"],
  };
}

/**
 * What `#voice-live` says when Voice Match's status changes (null: nothing new). Each phrase is said as it is asked for,
 * with how many were heard, and the end says how it ended (`m.ended`: never "learnt" for teaching that gave up while an
 * earlier voiceprint is kept, voice-listening-5), in MATCH_SAID's words. `cancelled`: the user pressed Cancel.
 */
export function matchAnnouncement(prev: VoiceMatchStatus | undefined, m: VoiceMatchStatus | undefined, cancelled = false): string | null {
  if (!m) return null;
  const e = m.enrolling;
  if (e) {
    const p = prev?.enrolling;
    if (p && p.got === e.got && p.phrase === e.phrase && p.again === e.again) return null;
    return e.again || e.got === 0 ? matchPrompt(e) : `Heard ${e.got} of ${e.of}. ${matchPrompt(e)}`;
  }
  if (prev?.enrolling) {
    const how = cancelled || m.ended === "cancelled" || m.ended === "stopped" ? MATCH_SAID.stopped
      : m.ended === "learnt" || (!m.ended && m.enrolled) ? MATCH_SAID.learnt : "";
    return `${how} ${matchSaid(m)}`.trim();
  }
  if (prev?.enrolled && !m.enrolled) return `${MATCH_SAID.forgot} ${matchSaid(m)}`;
  return null;
}

/** Said (and shown as the tooltip) on a row the organisation set, as on Ember's other managed rows. */
export const MANAGED_TEXT = "Managed by your organisation";

