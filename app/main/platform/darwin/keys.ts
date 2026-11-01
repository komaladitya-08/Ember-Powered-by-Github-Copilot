/**
 * Key tables for the macOS input backend. Ember names keys by X keysym on every platform; macOS presses virtual key
 * codes (CGKeyCode, HIToolbox Events.h). Keys that don't depend on the layout (Return, arrows, F-keys, modifiers,
 * keypad) are a fixed table here; which key types a character depends on the layout in use, so buildLayout() asks
 * the layout (UCKeyTranslate, injected) and the US ANSI table is only the documented fallback for needsShift.
 * Ember's key codes are CGKeyCode + 8: kVK_ANSI_A is 0, and callers read a 0 code as "no key". Pure data and
 * functions, unit-tested on every OS.
 */

import { strokeFor, type KeyLayout, type KeyLevels } from "../../hands/keymap";
import { FLAG } from "./cg";
import { UC_MODIFIER } from "./hitoolbox";

/** Ember's key code for a CGKeyCode (never 0). */
export const CODE_OFFSET = 8;
export const MAX_CG_KEY = 127;
export const toCode = (cgKey: number): number => cgKey + CODE_OFFSET;
/** The CGKeyCode for one of Ember's key codes, or -1 when it isn't one. */
export function cgKeyOf(code: number): number {
  const k = code - CODE_OFFSET;
  return Number.isInteger(k) && k >= 0 && k <= MAX_CG_KEY ? k : -1;
}

/** CGKeyCodes Ember uses by name (kVK_*). */
export const VK = {
  ansiA: 0x00, return: 0x24, tab: 0x30, space: 0x31, delete: 0x33, escape: 0x35, rightCommand: 0x36, command: 0x37,
  shift: 0x38, capsLock: 0x39, option: 0x3a, control: 0x3b, rightShift: 0x3c, rightOption: 0x3d, rightControl: 0x3e,
  function: 0x3f, keypadClear: 0x47, keypadEnter: 0x4c, help: 0x72, home: 0x73, pageUp: 0x74, forwardDelete: 0x75,
  end: 0x77, pageDown: 0x79, left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e,
} as const;

/** X keysyms of the keys that don't move with the layout, by X name, with their CGKeyCode. */
const NAMED: Record<string, [keysym: number, cgKey: number]> = {
  BackSpace: [0xff08, VK.delete], Tab: [0xff09, VK.tab], Clear: [0xff0b, VK.keypadClear], Return: [0xff0d, VK.return],
  Escape: [0xff1b, VK.escape], Delete: [0xffff, VK.forwardDelete], space: [0x20, VK.space],
  Home: [0xff50, VK.home], Left: [0xff51, VK.left], Up: [0xff52, VK.up], Right: [0xff53, VK.right], Down: [0xff54, VK.down],
  Prior: [0xff55, VK.pageUp], Page_Up: [0xff55, VK.pageUp], Next: [0xff56, VK.pageDown], Page_Down: [0xff56, VK.pageDown],
  End: [0xff57, VK.end], Help: [0xff6a, VK.help],
  KP_Enter: [0xff8d, VK.keypadEnter], KP_Multiply: [0xffaa, 0x43], KP_Add: [0xffab, 0x45], KP_Subtract: [0xffad, 0x4e],
  KP_Decimal: [0xffae, 0x41], KP_Divide: [0xffaf, 0x4b], KP_Equal: [0xffbd, 0x51],
  KP_0: [0xffb0, 0x52], KP_1: [0xffb1, 0x53], KP_2: [0xffb2, 0x54], KP_3: [0xffb3, 0x55], KP_4: [0xffb4, 0x56],
  KP_5: [0xffb5, 0x57], KP_6: [0xffb6, 0x58], KP_7: [0xffb7, 0x59], KP_8: [0xffb8, 0x5b], KP_9: [0xffb9, 0x5c],
  F1: [0xffbe, 0x7a], F2: [0xffbf, 0x78], F3: [0xffc0, 0x63], F4: [0xffc1, 0x76], F5: [0xffc2, 0x60], F6: [0xffc3, 0x61],
  F7: [0xffc4, 0x62], F8: [0xffc5, 0x64], F9: [0xffc6, 0x65], F10: [0xffc7, 0x6d], F11: [0xffc8, 0x67], F12: [0xffc9, 0x6f],
  F13: [0xffca, 0x69], F14: [0xffcb, 0x6b], F15: [0xffcc, 0x71], F16: [0xffcd, 0x6a], F17: [0xffce, 0x40], F18: [0xffcf, 0x4f],
  F19: [0xffd0, 0x50], F20: [0xffd1, 0x5a],
  Shift_L: [0xffe1, VK.shift], Shift_R: [0xffe2, VK.rightShift], Control_L: [0xffe3, VK.control], Control_R: [0xffe4, VK.rightControl],
  Caps_Lock: [0xffe5, VK.capsLock], Meta_L: [0xffe7, VK.command], Meta_R: [0xffe8, VK.rightCommand],
  Alt_L: [0xffe9, VK.option], Alt_R: [0xffea, VK.rightOption], Super_L: [0xffeb, VK.command], Super_R: [0xffec, VK.rightCommand],
};

