/**
 * Small libX11 helpers through koffi (no compiled addon of our own).
 * Everything is optional: if libX11 or the display is unavailable, callers get
 * null and fall back to safe defaults.
 */

import { createRequire } from "node:module";

export interface X11Window {
  id: number;
  pid: number | null;
  title: string;
  /** Outer geometry in root (screen) coordinates, physical pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface X11Image {
  width: number;
  height: number;
  /** BGRA pixels (ZPixmap, 32 bits per pixel, little-endian), stride = width * 4. */
  bgra: Buffer;
}

export interface X11 {
  /** True when a compositing manager owns _NET_WM_CM_S<screen> (transparency works). */
  hasCompositor(screen?: number): boolean;
  /**
   * Pointer position in physical pixels, read straight from the X server.
   * Electron's screen.getCursorScreenPoint() can return a stale position on X11
   * after the pointer jumps, so Ember uses this instead.
   */
  pointer(): { x: number; y: number } | null;
  /** The window the window manager reports as active (_NET_ACTIVE_WINDOW). */
  activeWindow(): X11Window | null;
  /**
   * Every top-level window (from _NET_CLIENT_LIST, or the window tree when no
   * window manager publishes one), with its class. Used to black out private
   * windows even when they expose nothing over accessibility.
   */
  clientWindows(): (X11Window & { wmClass: string })[];
  /** A rectangle of the screen as BGRA pixels (includes composited windows). */
  capture(x: number, y: number, width: number, height: number): X11Image | null;
  close(): void;
}

const requireCjs = createRequire(__filename);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- koffi's type handle
let ximageType: any = null;

