/**
 * Keys typed between Ctrl+Alt+Space and the ask box having the keyboard. The window manager may take a moment to give
 * the box focus, and every letter typed meanwhile went to the app the user was in. While the box opens, Ember holds
 * the keyboard itself (an X keyboard grab on its own connection), keeps what is typed, and gives it to the box once it
 * has the keyboard. The grab never outlives HOLD_MAX_MS, whatever happens.
 *
 * The grab is taken on this connection before holdKeyboard() returns (a short spin: the hotkey's own grab holds the
 * keyboard until Space is released), and tried again for the whole hold if another grab still has it. XTEST/xdotool
 * keys are real device events: once the grab is up they come here, not to Mousepad. GrabModeAsync, so giving the
 * keyboard back does not replay what was held into the focused app.
 */

import { createRequire } from "node:module";

/** Longest Ember holds the keyboard. */
export const HOLD_MAX_MS = 1500;
/** How long holdKeyboard() itself waits for the hotkey grab to drop, so the first letter is not already in the app. */
export const GRAB_SPIN_MS = 50;

const requireCjs = createRequire(__filename);

/** What was typed while Ember held the keyboard: the text, and whether it ended with Enter (send) or Esc (close). */
export interface Typed { text: string; submit: boolean; cancel: boolean }

/** X key events as the buffer needs them: the keysym, the text it types (Latin-1 or Unicode keysyms), the modifiers. */
export interface KeyPress { keysym: number; text: string; state: number }

const CONTROL = 4, MOD1 = 8, MOD4 = 64;
const BACKSPACE = 0xff08, RETURN = 0xff0d, KP_ENTER = 0xff8d, ESCAPE = 0xff1b, SPACE = 0x20;

/** Whether `text` is something a person meant to type (a printable character, not a control code). */
const printable = (text: string): string =>
  text && [...text].every(c => { const n = c.codePointAt(0) ?? 0; return n >= 32 && n !== 127; }) ? text : "";

/**
 * One key into what was typed. A letter typed before the hotkey's Ctrl/Alt are let go still counts: that is the
 * user's first letter, and dropping it (or leaving it in the app) is what the grab is here to prevent. Space is the
 * hotkey itself, and Super combinations are shortcuts, so those type nothing.
 */
export function typedKey(t: Typed, k: KeyPress): Typed {
  if (t.submit || t.cancel) return t;
  if (k.keysym === ESCAPE) return { ...t, cancel: true };
  if (k.keysym === RETURN || k.keysym === KP_ENTER) return { ...t, submit: t.text.trim().length > 0 };
  if (k.state & MOD4) return t;
  if (k.keysym === BACKSPACE) return { ...t, text: [...t.text].slice(0, -1).join("") };
  const text = printable(k.text);
  if ((k.state & (CONTROL | MOD1)) && (k.keysym === SPACE || !text)) return t;
  return text ? { ...t, text: t.text + text } : t;
}

/** The text a keysym types: Latin-1 keysyms are their own code, Unicode ones are 0x1000000 + the code point. */
export function keysymText(keysym: number): string {
  if (keysym >= 0x20 && keysym <= 0x7e) return String.fromCharCode(keysym);
  if (keysym >= 0xa0 && keysym <= 0xff) return String.fromCharCode(keysym);
  if (keysym >= 0x1000100 && keysym <= 0x110ffff) return String.fromCodePoint(keysym - 0x1000000);
  return "";
}

export interface KeyBuffer {
  /** Gives the keyboard back and returns what was typed meanwhile. */
  stop(): Typed;
  /** Whether Ember holds the keyboard now (false: letters still go to the focused app). */
  holding(): boolean;
}

/** Starts holding the keyboard (null where there is no X display or libX11). */
export function holdKeyboard(o: { display?: string; maxMs?: number } = {}): KeyBuffer | null {
  let x: ReturnType<typeof bind>;
  try {
    x = bind();
  } catch {
    return null;
  }
  const dpy = x.XOpenDisplay(o.display ?? null);
  if (!dpy) return null;
  const root = x.XDefaultRootWindow(dpy);
  let typed: Typed = { text: "", submit: false, cancel: false };
  let grabbed = false;
  let done = false;
  const t0 = Date.now();
  const ev = Buffer.alloc(192);
  const keysym = [0];
  const chars = Buffer.alloc(16);
  /** GrabModeAsync for pointer and keyboard; CurrentTime. 0: GrabSuccess. Never Sync: ungrab would replay into the app. */
  const tryGrab = () => x.XGrabKeyboard(dpy, root, 0, 1, 1, 0) === 0;
  while (!grabbed && Date.now() - t0 < GRAB_SPIN_MS) {
    if (tryGrab()) grabbed = true;
    else x.XFlush(dpy);
  }
  if (grabbed) drain();
  const poll = setInterval(() => {
    if (done) return;
    try {
      if (!grabbed && tryGrab()) grabbed = true;
      if (grabbed) drain();
    } catch {
      finish();
    }
  }, 1);
  /** The key presses that came, into what was typed. */
  function drain(): void {
    while (x.XPending(dpy) > 0) {
      x.XNextEvent(dpy, ev);
      // KeyPress (2); XKeyEvent: state at 80.
      if (ev.readInt32LE(0) !== 2) continue;
      const n = x.XLookupString(ev, chars, chars.length, keysym, null);
      const ks = Number(keysym[0]);
      const text = keysymText(ks) || (n > 0 ? chars.subarray(0, n).toString("latin1") : "");
      typed = typedKey(typed, { keysym: ks, text, state: ev.readUInt32LE(80) });
    }
  }
  const safety = setTimeout(() => finish(), o.maxMs ?? HOLD_MAX_MS);
  safety.unref?.();
  function finish(): void {
    if (done) return;
    done = true;
    clearInterval(poll);
    clearTimeout(safety);
    try {
      if (grabbed) {
        drain();
        x.XUngrabKeyboard(dpy, 0);
        grabbed = false;
      }
      x.XFlush(dpy);
    } finally {
      x.XCloseDisplay(dpy);
    }
  }
  return {
    holding: () => grabbed && !done,
    stop() {
      if (!done) {
        // What came just before the box took the keyboard. Drain, then ungrab: never leave a grab that would
        // delay the user's next Backspace in the app they go back to.
        try { if (grabbed) drain(); } catch { /* given back below */ }
        finish();
      }
      return typed;
    },
  };
}

function bind() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  return {
    XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: lib.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: lib.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XGrabKeyboard: lib.func("int XGrabKeyboard(void *dpy, unsigned long w, int ownerEvents, int pointerMode, int keyboardMode, unsigned long time)"),
    XUngrabKeyboard: lib.func("int XUngrabKeyboard(void *dpy, unsigned long time)"),
    XPending: lib.func("int XPending(void *dpy)"),
    XNextEvent: lib.func("int XNextEvent(void *dpy, _Out_ uint8_t *event)"),
    XLookupString: lib.func("int XLookupString(uint8_t *event, _Out_ uint8_t *buffer, int bytes, _Out_ unsigned long *keysym, void *status)"),
    XFlush: lib.func("int XFlush(void *dpy)"),
  };
}
