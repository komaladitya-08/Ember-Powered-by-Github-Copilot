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
  loadFile(): Promise<void>;
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
    loadFile(): Promise<void> { return Promise.resolve(); }
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

  it("is moved by main when the text size changes it, with the desk view beside it", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/if \(handle\?\.sendSettings\(s\)\) deskViewRef\?\.handleMoved\(\);/);
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