/** X names of the printable ASCII punctuation (the keysym is the character's code). */
const PUNCTUATION: Record<string, string> = {
  exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&", apostrophe: "'", quoteright: "'",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", minus: "-", period: ".", slash: "/", colon: ":",
  semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\",
  bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", quoteleft: "`", braceleft: "{", bar: "|",
  braceright: "}", asciitilde: "~",
};

/** keysym → CGKeyCode of the named keys (the first name wins for aliases like Super_L/Meta_L). */
const NAMED_BY_SYM = new Map<number, number>();
for (const [sym, cg] of Object.values(NAMED)) if (!NAMED_BY_SYM.has(sym)) NAMED_BY_SYM.set(sym, cg);

/**
 * The X keysym for a name like "Return", "s", "F4" or "exclam" (case-sensitive, as XStringToKeysym), or 0 when it
 * is unknown or macOS has no such key (Print, Pause, Menu, Insert, Num_Lock, F21 and up). Numeric spellings ("0x74",
 * "U0074") are never accepted here.
 */
export function keysymOf(name: string): number {
  const named = NAMED[name];
  if (named) return named[0];
  if (/^[A-Za-z0-9]$/.test(name)) return name.charCodeAt(0);
  const p = PUNCTUATION[name];
  return p ? p.charCodeAt(0) : 0;
}

/** The CGKeyCode of a layout-independent key, or -1 when `sym` isn't one. */
export function namedKey(sym: number): number {
  return NAMED_BY_SYM.get(sym) ?? -1;
}

/** The modifier flags a key carries while held: the generic mask plus the left/right device bit (NX_DEVICE*KEYMASK). */
const MODIFIER_FLAGS = new Map<number, number>([
  [VK.shift, FLAG.shift | 0x02], [VK.rightShift, FLAG.shift | 0x04],
  [VK.control, FLAG.control | 0x01], [VK.rightControl, FLAG.control | 0x2000],
  [VK.option, FLAG.alternate | 0x20], [VK.rightOption, FLAG.alternate | 0x40],
  [VK.command, FLAG.command | 0x08], [VK.rightCommand, FLAG.command | 0x10],
]);

/** Is this CGKeyCode a modifier that Ember tracks as held (Shift, Control, Option, Command, either side)? */
export const isModifierKey = (cgKey: number): boolean => MODIFIER_FLAGS.has(cgKey);

/** The flags a held modifier key adds to every event (0 for other keys). */
export const modifierFlags = (cgKey: number): number => MODIFIER_FLAGS.get(cgKey) ?? 0;

/** Command, Control or Option among the flags: what turns a typed character into a shortcut. */
export const SHORTCUT_FLAGS = FLAG.command | FLAG.control | FLAG.alternate;

const KEYPAD = new Set([0x41, 0x43, 0x45, 0x47, 0x4b, 0x4c, 0x4e, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5b, 0x5c]);
const ARROWS = new Set<number>([VK.left, VK.right, VK.down, VK.up]);
const FN_KEYS = new Set<number>([
  0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f, 0x69, 0x6b, 0x71, 0x6a, 0x40, 0x4f, 0x50, 0x5a,
  VK.help, VK.home, VK.end, VK.pageUp, VK.pageDown, VK.forwardDelete,
]);

/**
 * The flags the hardware itself puts on a key's events: arrows carry NumericPad and SecondaryFn, the keypad
 * NumericPad, and the F-keys and the navigation block SecondaryFn. Some apps tell keys apart by them.
 */
export function keyFlags(cgKey: number): number {
  if (ARROWS.has(cgKey)) return FLAG.numericPad | FLAG.secondaryFn;
  if (KEYPAD.has(cgKey)) return FLAG.numericPad;
  if (FN_KEYS.has(cgKey)) return FLAG.secondaryFn;
  return 0;
}

/** CGKeyCodes of the keys that type characters (they move with the layout); the rest is in the named table. */
export const CHARACTER_KEYS: readonly number[] = [
  ...Array.from({ length: 0x33 }, (_, k) => k).filter(k => k !== VK.return && k !== VK.tab && k !== VK.space),
  0x5d, 0x5e, // JIS ¥ and _
];

/** The US ANSI layout: CGKeyCode → [alone, with Shift]. */
const US_CHARS: Record<number, string> = {
  0x00: "aA", 0x01: "sS", 0x02: "dD", 0x03: "fF", 0x04: "hH", 0x05: "gG", 0x06: "zZ", 0x07: "xX", 0x08: "cC", 0x09: "vV",
  0x0b: "bB", 0x0c: "qQ", 0x0d: "wW", 0x0e: "eE", 0x0f: "rR", 0x10: "yY", 0x11: "tT", 0x12: "1!", 0x13: "2@", 0x14: "3#",
  0x15: "4$", 0x16: "6^", 0x17: "5%", 0x18: "=+", 0x19: "9(", 0x1a: "7&", 0x1b: "-_", 0x1c: "8*", 0x1d: "0)", 0x1e: "]}",
  0x1f: "oO", 0x20: "uU", 0x21: "[{", 0x22: "iI", 0x23: "pP", 0x25: "lL", 0x26: "jJ", 0x27: "'\"", 0x28: "kK", 0x29: ";:",
  0x2a: "\\|", 0x2b: ",<", 0x2c: "/?", 0x2d: "nN", 0x2e: "mM", 0x2f: ".>", 0x32: "`~",
};

