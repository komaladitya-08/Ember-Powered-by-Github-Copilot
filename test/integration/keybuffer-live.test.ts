/**
 * Holding the keyboard while the ask box opens, on a real X server (Xvfb; skipped without it):
 * XTEST/xdotool keys go to Ember, not the focused app, and giving the keyboard back does not
 * replay Backspace into that app (live retest: "hello" landed in Mousepad, then Backspace lagged).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { holdKeyboard } from "../../app/main/hands/keybuffer";

const requireCjs = createRequire(import.meta.url);
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const xvfb = has("Xvfb");
const xdotool = has("xdotool");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x = koffi.load("libX11.so.6"), xtst = koffi.load("libXtst.so.6");
  return {
    XOpenDisplay: x.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: x.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateWindow: x.func("unsigned long XCreateWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, int depth, unsigned int cls, void *visual, unsigned long mask, uint8_t *attrs)"),
    XSelectInput: x.func("int XSelectInput(void *dpy, unsigned long w, long mask)"),
    XMapRaised: x.func("int XMapRaised(void *dpy, unsigned long w)"),
    XSetInputFocus: x.func("int XSetInputFocus(void *dpy, unsigned long w, int revertTo, unsigned long time)"),
    XSync: x.func("int XSync(void *dpy, int discard)"),
    XFlush: x.func("int XFlush(void *dpy)"),
    XPending: x.func("int XPending(void *dpy)"),
    XNextEvent: x.func("int XNextEvent(void *dpy, _Out_ uint8_t *ev)"),
    XLookupString: x.func("int XLookupString(uint8_t *ev, _Out_ uint8_t *buf, int n, _Out_ unsigned long *sym, void *status)"),
    XStringToKeysym: x.func("unsigned long XStringToKeysym(const char *name)"),
    XKeysymToKeycode: x.func("uint8_t XKeysymToKeycode(void *dpy, unsigned long sym)"),
    XGrabKeyboard: x.func("int XGrabKeyboard(void *dpy, unsigned long w, int ownerEvents, int pointerMode, int keyboardMode, unsigned long time)"),
    XGrabKey: x.func("int XGrabKey(void *dpy, int keycode, unsigned int modifiers, unsigned long w, int ownerEvents, int pointerMode, int keyboardMode)"),
    XUngrabKeyboard: x.func("int XUngrabKeyboard(void *dpy, unsigned long time)"),
    XTestFakeKeyEvent: xtst.func("int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int isPress, unsigned long delay)"),
  };
}

describe.skipIf(!xvfb)("holding the keyboard on a real X server", () => {
  let server: ChildProcess;
  let display = "";
  let L: ReturnType<typeof xlib>;
  const apps: unknown[] = [];

  beforeAll(async () => {
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
    L = xlib();
  });
  afterAll(() => {
    for (const d of apps) L.XCloseDisplay(d);
    server?.kill();
  });

  function app() {
    const dpy = L.XOpenDisplay(display);
    apps.push(dpy);
    const attrs = Buffer.alloc(112);
    const win = Number(L.XCreateWindow(dpy, L.XDefaultRootWindow(dpy), 40, 40, 400, 300, 0, 0, 1, null, 0, attrs));
    L.XSelectInput(dpy, win, 1 /* KeyPress */);
    L.XMapRaised(dpy, win);
    L.XSetInputFocus(dpy, win, 2, 0);
    L.XSync(dpy, 0);
    const received = () => {
      L.XSync(dpy, 0);
      let text = "";
      const ev = Buffer.alloc(192), buf = Buffer.alloc(16), sym = [0];
      while (L.XPending(dpy) > 0) {
        L.XNextEvent(dpy, ev);
        if (ev.readInt32LE(0) !== 2) continue;
        const n = L.XLookupString(ev, buf, 16, sym, null);
        text += buf.subarray(0, n).toString("latin1");
      }
      return text;
    };
    const type = (chars: string) => {
      const xt = L.XOpenDisplay(display);
      for (const ch of chars) {
        const code = Number(L.XKeysymToKeycode(xt, Number(L.XStringToKeysym(ch))));
        L.XTestFakeKeyEvent(xt, code, 1, 0);
        L.XTestFakeKeyEvent(xt, code, 0, 0);
      }
      L.XSync(xt, 0);
      L.XCloseDisplay(xt);
    };
    return { dpy, win, received, type };
  }

  it("XTEST letters go to the buffer, not the focused app, and ungrab does not replay them", async () => {
    const a = app();
    expect(a.received()).toBe("");
    const held = holdKeyboard({ display, maxMs: 800 });
    expect(held).not.toBeNull();
    expect(held!.holding()).toBe(true);
    a.type("hello");
    await sleep(40);
    expect(a.received()).toBe("");
    const typed = held!.stop();
    expect(typed.text).toBe("hello");
    expect(held!.holding()).toBe(false);
    // Giving the keyboard back does not replay the grabbed keys (or a delayed Backspace) into the app.
    a.type("x");
    await sleep(30);
    expect(a.received()).toBe("x");
  });

  it.skipIf(!xdotool)("buffers the first word when the hotkey grab drops under xdotool", async () => {
    const grabber = L.XOpenDisplay(display);
    try {
      // What Electron's global shortcut does: a passive grab on Ctrl+Alt+Space, which is active while the keys are held.
      const space = Number(L.XKeysymToKeycode(grabber, Number(L.XStringToKeysym("space"))));
      L.XGrabKey(grabber, space, 4 | 8, L.XDefaultRootWindow(grabber), 0, 1, 1);
      L.XSync(grabber, 0);
      const child = spawn("xdotool", ["key", "ctrl+alt+space", "type", "hello"], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" });
      const ev = Buffer.alloc(192);
      let type = 0;
      while (type !== 2) { L.XNextEvent(grabber, ev); type = ev.readInt32LE(0); }
      // The hotkey callback: holdKeyboard() runs while the hotkey's own grab is still active and "hello" is on its way.
      const held = holdKeyboard({ display, maxMs: 800 });
      expect(held).not.toBeNull();
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
      await sleep(40);
      expect(held!.stop()).toMatchObject({ text: "hello", submit: false, cancel: false });
    } finally {
      L.XCloseDisplay(grabber);
    }
  });

  it("grabs as soon as another client's hotkey-style grab drops (no 5 ms wait)", async () => {
    const a = app();
    const grabber = L.XOpenDisplay(display);
    apps.push(grabber);
    expect(L.XGrabKeyboard(grabber, L.XDefaultRootWindow(grabber), 0, 1, 1, 0)).toBe(0);
    L.XSync(grabber, 0);
    const start = Date.now();
    const heldP = Promise.resolve().then(() => holdKeyboard({ display, maxMs: 800 }));
    await sleep(10);
    L.XUngrabKeyboard(grabber, 0);
    L.XSync(grabber, 0);
    const held = await heldP;
    expect(held).not.toBeNull();
    // Spin waits for the other grab; it must be holding before a fast xdotool "hello" would have been typed.
    while (!held!.holding() && Date.now() - start < 200) await sleep(1);
    expect(held!.holding()).toBe(true);
    expect(Date.now() - start).toBeLessThan(150);
    a.type("hi");
    await sleep(40);
    expect(a.received()).toBe("");
    expect(held!.stop().text).toBe("hi");
  });
});
