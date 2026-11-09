/**
 * Voice Match (in Voice) and "When Ember asks first" (in Apps & privacy): what the settings window shows, says to screen
 * readers and focuses for each state, as plain data. home/main.ts applies it to the page; the tests read it without a DOM.
 */
import type { VoiceMatchStatus } from "../../shared/ipc";

/** Voice Match's words. */
export const MATCH_TEXT = {
  label: "Answer questions with my voice (Voice Match)",
  none: "Ember hears anyone who talks to it. Teach it your voice, and you can answer its questions out loud (“Ember, allow”); other voices can't. “Ember, stop” works for anyone.",
  on: "On: your voice can answer Ember's questions out loud, and other voices can't. Ember still hears everyone. Your voiceprint stays on this computer.",
  off: "Off: answer Ember's questions by clicking. It keeps your voiceprint until you forget it.",
  /** enrolVoice() said no: Ember isn't listening just now (muted, starting, or not working), so it can't hear the phrases. */
  notListening: "I'm not listening just now, so I can't learn your voice. Try again once listening is on.",
  say: "Say:",
  again: { short: "That was too short. Say it again:", unlike: "That didn't sound like the others (another voice, or noise). Say it again:", failed: "I couldn't hear that clearly. Say it again:", over: "Your screen reader was still reading. Wait for it to finish, then say:" },
  teach: "Set up Voice Match",
  teachAgain: "Set up Voice Match again",
  cancel: "Cancel",
  forget: "Forget my voice",
  learnt: "Ember knows your voice now.",
  stopped: "Stopped teaching Ember your voice.",
  /** Forget my voice deletes the words learnt from what the user said too (personal/service.ts forgetVoice): said so. */
  forgot: "Ember forgot your voice and the words it learnt.",
  forgetHint: "Also forgets the words learnt from what you said.",
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
 */
export const MATCH_SAID = {
  none: "Requests from any voice are heard. Teach your voice again, and you can answer questions out loud; other voices can't.",
  on: "On: your voice can answer questions out loud, and other voices can't. Everyone is still heard. Your voiceprint stays on this computer.",
  off: "Off: answer questions by clicking. Your voiceprint is kept until you forget it.",
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

/** `matchText`'s news as a screen reader is told it (MATCH_SAID). */
function matchSaid(m: VoiceMatchStatus): string {
  if (noModel(m)) return MATCH_SAID.noModel;
  const state = !m.enrolled ? MATCH_SAID.none : m.on ? MATCH_SAID.on : MATCH_SAID.off;
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
  /** Name-free state description for controls focused while the wake microphone is open. */
  description: string;
  /** The phrase to say ("" when not enrolling). */
  prompt: string;
  progress: { value: number; max: number; text: string } | null;
  teach: { hidden: boolean; label: string };
  cancelHidden: boolean;
  forgetHidden: boolean;
  /** Where focus goes when the control that had it is hidden or disabled by this state (first shown wins). */
  focus: string[];
}

/**
 * Voice Match without its model (missing, or damaged): why it's off (a kept voiceprint isn't used meanwhile, so Ember
 * hears every voice rather than none), or why it can't be taught yet. `bytes`: the model's size, when it alone is missing.
 */
export function matchNoModelText(wanted: boolean, bytes: number | null = null): string {
  const size = bytes ? ` (${Math.max(1, Math.round(bytes / 1e6))} MB)` : "";
  return wanted
    ? `Off for now: Voice Match's model is missing or was damaged, so your voice can't answer Ember's questions. Download it above${size} to put that right.`
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

/** `speakerBytes`: Voice Match's model's size, when it alone is missing (said in the note about it). */
export function matchView(m: VoiceMatchStatus | undefined, o: { listening: boolean; managed: boolean; speakerBytes?: number | null }): MatchView {
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
    text: m ? matchText(m, o.speakerBytes ?? null) : "",
    description: e ? "Learning your voice. Wait for the spoken prompt to finish, then say the shown phrase." : m ? matchSaid(m) : "",
    prompt: e ? matchPrompt(e) : "",
    progress: e ? { value: e.got, max: e.of, text: `${e.got} of ${e.of} heard` } : null,
    teach: { hidden: busy || blocked, label: m?.enrolled ? MATCH_TEXT.teachAgain : MATCH_TEXT.teach },
    cancelHidden: !busy,
    forgetHidden: busy || !m?.enrolled,
    // Teaching: Cancel is the one button there. Otherwise Teach; with the whole group gone, the listening switch.
    focus: hidden ? ["wake"] : busy ? ["match-cancel"] : blocked ? ["voice-download", "wake"] : ["match-teach", "match-on", "wake"],
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

// ───── When Ember asks first ─────

/** The settings keys behind the two switches; admin.ts managedKeys locks each one (allowGrants false, aiReview false). */
export const TRUST_ROWS = [
  { id: "trust-apps", key: "askedApps" },
  { id: "trust-commands", key: "reviewCommands" },
] as const;
export const TRUST_TEXT = {
  heading: "When Ember asks first",
  apps: "Don't ask before working in an app I asked for help with",
  appsHint: "The app you were in when you asked, or one your request names. Ember still asks before anything hard to undo, such as sending or deleting.",
  commands: "Ask only about dangerous commands",
  commandsHint: "A command Ember would ask about is first reviewed by Copilot against your request. A routine one runs in Ember's command window, where you can stop it during its countdown. Commands that touch passwords or keys or change the system always ask.",
} as const;
/** Said (and shown as the tooltip) on a row the organisation set, as on Ember's other managed rows. */
export const MANAGED_TEXT = "Managed by your organisation";

export interface TrustRowView { id: string; checked: boolean; disabled: boolean; locked: boolean; title: string; describedBy: string }

export function trustView(trust: { askedApps: boolean; reviewCommands: boolean }, managed: ReadonlySet<string>): TrustRowView[] {
  return TRUST_ROWS.map(({ id, key }) => {
    const locked = managed.has(key);
    // aria-describedby wins over the title, so the managed note is one of the descriptions too.
    // Off while the organisation turns it off, as in force (the settings may still hold it on: safety-privacy-w5-2).
    return { id, checked: trust[key] && !locked, disabled: locked, locked, title: locked ? MANAGED_TEXT : "", describedBy: locked ? `${id}-hint trust-managed` : `${id}-hint` };
  });
}
