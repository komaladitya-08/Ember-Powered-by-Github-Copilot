/**
 * Wheel movement → X scroll steps: one step per notch of a mouse wheel (about 100 px, or 3 lines),
 * however finely a touchpad reports it (dozens of small deltas a second). What is left over is
 * forgotten after a pause, so the next gesture starts afresh.
 */

export const STEP_PX = 100;
const LINE_PX = STEP_PX / 3;
const PAUSE_MS = 400;

export interface WheelState { x: number; y: number; at: number }

/** Adds one wheel event; returns the whole steps it completes on each axis (signed: + is right or down). */
export function wheelSteps(s: WheelState, e: { deltaX: number; deltaY: number; deltaMode: number; timeStamp: number }, pagePx = 600): { dx: number; dy: number } {
  if (e.timeStamp - s.at > PAUSE_MS) { s.x = 0; s.y = 0; }
  s.at = e.timeStamp;
  // deltaMode: 0 pixels, 1 lines, 2 pages.
  const px = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pagePx : 1;
  s.x += e.deltaX * px;
  s.y += e.deltaY * px;
  const dx = Math.trunc(s.x / STEP_PX), dy = Math.trunc(s.y / STEP_PX);
  s.x -= dx * STEP_PX;
  s.y -= dy * STEP_PX;
  return { dx, dy };
}
