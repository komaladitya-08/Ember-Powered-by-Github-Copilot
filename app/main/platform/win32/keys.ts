/**
 * Keys for the Windows backend: X keysym names and numbers (Ember's key vocabulary on every OS: parseCombo, the
 * policy and the borrow all speak X) and the Windows virtual key that each one presses. Key codes on Windows are
 * virtual-key codes (1..254, never 0). Letters and digits map to their layout-independent VK, so Ctrl+C presses the
 * key apps treat as Ctrl+C on any layout; punctuation goes through VkKeyScanExW on the foreground app's layout, and a
 * character that needs AltGr there gets no key (pressed without AltGr it would be another key). Pure: the layout
 * lookup is passed in, so all of it is unit-tested on Linux.
 */

/** Keysyms of the named keys, by their case-sensitive X names (what XStringToKeysym accepts for them). */
const NAMED_KEYSYMS: Record<string, number> = {
  BackSpace: 0xff08, Tab: 0xff09, Clear: 0xff0b, Return: 0xff0d, Pause: 0xff13, Scroll_Lock: 0xff14, Escape: 0xff1b,
  Delete: 0xffff, Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, Prior: 0xff55, Page_Up: 0xff55,
  Next: 0xff56, Page_Down: 0xff56, End: 0xff57, Begin: 0xff58, Select: 0xff60, Print: 0xff61, Execute: 0xff62,
  Insert: 0xff63, Menu: 0xff67, Help: 0xff6a, Break: 0xff6b, Num_Lock: 0xff7f,
  KP_Enter: 0xff8d, KP_Home: 0xff95, KP_Left: 0xff96, KP_Up: 0xff97, KP_Right: 0xff98, KP_Down: 0xff99,
  KP_Prior: 0xff9a, KP_Page_Up: 0xff9a, KP_Next: 0xff9b, KP_Page_Down: 0xff9b, KP_End: 0xff9c, KP_Begin: 0xff9d,
  KP_Insert: 0xff9e, KP_Delete: 0xff9f, KP_Multiply: 0xffaa, KP_Add: 0xffab, KP_Separator: 0xffac,
  KP_Subtract: 0xffad, KP_Decimal: 0xffae, KP_Divide: 0xffaf,
  Shift_L: 0xffe1, Shift_R: 0xffe2, Control_L: 0xffe3, Control_R: 0xffe4, Caps_Lock: 0xffe5, Meta_L: 0xffe7,
  Meta_R: 0xffe8, Alt_L: 0xffe9, Alt_R: 0xffea, Super_L: 0xffeb, Super_R: 0xffec,
};
for (let i = 0; i <= 9; i++) NAMED_KEYSYMS[`KP_${i}`] = 0xffb0 + i;
for (let i = 1; i <= 35; i++) NAMED_KEYSYMS[`F${i}`] = 0xffbd + i;

/** X names of the printable ASCII characters that aren't letters or digits (CHAR_NAMES in borrow.ts, plus space). */
const CHARACTER_NAMES: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24, percent: 0x25, ampersand: 0x26,
  apostrophe: 0x27, quoteright: 0x27, parenleft: 0x28, parenright: 0x29, asterisk: 0x2a, plus: 0x2b, comma: 0x2c,
  minus: 0x2d, period: 0x2e, slash: 0x2f, colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e,
  question: 0x3f, at: 0x40, bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e,
  underscore: 0x5f, grave: 0x60, quoteleft: 0x60, braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
};

/**
 * The X keysym for a name like "Return", "Control_L", "F4", "exclam" or "s" (0 when unknown). Case-sensitive, as
 * in X ("a" and "A" are two keysyms). Unlike X it never accepts numeric names ("0x74", "U0074"): the policy refuses
 * them, and a key Ember can't name it doesn't press.
 */
export function keysymOfName(name: string): number {
  if (Object.hasOwn(NAMED_KEYSYMS, name)) return NAMED_KEYSYMS[name];
  if (Object.hasOwn(CHARACTER_NAMES, name)) return CHARACTER_NAMES[name];
  return /^[A-Za-z0-9]$/.test(name) ? name.charCodeAt(0) : 0;
}

/** The virtual key a key press uses: its code, whether it is an extended key, and whether it needs Shift. */
export interface VirtualKey { vk: number; extended: boolean; shift: boolean }

/** Virtual-key codes Ember refers to by name. */
export const VK = {
  LBUTTON: 0x01, RBUTTON: 0x02, MBUTTON: 0x04, RETURN: 0x0d, TAB: 0x09, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12,
  SPACE: 0x20, LSHIFT: 0xa0, RSHIFT: 0xa1, LCONTROL: 0xa2, RCONTROL: 0xa3, LMENU: 0xa4, RMENU: 0xa5, PACKET: 0xe7,
} as const;

