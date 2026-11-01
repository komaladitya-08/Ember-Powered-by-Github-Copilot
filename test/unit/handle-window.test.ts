/**
 * Ember's corner handle/card: the fallback card grows upward within its limits, a state sent before the page has
 * loaded is replayed, and destroying it takes its display listeners with it (no leak across compositor switches).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OVERLAY } from "../../app/shared/overlay";

const made: FakeWin[] = [];
const screenHandlers = new Map<string, (() => void)[]>();
const workArea = { x: 100, y: 50, width: 1280, height: 800 };

interface Sent { channel: string; args: unknown[] }
interface FakeWin {
  options: Record<string, unknown>;
  bounds: { x: number; y: number; width: number; height: number };
  sent: Sent[];
  shown: number;
  destroyed: boolean;
  emitWebContents(event: string): void;
  webContents: { on(e: string, fn: () => void): void; send(ch: string, ...args: unknown[]): void; isDestroyed(): boolean };
  setAlwaysOnTop(): void;
  setVisibleOnAllWorkspaces(): void;
  loadURL(): Promise<void>;
  showInactive(): void;
  setIgnoreMouseEvents(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
  isDestroyed(): boolean;
  destroy(): void;
}

vi.mock("electron", () => {
  class BrowserWindow implements FakeWin {
    options: Record<string, unknown>;
    bounds: { x: number; y: number; width: number; height: number };
    sent: Sent[] = [];
    shown = 0;
    destroyed = false;
    private handlers = new Map<string, (() => void)[]>();
    webContents = {
      on: (e: string, fn: () => void) => { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); },
      send: (channel: string, ...args: unknown[]) => { this.sent.push({ channel, args }); },
      isDestroyed: () => this.destroyed,
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.bounds = { x: Number(options.x), y: Number(options.y), width: Number(options.width), height: Number(options.height) };
      made.push(this);
    }
    emitWebContents(event: string): void { for (const fn of this.handlers.get(event) ?? []) fn(); }
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    loadURL(): Promise<void> { return Promise.resolve(); }
    showInactive(): void { this.shown++; }
    setIgnoreMouseEvents(): void {}
    getBounds() { return this.bounds; }
    setBounds(b: { x: number; y: number; width: number; height: number }): void { this.bounds = { ...b }; }
    isDestroyed(): boolean { return this.destroyed; }
    destroy(): void { this.destroyed = true; }
  }
  return {
    BrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ id: 1, bounds: workArea, workArea }),
      on: (e: string, fn: () => void) => { screenHandlers.set(e, [...(screenHandlers.get(e) ?? []), fn]); },
      off: (e: string, fn: () => void) => { screenHandlers.set(e, (screenHandlers.get(e) ?? []).filter(f => f !== fn)); },
    },
  };
});

const { HandleWindow } = await import("../../app/main/handle");

const settings = { size: "medium" } as never;

afterEach(() => {
  made.length = 0;
  screenHandlers.clear();
});

describe("the handle window", () => {
  it("has a pill with a compositor and a card without one, in the corner of the work area", () => {
    const pill = new HandleWindow(() => settings, false);
    const pillWin = pill.win as unknown as FakeWin;
    expect(pillWin.options.width).toBe(200);
    expect(pillWin.options.height).toBe(56);
    expect(pillWin.options.transparent).toBe(true);
    expect(pillWin.bounds).toEqual({ x: 1168, y: 782, width: 200, height: 56 });

    const card = new HandleWindow(() => settings, true);
    const cardWin = card.win as unknown as FakeWin;
    expect(cardWin.options.width).toBe(360);
    expect(cardWin.options.height).toBe(150);
    expect(cardWin.options.transparent).toBe(false);
    expect(cardWin.bounds).toEqual({ x: 1008, y: 688, width: 360, height: 150 });
  });

  it("grows the fallback card upward, keeping between its limits, and leaves the pill alone", () => {
    const card = new HandleWindow(() => settings, true);
    const cardWin = card.win as unknown as FakeWin;
    card.fit(999);
    expect(cardWin.bounds).toEqual({ x: 1008, y: 478, width: 360, height: 360 });
    card.fit(0);
    expect(cardWin.bounds).toEqual({ x: 1008, y: 718, width: 360, height: 120 });
    card.fit(Number.NaN);
    expect(cardWin.bounds.height).toBe(120);

    const pill = new HandleWindow(() => settings, false);
    pill.fit(300);
    expect((pill.win as unknown as FakeWin).bounds).toEqual({ x: 1168, y: 782, width: 200, height: 56 });
  });

  it("lets the card grow taller while a question shows a whole text, within the work area, and back once it goes (review #116)", () => {
    const card = new HandleWindow(() => settings, true);
    const cardWin = card.win as unknown as FakeWin;
    const asking = (whole: boolean) => ({
      emotion: "curious", talking: false, status: null, tasks: [],
      bubble: { visible: true, mood: "attention", title: "May I?", thought: "Type …?", step: null, streaming: false, actions: [], ...(whole ? { whole: { n: 1, text: "Dear team, …", seen: false, page: 0 } } : {}) },
    }) as never;
    card.sendState(asking(true));
    card.fit(514);
    expect(cardWin.bounds).toEqual({ x: 1008, y: 324, width: 360, height: 514 });
    // 640 at most (it holds the sentence, the block and the rest at the largest text size).
    card.fit(999);
    expect(cardWin.bounds).toEqual({ x: 1008, y: 198, width: 360, height: 640 });
    // The question gone: back within the usual limit at once, whatever the page asks next.
    card.sendState(asking(false));
    expect(cardWin.bounds).toEqual({ x: 1008, y: 478, width: 360, height: 360 });
    card.fit(514);
    expect(cardWin.bounds.height).toBe(360);
    // A work area too short for 640 (less 12 px above and below), and never under the usual limit.
    const usual = { ...workArea };
    workArea.height = 500;
    try {
      card.sendState(asking(true));
      card.fit(999);
      expect(cardWin.bounds.height).toBe(476);
      workArea.height = 300;
      card.fit(998);
      expect(cardWin.bounds.height).toBe(360);
    } finally { Object.assign(workArea, usual); }
  });

  it("shrinks the pill to a tab with Ember's face while Ember is hidden, in the same corner, and never the card (review #75)", () => {
    const pill = new HandleWindow(() => settings, false);
    const win = pill.win as unknown as FakeWin;
    expect(pill.setCompact(true)).toBe(true);
    expect(win.bounds).toEqual({ x: 1312, y: 782, width: 56, height: 56 });
    expect(pill.setCompact(true)).toBe(false);
    expect(pill.setCompact(false)).toBe(true);
    expect(win.bounds).toEqual({ x: 1168, y: 782, width: 200, height: 56 });

    const card = new HandleWindow(() => settings, true);
    expect(card.setCompact(true)).toBe(false);
    expect((card.win as unknown as FakeWin).bounds).toEqual({ x: 1008, y: 688, width: 360, height: 150 });
  });

  it("replays a state sent before the page loaded, then shows the window without taking focus", () => {
    const handle = new HandleWindow(() => settings, false);
    const win = handle.win as unknown as FakeWin;
    const state = { emotion: "neutral", talking: false, status: null, bubble: null } as never;
    handle.sendState(state);
    expect(win.sent.map(s => s.channel)).toEqual([OVERLAY.state]);

    win.emitWebContents("did-finish-load");
    expect(win.sent.map(s => s.channel)).toEqual([OVERLAY.state, OVERLAY.init, OVERLAY.state]);
    expect(win.sent[1].args[0]).toMatchObject({ fallback: false, settings });
    expect(win.sent[2].args[0]).toBe(state);
    expect(win.shown).toBe(1);
  });

  it("widens the pill with the text size, so its words aren't cut, and moves it along its corner when that changes (review #57)", () => {
    let now = { size: "medium", textSize: "larger" } as never;
    const pill = new HandleWindow(() => now, false);
    const win = pill.win as unknown as FakeWin;
    // 200 × 1.3; still 56 px high (its two lines fit at every size), 12 px in from the corner.
    expect(win.options.width).toBe(260);
    expect(win.bounds).toEqual({ x: 1108, y: 782, width: 260, height: 56 });
    now = { size: "medium", textSize: "large" } as never;
    expect(pill.sendSettings(now)).toBe(true);
    expect(win.bounds).toEqual({ x: 1138, y: 782, width: 230, height: 56 });
    // Another setting: it stays where it is.
    expect(pill.sendSettings(now)).toBe(false);
    now = { size: "medium", textSize: "default" } as never;
    expect(pill.sendSettings(now)).toBe(true);
    expect(win.bounds).toEqual({ x: 1168, y: 782, width: 200, height: 56 });
    // The card keeps its width (its words wrap) and grows to what it shows, as before.
    const card = new HandleWindow(() => ({ size: "medium", textSize: "larger" }) as never, true);
    expect((card.win as unknown as FakeWin).bounds).toEqual({ x: 1008, y: 688, width: 360, height: 150 });
    expect(card.sendSettings({ size: "medium", textSize: "default" } as never)).toBe(false);
  });

  it("keeps the tab its size while Ember is hidden, and shows the pill at the new text size again (reviews #75, #57)", () => {
    let now = { size: "medium", textSize: "default" } as never;
    const pill = new HandleWindow(() => now, false);
    const win = pill.win as unknown as FakeWin;
    pill.setCompact(true);
    now = { size: "medium", textSize: "larger" } as never;
    expect(pill.sendSettings(now)).toBe(false);
    expect(win.bounds).toEqual({ x: 1312, y: 782, width: 56, height: 56 });
    expect(pill.setCompact(false)).toBe(true);
    expect(win.bounds).toEqual({ x: 1108, y: 782, width: 260, height: 56 });
    expect(pill.sendSettings(now)).toBe(false);
  });

  it("sits in the bottom-left corner of the work area with Handle position set so: the pill, the tab and the card (review #75)", () => {
    const left = { size: "medium", handlePosition: "bottom-left" } as never;
    const pill = new HandleWindow(() => left, false);
    const win = pill.win as unknown as FakeWin;
    // The work area starts at 100, 50 (a taskbar on the left, a panel on top): 12 px in from its left and bottom edges.
    expect(win.options).toMatchObject({ x: 112, y: 782 });
    expect(win.bounds).toEqual({ x: 112, y: 782, width: 200, height: 56 });
    // Hidden: the tab with Ember's face stays in that corner.
    pill.setCompact(true);
    expect(win.bounds).toEqual({ x: 112, y: 782, width: 56, height: 56 });
    pill.setCompact(false);
    expect(win.bounds).toEqual({ x: 112, y: 782, width: 200, height: 56 });

    const card = new HandleWindow(() => left, true);
    const cardWin = card.win as unknown as FakeWin;
    expect(cardWin.bounds).toEqual({ x: 112, y: 688, width: 360, height: 150 });
    card.fit(999);
    expect(cardWin.bounds).toEqual({ x: 112, y: 478, width: 360, height: 360 });
  });

  it("moves to the other corner when the setting changes, in every form, and says it moved (review #75)", () => {
    let now = { size: "medium", handlePosition: "bottom-right" } as never;
    const pill = new HandleWindow(() => now, false);
    const win = pill.win as unknown as FakeWin;
    expect(win.bounds).toEqual({ x: 1168, y: 782, width: 200, height: 56 });
    now = { size: "medium", handlePosition: "bottom-left" } as never;
    expect(pill.sendSettings(now)).toBe(true);
    expect(win.bounds).toEqual({ x: 112, y: 782, width: 200, height: 56 });
    // The page hears the settings either way; nothing else changed: it stays.
    expect(win.sent.at(-1)).toEqual({ channel: OVERLAY.settings, args: [now] });
    expect(pill.sendSettings(now)).toBe(false);

    // The tab (Ember hidden) moves too, and the pill comes back on its new side.
    pill.setCompact(true);
    now = { size: "medium", handlePosition: "bottom-right" } as never;
    expect(pill.sendSettings(now)).toBe(true);
    expect(win.bounds).toEqual({ x: 1312, y: 782, width: 56, height: 56 });
    pill.setCompact(false);
    expect(win.bounds).toEqual({ x: 1168, y: 782, width: 200, height: 56 });

    // The card (no compositor) moves, at the height it has grown to.
    let cardNow = { size: "medium" } as never;
    const card = new HandleWindow(() => cardNow, true);
    const cardWin = card.win as unknown as FakeWin;
    card.fit(200);
    cardNow = { size: "medium", handlePosition: "bottom-left" } as never;
    expect(card.sendSettings(cardNow)).toBe(true);
    expect(cardWin.bounds).toEqual({ x: 112, y: 638, width: 360, height: 200 });
  });

  it("follows the work area when it changes (a taskbar moved, a display added), on its own side", () => {
    const pill = new HandleWindow(() => ({ size: "medium", handlePosition: "bottom-left" }) as never, false);
    const win = pill.win as unknown as FakeWin;
    const was = { ...workArea };
    Object.assign(workArea, { x: 0, y: 0, width: 1920, height: 1040 });
    try {
      for (const fn of screenHandlers.get("display-metrics-changed") ?? []) fn();
      expect(win.bounds).toEqual({ x: 12, y: 972, width: 200, height: 56 });
    } finally {
      Object.assign(workArea, was);
    }
  });

  it("is moved by main when the text size changes it, with the desk view beside it", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/if \(handle\?\.sendSettings\(s\)\) deskViewRef\?\.handleMoved\(\);/);
  });

  it("is the pill again whenever main shows a hidden Ember: for a question, for an answer, from the menu (cross-review X6)", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    // Every place main shows or hides Ember after the overlay exists (not makeOverlay's first setHidden) syncs the handle
    // in the same statement; showState does it on its own next lines, after its setHidden(true).
    const calls = [...main.matchAll(/overlay\??\.setHidden\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      const line = main.slice(main.lastIndexOf("\n", c.index!) + 1, main.indexOf("\n", c.index!));
      const inShowState = line.endsWith("keptHidden = true; overlay?.setHidden(true); }") && main.slice(c.index!, c.index! + 300).includes("syncHandle();");
      expect(inShowState || line.includes("syncHandle()"), line).toBe(true);
    }
    // Named: a question that brings a hidden Ember back, and an answer asked for while Ember was hidden.
    expect(main).toContain("if (overlay?.isHidden()) { overlay.setHidden(false); syncHandle(); presenceChanged(); }");
    expect(main).toMatch(/shownForAnswer = true; overlay\?\.setHidden\(false\); syncHandle\(\); \}/);
  });

  it("takes its display listeners with it when destroyed, and stops sending to it", () => {
    const handle = new HandleWindow(() => settings, true);
    const win = handle.win as unknown as FakeWin;
    expect(screenHandlers.get("display-metrics-changed")).toHaveLength(1);
    expect(screenHandlers.get("display-removed")).toHaveLength(1);

    handle.destroy();
    expect(win.destroyed).toBe(true);
    expect(screenHandlers.get("display-metrics-changed")).toHaveLength(0);
    expect(screenHandlers.get("display-removed")).toHaveLength(0);

    const before = win.sent.length;
    handle.sendState({} as never);
    handle.sendSettings(settings);
    expect(win.sent).toHaveLength(before);
  });
});
