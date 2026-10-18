/**
 * The clipboard when Ember quits. After Ember pastes into the user's app (tier 3) and puts their clipboard back, the
 * clipboard belongs to Ember's process, which serves it to every app that pastes; Electron never hands it to a
 * clipboard manager on its way out, so quitting Ember would empty a clipboard that came from an app still running.
 * Before quitting, Ember asks the clipboard manager (GNOME's, or any that owns CLIPBOARD_MANAGER) to take it over:
 * the freedesktop clipboard manager protocol. The manager reads every format from the clipboard's owner, Electron,
 * whose event loop goes on answering meanwhile (this waits without blocking it), and keeps them once Ember is gone.
 * Nothing is asked when there is no manager or the clipboard isn't Ember's; it never waits past its deadline.
 */

import { createRequire } from "node:module";

/**
 * "saved": the manager has it. "no-manager", "not-ours" (another app owns the clipboard, or none does): nothing to do.
 * "refused": the manager or the clipboard said no. "timeout": no answer by the deadline. "unavailable": no X display.
 */
export type HandoffResult = "saved" | "no-manager" | "not-ours" | "refused" | "timeout" | "unavailable";

/** Longest Ember waits for the manager: quitting must not hang on it. */
export const HANDOFF_MAX_MS = 2000;

const requireCjs = createRequire(__filename);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Formats about the selection itself, never saved (the manager skips them too). */
const META = new Set(["TARGETS", "MULTIPLE", "TIMESTAMP", "SAVE_TARGETS", "DELETE", "INSERT_PROPERTY", "INSERT_SELECTION"]);

/**
 * Asks the clipboard manager to keep the clipboard if Ember's process owns it. `ourWindow`: any X window of Ember's
 * (a BrowserWindow's native handle): X ids carry their client's id in their high bits, so the clipboard's owner
 * window (Chromium's own, unnamed) is told apart as Electron's by them.
 */
