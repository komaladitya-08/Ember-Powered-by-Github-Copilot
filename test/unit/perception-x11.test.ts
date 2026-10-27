/**
 * libX11 through koffi, on a real display (skipped without DISPLAY, and off
 * Linux, where XQuartz may set DISPLAY but Ember never uses X11): captures
 * that reach off the screen, input after the display was closed (both used to
 * end the whole process), the stacking order, finding windows by title, and
 * the list of apps' windows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { openX11 } from "../../app/main/x11";
import { openXInput } from "../../app/main/hands/input";

const requireCjs = createRequire(import.meta.url);

/** A few plain X windows of our own, with titles and pids (no toolkit needed). */
function windowMaker() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  const XOpenDisplay = lib.func("void *XOpenDisplay(const char *name)");
  const XCloseDisplay = lib.func("int XCloseDisplay(void *dpy)");
  const XDefaultRootWindow = lib.func("unsigned long XDefaultRootWindow(void *dpy)");
  const XCreateSimpleWindow = lib.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderPixel, unsigned long background)");
  const XStoreName = lib.func("int XStoreName(void *dpy, unsigned long w, const char *name)");
  const XInternAtom = lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)");
  const XChangeProperty = lib.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const uint8_t *data, int n)");
  const XMapWindow = lib.func("int XMapWindow(void *dpy, unsigned long w)");
  const XRaiseWindow = lib.func("int XRaiseWindow(void *dpy, unsigned long w)");
  const XSetInputFocus = lib.func("int XSetInputFocus(void *dpy, unsigned long w, int revertTo, unsigned long time)");
  const XDestroyWindow = lib.func("int XDestroyWindow(void *dpy, unsigned long w)");
  const XSync = lib.func("int XSync(void *dpy, int discard)");
  const dpy = XOpenDisplay(null);
  const root = XDefaultRootWindow(dpy);
  const made: number[] = [];
  return {
    /** `wmClass`: WM_CLASS as X has it ("instance\0Class\0"); `type`: its _NET_WM_WINDOW_TYPE ("DOCK" for a panel). */
    make(title: string, pid: number, x: number, y: number, o: { wmClass?: string; type?: string } = {}) {
      const w = Number(XCreateSimpleWindow(dpy, root, x, y, 120, 80, 0, 0, 0xffffff));
      XStoreName(dpy, w, title);
      const data = Buffer.alloc(8);
      data.writeBigInt64LE(BigInt(pid));
      XChangeProperty(dpy, w, XInternAtom(dpy, "_NET_WM_PID", 0), XInternAtom(dpy, "CARDINAL", 0), 32, 0, data, 1);
      if (o.wmClass) {
        const cls = Buffer.from(o.wmClass);
        XChangeProperty(dpy, w, XInternAtom(dpy, "WM_CLASS", 0), XInternAtom(dpy, "STRING", 0), 8, 0, cls, cls.length);
      }
      if (o.type) {
        const type = Buffer.alloc(8);
        type.writeBigUInt64LE(BigInt(XInternAtom(dpy, `_NET_WM_WINDOW_TYPE_${o.type}`, 0)));
        XChangeProperty(dpy, w, XInternAtom(dpy, "_NET_WM_WINDOW_TYPE", 0), XInternAtom(dpy, "ATOM", 0), 32, 0, type, 1);
      }
      XMapWindow(dpy, w);
      XSync(dpy, 0);
      made.push(w);
      return w;
    },
    raise(w: number) { XRaiseWindow(dpy, w); XSync(dpy, 0); },
    focus(w: number) { XSetInputFocus(dpy, w, 2, 0); XSync(dpy, 0); },
    close() { for (const w of made) XDestroyWindow(dpy, w); XSync(dpy, 0); XCloseDisplay(dpy); },
  };
}

const settle = () => new Promise(r => setTimeout(r, 300));

