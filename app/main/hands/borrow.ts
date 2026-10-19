/**
 * Tier 3: Ember borrows the cursor for a moment, only after the user said yes.
 * It waits until the user is idle, remembers the pointer and the active
 * window, glides the pointer visibly (Ember rides along), acts, then puts the
 * pointer and focus back. If the user moves the mouse, presses a mouse button,
 * turns the wheel or presses a key at any point, Ember lets go at once (their
 * devices' events are watched, and the pointer and keys checked every few
 * milliseconds) and does not move the pointer again. Keys are only sent while
 * the approved window has the keyboard and nothing else grabbed it, clicks only
 * when that window (or its own menu) is what's under the pointer, and text only
 * when the keyboard layout in use types it exactly. Two borrows never overlap:
 * the second waits its turn, and Stop cancels every borrow asked for before it.
 */

import type { XInput } from "./input";
import { keysymForChar, planTyping, shortcutStroke, type TypedKey } from "./keymap";

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
  /**
   * The window the element to click or scroll belongs to, when it is another window of the app over `window`
   * (its dialog, a palette). Clicks land only on `window`, the menus and dropdown lists its app opens, or this.
   */
  elementWindow?: number;
  /** Called once the user is still and Ember actually takes the cursor. */
  onStart?: () => void;
  /** Only the keyboard is used (keys pressed, a spreadsheet's cells typed into): the status says so (see usesMouse). */
  keysOnly?: boolean;
  /** This borrow only: stops it while it waits its turn or runs (the kill switch uses stop() for all). */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Hand {
  glideTo(x: number, y: number): Promise<void>;
  click(button?: number): Promise<void>;
  /** A key combination like "ctrl+s", "Return", "alt+F4". */
  keys(combo: string): Promise<void>;
  /** Types printable ASCII text with the keyboard (all of it, or nothing when the layout can't type some of it). */
  type(text: string): Promise<void>;
  /** Throws, typing nothing, when `text` can't be typed exactly with the keyboard layout in use. */
  checkTyping(text: string): void;
  scroll(direction: "up" | "down" | "left" | "right", steps: number): Promise<void>;
}

const MODIFIERS: Record<string, string> = {
  ctrl: "Control_L", control: "Control_L", shift: "Shift_L", alt: "Alt_L", super: "Super_L", meta: "Super_L",
  control_l: "Control_L", control_r: "Control_R", shift_l: "Shift_L", shift_r: "Shift_R", alt_l: "Alt_L", alt_r: "Alt_R",
  super_l: "Super_L", super_r: "Super_R",
};
const KEY_ALIASES: Record<string, string> = {
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "space", backspace: "BackSpace",
  delete: "Delete", del: "Delete", home: "Home", end: "End", pageup: "Prior", pagedown: "Next", page_up: "Prior", page_down: "Next",
  prior: "Prior", next: "Next", up: "Up", down: "Down", left: "Left", right: "Right",
  insert: "Insert", ins: "Insert", menu: "Menu", pause: "Pause", print: "Print", kp_enter: "KP_Enter",
  minus: "minus", plus: "plus", equal: "equal", comma: "comma", period: "period", dot: "period", slash: "slash", backslash: "backslash",
  semicolon: "semicolon", apostrophe: "apostrophe", grave: "grave", bracketleft: "bracketleft", bracketright: "bracketright",
};
/** X keysym names of the printable ASCII characters that aren't letters or digits. */
const CHAR_NAMES: Record<string, string> = {
  " ": "space", "!": "exclam", "\"": "quotedbl", "#": "numbersign", "$": "dollar", "%": "percent", "&": "ampersand", "'": "apostrophe",
  "(": "parenleft", ")": "parenright", "*": "asterisk", "+": "plus", ",": "comma", "-": "minus", ".": "period", "/": "slash",
  ":": "colon", ";": "semicolon", "<": "less", "=": "equal", ">": "greater", "?": "question", "@": "at", "[": "bracketleft",
  "\\": "backslash", "]": "bracketright", "^": "asciicircum", "_": "underscore", "`": "grave", "{": "braceleft", "|": "bar",
  "}": "braceright", "~": "asciitilde",
};
/** Modifier keys by keysym name (any case), as the modifier they are. */
const MODIFIER_KEYS: Record<string, string> = {
  control_l: "ctrl", control_r: "ctrl", shift_l: "shift", shift_r: "shift", alt_l: "alt", alt_r: "alt",
  super_l: "super", super_r: "super", meta_l: "super", meta_r: "super",
};
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "super"];
/** Any mouse button held (Button1Mask … Button5Mask). */
const BUTTONS_MASK = 0x1f00;
const STEP_MS = 8;
const TOLERANCE = 2;

