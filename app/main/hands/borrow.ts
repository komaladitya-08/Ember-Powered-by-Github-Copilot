/**
 * Tier 3: Ember borrows the cursor for a moment, only after the user said yes.
 * It waits until the user is idle, remembers the pointer and the active
 * window, glides the pointer visibly (Ember rides along), acts, then puts the
 * pointer and focus back. If the user moves the mouse, presses a mouse button
 * or a key at any point, Ember lets go at once (checked every few milliseconds)
 * and does not move the pointer again. Two borrows never overlap: the second
 * waits its turn, and Stop cancels every borrow asked for before it.
 */

import type { XInput } from "./input";

export class UserTookOver extends Error {
  constructor(readonly afterMs: number) {
    super("The user moved the mouse or pressed a key, so Ember let go.");
  }
}

/** The kill switch (or Stop) ended the borrow: no more input, the pointer jumps home. */
export class BorrowStopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

export interface BorrowOptions {
  /** How long the user must be still before Ember starts (ms). */
  idleMs?: number;
  /** Give up waiting for the user to be still after this long (ms). */
  idleTimeoutMs?: number;
  /** The window to act in; activated first and the previous one restored after. */
  window?: number;
  /** Called once the user is still and Ember actually takes the cursor. */
  onStart?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Hand {
  glideTo(x: number, y: number): Promise<void>;
  click(button?: number): Promise<void>;
  /** A key combination like "ctrl+s", "Return", "alt+F4". */
  keys(combo: string): Promise<void>;
  /** Types printable ASCII text with the keyboard. */
  type(text: string): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", steps: number): Promise<void>;
}

const MODIFIERS: Record<string, string> = { ctrl: "Control_L", control: "Control_L", shift: "Shift_L", alt: "Alt_L", super: "Super_L", meta: "Super_L" };
const KEY_ALIASES: Record<string, string> = {
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "space", backspace: "BackSpace",
  delete: "Delete", del: "Delete", home: "Home", end: "End", pageup: "Prior", pagedown: "Next", up: "Up", down: "Down", left: "Left", right: "Right",
  insert: "Insert", ins: "Insert", menu: "Menu", pause: "Pause", print: "Print", kp_enter: "KP_Enter",
  minus: "minus", plus: "plus", equal: "equal", comma: "comma", period: "period", dot: "period", slash: "slash", backslash: "backslash",
  semicolon: "semicolon", apostrophe: "apostrophe", grave: "grave", bracketleft: "bracketleft", bracketright: "bracketright",
};
/** Punctuation keys by the character they type. */
const PUNCT: Record<string, string> = {
  "-": "minus", "+": "plus", "=": "equal", ",": "comma", ".": "period", "/": "slash", "\\": "backslash", ";": "semicolon",
  "'": "apostrophe", "`": "grave", "[": "bracketleft", "]": "bracketright",
};
/** Any mouse button held (Button1Mask … Button5Mask). */
const BUTTONS_MASK = 0x1f00;
const STEP_MS = 8;
const TOLERANCE = 2;

export function parseCombo(combo: string): { modifiers: string[]; key: string } {
  // "ctrl++" is Ctrl and the plus key.
  const parts = combo.replace(/\+\+$/, "+plus").split("+").map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty key combination");
  const key = parts.pop()!;
  const modifiers = parts.map(m => {
    const name = MODIFIERS[m.toLowerCase()];
    if (!name) throw new Error(`unknown modifier "${m}"`);
    return name;
  });
  const named = KEY_ALIASES[key.toLowerCase()] ?? PUNCT[key] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : undefined);
  return { modifiers, key: named ?? (key.length === 1 ? key.toLowerCase() : key) };
}

/** Can Ember type this with the keyboard (printable ASCII, line breaks and tabs)? */
export const typeableText = (text: string) => /^[\x20-\x7e\n\t]*$/.test(text);

export class CursorBorrow {
  private busy = false;
  private stopping = false;
  /** Bumped by every stop(): a borrow asked for before it never starts. */
  private epoch = 0;
  /** The borrow in progress (or queued last): the next one waits for it. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private x: XInput) {}

  get active(): boolean {
    return this.busy;
  }

  /** Kill switch: the current borrow sends no more input and the pointer goes straight back; queued ones never start. */
  stop(): void {
    this.epoch++;
    if (this.busy) this.stopping = true;
  }

  borrow<T>(fn: (hand: Hand) => Promise<T>, o: BorrowOptions = {}): Promise<T> {
    const epoch = this.epoch;
    const run = this.turn.catch(() => undefined).then(() => {
      if (epoch !== this.epoch) throw new BorrowStopped();
      return this.borrowNow(fn, o);
    });
    this.turn = run;
    return run;
  }

