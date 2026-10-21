/**
 * The overlay's input region on X11: only the clickable rectangles receive clicks; everywhere else
 * they pass through to the app beneath. Electron's hover-to-interact (`setIgnoreMouseEvents`) is too
 * late for a press that starts on a button (the window is still click-through at mousedown).
 */

import { createRequire } from "node:module";
import type { Rect } from "./follow";
import { shapeRects } from "./follow";

const requireCjs = createRequire(__filename);

/**
 * Sets X window `xid`'s ShapeInput to `rects` (DIP, scaled to pixels). An empty list makes the
 * window let every click through. False when there is no X display or libXext.
 */
export function setInputShape(xid: number, rects: readonly Rect[], scale = 1, display?: string): boolean {
  if (!xid) return false;
  let x: ReturnType<typeof bind>;
  try {
    x = bind();
  } catch {
    return false;
  }
  const dpy = x.XOpenDisplay(display ?? null);
  if (!dpy) return false;
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
    x.XFlush(dpy);
    return true;
  } catch {
    return false;
  } finally {
    x.XCloseDisplay(dpy);
  }
}

function bind() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x11 = koffi.load("libX11.so.6");
  const xext = koffi.load("libXext.so.6");
  return {
    XOpenDisplay: x11.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x11.func("int XCloseDisplay(void *dpy)"),
    XFlush: x11.func("int XFlush(void *dpy)"),
    XShapeCombineRectangles: xext.func("void XShapeCombineRectangles(void *dpy, unsigned long dest, int kind, int xOff, int yOff, void *rects, int n, int op, int ordering)"),
  };
}
