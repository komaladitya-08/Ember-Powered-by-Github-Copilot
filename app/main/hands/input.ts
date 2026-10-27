/**
 * Synthetic input through the XTest extension (libXtst via koffi; no compiled
 * addon). Used only while Ember borrows the cursor (tier 3), and always with a
 * way out: every step checks that the pointer is still where Ember put it and
 * that no key Ember didn't press is down, so the user can take over at once.
 * After close() every method is a harmless no-op: the Display is freed, and
 * touching it would crash the whole process. Keys and buttons Ember still holds
 * are let go before the connection closes.
 */

import { createRequire } from "node:module";
import { shiftKey, type KeyLayout, type KeyLevels } from "./keymap";

export interface XInput {
  pointer(): { x: number; y: number } | null;
  /** Pointer position plus button/modifier mask (Button1Mask = 256). */
  pointerState(): { x: number; y: number; mask: number } | null;
  move(x: number, y: number): void;
  /** Presses or releases a logical button (1 left, 2 middle, 3 right, 4–7 wheel), whatever the pointer map. */
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
   * The app window titled `title` (a client window, as listed in _NET_CLIENT_LIST). When `pid` has
   * windows, only its windows count, and an exact title wins over one that only contains it.
   * Otherwise (no pid, or the process has no window here) only an exact title counts, and it must
   * be the app's when `wmClass` is given (either part of WM_CLASS, any case).
   * 0 when nothing matches or several windows do: input sent to a guess could go anywhere.
   */
  findWindow(title: string, pid?: number, wmClass?: string): number;
  /**
   * The app window with keyboard focus (the focused X window mapped up to its client window,
   * comparable with findWindow), or 0. Check it after activate(), and before typing.
   */
  focusedWindow(): number;
  /** Asks the window manager to activate a window (_NET_ACTIVE_WINDOW). */
  activate(window: number): void;
  /**
   * Gives one of Ember's own windows the keyboard at once (XSetInputFocus), where the window manager
   * wouldn't activate it (openbox never activates a toolbar window on its own).
   */
  focusInput?(window: number): void;
  sync(): void;
  /** Lets go of every key and mouse button Ember pressed and hasn't released yet (close() does this too). */
  releaseAll(): void;
  close(): void;
  /** The active keyboard group's keys, as typing would use them now (null without XKB). */
  layout?(): KeyLayout | null;
  /**
   * Has another program grabbed the keyboard (a lock screen, a password prompt, the overview)?
   * Keys and clicks would go to it. A menu or dropdown list that `window`'s own app opened grabs it too:
   * that doesn't count (its tooltips and other popups don't explain a grab).
   */
  keyboardGrabbed?(window?: number): boolean;
  /**
   * Would a click at the pointer land in `window`: is the top-level window under the pointer its frame, or a
   * menu or dropdown list its app opened over it? Not another window of the app (a dialog, a palette) unless
   * it is `elementWindow`, the window the caller says the element is in. Windows that let clicks through don't count.
   */
  pointerOn?(window: number, elementWindow?: number): boolean;
  /** Is the screen saver on or the screen blanked? (false when the server can't say) */
  screenLocked?(): boolean;
  /**
   * Starts (true) or stops (false) watching the user's own mouse and keyboard as XInput2 raw events;
   * false when XInput2 isn't available (the pointer and keys can then only be polled).
   */
  watchUser?(on: boolean): boolean;
  /** What the user did since the last call, on their own devices (never Ember's XTest input). */
  userInput?(): "pointer" | "keys" | null;
}

const requireCjs = createRequire(__filename);

/** Why the last openXInput() returned null (for the log). */
export let xinputError: unknown = null;

