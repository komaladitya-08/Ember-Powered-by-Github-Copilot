/**
 * Letters typed straight after the ask shortcut (review #78, owner decision D-78): on Windows and macOS, where Ember
 * can't hold the keyboard while the box opens, the box takes the keyboard as soon as it can, and nothing it does on
 * opening lands on letters already typed into it. The page gets what it shows before the window is shown, and what
 * was left in the field is selected when the box goes away, never as it opens (selected then, it took the first
 * letters: "uick brown fox").
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What happened to the windows, in order: shows, focuses, hides and messages to their pages. */
const events = vi.hoisted(() => [] as string[]);
const made = vi.hoisted(() => [] as FakeWindow[]);
interface FakeWindow {
  visible: boolean; focused: boolean; bounds: { x: number; y: number; width: number; height: number };
  emit(e: string): void;
  heard: Map<string, (e: unknown, ...a: unknown[]) => void>;
  sent: [string, unknown][];
}

vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1280, height: 800 } };
  class BrowserWindow implements FakeWindow {
    visible = false; focused = false; handlers = new Map<string, (() => void)[]>();
    bounds = { x: 0, y: 0, width: 560, height: 92 };
    heard = new Map<string, (e: unknown, ...a: unknown[]) => void>();
    sent: [string, unknown][] = [];
    webContents = {
      on: () => undefined, isLoading: () => false,
      send: (ch: string, v: unknown) => { this.sent.push([ch, v]); events.push(`send ${ch}`); },
      ipc: { on: (ch: string, fn: (e: unknown, ...a: unknown[]) => void) => { this.heard.set(ch, fn); } },
    };
    constructor(o: { x: number; y: number; width: number; height: number }) { made.push(this); this.bounds = { x: o.x, y: o.y, width: o.width, height: o.height }; }
    on(e: string, fn: () => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); return this; }
    once(e: string, fn: () => void) { return this.on(e, fn); }
    emit(e: string) { for (const fn of this.handlers.get(e) ?? []) fn(); }
    setAlwaysOnTop() {}
    loadURL() { return Promise.resolve(); }
    setBounds(b: { x: number; y: number; width: number; height: number }) { this.bounds = b; }
    getBounds() { return this.bounds; }
    show() { this.visible = true; events.push("show"); }
    hide() { this.visible = false; this.focused = false; events.push("hide"); }
    focus() { events.push("focus"); }
    setIgnoreMouseEvents() {}
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    isDestroyed() { return false; }
    destroy() {}
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeUInt32LE(0x3a00007, 0); return b; }
  }
  return {
    BrowserWindow, Menu: { buildFromTemplate: () => ({ popup() {} }) },
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
  };
});

const { AskWindow } = await import("../../app/main/ask");

afterEach(() => { made.length = 0; events.length = 0; });

/** A box made ahead of time and loaded, as main prepares it at start. */
function ready(o: ConstructorParameters<typeof AskWindow>[0] = {}) {
  const ask = new AskWindow(o);
  ask.prepare();
  const [win] = made;
  win!.emit("ready-to-show");
  events.length = 0;
  return { ask, win: win! };
}

describe("the ask box as it opens (review #78)", () => {
  it("gives its page what it shows before the window is shown and takes the keyboard", () => {
    const { ask } = ready({ takeFocus: () => events.push("takeFocus") });
    ask.show({ x: 400, y: 300 }, { sees: null, history: ["earlier"] }, "hotkey");
    // The opening's context first: the page is ready before a letter can reach it.
    expect(events).toEqual(["send agent:ask-context", "show", "focus", "takeFocus"]);
  });

  it("says it was shown only once it is up (a log line written before would hold up the keyboard)", () => {
    const { ask } = ready({ onReveal: s => events.push(`reveal ${s}`) });
    ask.show({ x: 400, y: 300 }, undefined, "hotkey");
    expect(events.indexOf("reveal hotkey")).toBeGreaterThan(events.indexOf("focus"));
  });

  it("says when it has the keyboard, once each time it opens (what was typed before went elsewhere)", () => {
    let told = 0;
    const { ask, win } = ready({ onKeyboard: () => { told++; } });
    // A focus before it was asked for (a test, the window manager) isn't an opening.
    win.emit("focus");
    expect(told).toBe(0);
    ask.show({ x: 400, y: 300 }, undefined, "hotkey");
    win.emit("focus");
    win.emit("focus");
    expect(told).toBe(1);
    ask.hide();
    ask.show({ x: 400, y: 300 }, undefined, "hotkey");
    win.emit("focus");
    expect(told).toBe(2);
  });

  it("has its page select what was left in the field when it goes away, while nothing can be typed", () => {
    const { ask, win } = ready();
    ask.show({ x: 400, y: 300 }, undefined, "hotkey");
    events.length = 0;
    ask.hide();
    expect(events).toEqual(["hide", "send agent:ask-hidden"]);
    expect(win.sent.at(-1)).toEqual(["agent:ask-hidden", undefined]);
  });
});

describe("the ask box's page (review #78)", () => {
  const PAGE = readFileSync(new URL("../../app/renderer/ask/main.ts", import.meta.url), "utf8");
  const onContext = /window\.emberAsk\.onContext\(c => \{[\s\S]*?\n\}\);/.exec(PAGE)?.[0] ?? "";

  it("selects what was left in the field when the box goes away, not as it opens", () => {
    expect(onContext).toContain("history.context(");
    // Selected as the box opened, the text selected was the letters already typed, and the next letter replaced them.
    expect(onContext).not.toContain(".select()");
    expect(PAGE).toMatch(/window\.emberAsk\.onHidden\(\(\) => input\.select\(\)\);/);
  });

  it("hears the box going away through its preload", () => {
    const preload = readFileSync(new URL("../../app/preload/ask.ts", import.meta.url), "utf8");
    expect(preload).toContain("onHidden: fn => { ipcRenderer.on(IPC.askHidden, () => fn()); },");
  });
});
