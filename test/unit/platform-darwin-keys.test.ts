/**
 * The macOS key tables: X keysym names (Ember's key vocabulary everywhere) to virtual key codes, key codes offset by
 * 8 so none is 0, the flags hardware puts on keys, and the keyboard layout built from a stand-in UCKeyTranslate
 * (AZERTY, Russian with its Command-key QWERTY, dead keys), as CursorBorrow uses it.
 */

import { describe, expect, it } from "vitest";
import { parseCombo } from "../../app/main/hands/borrow";
import { planTyping, shortcutStroke, strokeFor } from "../../app/main/hands/keymap";
import {
  US_ANSI, VK, buildLayout, cgKeyOf, charKeysym, isModifierKey, keyFlags, keysymOf, modifierFlags, namedKey, toCode,
  usNeedsShift, type Translate,
} from "../../app/main/platform/darwin/keys";
import { UC_MODIFIER } from "../../app/main/platform/darwin/hitoolbox";

const ch = (c: string) => c.codePointAt(0)!;

/** A layout as UCKeyTranslate reports it: CGKeyCode → [alone, Shift, Command] (missing entries type nothing). */
function translator(keys: Record<number, [string, string, string?]>): Translate {
  return (key, mods) => {
    const k = keys[key];
    if (!k) return "";
    if (mods & UC_MODIFIER.command) return mods & UC_MODIFIER.shift ? k[1] : k[2] ?? k[0];
    return mods & UC_MODIFIER.shift ? k[1] : k[0];
  };
}
const US = translator({ 0x00: ["a", "A"], 0x01: ["s", "S"], 0x04: ["h", "H"], 0x22: ["i", "I"], 0x12: ["1", "!"], 0x18: ["=", "+"], 0x2f: [".", ">"] });
/** AZERTY: "a" where QWERTY has "q" and the other way round, "&"/"1" on the first digit key, a dead circumflex. */
const AZERTY = translator({ 0x00: ["q", "Q"], 0x0c: ["a", "A"], 0x12: ["&", "1"], 0x0e: ["e", "E"], 0x21: ["", ""] });
/** Russian: Cyrillic when typing, the QWERTY letters with Command (macOS's Command-key layout). */
const RUSSIAN = translator({ 0x00: ["ф", "Ф", "a"], 0x08: ["с", "С", "c"], 0x09: ["м", "М", "v"] });

describe("macOS key names", () => {
  it("resolves every key name CursorBorrow can produce, except keys a Mac keyboard doesn't have", () => {
    const words = [
      "enter", "esc", "tab", "space", "backspace", "delete", "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
      "kp_enter", "minus", "plus", "equal", "comma", "period", "slash", "backslash", "semicolon", "apostrophe", "grave",
      "bracketleft", "bracketright", "ctrl", "shift", "alt", "super", "control_r", "shift_r", "alt_r", "super_r",
      ..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", "a", "Z", "0", "9",
      ...Array.from({ length: 20 }, (_, i) => `F${i + 1}`),
    ];
    for (const w of words) expect([w, keysymOf(parseCombo(w).key)]).not.toEqual([w, 0]);
    for (const missing of ["insert", "menu", "pause", "print", "F21", "F24"]) expect(keysymOf(parseCombo(missing).key)).toBe(0);
  });

  it("gives X's keysym numbers and never takes a numeric spelling", () => {
    expect(keysymOf("Return")).toBe(0xff0d);
    expect(keysymOf("BackSpace")).toBe(0xff08);
    expect(keysymOf("Prior")).toBe(keysymOf("Page_Up"));
    expect(keysymOf("Super_L")).toBe(0xffeb);
    expect(keysymOf("exclam")).toBe(ch("!"));
    expect(keysymOf("A")).toBe(ch("A"));
    expect(keysymOf("0x74")).toBe(0);
    expect(keysymOf("U0074")).toBe(0);
    expect(keysymOf("return")).toBe(0); // case-sensitive, like XStringToKeysym
  });

  it("puts the keys that don't move with the layout on their macOS key codes", () => {
    expect(namedKey(keysymOf("Return"))).toBe(0x24);
    expect(namedKey(keysymOf("BackSpace"))).toBe(VK.delete); // Mac's "delete" key
    expect(namedKey(keysymOf("Delete"))).toBe(VK.forwardDelete);
    expect(namedKey(keysymOf("KP_Enter"))).toBe(0x4c);
    expect(namedKey(keysymOf("Super_L"))).toBe(VK.command);
    expect(namedKey(keysymOf("Meta_L"))).toBe(VK.command);
    expect(namedKey(keysymOf("Alt_L"))).toBe(VK.option);
    expect(namedKey(keysymOf("Control_R"))).toBe(VK.rightControl);
    expect(namedKey(keysymOf("F1"))).toBe(0x7a);
    expect(namedKey(keysymOf("space"))).toBe(VK.space);
    expect(namedKey(ch("a"))).toBe(-1); // a character: the layout decides
  });
});

