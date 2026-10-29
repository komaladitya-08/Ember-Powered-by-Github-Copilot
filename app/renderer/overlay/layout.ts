/**
 * Where the overlay's own parts go so they never hide the control Ember works on: the task cards' corner and the
 * status pill's place. Pure, so it is unit-tested.
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

/** The status pill's distance from the top of the screen (.status's top in styles.css). */
export const PILL_TOP = 40;
/** Room between the pill and the bottom of the work area (the taskbar or Dock) when it moves down. */
export const PILL_BOTTOM_GAP = 20;

/**
 * Where the status pill goes ("Using your keyboard: press a key or move the mouse to take over"), centred: at the
 * top, unless the ring round the control Ember types into or clicks (an address bar, a ribbon's tabs; `focus`, in
 * this overlay's coordinates) is under it there; then at the bottom, `bottom` px up, when the ring is clear of that
 * (or less under it). The user watches what Ember types, and sees that they can take over.
 */
export function pillSpot(focus: Rect | null, pill: { width: number; height: number }, viewport: { width: number; height: number }, bottom: number): "top" | "bottom" {
  if (!focus) return "top";
  const ring = ringOf(focus);
  const x = (viewport.width - pill.width) / 2;
  const top = overlap(ring, { x, y: PILL_TOP, width: pill.width, height: pill.height });
  if (top === 0) return "top";
  return overlap(ring, { x, y: viewport.height - bottom - pill.height, width: pill.width, height: pill.height }) < top ? "bottom" : "top";
}

/**
 * How far up from the bottom of the overlay (its display, `bounds`, global DIP) the pill sits when it moves down:
 * just above the work area (`workArea`, global; the taskbar or Dock is below it), else level with the handle's
 * bottom (`handle`, this overlay's coordinates), else near the bottom edge.
 */
export function pillBottom(bounds: Rect, workArea: Rect | null, handle: Rect | null): number {
  if (workArea) return bounds.y + bounds.height - (workArea.y + workArea.height) + PILL_BOTTOM_GAP;
  if (handle) return bounds.height - (handle.y + handle.height) + PILL_BOTTOM_GAP;
  return PILL_BOTTOM_GAP;
}

/**
 * Whether this overlay (display `displayId`, `bounds` in global DIP) shows Ember's bubble for frame `f`: only the
 * display Ember is on (`f.on`, main's word: the display nearest its centre) does, though every display it straddles
 * draws its body. Without main's word, the display that holds its centre. A bubble drawn on both sides of a seam
 * would show a question twice, with two sets of buttons.
 */
export function bubbleHere(f: { ember: { x: number; y: number }; on?: number }, displayId: number, bounds: Rect): boolean {
  if (f.on !== undefined) return f.on === displayId;
  return f.ember.x >= bounds.x && f.ember.x < bounds.x + bounds.width && f.ember.y >= bounds.y && f.ember.y < bounds.y + bounds.height;
}
