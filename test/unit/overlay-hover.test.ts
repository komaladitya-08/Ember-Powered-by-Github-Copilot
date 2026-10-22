/**
 * The overlay where there is no input region (Windows, macOS): hover polling decides click-through from the pointer
 * and the clickable rectangles, a held button freezes it (a press ends where it began), and click-through forwards the
 * pointer's moves only where the platform says so (macOS; on Windows `forward` would hook every app's mouse). The
 * overlay windows take the platform's options and workspace rule, and stopping releases what the shaper holds.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as { options: Record<string, unknown>; calls: unknown[][] }[]);

vi.mock("electron", () => {
  const display = { id: 1, scaleFactor: 2, workArea: { x: 0, y: 0, width: 1920, height: 1200 }, bounds: { x: 0, y: 0, width: 1920, height: 1200 } };
  class BrowserWindow {
    calls: unknown[][] = [];
    webContents = { on() {}, send() {}, isLoading: () => false };
    constructor(readonly options: Record<string, unknown>) { made.push(this); }
    setAlwaysOnTop(...a: unknown[]) { this.calls.push(["setAlwaysOnTop", ...a]); }
    setVisibleOnAllWorkspaces(...a: unknown[]) { this.calls.push(["setVisibleOnAllWorkspaces", ...a]); }
    setIgnoreMouseEvents(...a: unknown[]) { this.calls.push(["setIgnoreMouseEvents", ...a]); }
    on() { return this; }
    loadFile() { return Promise.resolve(); }
    isDestroyed() { return false; }
    destroy() {}
  }
  return {
    BrowserWindow,
    screen: {
      getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: 900, y: 600 }), getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display, on() {}, off() {},
    },
  };
});

import type { Logger } from "../../app/main/logger";
import type { Settings } from "../../app/main/settings";
import type { FloatingWindow, OverlayShaper } from "../../app/main/platform/types";
import { hoverShaper } from "../../app/main/platform/compose";

afterEach(() => { made.length = 0; });

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const button = { x: 100, y: 100, width: 60, height: 24 };

/** A shaper with no input region (Windows, macOS), recording what is asked of it. */
function fakeShaper(forward: boolean, floating: FloatingWindow = { options: {}, allWorkspaces: null }) {
  const asked: string[] = [];
  const shaper: OverlayShaper = {
    setInputRegion: () => { asked.push("region"); return false; },
    release: () => { asked.push("release"); },
    forward,
    floating: () => floating,
  };
  return { shaper, asked };
}

/** An overlay manager with one hand-made overlay window, whose pointer is `at` with `buttons` held. */
async function overlay(shaper: OverlayShaper) {
  const { OverlayManager } = await import("../../app/main/overlay");
  const pointer = { x: 900, y: 600, buttons: 0 };
  const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => pointer, shaper);
  const ignore: unknown[][] = [];
  const webContents = { send() {}, isLoading: () => false };
  const win = { webContents, isDestroyed: () => false, destroy() {}, setIgnoreMouseEvents: (...a: unknown[]) => ignore.push(a) };
  const display = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 }, workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  (m as unknown as { overlays: Map<number, unknown> }).overlays.set(1, { win, display, interactive: [], clickThrough: true, shaped: false, cards: null });
  const tick = () => (m as unknown as { tick(): void }).tick();
  const moveTo = (x: number, y: number, buttons = 0) => { pointer.x = x; pointer.y = y; pointer.buttons = buttons; tick(); };
  return { m, sender: webContents as unknown as Electron.WebContents, ignore, moveTo };
}