export function openX11(displayName?: string): X11 | null {
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const lib = koffi.load("libX11.so.6");
    // koffi type names are process-wide: define the struct once, however many displays are opened.
    ximageType ??= koffi.struct("EmberXImage", {
      width: "int", height: "int", xoffset: "int", format: "int", data: "void *",
      byte_order: "int", bitmap_unit: "int", bitmap_bit_order: "int", bitmap_pad: "int",
      depth: "int", bytes_per_line: "int", bits_per_pixel: "int",
      red_mask: "unsigned long", green_mask: "unsigned long", blue_mask: "unsigned long",
    });
    const XImage = ximageType;
    const XOpenDisplay = lib.func("void *XOpenDisplay(const char *name)");
    const XCloseDisplay = lib.func("int XCloseDisplay(void *dpy)");
    const XFree = lib.func("int XFree(void *data)");
    const XInternAtom = lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)");
    const XGetSelectionOwner = lib.func("unsigned long XGetSelectionOwner(void *dpy, unsigned long atom)");
    const XDefaultRootWindow = lib.func("unsigned long XDefaultRootWindow(void *dpy)");
    const XQueryPointer = lib.func("int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)");
    const XGetWindowProperty = lib.func("int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)");
    const XGetGeometry = lib.func("int XGetGeometry(void *dpy, unsigned long d, _Out_ unsigned long *root, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *w, _Out_ unsigned int *h, _Out_ unsigned int *border, _Out_ unsigned int *depth)");
    const XTranslateCoordinates = lib.func("int XTranslateCoordinates(void *dpy, unsigned long src, unsigned long dest, int sx, int sy, _Out_ int *dx, _Out_ int *dy, _Out_ unsigned long *child)");
    const XQueryTree = lib.func("int XQueryTree(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *n)");
    const XGetWindowAttributes = lib.func("int XGetWindowAttributes(void *dpy, unsigned long w, _Out_ uint8_t *attrs)");
    const XGetImage = lib.func("EmberXImage *XGetImage(void *dpy, unsigned long d, int x, int y, unsigned int w, unsigned int h, unsigned long planeMask, int format)");
    const XDestroyImage = lib.func("int XDestroyImage(EmberXImage *image)");
    const XSync = lib.func("int XSync(void *dpy, int discard)");

    const dpy = XOpenDisplay(displayName ?? null);
    if (!dpy) return null;
    const root = XDefaultRootWindow(dpy);
    const atom = (name: string) => XInternAtom(dpy, name, 0);
    let open = true;

    // Copies native memory into a Buffer. koffi.view() would be zero-copy, but it creates an external
    // ArrayBuffer, which Electron's V8 memory cage forbids (the process aborts).
    const bytes = (ptr: unknown, n: number): Buffer => {
      const a = koffi.decode(ptr, "uint8_t", n) as Uint8Array;
      return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    };

    /** Reads a window property as numbers (format 32) or a string (format 8). */
    const property = (win: number | bigint, name: string, kind: "longs" | "string"): number[] | string | null => {
      const type = [0], format = [0], items = [0], after = [0], data: unknown[] = [null];
      if (XGetWindowProperty(dpy, win, atom(name), 0, 4096, 0, 0, type, format, items, after, data) !== 0) return null;
      const ptr = data[0];
      const n = Number(items[0]);
      if (!ptr || n === 0) { if (ptr) XFree(ptr); return null; }
      try {
        if (kind === "longs" && format[0] === 32) {
          // Format-32 items are C longs (8 bytes on x86-64). koffi.decode returns doubles here, so read raw.
          const buf = bytes(ptr, n * 8);
          return Array.from({ length: n }, (_, i) => Number(buf.readBigUInt64LE(i * 8)));
        }
        if (kind === "string" && format[0] === 8) {
          return bytes(ptr, n).toString("utf8");
        }
        return null;
      } finally {
        XFree(ptr);
      }
    };

    /** Title, pid and on-screen geometry of a window. */
    const describe = (id: number): X11Window | null => {
      const pid = property(id, "_NET_WM_PID", "longs");
      const title = property(id, "_NET_WM_NAME", "string") ?? property(id, "WM_NAME", "string");
      const r = [0], gx = [0], gy = [0], w = [0], h = [0], b = [0], d = [0];
      if (!XGetGeometry(dpy, id, r, gx, gy, w, h, b, d)) return null;
      const ax = [0], ay = [0], child = [0];
      XTranslateCoordinates(dpy, id, root, 0, 0, ax, ay, child);
      return {
        id, pid: Array.isArray(pid) ? pid[0] : null, title: typeof title === "string" ? title : "",
        x: ax[0], y: ay[0], width: w[0], height: h[0],
      };
    };

    return {
      hasCompositor(screen = 0) {
        if (!open) return true;
        return Number(XGetSelectionOwner(dpy, atom(`_NET_WM_CM_S${screen}`))) !== 0;
      },

      pointer() {
        if (!open) return null;
        const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0];
        return XQueryPointer(dpy, root, r, c, rx, ry, wx, wy, m) ? { x: rx[0], y: ry[0] } : null;
      },

      activeWindow() {
        if (!open) return null;
        const active = property(root, "_NET_ACTIVE_WINDOW", "longs");
        const id = Array.isArray(active) ? active[0] : 0;
        if (!id) return null;
        return describe(id);
      },

      clientWindows() {
        if (!open) return [];
        const listed = property(root, "_NET_CLIENT_LIST", "longs");
        let ids = Array.isArray(listed) ? listed : [];
        if (!ids.length) {
          // No EWMH window manager: the root's mapped children are the top-level windows.
          const r = [0], parent = [0], list: unknown[] = [null], n = [0];
          if (XQueryTree(dpy, root, r, parent, list, n) && list[0]) {
            try {
              const b = bytes(list[0], n[0] * 8);
              ids = Array.from({ length: n[0] }, (_, i) => Number(b.readBigUInt64LE(i * 8)))
                .filter(w => { const a = Buffer.alloc(136); return XGetWindowAttributes(dpy, w, a) && a.readInt32LE(92) === 2; }); // map_state == IsViewable
            } finally {
              XFree(list[0]);
            }
          }
        }
        const out: (X11Window & { wmClass: string })[] = [];
        for (const id of ids) {
          const w = describe(id);
          if (!w) continue;
          const cls = property(id, "WM_CLASS", "string");
          out.push({ ...w, wmClass: typeof cls === "string" ? cls.replace(/\0/g, " ").trim() : "" });
        }
        return out;
      },

      capture(x, y, width, height) {
        if (!open || width <= 0 || height <= 0) return null;
        XSync(dpy, 0);
        const ZPixmap = 2;
        const img = XGetImage(dpy, root, x, y, width, height, BigInt("0xffffffffffffffff"), ZPixmap);
        if (!img) return null;
        try {
          const info = koffi.decode(img, XImage) as { width: number; height: number; data: unknown; bytes_per_line: number; bits_per_pixel: number };
          if (info.bits_per_pixel !== 32) return null;
          const raw = bytes(info.data, info.bytes_per_line * info.height);
          const stride = info.width * 4;
          let bgra = raw; // already a copy, safe after XDestroyImage
          if (info.bytes_per_line !== stride) {
            bgra = Buffer.alloc(stride * info.height);
            for (let row = 0; row < info.height; row++) raw.copy(bgra, row * stride, row * info.bytes_per_line, row * info.bytes_per_line + stride);
          }
          return { width: info.width, height: info.height, bgra };
        } finally {
          XDestroyImage(img);
        }
      },

      close() {
        if (open) { open = false; XCloseDisplay(dpy); }
      },
    };
  } catch {
    return null;
  }
}