/** Keysym → [virtual key, extended]. The numpad's navigation keysyms are the non-extended VKs (the numpad keys). */
const NAMED_VK = new Map<number, [number, boolean]>([
  [0xff08, [0x08, false]], [0xff09, [0x09, false]], [0xff0b, [0x0c, false]], [0xff0d, [0x0d, false]],
  [0xff13, [0x13, false]], [0xff14, [0x91, false]], [0xff1b, [0x1b, false]], [0xffff, [0x2e, true]],
  [0xff50, [0x24, true]], [0xff51, [0x25, true]], [0xff52, [0x26, true]], [0xff53, [0x27, true]],
  [0xff54, [0x28, true]], [0xff55, [0x21, true]], [0xff56, [0x22, true]], [0xff57, [0x23, true]],
  [0xff58, [0x0c, false]], [0xff60, [0x29, false]], [0xff61, [0x2c, true]], [0xff62, [0x2b, false]],
  [0xff63, [0x2d, true]], [0xff67, [0x5d, true]], [0xff6a, [0x2f, false]], [0xff6b, [0x03, true]],
  [0xff7f, [0x90, true]],
  // Numpad Enter is VK_RETURN with EXTENDEDKEY: the same code as Return, so keysDown() (which only sees VK_RETURN)
  // doesn't make Ember's own numpad Enter look like someone else's key.
  [0xff8d, [0x0d, true]],
  [0xff95, [0x24, false]], [0xff96, [0x25, false]], [0xff97, [0x26, false]], [0xff98, [0x27, false]],
  [0xff99, [0x28, false]], [0xff9a, [0x21, false]], [0xff9b, [0x22, false]], [0xff9c, [0x23, false]],
  [0xff9d, [0x0c, false]], [0xff9e, [0x2d, false]], [0xff9f, [0x2e, false]],
  [0xffaa, [0x6a, false]], [0xffab, [0x6b, false]], [0xffac, [0x6c, false]], [0xffad, [0x6d, false]],
  [0xffae, [0x6e, false]], [0xffaf, [0x6f, true]],
  [0xffe1, [VK.LSHIFT, false]], [0xffe2, [VK.RSHIFT, false]], [0xffe3, [VK.LCONTROL, false]],
  [0xffe4, [VK.RCONTROL, true]], [0xffe5, [0x14, false]], [0xffe7, [0x5b, true]], [0xffe8, [0x5c, true]],
  [0xffe9, [VK.LMENU, false]], [0xffea, [VK.RMENU, true]], [0xffeb, [0x5b, true]], [0xffec, [0x5c, true]],
  [0x20, [VK.SPACE, false]],
]);
for (let i = 0; i <= 9; i++) NAMED_VK.set(0xffb0 + i, [0x60 + i, false]);
for (let i = 1; i <= 24; i++) NAMED_VK.set(0xffbd + i, [0x6f + i, false]); // F1..F24; Windows has no F25+

/**
 * Keys that need KEYEVENTF_EXTENDEDKEY when pressed by code: right Ctrl and Alt, the navigation block, Print Screen,
 * Break, Num Lock, numpad divide, the Windows and Menu keys, and the browser and media keys. Without it, scan-code
 * readers (games, remote desktops) see the numpad key instead of the arrow.
 */
export const EXTENDED_VKS: ReadonlySet<number> = new Set([
  0x03, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5c, 0x5d, 0x6f, 0x90, 0xa3, 0xa5,
  ...Array.from({ length: 0xb7 - 0xa6 + 1 }, (_, i) => 0xa6 + i),
]);

/** The mouse buttons' VKs (GetAsyncKeyState reports them too): not keys. */
const MOUSE_VKS: ReadonlySet<number> = new Set([0x01, 0x02, 0x04, 0x05, 0x06]);
/** VK_SHIFT/VK_CONTROL/VK_MENU duplicate the left and right keys; VK_PACKET is a KEYEVENTF_UNICODE character. */
const NOT_A_KEY: ReadonlySet<number> = new Set([VK.SHIFT, VK.CONTROL, VK.MENU, VK.PACKET]);

/** Is `code` a key code keycode() may press: a keyboard VK that keycodeOf() could have handed out? */
export function isKeyCode(code: number): boolean {
  return Number.isInteger(code) && code >= 0x01 && code <= 0xfe && !MOUSE_VKS.has(code) && !NOT_A_KEY.has(code);
}

/** The VKs keysDown() reads: Ctrl+Break (0x03) and 0x08..0xFE, less the mouse buttons and the aliases above. */
export const KEYBOARD_VKS: readonly number[] = [0x03, ...Array.from({ length: 0xfe - 0x08 + 1 }, (_, i) => 0x08 + i)]
  .filter(vk => !NOT_A_KEY.has(vk));

/**
 * The character a keysym types (Latin-1 keysyms are their code point; other Unicode keysyms are 0x1000000 + code
 * point), or 0 for keysyms that aren't characters. Only the Basic Multilingual Plane: VkKeyScanExW takes one WCHAR.
 */
