/**
 * Where the overlay's own parts go so they never hide the control Ember works on: the task cards' corner (and,
 * below, the status pill). Pure, so it is unit-tested.
 */

import type { Rect } from "../../shared/overlay";

/** How far the ring round a control reaches beyond the control (its 4 px inset, keylines and glow). */
export const RING_REACH = 8;

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The ring round `focus` (a control, in this overlay's coordinates) with its glow. */
export const ringOf = (focus: Rect): Rect =>
  ({ x: focus.x - RING_REACH, y: focus.y - RING_REACH, width: focus.width + RING_REACH * 2, height: focus.height + RING_REACH * 2 });

/**
 * The corner the task cards go in: their own, bottom right (`stack`, where they are there), unless the ring round
 * `focus` (a fixed chat button, a wizard's Next, in this overlay's coordinates) is under them; then the bottom left,
 * the same distance in, when the ring is clear of that (or less under it).
 */
export function cardsCorner(focus: Rect | null, stack: Rect, viewportWidth: number): "right" | "left" {
  if (!focus) return "right";
  const ring = ringOf(focus);
  const here = overlap(ring, stack);
  if (here === 0) return "right";
  const left = { ...stack, x: viewportWidth - stack.x - stack.width };
  return overlap(ring, left) < here ? "left" : "right";
}
