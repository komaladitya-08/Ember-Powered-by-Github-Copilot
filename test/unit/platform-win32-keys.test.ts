/**
 * Keys on Windows (pure, so they run on Linux): every key name Ember's combos use resolves to X's own keysym, named
 * keys press the right virtual key (extended where Windows needs it), letters and digits keep their VK on any layout,
 * punctuation follows the foreground layout but never through AltGr, the key state leaves out Windows' aliases and
 * the fake Ctrl of AltGr, text goes in as KEYEVENTF_UNICODE, and the button mask is logical with swapped buttons.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { parseCombo } from "../../app/main/hands/borrow";
import {
  buttonMask, decodeVkScan, EXTENDED_VKS, FAKE_CONTROL_GRACE_MS, fakeControlPossible, heldKeys, isKeyCode,
  KEYBOARD_VKS, keysymChar, keysymNames, keysymOfName, textStroke, virtualKeyFor, VK,
} from "../../app/main/platform/win32/keys";

const requireCjs = createRequire(import.meta.url);

/** XStringToKeysym from libX11 (needs no display), or null where libX11 isn't installed. */
function xStringToKeysym(): ((name: string) => number) | null {
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const f = koffi.load("libX11.so.6").func("unsigned long XStringToKeysym(const char *name)");
    return name => Number(f(name));
  } catch {
    return null;
  }
}
const xKeysym = process.platform === "linux" ? xStringToKeysym() : null;

/** VkKeyScanExW answers for a layout: character → [vk, shift state] (missing: -1). */
function layout(table: Record<string, [number, number]>): (ch: number) => number {
  return ch => {
    const hit = table[String.fromCharCode(ch)];
    return hit ? ((hit[1] << 8) | hit[0]) << 16 >> 16 : -1; // VkKeyScanExW returns a SHORT
  };
}
const US = layout({
  " ": [0x20, 0], "1": [0x31, 0], "!": [0x31, 1], "2": [0x32, 0], "@": [0x32, 1], ";": [0xba, 0], ":": [0xba, 1],
  "=": [0xbb, 0], "+": [0xbb, 1], ",": [0xbc, 0], "-": [0xbd, 0], "_": [0xbd, 1], ".": [0xbe, 0], "/": [0xbf, 0],
  "?": [0xbf, 1], "`": [0xc0, 0], "~": [0xc0, 1], "[": [0xdb, 0], "\\": [0xdc, 0], "]": [0xdd, 0], "'": [0xde, 0],
  "\"": [0xde, 1],
});
const GERMAN = layout({ "@": [0x51, 6], "€": [0x45, 6], "ß": [0xdb, 0], "+": [0xbb, 0], "*": [0xbb, 1], "1": [0x31, 0] });
const FRENCH = layout({ "&": [0x31, 0], "1": [0x31, 1], "é": [0x32, 0], "2": [0x32, 1], "!": [0xdf, 0] });

describe("keysym names on Windows", () => {
  it("resolves every key name Ember's combos produce (modifiers, aliases, punctuation, F-keys)", () => {
    const combos = [
      "ctrl+a", "control+shift+alt+super+meta+x", "control_l+control_r+shift_l+shift_r+alt_l+alt_r+super_l+super_r+z",
      "enter", "return", "esc", "escape", "tab", "space", "backspace", "delete", "del", "home", "end", "pageup", "pagedown",
      "page_up", "page_down", "prior", "next", "up", "down", "left", "right", "insert", "ins", "menu", "pause", "print",
      "kp_enter", "minus", "plus", "equal", "comma", "period", "dot", "slash", "backslash", "semicolon", "apostrophe",
      "grave", "bracketleft", "bracketright", "ctrl++", "+", "F1", "f12", "F24", "A", "7",
      ..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split("").map(c => `ctrl+${c}`),
    ];
    for (const combo of combos) {
      const { modifiers, key } = parseCombo(combo);
      for (const name of [...modifiers, key]) expect(keysymOfName(name), `${combo}: ${name}`).toBeGreaterThan(0);
    }
  });

  it.skipIf(!xKeysym)("gives the same keysym as X's own XStringToKeysym for every name it knows", () => {
    const names = [...keysymNames(), ..."abcxyzABCXYZ0189".split("")];
    for (const name of names) expect(keysymOfName(name), name).toBe(xKeysym!(name));
  });

  it("is case-sensitive like X, and refuses numeric and unknown names", () => {
    expect(keysymOfName("a")).toBe(0x61);
    expect(keysymOfName("A")).toBe(0x41);
    expect(keysymOfName("return")).toBe(0);
    expect(keysymOfName("0x74")).toBe(0);
    expect(keysymOfName("U0074")).toBe(0);
    expect(keysymOfName("é")).toBe(0);
    expect(keysymOfName("toString")).toBe(0);
    expect(keysymOfName("")).toBe(0);
  });
});

