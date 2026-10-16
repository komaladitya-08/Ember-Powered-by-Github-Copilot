/**
 * Ember's desk helper: a process of its own that makes every X call on the
 * desk's display (XTest input, window lists, screenshots, the key map). If
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
  const targets: Record<string, object> = { x11, input, keys, view };
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