describe("the overlay without an input region", () => {
  it("takes the pointer over a button and lets it through elsewhere, forwarding moves when the platform says so (macOS)", async () => {
    const { shaper, asked } = fakeShaper(true);
    const { m, sender, ignore, moveTo } = await overlay(shaper);
    m.setInteractive(sender, [button]);
    // The region was asked for and refused: hover polling decides.
    expect(asked).toEqual(["region"]);
    expect(ignore).toEqual([]);
    moveTo(120, 110);
    expect(ignore).toEqual([[false]]);
    moveTo(800, 700);
    expect(ignore).toEqual([[false], [true, { forward: true }]]);
  });

  it("lets clicks through with no options where moves aren't forwarded (Windows, as Linux always did)", async () => {
    const { shaper } = fakeShaper(false);
    const { m, sender, ignore, moveTo } = await overlay(shaper);
    m.setInteractive(sender, [button]);
    moveTo(120, 110);
    moveTo(800, 700);
    expect(ignore).toEqual([[false], [true]]);
    expect(ignore[1]).toHaveLength(1);
  });

  it("holds still while a button is held, so a press ends where it began (takesPointer)", async () => {
    const { shaper } = fakeShaper(true);
    const { m, sender, ignore, moveTo } = await overlay(shaper);
    m.setInteractive(sender, [button]);
    moveTo(120, 110);
    // Dragged off Allow with the button down: still Ember's.
    moveTo(800, 700, 256);
    expect(ignore).toEqual([[false]]);
    // Pressed outside while click-through: still the app's, even when the press moves over the button.
    moveTo(800, 700);
    expect(ignore).toEqual([[false], [true, { forward: true }]]);
    moveTo(120, 110, 256);
    expect(ignore).toHaveLength(2);
    moveTo(120, 110);
    expect(ignore).toEqual([[false], [true, { forward: true }], [false]]);
  });

  it("goes click-through at once when nothing is clickable any more (a question answered), with the platform's options", async () => {
    const { shaper } = fakeShaper(true);
    const { m, sender, ignore, moveTo } = await overlay(shaper);
    m.setInteractive(sender, [button]);
    moveTo(120, 110);
    m.setInteractive(sender, []);
    expect(ignore).toEqual([[false], [true, { forward: true }]]);
  });

  it("lets everything through while Ember borrows the pointer, also under the cursor", async () => {
    const { shaper } = fakeShaper(false);
    const { m, sender, ignore, moveTo } = await overlay(shaper);
    m.setInteractive(sender, [button]);
    moveTo(120, 110);
    m.setBorrowing(true);
    expect(ignore).toEqual([[false], [true]]);
    moveTo(121, 111);
    expect(ignore).toEqual([[false], [true]]);
  });

  it("stopping releases what the shaper holds", async () => {
    const { shaper, asked } = fakeShaper(false);
    const { m } = await overlay(shaper);
    m.stop();
    expect(asked).toContain("release");
  });
});

describe("the overlay's windows", () => {
  it("on macOS are panels that take the first click, with no setVisibleOnAllWorkspaces call, click-through with forwarding (M1)", async () => {
    const { OverlayManager } = await import("../../app/main/overlay");
    const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => ({ x: 900, y: 600 }), hoverShaper("darwin"));
    m.start();
    m.stop();
    expect(made).toHaveLength(1);
    expect(made[0]!.options).toMatchObject({ type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, roundedCorners: false, title: "Ember overlay", transparent: true, focusable: false });
    expect(made[0]!.calls.filter(c => c[0] === "setVisibleOnAllWorkspaces")).toEqual([]);
    expect(made[0]!.calls).toContainEqual(["setIgnoreMouseEvents", true, { forward: true }]);
    expect(made[0]!.calls).toContainEqual(["setAlwaysOnTop", true, "screen-saver"]);
  });

  it("on Windows are tool windows without a thick frame, click-through with no options", async () => {
    const { OverlayManager } = await import("../../app/main/overlay");
    const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => ({ x: 900, y: 600 }), hoverShaper("win32"));
    m.start();
    m.stop();
    expect(made[0]!.options).toMatchObject({ type: "toolbar", thickFrame: false, roundedCorners: false });
    expect(made[0]!.calls.filter(c => c[0] === "setVisibleOnAllWorkspaces")).toEqual([]);
    expect(made[0]!.calls).toContainEqual(["setIgnoreMouseEvents", true]);
    expect(made[0]!.calls.find(c => c[0] === "setIgnoreMouseEvents")).toHaveLength(2);
  });

  it("on Linux are today's windows: a toolbar over full-screen apps on every workspace, click-through with no options", async () => {
    const { OverlayManager } = await import("../../app/main/overlay");
    const { linuxOverlayShaper } = await import("../../app/main/platform/linux/overlay-shaper");
    const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => ({ x: 900, y: 600 }), linuxOverlayShaper());
    m.start();
    // (Stopping closes the X connection the shapes went over; nothing was opened here.)
    expect(made[0]!.options).toMatchObject({ type: "toolbar", title: "Ember overlay" });
    expect(Object.keys(made[0]!.options)).not.toContain("acceptFirstMouse");
    expect(made[0]!.calls.filter(c => c[0] !== "setAlwaysOnTop")).toEqual([
      ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true }],
      ["setIgnoreMouseEvents", true],
    ]);
    m.stop();
  });
});
