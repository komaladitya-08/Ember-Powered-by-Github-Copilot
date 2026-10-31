/**
 * openXInput on a private Xvfb display: the parts the existing tests don't reach — the real screen size, pointer,
 * keys and buttons, focus and activation, the keyboard layout, grabs (another client's, and an app's own menu),
 * which window a click would land in, screen locking, and watching the user's own input (but not Ember's XTest
 * input). A second koffi client of the test's own plays the other program.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { openXInput, xinputError, type XInput } from "../../app/main/hands/input";

const requireCjs = createRequire(import.meta.url);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 1500) => {
  const t0 = Date.now();
  let ok = cond();
  while (!ok && Date.now() - t0 < ms) {
    await sleep(5);
    ok = cond();
  }
  return ok;
};

const CAPS_LOCK = 0xffe5, SHIFT_L = 0xffe1, RETURN = 0xff0d, F4 = 0xffc1;

describe("openXInput without a usable display", () => {
  it("returns null and records why when the X display cannot be opened", () => {
    // On a machine without libX11 this still fails safely; on Linux it is the missing display that fails.
    if (process.platform !== "linux") return;
    expect(openXInput(":987654")).toBeNull();
    expect(xinputError).toBeInstanceOf(Error);
  });
});

/** Whether this machine can run the real-X tests: Linux, Xvfb, and both X libraries, all loadable. */
function xReady(): boolean {
  if (process.platform !== "linux") return false;
  if (spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status !== 0) return false;
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    koffi.load("libX11.so.6");
    koffi.load("libXtst.so.6");
    return true;
  } catch {
    return false;
  }
}

const X_READY = xReady();

function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x = koffi.load("libX11.so.6");
  const xtst = koffi.load("libXtst.so.6");
  return {
    XOpenDisplay: x.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: x.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateSimpleWindow: x.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderPixel, unsigned long background)"),
    XCreateWindow: x.func("unsigned long XCreateWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, int depth, unsigned int cls, void *visual, unsigned long mask, void *attrs)"),
    XDestroyWindow: x.func("int XDestroyWindow(void *dpy, unsigned long w)"),
    XQueryTree: x.func("int XQueryTree(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *n)"),
    XFree: x.func("int XFree(void *data)"),
    XMapWindow: x.func("int XMapWindow(void *dpy, unsigned long w)"),
    XStoreName: x.func("int XStoreName(void *dpy, unsigned long w, const char *name)"),
    XInternAtom: x.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)"),
    XChangeProperty: x.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const uint8_t *data, int n)"),
    XDeleteProperty: x.func("int XDeleteProperty(void *dpy, unsigned long w, unsigned long prop)"),
    XSetInputFocus: x.func("int XSetInputFocus(void *dpy, unsigned long focus, int revertTo, unsigned long time)"),
    XRaiseWindow: x.func("int XRaiseWindow(void *dpy, unsigned long w)"),
    XQueryPointer: x.func("int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)"),
    XQueryKeymap: x.func("int XQueryKeymap(void *dpy, _Out_ uint8_t *keys)"),
    XGrabKeyboard: x.func("int XGrabKeyboard(void *dpy, unsigned long w, int ownerEvents, int pointerMode, int keyboardMode, unsigned long time)"),
    XUngrabKeyboard: x.func("int XUngrabKeyboard(void *dpy, unsigned long time)"),
    XSelectInput: x.func("int XSelectInput(void *dpy, unsigned long w, long mask)"),
    XNextEvent: x.func("int XNextEvent(void *dpy, _Out_ uint8_t *ev)"),
    XSync: x.func("int XSync(void *dpy, int discard)"),
    XKeysymToKeycode: x.func("uint8_t XKeysymToKeycode(void *dpy, unsigned long sym)"),
    XTestFakeMotionEvent: xtst.func("int XTestFakeMotionEvent(void *dpy, int screen, int x, int y, unsigned long delay)"),
    XTestFakeButtonEvent: xtst.func("int XTestFakeButtonEvent(void *dpy, unsigned int button, int isPress, unsigned long delay)"),
    XTestFakeKeyEvent: xtst.func("int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int isPress, unsigned long delay)"),
  };
}

type Lib = ReturnType<typeof xlib>;

