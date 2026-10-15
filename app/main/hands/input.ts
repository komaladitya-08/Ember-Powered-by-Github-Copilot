/**
 * Synthetic input through the XTest extension (libXtst via koffi; no compiled
 * addon). Used only while Ember borrows the cursor (tier 3), and always with a
 * way out: every step checks that the pointer is still where Ember put it and
 * that no key Ember didn't press is down, so the user can take over at once.
 */

import { createRequire } from "node:module";

export interface XInput {
  pointer(): { x: number; y: number } | null;
  move(x: number, y: number): void;
  button(button: number, down: boolean): void;
  /** Presses or releases an X keysym; false if the keyboard has no key for it. */
  keysym(sym: number, down: boolean): boolean;
  /** Keysym for a name like "Return", "s" or "F4" (0 when unknown). */
  keysymOf(name: string): number;
  /** Keycodes currently held down on the keyboard (by anyone). */
  keysDown(): number[];
  keycodeOf(sym: number): number;
  /** Does typing this keysym need Shift on the current layout? */
  needsShift(sym: number): boolean;
  activeWindow(): number;
  /** Top-level window whose title contains `title` (_NET_CLIENT_LIST), or 0. */
  findWindow(title: string): number;
  /** Asks the window manager to activate a window (_NET_ACTIVE_WINDOW). */
  activate(window: number): void;
  sync(): void;
  close(): void;
}

const requireCjs = createRequire(__filename);

/** Why the last openXInput() returned null (for the log). */
export let xinputError: unknown = null;

