import { describe, it, expect } from "vitest";
import { arcFlight, criticalDamping, Spring2D } from "./motion";

describe("arcFlight", () => {
  it("starts and ends at the given points and arcs upward", () => {
    const f = arcFlight({ x: 0, y: 100 }, { x: 400, y: 100 });
    expect(f.at(0)).toMatchObject({ x: 0, y: 100 });
    const end = f.at(1);
    expect(end.x).toBeCloseTo(400);
    expect(end.y).toBeCloseTo(100);
    expect(f.at(0.5).y).toBeLessThan(100);
  });

  it("clamps duration between 0.6 and 1.4 s", () => {
    expect(arcFlight({ x: 0, y: 0 }, { x: 10, y: 0 }).duration).toBeCloseTo(0.6);
    expect(arcFlight({ x: 0, y: 0 }, { x: 5000, y: 0 }).duration).toBeCloseTo(1.4);
  });
});

describe("Spring2D", () => {
  it("converges on its target", () => {
    const s = new Spring2D({ x: 0, y: 0 });
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 120; i++) p = s.step({ x: 100, y: 50 }, 1 / 60);
    expect(p.x).toBeCloseTo(100, 0);
    expect(p.y).toBeCloseTo(50, 0);
  });

  const overshoot = (s: Spring2D) => {
    let max = 0;
    for (let i = 0; i < 240; i++) max = Math.max(max, s.step({ x: 100, y: 0 }, 1 / 60).x);
    return max - 100;
  };

  it("settles without overshoot when critically damped (reduced motion), and can switch back", () => {
    const wobbly = () => new Spring2D({ x: 0, y: 0 }, 200, 8);
    expect(overshoot(wobbly())).toBeGreaterThan(10);
    const calm = wobbly();
    calm.setCriticallyDamped(true);
    expect(overshoot(calm)).toBeLessThanOrEqual(0.01);
    const back = wobbly();
    back.setCriticallyDamped(true);
    back.setCriticallyDamped(false);
    expect(overshoot(back)).toBeGreaterThan(10);
    expect(criticalDamping(150)).toBeCloseTo(24.49, 1);
  });
});
