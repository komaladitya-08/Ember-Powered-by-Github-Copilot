/**
 * Whether Ember speaks out loud: one choice of three (review #55, WCAG 1.4.2 audio control). "reader", the default,
 * speaks while a screen reader runs (Orca, Narrator, VoiceOver) and not otherwise; "always"; or "never", which wins
 * over a screen reader too (a braille display's user, or one who wants the reader's voice alone). Stored as two
 * settings, `speak` and `speakWithScreenReader`, so a settings file from before reads as it was meant. Pure: main
 * decides with it, and the settings window shows and sets it.
 */

/** The settings window's choice. */
export type SpeakChoice = "reader" | "always" | "never";

/** The two settings that hold it. */
export interface SpeakSettings {
  speak: boolean;
  speakWithScreenReader: boolean;
}

export function speakChoice(s: SpeakSettings): SpeakChoice {
  return s.speak ? "always" : s.speakWithScreenReader ? "reader" : "never";
}

export function speakSettings(choice: SpeakChoice): SpeakSettings {
  return { speak: choice === "always", speakWithScreenReader: choice !== "never" };
}

/** Does Ember speak now? `screenReaderOn` is asked only when it decides. */
export function speaksAloud(s: SpeakSettings, screenReaderOn: () => boolean): boolean {
  return s.speak || (s.speakWithScreenReader && screenReaderOn());
}