describe.skipIf(!process.env.DISPLAY || process.platform !== "linux")("X11 on a real display", () => {
  it("clips captures to the screen instead of failing", () => {
    const x11 = openX11();
    if (!x11) return;
    try {
      const whole = x11.capture(0, 0, 100000, 100000);
      expect(whole).not.toBeNull();
      const { width: w, height: h } = whole!;
      const corner = x11.capture(w - 40, h - 30, 200, 200);
      expect(corner).toMatchObject({ x: w - 40, y: h - 30, width: 40, height: 30 });
      expect(corner!.bgra.length).toBe(40 * 30 * 4);
      expect(x11.capture(-10, 5, 30, 20)).toMatchObject({ x: 0, y: 5, width: 20, height: 20 });
      expect(x11.capture(w + 10, 0, 50, 50)).toBeNull();
    } finally {
      x11.close();
    }
  });

  it("does nothing, safely, once input is closed", () => {
    const x = openXInput();
    if (!x) return;
    x.close();
    expect(x.pointer()).toBeNull();
    expect(x.pointerState()).toBeNull();
    x.move(10, 10);
    x.button(1, false);
    expect(x.keysym(x.keysymOf("a"), false)).toBe(false);
    x.keycode(38, false);
    expect(x.keycodeOf(0x61)).toBe(0);
    expect(x.needsShift(0x41)).toBe(false);
    expect(x.keysDown()).toEqual([]);
    expect(x.activeWindow()).toBe(0);
    expect(x.findWindow("anything")).toBe(0);
    expect(x.focusedWindow()).toBe(0);
    x.activate(1);
    x.sync();
    x.close();
  });

  describe("windows", () => {
    let maker: ReturnType<typeof windowMaker>;
    let a = 0, b = 0, c = 0, d = 0;
    beforeAll(async () => {
      maker = windowMaker();
      a = maker.make("Ember test: Report", 4242001, 10, 10);
      b = maker.make("Ember test: Report (copy)", 4242002, 60, 30);
      c = maker.make("Ember test: Twin", 4242003, 200, 10);
      d = maker.make("Ember test: Twin", 4242003, 300, 10);
      await settle();
    });
    afterAll(() => maker?.close());

    it("lists top-level windows bottom to top, with pid, title and place", async () => {
      const x11 = openX11()!;
      try {
        maker.raise(a);
        await settle();
        const mine = x11.stack().filter(w => [a, b, c, d].includes(w.client));
        expect(mine.map(w => w.client).at(-1)).toBe(a);
        expect(mine.find(w => w.client === b)).toMatchObject({ pid: 4242002, title: "Ember test: Report (copy)", overrideRedirect: false });
        expect(mine.find(w => w.client === b)!.width).toBeGreaterThanOrEqual(120);
      } finally {
        x11.close();
      }
    });

    it("finds a window only when the title names one", () => {
      const x = openXInput()!;
      try {
        expect(x.findWindow("Ember test: Report")).toBe(a); // exact beats "contains"
        expect(x.findWindow("Report (copy)", 4242002)).toBe(b); // part of the title, among that process's own windows
        expect(x.findWindow("Report (copy)")).toBe(0); // no process to go by: never a title that merely contains it
        expect(x.findWindow("Ember test", 4242003)).toBe(0); // in several of its windows
        expect(x.findWindow("Ember test: Twin")).toBe(0); // two windows, same title
        expect(x.findWindow("Ember test: Report", 4242002)).toBe(b); // that process's window, not another app's
        expect(x.findWindow("Ember test: Report", 999999999)).toBe(a); // an unknown pid doesn't narrow anything
        expect(x.findWindow("No such window")).toBe(0);
      } finally {
        x.close();
      }
    });

    it("lists apps' windows by their class's own name, panels and the desktop left out", async () => {
      // As Xfce has them: xfwm4 lists every window it manages, xfce4-panel's and xfdesktop's too.
      const vbox = maker.make("Oracle VM VirtualBox Manager", 4242004, 400, 10, { wmClass: "VirtualBox Manager\0VirtualBox Manager\0", type: "NORMAL" });
      const panel = maker.make("xfce4-panel", 4242005, 0, 300, { wmClass: "xfce4-panel\0Xfce4-panel\0", type: "DOCK" });
      const desk = maker.make("Desktop", 4242006, 500, 300, { wmClass: "xfdesktop\0Xfdesktop\0", type: "DESKTOP" });
      await settle();
      const x11 = openX11()!;
      try {
        const listed = x11.clientWindows();
        // The space-joined class stays as it was (never-look and password prompts are matched on it).
        expect(listed.find(w => w.id === vbox)).toMatchObject({ title: "Oracle VM VirtualBox Manager", pid: 4242004, wmClass: "VirtualBox Manager VirtualBox Manager", wmClassName: "VirtualBox Manager" });
        expect(listed.find(w => w.id === a)).toMatchObject({ title: "Ember test: Report", wmClass: "", wmClassName: "" });
        expect(listed.map(w => w.id)).not.toContain(panel);
        expect(listed.map(w => w.id)).not.toContain(desk);
      } finally {
        x11.close();
      }
    });

    it("says which window has the keyboard", async () => {
      const x = openXInput()!;
      try {
        maker.focus(c);
        await settle();
        expect(x.focusedWindow()).toBe(c);
        maker.focus(b);
        await settle();
        expect(x.focusedWindow()).toBe(b);
      } finally {
        x.close();
      }
    });
  });
});
