/**
 * Ember's movement: the spring it uses to follow your cursor, and the arcing
 * flight it takes to a target (ported from clicky's overlay animation, MIT).
 */

import type { Point } from "./flame";

/** Where Ember rests relative to the cursor tip (below-right, out of the way). */
export const FOLLOW_OFFSET: Point = { x: 30, y: 34 };

/** Critically-damped-ish spring that trails a moving target. */
export class Spring2D {
  x: number;
  y: number;
  private vx = 0;
  private vy = 0;

  constructor(start: Point, private stiffness = 190, private damping = 24) {
    this.x = start.x;
    this.y = start.y;
  }

  step(target: Point, dt: number): Point {
    const ax = this.stiffness * (target.x - this.x) - this.damping * this.vx;
    const ay = this.stiffness * (target.y - this.y) - this.damping * this.vy;
    this.vx += ax * dt;
    this.vy += ay * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    return { x: this.x, y: this.y };
  }

  jump(p: Point): void {
    this.x = p.x;
    this.y = p.y;
    this.vx = this.vy = 0;
  }
}

export interface FlightFrame {
  x: number;
  y: number;
  /** Size pulse; peaks mid-flight. */
  scale: number;
  /** Heading in degrees (0 = up). */
  angle: number;
}

export interface Flight {
  /** Seconds. */
  duration: number;
  /** Position at linear progress 0..1 (easing is applied inside). */
  at(progress: number): FlightFrame;
}

/**
 * Quadratic-bezier arc from `from` to `to`: duration scales with distance
 * (0.6–1.4 s), the arc lifts up to 80 px, motion uses smoothstep easing.
 */
export function arcFlight(from: Point, to: Point, speed = 1): Flight {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = Math.min(Math.max(dist / 800, 0.6), 1.4) / speed;
  const arc = Math.min(dist * 0.2, 80);
  const c = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - arc };
  return {
    duration,
    at(progress) {
      const lin = Math.min(Math.max(progress, 0), 1);
      const t = lin * lin * (3 - 2 * lin);
      const u = 1 - t;
      const x = u * u * from.x + 2 * u * t * c.x + t * t * to.x;
      const y = u * u * from.y + 2 * u * t * c.y + t * t * to.y;
      const dx = 2 * u * (c.x - from.x) + 2 * t * (to.x - c.x);
      const dy = 2 * u * (c.y - from.y) + 2 * t * (to.y - c.y);
      return { x, y, scale: 1 + 0.3 * Math.sin(Math.PI * lin), angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90 };
    },
  };
}
