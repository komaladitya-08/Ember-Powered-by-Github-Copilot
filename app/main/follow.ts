/**
 * Where Ember sits relative to the cursor, and the spring that gets it there.
 * Pure logic (no Electron) so it is unit-tested.
 */

import { Spring2D, type Point } from "@ember/motion";

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Ember's centre relative to the cursor tip, flipped to stay inside the work area,
 * and kept off `avoid` (Ember's own handle in the corner: it never hides behind it).
 */
export function followTarget(cursor: Point, size: number, area: Rect, avoid: Rect | null = null): Point {
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
  if (avoid && p.x + half > avoid.x && p.x - half < avoid.x + avoid.width && p.y + half > avoid.y && p.y - half < avoid.y + avoid.height) {
    // Over the handle: sit just above it instead.
    p.y = Math.max(area.y + half, avoid.y - half - 4);
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

/** Beside a control Ember works on, always on screen (inside it when the control is as wide as the screen). */
export function besideControl(r: Rect, size: number, area: Rect): Point {
  const half = size * 0.6;
  return besideRect(r, size, area, r.y + r.height / 2) ?? {
    x: Math.min(Math.max(r.x + r.width - half, area.x + half), area.x + area.width - half),
    y: Math.min(Math.max(r.y + r.height / 2, area.y + half), area.y + area.height - half),
  };
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
