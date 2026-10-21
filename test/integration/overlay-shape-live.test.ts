/**
 * Overlay button clicks on a real X server (Xvfb; skipped without it): ShapeInput makes a press
 * on the button rectangle hit that window, and a press beside it pass through to the window beneath
 * (live retest: Allow and the guide's Stop raised Chrome instead).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { closeInputShape, setInputShape } from "../../app/main/xshape";

const requireCjs = createRequire(import.meta.url);
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const xvfb = has("Xvfb");

function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x = koffi.load("libX11.so.6"), xtst = koffi.load("libXtst.so.6"), xext = koffi.load("libXext.so.6");
  return {
    XOpenDisplay: x.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: x.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateWindow: x.func("unsigned long XCreateWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, int depth, unsigned int cls, void *visual, unsigned long mask, uint8_t *attrs)"),
    XSelectInput: x.func("int XSelectInput(void *dpy, unsigned long w, long mask)"),
    XMapRaised: x.func("int XMapRaised(void *dpy, unsigned long w)"),
    XSync: x.func("int XSync(void *dpy, int discard)"),
    XPending: x.func("int XPending(void *dpy)"),
    XNextEvent: x.func("int XNextEvent(void *dpy, _Out_ uint8_t *ev)"),
    XTestFakeMotionEvent: xtst.func("int XTestFakeMotionEvent(void *dpy, int screen, int x, int y, unsigned long delay)"),
    XTestFakeButtonEvent: xtst.func("int XTestFakeButtonEvent(void *dpy, unsigned int button, int isPress, unsigned long delay)"),
    XShapeCombineRectangles: xext.func("void XShapeCombineRectangles(void *dpy, unsigned long dest, int kind, int xOff, int yOff, void *rects, int n, int op, int ordering)"),
  };
}

describe.skipIf(!xvfb)("overlay input shape on a real X server", () => {
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
    // Before the server goes: closing a display whose server is gone is an X I/O error (Xlib exits the process).
    closeInputShape();
    for (const d of apps) L.XCloseDisplay(d);
    server?.kill();
  });

  function win(o: { x: number; y: number; w: number; h: number; override?: boolean }) {
    const dpy = L.XOpenDisplay(display);
    apps.push(dpy);
    const attrs = Buffer.alloc(112);
    attrs.writeInt32LE(o.override ? 1 : 0, 88);
    const id = Number(L.XCreateWindow(dpy, L.XDefaultRootWindow(dpy), o.x, o.y, o.w, o.h, 0, 0, 1, null, 1 << 9, attrs));
    L.XSelectInput(dpy, id, 4 /* ButtonPress */);
    L.XMapRaised(dpy, id);
    L.XSync(dpy, 0);
    const clicks = () => {
      L.XSync(dpy, 0);
      let n = 0;
      const ev = Buffer.alloc(192);
      while (L.XPending(dpy) > 0) {
        L.XNextEvent(dpy, ev);
        if (ev.readInt32LE(0) === 4) n++;
      }
      return n;
    };
    return { dpy, id, clicks };
  }

  const clickAt = (x: number, y: number) => {
    const dpy = L.XOpenDisplay(display);
    L.XTestFakeMotionEvent(dpy, 0, x, y, 0);
    L.XTestFakeButtonEvent(dpy, 1, 1, 0);
    L.XTestFakeButtonEvent(dpy, 1, 0, 0);
    L.XSync(dpy, 0);
    L.XCloseDisplay(dpy);
  };

  it("a press on the Allow rectangle hits the overlay; a press beside it hits the window beneath", () => {
    const beneath = win({ x: 0, y: 0, w: 400, h: 300 });
    const overlay = win({ x: 0, y: 0, w: 400, h: 300, override: true });
    expect(setInputShape(overlay.id, [{ x: 100, y: 100, width: 60, height: 24 }], 1, display)).toBe(true);
    beneath.clicks();
    overlay.clicks();
    clickAt(120, 110);
    expect(overlay.clicks()).toBe(1);
    expect(beneath.clicks()).toBe(0);
    clickAt(20, 20);
    expect(overlay.clicks()).toBe(0);
    expect(beneath.clicks()).toBe(1);
  });

  it("each new shape replaces the last at once, over the display kept open (Ember flying moves the rectangles every frame)", () => {
    const beneath = win({ x: 0, y: 0, w: 400, h: 300 });
    const overlay = win({ x: 0, y: 0, w: 400, h: 300, override: true });
    for (let i = 0; i < 20; i++) expect(setInputShape(overlay.id, [{ x: 100 + i * 10, y: 100, width: 60, height: 24 }], 1, display)).toBe(true);
    beneath.clicks();
    overlay.clicks();
    // The last rectangle is 290..350: a press there hits the overlay, one where the first was goes beneath.
    clickAt(320, 110);
    expect(overlay.clicks()).toBe(1);
    expect(beneath.clicks()).toBe(0);
    clickAt(120, 110);
    expect(overlay.clicks()).toBe(0);
    expect(beneath.clicks()).toBe(1);
  });
});
