/**
 * Borrowing the keyboard and mouse through another OS's input backend (design §2.4, §4.8): its own test of where the
 * screens are (negative coordinates), typing through textKey, the refusal when input can't reach the window, the
 * one-step-behind pointer only where posted moves show up late (pointerLags), the time of Ember's last key, and the
 * OS's spelling of key combinations. A backend without those members (XTest) gets exactly today's borrow.
 */

import { describe, expect, it } from "vitest";
import { CursorBorrow, UserTookOver, canonicalCombo, parseCombo } from "../../app/main/hands/borrow";
import { KEYS } from "../../app/shared/shortcuts";
import type { Input } from "../../app/main/platform/types";

const SUPER_L = 0xffeb, SHIFT_L = 0xffe1, RETURN = 0xff0d;

/** A pretend input backend: a pointer, a keyboard and two windows, with the optional members a test adds. */
function fakeInput(extra: Partial<Input> = {}) {
  const s = { pointer: { x: 500, y: 400 }, keys: new Set<number>(), active: 11, log: [] as string[], user: (() => undefined) as () => void };
  const syms: Record<string, number> = { Control_L: 0xffe3, Shift_L: SHIFT_L, Super_L: SUPER_L, Alt_L: 0xffe9, Return: RETURN, s: 0x73, a: 0x61, F5: 0xffc2 };
  const x: Input = {
    pointer: () => { s.user(); return { ...s.pointer }; },
    pointerState: () => ({ ...s.pointer, mask: 0 }),
    move: (px, py) => { s.pointer = { x: px, y: py }; s.log.push(`move ${px},${py}`); },
    button: (b, down) => { s.log.push(`button ${b} ${down ? "down" : "up"}`); },
    keysym: (sym, down) => { const code = sym % 200 + 8; if (down) s.keys.add(code); else s.keys.delete(code); s.log.push(`key ${sym} ${down ? "down" : "up"}`); return true; },
    keycode: (code, down) => { if (down) s.keys.add(code); else s.keys.delete(code); s.log.push(`keycode ${code} ${down ? "down" : "up"}`); },
    keysymOf: name => syms[name] ?? 0,
    keycodeOf: sym => sym % 200 + 8,
    needsShift: sym => sym >= 0x41 && sym <= 0x5a,
    keysDown: () => [...s.keys],
    activeWindow: () => s.active,
    focusedWindow: () => s.active,
    screenSize: () => ({ width: 1280, height: 800 }),
    findWindow: () => 22,
    activate: w => { s.active = w; s.log.push(`activate ${w}`); },
    sync: () => undefined,
    releaseAll: () => undefined,
    close: () => undefined,
    ...extra,
  };
  return { s, x };
}
const fast = { idleMs: 0, sleep: () => Promise.resolve() };

describe("where the screens are", () => {
  it("goes where the backend says a screen is, negative coordinates too (a monitor left of the main one)", async () => {
    const { s, x } = fakeInput({ onScreen: (px, py) => px >= -1920 && px < 1280 && py >= 0 && py < 1080 });
    const seen: { x: number; y: number }[] = [];
    await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(-500, 300); seen.push({ ...s.pointer }); }, fast);
    expect(seen).toEqual([{ x: -500, y: 300 }]);
    expect(s.pointer).toEqual({ x: 500, y: 400 }); // and back home
  });

  it("refuses a spot on no screen without moving, by the backend's test or else X's one rectangle", async () => {
    const off = fakeInput({ onScreen: (px, py) => px >= -1920 && px < 1280 && py >= 0 && py < 1080 });
    // (The pointer only ever stays home: the borrow's end glides it back to where it already is.)
    const home = (log: string[]) => log.filter(l => l.startsWith("move")).every(l => l === "move 500,400");
    await expect(new CursorBorrow(off.x).borrow(hand => hand.glideTo(-2000, 10), fast)).rejects.toThrow(/off the screen/);
    expect(home(off.s.log)).toBe(true);
    // XTest has no onScreen: a negative spot is off its screen, as today.
    const xtest = fakeInput();
    await expect(new CursorBorrow(xtest.x).borrow(hand => hand.glideTo(-5, 10), fast)).rejects.toThrow(/off the screen/);
    expect(home(xtest.s.log)).toBe(true);
  });
});

