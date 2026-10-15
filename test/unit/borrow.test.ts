import { describe, expect, it } from "vitest";
import { BorrowStopped, CursorBorrow, UserTookOver, parseCombo } from "../../app/main/hands/borrow";
import type { XInput } from "../../app/main/hands/input";
import { PolicyEngine } from "../../app/main/policy/policy";

/** A pretend X server: a pointer, a keyboard, two windows, and a user who may interfere. */
function fakeX() {
  const s = {
    pointer: { x: 500, y: 400 }, keys: new Set<number>(), active: 11, log: [] as string[],
    /** Called on every pointer query: lets a test play the user. */
    user: (() => undefined) as () => void,
  };
  const x: XInput = {
    pointer: () => { s.user(); return { ...s.pointer }; },
    pointerState: () => ({ ...s.pointer, mask: 0 }),
    move: (px, py) => { s.pointer = { x: px, y: py }; },
    button: (b, down) => { s.log.push(`button ${b} ${down ? "down" : "up"}`); },
    keysym: (sym, down) => { const code = sym % 200 + 8; if (down) s.keys.add(code); else s.keys.delete(code); s.log.push(`key ${sym} ${down ? "down" : "up"}`); return true; },
    keycode: (code, down) => { if (down) s.keys.add(code); else s.keys.delete(code); s.log.push(`keycode ${code} ${down ? "down" : "up"}`); },
    keysymOf: name => ({ Control_L: 0xffe3, Shift_L: 0xffe1, Return: 0xff0d, s: 0x73 } as Record<string, number>)[name] ?? 0,
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
  };
  return { s, x };
}
const fast = { idleMs: 0, sleep: () => Promise.resolve() };

describe("parseCombo", () => {
  it("reads modifiers and key names", () => {
    expect(parseCombo("ctrl+s")).toEqual({ modifiers: ["Control_L"], key: "s" });
    expect(parseCombo("Ctrl+Shift+T")).toEqual({ modifiers: ["Control_L", "Shift_L"], key: "t" });
    expect(parseCombo("enter")).toEqual({ modifiers: [], key: "Return" });
    expect(parseCombo("alt+F4")).toEqual({ modifiers: ["Alt_L"], key: "F4" });
    expect(() => parseCombo("hyper+x")).toThrow(/unknown modifier/);
  });
});