/**
 * Modifiers (as keysym names) and the key's X keysym name: "ctrl+s" → Control_L and "s",
 * "ctrl+!" → Control_L and "exclam", "super" → "Super_L".
 */
export function parseCombo(combo: string): { modifiers: string[]; key: string } {
  // "ctrl++" (and "+") is the plus key.
  const parts = combo.trim() === "+" ? ["plus"] : combo.replace(/\+\+$/, "+plus").split("+").map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty key combination");
  const key = parts.pop()!;
  const modifiers = parts.map(m => {
    const name = MODIFIERS[m.toLowerCase()];
    if (!name) throw new Error(`unknown modifier "${m}"`);
    return name;
  });
  const lower = key.toLowerCase();
  const named = KEY_ALIASES[lower] ?? MODIFIERS[lower] ?? CHAR_NAMES[key] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : undefined);
  return { modifiers, key: named ?? (key.length === 1 ? lower : key) };
}

/**
 * One spelling for a key combination, to compare combinations by: modifiers in a fixed order
 * (ctrl, alt, shift, super), then the key's keysym name in lower case. "alt+ctrl+T" → "ctrl+alt+t",
 * "Super_L" → "super", "ctrl++" → "ctrl+plus", "Ctrl+Alt+Del" → "ctrl+alt+delete". Throws like parseCombo.
 */
export function canonicalCombo(combo: string): string {
  const { modifiers, key } = parseCombo(combo);
  const mods = new Set(modifiers.map(m => MODIFIER_KEYS[m.toLowerCase()]));
  const asModifier = MODIFIER_KEYS[key.toLowerCase()];
  if (asModifier) mods.add(asModifier);
  const parts = MODIFIER_ORDER.filter(m => mods.has(m));
  if (!asModifier) parts.push(key.toLowerCase());
  return parts.join("+");
}

/** Can Ember type this with the keyboard (printable ASCII, line breaks and tabs)? */
export const typeableText = (text: string) => /^[\x20-\x7e\n\t]*$/.test(text);

const GRABBED = (then: string) => `Another program has taken the keyboard (a lock screen, a password prompt or the overview), so Ember ${then}.`;
const COVERED = "Something else is on top of the app where Ember was going to click (a dialog, a popup, a notification or another window), so it didn't click.";

export interface CursorBorrowOptions {
  /** Called whenever `pending` or `driving` changes (for the status shown to the user). */
  onChange?: () => void;
  /**
   * May the window that was active before the borrow be activated again after it? Not one that is hidden by now
   * (Ember's ask box hides when it loses the keyboard): activating it would show it again, as if it opened by itself.
   */
  mayRefocus?: (window: number) => boolean;
}

export class CursorBorrow {
  private busy = false;
  private stopping = false;
  /** Bumped by every stop(): a borrow asked for before it never starts. */
  private epoch = 0;
  /** The borrow in progress (or queued last): the next one waits for it. */
  private turn: Promise<unknown> = Promise.resolve();
  /** True only while Ember really drives the pointer and keys (not while it waits for the user to be still). */
  private drivingNow = false;
  /** Borrows asked for and not finished yet (waiting their turn, waiting for the user, or driving). */
  private open = 0;
  /** Of those, the ones that use the mouse (not keysOnly). */
  private openMouse = 0;
  /** The borrow running now (waiting for the user to be still, or driving) uses the mouse. */
  private runningMouse = false;

  constructor(private x: XInput, private options: CursorBorrowOptions = {}) {}

  private changed(): void {
    try { this.options.onChange?.(); } catch { /* a status display never stops a borrow */ }
  }

  private setDriving(on: boolean): void {
    if (this.drivingNow === on) return;
    this.drivingNow = on;
    this.changed();
  }

  get active(): boolean {
    return this.busy;
  }

  /** Ember is moving the pointer or typing right now: clicks that reach Ember's own windows are its own. */
  get driving(): boolean {
    return this.drivingNow;
  }

  /** How many borrows are asked for and not finished (for the "waiting for you to let go" status). */
  get pending(): number {
    return this.open;
  }

  /**
   * Does Ember use the mouse (not only the keyboard): the borrow it drives with now, else, while it waits, any borrow
   * asked for and not finished. The status says "your mouse" or "your keyboard" by it.
   */
  get usesMouse(): boolean {
    return this.drivingNow ? this.runningMouse : this.openMouse > 0;
  }