describe("typing through the backend's own text keys", () => {
  it("types each character whatever the layout, with Return for a line break, and never asks for a layout plan", async () => {
    const typed: string[] = [];
    const { s, x } = fakeInput({
      textKey: (ch, down) => { typed.push(`${ch} ${down ? "down" : "up"}`); return true; },
      layout: () => { throw new Error("no layout plan with textKey"); },
    });
    await new CursorBorrow(x).borrow(async hand => { hand.checkTyping("Hi!\n"); await hand.type("Hi!\n"); }, fast);
    expect(typed).toEqual(["H down", "H up", "i down", "i up", "! down", "! up"]);
    expect(s.log.filter(l => l.startsWith("key"))).toEqual([`key ${RETURN} down`, `key ${RETURN} up`]);
    expect(s.keys.size).toBe(0);
  });

  it("refuses text that isn't plain ASCII before typing anything, and stops where the backend can't type a character", async () => {
    const typed: string[] = [];
    const { x } = fakeInput({ textKey: (ch, down) => { typed.push(`${ch} ${down ? "down" : "up"}`); return ch !== "z"; } });
    await expect(new CursorBorrow(x).borrow(async hand => { hand.checkTyping("héllo"); }, fast)).rejects.toThrow(/plain ASCII/);
    await expect(new CursorBorrow(x).borrow(hand => hand.type("héllo"), fast)).rejects.toThrow(/plain ASCII/);
    expect(typed).toEqual([]);
    await expect(new CursorBorrow(x).borrow(hand => hand.type("abzc"), fast)).rejects.toThrow("The keyboard can't type “z”, so Ember stopped.");
    expect(typed).toEqual(["a down", "a up", "b down", "b up", "z down"]);
  });

  it("still lets go at once when the user presses a key while Ember types", async () => {
    const { s, x } = fakeInput({ textKey: () => true });
    const err = await new CursorBorrow(x).borrow(async hand => { s.keys.add(99); await hand.type("abc"); }, fast).catch(e => e);
    expect(err).toBeInstanceOf(UserTookOver);
  });
});

describe("input that can't reach the window", () => {
  it("is refused with the backend's reason before anything moves, and the next borrow still works", async () => {
    const asked: number[] = [];
    let why: string | null = "That window belongs to a program running as administrator, so Ember's keyboard and mouse can't reach it.";
    const { s, x } = fakeInput({ blockedReason: w => { asked.push(w); return why; } });
    const b = new CursorBorrow(x);
    await expect(b.borrow(async hand => { await hand.click(); }, { ...fast, window: 22 })).rejects.toThrow(why);
    expect(asked).toEqual([22]);
    expect(s.log).toEqual([]);
    expect([b.active, b.driving, b.pending]).toEqual([false, false, 0]);
    why = null;
    await b.borrow(async hand => { await hand.click(); }, { ...fast, window: 22 });
    expect(s.log).toContain("button 1 down");
  });

  it("asks about window 0 when no window is given, and fails closed when the check itself throws", async () => {
    const asked: number[] = [];
    const ok = fakeInput({ blockedReason: w => { asked.push(w); return null; } });
    await new CursorBorrow(ok.x).borrow(async () => undefined, fast);
    expect(asked).toEqual([0]);
    const broken = fakeInput({ blockedReason: () => { throw new Error("can't tell"); } });
    await expect(new CursorBorrow(broken.x).borrow(async hand => { await hand.click(); }, fast)).rejects.toThrow("can't tell");
    expect(broken.s.log).toEqual([]);
  });
});

describe("posted moves that show up late (pointerLags)", () => {
  /** A backend whose pointer reports where Ember's previous move went (macOS's asynchronous CGEventPost). */
  function lagging(lags: boolean | undefined) {
    const f = fakeInput(lags === undefined ? {} : { pointerLags: lags });
    let shown = { ...f.s.pointer };
    let last = { ...f.s.pointer };
    f.x.move = (px, py) => { shown = last; last = { x: px, y: py }; f.s.pointer = last; };
    f.x.pointer = () => ({ ...shown });
    return f;
  }

  it("counts the previous step as Ember's own only when the backend says its moves lag", async () => {
    const { x } = lagging(true);
    await expect(new CursorBorrow(x).borrow(hand => hand.glideTo(100, 120), fast)).resolves.toBeUndefined();
  });

  it("without the flag (XTest, SendInput) a pointer one step back is the user's: a takeover at once (L5)", async () => {
    for (const flag of [undefined, false]) {
      const { x } = lagging(flag);
      const err = await new CursorBorrow(x).borrow(hand => hand.glideTo(100, 120), fast).catch(e => e);
      expect(err, String(flag)).toBeInstanceOf(UserTookOver);
    }
  });

  it("still lets go when the user moves the pointer anywhere else, lag or not", async () => {
    const { s, x } = fakeInput({ pointerLags: true });
    let queries = 0;
    s.user = () => { if (++queries === 12) s.pointer = { x: 900, y: 50 }; };
    const err = await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(100, 100); await hand.click(); }, fast).catch(e => e);
    expect(err).toBeInstanceOf(UserTookOver);
    expect(s.pointer).toEqual({ x: 900, y: 50 });
  });
});