export async function handClipboardToManager(o: { ourWindow: number; display?: string; timeoutMs?: number }): Promise<HandoffResult> {
  const deadline = Date.now() + Math.min(o.timeoutMs ?? HANDOFF_MAX_MS, HANDOFF_MAX_MS);
  let x: ReturnType<typeof bind>;
  try {
    x = bind();
  } catch {
    return "unavailable";
  }
  const dpy = x.XOpenDisplay(o.display ?? null);
  if (!dpy) return "unavailable";
  let win = 0;
  try {
    const atom = (name: string) => Number(x.XInternAtom(dpy, name, 0));
    const CLIPBOARD = atom("CLIPBOARD"), MANAGER = atom("CLIPBOARD_MANAGER"), TARGETS = atom("TARGETS"), SAVE_TARGETS = atom("SAVE_TARGETS");
    if (!Number(x.XGetSelectionOwner(dpy, MANAGER))) return "no-manager";
    const owner = Number(x.XGetSelectionOwner(dpy, CLIPBOARD));
    // An X client's resources share the bits above the server's resource mask (Xlib keeps it in its Display: base, mask at 40, 48).
    let mask = Number(x.koffi.decode(dpy, 48, "unsigned long"));
    if (!(mask >= 0xffff && mask <= 0x1fffffff && (mask & (mask + 1)) === 0)) mask = 0x1fffff;
    if (!owner || Math.floor(owner / (mask + 1)) !== Math.floor(o.ourWindow / (mask + 1))) return "not-ours";
    win = Number(x.XCreateSimpleWindow(dpy, x.XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0));
    const ev = Buffer.alloc(192);
    /** The property of the SelectionNotify answering (`selection`, `target`) on our window (0: refused), or null by the deadline. */
    const answer = async (selection: number, target: number): Promise<number | null> => {
      for (;;) {
        while (x.XPending(dpy) > 0) {
          x.XNextEvent(dpy, ev);
          // SelectionNotify (31): requestor at 32, selection 40, target 48, property 56.
          if (ev.readInt32LE(0) === 31 && Number(ev.readBigUInt64LE(32)) === win && Number(ev.readBigUInt64LE(40)) === selection && Number(ev.readBigUInt64LE(48)) === target) {
            return Number(ev.readBigUInt64LE(56));
          }
        }
        if (Date.now() >= deadline) return null;
        await sleep(10);
      }
    };
    // The formats on offer, from the owner (Electron answers while this waits).
    const listProp = atom("EMBER_CLIPBOARD_TARGETS");
    x.XConvertSelection(dpy, CLIPBOARD, TARGETS, listProp, win, 0);
    x.XFlush(dpy);
    const listed = await answer(CLIPBOARD, TARGETS);
    if (listed === null) return "timeout";
    if (!listed) return "refused";
    const type = [0], format = [0], count = [0], after = [0], data: unknown[] = [null];
    if (x.XGetWindowProperty(dpy, win, listProp, 0, 4096, 1, 0, type, format, count, after, data) !== 0 || !data[0]) return "refused";
    let targets: number[] = [];
    try {
      if (format[0] === 32) {
        // Format-32 items are C longs (8 bytes on x86-64).
        const b = Buffer.from(x.koffi.decode(data[0], "uint8_t", Number(count[0]) * 8) as Uint8Array);
        targets = Array.from({ length: Number(count[0]) }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
      }
    } finally {
      x.XFree(data[0]);
    }
    const meta = new Set([...META].map(atom));
    const keep = targets.filter(t => t && !meta.has(t));
    if (!keep.length) return "refused";
    // The manager is asked to save those (its protocol: the list on the requestor's window, as ATOMs).
    const saveProp = atom("EMBER_SAVE_TARGETS");
    const list = Buffer.alloc(keep.length * 8);
    keep.forEach((t, i) => list.writeBigUInt64LE(BigInt(t), i * 8));
    x.XChangeProperty(dpy, win, saveProp, 4 /* ATOM */, 32, 0 /* PropModeReplace */, list, keep.length);
    x.XConvertSelection(dpy, MANAGER, SAVE_TARGETS, saveProp, win, 0);
    x.XFlush(dpy);
    const saved = await answer(MANAGER, SAVE_TARGETS);
    return saved === null ? "timeout" : saved ? "saved" : "refused";
  } finally {
    if (win) x.XDestroyWindow(dpy, win);
    x.XCloseDisplay(dpy);
  }
}

/**
 * The text selected now (the X PRIMARY selection, as UTF-8), when the app that owns it is the X client of window
 * `sameClientAs` (the window the user is in: a selection left in another app isn't theirs to ask about); "" otherwise,
 * or by the deadline. At most `max` characters.
 */
export async function readSelection(o: { sameClientAs: number; display?: string; timeoutMs?: number; max?: number }): Promise<string> {
  const deadline = Date.now() + (o.timeoutMs ?? 600);
  let x: ReturnType<typeof bind>;
  try {
    x = bind();
  } catch {
    return "";
  }
  const dpy = x.XOpenDisplay(o.display ?? null);
  if (!dpy) return "";
  let win = 0;
  try {
    const atom = (name: string) => Number(x.XInternAtom(dpy, name, 0));
    const PRIMARY = 1, UTF8 = atom("UTF8_STRING");
    const owner = Number(x.XGetSelectionOwner(dpy, PRIMARY));
    let mask = Number(x.koffi.decode(dpy, 48, "unsigned long"));
    if (!(mask >= 0xffff && mask <= 0x1fffffff && (mask & (mask + 1)) === 0)) mask = 0x1fffff;
    if (!owner || !o.sameClientAs || Math.floor(owner / (mask + 1)) !== Math.floor(o.sameClientAs / (mask + 1))) return "";
    win = Number(x.XCreateSimpleWindow(dpy, x.XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0));
    const prop = atom("EMBER_SELECTION");
    x.XConvertSelection(dpy, PRIMARY, UTF8, prop, win, 0);
    x.XFlush(dpy);
    const ev = Buffer.alloc(192);
    for (;;) {
      let got: number | null = null;
      while (x.XPending(dpy) > 0) {
        x.XNextEvent(dpy, ev);
        if (ev.readInt32LE(0) === 31 && Number(ev.readBigUInt64LE(32)) === win && Number(ev.readBigUInt64LE(40)) === PRIMARY) got = Number(ev.readBigUInt64LE(56));
      }
      if (got === 0) return "";
      if (got !== null) break;
      if (Date.now() >= deadline) return "";
      await sleep(10);
    }
    const max = o.max ?? 2000;
    const type = [0], format = [0], count = [0], after = [0], data: unknown[] = [null];
    if (x.XGetWindowProperty(dpy, win, prop, 0, Math.ceil(max / 4) * 4, 1, 0, type, format, count, after, data) !== 0 || !data[0]) return "";
    try {
      if (format[0] !== 8) return "";
      const bytes = Buffer.from(x.koffi.decode(data[0], "uint8_t", Number(count[0])) as Uint8Array);
      return bytes.toString("utf8").slice(0, max);
    } finally {
      x.XFree(data[0]);
    }
  } catch {
    return "";
  } finally {
    if (win) x.XDestroyWindow(dpy, win);
    x.XCloseDisplay(dpy);
  }
}

/** The libX11 calls used here, through koffi. */
function bind() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  return {
    koffi,
    XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: lib.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: lib.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XInternAtom: lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)"),
    XGetSelectionOwner: lib.func("unsigned long XGetSelectionOwner(void *dpy, unsigned long atom)"),
    XCreateSimpleWindow: lib.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderPixel, unsigned long background)"),
    XDestroyWindow: lib.func("int XDestroyWindow(void *dpy, unsigned long w)"),
    XConvertSelection: lib.func("int XConvertSelection(void *dpy, unsigned long selection, unsigned long target, unsigned long property, unsigned long requestor, unsigned long time)"),
    XChangeProperty: lib.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long property, unsigned long type, int format, int mode, const uint8_t *data, int n)"),
    XGetWindowProperty: lib.func("int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)"),
    XFree: lib.func("int XFree(void *data)"),
    XPending: lib.func("int XPending(void *dpy)"),
    XNextEvent: lib.func("int XNextEvent(void *dpy, _Out_ uint8_t *event)"),
    XFlush: lib.func("int XFlush(void *dpy)"),
  };
}
