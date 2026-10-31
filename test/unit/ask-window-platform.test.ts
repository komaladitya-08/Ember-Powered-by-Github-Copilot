/**
 * The ask box on every OS: its window id comes from the window system (an X id, an HWND, a CGWindowID), an id that
 * can't be told (0) never matches the box (main's mayRefocus has no guard of its own, finding L10), takeFocus is called
 * whatever the id so main decides, and the box is made with the platform's options and workspace rule.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as FakeWindow[]);
interface FakeWindow {
  options: Record<string, unknown>; calls: unknown[][]; handle: () => Buffer; visible: boolean;
  handlers: Map<string, (() => void)[]>; emit(e: string): void;
}

vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1280, height: 800 } };
  class BrowserWindow implements FakeWindow {
    calls: unknown[][] = [];
    visible = false;
    handlers = new Map<string, (() => void)[]>();
    handle = () => { const b = Buffer.alloc(8); b.writeUInt32LE(0x3a00007, 0); return b; };
    webContents = { on() {}, send() {}, isLoading: () => false, ipc: { on() {} } };
    constructor(readonly options: Record<string, unknown>) { made.push(this); }
    on(e: string, fn: () => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); return this; }
    once(e: string, fn: () => void) { return this.on(e, fn); }
    emit(e: string) { for (const fn of this.handlers.get(e) ?? []) fn(); }
    setAlwaysOnTop(...a: unknown[]) { this.calls.push(["setAlwaysOnTop", ...a]); }
    setVisibleOnAllWorkspaces(...a: unknown[]) { this.calls.push(["setVisibleOnAllWorkspaces", ...a]); }
    loadURL() { return Promise.resolve(); }
    setBounds() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    setIgnoreMouseEvents() {}
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    isDestroyed() { return false; }
    destroy() {}
    getNativeWindowHandle() { return this.handle(); }
  }
  return {
    BrowserWindow,
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
  };
});

const { AskWindow } = await import("../../app/main/ask");
const { hoverShaper } = await import("../../app/main/platform/compose");
const { linuxOverlayShaper } = await import("../../app/main/platform/linux/overlay-shaper");

afterEach(() => { made.length = 0; });

/** A box made, loaded and shown once, with `takeFocus` recording the ids it got. */
function shownBox(o: ConstructorParameters<typeof AskWindow>[0] = {}) {
  const focused: number[] = [];
  const ask = new AskWindow({ takeFocus: id => focused.push(id), ...o });
  ask.prepare();
  const [win] = made;
  win!.emit("ready-to-show");
  ask.show({ x: 400, y: 300 });
  return { ask, win: win!, focused };
}

describe("the ask box's window id", () => {
  it("is never window 0, even when its own id can't be told (a box whose id reads 0)", () => {
    const { ask } = shownBox({ windowId: () => 0 });
    expect(ask.isWindow(0)).toBe(false);
    expect(ask.isWindow(0x3a00007)).toBe(false);
  });

  it("is never window 0 when the window system can't tell it (windowId throws), and that counts as 0", () => {
    const { ask, focused } = shownBox({ windowId: () => { throw new Error("gone"); } });
    expect(ask.isWindow(0)).toBe(false);
    expect(focused).toEqual([0]);
  });

  it("calls takeFocus whatever the id, 0 included: main decides what to do with it", () => {
    const { focused } = shownBox({ windowId: () => 0 });
    expect(focused).toEqual([0]);
  });

  it("comes from the window system when given (an HWND or a CGWindowID, not the X id)", () => {
    const { ask, focused } = shownBox({ windowId: () => 0x1234 });
    expect(focused).toEqual([0x1234]);
    expect(ask.isWindow(0x1234)).toBe(true);
    expect(ask.isWindow(0x3a00007)).toBe(false);
  });

  it("still shows the box with its context when giving it the keyboard throws (best effort, as it always was)", () => {
    const ask = new AskWindow({ takeFocus: () => { throw new Error("no window manager"); } });
    ask.prepare();
    const win = made[0]!;
    const sent: string[] = [];
    (win as unknown as { webContents: { send: (channel: string) => void } }).webContents.send = channel => { sent.push(channel); };
    win.emit("ready-to-show");
    expect(() => ask.show({ x: 400, y: 300 })).not.toThrow();
    expect(win.visible).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("is the X id by default, as on Linux before (and a handle that reads 0 is no window)", () => {
    const { ask, win, focused } = shownBox();
    expect(focused).toEqual([0x3a00007]);
    expect(ask.isWindow(0x3a00007)).toBe(true);
    win.handle = () => Buffer.alloc(8);
    expect(ask.isWindow(0)).toBe(false);
  });
});

describe("the ask box's window", () => {
  it("on Linux is today's: no extra options and no setVisibleOnAllWorkspaces call", () => {
    shownBox({ floating: linuxOverlayShaper().floating("ask") });
    expect(Object.keys(made[0]!.options)).not.toContain("type");
    expect(made[0]!.calls.filter(c => c[0] === "setVisibleOnAllWorkspaces")).toEqual([]);
  });

  it("on macOS is a focusable panel (it takes the keyboard without activating Ember), with no setVisibleOnAllWorkspaces call", () => {
    shownBox({ floating: hoverShaper("darwin").floating("ask") });
    expect(made[0]!.options).toMatchObject({ type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, title: "Ask Ember" });
    expect(made[0]!.options.focusable).toBeUndefined();
    expect(made[0]!.calls.filter(c => c[0] === "setVisibleOnAllWorkspaces")).toEqual([]);
  });

  it("on Windows is a tool window (not tracked per virtual desktop)", () => {
    shownBox({ floating: hoverShaper("win32").floating("ask") });
    expect(made[0]!.options).toMatchObject({ type: "toolbar", thickFrame: false, roundedCorners: false });
  });

  it("keeps its sandboxed preload whatever the platform adds", () => {
    shownBox({ floating: hoverShaper("darwin").floating("ask") });
    expect(made[0]!.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
  });
});
