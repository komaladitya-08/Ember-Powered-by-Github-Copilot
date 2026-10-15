/**
 * Borrowing the mouse and keyboard on a private X server (Xvfb; skipped without it):
 * text comes out exactly on other keyboard layouts and with Caps Lock, shortcuts
 * whose key needs AltGr aren't pressed, a keyboard grabbed by another program or
 * a popup or dialog over the click spot stops Ember, the user's own quick clicks,
 * key taps and wheel notches are noticed (also from another XTest program),
 * nothing stays pressed after close, and windows are only found by their exact
 * title when the app's process has none.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { CursorBorrow, UserTookOver } from "../../app/main/hands/borrow";
import { openXInput, type XInput } from "../../app/main/hands/input";

const requireCjs = createRequire(import.meta.url);
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const xvfb = has("Xvfb");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** libX11, libXext, libXi and libXtst for playing the apps and the user. */
function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x = koffi.load("libX11.so.6"), xext = koffi.load("libXext.so.6"), xi = koffi.load("libXi.so.6"), xtst = koffi.load("libXtst.so.6");
  return {
    koffi,
    XOpenDisplay: x.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: x.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateWindow: x.func("unsigned long XCreateWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, int depth, unsigned int cls, void *visual, unsigned long mask, uint8_t *attrs)"),
    XStoreName: x.func("int XStoreName(void *dpy, unsigned long w, const char *name)"),
    XInternAtom: x.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)"),
    XChangeProperty: x.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const uint8_t *data, int n)"),
    XSelectInput: x.func("int XSelectInput(void *dpy, unsigned long w, long mask)"),
    XMapRaised: x.func("int XMapRaised(void *dpy, unsigned long w)"),
    XSetInputFocus: x.func("int XSetInputFocus(void *dpy, unsigned long w, int revertTo, unsigned long time)"),
    XGrabKeyboard: x.func("int XGrabKeyboard(void *dpy, unsigned long w, int ownerEvents, int pointerMode, int keyboardMode, unsigned long time)"),
    XUngrabKeyboard: x.func("int XUngrabKeyboard(void *dpy, unsigned long time)"),
    XSync: x.func("int XSync(void *dpy, int discard)"),
    XFlush: x.func("int XFlush(void *dpy)"),
    XPending: x.func("int XPending(void *dpy)"),
    XNextEvent: x.func("int XNextEvent(void *dpy, _Out_ uint8_t *ev)"),
    XLookupString: x.func("int XLookupString(uint8_t *ev, _Out_ uint8_t *buf, int n, _Out_ unsigned long *sym, void *status)"),
    XkbLockGroup: x.func("int XkbLockGroup(void *dpy, unsigned int device, unsigned int group)"),
    XkbLockModifiers: x.func("int XkbLockModifiers(void *dpy, unsigned int device, unsigned int affect, unsigned int values)"),
    XShapeCombineRectangles: xext.func("void XShapeCombineRectangles(void *dpy, unsigned long w, int kind, int x, int y, void *rects, int n, int op, int ordering)"),
    XIQueryVersion: xi.func("int XIQueryVersion(void *dpy, _Inout_ int *major, _Inout_ int *minor)"),
    XISetClientPointer: xi.func("int XISetClientPointer(void *dpy, unsigned long w, int device)"),
    XIQueryDevice: xi.func("void *XIQueryDevice(void *dpy, int device, _Out_ int *n)"),
    XIFreeDeviceInfo: xi.func("void XIFreeDeviceInfo(void *info)"),
    XIChangeHierarchy: xi.func("XIChangeHierarchy", "int", ["void *", koffi.pointer(koffi.struct({ type: "int", name: "const char *", send_core: "int", enable: "int" })), "int"]),
    XTestFakeButtonEvent: xtst.func("int XTestFakeButtonEvent(void *dpy, unsigned int button, int press, unsigned long delay)"),
    XTestFakeKeyEvent: xtst.func("int XTestFakeKeyEvent(void *dpy, unsigned int code, int press, unsigned long delay)"),
    XTestFakeRelativeMotionEvent: xtst.func("int XTestFakeRelativeMotionEvent(void *dpy, int dx, int dy, unsigned long delay)"),
  };
}

