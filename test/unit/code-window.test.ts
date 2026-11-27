/**
 * The coding window's BrowserWindow (windows.ts createCodeWindow, openCodeWindow): contextIsolation, the sandbox and no
 * Node, its own preload, titled "Ember" for good (EMBER_WINDOW in policy.ts), 1200×800 down to 720×480, and nothing
 * opened while the build has no coding preload.
 */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  made: [] as { options: Record<string, unknown>; handlers: Map<string, (e: { preventDefault(): void }) => void>; shown: number; focused: number; destroyed: boolean; url?: string }[],
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    record: (typeof electron.made)[number];
    webContents = { on() { return this; }, getZoomLevel: () => 0, setZoomLevel() { /* not looked at */ } };
    constructor(options: Record<string, unknown>) { this.record = { options, handlers: new Map(), shown: 0, focused: 0, destroyed: false }; electron.made.push(this.record); }
    on(event: string, fn: (e: { preventDefault(): void }) => void) { this.record.handlers.set(event, fn); return this; }
    once(event: string, fn: (e: { preventDefault(): void }) => void) { this.record.handlers.set(event, fn); return this; }
    loadURL(url: string) { this.record.url = url; return Promise.resolve(); }
    isDestroyed() { return this.record.destroyed; }
    isMinimized() { return false; }
    restore() { /* not minimised */ }
    show() { this.record.shown++; }
    focus() { this.record.focused++; }
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } }), on() {}, off() {} },
  Menu: {}, nativeTheme: { shouldUseDarkColors: true }, app: { on() {}, removeListener() {} },
}));

const { CODE_SIZE, createCodeWindow, openCodeWindow } = await import("../../app/main/windows");

beforeEach(() => { electron.made.length = 0; });

describe("the coding window", () => {
  it("is sandboxed with its own preload, sized 1200×800 down to 720×480, and keeps the title Ember", () => {
    createCodeWindow("linux");
    const w = electron.made[0];
    expect(w.options).toMatchObject({ width: 1200, height: 800, minWidth: 720, minHeight: 480, title: "Ember", show: false });
    expect(w.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false });
    expect(String((w.options.webPreferences as { preload: string }).preload).split(path.sep).slice(-2)).toEqual(["preload", "code.cjs"]);
    expect(w.url).toMatch(/\/renderer\/code\/index\.html$/);
    const prevented = vi.fn();
    w.handlers.get("page-title-updated")?.({ preventDefault: prevented });
    expect(prevented).toHaveBeenCalled();
    expect(CODE_SIZE).toEqual({ width: 1200, height: 800, minWidth: 720, minHeight: 480 });
  });

  it("opens nothing while the build has no coding preload, then one window, brought forward when asked again", () => {
    expect(openCodeWindow("linux", () => false)).toBeNull();
    expect(electron.made).toHaveLength(0);
    const first = openCodeWindow("linux", f => f.endsWith(`${path.sep}code.cjs`));
    expect(first).not.toBeNull();
    expect(openCodeWindow("linux", () => true)).toBe(first);
    expect(electron.made).toHaveLength(1);
    expect(electron.made[0].shown).toBe(1);
    expect(electron.made[0].focused).toBe(1);
    // Once closed, the next open makes a new one.
    electron.made[0].destroyed = true;
    electron.made[0].handlers.get("closed")?.({ preventDefault() {} });
    openCodeWindow("linux", () => true);
    expect(electron.made).toHaveLength(2);
  });
});
