/**
 * A global-shortcut callback alone is not a press: X11 also reports it when the grab ends, so the ask box opened on
 * a Backspace or a click. Only a fresh Ctrl+Alt+Space chord may open it, however the keyboard makes Ctrl and Alt
 * (Caps Lock as an extra Ctrl, Alt on the Win keys).
 */

import { describe, expect, it } from "vitest";
import { ASK_DEBOUNCE_MS, freshAskPress, type Chord } from "../../app/main/hotkey";
import { chordHeld } from "../../app/main/x11";

const chord = (over: Partial<Chord> = {}): Chord => ({ control: true, alt: true, ...over });

describe("a fresh ask press", () => {
  it("accepts Ctrl+Alt held now, once the debounce has passed", () => {
    expect(freshAskPress(chord(), 10_000, 0)).toBe(true);
    expect(freshAskPress(chord(), 10_000, 10_000 - ASK_DEBOUNCE_MS)).toBe(true);
  });

  it("rejects a callback delivered with no modifiers down (Backspace after Esc, or a click)", () => {
    expect(freshAskPress(chord({ control: false, alt: false }), 10_000, 0)).toBe(false);
    expect(freshAskPress(chord({ control: false }), 10_000, 0)).toBe(false);
    expect(freshAskPress(chord({ alt: false }), 10_000, 0)).toBe(false);
  });

  it("ignores the same press reported again in quick succession", () => {
    expect(freshAskPress(chord(), 10_000, 10_000 - ASK_DEBOUNCE_MS + 1)).toBe(false);
    expect(freshAskPress(chord(), 10_000, 10_000 - ASK_DEBOUNCE_MS)).toBe(true);
  });

  it("trusts the accelerator where there is no X display, but still debounces it", () => {
    expect(freshAskPress(null, 10_000, 0)).toBe(true);
    expect(freshAskPress(null, 10_000, 10_000 - ASK_DEBOUNCE_MS + 1)).toBe(false);
  });
});

describe("the chord the X server says is held", () => {
  const CONTROL_L = 0xffe3, CONTROL_R = 0xffe4, ALT_L = 0xffe9, SUPER_L = 0xffeb, CAPS_LOCK = 0xffe5, SPACE = 0x20;
  const ControlMask = 4, Mod1Mask = 8, LockMask = 2, Mod2Mask = 16;
  /** pc105 keycodes: 37 Left Ctrl, 66 Caps Lock, 64 Left Alt, 133 Left Win, 65 Space, 105 Right Ctrl. */
  const us: Record<number, number> = { 37: CONTROL_L, 105: CONTROL_R, 66: CAPS_LOCK, 64: ALT_L, 133: SUPER_L, 65: SPACE };
  /** GNOME Tweaks' "Make Caps Lock an additional Ctrl" (ctrl:nocaps): Control_L sits on two keys. */
  const noCaps: Record<number, number> = { ...us, 66: CONTROL_L };
  /** altwin:swap_alt_win: Alt is on the Win key, Super on the Alt key. */
  const swapAltWin: Record<number, number> = { ...noCaps, 64: SUPER_L, 133: ALT_L };
  const symOf = (map: Record<number, number>) => (code: number) => map[code] ?? 0;

  it("counts Caps Lock made an extra Ctrl, by the server's modifier state and by its key's keysym (review #61)", () => {
    const fresh = (c: ReturnType<typeof chordHeld>) => freshAskPress(c, 10_000, 0);
    // The modifier state X matched the shortcut's grab on.
    expect(chordHeld(ControlMask | Mod1Mask, [66, 64, 65], symOf(noCaps))).toEqual({ control: true, alt: true, space: true });
    // Without it (the server didn't say), any key that is Control_L counts, not only the lowest keycode with it.
    expect(chordHeld(null, [66, 64, 65], symOf(noCaps))).toEqual({ control: true, alt: true, space: true });
    expect(fresh(chordHeld(0, [66, 64, 65], symOf(noCaps)))).toBe(true);
    // Alt on the Win key.
    expect(chordHeld(ControlMask | Mod1Mask, [66, 133, 65], symOf(swapAltWin))).toMatchObject({ control: true, alt: true });
    expect(chordHeld(null, [66, 133, 65], symOf(swapAltWin))).toMatchObject({ control: true, alt: true });
  });

  it("still reads the plain keys, either side, and nothing else as Ctrl or Alt", () => {
    expect(chordHeld(ControlMask | Mod1Mask, [37, 64, 65], symOf(us))).toEqual({ control: true, alt: true, space: true });
    expect(chordHeld(null, [105, 64], symOf(us))).toEqual({ control: true, alt: true, space: false });
    // Caps Lock that is still Caps Lock, the Win key, Num Lock and Caps Lock's lock bits are not the chord.
    expect(chordHeld(LockMask | Mod2Mask, [66, 133, 65], symOf(us))).toEqual({ control: false, alt: false, space: true });
    // The press X reports again when the grab ends: nothing held, so no fresh press.
    expect(freshAskPress(chordHeld(0, [], symOf(noCaps)), 10_000, 0)).toBe(false);
  });
});