/** XI2 raw events (XI_RawKeyPress … XI_RawMotion): anything the user does with a mouse or keyboard. */
const RAW_EVENTS = [13, 14, 15, 16, 17];
const RAW_KEY_EVENTS = new Set([13, 14]);
const RAW_KEY_PRESS = 13, RAW_BUTTON_PRESS = 15;
/** EWMH window types (_NET_WM_WINDOW_TYPE_…), and those of an app's menus and dropdown lists. */
const WINDOW_TYPES = ["NORMAL", "DIALOG", "UTILITY", "TOOLBAR", "MENU", "DROPDOWN_MENU", "POPUP_MENU", "COMBO", "TOOLTIP", "NOTIFICATION", "SPLASH", "DND", "DOCK", "DESKTOP"];
const MENU_TYPES = new Set(["MENU", "DROPDOWN_MENU", "POPUP_MENU", "COMBO"]);

/**
 * The physical button to send through XTest for a logical one. X maps XTest's buttons through the core pointer map
 * (`map[i]`: what physical button i + 1 gives) like the hardware's, so with a left-handed map (xmodmap "pointer =
 * 3 2 1") button 1 would arrive as a right click. The first physical button that gives `logical`, else `logical`
 * itself (nothing gives it, or the map couldn't be read). The wheel is mapped too: scrolling down stays down.
 */
export function physicalButton(map: readonly number[], logical: number): number {
  const i = map.indexOf(logical);
  return i >= 0 ? i + 1 : logical;
}