describe("CursorBorrow", () => {
  it("stops at once on the kill switch: no more input, no keys left down, pointer straight home", async () => {
    const { s, x } = fakeX();
    const b = new CursorBorrow(x);
    let moves = 0;
    const move = x.move;
    x.move = (px, py) => { moves++; move(px, py); };
    const run = b.borrow(async hand => {
      await hand.glideTo(100, 120);
      await hand.keys("ctrl+s"); // never reached
    }, { ...fast, window: 22, sleep: () => new Promise(r => setTimeout(r, 1)) });
    await new Promise(r => setTimeout(r, 15));
    b.stop();
    const movesAtStop = moves;
    await expect(run).rejects.toBeInstanceOf(BorrowStopped);
    expect(s.pointer).toEqual({ x: 500, y: 400 });
    expect(moves - movesAtStop).toBeLessThanOrEqual(2); // a jump home, not a glide
    expect(s.log.some(l => l.startsWith("key"))).toBe(false);
    expect(s.keys.size).toBe(0);
    expect(s.active).toBe(11);
    expect(b.active).toBe(false);
    // The next borrow works normally.
    await b.borrow(async hand => { await hand.click(); }, fast);
  });

  it("acts in the target window, then puts the pointer and focus back", async () => {
    const { s, x } = fakeX();
    const b = new CursorBorrow(x);
    await b.borrow(async hand => {
      await hand.glideTo(100, 120);
      expect(s.pointer).toEqual({ x: 100, y: 120 });
      await hand.click();
      await hand.keys("ctrl+s");
    }, { ...fast, window: 22 });
    expect(s.pointer).toEqual({ x: 500, y: 400 });
    expect(s.active).toBe(11);
    expect(s.log).toEqual([
      "activate 22", "button 1 down", "button 1 up",
      `key ${0xffe3} down`, `key ${0x73} down`, `key ${0x73} up`, `key ${0xffe3} up`, "activate 11",
    ]);
    expect(s.keys.size).toBe(0);
    expect(b.active).toBe(false);
  });

  it("lets go the moment the user moves the mouse, and never moves it again", async () => {
    const { s, x } = fakeX();
    let queries = 0;
    s.user = () => { if (++queries === 12) s.pointer = { x: 900, y: 50 }; };
    const b = new CursorBorrow(x);
    const err = await b.borrow(async hand => { await hand.glideTo(100, 100); await hand.click(); }, { ...fast, window: 22 }).catch(e => e);
    expect(err).toBeInstanceOf(UserTookOver);
    expect(s.pointer).toEqual({ x: 900, y: 50 }); // not dragged back
    expect(s.log).not.toContain("button 1 down");
    expect(s.log).not.toContain("activate 11"); // the user is in charge now
    expect(b.active).toBe(false);
  });

  it("lets go when the user presses a key, and never leaves Ember's keys stuck", async () => {
    const { s, x } = fakeX();
    const b = new CursorBorrow(x);
    const err = await b.borrow(async hand => {
      s.keys.add(99); // the user presses something
      await hand.keys("ctrl+s");
    }, fast).catch(e => e);
    expect(err).toBeInstanceOf(UserTookOver);
    expect([...s.keys]).toEqual([99]);
  });

  it("waits for the user to be still, and gives up if they keep going", async () => {
    const { s, x } = fakeX();
    let t = 0;
    s.user = () => { s.pointer = { x: s.pointer.x + 1, y: s.pointer.y }; };
    const b = new CursorBorrow(x);
    const err = await b.borrow(async () => undefined, { idleMs: 500, idleTimeoutMs: 2000, now: () => t, sleep: async ms => { t += ms; } }).catch(e => e);
    expect(String(err)).toMatch(/kept using the mouse/);
    expect(b.active).toBe(false);
  });

  it("types ASCII with shift where needed and refuses other text", async () => {
    const { s, x } = fakeX();
    await new CursorBorrow(x).borrow(hand => hand.type("Hi"), fast);
    expect(s.log.filter(l => l.startsWith("key"))).toEqual([
      `key ${0xffe1} down`, `key ${0x48} down`, `key ${0x48} up`, `key ${0xffe1} up`, `key ${0x69} down`, `key ${0x69} up`,
    ]);
    await expect(new CursorBorrow(x).borrow(hand => hand.type("héllo"), fast)).rejects.toThrow(/ASCII/);
  });

  it("never clicks off the screen (the pointer would be clamped onto something else)", async () => {
    const { s, x } = fakeX();
    await expect(new CursorBorrow(x).borrow(async hand => { await hand.glideTo(300, 900); await hand.click(); }, fast)).rejects.toThrow(/off the screen/);
    expect(s.log).not.toContain("button 1 down");
    expect(s.pointer).toEqual({ x: 500, y: 400 });
  });

  it("never borrows twice at once: the second borrow waits its turn", async () => {
    const { x } = fakeX();
    const b = new CursorBorrow(x);
    const order: string[] = [];
    let release!: () => void;
    const first = b.borrow(() => new Promise<void>(r => { order.push("first"); release = () => { order.push("first done"); r(); }; }), fast);
    await new Promise(r => setTimeout(r, 0));
    const second = b.borrow(async () => { order.push("second"); }, fast);
    await new Promise(r => setTimeout(r, 5));
    expect(order).toEqual(["first"]);
    release();
    await first;
    await second;
    expect(order).toEqual(["first", "first done", "second"]);
  });

  it("Stop cancels borrows that were waiting their turn (nothing moves after Stop)", async () => {
    const { s, x } = fakeX();
    const b = new CursorBorrow(x);
    let release!: () => void;
    const first = b.borrow(() => new Promise<void>(r => { release = r; }), fast);
    await new Promise(r => setTimeout(r, 0));
    const second = b.borrow(async hand => { await hand.glideTo(10, 10); await hand.click(); }, fast);
    const secondResult = expect(second).rejects.toBeInstanceOf(BorrowStopped);
    b.stop();
    release();
    await first; // its work was already done when Stop came
    await secondResult;
    expect(s.log).not.toContain("button 1 down");
  });

  it("a mouse click or held button from the user is a takeover, like moving the mouse", async () => {
    const { x } = fakeX();
    let mask = 0;
    x.pointerState = () => ({ ...x.pointer()!, mask });
    const b = new CursorBorrow(x);
    const err = await b.borrow(async hand => {
      await hand.click(); // Ember's own click doesn't count
      mask = 0x100; // the user presses button 1
      await hand.click();
    }, fast).catch(e => e);
    expect(err).toBeInstanceOf(UserTookOver);
  });

  it("waits while the user holds a mouse button (a drag in progress)", async () => {
    const { x } = fakeX();
    let t = 0;
    x.pointerState = () => ({ x: 500, y: 400, mask: 0x100 });
    const err = await new CursorBorrow(x).borrow(async () => undefined, { idleMs: 500, idleTimeoutMs: 2000, now: () => t, sleep: async ms => { t += ms; } }).catch(e => e);
    expect(String(err)).toMatch(/kept using/);
  });
});