export function openXInput(displayName?: string): XInput | null {
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const x11 = koffi.load("libX11.so.6");
    const xtst = koffi.load("libXtst.so.6");
    const XOpenDisplay = x11.func("void *XOpenDisplay(const char *name)");
    const XCloseDisplay = x11.func("int XCloseDisplay(void *dpy)");
    const XFlush = x11.func("int XFlush(void *dpy)");
    const XSync = x11.func("int XSync(void *dpy, int discard)");
    const XFree = x11.func("int XFree(void *data)");
    const XDefaultRootWindow = x11.func("unsigned long XDefaultRootWindow(void *dpy)");
    const XInternAtom = x11.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)");
    const XQueryPointer = x11.func("int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)");
    const XQueryKeymap = x11.func("int XQueryKeymap(void *dpy, _Out_ uint8_t *keys)");
    const XStringToKeysym = x11.func("unsigned long XStringToKeysym(const char *name)");
    const XKeysymToKeycode = x11.func("uint8_t XKeysymToKeycode(void *dpy, unsigned long sym)");
    const XKeycodeToKeysym = x11.func("unsigned long XKeycodeToKeysym(void *dpy, uint8_t code, int index)");
    const XGetWindowProperty = x11.func("int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)");
    const XSendEvent = x11.func("int XSendEvent(void *dpy, unsigned long w, int propagate, long mask, void *event)");
    const XQueryTree = x11.func("int XQueryTree(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *n)");
    const XSetInputFocus = x11.func("int XSetInputFocus(void *dpy, unsigned long focus, int revertTo, unsigned long time)");
    const XRaiseWindow = x11.func("int XRaiseWindow(void *dpy, unsigned long w)");
    const XGetInputFocus = x11.func("int XGetInputFocus(void *dpy, _Out_ unsigned long *focus, _Out_ int *revertTo)");
    const XTestFakeMotionEvent = xtst.func("int XTestFakeMotionEvent(void *dpy, int screen, int x, int y, unsigned long delay)");
    const XTestFakeButtonEvent = xtst.func("int XTestFakeButtonEvent(void *dpy, unsigned int button, int isPress, unsigned long delay)");
    const XTestFakeKeyEvent = xtst.func("int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int isPress, unsigned long delay)");

    const dpy = XOpenDisplay(displayName ?? null);
    if (!dpy) { xinputError = new Error("cannot open the X display"); return null; }
    const root = XDefaultRootWindow(dpy);
    let open = true;
    // Window properties, copied out of X's memory (koffi.view would abort Electron).
    const prop = (win: number, name: string, max: number): { format: number; bytes: Buffer } | null => {
      const type = [0], format = [0], items = [0], after = [0], data: unknown[] = [null];
      if (XGetWindowProperty(dpy, win, XInternAtom(dpy, name, 0), 0, max, 0, 0, type, format, items, after, data) !== 0) return null;
      const ptr = data[0];
      if (!ptr) return null;
      try {
        const n = Number(items[0]);
        const size = format[0] === 32 ? n * 8 : format[0] === 16 ? n * 2 : n;
        if (!n) return null;
        const a = koffi.decode(ptr, "uint8_t", size) as Uint8Array;
        return { format: format[0], bytes: Buffer.from(a) };
      } finally {
        XFree(ptr);
      }
    };
    const longs = (win: number, name: string, max: number): number[] => {
      const p = prop(win, name, max);
      if (!p || p.format !== 32) return [];
      return Array.from({ length: p.bytes.length / 8 }, (_, i) => Number(p.bytes.readBigUInt64LE(i * 8)));
    };
    const children = (win: number): number[] => {
      const r = [0], parent = [0], list: unknown[] = [null], n = [0];
      if (!XQueryTree(dpy, win, r, parent, list, n) || !list[0]) return [];
      try {
        const a = koffi.decode(list[0], "uint8_t", n[0] * 8) as Uint8Array;
        const b = Buffer.from(a);
        return Array.from({ length: n[0] }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
      } finally {
        XFree(list[0]);
      }
    };
    const hasWindowManager = () => longs(root, "_NET_SUPPORTING_WM_CHECK", 1).length > 0;
    const text = (win: number, name: string): string | null => {
      const p = prop(win, name, 1024);
      return p && p.format === 8 ? p.bytes.toString("utf8") : null;
    };

    return {
      pointer() {
        if (!open) return null;
        const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0];
        return XQueryPointer(dpy, root, r, c, rx, ry, wx, wy, m) ? { x: rx[0], y: ry[0] } : null;
      },
      move(x, y) {
        XTestFakeMotionEvent(dpy, -1, Math.round(x), Math.round(y), 0);
        XFlush(dpy);
      },
      button(button, down) {
        XTestFakeButtonEvent(dpy, button, down ? 1 : 0, 0);
        XFlush(dpy);
      },
      keysym(sym, down) {
        const code = XKeysymToKeycode(dpy, sym);
        if (!code) return false;
        XTestFakeKeyEvent(dpy, code, down ? 1 : 0, 0);
        XFlush(dpy);
        return true;
      },
      keysymOf(name) {
        return Number(XStringToKeysym(name));
      },
      keycodeOf(sym) {
        return XKeysymToKeycode(dpy, sym);
      },
      needsShift(sym) {
        const code = XKeysymToKeycode(dpy, sym);
        if (!code) return false;
        return Number(XKeycodeToKeysym(dpy, code, 0)) !== sym && Number(XKeycodeToKeysym(dpy, code, 1)) === sym;
      },
      keysDown() {
        const keys = Buffer.alloc(32);
        XQueryKeymap(dpy, keys);
        const down: number[] = [];
        for (let i = 0; i < 32; i++) for (let b = 0; b < 8; b++) if (keys[i] & (1 << b)) down.push(i * 8 + b);
        return down;
      },
      activeWindow() {
        if (hasWindowManager()) return longs(root, "_NET_ACTIVE_WINDOW", 1)[0] ?? 0;
        const focus = [0], revert = [0];
        XGetInputFocus(dpy, focus, revert);
        return Number(focus[0]) > 1 ? Number(focus[0]) : 0; // 0 None, 1 PointerRoot
      },
      findWindow(title) {
        const want = title.toLowerCase();
        const named = (w: number) => (text(w, "_NET_WM_NAME") ?? text(w, "WM_NAME") ?? "").toLowerCase().includes(want);
        for (const w of longs(root, "_NET_CLIENT_LIST", 1024)) if (named(w)) return w;
        // No EWMH window manager: look through the window tree (top two levels).
        for (const w of children(root)) {
          if (named(w)) return w;
          for (const c of children(w)) if (named(c)) return c;
        }
        return 0;
      },
      activate(window) {
        if (!hasWindowManager()) {
          // Without a window manager, focus and raise the window ourselves.
          XRaiseWindow(dpy, window);
          XSetInputFocus(dpy, window, 2 /* RevertToParent */, 0 /* CurrentTime */);
          XFlush(dpy);
          return;
        }
        // XClientMessageEvent on x86-64: type, serial, send_event, display, window, message_type, format, data.l[5].
        const ev = Buffer.alloc(192);
        ev.writeInt32LE(33, 0);                       // ClientMessage
        ev.writeBigUInt64LE(BigInt(window), 32);      // window
        ev.writeBigUInt64LE(BigInt(XInternAtom(dpy, "_NET_ACTIVE_WINDOW", 0)), 40);
        ev.writeInt32LE(32, 48);                      // format
        ev.writeBigInt64LE(2n, 56);                   // source indication: pager (direct user action)
        ev.writeBigInt64LE(0n, 64);                   // timestamp: current time
        const SubstructureRedirectMask = 1 << 20, SubstructureNotifyMask = 1 << 19;
        XSendEvent(dpy, root, 0, SubstructureRedirectMask | SubstructureNotifyMask, ev);
        XFlush(dpy);
      },
      sync() {
        XSync(dpy, 0);
      },
      close() {
        if (open) { open = false; XCloseDisplay(dpy); }
      },
    };
  } catch (err) {
    xinputError = err;
    return null;
  }
}