export function keysymChar(sym: number): number {
  if ((sym >= 0x20 && sym <= 0x7e) || (sym >= 0xa0 && sym <= 0xff)) return sym;
  if (sym >= 0x1000100 && sym <= 0x100ffff) return sym - 0x1000000;
  return 0;
}

/**
 * Decodes VkKeyScanExW's answer: low byte the VK, high byte the shift state (1 Shift, 2 Ctrl, 4 Alt). null when no
 * key types the character (-1), or only with Ctrl or Alt held, which is AltGr on Windows: pressed without them it is
 * another key, and with them it may be a shortcut.
 */
export function decodeVkScan(result: number): { vk: number; shift: boolean } | null {
  const r = result & 0xffff;
  if (r === 0xffff) return null;
  const vk = r & 0xff, mods = r >> 8;
  if (vk === 0 || vk === 0xff || (mods & 0x06) !== 0) return null;
  return { vk, shift: (mods & 0x01) !== 0 };
}

/**
 * The virtual key for a keysym, or null when the keyboard has none. `scan(ch)` is VkKeyScanExW for a UTF-16 unit
 * on the foreground app's layout (layouts are per thread on Windows). Letters keep their VK whatever the layout
 * (uppercase needs Shift); digits keep theirs too, with Shift when the layout types the digit shifted (AZERTY).
 */
export function virtualKeyFor(sym: number, scan: (ch: number) => number): VirtualKey | null {
  const named = NAMED_VK.get(sym);
  if (named) return { vk: named[0], extended: named[1], shift: false };
  if (sym >= 0x61 && sym <= 0x7a) return { vk: sym - 0x20, extended: false, shift: false };
  if (sym >= 0x41 && sym <= 0x5a) return { vk: sym, extended: false, shift: true };
  if (sym >= 0x30 && sym <= 0x39) return { vk: sym, extended: false, shift: decodeVkScan(scan(sym))?.shift ?? false };
  const ch = keysymChar(sym);
  if (!ch) return null;
  const key = decodeVkScan(scan(ch));
  return key ? { vk: key.vk, extended: false, shift: key.shift } : null;
}

/**
 * The key codes held now, from the asynchronous key state (`isDown(vk)`: GetAsyncKeyState's high bit; not
 * GetKeyboardState, which is this thread's stale view). `ignore` are codes to leave out (the fake left Ctrl that
 * Windows adds while Ember holds right Alt on an AltGr layout: Ember didn't press it, and it isn't the user's).
 */
export function heldKeys(isDown: (vk: number) => boolean, ignore: ReadonlySet<number> = new Set()): number[] {
  return KEYBOARD_VKS.filter(vk => !ignore.has(vk) && isDown(vk));
}

/** How long after Ember lets go of right Alt the fake left Ctrl stays ignored (its "up" can trail the key's). */
export const FAKE_CONTROL_GRACE_MS = 150;

/**
 * Is a left Ctrl in the key state possibly the one Windows synthesises for AltGr: Ember holds right Alt now, or let
 * go of it less than FAKE_CONTROL_GRACE_MS ago?
 */
export function fakeControlPossible(emberHolds: ReadonlySet<number> | ReadonlyMap<number, unknown>, rightAltUpAt: number, now: number): boolean {
  return emberHolds.has(VK.RMENU) || now - rightAltUpAt < FAKE_CONTROL_GRACE_MS;
}

/** How to type one character whatever the layout: a VK for line breaks and tabs, else its UTF-16 units. */
export type TextStroke = { kind: "vk"; vk: number } | { kind: "unicode"; units: number[] };

/**
 * The stroke for `ch`: exactly one character (a code point, so a surrogate pair is two units), printable or a line
 * break or tab. null for anything else (control characters, lone surrogates, more than one character): typed as
 * KEYEVENTF_UNICODE they would do something other than type.
 */
export function textStroke(ch: string): TextStroke | null {
  if (ch === "\n" || ch === "\r") return { kind: "vk", vk: VK.RETURN };
  if (ch === "\t") return { kind: "vk", vk: VK.TAB };
  const points = [...ch];
  if (points.length !== 1) return null;
  const cp = points[0].codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return { kind: "unicode", units: Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i)) };
}

/**
 * The buttons held, in X's mask bits (256 primary, 512 middle, 1024 secondary) from the physical buttons'
 * asynchronous state: with the buttons swapped (SM_SWAPBUTTON) the primary is the physical right button.
 */
export function buttonMask(isDown: (vk: number) => boolean, swapped: boolean): number {
  const primary = isDown(swapped ? VK.RBUTTON : VK.LBUTTON), secondary = isDown(swapped ? VK.LBUTTON : VK.RBUTTON);
  return (primary ? 256 : 0) | (isDown(VK.MBUTTON) ? 512 : 0) | (secondary ? 1024 : 0);
}