type MakeOptions = {
  x?: number; y?: number; w?: number; h?: number;
  title?: string; pid?: number; wmClass?: string; type?: string;
  override?: boolean; parent?: number; transientFor?: number; leader?: number;
};

/** A second X client: it makes windows, moves the pointer, types and clicks, and grabs the keyboard. */
function makeClient(display: string, L: Lib) {
  const dpy = L.XOpenDisplay(display);
  if (!dpy) throw new Error("cannot open the test display");
  const root = Number(L.XDefaultRootWindow(dpy));
  const made: number[] = [];
  let open = true;
  const atom = (name: string) => Number(L.XInternAtom(dpy, name, 0));
  const setInts = (win: number, name: string, type: number, values: number[]) => {
    const b = Buffer.alloc(values.length * 8);
    values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), i * 8));
    L.XChangeProperty(dpy, win, atom(name), type, 32, 0, b, values.length);
  };
  const sync = () => L.XSync(dpy, 0);
  const c = {
    root,
    atom,
    sync,
    setInts,
    deleteProp(win: number, name: string) { L.XDeleteProperty(dpy, win, atom(name)); sync(); },
    make(o: MakeOptions = {}) {
      const parent = o.parent ?? root;
      let id: number;
      if (o.override) {
        const attrs = Buffer.alloc(112);
        attrs.writeInt32LE(1, 88); // XSetWindowAttributes.override_redirect
        id = Number(L.XCreateWindow(dpy, parent, o.x ?? 0, o.y ?? 0, o.w ?? 120, o.h ?? 80, 0, 0, 1 /* InputOutput */, null, 1 << 9 /* CWOverrideRedirect */, attrs));
      } else {
        id = Number(L.XCreateSimpleWindow(dpy, parent, o.x ?? 0, o.y ?? 0, o.w ?? 120, o.h ?? 80, 0, 0, 0xffffff));
      }
      made.push(id);
      if (o.title !== undefined) L.XStoreName(dpy, id, o.title);
      if (o.pid !== undefined) setInts(id, "_NET_WM_PID", atom("CARDINAL"), [o.pid]);
      if (o.wmClass !== undefined) {
        const b = Buffer.from(o.wmClass);
        L.XChangeProperty(dpy, id, atom("WM_CLASS"), atom("STRING"), 8, 0, b, b.length);
      }
      if (o.type !== undefined) setInts(id, "_NET_WM_WINDOW_TYPE", atom("ATOM"), [atom(`_NET_WM_WINDOW_TYPE_${o.type}`)]);
      if (o.transientFor !== undefined) setInts(id, "WM_TRANSIENT_FOR", atom("WINDOW"), [o.transientFor]);
      if (o.leader !== undefined) setInts(id, "WM_CLIENT_LEADER", atom("WINDOW"), [o.leader]);
      L.XMapWindow(dpy, id);
      sync();
      return id;
    },
    destroy(win: number) {
      const i = made.indexOf(win);
      if (i >= 0) made.splice(i, 1);
      L.XDestroyWindow(dpy, win);
      sync();
    },
    raise(win: number) { L.XRaiseWindow(dpy, win); sync(); },
    childrenOf(win: number) {
      sync();
      const r = [0], parent = [0], list: unknown[] = [null], n = [0];
      if (!L.XQueryTree(dpy, win, r, parent, list, n) || !list[0]) return [];
      try {
        const koffi = requireCjs("koffi") as typeof import("koffi");
        const a = koffi.decode(list[0], "uint8_t", n[0] * 8) as Uint8Array;
        const b = Buffer.from(a);
        return Array.from({ length: n[0] }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
      } finally {
        L.XFree(list[0]);
      }
    },
    focus(win: number) { L.XSetInputFocus(dpy, win, 2 /* RevertToParent */, 0 /* CurrentTime */); sync(); },
    selectRoot(mask: number) { L.XSelectInput(dpy, root, mask); sync(); },
    nextEvent() {
      const ev = Buffer.alloc(192);
      L.XNextEvent(dpy, ev);
      return ev;
    },
    pointer() {
      sync();
      const r = [0], child = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0];
      const ok = L.XQueryPointer(dpy, root, r, child, rx, ry, wx, wy, m);
      return ok ? { x: rx[0], y: ry[0], mask: m[0] } : null;
    },
    keysDown() {
      sync();
      const keys = Buffer.alloc(32);
      L.XQueryKeymap(dpy, keys);
      const down: number[] = [];
      for (let i = 0; i < 32; i++) for (let b = 0; b < 8; b++) if (keys[i] & (1 << b)) down.push(i * 8 + b);
      return down;
    },
    movePointer(x: number, y: number) { L.XTestFakeMotionEvent(dpy, -1, x, y, 0); sync(); },
    button(button: number, down: boolean) { L.XTestFakeButtonEvent(dpy, button, down ? 1 : 0, 0); sync(); },
    key(sym: number) {
      const code = Number(L.XKeysymToKeycode(dpy, sym));
      if (!code) return 0;
      L.XTestFakeKeyEvent(dpy, code, 1, 0);
      L.XTestFakeKeyEvent(dpy, code, 0, 0);
      sync();
      return code;
    },
    grabKeyboard() { const status = Number(L.XGrabKeyboard(dpy, root, 0, 1 /* Async */, 1, 0 /* CurrentTime */)); sync(); return status; },
    ungrabKeyboard() { L.XUngrabKeyboard(dpy, 0); sync(); },
    close() {
      if (!open) return;
      open = false;
      // Children are destroyed with their parent: go from the newest (and innermost) to the oldest.
      for (const w of made.splice(0).reverse()) L.XDestroyWindow(dpy, w);
      L.XCloseDisplay(dpy);
    },
  };
  return c;
}

