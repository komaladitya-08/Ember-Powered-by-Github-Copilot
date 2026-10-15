/**
 * Synthetic input through the XTest extension (libXtst via koffi; no compiled
 * addon). Used only while Ember borrows the cursor (tier 3), and always with a
 * way out: every step checks that the pointer is still where Ember put it and
 * that no key Ember didn't press is down, so the user can take over at once.
 * After close() every method is a harmless no-op: the Display is freed, and
 * touching it would crash the whole process.
 */

import { createRequire } from "node:module";

export interface XInput {
  pointer(): { x: number; y: number } | null;
  /** Pointer position plus button/modifier mask (Button1Mask = 256). */
  pointerState(): { x: number; y: number; mask: number } | null;
  move(x: number, y: number): void;
  button(button: number, down: boolean): void;
  /** Presses or releases an X keysym; false if the keyboard has no key for it. */
  keysym(sym: number, down: boolean): boolean;
  /**
   * Presses or releases a key by keycode. Keys Ember holds are released this way: the
   * keysym's key can change while it is down (a layout switch), the held key can't.
   */
  keycode(code: number, down: boolean): void;
  /** Keysym for a name like "Return", "s" or "F4" (0 when unknown). */
  keysymOf(name: string): number;
  /** Keycodes currently held down on the keyboard (by anyone). */
  keysDown(): number[];
  keycodeOf(sym: number): number;
  /** Does typing this keysym need Shift on the current layout? */
  needsShift(sym: number): boolean;
  activeWindow(): number;
  /** Size of the whole X screen in pixels. */
  screenSize(): { width: number; height: number };
  /**
   * The app window titled `title` (a client window, as listed in _NET_CLIENT_LIST). An exact
   * title wins over one that only contains it; when `pid` has windows, only its windows count.
   * 0 when nothing matches or several windows do: input sent to a guess could go anywhere.
   */
  findWindow(title: string, pid?: number): number;
  /**
   * The app window with keyboard focus (the focused X window mapped up to its client window,
   * comparable with findWindow), or 0. Check it after activate(), and before typing.
   */
  focusedWindow(): number;
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
    const XDisplayWidth = x11.func("int XDisplayWidth(void *dpy, int screen)");
    const XDisplayHeight = x11.func("int XDisplayHeight(void *dpy, int screen)");
    const XDefaultScreen = x11.func("int XDefaultScreen(void *dpy)");
    const XGetInputFocus = x11.func("int XGetInputFocus(void *dpy, _Out_ unsigned long *focus, _Out_ int *revertTo)");
    const XGetWindowAttributes = x11.func("int XGetWindowAttributes(void *dpy, unsigned long w, _Out_ uint8_t *attrs)");
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
    const parentOf = (win: number): number => {
      const r = [0], parent = [0], list: unknown[] = [null], n = [0];
      if (!XQueryTree(dpy, win, r, parent, list, n)) return 0;
      if (list[0]) XFree(list[0]);
      return Number(parent[0]);
    };
    /** XWindowAttributes.map_state (offset 92 on x86-64) is IsViewable. */
    const viewable = (win: number) => { const a = Buffer.alloc(136); return !!XGetWindowAttributes(dpy, win, a) && a.readInt32LE(92) === 2; };
    const managed = (win: number) => longs(win, "WM_STATE", 2).length > 0;
    /** The app window inside a top-level (ICCCM: the first one with WM_STATE), or the top-level itself. */
    const clientBelow = (top: number): number => {
      let level = [top];
      for (let depth = 0; depth < 3 && level.length && level.length <= 64; depth++) {
        const next: number[] = [];
        for (const w of level) { if (managed(w)) return w; next.push(...children(w)); }
        level = next;
      }
      return top;
    };
    /** App windows: _NET_CLIENT_LIST, or without an EWMH window manager, the clients of the mapped top-levels. */
    const clients = (): number[] => {
      const listed = longs(root, "_NET_CLIENT_LIST", 1024);
      return listed.length ? listed : children(root).filter(viewable).map(clientBelow);
    };
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
      pointerState() {
        if (!open) return null;
        const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0];
        return XQueryPointer(dpy, root, r, c, rx, ry, wx, wy, m) ? { x: rx[0], y: ry[0], mask: m[0] } : null;
      },
      move(x, y) {
        if (!open) return;
        XTestFakeMotionEvent(dpy, -1, Math.round(x), Math.round(y), 0);
        XFlush(dpy);
      },
      button(button, down) {
        if (!open) return;
        XTestFakeButtonEvent(dpy, button, down ? 1 : 0, 0);
        XFlush(dpy);
      },
      keysym(sym, down) {
        if (!open) return false;
        const code = XKeysymToKeycode(dpy, sym);
        if (!code) return false;
        XTestFakeKeyEvent(dpy, code, down ? 1 : 0, 0);
        XFlush(dpy);
        return true;
      },
      keycode(code, down) {
        if (!open || code < 8 || code > 255) return;
        XTestFakeKeyEvent(dpy, code, down ? 1 : 0, 0);
        XFlush(dpy);
      },
      keysymOf(name) {
        return Number(XStringToKeysym(name)); // needs no display
      },
      keycodeOf(sym) {
        if (!open) return 0;
        return XKeysymToKeycode(dpy, sym);
      },
      needsShift(sym) {
        if (!open) return false;
        const code = XKeysymToKeycode(dpy, sym);
        if (!code) return false;
        return Number(XKeycodeToKeysym(dpy, code, 0)) !== sym && Number(XKeycodeToKeysym(dpy, code, 1)) === sym;
      },
      keysDown() {
        if (!open) return [];
        const keys = Buffer.alloc(32);
        XQueryKeymap(dpy, keys);
        const down: number[] = [];
        for (let i = 0; i < 32; i++) for (let b = 0; b < 8; b++) if (keys[i] & (1 << b)) down.push(i * 8 + b);
        return down;
      },
      activeWindow() {
        if (!open) return 0;
        if (hasWindowManager()) return longs(root, "_NET_ACTIVE_WINDOW", 1)[0] ?? 0;
        const focus = [0], revert = [0];
        XGetInputFocus(dpy, focus, revert);
        return Number(focus[0]) > 1 ? Number(focus[0]) : 0; // 0 None, 1 PointerRoot
      },
      screenSize() {
        if (!open) return { width: 0, height: 0 };
        const n = XDefaultScreen(dpy);
        return { width: XDisplayWidth(dpy, n), height: XDisplayHeight(dpy, n) };
      },
      findWindow(title, pid) {
        if (!open || !title) return 0;
        const all = clients().map(id => ({ id, title: text(id, "_NET_WM_NAME") ?? text(id, "WM_NAME") ?? "", pid: longs(id, "_NET_WM_PID", 1)[0] }));
        // A process's own windows, when it has any: another app's window of the same name is not it.
        const theirs = pid !== undefined ? all.filter(w => w.pid === pid) : [];
        const pool = theirs.length ? theirs : all;
        const only = (list: typeof pool) => (list.length === 1 ? list[0].id : 0);
        const exact = pool.filter(w => w.title === title);
        if (exact.length) return only(exact);
        const want = title.toLowerCase();
        return only(pool.filter(w => w.title.toLowerCase().includes(want)));
      },
      focusedWindow() {
        if (!open) return 0;
        const f = [0], revert = [0];
        XGetInputFocus(dpy, f, revert);
        let id = Number(f[0]);
        if (id <= 1) return 0; // None or PointerRoot
        // Up from the focused (possibly inner) window to the app window that holds it.
        for (let hops = 0; hops < 32; hops++) {
          if (managed(id)) return id;
          const parent = parentOf(id);
          if (!parent || parent === Number(root)) return clientBelow(id); // a top-level: the frame, or an unmanaged window
          id = parent;
        }
        return 0;
      },
      activate(window) {
        if (!open) return;
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
        if (open) XSync(dpy, 0);
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
