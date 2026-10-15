/**
 * Keys on Ember's desk: what the take-over view sends for the user's keys
 * (characters as typed on any layout, shortcuts by key) and how a character
 * the desk's US keyboard lacks gets a key.
 */

import { describe, expect, it } from "vitest";
import { SpareKeys, charKeysym, findKey, planKey, spareKeycodes, usCharAt, type KeyMap } from "../../app/main/desk/keys";

const NAMES: Record<string, number> = { Return: 0xff0d, Shift_L: 0xffe1, Shift_R: 0xffe2, Control_L: 0xffe3, Control_R: 0xffe4, Alt_L: 0xffe9, Super_L: 0xffeb, F5: 0xffc2, space: 0x20, Tab: 0xff09, Left: 0xff51 };
const lookup = (n: string) => NAMES[n] ?? 0;

/** A small US key map: 8 slots per key, as Xvfb reports (only the first two matter here). */
const us = (): KeyMap => {
  const keys: [number, number][] = [
    [0x31, 0x21], // 10: 1 !
    [0x37, 0x26], // 11: 7 &
    [0x30, 0x29], // 12: 0 )
    [0x3d, 0x2b], // 13: = +
    [0x71, 0x51], // 14: q Q
    [0x2f, 0x3f], // 15: / ?
    [0x32, 0x40], // 16: 2 @
    [0, 0],       // 17: spare
    [0x5b, 0x7b], // 18: [ {
    [0, 0],       // 19: spare
    [0x20, 0x20], // 20: space space
  ];
  return { min: 10, per: 4, syms: keys.flatMap(([a, b]) => [a, b, 0, 0]) };
};

describe("desk keys", () => {
  it("names characters as X keysyms (Latin-1 as they are, the rest as Unicode keysyms)", () => {
    expect(charKeysym("a")).toBe(0x61);
    expect(charKeysym("ü")).toBe(0xfc);
    expect(charKeysym("€")).toBe(0x10020ac);
    expect(charKeysym("я")).toBe(0x100044f);
    expect(charKeysym("😀")).toBe(0x101f600);
    expect(charKeysym("Dead")).toBe(0);
    expect(charKeysym("\u0007")).toBe(0);
    expect(charKeysym("")).toBe(0);
  });

  it("types the character the user's layout made, whatever key made it", () => {
    // German: Shift+7 is "/", Shift+0 is "=", AltGr+Q is "@", and ü has a key of its own.
    for (const [key, code] of [["/", "Digit7"], ["=", "Digit0"], ["@", "KeyQ"], ["ü", "BracketLeft"], ["1", "Digit1"], ["&", "Digit1"]]) {
      expect(planKey(key, code, false, lookup), key).toEqual({ kind: "char", sym: charKeysym(key) });
    }
    // AltGr, Caps Lock and Num Lock themselves send nothing: the characters already include them.
    for (const key of ["AltGraph", "CapsLock", "NumLock", "Dead", "Process", "Unidentified"]) expect(planKey(key, "", false, lookup), key).toBeNull();
  });

  it("presses named keys and modifiers as they are, left or right", () => {
    expect(planKey("Enter", "Enter", false, lookup)).toEqual({ kind: "key", sym: 0xff0d });
    expect(planKey(" ", "Space", false, lookup)).toEqual({ kind: "key", sym: 0x20 });
    expect(planKey("Shift", "ShiftRight", false, lookup)).toEqual({ kind: "key", sym: 0xffe2 });
    expect(planKey("Control", "ControlLeft", false, lookup)).toEqual({ kind: "key", sym: 0xffe3 });
    expect(planKey("Meta", "MetaLeft", false, lookup)).toEqual({ kind: "key", sym: 0xffeb });
    expect(planKey("F5", "F5", true, lookup)).toEqual({ kind: "key", sym: 0xffc2 });
    expect(planKey("ArrowLeft", "ArrowLeft", true, lookup)).toEqual({ kind: "key", sym: 0xff51 });
  });

  it("sends shortcuts by key: Latin letters as labelled, digits by position, other scripts by position", () => {
    // Ctrl+Z on a German keyboard (the Z key is where US has Y) is still Ctrl+Z; Ctrl+A on French AZERTY is Ctrl+A.
    expect(planKey("z", "KeyY", true, lookup)).toEqual({ kind: "key", sym: 0x7a });
    expect(planKey("A", "KeyQ", true, lookup)).toEqual({ kind: "key", sym: 0x61 });
    // French Ctrl+1 is Ctrl with the "&" key: the digit by position.
    expect(planKey("&", "Digit1", true, lookup)).toEqual({ kind: "key", sym: 0x31 });
    // Russian Ctrl+С is Ctrl+C (the key's position); punctuation as typed when it is ASCII.
    expect(planKey("с", "KeyC", true, lookup)).toEqual({ kind: "key", sym: 0x63 });
    expect(planKey("-", "Slash", true, lookup)).toEqual({ kind: "key", sym: 0x2d });
    expect(planKey("ß", "Minus", true, lookup)).toEqual({ kind: "key", sym: 0x2d });
    expect(planKey("ж", "IntlRo", true, lookup)).toBeNull();
    expect(usCharAt("Backquote")).toBe("`");
    expect(usCharAt("KeyM")).toBe("m");
    expect(usCharAt("Numpad1")).toBe("");
  });

  it("finds the key and the Shift a character needs on the desk's map", () => {
    const map = us();
    expect(findKey(map, 0x2f)).toEqual({ code: 15, shift: false }); // "/" without Shift
    expect(findKey(map, 0x3f)).toEqual({ code: 15, shift: true }); // "?" with Shift
    expect(findKey(map, 0x3d)).toEqual({ code: 13, shift: false });
    expect(findKey(map, 0x40)).toEqual({ code: 16, shift: true });
    expect(findKey(map, 0x20)).toEqual({ code: 20, shift: null }); // Shift makes no difference
    expect(findKey(map, 0xfc)).toBeNull();
    expect(findKey(map, 0)).toBeNull();
    expect(spareKeycodes(map)).toEqual([17, 19]);
  });

  it("lends spare keys to missing characters, reusing them and taking the least recently used one when all are lent", () => {
    const spare = new SpareKeys([17, 19]);
    expect(spare.take(0xfc, 1)).toEqual({ code: 17, remap: true });
    expect(spare.take(0xe9, 2)).toEqual({ code: 19, remap: true });
    expect(spare.take(0xfc, 3)).toEqual({ code: 17, remap: false }); // ü still on its key
    expect(spare.take(0x10020ac, 4)).toEqual({ code: 19, remap: true }); // é was used longest ago
    spare.drop(19); // something else took it meanwhile
    expect(spare.take(0xe9, 5)).toEqual({ code: 17, remap: true });
    expect(spare.takeBack()).toEqual([17]);
    expect(spare.take(0xe9, 6)).toEqual({ code: 17, remap: true });
    expect(new SpareKeys([]).take(0xfc)).toBeNull();
  });
});
