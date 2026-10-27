/** The task cards' stack above the handle: their order and what folds away when they don't fit (pure, so it is unit-tested). */

import { TASK_STOPPING, type TaskCard } from "../../shared/overlay";

/** A task still under way (running, in line, or waiting for the user): its card has Stop. */
export const underWay = (t: TaskCard): boolean => t.status === "running" || t.status === "queued" || t.status === "waiting";

/** A card's state in words, for screen readers (its symbol says it to the eye): a task in line doesn't need the user. */
export const STATE_WORD: Record<TaskCard["status"], string> = {
  running: "Working: ", queued: "Waiting its turn: ", waiting: "Needs you: ", done: "Done: ", failed: "Failed: ", stopped: "Stopped: ",
};

/**
 * What the handle says while tasks run and nothing else is to be said ("Working on 2 tasks…"), so it never says
 * Ready under a card that says Working; null when no task is running or in line.
 */
export function busyLine(tasks: readonly TaskCard[]): string | null {
  const n = tasks.filter(t => t.status === "running" || t.status === "queued").length;
  return n === 0 ? null : `Working on ${n === 1 ? "1 task" : `${n} tasks`}…`;
}

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

/** How long a pressed Stop shows as stopping with no word from Ember that it is (then the press didn't land: Stop works again). */
export const STOP_ACK_MS = 3000;

/**
 * Whether a card whose Stop was pressed at `pressedAt` still shows as stopping (its detail "Stopping…", its Stop
 * taking no second press): while Ember says it is stopping (`detail`), and for a few seconds before it has said so.
 */
export function stopPending(pressedAt: number, now: number, detail: string): boolean {
  return detail === TASK_STOPPING || now - pressedAt < STOP_ACK_MS;
}

/**
 * How far each card moved between two layouts (`before` and `after`: each card's top edge by id), so it slides from
 * where it was instead of jumping there (a task that ended goes to the top of the stack). A new card fades in
 * instead, and one that barely moved (under a pixel) stays put.
 */
export function slides(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, top] of after) {
    const was = before.get(id);
    if (was !== undefined && Math.abs(was - top) >= 1) out.set(id, was - top);
  }
  return out;
}