export function openXInput(displayName?: string): XInput | null {
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const x11 = koffi.load("libX11.so.6");
    const xtst = koffi.load("libXtst.so.6");
    // Optional: XInput2 (the user's input as events), the screen saver and DPMS (is the screen locked or blank?).
    const optional = (name: string) => { try { return koffi.load(name); } catch { return null; } };
    const xi = optional("libXi.so.6"), xss = optional("libXss.so.1"), xext = optional("libXext.so.6");
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
    const XGetPointerMapping = x11.func("int XGetPointerMapping(void *dpy, _Out_ uint8_t *map, int n)");
    const XTestFakeMotionEvent = xtst.func("int XTestFakeMotionEvent(void *dpy, int screen, int x, int y, unsigned long delay)");
    const XTestFakeButtonEvent = xtst.func("int XTestFakeButtonEvent(void *dpy, unsigned int button, int isPress, unsigned long delay)");
    const XTestFakeKeyEvent = xtst.func("int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int isPress, unsigned long delay)");
    const XGrabKeyboard = x11.func("int XGrabKeyboard(void *dpy, unsigned long w, int ownerEvents, int pointerMode, int keyboardMode, unsigned long time)");
    const XCreateWindow = x11.func("unsigned long XCreateWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, int depth, unsigned int cls, void *visual, unsigned long mask, void *attrs)");
    const XSelectInput = x11.func("int XSelectInput(void *dpy, unsigned long w, long mask)");
    const XChangeProperty = x11.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const uint8_t *data, int n)");
    const XCheckTypedWindowEvent = x11.func("int XCheckTypedWindowEvent(void *dpy, unsigned long w, int type, _Out_ uint8_t *ev)");
    const XUngrabKeyboard = x11.func("int XUngrabKeyboard(void *dpy, unsigned long time)");
    const XkbGetState = x11.func("int XkbGetState(void *dpy, unsigned int device, _Out_ uint8_t *state)");
    const XkbGetMap = x11.func("void *XkbGetMap(void *dpy, unsigned int which, unsigned int device)");
    const XkbGetControls = x11.func("int XkbGetControls(void *dpy, unsigned long which, void *xkb)");
    const XkbFreeKeyboard = x11.func("void XkbFreeKeyboard(void *xkb, unsigned int which, int freeAll)");
    const XkbTranslateKeyCode = x11.func("int XkbTranslateKeyCode(void *xkb, uint8_t key, unsigned int state, _Out_ unsigned int *modsRtrn, _Out_ unsigned long *sym)");

    const dpy = XOpenDisplay(displayName ?? null);
    if (!dpy) { xinputError = new Error("cannot open the X display"); return null; }
    const root = XDefaultRootWindow(dpy);
    let open = true;
    // What Ember holds down right now: let go of before the connection closes, or the server keeps them down.
    // Buttons: logical button → the physical one that went down (the pointer map may change while it is held).
    const keysHeld = new Set<number>(), buttonsHeld = new Map<number, number>();
    const ScreenSaverOn = 1, XkbUseCoreKbd = 0x100, ShiftMask = 1, LockMask = 2;
    const atoms = new Map<string, number>();
    const atom = (name: string): number => {
      let a = atoms.get(name);
      if (a === undefined) atoms.set(name, a = Number(XInternAtom(dpy, name, 0)));
      return a;
    };
    // Window properties, copied out of X's memory (koffi.view would abort Electron).
    const prop = (win: number, name: string, max: number): { format: number; bytes: Buffer } | null => {
      const type = [0], format = [0], items = [0], after = [0], data: unknown[] = [null];
      if (XGetWindowProperty(dpy, win, atom(name), 0, max, 0, 0, type, format, items, after, data) !== 0) return null;
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
    /** The top-level window (a child of the root: a frame, or an unmanaged window) that holds `win`, or 0. */
    const topLevelOf = (win: number): number => {
      for (let hops = 0; hops < 32 && win; hops++) {
        const parent = parentOf(win);
        if (parent === Number(root)) return win;
        win = parent;
      }
      return 0;
    };
    /** XWindowAttributes: map_state (offset 92) IsViewable, override_redirect (offset 120). */
    const isPopup = (win: number) => {
      const a = Buffer.alloc(136);
      return !!XGetWindowAttributes(dpy, win, a) && a.readInt32LE(92) === 2 && a.readInt32LE(120) !== 0;
    };
    /** Do these windows belong to the same app: the same process, or one is the other's dialog or menu? */
    const sameApp = (top: number, window: number): boolean => {
      const client = clientBelow(top);
      const pid = longs(client, "_NET_WM_PID", 1)[0] ?? longs(top, "_NET_WM_PID", 1)[0];
      const want = longs(window, "_NET_WM_PID", 1)[0];
      if (pid && want) return pid === want;
      if (longs(client, "WM_TRANSIENT_FOR", 1)[0] === window) return true;
      const leader = longs(client, "WM_CLIENT_LEADER", 1)[0];
      return !!leader && leader === longs(window, "WM_CLIENT_LEADER", 1)[0];
    };
    const classOf = (win: number): string[] => (text(win, "WM_CLASS") ?? "").split("\0").filter(Boolean).map(c => c.toLowerCase());
    /** The window's EWMH type: the first one in its list that Ember knows ("POPUP_MENU", "TOOLTIP"…), or "" for none. */
    const windowType = (win: number): string => {
      for (const a of longs(win, "_NET_WM_WINDOW_TYPE", 8)) {
        const type = WINDOW_TYPES.find(t => atom(`_NET_WM_WINDOW_TYPE_${t}`) === a);
        if (type) return type;
      }
      return "";
    };
    /** A menu or dropdown list `window`'s app opened: a popup of the app that says it is one. */
    const ownMenu = (popup: number, window: number) => isPopup(popup) && MENU_TYPES.has(windowType(popup)) && sameApp(popup, window);

    // Is the screen saver on, or the monitor off (DPMS)? Both extensions are optional.
    const ext = [0], err = [0];
    const ssInfo = xss && xss.func("int XScreenSaverQueryExtension(void *dpy, _Out_ int *ev, _Out_ int *err)")(dpy, ext, err)
      ? xss.func("int XScreenSaverQueryInfo(void *dpy, unsigned long drawable, _Out_ uint8_t *info)") : null;
    const dpms = xext && xext.func("int DPMSQueryExtension(void *dpy, _Out_ int *ev, _Out_ int *err)")(dpy, ext, err)
      && xext.func("int DPMSCapable(void *dpy)")(dpy) ? xext.func("int DPMSInfo(void *dpy, _Out_ uint16_t *level, _Out_ uint8_t *on)") : null;

    // The server's clock, read from a PropertyNotify on an unmapped input-only window of Ember's (invisible).
    const clock = Number(XCreateWindow(dpy, root, -1, -1, 1, 1, 0, 0, 2 /* InputOnly */, null, 0, null));
    XSelectInput(dpy, clock, 1 << 22 /* PropertyChangeMask */);
    const clockAtom = XInternAtom(dpy, "_EMBER_TIME", 0);
    const serverTime = (): number => {
      XChangeProperty(dpy, clock, clockAtom, 19 /* INTEGER */, 8, 2 /* PropModeAppend */, Buffer.alloc(0), 0);
      XSync(dpy, 0);
      const ev = Buffer.alloc(192);
      return XCheckTypedWindowEvent(dpy, clock, 28 /* PropertyNotify */, ev) ? ev.readUInt32LE(48) : 0; // XPropertyEvent.time
    };

    // XInput2 raw events on a second connection: a click, a key tap or a wheel notch from the user between
    // two of Ember's checks still arrives (polling the pointer and the keys would miss it). Opened now, while
    // this display's credentials are at hand; it receives nothing until a borrow starts watching.
    const watch = xi ? openWatch(koffi, x11, xi, displayName, dpy) : null;
    let watchers = 0;

    /** The core pointer map, read per press: the user can swap the buttons while Ember runs. */
    const pointerMap = (): number[] => {
      const map = Buffer.alloc(256);
      const n = XGetPointerMapping(dpy, map, map.length);
      return n > 0 ? [...map.subarray(0, Math.min(n, map.length))] : [];
    };
    const keycode = (code: number, down: boolean) => {
      if (!open || code < 8 || code > 255) return;
      if (down) watch?.sent("keys");
      XTestFakeKeyEvent(dpy, code, down ? 1 : 0, 0);
      XFlush(dpy);
      if (down) keysHeld.add(code); else keysHeld.delete(code);
    };
    const releaseAll = () => {
      if (!open) return;
      for (const code of keysHeld) XTestFakeKeyEvent(dpy, code, 0, 0);
      for (const b of buttonsHeld.values()) XTestFakeButtonEvent(dpy, b, 0, 0);
      keysHeld.clear();
      buttonsHeld.clear();
      XSync(dpy, 0);
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
        if (down) watch?.sent("pointer");
        // The physical button the pointer map turns into this one; a release lets go of the one that went down.
        const sent = (!down && buttonsHeld.get(button)) || physicalButton(pointerMap(), button);
        XTestFakeButtonEvent(dpy, sent, down ? 1 : 0, 0);
        XFlush(dpy);
        if (down) buttonsHeld.set(button, sent); else buttonsHeld.delete(button);
      },
      keysym(sym, down) {
        if (!open) return false;
        const code = XKeysymToKeycode(dpy, sym);
        if (!code) return false;
        keycode(code, down);
        return true;
      },
      keycode,
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
      findWindow(title, pid, wmClass) {
        if (!open || !title) return 0;
        const all = clients().map(id => ({ id, title: text(id, "_NET_WM_NAME") ?? text(id, "WM_NAME") ?? "", pid: longs(id, "_NET_WM_PID", 1)[0] }));
        const only = (list: typeof all) => (list.length === 1 ? list[0].id : 0);
        // A process's own windows, when it has any: another app's window of the same name is not it.
        const theirs = pid !== undefined ? all.filter(w => w.pid === pid) : [];
        if (theirs.length) {
          const exact = theirs.filter(w => w.title === title);
          if (exact.length) return only(exact);
          const want = title.toLowerCase();
          return only(theirs.filter(w => w.title.toLowerCase().includes(want)));
        }
        // No process to go by (it closed, or its pid is from another namespace, as in a Flatpak): only the exact
        // title, and the app's class when known. A title that merely contains it could be anyone's window.
        const cls = wmClass?.toLowerCase();
        return only(all.filter(w => w.title === title && (!cls || classOf(w.id).includes(cls))));
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
      focusInput(window) {
        if (!open) return;
        XSetInputFocus(dpy, window, 2 /* RevertToParent */, 0 /* CurrentTime */);
        XFlush(dpy);
      },
      layout() {
        if (!open) return null;
        // XkbStateRec: group (0), mods (6) — the effective group and modifiers, locks included.
        const st = Buffer.alloc(18);
        if (XkbGetState(dpy, XkbUseCoreKbd, st) !== 0) return null;
        const group = st[0], mods = st[6];
        const xkb = XkbGetMap(dpy, 3 /* XkbKeyTypesMask | XkbKeySymsMask */, XkbUseCoreKbd);
        if (!xkb) return null;
        try {
          // XkbDescRec: min_key_code (12), max_key_code (13).
          const head = koffi.decode(xkb, "uint8_t", 14) as Uint8Array;
          const used = [0], sym = [0];
          const at = (code: number, m: number, g: number) => (XkbTranslateKeyCode(xkb, code, (m & 0xff) | ((g & 3) << 13), used, sym) ? Number(sym[0]) : 0);
          const levels = (m: number, g = group): KeyLevels => {
            const keys: KeyLevels = new Map();
            for (let code = head[12]; code <= head[13]; code++) keys.set(code, [at(code, m, g), at(code, m | ShiftMask, g)]);
            return keys;
          };
          const typing = levels(mods);
          const shortcuts = mods & LockMask ? levels(mods & ~LockMask) : typing;
          // The other groups (layouts) the keyboard has: XkbDescRec.ctrls (16) → XkbControlsRec.num_groups (1).
          const ctrls = XkbGetControls(dpy, 1 << 27 /* XkbGroupsWrapMask */, xkb) === 0 ? koffi.decode(xkb, 16, "void *") : null;
          const groups = ctrls ? (koffi.decode(ctrls, "uint8_t", 2) as Uint8Array)[1] : 1;
          const others: KeyLevels[] = [];
          for (let g = 0; g < Math.min(groups, 4); g++) if (g !== group % groups) others.push(levels(mods & ~LockMask, g));
          return { typing, shortcuts, shift: shiftKey(shortcuts), others };
        } finally {
          XkbFreeKeyboard(xkb, 0, 1);
        }
      },
      keyboardGrabbed(window) {
        if (!open) return false;
        // The only way X tells is a grab request. Its time is a minute ahead, so the server answers AlreadyGrabbed
        // when someone has the keyboard and otherwise refuses it as GrabInvalidTime: Ember never really grabs the
        // keyboard, and the focused app gets no focus-out (a grab would make GTK apps lose focus and Firefox close
        // its open menus and dropdowns).
        const now = serverTime();
        const status = XGrabKeyboard(dpy, root, 0, 1 /* GrabModeAsync */, 1, now ? (now + 60_000) >>> 0 : 0 /* CurrentTime */);
        if (status === 0) { XUngrabKeyboard(dpy, 0); XFlush(dpy); return false; }
        if (status !== 1 && status !== 4) return false; // only AlreadyGrabbed and GrabFrozen mean someone has it
        // The app's own open menu or dropdown list holds the grab: keys for it are the app's. Its other popups
        // (a tooltip, one that doesn't say what it is) don't explain a grab: someone else may have the keyboard.
        return !(window && children(root).some(w => ownMenu(w, window)));
      },
      pointerOn(window, elementWindow) {
        if (!open || !window) return false;
        // The server's own answer: the top-level that would get a click here (windows that let clicks through are skipped).
        const r = [0], c = [0], rx = [0], ry = [0], wx = [0], wy = [0], m = [0];
        if (!XQueryPointer(dpy, root, r, c, rx, ry, wx, wy, m)) return false;
        const top = Number(c[0]);
        if (!top) return false; // the bare desktop
        const targets = elementWindow ? [window, elementWindow] : [window];
        if (targets.some(w => top === w || top === topLevelOf(w))) return true;
        // Else only a popup the app opened over it: its menu or dropdown list, or one tied to the window
        // (WM_TRANSIENT_FOR) that isn't a tooltip or a notification. Never another of the app's windows
        // (its dialog over that spot): the click would do something else there.
        if (!isPopup(top)) return false;
        const type = windowType(top);
        if (MENU_TYPES.has(type)) return sameApp(top, window);
        return type !== "TOOLTIP" && type !== "NOTIFICATION" && targets.includes(longs(top, "WM_TRANSIENT_FOR", 1)[0] ?? 0);
      },
      screenLocked() {
        if (!open) return false;
        if (ssInfo) {
          // XScreenSaverInfo: window (0), state (8).
          const info = Buffer.alloc(40);
          if (ssInfo(dpy, root, info) && info.readInt32LE(8) === ScreenSaverOn) return true;
        }
        if (dpms) {
          const level = [0], on = [0];
          if (dpms(dpy, level, on) && on[0] && level[0] !== 0 /* DPMSModeOn */) return true;
        }
        return false;
      },
      watchUser(on) {
        if (!open || !watch) return false;
        if (on) { if (watchers++ === 0) watch.select(true); } else if (watchers > 0 && --watchers === 0) watch.select(false);
        return true;
      },
      userInput() {
        return open && watch && watchers > 0 ? watch.drain() : null;
      },
      sync() {
        if (open) XSync(dpy, 0);
      },
      releaseAll,
      close() {
        if (!open) return;
        // A borrow still running when Ember quits must not leave a key or button down.
        releaseAll();
        open = false;
        watch?.close();
        XCloseDisplay(dpy);
      },
    };
  } catch (err) {
    xinputError = err;
    return null;
  }
}

