/** The task cards' stack above the handle: their order and what folds away when they don't fit (pure, so it is unit-tested). */

import type { TaskCard } from "../../shared/overlay";

/** A task still under way: its card has Stop. */
export const underWay = (t: TaskCard): boolean => t.status === "running" || t.status === "waiting";

/**
 * The cards from the top of the stack down: the tasks that ended (oldest first), then those under way, so
 * every Stop is nearest the handle and stays in view however many failures wait to be closed.
 */
export function stackOrder(tasks: readonly TaskCard[]): TaskCard[] {
  return [...tasks.filter(t => !underWay(t)), ...tasks.filter(underWay)];
}

/**
 * How many of the oldest ended cards (the first `ended` of `heights`, in stack order) fold into one "+N more"
 * line `more` px tall so the stack fits in `room` px (cards `gap` px apart). Cards under way never fold:
 * when even they don't fit, all ended cards fold and the stack scrolls.
 */
export function foldCount(heights: readonly number[], ended: number, room: number, gap: number, more: number): number {
  const height = (k: number) => {
    const shown = heights.slice(k);
    const lines = shown.length + (k > 0 ? 1 : 0);
    return shown.reduce((a, h) => a + h, 0) + (k > 0 ? more : 0) + Math.max(0, lines - 1) * gap;
  };
  const most = Math.min(ended, heights.length);
  for (let k = 0; k < most; k++) if (height(k) <= room) return k;
  return most;
}

/** The "+N more" line's words, and its Close all button's ids (the folded failures; other ended cards go by themselves). */
export function foldedLine(folded: readonly TaskCard[]): { title: string; detail: string; close: string[] } {
  const n = folded.length;
  return {
    title: `+${n} more`,
    // One line beside Close all (about 120 px).
    detail: "Ended earlier",
    close: folded.flatMap(t => (t.actions ?? []).filter(a => /:dismiss$/.test(a.id)).map(a => a.id)),
  };
}
