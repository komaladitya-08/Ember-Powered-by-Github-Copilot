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
    setAlwaysOnTop() {}
    loadFile() { return Promise.resolve(); }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
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

type Win = EventEmitter & { visible: boolean; sent: [string, unknown][]; webContents: object; close(): void; bounds: { width: number } };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/** The fake keyboard's keycode for a keysym. */
const kc = (sym: number) => (sym % 200) + 8;
const SYM = { Control_L: 0xffe3, Alt_L: 0xffe9, Shift_L: 0xffe1, Escape: 0xff1b, End: 0xff57 } as Record<string, number>;

function fakePlace() {
  const log: string[] = [];
  let dead = false;
  const deadFns: (() => void)[] = [];
  const place = {
    info: { display: ":120", width: 1280, height: 800, env: {}, handOff: "/h" },
    input: {
      move: (x: number, y: number) => log.push(`move ${x},${y}`),
      button: (b: number, down: boolean) => log.push(`button ${b} ${down ? "down" : "up"}`),
      keysymOf: (n: string) => SYM[n] ?? 0,
      keycodeOf: (sym: number) => (sym ? kc(sym) : 0),
      keycode: (code: number, down: boolean) => log.push(`key ${code} ${down ? "down" : "up"}`),
    },
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
    expect(log).toEqual([`key ${kc(SYM.Shift_L)} up`, `key ${kc(0x41)} up`]);
    key("b", "KeyB", true);
    log.length = 0;
    view.handBack();
    expect(log).toEqual(["button 1 up", `key ${kc(0x62)} up`]);

    for (const letGo of [() => win.emit("blur"), () => send(DESK.release), () => view.hide()]) {
      if (!view.userInControl) send(DESK.takeOver);
      key("c", "KeyC", true);
      log.length = 0;
      letGo();
      expect(log).toEqual([`key ${kc(0x63)} up`]);
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
      expect(log).toEqual([`key ${kc(SYM.Alt_L)} up`, `key ${kc(SYM.Control_L)} up`]);
    }
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
