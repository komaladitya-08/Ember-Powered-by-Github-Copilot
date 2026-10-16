/**
 * Ember's desk helper: a process of its own that makes every X call on the
 * desk's display (XTest input, window lists, screenshots, the key map, whether
 * the window manager is ready). If
 * the desk's X server goes away, Xlib ends the process that was talking to
 * it: this one, never Ember, which then treats the desk as gone. Requests come
 * from agent.ts over the IPC channel; the display and cookie are in DISPLAY
 * and XAUTHORITY.
 */

import { createRequire } from "node:module";
import type Sharp from "sharp";
import { openX11 } from "../x11";
import { openXInput } from "../hands/input";
import { bgraToRgba } from "../perception/capture";
import { SpareKeys, findKey, spareKeycodes, type KeyMap } from "./keys";

const requireCjs = createRequire(__filename);

interface Request { id: number; t: string; m: string; a: unknown[]; async?: boolean }

const send = (m: object) => { if (process.connected) process.send!(m); };
const fail = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A window that closes between two calls (BadWindow) must not end the helper: Xlib's default error handler exits. */
function ignoreXErrors(): void {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  const handler = koffi.proto("int EmberXErrorHandler(void *dpy, void *event)");
  const XSetErrorHandler = lib.func("void *XSetErrorHandler(EmberXErrorHandler *handler)");
  XSetErrorHandler(koffi.register(() => 0, koffi.pointer(handler)));
}

/** The key map, read and changed on a connection of its own. */
function openKeyboard(display: string) {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  const XOpenDisplay = lib.func("void *XOpenDisplay(const char *name)");
  const XDisplayKeycodes = lib.func("int XDisplayKeycodes(void *dpy, _Out_ int *min, _Out_ int *max)");
  const XGetKeyboardMapping = lib.func("void *XGetKeyboardMapping(void *dpy, uint8_t first, int count, _Out_ int *per)");
  const XChangeKeyboardMapping = lib.func("int XChangeKeyboardMapping(void *dpy, int first, int per, void *syms, int count)");
  const XSync = lib.func("int XSync(void *dpy, int discard)");
  const XFree = lib.func("int XFree(void *data)");

  const dpy = XOpenDisplay(display);
  if (!dpy) return null;
  const read = (): KeyMap => {
    const min = [0], max = [0], per = [0];
    XDisplayKeycodes(dpy, min, max);
    const ptr = XGetKeyboardMapping(dpy, min[0], max[0] - min[0] + 1, per);
    if (!ptr) return { min: min[0], per: 1, syms: [] };
    try {
      const n = (max[0] - min[0] + 1) * per[0];
      const a = koffi.decode(ptr, "uint8_t", n * 8) as Uint8Array;
      const b = Buffer.from(a);
      return { min: min[0], per: per[0], syms: Array.from({ length: n }, (_, i) => Number(b.readBigUInt64LE(i * 8))) };
    } finally {
      XFree(ptr);
    }
  };
  const put = (code: number, sym: number) => {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(BigInt(sym), 0);
    b.writeBigUInt64LE(BigInt(sym), 8);
    XChangeKeyboardMapping(dpy, code, 2, b, 1);
    XSync(dpy, 0);
  };
  let spare: SpareKeys | null = null;
  return {
    /** The key that types `sym` (see findKey); a character the map doesn't have is put on a spare key (Shift then makes no difference). */
    key(sym: number): { code: number; shift: boolean | null } | null {
      const map = read();
      const found = findKey(map, sym);
      if (found) return found;
      spare ??= new SpareKeys(spareKeycodes(map));
      for (let tries = 0; tries < 4; tries++) {
        const slot = spare.take(sym);
        if (!slot) return null;
        if (!slot.remap) return { code: slot.code, shift: null };
        // Only a key that still has nothing (or one of Ember's characters) is changed.
        const now = Array.from({ length: map.per }, (_, l) => map.syms[(slot.code - map.min) * map.per + l] ?? 0).filter(Boolean);
        if (now.length && !now.every(s => s === now[0])) { spare.drop(slot.code); continue; }
        put(slot.code, sym);
        return { code: slot.code, shift: null };
      }
      return null;
    },
    /** Lent keys go back to having nothing on them. */
    restore(): void {
      for (const code of spare?.takeBack() ?? []) put(code, 0);
    },
  };
}

/** The name of openWmProbe's test windows. */
const WM_PROBE = "Ember's window manager check";

/**
 * Is the desk's window manager ready to manage windows? Until it is, an app's window mapped meanwhile can
 * stay unmanaged, and unseen: openbox 3.6 never manages a window mapped a few tens of milliseconds after it
 * started (after it took the display over, before it handles map requests). Ready: its EWMH check window
 * is up, a test window mapped since then got WM_STATE from it, and the test windows are gone from its
 * window list again. Asked again and again (each call is quick) on a connection of its own, which end() closes.
 */