/**
 * The X keysym of what a key types: Latin-1 is its own code, other Unicode is 0x1000000 + code point. 0 for
 * nothing, control characters, or more than one character (a key that types a ligature isn't one keysym).
 */
export function charKeysym(text: string | null | undefined): number {
  if (!text) return 0;
  const chars = [...text];
  if (chars.length !== 1) return 0;
  const cp = chars[0]!.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return cp <= 0xff ? cp : 0x1000000 + cp;
}

/** The named keys as KeyLevels entries (the same keysym alone and with Shift). */
function namedLevels(keys: KeyLevels): void {
  for (const [sym, cg] of NAMED_BY_SYM) keys.set(toCode(cg), [sym, sym]);
}

/** The US ANSI keys, as KeyLevels (Ember's codes). */
export const US_ANSI: KeyLevels = (() => {
  const keys: KeyLevels = new Map();
  for (const [cg, pair] of Object.entries(US_CHARS)) keys.set(toCode(Number(cg)), [pair.charCodeAt(0), pair.charCodeAt(1)]);
  namedLevels(keys);
  return keys;
})();

/** What a key types on a layout with UCKeyTranslate's modifier state (see hitoolbox.ts): "" or null for nothing. */
export type Translate = (cgKey: number, modifiers: number) => string | null;

/** The character keys of a layout at two modifier states, plus the named keys. */
export function levelsOf(translate: Translate, alone: number, shifted: number): KeyLevels {
  const keys: KeyLevels = new Map();
  for (const cg of CHARACTER_KEYS) {
    const a = charKeysym(translate(cg, alone)), s = charKeysym(translate(cg, shifted));
    if (a || s) keys.set(toCode(cg), [a, s]);
  }
  namedLevels(keys);
  return keys;
}

/**
 * The layout in use as CursorBorrow's KeyLayout. `typing` is what each key types alone and with Shift (Ember posts
 * its keys with explicit flags, so Caps Lock doesn't apply). `shortcuts` takes the alone level with Command held,
 * which is how macOS matches Command shortcuts: Latin layouts give their own letters (on AZERTY the "a" is where
 * QWERTY's "q" is), and non-Latin ones (Russian, Greek) their Command-key QWERTY. A dead key types nothing (0), so
 * it is never pressed for its accent.
 */
export function buildLayout(translate: Translate): KeyLayout {
  return {
    typing: levelsOf(translate, 0, UC_MODIFIER.shift),
    shortcuts: levelsOf(translate, UC_MODIFIER.command, UC_MODIFIER.shift),
    shift: toCode(VK.shift),
    others: [],
  };
}

/** Does typing `sym` need Shift on the US ANSI layout (the fallback when the layout in use can't be read)? */
export function usNeedsShift(sym: number): boolean {
  return strokeFor(sym, US_ANSI)?.shift ?? false;
}
