/**
 * Where the overlay's own parts go so they never hide the control Ember works on: the task cards' corner (the
 * handle's, bottom right or bottom left) and the status pill's place. Pure, so it is unit-tested.
 */

import type { Rect } from "../../shared/overlay";
import { sideOf, type HandlePosition, type HandleSide } from "../../shared/handle-place";

/** How far the ring round a control reaches beyond the control (its 4 px inset, keylines and glow). */
export const RING_REACH = 8;

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The ring round `focus` (a control, in this overlay's coordinates) with its glow. */
export const ringOf = (focus: Rect): Rect =>
  ({ x: focus.x - RING_REACH, y: focus.y - RING_REACH, width: focus.width + RING_REACH * 2, height: focus.height + RING_REACH * 2 });

/**
 * The corner the task cards go in: their own, the handle's (`home`: bottom right, or bottom left with Handle position;
 * `stack`, where they are there), unless the ring round `focus` (a fixed chat button, a wizard's Next, in this
 * overlay's coordinates) is under them; then the other bottom corner, the same distance in, when the ring is clear of
 * that (or less under it).
 */
export function cardsCorner(focus: Rect | null, stack: Rect, viewportWidth: number, home: HandleSide = "right"): HandleSide {
  if (!focus) return home;
  const ring = ringOf(focus);
  const here = overlap(ring, stack);
  if (here === 0) return home;
  const mirrored = { ...stack, x: viewportWidth - stack.x - stack.width };
  return overlap(ring, mirrored) < here ? (home === "left" ? "right" : "left") : home;
}

/**
 * The side the task cards belong on: the handle's, from where its pill is in this overlay (`handle`, this overlay's
 * coordinates), else (the handle is on another display) from Handle position. The pill's place wins: it is where the
 * handle is now, and the setting can arrive before the handle has moved.
 */
export function handleSide(handle: Rect | null, viewportWidth: number, position: HandlePosition | undefined): HandleSide {
  if (handle) return handle.x + handle.width / 2 < viewportWidth / 2 ? "left" : "right";
  return sideOf(position);
}

/**
 * Where the task cards' stack sits on its side: `inset` px in from that edge, lined up with the handle's pill as it
 * shows (its outer edge, `pillInset` inside its window; the other corner takes the same distance in), and `bottom` px
 * up, `gap` above the pill. Without the handle on this display: 12 px in and 80 up.
 */
export function stackPlace(handle: Rect | null, viewport: { width: number; height: number }, pillInset = 4, gap = 8): { inset: number; bottom: number } {
  if (!handle) return { inset: 12, bottom: 80 };
  const inset = handleSide(handle, viewport.width, undefined) === "left" ? handle.x + pillInset : viewport.width - (handle.x + handle.width - pillInset);
  return { inset: Math.max(8, inset), bottom: Math.max(8, viewport.height - (handle.y + pillInset) + gap) };
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
