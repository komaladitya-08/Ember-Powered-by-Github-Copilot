/**
 * Keys for Ember's desk. The desk's keyboard is a US one; the user's may be
 * anything (German, French, Russian…). So in the take-over view a typed
 * character goes to the desk as that character, whatever keys made it, and
 * only shortcuts (Ctrl, Alt or Super held) go by key. Pure logic: the X side
 * is in agent-process.ts.
 */

/** The X keysym for one character: Latin-1 keysyms are their code points, the rest are 0x01000000 + code point. 0 if not one printable character. */
export function charKeysym(ch: string): number {
  const chars = [...ch];
  if (chars.length !== 1) return 0;
  const cp = chars[0].codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // control characters
  return cp <= 0xff ? cp : 0x01000000 + cp;
}

/** Browser KeyboardEvent.key → X keysym name, for keys that aren't characters. */
const NAMED: Record<string, string> = {
  Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", " ": "space", Delete: "Delete", Insert: "Insert",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next",
  ContextMenu: "Menu", PrintScreen: "Print", Pause: "Pause", ScrollLock: "Scroll_Lock",
  Control: "Control_L", Shift: "Shift_L", Alt: "Alt_L", Meta: "Super_L", OS: "Super_L", Super: "Super_L",
};

/** Modifiers that make a key a shortcut: it then goes by key, not by the character it would type. */
export const SHORTCUT_MODIFIERS = new Set(["Control", "Alt", "Meta", "OS", "Super", "Hyper"]);

/** KeyboardEvent.code → what that key types on a US keyboard (the desk's), for keys other than letters and digits. */
const US_PUNCTUATION: Record<string, string> = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Backquote: "`", Comma: ",", Period: ".", Slash: "/", IntlBackslash: "<",
};

/** The US character at a physical key position (KeyboardEvent.code), or "". */
export function usCharAt(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return US_PUNCTUATION[code] ?? "";
}

export type KeyPlan =
  /** Press this keysym's key as it is, with whatever modifiers are held (named keys, modifiers, shortcuts). */
  | { kind: "key"; sym: number }
  /** Type this character: its key, with the Shift it needs on the desk's keyboard. */
  | { kind: "char"; sym: number };

/**
 * What a browser key event means on the desk. `shortcut`: Ctrl, Alt or Super is held.
 * `code` picks the right-hand modifier keys (ShiftRight → Shift_R). Caps Lock, Num Lock and
 * AltGr send nothing: the characters the user's keyboard makes already include them.
 */
export function planKey(key: string, code: string, shortcut: boolean, lookup: (name: string) => number): KeyPlan | null {
  const named = NAMED[key];
  if (named) {
    const name = /Right$/.test(code) && named.endsWith("_L") ? named.replace(/_L$/, "_R") : named;
    const sym = lookup(name);
    return sym ? { kind: "key", sym } : null;
  }
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) {
    const sym = lookup(key);
    return sym ? { kind: "key", sym } : null;
  }
  const sym = charKeysym(key);
  if (!sym) return null;
  if (!shortcut) return { kind: "char", sym };
  // A shortcut: Latin letters by what the key says (Ctrl+Z is undo on a German keyboard too), digits by position
  // (French digits need Shift), other ASCII as typed, and anything else (Cyrillic…) by where the key is.
  const ascii = sym >= 0x20 && sym <= 0x7e;
  const lower = ascii ? key.toLowerCase() : "";
  const at = usCharAt(code);
  const ch = /^[a-z]$/.test(lower) ? lower : /^Digit\d$/.test(code) ? at : ascii ? key : at;
  return ch ? { kind: "key", sym: ch.charCodeAt(0) } : null;
}

/** A keyboard map as X reports it: `per` keysyms for each keycode from `min` on (0 is NoSymbol). */
export interface KeyMap {
  min: number;
  per: number;
  syms: number[];
}

/** Keysym at a keycode's shift level (0 plain, 1 Shift). */
export const symAt = (map: KeyMap, code: number, level: number) => (level < map.per ? map.syms[(code - map.min) * map.per + level] ?? 0 : 0);

const keycodes = (map: KeyMap) => Array.from({ length: Math.floor(map.syms.length / map.per) }, (_, i) => map.min + i);

/**
 * The key that types `sym` on this map: `shift` true if it needs Shift, false if it must
 * be typed without, null if Shift makes no difference. null when no key has it.
 */
export function findKey(map: KeyMap, sym: number): { code: number; shift: boolean | null } | null {
  if (!sym) return null;
  for (const code of keycodes(map)) {
    if (symAt(map, code, 0) === sym) return { code, shift: symAt(map, code, 1) === sym ? null : false };
  }
  for (const code of keycodes(map)) {
    if (symAt(map, code, 1) === sym) return { code, shift: true };
  }
  return null;
}

/** Keycodes with nothing on them: Ember lends them to characters the map doesn't have. */
export const spareKeycodes = (map: KeyMap) => keycodes(map).filter(code => Array.from({ length: map.per }, (_, l) => symAt(map, code, l)).every(s => s === 0));

/**
 * Spare keycodes lent to characters the desk's keyboard doesn't have (ü on a US map).
 * A lent key keeps its character until it is needed for another: an app may read the
 * key map only when it handles the key press, so changing it back at once could lose
 * the character. The least recently used key is lent again.
 */
export class SpareKeys {
  private lent = new Map<number, { code: number; used: number }>();

  constructor(private free: number[]) {}

  /** The keycode for `sym`; `remap` is true when the key must be given that keysym first. null when there are no spare keys. */
  take(sym: number, now = Date.now()): { code: number; remap: boolean } | null {
    const had = this.lent.get(sym);
    if (had) { had.used = now; return { code: had.code, remap: false }; }
    let code = this.free.shift();
    if (code === undefined) {
      const oldest = [...this.lent.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) return null;
      this.lent.delete(oldest[0]);
      code = oldest[1].code;
    }
    this.lent.set(sym, { code, used: now });
    return { code, remap: true };
  }

  /** A key that can't be lent (something else uses it now): it is never offered again. */
  drop(code: number): void {
    for (const [sym, l] of this.lent) if (l.code === code) this.lent.delete(sym);
    this.free = this.free.filter(c => c !== code);
  }

  /** Every lent key, which go back to having nothing on them. */
  takeBack(): number[] {
    const codes = [...this.lent.values()].map(l => l.code);
    this.lent.clear();
    this.free.unshift(...codes);
    return codes;
  }
}
