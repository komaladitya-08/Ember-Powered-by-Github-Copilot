/**
 * Which section of the settings window main asked for, and the control in it to focus: "computers" (its heading), or
 * "computers:host" / "computers:wsl" (the field to add a computer, the WSL switch). A section can still be hidden when
 * the request comes (Computers shows only once the computers list and the status have both arrived, after the page has
 * loaded): the request then waits until it shows, unless the user has moved on first. Pure and renderer-safe.
 */

/** The controls a request may focus, by the name main uses (main's openSettings). */
const CONTROLS: Readonly<Record<string, string>> = { "computers:host": "host-add", "computers:wsl": "wsl-on" };

/** A request as the page acts on it: the section's id (its heading is `${section}-h`) and the control's id, if any. */
export interface SectionRequest {
  section: string;
  control: string | null;
}

/** Reads a request ("computers", "computers:host"); an unknown control falls back to the section's heading. */
export function sectionRequest(value: string): SectionRequest {
  const [section] = value.split(":");
  return { section, control: CONTROLS[value] ?? null };
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