describe("keysyms as virtual keys", () => {
  it("presses named keys with their VK, extended where Windows needs it", () => {
    const vk = (name: string) => virtualKeyFor(keysymOfName(name), US);
    expect(vk("Return")).toEqual({ vk: 0x0d, extended: false, shift: false });
    expect(vk("KP_Enter")).toEqual({ vk: 0x0d, extended: true, shift: false }); // the same code, so keysDown can match it
    expect(vk("Delete")).toEqual({ vk: 0x2e, extended: true, shift: false });
    expect(vk("Left")).toEqual({ vk: 0x25, extended: true, shift: false });
    expect(vk("KP_Left")).toEqual({ vk: 0x25, extended: false, shift: false }); // the numpad key
    expect(vk("Prior")?.vk).toBe(0x21);
    expect(vk("Next")?.vk).toBe(0x22);
    expect(vk("Escape")?.vk).toBe(0x1b);
    expect(vk("Tab")?.vk).toBe(0x09);
    expect(vk("BackSpace")?.vk).toBe(0x08);
    expect(vk("space")?.vk).toBe(0x20);
    expect(vk("Menu")).toEqual({ vk: 0x5d, extended: true, shift: false });
    expect(vk("Print")).toEqual({ vk: 0x2c, extended: true, shift: false });
    expect(vk("F1")?.vk).toBe(0x70);
    expect(vk("F24")?.vk).toBe(0x87);
    expect(vk("F25")).toBeNull(); // Windows has no F25
    expect(vk("KP_7")?.vk).toBe(0x67);
    expect(vk("KP_Divide")).toEqual({ vk: 0x6f, extended: true, shift: false });
  });

  it("presses each side of each modifier with its own VK (what keysDown reports)", () => {
    const vk = (name: string) => virtualKeyFor(keysymOfName(name), US);
    expect(vk("Shift_L")).toEqual({ vk: VK.LSHIFT, extended: false, shift: false });
    expect(vk("Shift_R")).toEqual({ vk: VK.RSHIFT, extended: false, shift: false });
    expect(vk("Control_L")).toEqual({ vk: VK.LCONTROL, extended: false, shift: false });
    expect(vk("Control_R")).toEqual({ vk: VK.RCONTROL, extended: true, shift: false });
    expect(vk("Alt_L")).toEqual({ vk: VK.LMENU, extended: false, shift: false });
    expect(vk("Alt_R")).toEqual({ vk: VK.RMENU, extended: true, shift: false });
    expect(vk("Super_L")).toEqual({ vk: 0x5b, extended: true, shift: false });
    expect(vk("Super_R")?.vk).toBe(0x5c);
  });

  it("keeps letters on their VK on any layout (Ctrl+C stays Ctrl+C), uppercase with Shift", () => {
    const none = () => -1; // a layout that types no Latin letters (Russian)
    expect(virtualKeyFor(0x63, none)).toEqual({ vk: 0x43, extended: false, shift: false });
    expect(virtualKeyFor(0x43, none)).toEqual({ vk: 0x43, extended: false, shift: true });
    expect(virtualKeyFor(0x7a, GERMAN)?.vk).toBe(0x5a);
  });

  it("keeps digits on their VK, with Shift where the layout types them shifted (AZERTY)", () => {
    expect(virtualKeyFor(0x31, US)).toEqual({ vk: 0x31, extended: false, shift: false });
    expect(virtualKeyFor(0x31, FRENCH)).toEqual({ vk: 0x31, extended: false, shift: true });
    expect(virtualKeyFor(0x31, () => -1)).toEqual({ vk: 0x31, extended: false, shift: false });
  });

  it("finds punctuation on the foreground layout, shifted or not", () => {
    expect(virtualKeyFor(0x2f, US)).toEqual({ vk: 0xbf, extended: false, shift: false }); // slash
    expect(virtualKeyFor(0x3f, US)).toEqual({ vk: 0xbf, extended: false, shift: true }); // question
    expect(virtualKeyFor(0x2b, US)).toEqual({ vk: 0xbb, extended: false, shift: true }); // plus
    expect(virtualKeyFor(0x2b, GERMAN)).toEqual({ vk: 0xbb, extended: false, shift: false });
    expect(virtualKeyFor(0x26, FRENCH)).toEqual({ vk: 0x31, extended: false, shift: false }); // & on the 1 key
    expect(virtualKeyFor(0xdf, GERMAN)).toEqual({ vk: 0xdb, extended: false, shift: false }); // ß (Latin-1 keysym)
    expect(virtualKeyFor(0xe9, FRENCH)).toEqual({ vk: 0x32, extended: false, shift: false }); // é
  });

  it("gives no key for a character that needs AltGr there, or that the layout lacks", () => {
    expect(virtualKeyFor(0x40, GERMAN)).toBeNull(); // @ is AltGr+Q: pressed without AltGr it would be Ctrl+Q
    expect(virtualKeyFor(0x10020ac, GERMAN)).toBeNull(); // € (a Unicode keysym)
    expect(virtualKeyFor(0xe9, US)).toBeNull();
    expect(virtualKeyFor(0, US)).toBeNull();
    expect(virtualKeyFor(0xfe50, US)).toBeNull(); // dead_grave: not a character
  });

  it("gives no key for a character whose key is a dead key there, asking with the Shift it would need", () => {
    // German: "^" is the dead circumflex (unshifted), "`" the dead grave (Shift+´); "°" shares the "^" key, shifted.
    const de = layout({ "^": [0xdc, 0], "°": [0xdc, 1], "`": [0xdd, 1], "+": [0xbb, 0] });
    const deDead = (vk: number, shift: boolean) => (vk === 0xdc && !shift) || vk === 0xdd;
    expect(virtualKeyFor(0x5e, de, deDead)).toBeNull(); // asciicircum
    expect(virtualKeyFor(0x60, de, deDead)).toBeNull(); // grave
    expect(virtualKeyFor(0xb0, de, deDead)).toEqual({ vk: 0xdc, extended: false, shift: true }); // ° isn't dead
    expect(virtualKeyFor(0x2b, de, deDead)).toEqual({ vk: 0xbb, extended: false, shift: false });
    // US-International: Shift+6 is a dead circumflex though the 6 key isn't; digits keep their VK all the same.
    const intl = layout({ "^": [0x36, 1], "6": [0x36, 0], "'": [0xde, 0] });
    const intlDead = (vk: number, shift: boolean) => (vk === 0x36 && shift) || vk === 0xde;
    expect(virtualKeyFor(0x5e, intl, intlDead)).toBeNull();
    expect(virtualKeyFor(0x27, intl, intlDead)).toBeNull(); // apostrophe
    expect(virtualKeyFor(0x36, intl, intlDead)).toEqual({ vk: 0x36, extended: false, shift: false });
    // Letters and named keys are never looked up as characters.
    expect(virtualKeyFor(0x61, intl, () => true)).toEqual({ vk: 0x41, extended: false, shift: false });
    expect(virtualKeyFor(0xff0d, intl, () => true)).toEqual({ vk: 0x0d, extended: false, shift: false });
  });

  it("decodes VkKeyScanExW's answer", () => {
    expect(decodeVkScan(0x01bf)).toEqual({ vk: 0xbf, shift: true });
    expect(decodeVkScan(0x00bb)).toEqual({ vk: 0xbb, shift: false });
    expect(decodeVkScan(-1)).toBeNull();
    expect(decodeVkScan(0x0651)).toBeNull(); // Ctrl+Alt = AltGr
    expect(decodeVkScan(0x0251)).toBeNull(); // Ctrl
    expect(decodeVkScan(0x0451)).toBeNull(); // Alt
  });

  it("maps keysyms to characters for the layout lookup (Latin-1 and the BMP only)", () => {
    expect(keysymChar(0x41)).toBe(0x41);
    expect(keysymChar(0xe9)).toBe(0xe9);
    expect(keysymChar(0x10020ac)).toBe(0x20ac);
    expect(keysymChar(0x101f600)).toBe(0); // outside the BMP: VkKeyScanExW takes one WCHAR
    expect(keysymChar(0xff0d)).toBe(0);
    expect(keysymChar(0x7f)).toBe(0);
  });
});

