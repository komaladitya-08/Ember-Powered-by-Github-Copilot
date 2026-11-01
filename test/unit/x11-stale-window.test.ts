/**
 * A window that closes between being listed and being read must not end Ember:
 * Xlib's default error handler exits the whole process on BadWindow. The active
 * window (a window manager can leave a just-quit app's id in _NET_ACTIVE_WINDOW
 * for a moment) and the overlay's input shape (a stale native-handle xid) both
 * have to survive it and answer null/empty instead.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { openX11 } from "../../app/main/x11";
import { closeInputShape, setInputShape } from "../../app/main/xshape";

const requireCjs = createRequire(import.meta.url);

/** The handful of libX11 calls these tests need to make a window that is already gone. */
function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  return {
    XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: lib.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: lib.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateSimpleWindow: lib.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderPixel, unsigned long background)"),
    XDestroyWindow: lib.func("int XDestroyWindow(void *dpy, unsigned long w)"),
    XInternAtom: lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)"),
    XChangeProperty: lib.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const uint8_t *data, int n)"),
    XSync: lib.func("int XSync(void *dpy, int discard)"),
  };
}

describe.skipIf(!process.env.DISPLAY || process.platform !== "linux")("X11 with a window that is already gone", () => {
  it("reads the active window as gone instead of letting Xlib end the process", () => {
    const L = xlib();
    const dpy = L.XOpenDisplay(null);
    try {
      const root = L.XDefaultRootWindow(dpy);
      // A window that existed a moment ago (an app that just quit): the WM's _NET_ACTIVE_WINDOW still names it.
      const gone = Number(L.XCreateSimpleWindow(dpy, root, 0, 0, 10, 10, 0, 0, 0));
      L.XDestroyWindow(dpy, gone);
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(BigInt(gone));
      const active = L.XInternAtom(dpy, "_NET_ACTIVE_WINDOW", 0);
      const window = L.XInternAtom(dpy, "WINDOW", 0);
      L.XChangeProperty(dpy, root, active, window, 32, 0, data, 1);
      L.XSync(dpy, 0);

      const x11 = openX11();
      try {
        expect(x11?.activeWindow() ?? null).toBeNull();
      } finally {
        const empty = Buffer.alloc(8);
        L.XChangeProperty(dpy, root, active, window, 32, 0, empty, 0);
        L.XSync(dpy, 0);
        x11?.close();
      }
    } finally {
      L.XCloseDisplay(dpy);
    }
  });

  it("ignores a shape update for an overlay xid that was destroyed", () => {
    const L = xlib();
    const dpy = L.XOpenDisplay(null);
    try {
      const root = L.XDefaultRootWindow(dpy);
      const gone = Number(L.XCreateSimpleWindow(dpy, root, 0, 0, 10, 10, 0, 0, 0));
      L.XDestroyWindow(dpy, gone);
      L.XSync(dpy, 0);
      // Before the fix the XSync inside setInputShape hits BadWindow and Xlib exits the process.
      expect(setInputShape(gone, [{ x: 0, y: 0, width: 10, height: 10 }], 1)).toBe(true);
    } finally {
      closeInputShape();
      L.XCloseDisplay(dpy);
    }
  });
});
