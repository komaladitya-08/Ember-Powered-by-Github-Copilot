/**
 * The desk mini-view's control logic (take over, hand back, held keys, hiding)
 * with a stand-in for Electron: no window is shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { DeskPlace } from "../../app/main/desk/place";
import type { Logger } from "../../app/main/logger";

const h = vi.hoisted(() => ({ ipc: null as unknown as import("node:events").EventEmitter, windows: [] as unknown[] }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  h.ipc = new EventEmitter();
  class BrowserWindow extends EventEmitter {
    destroyed = false;
    visible = false;
    focused = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    sent: [string, unknown][] = [];
    webContents = { send: (ch: string, v: unknown) => this.sent.push([ch, v]) };
    constructor(o: { width: number; height: number; x: number; y: number }) { super(); this.bounds = { x: o.x, y: o.y, width: o.width, height: o.height }; h.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    ignoreMouse = false;
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(on: boolean) { this.ignoreMouse = on; }
    loadFile() { return Promise.resolve(); }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    isFocused() { return this.focused; }
    getBounds() { return this.bounds; }
    setBounds(b: typeof this.bounds) { this.bounds = b; }
    close() { this.destroyed = true; this.visible = false; this.emit("closed"); }
  }
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    BrowserWindow,
    ipcMain: { on: (ch: string, fn: (...a: unknown[]) => void) => h.ipc.on(ch, fn) },
    screen: { getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) },
  };
});

const { DeskView } = await import("../../app/main/desk/view");
const { DESK } = await import("../../app/shared/desk");

type Win = EventEmitter & { visible: boolean; sent: [string, unknown][]; webContents: object; close(): void; bounds: { x: number; width: number }; ignoreMouse: boolean };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/** The fake keyboard's keycode for a keysym. */
const kc = (sym: number) => (sym % 200) + 8;
const SYM = { Control_L: 0xffe3, Alt_L: 0xffe9, Shift_L: 0xffe1, Shift_R: 0xffe2, Escape: 0xff1b, End: 0xff57, Return: 0xff0d } as Record<string, number>;
/** The desk's US keys for the characters the tests type: [keycode, needs Shift]. ü has none: it gets spare key 200. */
const US: Record<number, [number, boolean | null]> = {
  0x2f: [61, false], 0x3f: [61, true], 0x3d: [21, false], 0x2b: [21, true], 0x40: [11, true], 0x32: [11, false], 0x31: [10, false], 0x21: [10, true],
  0x61: [38, false], 0x41: [38, true], 0x7a: [52, false], 0x5a: [52, true], 0x62: [56, false], 0x63: [54, false], 0x78: [53, false],
};

function fakePlace() {
  const log: string[] = [];
  let dead = false;
  const deadFns: (() => void)[] = [];
  const name = (code: number) => Object.entries(SYM).find(([, s]) => kc(s) === code)?.[0] ?? String(code);
  const place = {
    info: { display: ":120", width: 1280, height: 800, env: {}, handOff: "/h" },
    input: {
      move: (x: number, y: number) => log.push(`move ${x},${y}`),
      button: (b: number, down: boolean) => log.push(`button ${b} ${down ? "down" : "up"}`),
      keysymOf: (n: string) => SYM[n] ?? 0,
      keycodeOf: (sym: number) => (US[sym]?.[0] ?? (sym ? kc(sym) : 0)),
      keycode: (code: number, down: boolean) => log.push(`key ${name(code)} ${down ? "down" : "up"}`),
    },
    keys: {
      key: (sym: number) => { log.push(`lookup ${sym.toString(16)}`); const k = US[sym]; return k ? { code: k[0], shift: k[1] } : sym === 0xfc ? { code: 200, shift: null } : null; },
      restore: () => log.push("restore"),
    },
    snapshot: async () => null,
    x11: { capture: () => null, activeWindow: () => null },
    get dead() { return dead; },
    onDead: (fn: () => void) => { deadFns.push(fn); },
    kill: () => { dead = true; for (const fn of deadFns) fn(); },
  };
  return { place: place as unknown as DeskPlace & { kill(): void }, log };
}

