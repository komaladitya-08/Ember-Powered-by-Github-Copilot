/**
 * The overlay's input region on X11: only the clickable rectangles receive clicks; everywhere else
 * they pass through to the app beneath. Electron's hover-to-interact (`setIgnoreMouseEvents`) is too
 * late for a press that starts on a button (the window is still click-through at mousedown).
 */

import { createRequire } from "node:module";
import type { Rect } from "./follow";
import { shapeRects } from "./follow";

const requireCjs = createRequire(__filename);

// The overlay reports new rectangles every frame while Ember flies, so libX11 is bound once and a display stays
// open until closeInputShape(): binding and opening one per call blocked the main thread about a millisecond each
// time. One connection per display name (a test passes its own Xvfb); "" is $DISPLAY. null: koffi, libX11 or
// libXext is missing, and won't appear later.
let lib: ReturnType<typeof bind> | null | undefined;
const open = new Map<string, unknown>();

/**
 * Sets X window `xid`'s ShapeInput to `rects` (DIP, scaled to pixels). An empty list makes the
 * window let every click through. False when there is no X display or libXext.
 */
export function setInputShape(xid: number, rects: readonly Rect[], scale = 1, display?: string): boolean {
  if (!xid) return false;
  if (lib === undefined) {
    try {
      lib = bind();
    } catch {
      lib = null;
    }
  }
  const x = lib;
  if (!x) return false;
  const key = display ?? "";
  let dpy = open.get(key);
  if (!dpy) {
    // Only an open display is kept: one that isn't there now is tried again next time.
    dpy = x.XOpenDisplay(display ?? null);
    if (!dpy) return false;
    open.set(key, dpy);
  }
  try {
    const pixels = shapeRects(rects, scale);
    if (!pixels.length) {
      // n=0, rectangles=null: empty input region (ShapeInput = 2, ShapeSet = 0).
      x.XShapeCombineRectangles(dpy, xid, 2, 0, 0, null, 0, 0, 0);
    } else {
      const buf = Buffer.alloc(pixels.length * 8);
      for (let i = 0; i < pixels.length; i++) {
        const r = pixels[i]!;
        const o = i * 8;
        buf.writeInt16LE(r.x, o);
        buf.writeInt16LE(r.y, o + 2);
        buf.writeUInt16LE(r.width, o + 4);
        buf.writeUInt16LE(r.height, o + 6);
      }
      x.XShapeCombineRectangles(dpy, xid, 2, 0, 0, buf, pixels.length, 0, 0);
    }
    // A round trip, not just a flush: the shape is in place when this returns (as closing the display used to
    // ensure), so a press right after it lands on the new region. About 20 µs on a local server.
    x.XSync(dpy, 0);
    return true;
  } catch {
    return false;
  }
}

/** Closes the displays setInputShape keeps open (the overlay stopping, Ember quitting); the next call opens one again. */
export function closeInputShape(): void {
  for (const dpy of open.values()) lib?.XCloseDisplay(dpy);
  open.clear();
}

function bind() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x11 = koffi.load("libX11.so.6");
  const xext = koffi.load("libXext.so.6");
  return {
    XOpenDisplay: x11.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x11.func("int XCloseDisplay(void *dpy)"),
    XSync: x11.func("int XSync(void *dpy, int discard)"),
    XShapeCombineRectangles: xext.func("void XShapeCombineRectangles(void *dpy, unsigned long dest, int kind, int xOff, int yOff, void *rects, int n, int op, int ordering)"),
  };
}