describe.skipIf(!xvfb)("borrowing on a real X server", () => {
  let server: ChildProcess;
  let display = "";
  let L: ReturnType<typeof xlib>;
  let x: XInput;
  const apps: unknown[] = [];

  beforeAll(async () => {
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
    L = xlib();
    x = openXInput(display)!;
  });
  afterAll(() => {
    x?.close();
    for (const d of apps) L.XCloseDisplay(d);
    server?.kill();
  });

  /** An app's window on its own connection: a title, a pid, a class; override-redirect for a popup, its EWMH type, what it's transient for. */
  function app(o: { title?: string; pid?: number; cls?: string; x?: number; y?: number; w?: number; h?: number; popup?: boolean; type?: string; transientFor?: number; clickThrough?: boolean; focus?: boolean } = {}) {
    const dpy = L.XOpenDisplay(display);
    apps.push(dpy);
    const attrs = Buffer.alloc(112);
    attrs.writeInt32LE(o.popup ? 1 : 0, 88); // XSetWindowAttributes.override_redirect
    attrs.writeBigUInt64LE(0xffffffn, 8); // background_pixel
    const win = Number(L.XCreateWindow(dpy, L.XDefaultRootWindow(dpy), o.x ?? 100, o.y ?? 100, o.w ?? 400, o.h ?? 300, 0, 0, 1, null, (1 << 9) | (1 << 1), attrs));
    if (o.title) L.XStoreName(dpy, win, o.title);
    if (o.pid) {
      const pid = Buffer.alloc(8);
      pid.writeBigUInt64LE(BigInt(o.pid));
      L.XChangeProperty(dpy, win, L.XInternAtom(dpy, "_NET_WM_PID", 0), 6 /* CARDINAL */, 32, 0, pid, 1);
    }
    if (o.cls) { const c = Buffer.from(`${o.cls}\0${o.cls}\0`); L.XChangeProperty(dpy, win, L.XInternAtom(dpy, "WM_CLASS", 0), 31 /* STRING */, 8, 0, c, c.length); }
    const long = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
    if (o.type) L.XChangeProperty(dpy, win, L.XInternAtom(dpy, "_NET_WM_WINDOW_TYPE", 0), 4 /* ATOM */, 32, 0, long(L.XInternAtom(dpy, `_NET_WM_WINDOW_TYPE_${o.type}`, 0)), 1);
    if (o.transientFor) L.XChangeProperty(dpy, win, L.XInternAtom(dpy, "WM_TRANSIENT_FOR", 0), 33 /* WINDOW */, 32, 0, long(o.transientFor), 1);
    if (o.clickThrough) L.XShapeCombineRectangles(dpy, win, 2 /* ShapeInput */, 0, 0, null, 0, 0 /* ShapeSet */, 0);
    L.XSelectInput(dpy, win, 1 /* KeyPress */ | 4 /* ButtonPress */ | (1 << 21) /* FocusChange */);
    L.XMapRaised(dpy, win);
    if (o.focus) L.XSetInputFocus(dpy, win, 2, 0);
    L.XSync(dpy, 0);
    /** What reached this app: the text its key presses type, the key presses themselves, its clicks, and focus lost to a grab. */
    const received = () => {
      L.XSync(dpy, 0);
      let text = "", clicks = 0, grabbedAway = 0;
      const keys: { code: number; state: number }[] = [];
      const ev = Buffer.alloc(192), buf = Buffer.alloc(16), sym = [0];
      while (L.XPending(dpy) > 0) {
        L.XNextEvent(dpy, ev);
        const type = ev.readInt32LE(0);
        if (type === 4) clicks++;
        if (type === 10 && ev.readInt32LE(40) === 1 /* FocusOut, NotifyGrab */) grabbedAway++;
        if (type !== 2) continue;
        keys.push({ code: ev.readUInt32LE(84), state: ev.readUInt32LE(80) });
        const n = L.XLookupString(ev, buf, 16, sym, null);
        text += Number(sym[0]) === 0xff0d ? "\n" : buf.subarray(0, n).toString("latin1");
      }
      return { text, keys, clicks, grabbedAway };
    };
    return { dpy, win, received };
  }
  const layout = (...args: string[]) => spawnSync("setxkbmap", ["-display", display, ...args]);
  const lock = (o: { group?: number; caps?: boolean }) => {
    const dpy = L.XOpenDisplay(display);
    if (o.group !== undefined) L.XkbLockGroup(dpy, 0x100, o.group);
    if (o.caps !== undefined) L.XkbLockModifiers(dpy, 0x100, 2, o.caps ? 2 : 0);
    L.XSync(dpy, 0);
    L.XCloseDisplay(dpy);
  };
  const fast = { idleMs: 0 };

  describe.skipIf(!has("setxkbmap"))("typing on the keyboard layout in use", () => {
    afterAll(() => { layout("us"); lock({ group: 0, caps: false }); });

    it("types exactly, Caps Lock or not", async () => {
      layout("us");
      for (const caps of [false, true]) {
        lock({ caps });
        const a = app({ title: "Ember live: Notes", focus: true });
        await new CursorBorrow(x).borrow(hand => hand.type("Hello, World! @{}[]|~`\nok"), { ...fast, window: a.win });
        expect(a.received().text).toBe("Hello, World! @{}[]|~`\nok");
      }
      lock({ caps: false });
    });

    it("types nothing when the active layout can't type the text (us,ru with Russian active)", async () => {
      layout("us,ru");
      lock({ group: 1 });
      const a = app({ title: "Ember live: Chat", focus: true });
      const err = await new CursorBorrow(x).borrow(hand => hand.type("2024 hello"), { ...fast, window: a.win }).catch(e => e);
      expect(String(err)).toMatch(/keyboard layout in use can't type “h” “e” “l” “o”/);
      expect(a.received().keys).toEqual([]);
      // What it can type, it types exactly; shortcuts still reach the app.
      await new CursorBorrow(x).borrow(async hand => { await hand.type("2024"); await hand.keys("ctrl+a"); }, { ...fast, window: a.win });
      const got = a.received();
      expect(got.text.slice(0, 4)).toBe("2024");
      expect(got.keys.at(-1)!.state & 4).toBe(4); // Control held for the last key
      lock({ group: 0 });
      layout("us");
    });

    it("refuses characters a German layout has only on AltGr or as dead keys, and types the rest right", async () => {
      layout("de");
      const a = app({ title: "Ember live: Brief", focus: true });
      const err = await new CursorBorrow(x).borrow(hand => hand.type("mail@example"), { ...fast, window: a.win }).catch(e => e);
      expect(String(err)).toMatch(/can't type “@”/);
      expect(a.received().keys).toEqual([]);
      await new CursorBorrow(x).borrow(hand => hand.type("Hallo Welt? (y=z) \"ok\" #1 & 50% + $5 * / < > _ ;:"), { ...fast, window: a.win });
      expect(a.received().text).toBe("Hallo Welt? (y=z) \"ok\" #1 & 50% + $5 * / < > _ ;:");
      layout("us");
    });

    it("never presses a shortcut whose key needs AltGr on the layout in use: without it, it is another shortcut (review round 3)", async () => {
      const a = app({ title: "Ember live: Shortcuts", focus: true });
      for (const [map, combos] of [["de", ["ctrl+@", "@", "ctrl+]", "ctrl+{"]], ["fr", ["ctrl+["]]] as const) {
        layout(map);
        for (const combo of combos) {
          const err = await new CursorBorrow(x).borrow(hand => hand.keys(combo), { ...fast, window: a.win }).catch(e => e);
          expect(String(err)).toMatch(/can't press .*AltGr.*pressed nothing/);
        }
        expect(a.received().keys).toEqual([]); // not Ctrl+Q, Ctrl+9, Ctrl+7 or "("
      }
      layout("de");
      await new CursorBorrow(x).borrow(hand => hand.keys("ctrl+q"), { ...fast, window: a.win });
      expect(a.received().keys.at(-1)).toEqual({ code: 24, state: 4 });
      layout("us");
    });

    it("adds Shift for shortcut keys on the shifted level (ctrl+plus, ctrl+!)", async () => {
      layout("us");
      const a = app({ title: "Ember live: Zoom", focus: true });
      await new CursorBorrow(x).borrow(async hand => { await hand.keys("ctrl+plus"); await hand.keys("ctrl+!"); await hand.keys("ctrl+-"); }, { ...fast, window: a.win });
      const keys = a.received().keys.filter(k => k.code !== 37 && k.code !== 50); // leave out Control and Shift themselves
      expect(keys).toEqual([{ code: 21, state: 5 }, { code: 10, state: 5 }, { code: 20, state: 4 }]); // =+ with Shift|Control, 1! with Shift|Control, - with Control
    });
  });

  describe("other programs", () => {
    it("stops when another program has grabbed the keyboard, but not for the app's own menu", async () => {
      const a = app({ title: "Ember live: Form", pid: 4244001, focus: true });
      const locker = app({ title: "Lock screen", pid: 4244002, x: 0, y: 0, w: 10, h: 10 });
      expect(L.XGrabKeyboard(locker.dpy, L.XDefaultRootWindow(locker.dpy), 0, 1, 1, 0)).toBe(0);
      L.XSync(locker.dpy, 0);
      const err = await new CursorBorrow(x).borrow(async hand => { await hand.keys("ctrl+a"); await hand.type("hi"); }, { ...fast, window: a.win }).catch(e => e);
      expect(String(err)).toMatch(/Another program has taken the keyboard/);
      expect(locker.received().keys).toEqual([]);
      L.XUngrabKeyboard(locker.dpy, 0);
      L.XSync(locker.dpy, 0);
      // The app opens a menu (a popup of its own) that grabs the keyboard: Ember's keys are for that menu.
      const menu = app({ pid: 4244001, popup: true, type: "POPUP_MENU", x: 120, y: 130, w: 100, h: 80 });
      expect(L.XGrabKeyboard(menu.dpy, menu.win, 0, 1, 1, 0)).toBe(0);
      L.XSync(menu.dpy, 0);
      await new CursorBorrow(x).borrow(hand => hand.keys("Down"), { ...fast, window: a.win });
      expect(menu.received().keys).toHaveLength(1);
      L.XUngrabKeyboard(menu.dpy, 0);
      L.XSync(menu.dpy, 0);
    });

    it("a tooltip or a popup of the app that doesn't say it's a menu doesn't explain someone else's grab (review round 3)", async () => {
      const a = app({ title: "Ember live: Sheet", pid: 4244101, focus: true });
      app({ pid: 4244101, popup: true, type: "TOOLTIP", transientFor: a.win, x: 1200, y: 700, w: 60, h: 20 });
      app({ pid: 4244101, popup: true, transientFor: a.win, x: 1200, y: 740, w: 60, h: 20 });
      const locker = app({ title: "Password prompt", pid: 4244102, x: 0, y: 0, w: 10, h: 10 });
      expect(L.XGrabKeyboard(locker.dpy, L.XDefaultRootWindow(locker.dpy), 0, 1, 1, 0)).toBe(0);
      L.XSync(locker.dpy, 0);
      try {
        const err = await new CursorBorrow(x).borrow(hand => hand.keys("ctrl+a"), { ...fast, window: a.win }).catch(e => e);
        expect(String(err)).toMatch(/Another program has taken the keyboard/);
        expect(locker.received().keys).toEqual([]);
      } finally {
        L.XUngrabKeyboard(locker.dpy, 0);
        L.XSync(locker.dpy, 0);
      }
    });

    it("doesn't click when another app's popup is on top of the spot, and clicks through a click-through overlay", async () => {
      const a = app({ title: "Ember live: Canvas", pid: 4245001, x: 300, y: 300, w: 400, h: 300, focus: true });
      const overlay = app({ pid: 4245009, popup: true, clickThrough: true, x: 0, y: 0, w: 1280, h: 800 });
      await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(500, 450); await hand.click(); }, { ...fast, window: a.win });
      expect(a.received().clicks).toBe(1);
      expect(overlay.received().clicks).toBe(0);
      const banner = app({ title: "Notification", pid: 4245002, popup: true, x: 450, y: 400, w: 200, h: 100 });
      const err = await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(500, 450); await hand.click(); }, { ...fast, window: a.win }).catch(e => e);
      expect(String(err)).toMatch(/Something else is on top of the app/);
      expect(banner.received().clicks).toBe(0);
      expect(a.received().clicks).toBe(0);
      // The app's own popup (its menu) at that spot is fine.
      const own = app({ pid: 4245001, popup: true, type: "POPUP_MENU", x: 480, y: 600, w: 100, h: 50 });
      await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(500, 620); await hand.click(); }, { ...fast, window: a.win });
      expect(own.received().clicks).toBe(1);
    });

    it("doesn't click the app's own dialog or tooltip over the spot, unless told the element is in that dialog (review round 3)", async () => {
      const a = app({ title: "Ember live: Calc", pid: 4247001, x: 300, y: 300, w: 400, h: 300, focus: true });
      const dialog = app({ title: "Find and Replace", pid: 4247001, x: 550, y: 320, w: 120, h: 80 });
      const tip = app({ pid: 4247001, popup: true, type: "TOOLTIP", transientFor: a.win, x: 320, y: 320, w: 60, h: 30 });
      const clickAt = (px: number, py: number, o: { elementWindow?: number } = {}) =>
        new CursorBorrow(x).borrow(async hand => { await hand.glideTo(px, py); await hand.click(); }, { ...fast, window: a.win, ...o }).catch(e => e);
      expect(String(await clickAt(600, 350))).toMatch(/Something else is on top of the app/);
      expect(String(await clickAt(340, 330))).toMatch(/Something else is on top of the app/);
      expect([a.received().clicks, dialog.received().clicks, tip.received().clicks]).toEqual([0, 0, 0]);
      // The element is in the dialog: the click is meant for it.
      expect(await clickAt(600, 350, { elementWindow: dialog.win })).toBeUndefined();
      expect(dialog.received().clicks).toBe(1);
      // A popup tied to the window that doesn't say what it is (an old toolkit's dropdown list) is the app's.
      const list = app({ pid: 4247001, popup: true, transientFor: a.win, x: 320, y: 500, w: 80, h: 60 });
      expect(await clickAt(340, 520)).toBeUndefined();
      expect([list.received().clicks, a.received().clicks]).toEqual([1, 0]);
    });
  });

  describe("the user's own mouse and keyboard", () => {
    /** A second "physical" mouse and keyboard (a master device of their own), used from another connection. */
    let user: ReturnType<typeof app>["dpy"];
    beforeAll(() => {
      user = L.XOpenDisplay(display);
      apps.push(user);
      L.XIQueryVersion(user, [2], [2]);
      expect(L.XIChangeHierarchy(user, { type: 1 /* XIAddMaster */, name: "User", send_core: 1, enable: 1 }, 1)).toBe(0);
      L.XSync(user, 0);
      const n = [0];
      const list = L.XIQueryDevice(user, 0, n);
      const devices = L.koffi.decode(list, L.koffi.array(L.koffi.struct({ deviceid: "int", name: "const char *", use: "int", attachment: "int", enabled: "int", num_classes: "int", classes: "void *" }), n[0])) as { deviceid: number; name: string }[];
      L.XIFreeDeviceInfo(list);
      L.XISetClientPointer(user, 0, devices.find(d => d.name === "User pointer")!.deviceid);
    });
    const gestures: Record<string, () => Promise<void>> = {
      "a quick click": async () => { L.XTestFakeButtonEvent(user, 1, 1, 0); L.XFlush(user); await sleep(80); L.XTestFakeButtonEvent(user, 1, 0, 0); L.XFlush(user); },
      "a key tap": async () => { L.XTestFakeKeyEvent(user, 50, 1, 0); L.XFlush(user); await sleep(60); L.XTestFakeKeyEvent(user, 50, 0, 0); L.XFlush(user); },
      "wheel notches": async () => { for (let i = 0; i < 3; i++) { L.XTestFakeButtonEvent(user, 5, 1, 0); L.XTestFakeButtonEvent(user, 5, 0, 0); L.XFlush(user); await sleep(30); } },
    };
    for (const [name, gesture] of Object.entries(gestures)) {
      it(`lets go after ${name}, even between two of Ember's checks`, async () => {
        const run = new CursorBorrow(x).borrow(async hand => {
          await hand.glideTo(200, 200);
          await sleep(400); // waiting for an app: nothing is checked meanwhile
          await hand.glideTo(600, 400);
        }, fast).catch(e => e);
        await sleep(150);
        await gesture();
        expect(await run).toBeInstanceOf(UserTookOver);
      });
    }
    it("lets go when another XTest program (an on-screen keyboard, remote support) clicks, scrolls or types on the devices Ember uses (review round 3)", async () => {
      const other = L.XOpenDisplay(display);
      apps.push(other);
      const taps: Record<string, () => void> = {
        click: () => { L.XTestFakeButtonEvent(other, 1, 1, 0); L.XTestFakeButtonEvent(other, 1, 0, 0); },
        wheel: () => { L.XTestFakeButtonEvent(other, 5, 1, 0); L.XTestFakeButtonEvent(other, 5, 0, 0); },
        key: () => { L.XTestFakeKeyEvent(other, 50, 1, 0); L.XTestFakeKeyEvent(other, 50, 0, 0); },
      };
      for (const tap of Object.values(taps)) {
        const run = new CursorBorrow(x).borrow(async hand => {
          await hand.glideTo(200, 200);
          await hand.click(3);
          await sleep(400);
          await hand.glideTo(600, 400);
        }, fast).catch(e => e);
        await sleep(300);
        tap();
        L.XSync(other, 0);
        expect(await run).toBeInstanceOf(UserTookOver);
      }
    });
    it("waits while the user scrolls with a still mouse", async () => {
      let scrolling = true;
      void (async () => { while (scrolling) { await gestures["wheel notches"](); } })();
      const err = await new CursorBorrow(x).borrow(async () => undefined, { idleMs: 500, idleTimeoutMs: 1500 }).catch(e => e);
      scrolling = false;
      await sleep(200);
      expect(String(err)).toMatch(/kept using/);
    });
    it("doesn't mistake Ember's own input for the user's, and never takes the focus from the app to check for grabs", async () => {
      const a = app({ title: "Ember live: Own", focus: true });
      await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(150, 150); await hand.click(); await hand.type("mine, all of it"); await hand.keys("ctrl+a"); await hand.scroll("down", 2); }, { ...fast, window: a.win });
      expect(a.received()).toMatchObject({ text: expect.stringMatching(/^mine, all of it/), grabbedAway: 0 });
    });
  });

  it("lets go of every key and button when the connection closes", () => {
    const y = openXInput(display)!;
    y.keycode(37, true); // Control_L
    y.button(1, true);
    y.close();
    expect(x.keysDown()).toEqual([]);
    expect((x.pointerState()!.mask & 0x100)).toBe(0);
  });

  it("finds a window only by its exact title (and class) when the app's process has none", () => {
    const a = app({ title: "Ember live: Report", pid: 4246001, cls: "reporter" });
    const b = app({ title: "Ember live: Report (2)", pid: 4246002, cls: "other" });
    expect(x.findWindow("Ember live: Report (2)", 4246002)).toBe(b.win);
    expect(x.findWindow("Report (2)", 4246002)).toBe(b.win); // the process's own windows: part of the title will do
    expect(x.findWindow("Ember live: Report", 999_999_999)).toBe(a.win);
    expect(x.findWindow("Ember live: Repo", 999_999_999)).toBe(0); // never someone else's window that merely contains it
    expect(x.findWindow("Report (2)")).toBe(0);
    expect(x.findWindow("Ember live: Report", 999_999_999, "Reporter")).toBe(a.win);
    expect(x.findWindow("Ember live: Report", 999_999_999, "other")).toBe(0);
  });
});
