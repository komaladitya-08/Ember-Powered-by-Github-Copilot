/**
 * A global-shortcut callback alone is not a press: X11 also reports it when the grab ends, so the ask box opened on
 * a Backspace or a click. Only a fresh Ctrl+Alt+Space chord may open it.
 */

import { describe, expect, it } from "vitest";
import { ASK_DEBOUNCE_MS, freshAskPress, type Chord } from "../../app/main/hotkey";

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
