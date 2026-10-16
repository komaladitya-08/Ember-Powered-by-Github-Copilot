/** The desk view's wheel: one X scroll step per wheel notch, however finely a touchpad reports movement. */

import { describe, expect, it } from "vitest";
import { wheelSteps, type WheelState } from "../../app/renderer/desk/wheel";

const ev = (deltaY: number, timeStamp: number, deltaMode = 0, deltaX = 0) => ({ deltaX, deltaY, deltaMode, timeStamp });

describe("desk view wheel", () => {
  it("scrolls one step per mouse wheel notch (120 px in Chromium, 3 lines, or a page)", () => {
    const s: WheelState = { x: 0, y: 0, at: 0 };
    expect(wheelSteps(s, ev(120, 1000))).toEqual({ dx: 0, dy: 1 });
    expect(wheelSteps(s, ev(-120, 3000))).toEqual({ dx: 0, dy: -1 });
    expect(wheelSteps(s, ev(3, 5000, 1))).toEqual({ dx: 0, dy: 1 });
    expect(wheelSteps(s, ev(1, 7000, 2), 600)).toEqual({ dx: 0, dy: 6 });
    expect(wheelSteps(s, ev(0, 9000, 0, -100))).toEqual({ dx: -1, dy: 0 });
  });

  it("turns a touchpad's many small deltas into a few steps, not one per event", () => {
    const s: WheelState = { x: 0, y: 0, at: 0 };
    let steps = 0;
    for (let i = 0; i < 60; i++) steps += wheelSteps(s, ev(8, 1000 + i * 16)).dy; // a second of 8 px deltas
    expect(steps).toBe(4); // 480 px
  });

  it("forgets what is left over after a pause, so a gesture never scrolls on its own later", () => {
    const s: WheelState = { x: 0, y: 0, at: 0 };
    expect(wheelSteps(s, ev(90, 1000))).toEqual({ dx: 0, dy: 0 });
    expect(wheelSteps(s, ev(20, 2000))).toEqual({ dx: 0, dy: 0 }); // 90 forgotten
    expect(wheelSteps(s, ev(85, 2100))).toEqual({ dx: 0, dy: 1 });
  });
});
