/**
 * Which key types which character on the keyboard layout in use right now.
 * X has one keymap with several groups (layouts like us,ru) and levels (Shift);
 * pressing a key types what the active group and the locked modifiers (Caps
 * Lock) make of it. Ember looks the characters up there, so "hello" stays
 * "hello" with a Russian layout active, and Caps Lock doesn't invert the case.
 * Pure logic: the X side (input.ts) supplies the layout.
 */

/** The keys of the active group: keycode → [keysym alone, keysym with Shift] (0 for none). */
export type KeyLevels = Map<number, [number, number]>;

export interface KeyLayout {
  /** As typing produces them now: with the active group and any locked modifier (Caps Lock). */
  typing: KeyLevels;
  /** The same keys without Caps Lock: shortcuts ignore it (Ctrl+A stays Ctrl+A). */
  shortcuts: KeyLevels;
  /** The keycode of a Shift key (0 if the layout has none). */
  shift: number;
}

export interface KeyStroke {
  code: number;
  shift: boolean;
}

/** A character to type: its key, and the keysym it gives. */
export interface TypedKey extends KeyStroke {
  sym: number;
}

const SHIFT_L = 0xffe1, SHIFT_R = 0xffe2, RETURN = 0xff0d, TAB = 0xff09;

/** The keysym for a character Ember may type (printable ASCII is its own keysym), or 0. */
export function keysymForChar(ch: string): number {
  if (ch === "\n") return RETURN;
  if (ch === "\t") return TAB;
  const c = ch.codePointAt(0) ?? 0;
  return ch.length === 1 && c >= 0x20 && c <= 0x7e ? c : 0;
}

/** The key that gives `sym` on these keys, alone if any key does, else with Shift; null if none. */
export function strokeFor(sym: number, keys: KeyLevels): KeyStroke | null {
  if (!sym) return null;
  let shifted: KeyStroke | null = null;
  for (const [code, [alone, withShift]] of keys) {
    if (alone === sym) return { code, shift: false };
    if (!shifted && withShift === sym) shifted = { code, shift: true };
  }
  return shifted;
}

/** The keycode of a Shift key on these keys (0 if none). */
export function shiftKey(keys: KeyLevels): number {
  return strokeFor(SHIFT_L, keys)?.code ?? strokeFor(SHIFT_R, keys)?.code ?? 0;
}

/**
 * How to type `text` exactly on this layout, one stroke per character. Throws before anything is
 * typed when some character can't be typed exactly (another script's layout is active, or the
 * character needs AltGr or a dead key there).
 */
export function planTyping(text: string, layout: KeyLayout): TypedKey[] {
  const strokes: TypedKey[] = [];
  const missing = new Set<string>();
  const known = new Map<number, KeyStroke | null>();
  for (const ch of text) {
    const sym = keysymForChar(ch);
    if (!known.has(sym)) known.set(sym, sym ? strokeFor(sym, layout.typing) : null);
    const s = known.get(sym)!;
    if (!s || (s.shift && !layout.shift)) missing.add(ch === " " ? "space" : ch === "\n" ? "Enter" : ch === "\t" ? "Tab" : ch);
    else strokes.push({ ...s, sym });
  }
  if (missing.size) {
    const list = [...missing].slice(0, 6).map(c => `“${c}”`).join(" ");
    throw new Error(`The keyboard layout in use can't type ${list}, so Ember typed nothing. Switch the layout (for example to English) and try again.`);
  }
  return strokes;
}