function openWmProbe(display: string) {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  const XOpenDisplay = lib.func("void *XOpenDisplay(const char *name)");
  const XCloseDisplay = lib.func("int XCloseDisplay(void *dpy)");
  const XDefaultRootWindow = lib.func("unsigned long XDefaultRootWindow(void *dpy)");
  const XInternAtom = lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)");
  const XGetWindowProperty = lib.func("int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)");
  const XCreateSimpleWindow = lib.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderPixel, unsigned long background)");
  const XStoreName = lib.func("int XStoreName(void *dpy, unsigned long w, const char *name)");
  const XMapWindow = lib.func("int XMapWindow(void *dpy, unsigned long w)");
  const XDestroyWindow = lib.func("int XDestroyWindow(void *dpy, unsigned long w)");
  const XSync = lib.func("int XSync(void *dpy, int discard)");
  const XFree = lib.func("int XFree(void *data)");

  let dpy: unknown = null, root = 0;
  /** Test windows mapped (and when), and whether one of them has been managed. */
  let probes: { id: number; at: number }[] = [];
  let managed = false;
  /** A window property of 32-bit items (window ids, WM_STATE…); null if it isn't there or the window is gone. */
  const longs = (w: number, name: string): number[] | null => {
    const type = [0], format = [0], items = [0], after = [0], data: unknown[] = [null];
    if (XGetWindowProperty(dpy, w, XInternAtom(dpy, name, 0), 0, 1024, 0, 0, type, format, items, after, data) !== 0) return null;
    const ptr = data[0], n = Number(items[0]);
    if (!ptr) return null;
    try {
      if (format[0] !== 32 || n === 0) return null;
      const b = Buffer.from(koffi.decode(ptr, "uint8_t", n * 8) as Uint8Array); // C longs: 8 bytes on x86-64
      return Array.from({ length: n }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
    } finally {
      XFree(ptr);
    }
  };
  return {
    ready(): boolean {
      if (!dpy) {
        dpy = XOpenDisplay(display);
        if (!dpy) return true; // nothing to look with: not held up
        root = Number(XDefaultRootWindow(dpy));
      }
      if (!managed) {
        // EWMH: the root names a window that names itself (one that is there, not a window manager's that has gone).
        const check = longs(root, "_NET_SUPPORTING_WM_CHECK")?.[0];
        if (!check || longs(check, "_NET_SUPPORTING_WM_CHECK")?.[0] !== check) return false;
        if (!probes.some(p => longs(p.id, "WM_STATE"))) {
          // Mapped once the window manager has taken the display over (so only it can map them). A map it never
          // saw (in openbox's gap) goes unanswered: another test window then, every 100 ms.
          if (!probes.length || Date.now() - probes[probes.length - 1].at >= 100) {
            const id = Number(XCreateSimpleWindow(dpy, root, 0, 0, 1, 1, 0, 0, 0));
            XStoreName(dpy, id, WM_PROBE);
            XMapWindow(dpy, id);
            XSync(dpy, 0);
            probes.push({ id, at: Date.now() });
          }
          return false;
        }
        managed = true;
        for (const p of probes) XDestroyWindow(dpy, p.id);
        XSync(dpy, 0);
      }
      // Ready once it has let go of the test windows again (apps would otherwise see them in its window list).
      const listed = longs(root, "_NET_CLIENT_LIST") ?? [];
      return !probes.some(p => listed.includes(p.id));
    },
    /** Lets go: the connection, and with it any test window still there. */
    end(): void {
      if (dpy) XCloseDisplay(dpy);
      dpy = null;
      probes = [];
      managed = false;
    },
  };
}

function main(): void {
  const display = process.env.DISPLAY ?? "";
  ignoreXErrors();
  const x11 = openX11(display);
  const input = openXInput(display);
  const keys = openKeyboard(display);
  if (!x11 || !input || !keys) {
    const error = `couldn't open the desk display (${[!x11 && "x11", !input && "input", !keys && "keys"].filter(Boolean).join(", ")})`;
    if (process.connected) process.send!({ ready: false, error }, () => process.exit(1)); else process.exit(1);
    return;
  }
  // Loaded now, while nothing waits on this thread: loading it at the first frame (a fraction of a second,
  // more on a busy machine) would hold up the calls queued behind it.
  let sharp: typeof Sharp | null = null;
  try {
    sharp = requireCjs("sharp") as typeof Sharp;
    sharp.concurrency(1); // a small picture a few times a second: one thread is plenty
    sharp.cache(false);
  } catch { /* loaded (or reported) at the first frame */ }
  const view = {
    /** The whole desk as a JPEG `width` pixels wide, and the active window's title (for the mini-view). */
    async snapshot(width: number, quality: number) {
      const size = input.screenSize();
      const img = x11.capture(0, 0, size.width, size.height);
      if (!img) return null;
      if (!sharp) {
        sharp = requireCjs("sharp") as typeof Sharp;
        sharp.concurrency(1); // a small picture a few times a second: one thread is plenty
        sharp.cache(false);
      }
      const jpeg = await sharp(bgraToRgba(img.bgra), { raw: { width: img.width, height: img.height, channels: 4 } })
        .resize(Math.min(width, img.width)).jpeg({ quality }).toBuffer();
      return { jpeg, width: img.width, height: img.height, title: x11.activeWindow()?.title ?? "" };
    },
  };
  const targets: Record<string, object> = { x11, input, keys, view, wm: openWmProbe(display) };
  const run = (r: Request): unknown => {
    const target = targets[r.t] as Record<string, unknown> | undefined;
    const fn = target?.[r.m];
    if (typeof fn !== "function" || r.m === "close") throw new Error(`unknown desk call ${r.t}.${r.m}`);
    return (fn as (...a: unknown[]) => unknown).apply(target, r.a ?? []);
  };
  process.on("message", (r: Request) => {
    if (r.async) {
      Promise.resolve().then(() => run(r)).then(v => send({ id: r.id, async: true, v }), err => send({ id: r.id, async: true, e: fail(err) }));
      return;
    }
    try { send({ id: r.id, v: run(r) }); } catch (err) { send({ id: r.id, e: fail(err) }); }
  });
  // Ember went away (or stopped the desk): so does the helper.
  process.on("disconnect", () => process.exit(0));
  const methods = (o: object) => Object.keys(o).filter(k => typeof (o as Record<string, unknown>)[k] === "function");
  send({ ready: true, calls: Object.fromEntries(Object.entries(targets).map(([k, o]) => [k, methods(o)])) });
}

main();