describe("key codes and the key state", () => {
  it("accepts keyboard VKs as key codes, never 0, a mouse button, a generic modifier or VK_PACKET", () => {
    expect(isKeyCode(0x41)).toBe(true);
    expect(isKeyCode(VK.LSHIFT)).toBe(true);
    expect(isKeyCode(0x03)).toBe(true);
    for (const code of [0, 1, 2, 4, 5, 6, VK.SHIFT, VK.CONTROL, VK.MENU, VK.PACKET, 0xff, 0x10041, -1, 1.5]) expect(isKeyCode(code)).toBe(false);
  });

  it("marks the navigation block, right Ctrl/Alt and the Windows keys as extended, not Enter or the left modifiers", () => {
    for (const vk of [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, VK.RCONTROL, VK.RMENU, 0x5b, 0x5c, 0x5d, 0x90]) expect(EXTENDED_VKS.has(vk)).toBe(true);
    for (const vk of [0x0d, VK.LCONTROL, VK.LMENU, VK.LSHIFT, VK.RSHIFT, 0x41]) expect(EXTENDED_VKS.has(vk)).toBe(false);
  });

  it("reports held keys without the generic modifiers, VK_PACKET or mouse buttons", () => {
    // Windows reports a held left Shift as VK_SHIFT and VK_LSHIFT; Ember's own press is VK_LSHIFT only.
    const down = new Set<number>([VK.LBUTTON, VK.SHIFT, VK.LSHIFT, VK.PACKET, 0x41, VK.CONTROL, VK.RCONTROL]);
    expect(heldKeys(vk => down.has(vk))).toEqual([0x41, VK.LSHIFT, VK.RCONTROL]);
    expect(KEYBOARD_VKS).not.toContain(VK.SHIFT);
    expect(KEYBOARD_VKS).toContain(0x03);
    expect(KEYBOARD_VKS).toContain(0xfe);
    expect(heldKeys(() => false)).toEqual([]);
  });

  it("leaves out the fake left Ctrl of AltGr while Ember holds right Alt, and shortly after", () => {
    const down = new Set<number>([VK.LCONTROL, VK.RMENU]);
    const ignore = new Set<number>([VK.LCONTROL]);
    expect(heldKeys(vk => down.has(vk), ignore)).toEqual([VK.RMENU]);
    expect(fakeControlPossible(new Map([[VK.RMENU, true]]), -Infinity, 1000)).toBe(true);
    expect(fakeControlPossible(new Map(), 1000, 1000 + FAKE_CONTROL_GRACE_MS - 1)).toBe(true);
    expect(fakeControlPossible(new Map(), 1000, 1000 + FAKE_CONTROL_GRACE_MS)).toBe(false);
    expect(fakeControlPossible(new Set([VK.LCONTROL]), -Infinity, 1000)).toBe(false);
  });
});

