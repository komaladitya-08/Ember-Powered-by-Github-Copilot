/**
 * Review round 2 for borrowing the keyboard and mouse: text typed exactly on the
 * layout in use (other scripts, AltGr layouts, Caps Lock), shortcuts that need
 * Shift, a keyboard grabbed by someone else, something on top of the click spot,
 * the user's input seen as events, and the borrow's state changes.
 */

import { describe, expect, it } from "vitest";
import { BorrowStopped, CursorBorrow, UserTookOver, canonicalCombo, parseCombo, type Hand } from "../../app/main/hands/borrow";
import { planTyping, shortcutStroke, type KeyLayout, type KeyLevels } from "../../app/main/hands/keymap";
import type { XInput } from "../../app/main/hands/input";

const SHIFT_L = 0xffe1, CONTROL_L = 0xffe3, RETURN = 0xff0d;
const ch = (c: string) => c.charCodeAt(0);

/** A few keys of a pc105 keyboard: keycode → [group 1 (us), group 2 (ru)] levels. */
const KEYS: Record<number, [[number, number], [number, number]]> = {
  10: [[ch("1"), ch("!")], [ch("1"), ch("!")]],
  11: [[ch("2"), ch("@")], [ch("2"), ch("\"")]],
  21: [[ch("="), ch("+")], [ch("="), ch("+")]],
  26: [[ch("e"), ch("E")], [0x6d5, 0x6f5]], // у У
  38: [[ch("a"), ch("A")], [0x6c6, 0x6e6]], // ф Ф
  43: [[ch("h"), ch("H")], [0x6d2, 0x6f2]], // р Р
  46: [[ch("l"), ch("L")], [0x6c4, 0x6e4]], // д Д
  32: [[ch("o"), ch("O")], [0x6dd, 0x6fd]], // щ Щ
  36: [[RETURN, RETURN], [RETURN, RETURN]],
  50: [[SHIFT_L, SHIFT_L], [SHIFT_L, SHIFT_L]],
  65: [[ch(" "), ch(" ")], [ch(" "), ch(" ")]],
};
const LETTERS = new Set([26, 38, 43, 46, 32]);

/** The layout as X would report it: the active group, Caps Lock inverting the letters, and the other group. */
function layout(group: 0 | 1, caps = false): KeyLayout {
  const levels = (lock: boolean, g: 0 | 1 = group): KeyLevels => new Map(Object.entries(KEYS).map(([code, groups]) => {
    const [alone, shifted] = groups[g];
    return [Number(code), lock && LETTERS.has(Number(code)) ? [shifted, alone] : [alone, shifted]];
  }));
  return { typing: levels(caps), shortcuts: levels(false), shift: 50, others: [levels(false, group ? 0 : 1)] };
}

/** German: "@" "{" are on AltGr (not on the first two levels) and "`" is a dead key. */
const german: KeyLayout = (() => {
  const keys: KeyLevels = new Map([[24, [ch("q"), ch("Q")]], [16, [ch("7"), ch("/")]], [21, [0xfe51 /* dead_acute */, 0xfe50 /* dead_grave */]], [35, [ch("+"), ch("*")]], [50, [SHIFT_L, SHIFT_L]]]);
  return { typing: keys, shortcuts: keys, shift: 50 };
})();

