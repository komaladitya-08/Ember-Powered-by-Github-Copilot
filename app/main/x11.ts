/**
 * Small libX11 helpers through koffi (no compiled addon of our own).
 * Everything is optional: if libX11 or the display is unavailable, callers get
 * null and fall back to safe defaults.
 */

import { createRequire } from "node:module";

export interface X11 {
  /** True when a compositing manager owns _NET_WM_CM_S<screen> (transparency works). */
  hasCompositor(screen?: number): boolean;
  /**
   * Pointer position in physical pixels, read straight from the X server.
   * Electron's screen.getCursorScreenPoint() can return a stale position on X11
   * after the pointer jumps, so Ember uses this instead.
   */
  pointer(): { x: number; y: number } | null;
  close(): void;
}

const requireCjs = createRequire(__filename);

export function openX11(displayName?: string): X11 | null {
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const lib = koffi.load("libX11.so.6");
    const XOpenDisplay = lib.func("void *XOpenDisplay(const char *name)");
    const XCloseDisplay = lib.func("int XCloseDisplay(void *dpy)");
    const XInternAtom = lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)");
    const XGetSelectionOwner = lib.func("unsigned long XGetSelectionOwner(void *dpy, unsigned long atom)");
    const XDefaultRootWindow = lib.func("unsigned long XDefaultRootWindow(void *dpy)");
    const XQueryPointer = lib.func("int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)");

    const dpy = XOpenDisplay(displayName ?? null);
    if (!dpy) return null;
    const root = XDefaultRootWindow(dpy);
    let open = true;
    const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0];

    return {
      hasCompositor(screen = 0) {
        if (!open) return true;
        const atom = XInternAtom(dpy, `_NET_WM_CM_S${screen}`, 0);
        return Number(XGetSelectionOwner(dpy, atom)) !== 0;
      },
      pointer() {
        if (!open) return null;
        const onScreen = XQueryPointer(dpy, root, r, c, rx, ry, wx, wy, m);
        return onScreen ? { x: rx[0], y: ry[0] } : null;
      },
      close() {
        if (open) { open = false; XCloseDisplay(dpy); }
      },
    };
  } catch {
    return null;
  }
}
