/**
 * A clock that steps back (VM time sync after resume, an NTP step) or a frame time that isn't a number never throws
 * Ember off screen (review #88): Follower.step takes a step's time only within 0 to 50 ms, and the overlay's tick
 * measures it on a monotonic clock.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Follower } from "../../app/main/follow";

describe("Ember's motion when the clock steps back (review #88)", () => {
  it("a negative step after a cursor flick leaves Ember where it was, then it goes on as usual", () => {
    const f = new Follower({ x: 400, y: 400 });
    for (let i = 0; i < 100; i++) f.step({ x: 700, y: 500 }, 0.016);
    f.step({ x: 1200, y: 900 }, 0.016);
    const before = { ...f.step({ x: 1200, y: 900 }, 0.016) };
    const p = f.step({ x: 1200, y: 900 }, -3);
    expect(p.x).toBeCloseTo(before.x, 6);
    expect(p.y).toBeCloseTo(before.y, 6);
    let q = p;
    for (let i = 0; i < 200; i++) {
      q = f.step({ x: 1200, y: 900 }, 0.016);
      expect(Math.abs(q.x)).toBeLessThan(2000);
      expect(Math.abs(q.y)).toBeLessThan(2000);
    }
    expect(Math.abs(q.x - 1200)).toBeLessThan(5);
  });

  it("a frame time that isn't a number moves nothing", () => {
    const f = new Follower({ x: 100, y: 100 });
    for (let i = 0; i < 5; i++) f.step({ x: 900, y: 600 }, 0.016);
    const before = { ...f.step({ x: 900, y: 600 }, 0.016) };
    const p = f.step({ x: 900, y: 600 }, Number.NaN);
    expect([p.x, p.y]).toEqual([before.x, before.y]);
    expect(Number.isFinite(f.step({ x: 900, y: 600 }, 0.016).x)).toBe(true);
  });

  it("the overlay measures a frame's time on a monotonic clock, not the wall clock", () => {
    const src = fs.readFileSync(path.resolve("app/main/overlay.ts"), "utf8");
    const tick = /private tick\(\): void \{([\s\S]*?)\n {2}\}/.exec(src)![1];
    expect(tick).toMatch(/const dt = \(mono - this\.last\) \/ 1000;/);
    expect(tick).toMatch(/const mono = performance\.now\(\);/);
  });
});
