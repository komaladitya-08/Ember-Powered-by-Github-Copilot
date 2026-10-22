/**
 * The remote screen's size for the X11 window system (§5.3.2): openLinuxWindows takes a ScreenLike, which locally is
 * Electron's `screen`; on a remote there is no Electron, so it is built from the X root window (one display, scale
 * factor 1: XQueryPointer and XGetImage work in the root's pixels). koffi and libX11 load lazily, inside the call, so
 * the agent imports this module on a macOS remote too, which ships no koffi.
 */

import { createRequire } from "node:module";
import type { Rect, ScreenLike } from "../main/platform/types";

const requireCjs = createRequire(__filename);

/** The root window's size on `display` (":0"), or null when libX11 or the display can't be opened. */
export function rootSize(display: string): { width: number; height: number } | null {
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const lib = koffi.load("libX11.so.6");
    const XOpenDisplay = lib.func("void *XOpenDisplay(const char *name)");
    const XCloseDisplay = lib.func("int XCloseDisplay(void *dpy)");
    const XDefaultScreen = lib.func("int XDefaultScreen(void *dpy)");
    const XDisplayWidth = lib.func("int XDisplayWidth(void *dpy, int screen)");
    const XDisplayHeight = lib.func("int XDisplayHeight(void *dpy, int screen)");
    const dpy = XOpenDisplay(display);
    if (!dpy) return null;
    try {
      const n = XDefaultScreen(dpy) as number;
      const width = XDisplayWidth(dpy, n) as number, height = XDisplayHeight(dpy, n) as number;
      return width > 0 && height > 0 ? { width, height } : null;
    } finally {
      XCloseDisplay(dpy);
    }
  } catch {
    return null;
  }
}

/** A ScreenLike of one display of `size` at scale 1 (what openLinuxWindows needs of Electron's screen). */
export function rootScreen(size: { width: number; height: number }): ScreenLike {
  const bounds: Rect = { x: 0, y: 0, width: size.width, height: size.height };
  const display = { bounds, scaleFactor: 1 };
  return { getPrimaryDisplay: () => display, getAllDisplays: () => [display] };
}
