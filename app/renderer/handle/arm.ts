/** How long a new task card's buttons ignore presses (a pointer may be resting where the card just appeared). */
export const TASK_ARM_MS = 900;

/**
 * Ember's own bubble buttons that start or end work, armed as a task card's are: Try again (asks the request again)
 * and Stop (ends the turn). They come up where the pointer may already rest, under a bubble that moves with Ember.
 */
const ARMED_UI = new Set(["ui:retry", "ui:stop"]);

/** Whether a button ignores presses for TASK_ARM_MS after it appears. */
export const armed = (id: string): boolean => id.startsWith("task:") || ARMED_UI.has(id);

/**
 * Question buttons are already armed by the Confirmer (and a press there is deliberate); arming them again in the
 * renderer, longer than the Confirmer does, silently dropped Allow clicks that came in between the two windows.
 */
export function armMsFor(actions: readonly { id: string }[]): number {
  return actions.some(a => armed(a.id)) ? TASK_ARM_MS : 0;
}

/**
 * When each armed button came up (the bubble keeps its buttons across updates, so a button is new only when its id
 * wasn't shown just before), and whether a press on it counts yet.
 */
export class ArmClock {
  private since = new Map<string, number>();

  /** The buttons shown now, at `now` (ms). */
  shown(ids: readonly string[], now: number): void {
    const next = new Map<string, number>();
    for (const id of ids) if (armed(id)) next.set(id, this.since.get(id) ?? now);
    this.since = next;
  }

  /** A press on `id` at `now` counts: it isn't an armed button, or it has been up for TASK_ARM_MS. */
  ready(id: string, now: number): boolean {
    const at = this.since.get(id);
    return at === undefined || now - at >= TASK_ARM_MS;
  }
}
