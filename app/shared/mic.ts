/**
 * The microphone as the handle shows it: a badge on Ember's face whose shape says the state as well as its colour
 * (never colour alone: orange and red are close for many people), its words for the tooltip and screen readers, what
 * the handle says instead of "Ready" when listening can't work, and the handle menu's way to fix a problem. Pure, so
 * the handle page and main share one set of words; handle-mic.test.ts pins them.
 */

import type { MicState } from "./voice";

/** The badge's shapes: a microphone (listening), a struck-out one (not listening), Ember's working ring, a problem. */
export type MicGlyph = "mic" | "mic-off" | "working" | "problem";

export interface MicBadge {
  glyph: MicGlyph;
  /** The tooltip and the accessible name. */
  label: string;
}

const BADGES: Readonly<Record<Exclude<MicState, "off">, MicBadge>> = {
  waiting: { glyph: "mic", label: "Listening for “Hey Ember”" },
  active: { glyph: "mic", label: "Hearing you" },
  muted: { glyph: "mic-off", label: "Microphone off" },
  "needs-models": { glyph: "mic-off", label: "Voice isn't set up: download the speech models in Settings" },
  downloading: { glyph: "working", label: "Downloading speech models…" },
  starting: { glyph: "working", label: "Starting to listen…" },
  error: { glyph: "problem", label: "Microphone problem" },
};

/** The badge for a microphone state, or null while listening is off (or the state is unknown). */
export function micBadge(state: MicState | undefined): MicBadge | null {
  if (!state || state === "off") return null;
  return BADGES[state] ?? null;
}

/** Short words for a state the user must know about: the handle's line, and what is said when it starts. */
const NEWS: Partial<Record<MicState, string>> = { error: "Microphone problem", "needs-models": "Voice isn't set up", muted: "Microphone off" };

/**
 * What the handle says when nothing else is going on: why Ember can't answer comes first ("Not connected"), then a
 * microphone that can't hear "Hey Ember", then "Ready". A muted microphone is the user's own choice: the badge says it.
 */
export function idleLine(idle: string | undefined, mic: MicState | undefined): string {
  if (idle && idle !== "Ready") return idle;
  if (mic === "error" || mic === "needs-models") return NEWS[mic]!;
  return idle ?? "Ready";
}

/**
 * Words to say once when the microphone changes to a state the user must know about (a problem, voice not set up,
 * muted); null for the others, so nothing is said each time they talk to Ember.
 */
export function micAnnouncement(state: MicState | undefined): string | null {
  return (state && NEWS[state]) ?? null;
}

/** The handle menu's item while the microphone has a problem: it opens Settings at Voice. */
export const MIC_PROBLEM_MENU = "Microphone problem: open Settings…";
