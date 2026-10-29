/**
 * The ask box opens only when asked for, at once, with the keyboard (live test: once it opened on a plain click
 * into Mousepad, once so late after Ctrl+Alt+Space that the first letters went into the app).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as FakeWindow[]);
/** The edit menus popped up: their items, and the popup's options (its callback runs when the menu closes). */
const menus = vi.hoisted(() => [] as { items: { role?: string; label?: string; enabled?: boolean }[]; popup?: { callback?: () => void } }[]);
interface FakeWindow {
  shown: number; focused: number; visible: boolean; ignoreMouse: boolean; handlers: Map<string, (() => void)[]>;
  bounds: { x: number; y: number; width: number; height: number }; heard: Map<string, (e: unknown, ...a: unknown[]) => void>;
  contents: Map<string, (e: unknown, ...a: unknown[]) => void>;
  webContents: { on(e: string, fn: (e: unknown, ...a: unknown[]) => void): void; send(ch: string, t: unknown): void; isLoading(): boolean };
  emit(e: string): void;
  isFocused(): boolean;
}

vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1280, height: 800 } };
  class BrowserWindow implements FakeWindow {
    shown = 0; focused = 0; visible = false; handlers = new Map<string, (() => void)[]>();
    bounds = { x: 0, y: 0, width: 560, height: 92 };
    heard = new Map<string, (e: unknown, ...a: unknown[]) => void>();
    contents = new Map<string, (e: unknown, ...a: unknown[]) => void>();
    webContents = {
      on: (e: string, fn: (e: unknown, ...a: unknown[]) => void) => { this.contents.set(e, fn); }, send() {}, isLoading: () => false,
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
  const Menu = {
    buildFromTemplate: (items: { role?: string; label?: string; enabled?: boolean }[]) => {
      const m: (typeof menus)[number] = { items };
      menus.push(m);
      return { popup: (o: { callback?: () => void }) => { m.popup = o; } };
    },
  };
  return {
    BrowserWindow, Menu,
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
  };
});

const { AskWindow } = await import("../../app/main/ask");

afterEach(() => { made.length = 0; menus.length = 0; vi.useRealTimers(); });

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

  it("grows with its field as lines are added or pasted, upward above Ember, and opens one line tall again (review #70)", () => {
    const ask = new AskWindow();
    ask.show({ x: 400, y: 500 });
    const [win] = made;
    win.emit("ready-to-show");
    const one = { ...win.bounds };
    expect(one.height).toBe(92);
    win.heard.get("agent:ask-fit")!({}, 3);
    expect(win.bounds).toEqual({ ...one, height: 140, y: one.y - 48 });
    // Nothing from the page that isn't a number of lines.
    win.heard.get("agent:ask-fit")!({}, "9");
    expect(win.bounds.height).toBe(140);
    ask.hide();
    ask.show({ x: 400, y: 500 });
    expect(win.bounds).toEqual(one);
  });

  it("offers Cut, Copy, Paste and Select all on a right-click, and stays open while that menu is up (review #77)", () => {
    const ask = new AskWindow();
    ask.show({ x: 400, y: 500 });
    const [win] = made;
    win.emit("ready-to-show");
    win.contents.get("context-menu")!({}, { editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
    expect(menus[0].items.map(i => [i.role, i.label, i.enabled])).toEqual([
      ["cut", "Cut", false], ["copy", "Copy", false], ["paste", "Paste", true], [undefined, undefined, undefined], ["selectAll", "Select all", true],
    ]);
    // The menu may take the keyboard: the box doesn't close under it, and keeps the keyboard once it closes.
    vi.useFakeTimers();
    win.emit("blur");
    expect(win.visible).toBe(true);
    win.emit("focus");
    const focused = win.focused;
    menus[0].popup!.callback!();
    vi.advanceTimersByTime(500);
    expect(win.focused).toBe(focused);
    expect(win.visible).toBe(true);
    // Past the handover after the box was shown: a blur now is the user clicking away.
    vi.advanceTimersByTime(1500);
    win.emit("blur");
    expect(win.visible).toBe(false);
  });

  it("stays open when the keyboard is taken back while the box is still being handed it", () => {
    vi.useFakeTimers();
    const taken: number[] = [];
    const ask = new AskWindow({ takeFocus: id => taken.push(id) });
    ask.show({ x: 400, y: 300 });
    const [win] = made;
    win.emit("ready-to-show");
    const focused = win.focused;
    win.isFocused = () => false;
    win.emit("blur");
    expect(win.visible).toBe(true);
    vi.advanceTimersByTime(0);
    expect(win.focused).toBe(focused + 1);
    expect(taken).toEqual([0x3a00007, 0x3a00007]);
    expect(win.visible).toBe(true);
    vi.advanceTimersByTime(1500);
    win.emit("blur");
    expect(win.visible).toBe(false);
  });

  /** A box with its right-click menu up; `focused` is whether it has the keyboard when the menu has closed. */
  function withMenu(focused: () => boolean) {
    vi.useFakeTimers();
    const ask = new AskWindow();
    ask.show({ x: 400, y: 500 });
    const [win] = made;
    win.emit("ready-to-show");
    win.isFocused = () => win.visible && focused();
    win.contents.get("context-menu")!({}, { editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
    return { win, closeMenu: () => menus[menus.length - 1].popup!.callback!() };
  }

  it("goes away, instead of taking the keyboard back, when the user dismissed its menu by clicking another app (review #77)", () => {
    // The click on the other app took the keyboard while the menu was up: a blur, and no focus since.
    const { win, closeMenu } = withMenu(() => false);
    win.emit("blur");
    const focused = win.focused;
    closeMenu();
    vi.advanceTimersByTime(500);
    expect(win.visible).toBe(false);
    expect(win.focused).toBe(focused);
  });

  it("goes away when that click's blur comes just after the menu has closed (review #77)", () => {
    const { win, closeMenu } = withMenu(() => false);
    const focused = win.focused;
    closeMenu();
    win.emit("blur");
    vi.advanceTimersByTime(500);
    expect(win.visible).toBe(false);
    expect(win.focused).toBe(focused);
  });

  it("takes the keyboard back when the menu closed and nothing else took it", () => {
    const { win, closeMenu } = withMenu(() => false);
    const focused = win.focused;
    closeMenu();
    vi.advanceTimersByTime(500);
    expect(win.visible).toBe(true);
    expect(win.focused).toBe(focused + 1);
  });
});