  /** Kill switch: the current borrow sends no more input and the pointer goes straight back; queued ones never start. */
  stop(): void {
    this.epoch++;
    if (this.busy) this.stopping = true;
  }

  borrow<T>(fn: (hand: Hand) => Promise<T>, o: BorrowOptions = {}): Promise<T> {
    const epoch = this.epoch;
    const mouse = !o.keysOnly;
    this.open++;
    if (mouse) this.openMouse++;
    this.changed();
    const run = this.turn.catch(() => undefined).then(() => {
      if (epoch !== this.epoch || o.signal?.aborted) throw new BorrowStopped();
      this.runningMouse = mouse;
      return this.borrowNow(fn, o);
    }).finally(() => { this.open--; if (mouse) this.openMouse--; this.changed(); });
    this.turn = run;
    return run;
  }

  private async borrowNow<T>(fn: (hand: Hand) => Promise<T>, o: BorrowOptions): Promise<T> {
    this.busy = true;
    this.stopping = false;
    // Its own task stopping stops this borrow (and no other).
    const onAbort = () => { this.stopping = true; };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const x = this.x;
    const t0 = now();
    const held = new Map<number, number>(); // keycode → keysym Ember holds down
    let ownButtons = 0; // mouse buttons Ember holds down (as a mask)
    let expected: { x: number; y: number } | null = null;
    let tookOver: "pointer" | "keys" | null = null;
    const foreignButtons = () => ((x.pointerState()?.mask ?? 0) & BUTTONS_MASK & ~ownButtons) !== 0;
    // The user's own devices, as events (XInput2): a click, a key tap or a wheel notch between two checks counts too.
    const quiet = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
    let watching = false;
    const unwatch = () => { if (watching) { watching = false; quiet(() => x.watchUser?.(false), false); } };

    const check = () => {
      if (this.stopping) throw new BorrowStopped();
      const used = x.userInput?.() ?? null;
      const p = x.pointer();
      const moved = !!p && !!expected && (Math.abs(p.x - expected.x) > TOLERANCE || Math.abs(p.y - expected.y) > TOLERANCE);
      const foreign = x.keysDown().filter(k => !held.has(k));
      if (used || moved || foreignButtons() || foreign.length) {
        tookOver = used === "pointer" || moved || foreignButtons() ? "pointer" : "keys";
        throw new UserTookOver(now() - t0);
      }
    };
    // Keys go only to the window the user approved: if another window has the keyboard (a dialog popped up,
    // focus moved), Ember stops instead of typing into it.
    const keyboardOnTarget = () => {
      if (o.window && x.focusedWindow() !== o.window) throw new Error("another window has the keyboard, so Ember stopped typing");
    };
    // A lock screen, a password prompt or the overview grabs the keyboard without moving the focus: keys and
    // clicks would go to it. (The app's own open menu grabs it too; that's fine.)
    const keyboardFree = () => {
      if (x.keyboardGrabbed?.(o.window)) throw new Error(GRABBED("stopped"));
    };
    // A click goes to whatever is on top at that spot: it must be the approved window or the app's own open menu
    // (not its dialog over that spot, unless the element is in it).
    const pointerOnTarget = () => {
      if (o.window && x.pointerOn && !x.pointerOn(o.window, o.elementWindow)) throw new Error(COVERED);
    };
    const press = (sym: number, down: boolean) => {
      const code = x.keycodeOf(sym);
      if (!code || !x.keysym(sym, down)) throw new Error("this keyboard layout has no key for that");
      if (down) held.set(code, sym); else held.delete(code);
    };
    const pressCode = (code: number, sym: number, down: boolean) => {
      x.keycode(code, down);
      if (down) held.set(code, sym); else held.delete(code);
    };
    const SHIFT_L = 0xffe1;
    /** The keys for `text` on the layout in use, or an error before anything is typed. */
    const planText = (text: string): { strokes: TypedKey[]; shift: number; byCode: boolean } => {
      if (!typeableText(text)) throw new Error("Ember can only type plain ASCII text with the keyboard");
      const layout = x.layout?.() ?? null;
      if (layout) return { strokes: planTyping(text, layout), shift: layout.shift, byCode: true };
      // No XKB: whichever key the core keymap has for each character.
      const strokes = [...text].map(ch => {
        const sym = keysymForChar(ch), code = x.keycodeOf(sym);
        if (!code) throw new Error(`The keyboard layout in use can't type “${ch}”, so Ember typed nothing.`);
        return { code, sym, shift: x.needsShift(sym) };
      });
      return { strokes, shift: x.keycodeOf(SHIFT_L), byCode: false };
    };

    // Wait for the user to be still: no movement, no wheel, no button held, no key down.
    const idleMs = o.idleMs ?? 1500;
    let stillSince = now();
    try {
      watching = x.watchUser?.(true) ?? false;
      let last = x.pointer();
      for (;;) {
        const p = x.pointer();
        const used = x.userInput?.() ?? null;
        if (used || !p || !last || p.x !== last.x || p.y !== last.y || x.keysDown().length || foreignButtons()) stillSince = now();
        last = p;
        if (this.stopping) throw new BorrowStopped();
        if (now() - stillSince >= idleMs) break;
        if (now() - t0 > (o.idleTimeoutMs ?? 15_000)) throw new Error("You kept using the mouse or keyboard, so Ember didn't borrow it.");
        await sleep(50);
      }
      // Nothing is touched on a locked or blank screen, or while something else holds the keyboard.
      if (x.screenLocked?.()) throw new Error("The screen is locked or blank, so Ember didn't borrow the mouse.");
      if (x.keyboardGrabbed?.(o.window)) throw new Error(GRABBED("didn't borrow the mouse"));
    } catch (err) {
      unwatch();
      this.busy = false;
      this.stopping = false;
      o.signal?.removeEventListener("abort", onAbort);
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
        keyboardFree();
        pointerOnTarget();
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
        keyboardFree();
        const { modifiers, key } = parseCombo(combo);
        const sym = x.keysymOf(key);
        if (!sym) throw new Error(`unknown key "${key}"`);
        // The key in the active layout when it has one (with Shift if it's on the shifted level there, like
        // "plus" on a US keyboard); else in another layout of the keyboard (Ctrl+C still works with a Russian
        // layout active). Never a key that gives it only with AltGr: without AltGr it is another shortcut.
        const layout = x.layout?.() ?? null;
        const stroke = layout ? shortcutStroke(sym, layout) : null;
        if (layout && !stroke) throw new Error(`The keyboard layout in use can't press ${combo.trim()} (its key needs AltGr there, or isn't there), so Ember pressed nothing: any other key would be another shortcut. Switch the layout (for example to English) and try again.`);
        const mods = modifiers.map(m => x.keysymOf(m));
        if ((stroke ? stroke.shift : x.needsShift(sym)) && !mods.includes(SHIFT_L)) mods.push(SHIFT_L);
        const tap = (down: boolean) => (stroke ? pressCode(stroke.code, sym, down) : press(sym, down));
        for (const m of mods) press(m, true);
        try {
          tap(true);
          await sleep(30);
          tap(false);
        } finally {
          for (const m of mods.reverse()) press(m, false);
        }
        await sleep(40);
        check();
      },
      type: async text => {
        // The whole text first: either all of it can be typed exactly, or nothing is.
        const { strokes, shift, byCode } = planText(text);
        const tap = (code: number, sym: number, down: boolean) => (byCode ? pressCode(code, sym, down) : press(sym, down));
        for (const s of strokes) {
          // A dialog or a password prompt can come up while typing: looked for before every character.
          check();
          keyboardOnTarget();
          keyboardFree();
          if (s.shift) tap(shift, SHIFT_L, true);
          tap(s.code, s.sym, true);
          tap(s.code, s.sym, false);
          if (s.shift) tap(shift, SHIFT_L, false);
          await sleep(12);
        }
        check();
      },
      checkTyping: text => {
        planText(text);
      },
      scroll: async (direction, steps) => {
        const button = { up: 4, down: 5, left: 6, right: 7 }[direction];
        check();
        keyboardFree();
        pointerOnTarget();
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
      this.setDriving(true);
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
      const restoreFocus = () => {
        if (!previousWindow || !o.window || previousWindow === o.window) return;
        let may = true;
        try { may = this.options.mayRefocus?.(previousWindow) ?? true; } catch { may = false; }
        if (may) x.activate(previousWindow);
      };
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
      unwatch();
      this.busy = false;
      this.stopping = false;
      o.signal?.removeEventListener("abort", onAbort);
      // Quietly: borrow() reports the end once, with this borrow no longer counted (reported now, it read as "waiting
      // for the user to let go" for a moment, and a screen reader announced that after every borrow).
      this.drivingNow = false;
    }
  }
}
