/**
 * Tier 3: Ember borrows the cursor for a moment, only after the user said yes.
 * It waits until the user is idle, remembers the pointer and the active
 * window, glides the pointer visibly (Ember rides along), acts, then puts the
 * pointer and focus back. If the user moves the mouse or presses a key at any
 * point, Ember lets go at once (checked every few milliseconds) and does not
 * move the pointer again.
 */

import type { XInput } from "./input";

export class UserTookOver extends Error {
  constructor(readonly afterMs: number) {
    super("The user moved the mouse or pressed a key, so Ember let go.");
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
};
const STEP_MS = 8;
const TOLERANCE = 2;

export function parseCombo(combo: string): { modifiers: string[]; key: string } {
  const parts = combo.split("+").map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty key combination");
  const key = parts.pop()!;
  const modifiers = parts.map(m => {
    const name = MODIFIERS[m.toLowerCase()];
    if (!name) throw new Error(`unknown modifier "${m}"`);
    return name;
  });
  return { modifiers, key: KEY_ALIASES[key.toLowerCase()] ?? (key.length === 1 ? key.toLowerCase() : key) };
}

export class CursorBorrow {
  private busy = false;

  constructor(private x: XInput) {}

  get active(): boolean {
    return this.busy;
  }

  async borrow<T>(fn: (hand: Hand) => Promise<T>, o: BorrowOptions = {}): Promise<T> {
    if (this.busy) throw new Error("Ember is already using the cursor");
    this.busy = true;
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const x = this.x;
    const t0 = now();
    const held = new Map<number, number>(); // keycode → keysym Ember holds down
    let expected = x.pointer();
    let tookOver = false;

    const check = () => {
      const p = x.pointer();
      const foreign = x.keysDown().filter(k => !held.has(k));
      if ((p && expected && (Math.abs(p.x - expected.x) > TOLERANCE || Math.abs(p.y - expected.y) > TOLERANCE)) || foreign.length) {
        tookOver = true;
        throw new UserTookOver(now() - t0);
      }
    };
    const press = (sym: number, down: boolean) => {
      const code = x.keycodeOf(sym);
      if (!code || !x.keysym(sym, down)) throw new Error("this keyboard layout has no key for that");
      if (down) held.set(code, sym); else held.delete(code);
    };

    // Wait for the user to be still.
    const idleMs = o.idleMs ?? 1500;
    let last = x.pointer(), stillSince = now();
    for (;;) {
      const p = x.pointer();
      if (!p || !last || p.x !== last.x || p.y !== last.y || x.keysDown().length) stillSince = now();
      last = p;
      if (now() - stillSince >= idleMs) break;
      if (now() - t0 > (o.idleTimeoutMs ?? 15_000)) { this.busy = false; throw new Error("The user kept using the mouse, so Ember didn't borrow it."); }
      await sleep(50);
    }

    const home = x.pointer();
    const previousWindow = x.activeWindow();
    expected = home;
    o.onStart?.();
    const hand: Hand = {
      glideTo: async (tx, ty) => {
        check();
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
        x.button(button, true);
        await sleep(40);
        x.button(button, false);
        await sleep(60);
        check();
      },
      keys: async combo => {
        check();
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
      if (o.window && o.window !== previousWindow) {
        x.activate(o.window);
        await sleep(150);
        check();
      }
      return await fn(hand);
    } finally {
      // Never leave a key stuck down, whatever happened.
      for (const sym of held.values()) x.keysym(sym, false);
      held.clear();
      if (!tookOver) {
        // Hand everything back the way it was.
        if (home) {
          try { await hand.glideTo(home.x, home.y); } catch { /* the user took over on the way back */ }
        }
        if (previousWindow && o.window && previousWindow !== o.window && !tookOver) x.activate(previousWindow);
      }
      this.busy = false;
    }
  }
}
