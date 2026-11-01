/**
 * Screen units on Windows (pure): captures clip to the virtual desktop without X11's clip at 0 (monitors left of or
 * above the primary have negative coordinates), and physical pixels convert to DIP through Electron's per-monitor
 * conversion when it is there, else approximately by the primary display's scale factor.
 */

import { describe, expect, it } from "vitest";
import type { Rect, ScreenLike } from "../../app/main/platform/types";
import { clipToScreen, pointToDip, rectToDip } from "../../app/main/platform/win32/units";

const display = (bounds: Rect, scaleFactor: number) => ({ bounds, scaleFactor });

describe("clipping a capture to the virtual desktop", () => {
  const screen = { x: -1920, y: -200, width: 3840, height: 1280 };

  it("keeps negative coordinates on a monitor left of or above the primary", () => {
    expect(clipToScreen(-1800, -150, 400, 300, screen)).toEqual({ x: -1800, y: -150, width: 400, height: 300 });
  });

  it("clips what reaches past the edges, floors like X11, and gives null for nothing on screen", () => {
    expect(clipToScreen(-2000, -300, 200, 200, screen)).toEqual({ x: -1920, y: -200, width: 120, height: 100 });
    expect(clipToScreen(1800, 1000, 500, 500, screen)).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
    expect(clipToScreen(10.7, 20.2, 100.6, 50.5, screen)).toEqual({ x: 10, y: 20, width: 101, height: 50 });
    expect(clipToScreen(1920, 0, 100, 100, screen)).toBeNull();
    expect(clipToScreen(0, 0, 0, 100, screen)).toBeNull();
    expect(clipToScreen(0, 0, 100, -5, screen)).toBeNull();
    expect(clipToScreen(0, 0, Number.NaN, 5, screen)).toBeNull();
  });
});

describe("physical pixels to DIP", () => {
  it("uses Electron's per-monitor conversion when it has one", () => {
    const screen: ScreenLike = {
      getPrimaryDisplay: () => display({ x: 0, y: 0, width: 1280, height: 720 }, 1.5),
      getAllDisplays: () => [display({ x: 0, y: 0, width: 1280, height: 720 }, 1.5)],
      screenToDipRect: (_w, r) => ({ x: r.x - 1, y: r.y - 2, width: r.width, height: r.height }),
      screenToDipPoint: p => ({ x: p.x + 1, y: p.y + 2 }),
    };
    expect(rectToDip({ x: 10, y: 20, width: 30, height: 40 }, screen)).toEqual({ x: 9, y: 18, width: 30, height: 40 });
    expect(pointToDip({ x: 10, y: 20 }, screen)).toEqual({ x: 11, y: 22 });
  });

  it("divides by the primary display's scale factor without it, or when it throws", () => {
    const plain: ScreenLike = {
      getPrimaryDisplay: () => display({ x: 0, y: 0, width: 1280, height: 720 }, 2),
      getAllDisplays: () => [],
    };
    expect(rectToDip({ x: 100, y: 50, width: 200, height: 20 }, plain)).toEqual({ x: 50, y: 25, width: 100, height: 10 });
    expect(pointToDip({ x: -300, y: 40 }, plain)).toEqual({ x: -150, y: 20 });
    const throwing: ScreenLike = {
      ...plain,
      screenToDipRect: () => { throw new Error("no displays"); },
      screenToDipPoint: () => { throw new Error("no displays"); },
    };
    expect(rectToDip({ x: 100, y: 50, width: 200, height: 20 }, throwing)).toEqual({ x: 50, y: 25, width: 100, height: 10 });
    expect(pointToDip({ x: 100, y: 50 }, throwing)).toEqual({ x: 50, y: 25 });
  });

  it("treats pixels as DIP when the scale factor is missing or nonsense", () => {
    for (const scaleFactor of [0, Number.NaN, -1]) {
      const odd: ScreenLike = { getPrimaryDisplay: () => display({ x: 0, y: 0, width: 1, height: 1 }, scaleFactor), getAllDisplays: () => [] };
      expect(pointToDip({ x: 7, y: 9 }, odd)).toEqual({ x: 7, y: 9 });
    }
    const none: ScreenLike = { getPrimaryDisplay: () => { throw new Error("no display"); }, getAllDisplays: () => [] };
    expect(rectToDip({ x: 7, y: 9, width: 1, height: 2 }, none)).toEqual({ x: 7, y: 9, width: 1, height: 2 });
  });
});
