/** How often Home draws its characters (app/renderer/home/frame-gap.ts). */

import { describe, expect, it } from "vitest";
import { homeFrameGap } from "../../app/renderer/home/frame-gap";

describe("Home's frame gap", () => {
  it("draws as before in the window the user is working in: every frame, ~30 fps, ~15 fps (rp-4)", () => {
    expect([0, 1, 2].map(m => homeFrameGap(m as 0 | 1 | 2, true))).toEqual([0, 33, 66]);
  });

  it("draws a still face no more while Home sits behind other windows, and moving ones less often, as before (rp-4)", () => {
    expect(homeFrameGap(2, false)).toBeNull();
    expect(homeFrameGap(1, false)).toBe(66);
    expect(homeFrameGap(0, false)).toBe(33);
  });
});
