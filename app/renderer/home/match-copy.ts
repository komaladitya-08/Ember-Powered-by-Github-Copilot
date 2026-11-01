/**
 * Voice Match (in Voice) and "When Ember asks first" (in Apps & privacy): what the settings window shows, says to screen
 * readers and focuses for each state, as plain data. home/main.ts applies it to the page; the tests read it without a DOM.
 */
import type { VoiceMatchStatus } from "../../shared/ipc";

/** Voice Match's words. */
export const MATCH_TEXT = {
  label: "Answer only my voice (Voice Match)",
  none: "Ember answers anyone who says its name. Teach it your voice, and it answers only you. “Ember, stop” still works for anyone.",
  on: "On: Ember answers only your voice. Your voiceprint stays on this computer; “Ember, stop” still works for anyone.",
  off: "Off: Ember answers anyone who says its name. It keeps your voiceprint until you forget it.",
  /** enrolVoice() said no: Ember isn't listening just now (muted, starting, or not working), so it can't hear the phrases. */
  notListening: "Ember isn't listening just now, so it can't learn your voice. Try again once it's listening for “Ember”.",
  say: "Say:",
  again: { short: "That was too short. Say it again:", unlike: "That didn't sound like the others (another voice, or noise). Say it again:", failed: "Ember couldn't hear that clearly. Say it again:" },
  teach: "Teach Ember my voice",
  teachAgain: "Teach Ember my voice again",
  cancel: "Cancel",
  forget: "Forget my voice",
  learnt: "Ember knows your voice now.",
  stopped: "Stopped teaching Ember your voice.",
  forgot: "Ember forgot your voice.",
  progressLabel: "Phrases Ember has heard",
} as const;

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
  teach: { hidden: boolean; label: string };
  cancelHidden: boolean;
  forgetHidden: boolean;
  /** Where focus goes when the control that had it is hidden or disabled by this state (first shown wins). */
  focus: string[];
}

export function matchText(m: VoiceMatchStatus): string {
  if (m.enrolling) return `Say each phrase as you would ask Ember (${m.enrolling.got} of ${m.enrolling.of} heard).`;
  return !m.enrolled ? MATCH_TEXT.none : m.on ? MATCH_TEXT.on : MATCH_TEXT.off;
}

export function matchPrompt(e: NonNullable<VoiceMatchStatus["enrolling"]>): string {
  return `${e.again ? MATCH_TEXT.again[e.again] : MATCH_TEXT.say} “${e.phrase}”`;
}

export function matchView(m: VoiceMatchStatus | undefined, o: { listening: boolean; managed: boolean }): MatchView {
  const hidden = !m || o.managed || !o.listening;
  const e = m?.enrolling ?? null;
  const busy = !!e;
  return {
    hidden,
    busy,
    checked: !!m && (m.on || busy),
    disabled: busy,
    text: m ? matchText(m) : "",
    prompt: e ? matchPrompt(e) : "",
    progress: e ? { value: e.got, max: e.of, text: `${e.got} of ${e.of} heard` } : null,
    teach: { hidden: busy, label: m?.enrolled ? MATCH_TEXT.teachAgain : MATCH_TEXT.teach },
    cancelHidden: !busy,
    forgetHidden: busy || !m?.enrolled,
    // Teaching: Cancel is the one button there. Otherwise Teach; with the whole group gone, the listening switch.
    focus: hidden ? ["wake"] : busy ? ["match-cancel"] : ["match-teach", "match-on", "wake"],
  };
}

/**
 * What `#voice-live` says when Voice Match's status changes (null: nothing new). Each phrase is said as it is asked for,
 * with how many were heard, and the end says how it ended. `cancelled`: the user pressed Cancel.
 */
export function matchAnnouncement(prev: VoiceMatchStatus | undefined, m: VoiceMatchStatus | undefined, cancelled = false): string | null {
  if (!m) return null;
  const e = m.enrolling;
  if (e) {
    const p = prev?.enrolling;
    if (p && p.got === e.got && p.phrase === e.phrase && p.again === e.again) return null;
    return e.again || e.got === 0 ? matchPrompt(e) : `Heard ${e.got} of ${e.of}. ${matchPrompt(e)}`;
  }
  if (prev?.enrolling) return `${cancelled ? MATCH_TEXT.stopped : m.enrolled ? MATCH_TEXT.learnt : ""} ${matchText(m)}`.trim();
  if (prev?.enrolled && !m.enrolled) return `${MATCH_TEXT.forgot} ${matchText(m)}`;
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
    return { id, checked: trust[key], disabled: locked, locked, title: locked ? MANAGED_TEXT : "", describedBy: locked ? `${id}-hint trust-managed` : `${id}-hint` };
  });
}
