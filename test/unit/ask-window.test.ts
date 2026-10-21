/**
 * The ask box opens only when asked for, at once, with the keyboard (live test: once it opened on a plain click
 * into Mousepad, once so late after Ctrl+Alt+Space that the first letters went into the app).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as FakeWindow[]);
interface FakeWindow {
  shown: number; focused: number; visible: boolean; ignoreMouse: boolean; handlers: Map<string, (() => void)[]>;
  webContents: { on(): void; send(ch: string, t: unknown): void; isLoading(): boolean };
  emit(e: string): void;
}

vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1280, height: 800 } };
  class BrowserWindow implements FakeWindow {
    shown = 0; focused = 0; visible = false; handlers = new Map<string, (() => void)[]>();
    webContents = { on() {}, send() {}, isLoading: () => false };
    constructor() { made.push(this); }
    on(e: string, fn: () => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); return this; }
    once(e: string, fn: () => void) { return this.on(e, fn); }
    emit(e: string) { for (const fn of this.handlers.get(e) ?? []) fn(); }
    setAlwaysOnTop() {}
    loadFile() { return Promise.resolve(); }
    setBounds() {}
    show() { this.shown++; this.visible = true; this.ignoreMouse = false; }
    hide() { this.visible = false; }
    focus() { this.focused++; }
    ignoreMouse = true;
    setIgnoreMouseEvents(on: boolean) { this.ignoreMouse = on; }
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    isDestroyed() { return false; }
    destroy() {}
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeUInt32LE(0x3a00007, 0); return b; }
  }
  return {
    BrowserWindow,
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
  };
});

const { AskWindow } = await import("../../app/main/ask");

afterEach(() => { made.length = 0; vi.useRealTimers(); });

describe("the ask box", () => {
  it("made ahead of time, it opens at once when asked for and takes the keyboard through X", () => {
    const focusedX: number[] = [];
    const ask = new AskWindow({ takeFocus: xid => focusedX.push(xid) });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    // Loaded, never asked for: it stays hidden.
    expect(win.shown).toBe(0);
    ask.show({ x: 400, y: 300 });
    expect(made).toHaveLength(1);
    expect(win.shown).toBe(1);
    expect(win.focused).toBe(1);
    expect(focusedX).toEqual([0x3a00007]);
  });

  it("closed before it had loaded, it doesn't pop up later by itself", () => {
    const ask = new AskWindow();
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    ask.hide();
    win.emit("ready-to-show");
    expect(win.shown).toBe(0);
  });

  it("one that took too long to load isn't shown over what the user went on to do", () => {
    vi.useFakeTimers();
    const ask = new AskWindow();
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    vi.advanceTimersByTime(3000);
    win.emit("ready-to-show");
    expect(win.shown).toBe(0);
    // Asked for again, it opens now.
    ask.show({ x: 400, y: 300 });
    expect(win.shown).toBe(1);
  });

  it("hands letters typed while it opened to the box", () => {
    const sent: unknown[] = [];
    const ask = new AskWindow();
    ask.prepare();
    const [win] = made;
    win.webContents.send = (ch: string, t: unknown) => { sent.push([ch, t]); };
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 });
    ask.typed({ text: "hello", submit: false, cancel: false });
    expect(sent).toContainEqual(["agent:ask-typed", { text: "hello", submit: false, cancel: false }]);
    ask.typed({ text: "", submit: false, cancel: false });
    expect(sent.filter(x => Array.isArray(x) && x[0] === "agent:ask-typed")).toHaveLength(1);
  });

  it("waits for X focus, not just Electron's, before it counts as having the keyboard", async () => {
    vi.useFakeTimers();
    let ours = false;
    const ask = new AskWindow({ hasFocus: () => ours });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 });
    const ready = ask.hasKeyboard(200);
    await vi.advanceTimersByTimeAsync(30);
    // Electron says focused (the window is visible), but X still has the user's app: keep holding the keys.
    ours = true;
    await vi.advanceTimersByTimeAsync(20);
    await expect(ready).resolves.toBe(true);
  });

  it("hiding the box takes the pointer off it (a leftover mapped window would steal a click into the app)", () => {
    const revealed: string[] = [];
    const ask = new AskWindow({ onReveal: s => revealed.push(s) });
    ask.prepare();
    const [win] = made;
    win.emit("ready-to-show");
    ask.show({ x: 400, y: 300 }, undefined, "hotkey");
    expect(revealed).toEqual(["hotkey"]);
    expect(win.ignoreMouse).toBe(false);
    ask.hide();
    expect(win.visible).toBe(false);
    expect(win.ignoreMouse).toBe(true);
    // A focus on the hidden box must not map it again.
    ask.focus();
    expect(win.visible).toBe(false);
  });
});