describe("desk view", () => {
  let control: boolean[];
  let view: InstanceType<typeof DeskView>;
  let win: Win;
  const send = (ch: string, ...args: unknown[]) => h.ipc.emit(ch, { sender: win.webContents }, ...args);
  const key = (k: string, code: string, down: boolean) => send(DESK.input, { type: "key", key: k, code, down });

  beforeEach(() => {
    vi.useFakeTimers();
    h.ipc.removeAllListeners();
    h.windows.length = 0;
    control = [];
    view = new DeskView(quiet, on => control.push(on), { lingerMs: 1000 });
  });
  afterEach(() => vi.useRealTimers());

  const open = () => {
    const p = fakePlace();
    view.show(p.place);
    win = h.windows.at(-1) as Win;
    win.emit("ready-to-show");
    return p;
  };

  it("hands control back when the view is closed while the user has it", () => {
    open();
    send(DESK.takeOver);
    expect(view.userInControl).toBe(true);
    win.close();
    expect(view.userInControl).toBe(false);
    expect(control).toEqual([true, false]);
  });

  it("grows clear of Ember's handle where it really is, and keeps clear when the handle changes", () => {
    // A 360 px card whose left edge is at 1100 (a narrow handle's place would leave the view its full 980 px).
    let handle: { x: number; y: number; width: number; height: number } | null = { x: 1100, y: 930, width: 360, height: 138 };
    view = new DeskView(quiet, on => control.push(on), { lingerMs: 1000, handleBounds: () => handle });
    open();
    send(DESK.takeOver);
    const right = () => win.bounds.x + win.bounds.width;
    expect(right()).toBeLessThanOrEqual(1100 - 12);
    expect(win.bounds.width).toBeGreaterThan(340);
    // The card moves further in (another card size, another place): the enlarged view keeps clear of it.
    handle = { x: 800, y: 930, width: 360, height: 138 };
    view.handleMoved();
    expect(right()).toBeLessThanOrEqual(800 - 12);
    // Unknown: room for the pill in the corner.
    handle = null;
    view.handleMoved();
    expect(win.bounds.width).toBe(980);
  });

  it("always tells the page which mode it is in", () => {
    open();
    send(DESK.handBack);
    send(DESK.handBack);
    expect(win.sent.filter(([ch]) => ch === DESK.mode)).toEqual([[DESK.mode, { control: false }], [DESK.mode, { control: false }]]);
    expect(control).toEqual([]);
  });

  it("lets go of every key and button the user held on hand back, hide, blur or the page asking", () => {
    const { log } = open();
    send(DESK.takeOver);
    send(DESK.input, { type: "button", button: 0, down: true, x: 10, y: 20 });
    key("Shift", "ShiftLeft", true);
    key("A", "KeyA", true);
    log.length = 0;
    // Shift let go first: "A" comes up as "a", but the same key goes up.
    key("Shift", "ShiftLeft", false);
    key("a", "KeyA", false);
    expect(log).toEqual(["key Shift_L up", "key 38 up"]);
    key("b", "KeyB", true);
    log.length = 0;
    view.handBack();
    expect(log).toEqual(["button 1 up", "key 56 up"]);

    for (const letGo of [() => win.emit("blur"), () => send(DESK.release), () => view.hide()]) {
      if (!view.userInControl) send(DESK.takeOver);
      key("c", "KeyC", true);
      log.length = 0;
      letGo();
      expect(log).toEqual(["key 54 up"]);
    }
  });

  it("maps back/forward buttons and both scroll directions", () => {
    const { log } = open();
    send(DESK.takeOver);
    log.length = 0;
    send(DESK.input, { type: "button", button: 3, down: true, x: 1, y: 1 });
    send(DESK.input, { type: "button", button: 3, down: false, x: 1, y: 1 });
    send(DESK.input, { type: "wheel", dx: 1, dy: 0, x: 1, y: 1 });
    send(DESK.input, { type: "wheel", dx: 0, dy: 0, x: 1, y: 1 });
    expect(log.filter(l => l.startsWith("button"))).toEqual(["button 8 down", "button 8 up", "button 7 down", "button 7 up"]);
  });

  it("hands back on Ctrl+Alt+End or Ctrl+Alt+Esc, which never reach the desk", () => {
    const { log } = open();
    for (const [k, code] of [["End", "End"], ["Escape", "Escape"]]) {
      send(DESK.takeOver);
      key("Control", "ControlLeft", true);
      key("Alt", "AltLeft", true);
      log.length = 0;
      key(k, code, true);
      expect(view.userInControl).toBe(false);
      // Ctrl and Alt are let go on the desk; the reserved key was never pressed there.
      expect(log).toEqual(["key Alt_L up", "key Control_L up"]);
    }
  });

  it("gives the keyboard back to the user's window on hand back, unless they already went elsewhere", () => {
    const given: string[] = [];
    let n = 0;
    view = new DeskView(quiet, () => undefined, { userFocus: () => { const id = ++n; given.push(`took ${id}`); return () => given.push(`back ${id}`); } });
    open();
    const w = win as Win & { focused: boolean };
    send(DESK.takeOver);
    expect(w.focused).toBe(true);
    send(DESK.handBack);
    // The user clicked into another window while in control: theirs to keep.
    send(DESK.takeOver);
    w.focused = false;
    send(DESK.handBack);
    // Handed back by the kill switch with the view focused, then nothing left to give back.
    send(DESK.takeOver);
    w.focused = true;
    view.handBack();
    view.handBack();
    expect(given).toEqual(["took 1", "back 1", "took 2", "took 3", "back 3"]);
  });

  it("stays up while any desk task works, and hides a little after the last one (or after the user hands back)", () => {
    const a = fakePlace().place;
    view.show(a);
    win = h.windows.at(-1) as Win;
    win.emit("ready-to-show");
    view.show(a); // a second task on the desk
    view.leave();
    vi.advanceTimersByTime(5000);
    expect(win.visible).toBe(true);
    send(DESK.takeOver);
    view.leave();
    vi.advanceTimersByTime(5000);
    expect(win.visible).toBe(true); // the user is using it
    send(DESK.handBack);
    vi.advanceTimersByTime(999);
    expect(win.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(win.visible).toBe(false);
  });

  it("types the characters the user's layout makes, with the Shift the desk's keyboard needs for them", () => {
    const { log } = open();
    send(DESK.takeOver);
    log.length = 0;
    // German: Shift+7 is "/", which needs no Shift on the desk: Shift goes up around it.
    key("Shift", "ShiftLeft", true);
    key("/", "Digit7", true);
    key("/", "Digit7", false);
    // Shift+0 is "=" (no Shift on the desk either); then Shift is let go.
    key("=", "Digit0", true);
    key("=", "Digit0", false);
    key("Shift", "ShiftLeft", false);
    expect(log.filter(l => !l.startsWith("lookup"))).toEqual([
      "key Shift_L down", "key Shift_L up", "key 61 down", "key Shift_L down", "key 61 up",
      "key Shift_L up", "key 21 down", "key Shift_L down", "key 21 up", "key Shift_L up",
    ]);
    log.length = 0;
    // AltGr+Q is "@": AltGr itself sends nothing, and "@" needs Shift on the desk.
    key("AltGraph", "AltRight", true);
    key("@", "KeyQ", true);
    key("@", "KeyQ", false);
    key("AltGraph", "AltRight", false);
    // French Shift+& is "1", which needs no Shift.
    key("Shift", "ShiftLeft", true);
    key("1", "Digit1", true);
    key("1", "Digit1", false);
    key("Shift", "ShiftLeft", false);
    // Caps Lock sends nothing: the letters arrive as the user's keyboard makes them.
    key("CapsLock", "CapsLock", true);
    key("CapsLock", "CapsLock", false);
    key("A", "KeyA", true);
    key("A", "KeyA", false);
    expect(log.filter(l => !l.startsWith("lookup"))).toEqual([
      "key Shift_L down", "key 11 down", "key Shift_L up", "key 11 up",
      "key Shift_L down", "key Shift_L up", "key 10 down", "key Shift_L down", "key 10 up", "key Shift_L up",
      "key Shift_L down", "key 38 down", "key Shift_L up", "key 38 up",
    ]);
  });

  it("puts characters the desk's keyboard lacks on a spare key, and gives it back a while after hand back", () => {
    const { log } = open();
    send(DESK.takeOver);
    log.length = 0;
    key("ü", "BracketLeft", true);
    key("ü", "BracketLeft", false);
    expect(log).toEqual(["lookup fc", "key 200 down", "key 200 up"]);
    send(DESK.handBack);
    vi.advanceTimersByTime(1999);
    expect(log).not.toContain("restore");
    vi.advanceTimersByTime(1);
    expect(log.at(-1)).toBe("restore");
  });

  it("sends shortcuts by key: Ctrl+Z on a German keyboard is Ctrl+Z", () => {
    const { log } = open();
    send(DESK.takeOver);
    log.length = 0;
    key("Control", "ControlLeft", true);
    key("z", "KeyY", true);
    key("z", "KeyY", false);
    key("Control", "ControlLeft", false);
    expect(log).toEqual(["key Control_L down", "key 52 down", "key 52 up", "key Control_L up"]);
  });

  it("keeps the view for the tasks on the desk it shows: a task leaving a desk that died doesn't hide it", () => {
    const a = fakePlace();
    view.show(a.place);
    win = h.windows.at(-1) as Win;
    win.emit("ready-to-show");
    view.show(a.place); // task B on the same desk
    a.place.kill(); // the desk dies with both tasks on it
    expect(win.visible).toBe(false);
    const b = fakePlace();
    view.show(b.place); // task B starts a new desk
    expect(win.visible).toBe(true);
    view.leave(a.place); // task A ends: it was on the old desk
    vi.advanceTimersByTime(5000);
    expect(win.visible).toBe(true);
    view.leave(b.place);
    vi.advanceTimersByTime(1000);
    expect(win.visible).toBe(false);
  });

  it("lets clicks through and can't be taken over while Ember moves the user's own mouse", () => {
    const { log } = open();
    view.setDriving(true);
    expect(win.ignoreMouse).toBe(true);
    send(DESK.takeOver);
    expect(view.userInControl).toBe(false);
    send(DESK.input, { type: "button", button: 0, down: true, x: 1, y: 1 });
    expect(log).toEqual([]);
    view.setDriving(false);
    expect(win.ignoreMouse).toBe(false);
    send(DESK.takeOver);
    expect(view.userInControl).toBe(true);
    // A view opened while Ember drives lets clicks through from the start.
    view.setDriving(true);
    win.close();
    view.show(fakePlace().place);
    expect((h.windows.at(-1) as Win).ignoreMouse).toBe(true);
  });

  it("lets go of the desk when it dies", () => {
    const p = open();
    send(DESK.takeOver);
    key("x", "KeyX", true);
    p.log.length = 0;
    p.place.kill();
    expect(view.userInControl).toBe(false);
    expect(control).toEqual([true, false]);
    expect(win.visible).toBe(false);
    expect(p.log).toEqual([]); // nothing sent to a dead display
    send(DESK.takeOver);
    expect(view.userInControl).toBe(false);
  });
});
