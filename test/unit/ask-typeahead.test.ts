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

describe("the ask box's tip to wait for it (review #78, owner decision D-78)", () => {
  it("shows the first five times the box opens where Ember can't hold the letters typed meanwhile, never on Linux", async () => {
    const { WAIT_TIP_OPENINGS, showsWaitTip } = await import("../../app/main/ask");
    expect(WAIT_TIP_OPENINGS).toBe(5);
    expect(showsWaitTip(false, 0)).toBe(true);
    expect(showsWaitTip(false, 4)).toBe(true);
    expect(showsWaitTip(false, 5)).toBe(false);
    // Linux holds the keyboard while the box opens and hands the letters to it.
    expect(showsWaitTip(true, 0)).toBe(false);
  });

  it("says in plain words to wait for the box, and where letters typed sooner go", async () => {
    const { WAIT_TIP } = await import("../../app/renderer/ask/field");
    expect(WAIT_TIP).toBe("Wait for this box before you type: letters typed sooner go to the app underneath.");
  });

  it("opens a row taller while it says so, growing away from Ember, and fits the field's lines and the note under it", () => {
    const { ask, win } = ready();
    ask.show({ x: 400, y: 500 }, { sees: null, history: [], tip: true }, "hotkey");
    const tall = { ...win.bounds };
    ask.hide();
    ask.show({ x: 400, y: 500 }, { sees: null, history: [] }, "hotkey");
    const one = { ...win.bounds };
    expect(one.height).toBe(92);
    // Above Ember: the hint row stays beside Ember's head, the box grows upward.
    expect(tall).toEqual({ ...one, height: 116, y: one.y - 24 });
    // Four lines, the note that a paste was cut and the tip: six rows.
    win.heard.get("agent:ask-fit")!({}, 6);
    expect(win.bounds.height).toBe(92 + 5 * 24);
  });

  it("is counted by main where the box is shown, and its row by the page", () => {
    const MAIN = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(MAIN).toContain("tip: showsWaitTip(!!platform.keyboardHold, settings.get().askOpened)");
    expect(MAIN).toContain("settings.update({ askOpened: opened + 1 }, { soon: true })");
    const HTML = readFileSync(new URL("../../app/renderer/ask/index.html", import.meta.url), "utf8");
    expect(HTML).toMatch(/<p id="cut" class="cut" role="status" hidden><\/p>\s*(<!--[^>]*-->\s*)?<p id="tip" class="tip" hidden><\/p>/);
    expect(HTML).toMatch(/aria-describedby="where cut tip hint sees"/);
  });
});

describe("the ask box's rows", () => {
  it("are the field's lines, and one each for the note that a paste was cut and the tip to wait for the box", async () => {
    const { boxRows } = await import("../../app/renderer/ask/field");
    expect(boxRows(1, false, false)).toBe(1);
    expect(boxRows(1, false, true)).toBe(2);
    expect(boxRows(4, true, true)).toBe(6);
  });
});

describe("the ask box at the text size (review #57)", () => {
  it("is made, opened and grown as large as its words at the size now, and still opens as it did for typing ahead", () => {
    let scale = 1.3;
    const { ask, win } = ready({ textScale: () => scale, takeFocus: () => events.push("takeFocus") });
    // Made ahead of time at the size then.
    expect(win.bounds).toMatchObject({ width: 728, height: 111 });
    ask.show({ x: 400, y: 500 }, { sees: null, history: [] }, "hotkey");
    expect(win.bounds).toMatchObject({ width: 728, height: 111 });
    // What it shows first, then shown and given the keyboard, exactly as at the default size (review #78).
    expect(events).toEqual(["send agent:ask-context", "show", "focus", "takeFocus"]);
    // Four lines, the note and the tip: five rows of 31.2 px more.
    win.heard.get("agent:ask-fit")!({}, 6);
    expect(win.bounds.height).toBe(111 + 156);
    ask.hide();
    // Changed in Settings while the box was hidden (it closes when Settings takes the keyboard): its next opening is
    // the new size, the tip's row included, growing upward away from Ember.
    scale = 1.15;
    ask.show({ x: 400, y: 500 }, { sees: null, history: [], tip: true }, "hotkey");
    expect(win.bounds).toMatchObject({ width: 644, height: 101 + 28 });
    const tall = { ...win.bounds };
    ask.hide();
    ask.show({ x: 400, y: 500 }, { sees: null, history: [] }, "hotkey");
    expect(win.bounds).toEqual({ ...tall, height: 101, y: tall.y + 28 });
    ask.hide();
    // Back at the default size, the usual box; and a scale that can't be read is the default's.
    scale = 1;
    ask.show({ x: 400, y: 500 }, { sees: null, history: [] }, "hotkey");
    expect(win.bounds).toMatchObject({ width: 560, height: 92 });
    ask.hide();
    const broken = ready({ textScale: () => { throw new Error("settings gone"); } });
    expect(broken.win.bounds).toMatchObject({ width: 560, height: 92 });
  });
});

describe("the count of openings that showed the tip", () => {
  it("is a setting that starts at 0 and a bad value of which is put back to 0", async () => {
    const { DEFAULT_SETTINGS, repairSettings } = await import("../../app/main/settings");
    expect(DEFAULT_SETTINGS.askOpened).toBe(0);
    expect(repairSettings({ askOpened: -1 }).askOpened).toBe(0);
    expect(repairSettings({ askOpened: "many" }).askOpened).toBe(0);
    expect(repairSettings({ askOpened: 3 }).askOpened).toBe(3);
  });
});
