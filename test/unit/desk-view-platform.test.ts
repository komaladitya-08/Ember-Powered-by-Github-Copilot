/**
 * The desk view's window id comes from the window system, and an id that can't be told (0) never matches it (finding
 * L10: main's focus hand-back and the handle's menu ask isWindow with whatever the window system answered).
 */

import { describe, expect, it, vi } from "vitest";
import type { DeskPlace } from "../../app/main/desk/place";
import type { Logger } from "../../app/main/logger";

const h = vi.hoisted(() => ({ windows: [] as { handle: Buffer }[] }));

vi.mock("electron", () => {
  class BrowserWindow {
    handle = Buffer.alloc(8);
    webContents = { send() {} };
    constructor() { this.handle.writeUInt32LE(0x2c00011, 0); h.windows.push(this); }
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    loadURL() { return Promise.resolve(); }
    once() { return this; }
    on() { return this; }
    showInactive() {}
    getNativeWindowHandle() { return this.handle; }
  }
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    BrowserWindow,
    ipcMain: { on: () => undefined },
    screen: { getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) },
  };
});

const { DeskView } = await import("../../app/main/desk/view");
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const place = { dead: false, onDead: () => undefined } as unknown as DeskPlace;

describe("the desk view's window id", () => {
  it("is the X id by default, as before, and never window 0", () => {
    const view = new DeskView(quiet);
    expect(view.isWindow(0x2c00011)).toBe(false);
    view.show(place);
    expect(view.isWindow(0x2c00011)).toBe(true);
    expect(view.isWindow(0)).toBe(false);
    h.windows.at(-1)!.handle = Buffer.alloc(8);
    expect(view.isWindow(0)).toBe(false);
  });

  it("comes from the window system when given, and a window system that can't tell (0, or throwing) matches nothing", () => {
    let id = 77;
    const view = new DeskView(quiet, undefined, { windowId: () => { if (id < 0) throw new Error("gone"); return id; } });
    view.show(place);
    expect(view.isWindow(77)).toBe(true);
    expect(view.isWindow(0x2c00011)).toBe(false);
    id = 0;
    expect(view.isWindow(0)).toBe(false);
    id = -1;
    expect(view.isWindow(0)).toBe(false);
    expect(view.isWindow(-1)).toBe(false);
  });
});