describe("macOS key codes", () => {
  it("offsets CGKeyCode by 8, so the A key (0) is never read as no key", () => {
    expect(toCode(VK.ansiA)).toBe(8);
    expect(cgKeyOf(8)).toBe(0);
    expect(cgKeyOf(7)).toBe(-1);
    expect(cgKeyOf(8 + 128)).toBe(-1);
    expect(cgKeyOf(8.5)).toBe(-1);
    for (const [code] of US_ANSI) expect(code).toBeGreaterThan(0);
  });

  it("gives held modifiers their generic flag and their side's device bit", () => {
    expect(modifierFlags(VK.shift)).toBe(0x20000 | 0x02);
    expect(modifierFlags(VK.rightShift)).toBe(0x20000 | 0x04);
    expect(modifierFlags(VK.command)).toBe(0x100000 | 0x08);
    expect(modifierFlags(VK.option)).toBe(0x80000 | 0x20);
    expect(modifierFlags(VK.control)).toBe(0x40000 | 0x01);
    expect(modifierFlags(0x00)).toBe(0);
    expect(isModifierKey(VK.capsLock)).toBe(false); // a lock, not held like Shift
  });

  it("puts on each key the flags the hardware sends with it", () => {
    expect(keyFlags(VK.up)).toBe(0x200000 | 0x800000); // arrows: numeric pad and Fn
    expect(keyFlags(0x53)).toBe(0x200000); // keypad 1
    expect(keyFlags(0x7a)).toBe(0x800000); // F1
    expect(keyFlags(VK.forwardDelete)).toBe(0x800000);
    expect(keyFlags(0x00)).toBe(0);
  });
});

describe("what a key types", () => {
  it("names a character by X's keysym numbering", () => {
    expect(charKeysym("a")).toBe(0x61);
    expect(charKeysym("é")).toBe(0xe9);
    expect(charKeysym("ф")).toBe(0x1000000 + 0x444);
    expect(charKeysym("😀")).toBe(0x1000000 + 0x1f600);
    expect(charKeysym("\r")).toBe(0);
    expect(charKeysym("\u0085")).toBe(0);
    expect(charKeysym("ab")).toBe(0);
    expect(charKeysym("")).toBe(0);
    expect(charKeysym(null)).toBe(0);
  });
});

describe("the keyboard layout in use, from UCKeyTranslate", () => {
  it("types text with the layout's own keys and Shift", () => {
    const l = buildLayout(US);
    expect(planTyping("Hi!\n", l)).toEqual([
      { code: toCode(0x04), shift: true, sym: ch("H") },
      { code: toCode(0x22), shift: false, sym: ch("i") },
      { code: toCode(0x12), shift: true, sym: ch("!") },
      { code: toCode(VK.return), shift: false, sym: 0xff0d },
    ]);
    expect(l.shift).toBe(toCode(VK.shift));
  });

  it("presses AZERTY's own a key for a shortcut on a, never QWERTY's (which is q there)", () => {
    const l = buildLayout(AZERTY);
    expect(shortcutStroke(ch("a"), l)).toEqual({ code: toCode(0x0c), shift: false });
    expect(shortcutStroke(ch("q"), l)).toEqual({ code: toCode(0x00), shift: false });
    expect(shortcutStroke(ch("1"), l)).toEqual({ code: toCode(0x12), shift: true });
  });

  it("never presses a dead key for its accent", () => {
    const l = buildLayout(AZERTY);
    expect(l.typing.has(toCode(0x21))).toBe(false);
    expect(() => planTyping("^", l)).toThrow(/can't type “\^”/);
  });

  it("finds Command shortcuts on a Russian layout through its Command-key QWERTY, and types Cyrillic", () => {
    const l = buildLayout(RUSSIAN);
    expect(shortcutStroke(ch("c"), l)).toEqual({ code: toCode(0x08), shift: false });
    expect(shortcutStroke(ch("v"), l)).toEqual({ code: toCode(0x09), shift: false });
    expect(strokeFor(0x1000000 + 0x444, l.typing)).toEqual({ code: toCode(0x00), shift: false }); // ф
    expect(() => planTyping("cv", l)).toThrow(/can't type/); // no Latin letters to type with
  });

  it("takes the shortcut's Shift level as typing gives it (Command+plus is Command+Shift+= on US)", () => {
    expect(shortcutStroke(ch("+"), buildLayout(US))).toEqual({ code: toCode(0x18), shift: true });
  });

  it("knows Shift on the US layout for the fallback", () => {
    expect(usNeedsShift(ch("A"))).toBe(true);
    expect(usNeedsShift(ch("a"))).toBe(false);
    expect(usNeedsShift(ch("?"))).toBe(true);
    expect(usNeedsShift(0xff0d)).toBe(false);
  });
});
