/**
 * The companion as an option (docs/CODING-APP.md §5): which of its parts run, and what Ember opens at start, decided
 * from the settings alone. Pure (no Electron), so main asks it at start and on every settings change, and the tests
 * hold every part to it.
 *
 * The constraint behind it: off, nothing of the companion reads, hears or acts (no character, no ask box, no
 * microphone, no conversation and so no tasks in the user's apps), while Stop stays: its shortcut and "Stop
 * everything" reach coding sessions whatever the switch says. A part that holds the microphone, the screen or input is
 * stopped whole (its task is stopped as Stop stops it), never left half-running.
 */

import type { ShortcutId } from "../shared/shortcuts";

/** What `companionParts` reads of the settings. */
export interface CompanionSettings {
  companion: { enabled: boolean };
  code: { enabled: boolean };
}

/** Each part of the companion, and whether it runs. */
export interface CompanionParts {
  /** The character beside the cursor (the overlay, one window per display). */
  overlay: boolean;
  /** The handle (the pill, or the corner card without a compositor). */
  handle: boolean;
  /** The ask box and its shortcut. */
  ask: boolean;
  /** Listening for “Hey Ember”, Listen once and spoken replies. */
  voice: boolean;
  /** The conversation's Copilot session (the conductor), and with it every task and worker session. */
  conversation: boolean;
  /** The hello at start and after the welcome. */
  greeting: boolean;
  /** Saying, in the bubble and by voice, that a coding session needs the user (needs coding sessions on too). */
  codingAnnouncements: boolean;
  /** The conductor's tools over the coding sessions (needs coding sessions on too). */
  codingTools: boolean;
  /** The shortcuts Ember holds: Stop and Settings always, the ask box and mute only with the companion. */
  shortcuts: readonly ShortcutId[];
}

/** The shortcuts Ember holds whatever the companion's switch: Stop (it reaches coding sessions) and Settings. */
export const ALWAYS_EMBERS: readonly ShortcutId[] = ["stop", "settings"];

/** Whether the companion is on. */
export function companionOn(s: CompanionSettings): boolean {
  return s.companion.enabled === true;
}

/** Which of the companion's parts run for these settings. */
export function companionParts(s: CompanionSettings): CompanionParts {
  const on = companionOn(s);
  const code = s.code.enabled === true;
  return {
    overlay: on, handle: on, ask: on, voice: on, conversation: on, greeting: on,
    codingAnnouncements: on && code, codingTools: on && code,
    shortcuts: on ? ["ask", "stop", "settings", "mute"] : ALWAYS_EMBERS,
  };
}

/** What a start opens. */
export interface StartOpens { greet: boolean; ask: boolean; home: boolean; code: boolean }

/**
 * What a start opens, from what the launcher decided (`view`, launcher.ts startView). With the companion on, as
 * before: its greeting, the ask box or settings, and the coding window beside them for a start by hand while coding
 * sessions are on (`opensCodeAtStart`). With it off there is no greeting and no ask box: a start by hand opens the
 * coding window, which is then the app, or, with coding sessions off too, settings, which says what can be turned on;
 * settings opens as before wherever the launcher chose it (the welcome, a setup row). At login, nothing more.
 */
export function startOpens(o: CompanionSettings & { onboarded: boolean; atLogin: boolean; view: "settings" | "ask" | "greet" }): StartOpens {
  const byHand = o.onboarded && !o.atLogin;
  if (companionOn(o)) {
    return { greet: o.view === "greet", ask: o.view === "ask", home: o.view === "settings", code: o.code.enabled && byHand && o.view !== "ask" };
  }
  const code = o.code.enabled && byHand;
  return { greet: false, ask: false, home: o.view === "settings" || (byHand && !o.code.enabled), code };
}
