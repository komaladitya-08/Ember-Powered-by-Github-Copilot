/**
 * The desktop's reduce-motion preference reaches Ember's follow spring while Ember runs, not only at start: the
 * overlay's page follows the preference live and tells the main process when it changes (review #135).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const display = { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  return {
    BrowserWindow: class {},
    screen: { getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: 900, y: 600 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display, on() {}, off() {} },
  };
});

import type { Logger } from "../../app/main/logger";
import type { Settings } from "../../app/main/settings";
import { OVERLAY } from "../../app/shared/overlay";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const shaper = { setInputRegion: () => false, release() {}, forward: false, floating: () => ({ options: {}, allWorkspaces: null }) };

describe("the desktop's reduce-motion preference", () => {
  it("is followed when it changes while Ember runs, either way", async () => {
    const { OverlayManager } = await import("../../app/main/overlay");
    const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => ({ x: 900, y: 600 }), shaper);
    const calm: boolean[] = [];
    const follower = (m as unknown as { follower: { setReducedMotion(on: boolean): void } }).follower;
    follower.setReducedMotion = on => { calm.push(on); };
    const tick = () => (m as unknown as { tick(): void }).tick();
    // Read at start: animations were off.
    m.systemReducedMotion = true;
    tick();
    // The user turns animations back on, then off again.
    m.reducedMotionChanged(false);
    tick();
    m.reducedMotionChanged(true);
    tick();
    expect(calm).toEqual([true, false, true]);
  });

  it("has its own message from the overlay's page", () => {
    expect(OVERLAY.motion).toBe("overlay:motion");
  });
});
