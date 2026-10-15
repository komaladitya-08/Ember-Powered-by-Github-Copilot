import { describe, it, expect } from "vitest";
import { followTarget, Follower, contains } from "../../app/main/follow";

const area = { x: 0, y: 0, width: 1280, height: 800 };

describe("followTarget", () => {
  it("sits below-right of the cursor", () => {
    const t = followTarget({ x: 400, y: 300 }, 60, area);
    expect(t.x).toBeGreaterThan(400);
    expect(t.y).toBeGreaterThan(300);
  });

  it("flips to the left near the right edge and above near the bottom", () => {
    const t = followTarget({ x: 1270, y: 790 }, 60, area);
    expect(t.x).toBeLessThan(1270);
    expect(t.y).toBeLessThan(790);
  });

  it("stays inside the work area on other displays", () => {
    const second = { x: 1280, y: 0, width: 1920, height: 1080 };
    const t = followTarget({ x: 1285, y: 2 }, 80, second);
    expect(contains(second, t)).toBe(true);
  });
});

describe("Follower", () => {
  const settle = (f: Follower, target: { x: number; y: number }) => {
    let p = f.position;
    for (let i = 0; i < 120; i++) p = f.step(target, 1 / 60);
    return p;
  };

  it("catches up with its target", () => {
    const p = settle(new Follower({ x: 0, y: 0 }), { x: 300, y: 200 });
    expect(p.x).toBeCloseTo(300, 0);
    expect(p.y).toBeCloseTo(200, 0);
  });

  it("holds its place while parked and when paused", () => {
    const f = new Follower({ x: 100, y: 100 });
    f.park({ x: 100, y: 100 });
    expect(settle(f, { x: 900, y: 700 })).toMatchObject({ x: 100, y: 100 });
    f.park(null);
    f.setPaused(true);
    expect(settle(f, { x: 900, y: 700 }).x).toBeCloseTo(100, 0);
  });
});
