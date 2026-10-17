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

export interface Rect { x: number; y: number; width: number; height: number }

/** A mapped top-level window, as stacked on screen. */
export interface StackedWindow {
  /** The top-level window: a window manager's frame, or the app's own window when it has none. */
  id: number;
  /** The app's window inside it (the one with WM_STATE); `id` itself for menus and tooltips. */
  client: number;
  pid: number | null;
  title: string;
  wmClass: string;
  /** What it covers on screen (root coordinates, physical pixels): the frame, less GTK's client-side shadows. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The window as its toolkit reports it (client plus _NET_FRAME_EXTENTS): GTK's accessibility frame extents. */
  outer: Rect;
  /** The app's own window, without the window manager's frame: what Chromium, Electron and Qt report over accessibility. */
  inner: Rect;
  /** Menus, tooltips and other popups the window manager doesn't manage. */
  overrideRedirect: boolean;
}

export interface X11Image {
  /** Where the image starts on the screen (the requested rectangle, clipped to the screen). */
  x: number;
  y: number;
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
   * after the pointer jumps, so Ember uses this instead. `mask`: the buttons down (X's mask: 256 is the left one).
   */
  pointer(): { x: number; y: number; mask: number } | null;
  /** The window the window manager reports as active (_NET_ACTIVE_WINDOW). */
  activeWindow(): (X11Window & { wmClass: string }) | null;
  /**
   * The top-level window that has keyboard focus (XGetInputFocus), whether or not a
   * window manager says so. Typed keys go there, so this is what safety checks use.
   */
  focusWindow(): (X11Window & { wmClass: string }) | null;
  /**
   * Every top-level window (from _NET_CLIENT_LIST, or the window tree when no
   * window manager publishes one), with its class. Used to black out private
   * windows even when they expose nothing over accessibility.
   */
  clientWindows(): (X11Window & { wmClass: string })[];
  /**
   * Every mapped top-level window (the root window's children), bottom to top: what covers
   * what on screen, including popups the window manager doesn't list.
   */
  stack(): StackedWindow[];
  /**
   * A rectangle of the screen as BGRA pixels (includes composited windows), clipped to the screen;
   * null when nothing of it is on screen.
   */
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
    const XGetInputFocus = lib.func("int XGetInputFocus(void *dpy, _Out_ unsigned long *focus, _Out_ int *revertTo)");

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

    const childrenOf = (w: number): number[] => {
      const r = [0], parent = [0], list: unknown[] = [null], n = [0];
      if (!XQueryTree(dpy, w, r, parent, list, n) || !list[0]) return [];
      try {
        const b = bytes(list[0], n[0] * 8);
        return Array.from({ length: n[0] }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
      } finally {
        XFree(list[0]);
      }
    };
    /** XWindowAttributes on x86-64: x, y, width, height, border_width at 0..16; class at 40; map_state at 92; override_redirect at 120. */
    const attributes = (w: number) => {
      const a = Buffer.alloc(136);
      if (!XGetWindowAttributes(dpy, w, a)) return null;
      const border = a.readInt32LE(16);
      return {
        x: a.readInt32LE(0), y: a.readInt32LE(4), width: a.readInt32LE(8) + 2 * border, height: a.readInt32LE(12) + 2 * border,
        viewable: a.readInt32LE(92) === 2, overrideRedirect: a.readInt32LE(120) !== 0,
        inputOnly: a.readInt32LE(40) === 2, // draws nothing, so it covers nothing
      };
    };
    const managed = (w: number) => Array.isArray(property(w, "WM_STATE", "longs"));
    /** The app's window in a top-level: itself, or the first window with WM_STATE a few levels down (ICCCM). */
    const clientOf = (top: number): number => {
      if (managed(top)) return top;
      let level = [top];
      for (let depth = 0; depth < 3 && level.length && level.length <= 64; depth++) {
        const next: number[] = [];
        for (const w of level) for (const c of childrenOf(w)) { if (managed(c)) return c; next.push(c); }
        level = next;
      }
      return top;
    };
    const longs4 = (w: number, name: string) => {
      const v = property(w, name, "longs");
      return Array.isArray(v) && v.length >= 4 ? v.slice(0, 4) : null; // left, right, top, bottom
    };

    return {
      hasCompositor(screen = 0) {
        if (!open) return true;
        return Number(XGetSelectionOwner(dpy, atom(`_NET_WM_CM_S${screen}`))) !== 0;
      },

      pointer() {
        if (!open) return null;
        const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0];
        return XQueryPointer(dpy, root, r, c, rx, ry, wx, wy, m) ? { x: rx[0], y: ry[0], mask: m[0] } : null;
      },

      activeWindow() {
        if (!open) return null;
        const active = property(root, "_NET_ACTIVE_WINDOW", "longs");
        const id = Array.isArray(active) ? active[0] : 0;
        if (!id) return null;
        const w = describe(id);
        if (!w) return null;
        const cls = property(id, "WM_CLASS", "string");
        return { ...w, wmClass: typeof cls === "string" ? cls.replace(/\0/g, " ").trim() : "" };
      },

      focusWindow() {
        if (!open) return null;
        const f = [0], revert = [0];
        XGetInputFocus(dpy, f, revert);
        let id = Number(f[0]);
        if (id <= 1) return null; // None or PointerRoot
        // Walk up from the focused (possibly inner) window to the first one with a title.
        for (let hops = 0; hops < 20; hops++) {
          const title = property(id, "_NET_WM_NAME", "string") ?? property(id, "WM_NAME", "string");
          if (typeof title === "string" && title) break;
          const r = [0], parent = [0], list: unknown[] = [null], n = [0];
          if (!XQueryTree(dpy, id, r, parent, list, n)) return null;
          if (list[0]) XFree(list[0]);
          if (!parent[0] || Number(parent[0]) === Number(root)) break;
          id = Number(parent[0]);
        }
        const w = describe(id);
        if (!w) return null;
        const cls = property(id, "WM_CLASS", "string");
        return { ...w, wmClass: typeof cls === "string" ? cls.replace(/\0/g, " ").trim() : "" };
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

      stack() {
        if (!open) return [];
        const out: StackedWindow[] = [];
        for (const top of childrenOf(root)) {
          const a = attributes(top);
          if (!a || !a.viewable || a.inputOnly || a.width <= 1 || a.height <= 1) continue;
          const client = clientOf(top);
          const pid = property(client, "_NET_WM_PID", "longs") ?? (client !== top ? property(top, "_NET_WM_PID", "longs") : null);
          const title = property(client, "_NET_WM_NAME", "string") ?? property(client, "WM_NAME", "string");
          const cls = property(client, "WM_CLASS", "string");
          const frame: Rect = { x: a.x, y: a.y, width: a.width, height: a.height };
          let inner = frame;
          if (client !== top) {
            const r = [0], gx = [0], gy = [0], w = [0], h = [0], b = [0], d = [0], ax = [0], ay = [0], child = [0];
            if (XGetGeometry(dpy, client, r, gx, gy, w, h, b, d) && XTranslateCoordinates(dpy, client, root, 0, 0, ax, ay, child)) {
              inner = { x: ax[0], y: ay[0], width: w[0], height: h[0] };
            }
          }
          const ext = longs4(client, "_NET_FRAME_EXTENTS");
          const outer = ext && client !== top
            ? { x: inner.x - ext[0], y: inner.y - ext[2], width: inner.width + ext[0] + ext[1], height: inner.height + ext[2] + ext[3] }
            : frame;
          // GTK's client-side decorations draw a transparent shadow inside the window: it covers nothing.
          const shadow = longs4(client, "_GTK_FRAME_EXTENTS");
          const seen = shadow
            ? { x: inner.x + shadow[0], y: inner.y + shadow[2], width: Math.max(0, inner.width - shadow[0] - shadow[1]), height: Math.max(0, inner.height - shadow[2] - shadow[3]) }
            : frame;
          out.push({
            id: top, client, pid: Array.isArray(pid) ? pid[0] : null, title: typeof title === "string" ? title : "",
            wmClass: typeof cls === "string" ? cls.replace(/\0/g, " ").trim() : "",
            ...seen, outer, inner, overrideRedirect: a.overrideRedirect,
          });
        }
        return out;
      },

      capture(x, y, width, height) {
        if (!open || width <= 0 || height <= 0) return null;
        // Any part outside the root window makes XGetImage fail with BadMatch, which Xlib's default
        // error handler answers by exiting the process: clip to the screen first.
        const r = [0], gx = [0], gy = [0], rw = [0], rh = [0], b = [0], d = [0];
        if (!XGetGeometry(dpy, root, r, gx, gy, rw, rh, b, d)) return null;
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(rw[0], Math.floor(x + width)), y1 = Math.min(rh[0], Math.floor(y + height));
        if (x1 <= x0 || y1 <= y0) return null;
        XSync(dpy, 0);
        const ZPixmap = 2;
        const img = XGetImage(dpy, root, x0, y0, x1 - x0, y1 - y0, BigInt("0xffffffffffffffff"), ZPixmap);
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
          return { x: x0, y: y0, width: info.width, height: info.height, bgra };
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
