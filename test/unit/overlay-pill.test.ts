/**
 * The status pill ("Using your keyboard: press a key or move the mouse to take over") never hides the control Ember
 * types into or clicks: it moves from the top to the bottom of the screen while the control's ring is under it
 * (review #124).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } }));

import { PILL_TOP, pillBottom, pillSpot } from "../../app/renderer/overlay/layout";
import type { Logger } from "../../app/main/logger";
import type { Settings } from "../../app/main/settings";
import type { OverlayInit } from "../../app/shared/overlay";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

describe("where the status pill goes", () => {
  const view = { width: 1440, height: 900 };
  const pill = { width: 390, height: 34 };

  it("sits at the top, centred, when nothing Ember works on is there", () => {
    expect(PILL_TOP).toBe(40);
    expect(pillSpot(null, pill, view, 60)).toBe("top");
    expect(pillSpot({ x: 600, y: 400, width: 200, height: 30 }, pill, view, 60)).toBe("top");
  });

  it("moves to the bottom while Ember types into an address bar under it", () => {
    expect(pillSpot({ x: 260, y: 48, width: 920, height: 32 }, pill, view, 60)).toBe("bottom");
  });

  it("moves for a ribbon's tabs just under it (the ring's glow counts)", () => {
    expect(pillSpot({ x: 640, y: 80, width: 160, height: 24 }, pill, view, 60)).toBe("bottom");
  });

  it("stays at the top when the bottom would be no better (a control as tall as the screen)", () => {
    expect(pillSpot({ x: 500, y: 0, width: 440, height: 900 }, pill, view, 60)).toBe("top");
  });

  it("keeps above the taskbar or Dock: the work area's bottom when known, else the handle's", () => {
    const bounds = { x: 1920, y: 0, width: 1440, height: 900 };
    expect(pillBottom(bounds, { x: 1920, y: 0, width: 1440, height: 852 }, null)).toBe(48 + 20);
    expect(pillBottom(bounds, null, { x: 1228, y: 784, width: 200, height: 56 })).toBe(60 + 20);
    expect(pillBottom(bounds, null, null)).toBe(20);
  });
});

describe("what each overlay is told about its display", () => {
  it("includes the work area, so the pill can keep above the taskbar or Dock", async () => {
    const { OverlayManager } = await import("../../app/main/overlay");
    const shaper = { setInputRegion: () => false, release() {}, forward: false, floating: () => ({ options: {}, allWorkspaces: null }) };
    const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => ({ x: 0, y: 0 }), shaper);
    const display = { id: 7, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 800 } };
    const init = (m as unknown as { initFor(o: unknown): OverlayInit }).initFor({ display });
    expect(init.workArea).toEqual({ x: 0, y: 25, width: 1440, height: 800 });
  });
});