describe("text as KEYEVENTF_UNICODE", () => {
  it("types one character whatever the layout: accents, symbols, and astral ones as two units", () => {
    expect(textStroke("a")).toEqual({ kind: "unicode", units: [0x61] });
    expect(textStroke("é")).toEqual({ kind: "unicode", units: [0xe9] });
    expect(textStroke("€")).toEqual({ kind: "unicode", units: [0x20ac] });
    expect(textStroke("😀")).toEqual({ kind: "unicode", units: [0xd83d, 0xde00] });
    expect(textStroke(" ")).toEqual({ kind: "unicode", units: [0x20] });
  });

  it("presses Enter and Tab as keys (apps act on the key, not on the character)", () => {
    expect(textStroke("\n")).toEqual({ kind: "vk", vk: VK.RETURN });
    expect(textStroke("\r")).toEqual({ kind: "vk", vk: VK.RETURN });
    expect(textStroke("\t")).toEqual({ kind: "vk", vk: VK.TAB });
  });

  it("refuses control characters, lone surrogates and more than one character", () => {
    for (const ch of ["", "ab", "\u0007", "\u007f", "\u0085", "\ud83d", "\ude00", "é"]) expect(textStroke(ch), JSON.stringify(ch)).toBeNull();
  });
});

describe("the button mask", () => {
  it("reports X's bits for the logical buttons", () => {
    expect(buttonMask(vk => vk === VK.LBUTTON, false)).toBe(256);
    expect(buttonMask(vk => vk === VK.RBUTTON, false)).toBe(1024);
    expect(buttonMask(vk => vk === VK.MBUTTON, false)).toBe(512);
    expect(buttonMask(() => true, false)).toBe(256 | 512 | 1024);
    expect(buttonMask(() => false, true)).toBe(0);
  });

  it("swaps the physical buttons when the user swapped them, so 256 stays the primary click", () => {
    expect(buttonMask(vk => vk === VK.RBUTTON, true)).toBe(256);
    expect(buttonMask(vk => vk === VK.LBUTTON, true)).toBe(1024);
  });
});
