/**
 * Keys typed while the ask box opens: Ember holds the keyboard and later hands
 * what was typed to the box (live retest: the first letters went into Mousepad).
 */

import { describe, expect, it } from "vitest";
import { GRAB_SPIN_MS, HOLD_MAX_MS, grabStatusName, keysymText, typedKey, type Typed } from "../../app/main/hands/keybuffer";

const empty = (): Typed => ({ text: "", submit: false, cancel: false });
const press = (keysym: number, text = "", state = 0) => typedKey(empty(), { keysym, text, state });

describe("what was typed while Ember held the keyboard", () => {
  it("letters go in, Backspace takes the last one, Enter sends, Esc closes", () => {
    let t = empty();
    t = typedKey(t, { keysym: 0x68, text: "h", state: 0 });
    t = typedKey(t, { keysym: 0x69, text: "i", state: 0 });
    expect(t).toEqual({ text: "hi", submit: false, cancel: false });
    t = typedKey(t, { keysym: 0xff08, text: "", state: 0 });
    expect(t.text).toBe("h");
    t = typedKey(t, { keysym: 0xff0d, text: "\r", state: 0 });
    expect(t.submit).toBe(true);
    expect(typedKey(empty(), { keysym: 0xff1b, text: "", state: 0 }).cancel).toBe(true);
  });

  it("Ctrl, Alt or Super held types nothing (the hotkey's own keys too)", () => {
    expect(press(0x61, "a", 4).text).toBe("");
    expect(press(0x61, "a", 8).text).toBe("");
    expect(press(0x61, "a", 64).text).toBe("");
    expect(press(0x61, "a", 0).text).toBe("a");
  });

  it("Enter with nothing typed does not send; after Enter, further keys do nothing", () => {
    expect(press(0xff0d).submit).toBe(false);
    const sent = typedKey({ text: "go", submit: true, cancel: false }, { keysym: 0x78, text: "x", state: 0 });
    expect(sent.text).toBe("go");
  });

  it("Latin-1 and Unicode keysyms become text", () => {
    expect(keysymText(0x41)).toBe("A");
    expect(keysymText(0xe9)).toBe("é");
    expect(keysymText(0x10020ac)).toBe("€");
    expect(keysymText(0xff0d)).toBe("");
    expect(HOLD_MAX_MS).toBe(1500);
    expect(GRAB_SPIN_MS).toBeGreaterThan(0);
    expect(GRAB_SPIN_MS).toBeLessThan(HOLD_MAX_MS);
  });

  it("names a failed grab instead of hiding its status", () => {
    expect(grabStatusName(0)).toBe("GrabSuccess");
    expect(grabStatusName(1)).toBe("AlreadyGrabbed");
    expect(grabStatusName(99)).toBe("GrabError(99)");
  });
});