describe("typing on the layout in use", () => {
  it("types each character with the key and level the active layout has for it", () => {
    expect(planTyping("Ha!", layout(0))).toEqual([
      { code: 43, shift: true, sym: ch("H") }, { code: 38, shift: false, sym: ch("a") }, { code: 10, shift: true, sym: ch("!") },
    ]);
    expect(planTyping("a\n", layout(0)).map(s => s.code)).toEqual([38, 36]);
  });
  it("refuses, before typing anything, what another script's layout can't type (us,ru with ru active)", () => {
    expect(() => planTyping("hello", layout(1))).toThrow(/can't type “h” “e” “l” “o”/);
    expect(planTyping("12 = 12", layout(1))).toHaveLength(7); // digits and punctuation are there in both
  });
  it("refuses characters on AltGr or dead keys instead of typing something else", () => {
    expect(() => planTyping("a@b", german)).toThrow(/can't type “a” “@” “b”/);
    expect(() => planTyping("`", german)).toThrow(/can't type “`”/);
    expect(planTyping("+*", german)).toEqual([{ code: 35, shift: false, sym: ch("+") }, { code: 35, shift: true, sym: ch("*") }]);
  });
  it("with Caps Lock on, a lower-case letter takes Shift and a capital doesn't", () => {
    expect(planTyping("Ha1", layout(0, true))).toEqual([
      { code: 43, shift: false, sym: ch("H") }, { code: 38, shift: true, sym: ch("a") }, { code: 10, shift: false, sym: ch("1") },
    ]);
  });
});

/** A pretend X server with a keymap, a grab, a window stack and the user's raw events. */
function fakeX(o: { group?: 0 | 1; caps?: boolean; grabbed?: boolean; covered?: boolean } = {}) {
  const s = { log: [] as string[], pointer: { x: 500, y: 400 }, user: [] as ("pointer" | "keys")[], watching: 0, grabbed: !!o.grabbed, covered: !!o.covered };
  const x: XInput = {
    pointer: () => ({ ...s.pointer }),
    pointerState: () => ({ ...s.pointer, mask: 0 }),
    move: (px, py) => { s.pointer = { x: px, y: py }; },
    button: (b, down) => { s.log.push(`button ${b} ${down ? "down" : "up"}`); },
    keysym: (sym, down) => { s.log.push(`sym ${sym.toString(16)} ${down ? "down" : "up"}`); return true; },
    keycode: (code, down) => { s.log.push(`code ${code} ${down ? "down" : "up"}`); },
    keysymOf: name => ({ Control_L: CONTROL_L, Shift_L: SHIFT_L, Alt_L: 0xffe9, Return: RETURN, plus: ch("+"), exclam: ch("!"), equal: ch("="), minus: ch("-"), a: ch("a"), s: ch("s") } as Record<string, number>)[name] ?? 0,
    keycodeOf: sym => ({ [CONTROL_L]: 37, 0xffe9: 64 } as Record<number, number>)[sym] ?? Number(Object.entries(KEYS).find(([, g]) => g[0].includes(sym))?.[0] ?? 0),
    needsShift: sym => [...Object.values(KEYS)].some(g => g[0][1] === sym && g[0][0] !== sym),
    keysDown: () => [],
    activeWindow: () => 22,
    focusedWindow: () => 22,
    screenSize: () => ({ width: 1280, height: 800 }),
    findWindow: () => 22,
    activate: () => undefined,
    sync: () => undefined,
    releaseAll: () => undefined,
    close: () => undefined,
    layout: () => layout(o.group ?? 0, o.caps),
    keyboardGrabbed: () => s.grabbed,
    pointerOn: () => !s.covered,
    screenLocked: () => false,
    watchUser: on => { s.watching += on ? 1 : -1; return true; },
    userInput: () => s.user.shift() ?? null,
  };
  return { s, x };
}
const fast = { idleMs: 0, sleep: () => Promise.resolve(), window: 22 };
const keysPressed = (log: string[]) => log.filter(l => l.startsWith("code") || l.startsWith("sym"));

describe("CursorBorrow and the keyboard layout", () => {
  it("presses the keys the active layout has, compensating for Caps Lock", async () => {
    const { s, x } = fakeX({ caps: true });
    await new CursorBorrow(x).borrow(hand => hand.type("Ha"), fast);
    expect(keysPressed(s.log)).toEqual(["code 43 down", "code 43 up", "code 50 down", "code 38 down", "code 38 up", "code 50 up"]);
  });
  it("types nothing at all when part of the text can't be typed", async () => {
    const { s, x } = fakeX({ group: 1 });
    const err = await new CursorBorrow(x).borrow(hand => hand.type("12 hello"), fast).catch(e => e);
    expect(String(err)).toMatch(/keyboard layout in use can't type/);
    expect(keysPressed(s.log)).toEqual([]);
  });
  it("lets the caller check all of a long text before typing it in pieces", async () => {
    const { s, x } = fakeX({ group: 1 });
    const err = await new CursorBorrow(x).borrow(async hand => { hand.checkTyping("1111 hello"); await hand.type("1111"); }, fast).catch(e => e);
    expect(String(err)).toMatch(/can't type/);
    expect(keysPressed(s.log)).toEqual([]);
  });
  it("adds Shift for shortcut keys on the shifted level (ctrl+plus, ctrl+!), not for ctrl+= or ctrl+a under Caps Lock", async () => {
    const { s, x } = fakeX({ caps: true });
    const b = new CursorBorrow(x);
    await b.borrow(hand => hand.keys("ctrl+plus"), fast);
    expect(keysPressed(s.log)).toEqual([`sym ffe3 down`, `sym ffe1 down`, "code 21 down", "code 21 up", `sym ffe1 up`, `sym ffe3 up`]);
    s.log.length = 0;
    await b.borrow(hand => hand.keys("ctrl+!"), fast);
    expect(keysPressed(s.log)).toContain("code 10 down");
    expect(keysPressed(s.log)).toContain("sym ffe1 down");
    s.log.length = 0;
    await b.borrow(async hand => { await hand.keys("ctrl+="); await hand.keys("ctrl+a"); }, fast);
    expect(keysPressed(s.log)).toEqual(["sym ffe3 down", "code 21 down", "code 21 up", "sym ffe3 up", "sym ffe3 down", "code 38 down", "code 38 up", "sym ffe3 up"]);
  });
  it("finds a shortcut's letter in another group when the active layout has none (ctrl+a with ru active)", async () => {
    const { s, x } = fakeX({ group: 1 });
    await new CursorBorrow(x).borrow(hand => hand.keys("ctrl+a"), fast);
    expect(keysPressed(s.log)).toEqual(["sym ffe3 down", "code 38 down", "code 38 up", "sym ffe3 up"]);
  });
  it("never presses the key of a character that needs AltGr without AltGr: that would be another shortcut (review round 3)", async () => {
    // German: "@" is AltGr+Q, "]" AltGr+9; the keymap still lists them on those keys, so a lookup by keysym finds Q and 9.
    const { s, x } = fakeX();
    x.layout = () => german;
    x.keysymOf = name => ({ Control_L: CONTROL_L, Shift_L: SHIFT_L, at: ch("@"), bracketright: ch("]"), q: ch("q"), asterisk: ch("*") } as Record<string, number>)[name] ?? 0;
    x.keycodeOf = sym => ({ [CONTROL_L]: 37, [SHIFT_L]: 50, [ch("@")]: 24, [ch("]")]: 18, [ch("q")]: 24 } as Record<number, number>)[sym] ?? 0;
    const b = new CursorBorrow(x);
    for (const combo of ["ctrl+@", "@", "ctrl+]"]) {
      const err = await b.borrow(hand => hand.keys(combo), fast).catch(e => e);
      expect(String(err)).toMatch(new RegExp(`can't press ${combo.replace(/[+\]]/g, "\\$&")} .*AltGr.*pressed nothing`));
    }
    expect(keysPressed(s.log)).toEqual([]);
    await b.borrow(async hand => { await hand.keys("ctrl+q"); await hand.keys("ctrl+*"); }, fast);
    expect(keysPressed(s.log)).toEqual(["sym ffe3 down", "code 24 down", "code 24 up", "sym ffe3 up", "sym ffe3 down", "sym ffe1 down", "code 35 down", "code 35 up", "sym ffe1 up", "sym ffe3 up"]);
  });
});

describe("shortcut keys on the layout in use", () => {
  it("takes the active group first, then another group's first two levels, never a third level", () => {
    expect(shortcutStroke(ch("a"), layout(1))).toEqual({ code: 38, shift: false }); // from us, with ru active
    expect(shortcutStroke(ch("@"), layout(1))).toEqual({ code: 11, shift: true }); // ru has none: us has it with Shift
    expect(shortcutStroke(ch("\""), layout(1))).toEqual({ code: 11, shift: true }); // ru's own Shift+2
    expect(shortcutStroke(ch("@"), german)).toBeNull();
    expect(shortcutStroke(ch("*"), german)).toEqual({ code: 35, shift: true });
  });
});

describe("CursorBorrow and other programs", () => {
  it("won't start while another program holds the keyboard (lock screen, password prompt)", async () => {
    const { s, x } = fakeX({ grabbed: true });
    const err = await new CursorBorrow(x).borrow(hand => hand.keys("ctrl+s"), fast).catch(e => e);
    expect(String(err)).toMatch(/Another program has taken the keyboard.*didn't borrow/);
    expect(s.log).toEqual([]);
    expect(s.watching).toBe(0);
  });
  it("stops when a grab starts mid-way: no more keys, no click", async () => {
    const { s, x } = fakeX();
    const err = await new CursorBorrow(x).borrow(async hand => {
      await hand.keys("ctrl+a");
      s.grabbed = true;
      await hand.type("hello");
    }, fast).catch(e => e);
    expect(String(err)).toMatch(/Another program has taken the keyboard.*stopped/);
    expect(keysPressed(s.log).filter(l => l.startsWith("code") && !l.startsWith("code 38"))).toEqual([]);
    const click = await new CursorBorrow(x).borrow(hand => hand.click(), { ...fast }).catch(e => e);
    expect(String(click)).toMatch(/taken the keyboard/);
    expect(s.log).not.toContain("button 1 down");
  });
  it("clicks into another window of the app only when told the element is there (review round 3)", async () => {
    const { s, x } = fakeX();
    const asked: (number | undefined)[][] = [];
    x.pointerOn = (w, el) => { asked.push([w, el]); return el === 33; };
    expect(String(await new CursorBorrow(x).borrow(hand => hand.click(), fast).catch(e => e))).toMatch(/Something else is on top/);
    await new CursorBorrow(x).borrow(hand => hand.click(), { ...fast, elementWindow: 33 });
    expect(asked).toEqual([[22, undefined], [22, 33]]);
    expect(s.log.filter(l => l.startsWith("button"))).toEqual(["button 1 down", "button 1 up"]);
  });
  it("doesn't click or scroll when something else is on top of the spot", async () => {
    const { s, x } = fakeX({ covered: true });
    for (const act of [(h: Hand) => h.click(), (h: Hand) => h.scroll("down", 3)]) {
      const err = await new CursorBorrow(x).borrow(async hand => { await hand.glideTo(100, 100); await act(hand); }, fast).catch(e => e);
      expect(String(err)).toMatch(/Something else is on top of the app/);
    }
    expect(s.log.filter(l => l.startsWith("button"))).toEqual([]);
  });
  it("refuses to start on a locked or blank screen", async () => {
    const { s, x } = fakeX();
    x.screenLocked = () => true;
    await expect(new CursorBorrow(x).borrow(hand => hand.click(), fast)).rejects.toThrow(/locked or blank/);
    expect(s.log).toEqual([]);
  });
});

describe("CursorBorrow and the user's own input events", () => {
  it("lets go when the user's mouse or keyboard sent anything since the last check (a wheel notch, a quick tap)", async () => {
    const { s, x } = fakeX();
    const err = await new CursorBorrow(x).borrow(async hand => {
      await hand.glideTo(100, 100);
      s.user.push("pointer"); // a wheel notch while Ember waited for something
      await hand.click();
    }, fast).catch(e => e);
    expect(err).toBeInstanceOf(UserTookOver);
    expect(s.log).not.toContain("button 1 down");
    expect(s.watching).toBe(0); // stopped watching
    const keys = await new CursorBorrow(x).borrow(async hand => { s.user.push("keys"); await hand.keys("ctrl+s"); }, fast).catch(e => e);
    expect(keys).toBeInstanceOf(UserTookOver);
  });
  it("a user scrolling with a still mouse isn't idle", async () => {
    const { s, x } = fakeX();
    let t = 0;
    // The pointer never moves; a wheel notch arrives every 50 ms.
    const err = await new CursorBorrow(x).borrow(async () => undefined, {
      idleMs: 500, idleTimeoutMs: 2000, now: () => t, sleep: async ms => { t += ms; s.user.push("pointer"); },
    }).catch(e => e);
    expect(String(err)).toMatch(/kept using/);
  });
});

describe("CursorBorrow state changes", () => {
  it("tells when borrows are pending and when Ember drives", async () => {
    const { x } = fakeX();
    const seen: string[] = [];
    const b: CursorBorrow = new CursorBorrow(x, { onChange: () => seen.push(`${b.pending}/${b.driving}`) });
    await b.borrow(async () => undefined, fast);
    // Its end is one change: never "pending, not driving" after it drove (read as "waiting for you to let go").
    expect(seen).toEqual(["1/false", "1/true", "0/false"]);
    seen.length = 0;
    b.stop();
    await b.borrow(async () => undefined, fast).catch(e => expect(e).toBeInstanceOf(BorrowStopped));
  });
});

describe("key combinations", () => {
  it("names any printable character's key", () => {
    expect(parseCombo("ctrl+!")).toEqual({ modifiers: ["Control_L"], key: "exclam" });
    expect(parseCombo("ctrl+?")).toEqual({ modifiers: ["Control_L"], key: "question" });
    expect(parseCombo("alt+@")).toEqual({ modifiers: ["Alt_L"], key: "at" });
    expect(parseCombo("ctrl+-")).toEqual({ modifiers: ["Control_L"], key: "minus" });
    expect(parseCombo("ctrl+=")).toEqual({ modifiers: ["Control_L"], key: "equal" });
    expect(parseCombo("+")).toEqual({ modifiers: [], key: "plus" });
    expect(parseCombo("super")).toEqual({ modifiers: [], key: "Super_L" });
  });
  it("has one spelling for each combination", () => {
    expect(canonicalCombo("alt+ctrl+t")).toBe("ctrl+alt+t");
    expect(canonicalCombo("Ctrl+Alt+T")).toBe("ctrl+alt+t");
    expect(canonicalCombo("Super_L")).toBe("super");
    expect(canonicalCombo("super")).toBe("super");
    expect(canonicalCombo("meta+l")).toBe("super+l");
    expect(canonicalCombo("ctrl+plus")).toBe("ctrl+plus");
    expect(canonicalCombo("ctrl++")).toBe("ctrl+plus");
    expect(canonicalCombo("shift+ctrl+=")).toBe("ctrl+shift+equal");
    expect(canonicalCombo("Ctrl+Alt+Del")).toBe("ctrl+alt+delete");
    expect(canonicalCombo("alt+F4")).toBe("alt+f4");
    expect(canonicalCombo("Control_R+Alt_L+Delete")).toBe("ctrl+alt+delete");
    expect(canonicalCombo("ctrl+shift+Control_L")).toBe("ctrl+shift");
    expect(canonicalCombo("enter")).toBe("return");
    expect(canonicalCombo("ctrl+!")).toBe("ctrl+exclam");
    expect(canonicalCombo("PageUp")).toBe(canonicalCombo("Page_Up"));
    expect(() => canonicalCombo("hyper+x")).toThrow(/unknown modifier/);
  });
});