describe("parseCombo punctuation and function keys", () => {
  it("names the keys X knows", () => {
    expect(parseCombo("ctrl+-")).toEqual({ modifiers: ["Control_L"], key: "minus" });
    expect(parseCombo("ctrl++")).toEqual({ modifiers: ["Control_L"], key: "plus" });
    expect(parseCombo("ctrl+,")).toEqual({ modifiers: ["Control_L"], key: "comma" });
    expect(parseCombo("f5")).toEqual({ modifiers: [], key: "F5" });
    expect(parseCombo("insert")).toEqual({ modifiers: [], key: "Insert" });
  });
});

describe("tier 3 policy", () => {
  const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ gedit: "act" }) });
  it("asks every time Ember needs the mouse or keyboard, even with a grant", () => {
    const d = e.decide({ taskId: "t", kind: "cursor_click", app: "gedit", window: "notes", element: { role: "panel", name: "Canvas" } });
    expect(d).toMatchObject({ verdict: "confirm", tier: "confirm", risky: true, prompt: "Borrow your mouse to click “Canvas” panel in gedit?" });
    expect(e.decide({ taskId: "t", kind: "keys", app: "gedit", window: "notes", value: "ctrl+s" }).prompt).toBe("Borrow your keyboard to press ctrl+s in gedit?");
  });
  it("still refuses secrets", () => {
    expect(e.decide({ taskId: "t", kind: "cursor_text", app: "gedit", window: "w", element: { role: "text", name: "Password" }, value: "x" }).verdict).toBe("deny");
    expect(e.decide({ taskId: "t", kind: "keys", app: "gedit", window: "w", element: { role: "password text", name: "" }, value: "Return" }).verdict).toBe("deny");
  });
});

describe("keys go only to the approved window", () => {
  it("doesn't touch a window that never comes to the front", async () => {
    const { s, x } = fakeX();
    x.activate = () => { s.log.push("activate refused"); };
    const err = await new CursorBorrow(x).borrow(async hand => { await hand.click(); }, { ...fast, window: 22 }).catch(e => e);
    expect(String(err)).toMatch(/didn't come to the front/);
    expect(s.log).not.toContain("button 1 down");
  });
  it("stops typing when another window takes the keyboard", async () => {
    const { s, x } = fakeX();
    const err = await new CursorBorrow(x).borrow(async hand => {
      await hand.type("ab");
      s.active = 99; // a dialog popped up
      await hand.type("cd");
    }, { ...fast, window: 22 }).catch(e => e);
    expect(String(err)).toMatch(/another window has the keyboard/);
  });
});

describe("borrows belong to their task (review round 2)", () => {
  it("stopping one task's borrow leaves another task's queued borrow alone", async () => {
    const { s, x } = fakeX();
    const b = new CursorBorrow(x);
    const a = new AbortController();
    let release!: () => void;
    const first = b.borrow(() => new Promise<void>(r => { release = r; }), { ...fast, signal: a.signal });
    await new Promise(r => setTimeout(r, 0));
    const second = b.borrow(async hand => { await hand.click(); }, fast);
    a.abort();
    release();
    await first.catch(() => undefined);
    await second;
    expect(s.log).toContain("button 1 down");
  });
  it("is only 'driving' while it really moves the pointer, not while waiting for the user", async () => {
    const { x } = fakeX();
    let t = 0;
    const b = new CursorBorrow(x);
    let drivingWhileWaiting = false;
    let started = false;
    const run = b.borrow(async () => undefined, { idleMs: 500, now: () => t, onStart: () => { started = true; }, sleep: async ms => { if (!started) drivingWhileWaiting ||= b.driving; t += ms; } });
    let drivingInside = false;
    await run;
    await b.borrow(async () => { drivingInside = b.driving; }, fast);
    expect(drivingWhileWaiting).toBe(false);
    expect(drivingInside).toBe(true);
    expect(b.driving).toBe(false);
  });
});