describe.runIf(X_READY)("openXInput on a private Xvfb display", () => {
  let server: ChildProcess | undefined;
  let display = "";
  let L: Lib;
  let x: XInput | undefined;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    server = spawn("Xvfb", ["-displayfd", "3", "-noreset", "-nolisten", "tcp", "-screen", "0", "800x600x24"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    display = ":" + await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Xvfb did not report a display")), 5000);
      server!.stdio[3]!.on("data", (d: Buffer) => {
        buf += d.toString();
        const first = buf.split("\n")[0].trim();
        if (/^\d+$/.test(first)) {
          clearTimeout(timer);
          resolve(first);
        }
      });
      server!.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`Xvfb exited (${code}) before reporting a display`));
      });
    });
    L = xlib();
  }, 10_000);

  afterAll(async () => {
    if (!server || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { server!.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, 2000);
      server!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  beforeEach(() => {
    c = makeClient(display, L);
    // No window manager, no EWMH properties left from an earlier test.
    c.deleteProp(c.root, "_NET_SUPPORTING_WM_CHECK");
    c.deleteProp(c.root, "_NET_ACTIVE_WINDOW");
    c.deleteProp(c.root, "_NET_CLIENT_LIST");
  });

  afterEach(() => {
    x?.close();
    x = undefined;
    c.close();
    vi.useRealTimers();
  });

  const open = (): XInput => {
    x = openXInput(display) ?? undefined;
    expect(x).not.toBeNull();
    return x!;
  };

  it("reports the server's screen size, and zero once closed", () => {
    const i = open();
    expect(i.screenSize()).toEqual({ width: 800, height: 600 });
    i.close();
    expect(i.screenSize()).toEqual({ width: 0, height: 0 });
    expect(i.layout?.()).toBeNull();
  });

  it("moves the real pointer, rounds coordinates, and tracks button and modifier state", async () => {
    const i = open();
    i.move(123.6, 45.2);
    i.sync();
    expect(await pointerUntil(c, 124, 45)).toBe(true);
    expect(i.pointer()).toEqual({ x: 124, y: 45 });
    expect(i.pointerState()).toEqual({ x: 124, y: 45, mask: 0 });

    i.button(1, true);
    i.sync();
    expect(i.pointerState()!.mask & 256 /* Button1Mask */).toBe(256); // the real server saw a left press
    i.button(1, false);
    i.sync();
    expect(i.pointerState()!.mask & 256).toBe(0);
  });

  it("presses and releases keys by keysym and keycode, and releases everything it holds", () => {
    const i = open();
    expect(i.keysymOf("Return")).toBe(RETURN);
    expect(i.keysymOf("F4")).toBe(F4);
    expect(i.keysymOf("NoSuchKey")).toBe(0);
    const a = i.keycodeOf(0x61 /* a */);
    const shift = i.keycodeOf(SHIFT_L);
    expect(a).toBeGreaterThan(0);
    expect(shift).toBeGreaterThan(0);
    expect(i.keycodeOf(0x1000000)).toBe(0);
    expect(i.needsShift(0x41 /* A */)).toBe(true);
    expect(i.needsShift(0x61 /* a */)).toBe(false);
    expect(i.needsShift(RETURN)).toBe(false); // the same keysym at both levels
    expect(i.needsShift(0x1000000)).toBe(false); // no key at all

    expect(i.keysym(0x61, true)).toBe(true);
    expect(i.keysDown()).toContain(a);
    expect(i.keysym(0x61, false)).toBe(true);
    expect(i.keysDown()).not.toContain(a);
    expect(i.keysym(0x1000000, true)).toBe(false);

    i.keycode(a, true);
    i.button(1, true);
    i.sync();
    expect(i.keysDown()).toContain(a);
    expect(i.pointerState()!.mask & 256).toBe(256);
    i.releaseAll();
    expect(i.keysDown()).toEqual([]);
    expect(i.pointerState()!.mask & 256).toBe(0);
  });

  it("ignores keycodes outside the XTest range", () => {
    const i = open();
    const before = i.keysDown();
    i.keycode(7, true);
    i.keycode(256, true);
    i.keycode(0, true);
    i.keycode(300, true);
    i.sync();
    expect(i.keysDown()).toEqual(before);

    const a = i.keycodeOf(0x61);
    expect(a).toBeGreaterThan(0);
    i.keycode(a, true);
    i.sync();
    expect(i.keysDown()).toContain(a); // the process and connection are still alive
    i.keycode(a, false);
    i.sync();
  });

  it("releases held keys and buttons when the connection closes", () => {
    const i = open();
    const a = i.keycodeOf(0x61);
    i.keycode(a, true);
    i.button(1, true);
    i.sync();
    expect(i.keysDown()).toContain(a);
    i.close();
    expect(c.keysDown()).not.toContain(a);
    expect(c.pointer()!.mask & 256).toBe(0);
  });

  it("focuses and activates windows itself without a window manager", () => {
    const i = open();
    const a = c.make({ title: "A", pid: 4101, x: 10, y: 10 });
    const b = c.make({ title: "B", pid: 4102, x: 200, y: 10 });

    c.focus(1 /* PointerRoot */);
    expect(i.activeWindow()).toBe(0);
    expect(i.focusedWindow()).toBe(0);

    i.focusInput!(a);
    i.sync();
    expect(i.focusedWindow()).toBe(a);
    expect(i.activeWindow()).toBe(a);

    c.focus(b);
    expect(i.focusedWindow()).toBe(b);

    i.activate(a); // no WM: raise and focus directly
    i.sync();
    expect(i.focusedWindow()).toBe(a);
    expect(i.activeWindow()).toBe(a);
  });

  it("raises the window when activating without a window manager", async () => {
    const i = open();
    const a = c.make({ title: "A", pid: 5101, x: 100, y: 100, w: 200, h: 150 });
    const b = c.make({ title: "B", pid: 5102, x: 150, y: 150, w: 200, h: 150 });
    c.raise(b);
    const before = c.childrenOf(c.root);
    expect(before.indexOf(a)).toBeLessThan(before.indexOf(b)); // B is above A

    i.move(160, 160); // the overlap
    i.sync();
    expect(await pointerUntil(c, 160, 160)).toBe(true);
    expect(i.pointerOn!(a)).toBe(false); // B gets the click for now

    i.activate(a);
    i.sync();
    expect(await until(() => i.pointerOn!(a) === true)).toBe(true);
    const after = c.childrenOf(c.root);
    expect(after.indexOf(a)).toBeGreaterThan(after.indexOf(b)); // A was raised above B
  });

  it("maps the focused inner window up to the app's client window", () => {
    const i = open();
    const top = c.make({ title: "Top", pid: 4201, x: 10, y: 10 });
    const inner = c.make({ parent: top, title: "Inner", pid: 4201, x: 5, y: 5, w: 40, h: 30 });
    c.focus(inner);
    expect(i.focusedWindow()).toBe(top);
  });

  it("recognizes the top-level that holds an inner child window", async () => {
    const i = open();
    const top = c.make({ title: "Top", pid: 5201, x: 300, y: 300, w: 200, h: 150 });
    const child = c.make({ parent: top, title: "Child", pid: 5201, x: 10, y: 10, w: 40, h: 30 });
    i.move(302, 302); // over the top-level, outside the child
    i.sync();
    expect(await pointerUntil(c, 302, 302)).toBe(true);
    expect(i.pointerOn!(top)).toBe(true);
    expect(i.pointerOn!(child)).toBe(true); // its top-level is the window under the pointer
  });

  it("uses _NET_ACTIVE_WINDOW when a window manager is present, and asks it to activate", () => {
    const i = open();
    const a = c.make({ title: "A", pid: 4301, x: 10, y: 10 });
    const b = c.make({ title: "B", pid: 4302, x: 200, y: 10 });
    c.setInts(c.root, "_NET_SUPPORTING_WM_CHECK", c.atom("WINDOW"), [a]);
    c.setInts(c.root, "_NET_ACTIVE_WINDOW", c.atom("WINDOW"), [b]);
    c.selectRoot(1 << 19 /* SubstructureNotifyMask */);
    expect(i.activeWindow()).toBe(b);

    i.activate(a);
    i.sync();
    const ev = c.nextEvent();
    expect(ev.readInt32LE(0)).toBe(33); // ClientMessage
    expect(Number(ev.readBigUInt64LE(32))).toBe(a);
    expect(Number(ev.readBigUInt64LE(40))).toBe(c.atom("_NET_ACTIVE_WINDOW"));
    expect(ev.readInt32LE(48)).toBe(32); // format
    expect(Number(ev.readBigInt64LE(56))).toBe(2); // source indication: pager
    expect(Number(ev.readBigInt64LE(64))).toBe(0); // timestamp: CurrentTime

    c.deleteProp(c.root, "_NET_SUPPORTING_WM_CHECK");
    c.deleteProp(c.root, "_NET_ACTIVE_WINDOW");
  });

  it("reads the active layout, including Caps Lock, while shortcuts ignore the lock", () => {
    const i = open();
    const a = i.keycodeOf(0x61);
    const layout = i.layout!();
    expect(layout).not.toBeNull();
    expect(layout!.typing.get(a)).toEqual([0x61, 0x41]);
    expect(layout!.shortcuts.get(a)).toEqual([0x61, 0x41]);
    expect(layout!.shift).toBe(i.keycodeOf(SHIFT_L));
    expect(layout!.shift).toBeGreaterThan(0);
    expect(Array.isArray(layout!.others)).toBe(true);

    expect(c.key(CAPS_LOCK)).toBeGreaterThan(0);
    i.sync();
    const locked = i.layout!();
    expect(locked!.typing.get(a)).toEqual([0x41, 0x61]); // typing sees the lock
    expect(locked!.shortcuts.get(a)).toEqual([0x61, 0x41]); // shortcuts don't

    c.key(CAPS_LOCK);
    i.sync();
    expect(i.layout!()!.typing.get(a)).toEqual([0x61, 0x41]);
  });

  it("does not refuse the keyboard when Typing Assist is off", () => {
    const i = open();
    expect(i.keyboardBlockedReason!()).toBeNull();
    expect(i.keyboardBlockedReason!({ modifiers: [0xffe3], sym: 0x61 })).toBeNull();
  });

  it("sees another client's keyboard grab, and treats the app's own menu as explaining it", () => {
    const i = open();
    expect(i.keyboardGrabbed!()).toBe(false);
    expect(c.grabKeyboard()).toBe(0); // GrabSuccess
    expect(i.keyboardGrabbed!()).toBe(true);
    c.ungrabKeyboard();
    expect(i.keyboardGrabbed!()).toBe(false);

    const app = c.make({ title: "App", pid: 4401, x: 100, y: 100 });
    const menu = c.make({ title: "Menu", pid: 4401, x: 100, y: 100, override: true, type: "MENU" });
    expect(c.grabKeyboard()).toBe(0);
    expect(i.keyboardGrabbed!()).toBe(true); // no window named: someone holds it
    expect(i.keyboardGrabbed!(app)).toBe(false); // the app's own open menu
    c.ungrabKeyboard();
    c.destroy(menu);

    const tooltip = c.make({ title: "Tip", pid: 4401, x: 100, y: 100, override: true, type: "TOOLTIP" });
    expect(c.grabKeyboard()).toBe(0);
    expect(i.keyboardGrabbed!(app)).toBe(true); // a tooltip doesn't explain a grab
    c.ungrabKeyboard();
    c.destroy(tooltip);
  });

  it("tells whether a click at the pointer would land in the window, or in its own menu over it", async () => {
    const i = open();
    const a = c.make({ title: "A", pid: 4501, x: 100, y: 100 });
    const b = c.make({ title: "B", pid: 4502, x: 400, y: 100 });
    i.move(110, 110);
    i.sync();
    expect(await pointerUntil(c, 110, 110)).toBe(true);
    expect(i.pointerOn!(a)).toBe(true);
    expect(i.pointerOn!(b)).toBe(false);
    expect(i.pointerOn!(0)).toBe(false);
    expect(i.pointerOn!(a, b)).toBe(true); // the element says B is where the pointer is

    i.move(410, 110); // over B's own top-level, a different window
    i.sync();
    expect(await pointerUntil(c, 410, 110)).toBe(true);
    expect(i.pointerOn!(a)).toBe(false);
    expect(i.pointerOn!(a, b)).toBe(true);

    i.move(700, 500); // the bare desktop
    i.sync();
    expect(await pointerUntil(c, 700, 500)).toBe(true);
    expect(i.pointerOn!(a)).toBe(false);

    i.move(110, 110);
    i.sync();
    expect(await pointerUntil(c, 110, 110)).toBe(true);
    const menu = c.make({ title: "Menu", pid: 4501, x: 100, y: 100, override: true, type: "MENU" });
    c.raise(menu);
    expect(i.pointerOn!(a)).toBe(true);
    expect(i.pointerOn!(b)).toBe(false);
    c.destroy(menu);

    const tooltip = c.make({ title: "Tip", pid: 4501, x: 100, y: 100, override: true, type: "TOOLTIP" });
    c.raise(tooltip);
    expect(i.pointerOn!(a)).toBe(false);
    c.destroy(tooltip);

    const tooltipFor = c.make({ title: "TipFor", pid: 4501, x: 100, y: 100, override: true, type: "TOOLTIP", transientFor: a });
    c.raise(tooltipFor);
    expect(i.pointerOn!(a)).toBe(false); // tied to the window, but still a tooltip
    c.destroy(tooltipFor);

    const untyped = c.make({ title: "Untyped", pid: 4501, x: 100, y: 100, override: true, transientFor: a });
    c.raise(untyped);
    expect(i.pointerOn!(a)).toBe(true); // an untyped popup tied to the window counts
    c.destroy(untyped);

    const normalDialog = c.make({ title: "NormalDialog", pid: 4501, x: 100, y: 100, type: "DIALOG", transientFor: a });
    c.raise(normalDialog);
    expect(i.pointerOn!(a)).toBe(false); // not override-redirect, so not a popup
    c.destroy(normalDialog);

    const dialog = c.make({ title: "Dialog", pid: 4501, x: 100, y: 100, override: true, type: "DIALOG", transientFor: a });
    c.raise(dialog);
    expect(i.pointerOn!(a)).toBe(true); // tied to the window, not a tooltip or notification
    c.destroy(dialog);

    const foreignMenu = c.make({ title: "Foreign", pid: 4599, x: 100, y: 100, override: true, type: "MENU" });
    c.raise(foreignMenu);
    expect(i.pointerOn!(a)).toBe(false); // another app's menu over it
  });

  it("is not locked on a fresh X server", () => {
    const i = open();
    expect(i.screenLocked!()).toBe(false);
  });

  it("watches the user's own input but not the input Ember sends", async () => {
    const i = open();
    expect(i.watchUser!(true)).toBe(true);
    expect(i.userInput!()).toBeNull();

    // Ember's own press is not the user's: wait for the watch connection to see and discard it.
    expect(i.keysym(0x61, true)).toBe(true);
    i.button(1, true);
    i.sync();
    await sleep(30);
    expect(i.userInput!()).toBeNull();
    i.keysym(0x61, false);
    i.button(1, false);
    i.sync();

    c.key(0x62); // another client's key, through the same XTest devices
    expect(await until(() => i.userInput!() === "keys")).toBe(true);

    c.button(1, true);
    c.button(1, false);
    expect(await until(() => i.userInput!() === "pointer")).toBe(true);
  });

  it("counts watchers so one stop doesn't stop another, and starts watching again", async () => {
    const i = open();
    expect(i.watchUser!(true)).toBe(true);
    expect(i.watchUser!(true)).toBe(true);
    c.key(0x63);
    expect(await until(() => i.userInput!() === "keys")).toBe(true);

    expect(i.watchUser!(false)).toBe(true); // one watcher remains
    c.key(0x64);
    expect(await until(() => i.userInput!() === "keys")).toBe(true);

    expect(i.watchUser!(false)).toBe(true); // none left
    expect(i.watchUser!(false)).toBe(true); // never below zero
    c.key(0x65);
    await sleep(30);
    expect(i.userInput!()).toBeNull();

    expect(i.watchUser!(true)).toBe(true); // and it can start again
    c.key(0x66);
    expect(await until(() => i.userInput!() === "keys")).toBe(true);
  });

  it("keeps a user event that arrived before a second watcher starts", () => {
    const i = open();
    expect(i.watchUser!(true)).toBe(true);
    c.key(0x62); // another client's key, already queued on the watch connection
    c.sync();
    expect(i.watchUser!(true)).toBe(true); // starting another watcher must not drain it
    expect(i.userInput!()).toBe("keys");
  });

  it("reports no user input after the last watcher stops", async () => {
    const i = open();
    expect(i.watchUser!(true)).toBe(true);
    expect(i.watchUser!(false)).toBe(true);
    c.button(1, true);
    c.button(1, false);
    c.sync();
    await sleep(30);
    expect(i.userInput!()).toBeNull();
  });

  it("reports the pointer when a click and a key both happened before reading", async () => {
    const i = open();
    expect(i.watchUser!(true)).toBe(true);
    c.button(1, true);
    c.button(1, false);
    c.key(0x62); // after the click
    c.sync();
    await sleep(30);
    expect(i.userInput!()).toBe("pointer");
  });

  it("does not watch the user when XInput2 cannot be initialized", () => {
    const koffiPath = requireCjs.resolve("koffi");
    const real = requireCjs("koffi") as typeof import("koffi");
    const saved = requireCjs.cache[koffiPath];
    const fakeXi = { func: (..._args: unknown[]) => () => 1 }; // every XIQueryVersion call fails
    const fake = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "load") return (name: string) => name === "libXi.so.6" ? fakeXi : target.load(name);
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: fake } as unknown as NodeModule;
      const i = openXInput(display)!;
      expect(i).not.toBeNull();
      expect(i.watchUser!(true)).toBe(false); // no XInput2: polling only
      expect(i.userInput!()).toBeNull();
      i.close();
    } finally {
      if (saved) requireCjs.cache[koffiPath] = saved;
      else delete requireCjs.cache[koffiPath];
    }
  });

  it("falls back safely when the optional XInput2, screensaver and Xext libraries are missing", () => {
    const koffiPath = requireCjs.resolve("koffi");
    const real = requireCjs("koffi") as typeof import("koffi");
    const saved = requireCjs.cache[koffiPath];
    const fake = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "load") {
          return (name: string) => {
            if (name === "libXi.so.6" || name === "libXss.so.1" || name === "libXext.so.6") throw new Error(`missing ${name}`);
            return target.load(name);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: fake } as unknown as NodeModule;
      const i = openXInput(display)!;
      expect(i).not.toBeNull();
      expect(i.screenSize()).toEqual({ width: 800, height: 600 });
      expect(i.watchUser!(true)).toBe(false); // no XInput2
      expect(i.userInput!()).toBeNull();
      expect(i.screenLocked!()).toBe(false); // no screensaver or DPMS extension
      i.close();
    } finally {
      if (saved) requireCjs.cache[koffiPath] = saved;
      else delete requireCjs.cache[koffiPath];
    }
  });
});

/** XTest motion comes from another connection; wait for the server to place the pointer. */
async function pointerUntil(c: ReturnType<typeof makeClient>, x: number, y: number): Promise<boolean> {
  return until(() => { const p = c.pointer(); return p?.x === x && p?.y === y; });
}
