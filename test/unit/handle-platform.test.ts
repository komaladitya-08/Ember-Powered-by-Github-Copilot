/**
 * Ember's corner handle on every OS: the platform's window options and workspace rule (Linux: today's toolbar on every
 * workspace; macOS: a panel with no setVisibleOnAllWorkspaces call, which would transform the process, M1), and
 * click-through while Ember borrows the pointer that forwards moves only where the platform says so (macOS).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as { options: Record<string, unknown>; calls: unknown[][] }[]);

vi.mock("electron", () => {
  class BrowserWindow {
    calls: unknown[][] = [];
    webContents = { on() {}, send() {}, isDestroyed: () => false };
    constructor(readonly options: Record<string, unknown>) { made.push(this); }
    setAlwaysOnTop(...a: unknown[]) { this.calls.push(["setAlwaysOnTop", ...a]); }
    setVisibleOnAllWorkspaces(...a: unknown[]) { this.calls.push(["setVisibleOnAllWorkspaces", ...a]); }
    setIgnoreMouseEvents(...a: unknown[]) { this.calls.push(["setIgnoreMouseEvents", ...a]); }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; }
    destroy() {}
  }
  const workArea = { x: 0, y: 0, width: 1280, height: 800 };
  return { BrowserWindow, screen: { getPrimaryDisplay: () => ({ id: 1, bounds: workArea, workArea }), on() {}, off() {} } };
});

const { HandleWindow } = await import("../../app/main/handle");
const { hoverShaper } = await import("../../app/main/platform/compose");
const { linuxOverlayShaper } = await import("../../app/main/platform/linux/overlay-shaper");
import type { Settings } from "../../app/main/settings";

const settings = () => ({}) as Settings;
const workspaceCalls = (i = 0) => made[i]!.calls.filter(c => c[0] === "setVisibleOnAllWorkspaces");
const ignoreCalls = (i = 0) => made[i]!.calls.filter(c => c[0] === "setIgnoreMouseEvents").map(c => c.slice(1));

afterEach(() => { made.length = 0; });

describe("the handle's window", () => {
  it("without platform options is today's Linux toolbar, on every workspace", () => {
    new HandleWindow(settings, false);
    expect(made[0]!.options).toMatchObject({ type: "toolbar", focusable: false, alwaysOnTop: true });
    expect(workspaceCalls()).toEqual([["setVisibleOnAllWorkspaces", true]]);
  });

  it("with Linux's floating window makes the same calls as before", () => {
    new HandleWindow(settings, false, { floating: linuxOverlayShaper().floating("handle"), forward: false });
    expect(made[0]!.options).toMatchObject({ type: "toolbar" });
    expect(Object.keys(made[0]!.options)).not.toContain("acceptFirstMouse");
    expect(workspaceCalls()).toEqual([["setVisibleOnAllWorkspaces", true]]);
  });

  it("on macOS is a panel that takes the first click, with no setVisibleOnAllWorkspaces call (M1)", () => {
    new HandleWindow(settings, false, { floating: hoverShaper("darwin").floating("handle"), forward: true });
    expect(made[0]!.options).toMatchObject({ type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, roundedCorners: false });
    expect(workspaceCalls()).toEqual([]);
    expect(made[0]!.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
  });

  it("on Windows is a tool window without a thick frame, with no setVisibleOnAllWorkspaces call", () => {
    new HandleWindow(settings, true, { floating: hoverShaper("win32").floating("handle"), forward: false });
    expect(made[0]!.options).toMatchObject({ type: "toolbar", thickFrame: false, roundedCorners: false });
    expect(workspaceCalls()).toEqual([]);
  });
});

describe("the handle's click-through while Ember borrows the pointer", () => {
  it("forwards the pointer's moves where the platform says so (macOS), and takes clicks again after", () => {
    const h = new HandleWindow(settings, false, { floating: hoverShaper("darwin").floating("handle"), forward: true });
    h.setClickThrough(true);
    h.setClickThrough(false);
    expect(ignoreCalls()).toEqual([[true, { forward: true }], [false]]);
  });

  it("takes no options elsewhere, as before", () => {
    const h = new HandleWindow(settings, false, { forward: false });
    h.setClickThrough(true);
    h.setClickThrough(false);
    expect(ignoreCalls()).toEqual([[true], [false]]);
  });
});
