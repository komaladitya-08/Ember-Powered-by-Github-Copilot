/**
 * Where Ember sits relative to the cursor, and the spring that gets it there.
 * Pure logic (no Electron) so it is unit-tested.
 */

import { Spring2D, type Point } from "@ember/motion";

export interface Rect { x: number; y: number; width: number; height: number }

/** Ember's centre relative to the cursor tip, flipped to stay inside the work area. */
export function followTarget(cursor: Point, size: number, area: Rect): Point {
  const dx = size * 0.55 + 14;
  const dy = size * 0.62 + 16;
  const half = size * 0.6;
  let x = cursor.x + dx;
  let y = cursor.y + dy;
  if (x + half > area.x + area.width) x = cursor.x - dx;
  if (y + half > area.y + area.height) y = cursor.y - dy * 0.55;
  return {
    x: Math.min(Math.max(x, area.x + half), area.x + area.width - half),
    y: Math.min(Math.max(y, area.y + half), area.y + area.height - half),
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

  /** Hold Ember at a point (e.g. while it works in another window); null releases it. */
  park(at: Point | null): void {
    this.parked = at;
  }

  step(target: Point, dt: number): Point {
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
