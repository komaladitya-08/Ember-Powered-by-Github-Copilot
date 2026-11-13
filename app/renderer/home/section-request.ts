/**
 * Which section of the settings window main asked for, and the control in it to focus: "computers" (its heading), or
 * "computers:host" / "computers:wsl" (the field to add a computer, the WSL switch), "conversation:latest" (the newest
 * answer), "conversation:stop" (Stop response, while the bubble says Ember is still waiting), "access:ask" / "access:stop" (Ask
 * Ember… and Stop everything, the keyboard's way to them while another app holds their shortcut). A section can still
 * be hidden when the request comes (Computers shows only once the computers list and the status have both arrived,
 * after the page has loaded): the request then waits until it shows, unless the user has moved on first. Pure and
 * renderer-safe.
 */

/**
 * Not an element's id: the newest answer's row in the conversation ("Read the last answer", the bubble's "Open
 * conversation": main asks for "conversation:latest", home-v1), which Home finds when the request comes.
 */
export const LATEST_ANSWER = "latest-answer";

/** The controls a request may focus, by the name main uses (main's openSettings). */
const CONTROLS: Readonly<Record<string, string>> = {
  "conversation:latest": LATEST_ANSWER, "conversation:message": "conversation-message", "conversation:stop": "conversation-stop",
  "computers:host": "host-add", "computers:wsl": "wsl-on", "access:ask": "p-ask", "access:stop": "p-stop",
  // "Work without asking" by voice (autonomy-intent.ts): Interactive's row in How Ember asks, or its card's agree button
  // (the card shown first).
  "privacy:autonomy-on": "mode-interactive", "privacy:autonomy-yes": "approvals-yes",
  // Memory: its search for a forget request, its note's words for "get to know me" or Open Memory, never the note's
  // "I agree, remember", where a stray Enter or Space would agree; asked for by that name, the words (memory-r7).
  "memory:memory-query": "memory-query", "memory:memory-consent-text": "memory-consent-text", "memory:memory-yes": "memory-consent-text",
  // Tell Ember about you's first question: "get to know me" in a voice Ember couldn't check opens the typed way (memory-r9-6).
  "memory:about-you": "ay-name",
  // Ask's “Set up voice in Settings…”: its Download, in view (home-r9-7); while no model is missing it is hidden, and the
  // request lands on the heading.
  "voice:voice-download": "voice-download",
};

/** A request as the page acts on it: the section's id (its heading is `${section}-h`) and the control's id, if any. */
export interface SectionRequest {
  section: string;
  control: string | null;
}

/**
 * Requests whose control lives in another section than the name main uses: Ask Ember… and Stop everything moved to
 * Home's status panel (main's keyboardRoute still says "access:ask" and "access:stop").
 */
const SECTIONS: Readonly<Record<string, string>> = { "access:ask": "home", "access:stop": "home" };

/** Reads a request ("computers", "computers:host"); an unknown control falls back to the section's heading. */
export function sectionRequest(value: string): SectionRequest {
  const [section] = value.split(":");
  return { section: SECTIONS[value] ?? section, control: CONTROLS[value] ?? null };
}

/** The request that waits for its section to show; at most one, the latest. */
export class PendingSection {
  private value: string | null = null;

  /** Waits with `value` (a section still hidden). */
  hold(value: string): void {
    this.value = value;
  }

  /** The user did something (a click, a key, a scroll) or another section was shown: nothing waits any more. */
  drop(): void {
    this.value = null;
  }

  /** The waiting request once its section shows (`shown` says whether a section is shown now), taken; else null. */
  take(shown: (section: string) => boolean): string | null {
    if (this.value === null || !shown(sectionRequest(this.value).section)) return null;
    const v = this.value;
    this.value = null;
    return v;
  }

  get waiting(): boolean {
    return this.value !== null;
  }
}
