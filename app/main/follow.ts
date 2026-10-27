/**
 * Where Ember sits relative to the cursor, and the spring that gets it there.
 * Pure logic (no Electron) so it is unit-tested.
 */

import { Spring2D, type Point } from "@ember/motion";

export interface Rect { x: number; y: number; width: number; height: number }

/** What Ember keeps off, as a list: none, one area, or several apart (its handle, and the task cards in another corner). */
const areasOf = (avoid: Rect | readonly Rect[] | null): readonly Rect[] => (avoid === null ? [] : "width" in avoid ? [avoid] : avoid);

/**
 * Ember's centre relative to the cursor tip, flipped to stay inside the work area,
 * and kept off `avoid` (Ember's own handle in the corner, and the task cards: it never hides behind them).
 */
export function followTarget(cursor: Point, size: number, area: Rect, avoid: Rect | readonly Rect[] | null = null): Point {
  const dx = size * 0.55 + 14;
  const dy = size * 0.62 + 16;
  const half = size * 0.6;
  let x = cursor.x + dx;
  let y = cursor.y + dy;
  if (x + half > area.x + area.width) x = cursor.x - dx;
  if (y + half > area.y + area.height) y = cursor.y - dy * 0.55;
  const p = {
    x: Math.min(Math.max(x, area.x + half), area.x + area.width - half),
    y: Math.min(Math.max(y, area.y + half), area.y + area.height - half),
  };
  // Over the handle (or cards): sit just above it instead, and above the next if that puts it over another.
  const areas = areasOf(avoid);
  for (let i = 0; i < areas.length; i++) {
    const r = areas.find(a => p.x + half > a.x && p.x - half < a.x + a.width && p.y + half > a.y && p.y - half < a.y + a.height);
    if (!r) break;
    p.y = Math.max(area.y + half, r.y - half - 4);
  }
  return p;
}

/**
 * A spot for Ember just beside `r` (right if there is room, else left), at height `y`, inside the
 * work area; null when neither side has room (a window filling the screen).
 */
export function besideRect(r: Rect, size: number, area: Rect, y: number, gap = 10): Point | null {
  const half = size * 0.6;
  const cy = Math.min(Math.max(y, area.y + half), area.y + area.height - half);
  const right = r.x + r.width + gap + half;
  if (right + half <= area.x + area.width) return { x: right, y: cy };
  const left = r.x - gap - half;
  if (left - half >= area.x) return { x: left, y: cy };
  return null;
}

/** Ember's body (`half` each way round `p`) overlaps `r`. */
export const overlapsBody = (p: Point, half: number, r: Rect): boolean =>
  p.x + half > r.x && p.x - half < r.x + r.width && p.y + half > r.y && p.y - half < r.y + r.height;

/**
 * Beside a control Ember works on, always on screen (inside it when the control is as wide as the screen). Where
 * that spot is under `avoid` (its handle and the task cards), the other side, or above or below the control, if one
 * of those is clear: it never parks under the card of the very task it works for.
 */
export function besideControl(r: Rect, size: number, area: Rect, avoid: Rect | readonly Rect[] | null = null): Point {
  const half = size * 0.6;
  const cy = Math.min(Math.max(r.y + r.height / 2, area.y + half), area.y + area.height - half);
  const cx = Math.min(Math.max(r.x + r.width - half, area.x + half), area.x + area.width - half);
  const spot = besideRect(r, size, area, r.y + r.height / 2) ?? { x: cx, y: cy };
  const clear = (p: Point) => !areasOf(avoid).some(a => overlapsBody(p, half, a));
  if (clear(spot)) return spot;
  const gap = 10;
  const onScreen = (p: Point) => p.x - half >= area.x && p.x + half <= area.x + area.width && p.y - half >= area.y && p.y + half <= area.y + area.height;
  const spots = [
    { x: r.x + r.width + gap + half, y: cy }, { x: r.x - gap - half, y: cy },
    { x: cx, y: r.y - gap - half }, { x: cx, y: r.y + r.height + gap + half },
  ];
  return spots.find(p => onScreen(p) && clear(p)) ?? spot;
}

export class Follower {
  private spring: Spring2D;
  private paused = false;
  private parked: Point | null = null;

  constructor(start: Point) {
    this.spring = new Spring2D(start, 150, 21);
  }

  get position(): Point {
    return { x: this.spring.x, y: this.spring.y };
  }

  setPaused(on: boolean): void {
    this.paused = on;
  }

  /** Calm mode: no overshoot on the way to the cursor. */
  setReducedMotion(on: boolean): void {
    this.spring.setCriticallyDamped(on);
  }

  /** Hold Ember at a point (e.g. while it works in another window); null releases it. */
  park(at: Point | null): void {
    this.parked = at;
  }

  /** `force`: go to the target even when parked or paused (stepping out of the way of a window). */
  step(target: Point, dt: number, force = false): Point {
    if (force) return this.spring.step(target, Math.min(dt, 0.05));
    if (this.paused && !this.parked) return this.position;
    return this.spring.step(this.parked ?? target, Math.min(dt, 0.05));
  }

  jump(p: Point): void {
    this.spring.jump(p);
  }
}

export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/**
 * Whether an overlay takes the pointer (hover-to-interact): `now`, whether it does already; `at`, the pointer on its
 * display (null: elsewhere); `buttons`, the mouse buttons held. While one is held nothing changes, so a press that
 * began on a button is released on it (and one that began on the app below, there). Once it takes the pointer, a few
 * pixels around its clickable parts still count: a button that shifts a little (a re-layout, Ember settling) doesn't
 * let a click fall through to the app beneath.
 */
export function takesPointer(now: boolean, at: Point | null, rects: readonly Rect[], buttons = 0, pad = 6): boolean {
  if (buttons) return now;
  if (!at) return false;
  const m = now ? pad : 0;
  return rects.some(r => contains({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m }, at));
}

/**
 * Overlay clickable parts as X ShapeInput rectangles (physical pixels). Empty when there is
 * nothing to click: the window then lets every press through.
 */
export function shapeRects(rects: readonly Rect[], scale = 1): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const x = Math.round(r.x * scale);
    const y = Math.round(r.y * scale);
    const width = Math.round(r.width * scale);
    const height = Math.round(r.height * scale);
    if (width > 0 && height > 0) out.push({ x, y, width, height });
  }
  return out;
}
