import { describe, expect, it } from "vitest";
import { CursorBorrow, UserTookOver, parseCombo } from "../../app/main/hands/borrow";
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
    move: (px, py) => { s.pointer = { x: px, y: py }; },
    button: (b, down) => { s.log.push(`button ${b} ${down ? "down" : "up"}`); },
    keysym: (sym, down) => { const code = sym % 200 + 8; if (down) s.keys.add(code); else s.keys.delete(code); s.log.push(`key ${sym} ${down ? "down" : "up"}`); return true; },
    keysymOf: name => ({ Control_L: 0xffe3, Shift_L: 0xffe1, Return: 0xff0d, s: 0x73 } as Record<string, number>)[name] ?? 0,
    keycodeOf: sym => sym % 200 + 8,
    needsShift: sym => sym >= 0x41 && sym <= 0x5a,
    keysDown: () => [...s.keys],
    activeWindow: () => s.active,
    screenSize: () => ({ width: 1280, height: 800 }),
    findWindow: () => 22,
    activate: w => { s.active = w; s.log.push(`activate ${w}`); },
    sync: () => undefined,
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

  it("refuses to borrow twice at once", async () => {
    const { x } = fakeX();
    const b = new CursorBorrow(x);
    let release!: () => void;
    const first = b.borrow(() => new Promise<void>(r => { release = r; }), fast);
    await new Promise(r => setTimeout(r, 0));
    await expect(b.borrow(async () => undefined, fast)).rejects.toThrow(/already/);
    release();
    await first;
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
