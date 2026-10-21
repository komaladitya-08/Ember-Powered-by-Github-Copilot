/** How long a new task card's buttons ignore presses (a pointer may be resting where the card just appeared). */
export const TASK_ARM_MS = 900;

/**
 * Question buttons are already armed by the Confirmer (and a press there is deliberate); arming them again in the
 * renderer, longer than the Confirmer does, silently dropped Allow clicks that came in between the two windows.
 */
export function armMsFor(actions: readonly { id: string }[]): number {
  return actions.some(a => a.id.startsWith("task:")) ? TASK_ARM_MS : 0;
}
