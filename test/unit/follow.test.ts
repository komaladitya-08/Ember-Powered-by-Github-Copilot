import { describe, it, expect } from "vitest";
import { followTarget, Follower, contains, besideRect, besideControl, takesPointer } from "../../app/main/follow";

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

describe("Ember keeps off its own handle", () => {
  it("sits just above the handle instead of behind it in the corner", () => {
    const area = { x: 0, y: 0, width: 1280, height: 800 };
    const handle = { x: 1068, y: 732, width: 200, height: 56 };
    const p = followTarget({ x: 1150, y: 760 }, 60, area, handle);
    expect(p.y + 36).toBeLessThanOrEqual(handle.y);
    expect(followTarget({ x: 300, y: 300 }, 60, area, handle)).toEqual(followTarget({ x: 300, y: 300 }, 60, area));
  });
});

describe("Ember steps beside things, never off screen", () => {
  const area = { x: 0, y: 0, width: 1280, height: 800 };
  it("waits to the right of a window, or to the left when the right has no room", () => {
    expect(besideRect({ x: 100, y: 100, width: 600, height: 500 }, 60, area, 190)).toEqual({ x: 100 + 600 + 10 + 36, y: 190 });
    const left = besideRect({ x: 500, y: 100, width: 760, height: 500 }, 60, area, 190)!;
    expect(left.x).toBe(500 - 10 - 36);
  });
  it("has no spot beside a window that fills the screen", () => {
    expect(besideRect({ x: 0, y: 0, width: 1280, height: 800 }, 60, area, 90)).toBeNull();
  });
  it("parks beside a control at the right edge on its left, and inside the screen for a full-width one", () => {
    const menu = besideControl({ x: 1240, y: 4, width: 36, height: 30 }, 60, area);
    expect(menu.x + 36).toBeLessThanOrEqual(1280);
    expect(menu.x).toBeLessThan(1240);
    const bar = besideControl({ x: 0, y: 760, width: 1280, height: 40 }, 60, area);
    expect(bar.x).toBeGreaterThanOrEqual(36);
    expect(bar.x + 36).toBeLessThanOrEqual(1280);
    expect(bar.y + 36).toBeLessThanOrEqual(800);
  });
  it("goes to a forced target even while parked", () => {
    const f = new Follower({ x: 0, y: 0 });
    f.park({ x: 0, y: 0 });
    for (let i = 0; i < 200; i++) f.step({ x: 300, y: 300 }, 0.016, true);
    expect(f.position.x).toBeCloseTo(300, 0);
  });
});

describe("the overlay takes the pointer over its buttons (live test: Allow ignored the first click)", () => {
  const allow = [{ x: 100, y: 100, width: 60, height: 24 }];
  it("over a button it takes it; elsewhere, or on another display, it lets clicks through", () => {
    expect(takesPointer(false, { x: 110, y: 110 }, allow)).toBe(true);
    expect(takesPointer(false, { x: 98, y: 110 }, allow)).toBe(false);
    expect(takesPointer(true, null, allow)).toBe(false);
  });
  it("once it takes it, a button that shifts a few pixels keeps it; far away it lets go", () => {
    expect(takesPointer(true, { x: 96, y: 98 }, allow)).toBe(true);
    expect(takesPointer(true, { x: 80, y: 110 }, allow)).toBe(false);
  });
  it("nothing changes while a mouse button is held: a press on Allow is released on Allow", () => {
    // Pressed on the button, the button moved away under the pointer: still Ember's until the release.
    expect(takesPointer(true, { x: 300, y: 300 }, allow, 256)).toBe(true);
    // Pressed in the app below, dragged over the bubble: still the app's.
    expect(takesPointer(false, { x: 110, y: 110 }, allow, 256)).toBe(false);
  });
});