  private async borrowNow<T>(fn: (hand: Hand) => Promise<T>, o: BorrowOptions): Promise<T> {
    this.busy = true;
    this.stopping = false;
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const x = this.x;
    const t0 = now();
    const held = new Map<number, number>(); // keycode → keysym Ember holds down
    let ownButtons = 0; // mouse buttons Ember holds down (as a mask)
    let expected = x.pointer();
    let tookOver: "pointer" | "keys" | null = null;
    const foreignButtons = () => ((x.pointerState()?.mask ?? 0) & BUTTONS_MASK & ~ownButtons) !== 0;

    const check = () => {
      if (this.stopping) throw new BorrowStopped();
      const p = x.pointer();
      const moved = !!p && !!expected && (Math.abs(p.x - expected.x) > TOLERANCE || Math.abs(p.y - expected.y) > TOLERANCE);
      const foreign = x.keysDown().filter(k => !held.has(k));
      if (moved || foreignButtons() || foreign.length) {
        tookOver = moved || foreignButtons() ? "pointer" : "keys";
        throw new UserTookOver(now() - t0);
      }
    };
    // Keys go only to the window the user approved: if another window has the keyboard (a dialog popped up,
    // focus moved), Ember stops instead of typing into it.
    const keyboardOnTarget = () => {
      if (o.window && x.focusedWindow() !== o.window) throw new Error("another window has the keyboard, so Ember stopped typing");
    };
    const press = (sym: number, down: boolean) => {
      const code = x.keycodeOf(sym);
      if (!code || !x.keysym(sym, down)) throw new Error("this keyboard layout has no key for that");
      if (down) held.set(code, sym); else held.delete(code);
    };

    // Wait for the user to be still: no movement, no button held, no key down.
    const idleMs = o.idleMs ?? 1500;
    let last = x.pointer(), stillSince = now();
    try {
      for (;;) {
        const p = x.pointer();
        if (!p || !last || p.x !== last.x || p.y !== last.y || x.keysDown().length || foreignButtons()) stillSince = now();
        last = p;
        if (this.stopping) throw new BorrowStopped();
        if (now() - stillSince >= idleMs) break;
        if (now() - t0 > (o.idleTimeoutMs ?? 15_000)) throw new Error("You kept using the mouse or keyboard, so Ember didn't borrow it.");
        await sleep(50);
      }
    } catch (err) {
      this.busy = false;
      this.stopping = false;
      throw err;
    }

    let home: { x: number; y: number } | null = null;
    let previousWindow = 0;
    const hand: Hand = {
      glideTo: async (tx, ty) => {
        check();
        const screen = x.screenSize();
        if (tx < 0 || ty < 0 || tx >= screen.width || ty >= screen.height) {
          throw new Error("That spot is off the screen; scroll it into view or move the window first.");
        }
        const from = x.pointer() ?? { x: tx, y: ty };
        const dist = Math.hypot(tx - from.x, ty - from.y);
        const steps = Math.max(1, Math.round(Math.min(600, 180 + dist * 0.5) / STEP_MS));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
          const px = Math.round(from.x + (tx - from.x) * e), py = Math.round(from.y + (ty - from.y) * e);
          x.move(px, py);
          expected = { x: px, y: py };
          await sleep(STEP_MS);
          check();
        }
      },
      click: async (button = 1) => {
        check();
        const bit = button >= 1 && button <= 5 ? 0x80 << button : 0;
        ownButtons |= bit;
        x.button(button, true);
        try {
          await sleep(40);
        } finally {
          x.button(button, false);
          ownButtons &= ~bit;
        }
        await sleep(60);
        check();
      },
      keys: async combo => {
        check();
        keyboardOnTarget();
        const { modifiers, key } = parseCombo(combo);
        const sym = x.keysymOf(key);
        if (!sym) throw new Error(`unknown key "${key}"`);
        const mods = modifiers.map(m => x.keysymOf(m));
        for (const m of mods) press(m, true);
        try {
          press(sym, true);
          await sleep(30);
          press(sym, false);
        } finally {
          for (const m of mods.reverse()) press(m, false);
        }
        await sleep(40);
        check();
      },
      type: async text => {
        const shift = x.keysymOf("Shift_L");
        keyboardOnTarget();
        for (const ch of text) {
          check();
          const code = ch.charCodeAt(0);
          const sym = ch === "\n" ? x.keysymOf("Return") : ch === "\t" ? x.keysymOf("Tab") : code >= 0x20 && code <= 0x7e ? code : 0;
          if (!sym) throw new Error("Ember can only type plain ASCII text with the keyboard");
          const needsShift = x.needsShift(sym);
          if (needsShift) press(shift, true);
          press(sym, true);
          press(sym, false);
          if (needsShift) press(shift, false);
          await sleep(12);
        }
        check();
      },
      scroll: async (direction, steps) => {
        const button = { up: 4, down: 5, left: 6, right: 7 }[direction];
        for (let i = 0; i < Math.min(Math.max(1, steps), 30); i++) {
          check();
          x.button(button, true);
          x.button(button, false);
          await sleep(30);
        }
        check();
      },
    };

    try {
      home = x.pointer();
      previousWindow = x.activeWindow();
      expected = home;
      o.onStart?.();
      if (o.window) {
        if (o.window !== previousWindow) x.activate(o.window);
        // The window must really come to the front (a window manager may refuse): otherwise nothing is touched.
        let focused = x.focusedWindow() === o.window;
        for (let i = 0; i < 10 && !focused; i++) { await sleep(100); focused = x.focusedWindow() === o.window; }
        if (!focused) throw new Error("the window didn't come to the front, so Ember didn't touch it");
        check();
      }
      return await fn(hand);
    } finally {
      // Never leave a key or button stuck down, whatever happened.
      // By keycode: the exact key that went down comes up (a keysym could map to another key by now).
      for (const code of held.keys()) x.keycode(code, false);
      held.clear();
      const restoreFocus = () => { if (previousWindow && o.window && previousWindow !== o.window) x.activate(previousWindow); };
      if (this.stopping || tookOver === "keys") {
        // Stopped (or the user reached for the keyboard, e.g. Ctrl+Alt+X): no gliding, pointer and focus simply go back.
        if (home) x.move(home.x, home.y);
        restoreFocus();
      } else if (!tookOver) {
        // Hand everything back the way it was.
        if (home) {
          try { await hand.glideTo(home.x, home.y); } catch { /* stopped or taken over on the way back */ }
          if (this.stopping) x.move(home.x, home.y);
        }
        if (!tookOver) restoreFocus();
      }
      this.busy = false;
      this.stopping = false;
    }
  }
}
