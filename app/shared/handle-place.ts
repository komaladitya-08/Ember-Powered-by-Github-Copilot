/**
 * Where Ember's handle sits (Settings › Comfort & access › Handle position, review #75): the bottom-right corner of the
 * primary display's work area (the default, where it has always been) or the bottom-left one, inside the taskbar, the
 * Dock or the panel on every OS. Shared by the handle's window (main), the overlay's task cards, the desk view and the
 * settings window, so they can't disagree about the side; pure and Electron-free, so it is unit-tested and loads in
 * every renderer.
 */

/** The handle's corners, as settings.json stores them. */
export const HANDLE_POSITIONS = ["bottom-right", "bottom-left"] as const;
export type HandlePosition = (typeof HANDLE_POSITIONS)[number];

/** The side of the screen the handle is on (its task cards stack above it, on the same side). */
export type HandleSide = "right" | "left";

/** How far the handle's window sits in from the work area's edges. */
export const HANDLE_MARGIN = 12;

/** The side `p` names; anything else (settings from before the setting) is the right, where the handle always was. */
export function sideOf(p: HandlePosition | undefined): HandleSide {
  return p === "bottom-left" ? "left" : "right";
}

/** The position the handle menu's "Move to the other side" sets. */
export function otherSide(p: HandlePosition | undefined): HandlePosition {
  return sideOf(p) === "left" ? "bottom-right" : "bottom-left";
}

/**
 * The top-left corner (global DIP) of a window of `size` in the handle's corner of `workArea`: `margin` px in from the
 * work area's bottom edge and from its right or left edge, so a taskbar, Dock or panel on any side never covers it.
 */
export function handleCorner(p: HandlePosition | undefined, size: { width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number }, margin = HANDLE_MARGIN): { x: number; y: number } {
  const x = sideOf(p) === "left" ? workArea.x + margin : workArea.x + workArea.width - size.width - margin;
  return { x, y: workArea.y + workArea.height - size.height - margin };
}
