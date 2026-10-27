/**
 * The keyboard can be unusable while the mouse is fine: GNOME's Typing Assist (XKB AccessX Slow, Bounce and Sticky
 * Keys) filters Ember's synthetic keys like the user's, so keys vanish or change, and Sticky Keys switches itself
 * off at Ember's first chord. The input says why (keyboardBlockedReason), and the borrow refuses every key and all
 * typing before the first key goes down, while clicks and scrolls still go ahead.
 */

import { describe, expect, it } from "vitest";
import { CursorBorrow } from "../../app/main/hands/borrow";
import { TYPING_ASSIST_REASON, typingAssistReason, type XInput } from "../../app/main/hands/input";

const CONTROL_L = 0xffe3, SHIFT_L = 0xffe1;

/** A pretend X input whose keyboard check answers `why`; it records the keys and buttons it is sent. */
function fakeX(why: () => string | null) {
  const s = { log: [] as string[], asked: [] as unknown[], pointer: { x: 500, y: 400 } };
  const x: XInput = {
    pointer: () => ({ ...s.pointer }),
    pointerState: () => ({ ...s.pointer, mask: 0 }),
    move: (px, py) => { s.pointer = { x: px, y: py }; },
    button: (b, down) => { s.log.push(`button ${b} ${down ? "down" : "up"}`); },
    keysym: (sym, down) => { s.log.push(`sym ${sym.toString(16)} ${down ? "down" : "up"}`); return true; },
    keycode: (code, down) => { s.log.push(`code ${code} ${down ? "down" : "up"}`); },
    keysymOf: name => ({ Control_L: CONTROL_L, Shift_L: SHIFT_L, a: 0x61, Return: 0xff0d } as Record<string, number>)[name] ?? 0,
    keycodeOf: sym => (sym === CONTROL_L ? 37 : sym === SHIFT_L ? 50 : sym === 0x61 ? 38 : sym === 0xff0d ? 36 : sym > 0x20 && sym < 0x7f ? 10 : sym === 0x20 ? 65 : 0),
    needsShift: () => false,
    keysDown: () => [],
    activeWindow: () => 22,
    focusedWindow: () => 22,
    screenSize: () => ({ width: 1280, height: 800 }),
    findWindow: () => 22,
    activate: () => undefined,
    sync: () => undefined,
    releaseAll: () => undefined,
    close: () => undefined,
    keyboardBlockedReason: keys => { s.asked.push(keys); return why(); },
  };
  return { s, x };
}
const fast = { idleMs: 0, sleep: () => Promise.resolve(), window: 22 };
const keys = (log: string[]) => log.filter(l => l.startsWith("sym") || l.startsWith("code"));

describe("Typing Assist on X11", () => {
  it("is named when Slow, Bounce or Sticky Keys is on, and not for the other AccessX controls (review #62)", () => {
    expect(typingAssistReason(0)).toBeNull();
    // RepeatKeys, MouseKeys, MouseKeysAccel, AccessXKeys, AccessXTimeout, AccessXFeedback, AudibleBell: Ember's keys get through.
    for (const bit of [0, 4, 5, 6, 7, 8, 9]) expect(typingAssistReason(1 << bit)).toBeNull();
    for (const bit of [1, 2, 3]) expect(typingAssistReason(1 | (1 << bit))).toBe(TYPING_ASSIST_REASON);
    expect(TYPING_ASSIST_REASON).toMatch(/^Typing Assist is on \(Slow Keys, Bounce Keys or Sticky Keys/);
    expect(TYPING_ASSIST_REASON).toMatch(/won't use your keyboard/);
  });
});

describe("a borrow while the keyboard can't be used", () => {
  it("refuses keys, typing and the typing check before any key goes down, with the input's reason (review #62)", async () => {
    const { s, x } = fakeX(() => TYPING_ASSIST_REASON);
    const b = new CursorBorrow(x);
    await expect(b.borrow(hand => hand.keys("ctrl+a"), fast)).rejects.toThrow(TYPING_ASSIST_REASON);
    await expect(b.borrow(hand => hand.type("hello"), fast)).rejects.toThrow(TYPING_ASSIST_REASON);
    await expect(b.borrow(async hand => hand.checkTyping("hello"), fast)).rejects.toThrow(TYPING_ASSIST_REASON);
    expect(keys(s.log)).toEqual([]);
    expect([b.active, b.driving, b.pending]).toEqual([false, false, 0]);
  });

  it("still clicks and scrolls: only the keyboard is refused", async () => {
    const { s, x } = fakeX(() => TYPING_ASSIST_REASON);
    await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(300, 200); await hand.click(); await hand.scroll("down", 1); }, fast);
    expect(s.log).toEqual(["button 1 down", "button 1 up", "button 5 down", "button 5 up"]);
  });

  it("tells the input which keys a shortcut presses, and nothing for typed text", async () => {
    const { s, x } = fakeX(() => null);
    await new CursorBorrow(x).borrow(async hand => { await hand.keys("ctrl+a"); hand.checkTyping("hi"); await hand.type("hi"); }, fast);
    expect(s.asked).toEqual([{ modifiers: [CONTROL_L], sym: 0x61 }, undefined, undefined]);
    expect(keys(s.log)).toContain("sym 61 down");
  });
});