describe("the time of Ember's last key", () => {
  it("is 0 before any, then when Ember last pressed or released a key (shortcuts and text keys alike)", async () => {
    let t = 1000;
    const tick = { idleMs: 0, now: () => t, sleep: async (ms: number) => { t += ms; } };
    const { x } = fakeInput({ textKey: () => true });
    const b = new CursorBorrow(x);
    expect(b.lastSyntheticKeyAt).toBe(0);
    await b.borrow(async hand => { await hand.click(); }, tick);
    expect(b.lastSyntheticKeyAt).toBe(0); // a click is no key
    await b.borrow(async hand => { await hand.keys("ctrl+s"); }, tick);
    const afterKeys = b.lastSyntheticKeyAt;
    expect(afterKeys).toBeGreaterThan(1000);
    expect(afterKeys).toBeLessThanOrEqual(t);
    await b.borrow(async hand => { await hand.type("ab"); }, tick);
    expect(b.lastSyntheticKeyAt).toBeGreaterThan(afterKeys);
  });
});

describe("key combinations as the OS spells them", () => {
  it("presses ⌘ for cmd on macOS, and keeps Linux's spellings elsewhere", async () => {
    const { s, x } = fakeInput();
    await new CursorBorrow(x, { keys: KEYS.darwin }).borrow(hand => hand.keys("cmd+s"), fast);
    expect(s.log.filter(l => l.startsWith("key"))).toEqual([`key ${SUPER_L} down`, `key ${0x73} down`, `key ${0x73} up`, `key ${SUPER_L} up`]);
    await expect(new CursorBorrow(x).borrow(hand => hand.keys("cmd+s"), fast)).rejects.toThrow(/unknown modifier "cmd"/);
  });

  it("presses what the policy asked about for the logo key's other names on macOS (\"win+s\" is ⌘S), and not on Linux", async () => {
    const { s, x } = fakeInput();
    await new CursorBorrow(x, { keys: KEYS.darwin }).borrow(async hand => { await hand.keys("win+s"); await hand.keys("logo+s"); }, fast);
    const cmdS = [`key ${SUPER_L} down`, `key ${0x73} down`, `key ${0x73} up`, `key ${SUPER_L} up`];
    expect(s.log.filter(l => l.startsWith("key"))).toEqual([...cmdS, ...cmdS]);
    await expect(new CursorBorrow(x).borrow(hand => hand.keys("win+s"), fast)).rejects.toThrow(/unknown modifier "win"/);
    await expect(new CursorBorrow(x, { keys: KEYS.linux }).borrow(hand => hand.keys("logo+s"), fast)).rejects.toThrow(/unknown modifier "logo"/);
  });

  it("parses the Mac's modifier names only with its conventions (L4)", () => {
    expect(parseCombo("cmd+s", KEYS.darwin)).toEqual({ modifiers: ["Super_L"], key: "s" });
    expect(parseCombo("option+shift+left", KEYS.darwin)).toEqual({ modifiers: ["Alt_L", "Shift_L"], key: "Left" });
    expect(parseCombo("ctrl+a", KEYS.darwin)).toEqual({ modifiers: ["Control_L"], key: "a" });
    for (const kc of [undefined, KEYS.linux, KEYS.win32]) {
      expect(() => parseCombo("cmd+s", kc)).toThrow(/unknown modifier/);
      expect(() => parseCombo("mod+s", kc)).toThrow(/unknown modifier/);
      expect(() => parseCombo("option+left", kc)).toThrow(/unknown modifier/);
    }
    expect(() => parseCombo("mod+s", KEYS.darwin)).toThrow(/unknown modifier/);
  });

  it("compares combinations in the OS's modifier order", () => {
    expect(canonicalCombo("cmd+shift+z", KEYS.darwin)).toBe("shift+cmd+z");
    expect(canonicalCombo("Super_L", KEYS.darwin)).toBe("cmd");
    expect(canonicalCombo("super+alt+ctrl+t")).toBe("ctrl+alt+super+t");
    expect(canonicalCombo("Super_L")).toBe("super");
  });
});