interface Watch {
  /** Starts (or stops) the raw events; anything that arrived before is dropped. */
  select(on: boolean): void;
  /** Ember presses a key or a mouse button (or turns the wheel) through XTest now. */
  sent(kind: "pointer" | "keys"): void;
  /** Reads what arrived: "pointer" if the user used a mouse, else "keys" if a keyboard, else null. */
  drain(): "pointer" | "keys" | null;
  close(): void;
}

/**
 * A second connection that receives XInput2 raw events (every device's input, even while another client
 * grabs it), leaving out Ember's own XTest input. It is only read when Ember asks (no timer): events queue
 * on the connection meanwhile, so nothing between two reads is lost. null when XInput2 isn't there.
 */
function openWatch(koffi: typeof import("koffi"), x11: import("koffi").LibraryHandle, xi: import("koffi").LibraryHandle, displayName: string | undefined, main: unknown): Watch | null {
  const XOpenDisplay = x11.func("void *XOpenDisplay(const char *name)");
  const XCloseDisplay = x11.func("int XCloseDisplay(void *dpy)");
  const XDefaultRootWindow = x11.func("unsigned long XDefaultRootWindow(void *dpy)");
  const XQueryExtension = x11.func("int XQueryExtension(void *dpy, const char *name, _Out_ int *opcode, _Out_ int *event, _Out_ int *error)");
  const XSync = x11.func("int XSync(void *dpy, int discard)");
  const XPending = x11.func("int XPending(void *dpy)");
  const XNextEvent = x11.func("int XNextEvent(void *dpy, _Out_ uint8_t *ev)");
  const XGetEventData = x11.func("int XGetEventData(void *dpy, uint8_t *cookie)");
  const XFreeEventData = x11.func("void XFreeEventData(void *dpy, uint8_t *cookie)");
  const XIQueryVersion = xi.func("int XIQueryVersion(void *dpy, _Inout_ int *major, _Inout_ int *minor)");
  const XIGetClientPointer = xi.func("int XIGetClientPointer(void *dpy, unsigned long win, _Out_ int *device)");
  const DeviceInfo = koffi.struct({ deviceid: "int", name: "const char *", use: "int", attachment: "int", enabled: "int", num_classes: "int", classes: "void *" });
  const EventMask = koffi.struct({ deviceid: "int", mask_len: "int", mask: "uint8_t *" });
  const XIQueryDevice = xi.func("void *XIQueryDevice(void *dpy, int device, _Out_ int *n)");
  const XIFreeDeviceInfo = xi.func("void XIFreeDeviceInfo(void *info)");
  const XISelectEvents = xi.func("XISelectEvents", "int", ["void *", "unsigned long", koffi.pointer(EventMask), "int"]);

  const dpy = XOpenDisplay(displayName ?? null);
  if (!dpy) return null;
  try {
    const opcode = [0], ev = [0], er = [0], major = [2], minor = [2];
    if (!XQueryExtension(dpy, "XInputExtension", opcode, ev, er) || XIQueryVersion(dpy, major, minor) !== 0 || major[0] < 2) throw new Error("no XInput2");
    // Ember's XTest input comes from its client pointer's XTEST devices ("Virtual core XTEST pointer" and "… keyboard").
    const n = [0];
    const list = XIQueryDevice(dpy, 0 /* XIAllDevices */, n);
    if (!list) throw new Error("no devices");
    const devices = koffi.decode(list, koffi.array(DeviceInfo, n[0])) as { deviceid: number; name: string }[];
    XIFreeDeviceInfo(list);
    const pointer = [0];
    const master = (XIGetClientPointer(main, 0, pointer) && devices.find(d => d.deviceid === pointer[0])?.name) || "Virtual core pointer";
    const prefix = master.replace(/ pointer$/, "");
    const ours = new Set(devices.filter(d => d.name === `${prefix} XTEST pointer` || d.name === `${prefix} XTEST keyboard`).map(d => d.deviceid));
    // Without both, Ember's own input would look like the user's.
    if (ours.size !== 2) throw new Error("no XTEST devices");
    const root = XDefaultRootWindow(dpy);
    const event = Buffer.alloc(192); // XEvent
    let open = true, selected = false;
    // Every XTest client shares those devices (xdotool, an on-screen keyboard, remote support): presses and wheel
    // notches beyond the ones Ember sent are someone else's. (Their pointer motion can't be told from Ember's.)
    const sent = { pointer: 0, keys: 0 };
    const drain = (): "pointer" | "keys" | null => {
      let seen: "pointer" | "keys" | null = null;
      while (open && XPending(dpy) > 0) {
        XNextEvent(dpy, event);
        // XGenericEventCookie: type (0) GenericEvent, extension (32), data (48).
        if (event.readInt32LE(0) !== 35 || event.readInt32LE(32) !== opcode[0] || !XGetEventData(dpy, event)) continue;
        try {
          // XIRawEvent: evtype (36), sourceid (52): the device it came from.
          const raw = Buffer.from(koffi.decode(koffi.decode(event, 48, "void *"), "uint8_t", 56) as Uint8Array);
          const type = raw.readInt32LE(36);
          const kind = RAW_KEY_EVENTS.has(type) ? "keys" : "pointer";
          if (ours.has(raw.readInt32LE(52))) {
            if (type !== RAW_KEY_PRESS && type !== RAW_BUTTON_PRESS) continue;
            if (sent[kind] > 0) { sent[kind]--; continue; }
          }
          seen = kind === "keys" ? seen ?? "keys" : "pointer";
        } finally {
          XFreeEventData(dpy, event);
        }
      }
      return seen;
    };
    return {
      select(on) {
        if (!open) return;
        const mask = [0, 0, 0, 0];
        if (on) for (const e of RAW_EVENTS) mask[e >> 3] |= 1 << (e & 7);
        XISelectEvents(dpy, root, { deviceid: 1 /* XIAllMasterDevices */, mask_len: mask.length, mask }, 1);
        XSync(dpy, 0);
        drain(); // what came before is not this borrow's business
        selected = on;
        sent.pointer = sent.keys = 0;
      },
      sent(kind) {
        if (selected) sent[kind]++;
      },
      drain,
      close() {
        if (open) { open = false; XCloseDisplay(dpy); }
      },
    };
  } catch {
    XCloseDisplay(dpy);
    return null;
  }
}
