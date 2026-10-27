/**
 * The keyboard can be unusable while the mouse is fine: GNOME's Typing Assist (XKB AccessX Slow, Bounce and Sticky
 * Keys) filters Ember's synthetic keys like the user's, so keys vanish or change, and Sticky Keys switches itself
 * off at Ember's first chord. The input says why (keyboardBlockedReason), and the borrow refuses every key and all
 * typing before the first key goes down, while clicks and scrolls still go ahead.
 */

import { describe, expect, it } from "vitest";
import { CursorBorrow } from "../../app/main/hands/borrow";
import { TYPING_ASSIST_REASON, typingAssistReason, type XInput } from "../../app/main/hands/input";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import { KEYS } from "../../app/shared/shortcuts";
import type { AxNode, Bounds } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";

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
    keysymOf: name => ({ Control_L: CONTROL_L, Shift_L: SHIFT_L, a: 0x61, v: 0x76, Return: 0xff0d, Delete: 0xffff, End: 0xff57 } as Record<string, number>)[name] ?? 0,
    keycodeOf: sym => (sym === CONTROL_L ? 37 : sym === SHIFT_L ? 50 : sym === 0x61 ? 38 : sym === 0x76 ? 55 : sym === 0xff0d ? 36 : sym === 0xffff ? 119 : sym === 0xff57 ? 115 : sym > 0x20 && sym < 0x7f ? 10 : sym === 0x20 ? 65 : 0),
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
  it("refuses keys, typing and the typing and key checks before any key goes down, with the input's reason (review #62)", async () => {
    const { s, x } = fakeX(() => TYPING_ASSIST_REASON);
    const b = new CursorBorrow(x);
    await expect(b.borrow(hand => hand.keys("ctrl+a"), fast)).rejects.toThrow(TYPING_ASSIST_REASON);
    await expect(b.borrow(hand => hand.type("hello"), fast)).rejects.toThrow(TYPING_ASSIST_REASON);
    await expect(b.borrow(async hand => hand.checkTyping("hello"), fast)).rejects.toThrow(TYPING_ASSIST_REASON);
    await expect(b.borrow(async hand => hand.checkKeys!("ctrl+a"), fast)).rejects.toThrow(TYPING_ASSIST_REASON);
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

/**
 * type_text into a field that takes no text by accessibility, on the user's screen: Ember clicks into it, presses
 * select-all and Delete (replace) or text-end (append), and pastes from the clipboard. A real borrow over the pretend
 * input; the field and its window as in worker-platform.test.ts's harness.
 */
function typeHarness(why: () => string | null) {
  const { s, x } = fakeX(why);
  const clip = { written: [] as string[], restored: 0 };
  const FRAME: Bounds = { x: 0, y: 0, width: 800, height: 600 };
  const field = { role: "text", name: "Search", text: "old words", bounds: { x: 10, y: 60, width: 300, height: 30 }, states: ["enabled", "sensitive", "editable", "focusable", "focused"] };
  const nodes = (): AxNode[] => [{ id: 1, parent: null, depth: 0, role: "frame", name: "Notes", states: [], bounds: FRAME }, { id: 2, parent: 1, depth: 1, ...field }];
  const window = { app: "notes", pid: 7, path: "/org/a11y/atspi/accessible/9", name: "Notes", role: "frame", active: true, bounds: FRAME };
  const seen = () => ({ window, x11Window: null, nodes: nodes(), blocked: false, busy: false, truncated: null, others: [], ms: 0, axScale: 1 });
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  // Delete empties the field, and the paste key puts in what was written to the clipboard.
  const keysym = x.keysym;
  x.keysym = (sym, down) => {
    if (down && sym === 0xffff) field.text = "";
    if (down && sym === 0x76) field.text = clip.written.at(-1) ?? "";
    return keysym(sym, down);
  };
  const borrow = new CursorBorrow(x);
  const borrowWith = borrow.borrow.bind(borrow);
  // Without waiting for the user to be still, and at once.
  borrow.borrow = (fn, o) => borrowWith(fn, { ...o, ...fast });
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen(), text: "<screen>", capture: null }), read: async () => seen(), windows: async () => [window], systemDialogOpen: async () => false } as never,
    sidecar: {
      readElement: async (id: number) => {
        const n = nodes().find(e => e.id === id);
        return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds, ...(n.text !== undefined ? { text: n.text } : {}) } : null;
      },
      setText: async () => { throw new Error("background_unavailable: this app takes no text this way"); },
      doAction: async () => { throw new Error("background_unavailable: no accessible action"); },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({ notes: "act" }), keys: KEYS.linux, os: "linux" }),
    confirmer: { ask: async () => "once" } as never,
    audit: { write: () => undefined } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    cursor: { borrow, findWindow: () => 22, setBorrowing: () => undefined },
    clipboard: {
      save: async () => ({ items: [{ "text/plain": "the user's" }], look: "x" }),
      unchanged: async () => true,
      writeText: async (t: string) => { clip.written.push(t); },
      restore: async () => { clip.restored++; },
    },
    limits: { pasteWaitMs: 2000 },
  } as unknown as WorkerDeps, { id: "t1", goal: "write hello in the notes", target: { title: "Notes" } });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { s, clip, call };
}

describe("type_text on the user's screen while the keyboard can't be used", () => {
  for (const mode of ["replace", "append", "insert"] as const) {
    it(`refuses ${mode} before any click and before Ember's text goes on the clipboard (review #62)`, async () => {
      const h = typeHarness(() => TYPING_ASSIST_REASON);
      await h.call("perceive_window", {});
      const r = await h.call("type_text", { id: 2, text: "hello", mode });
      expect(r.resultType).toBe("failure");
      expect(r.textResultForLlm).toContain(TYPING_ASSIST_REASON);
      expect(h.s.log).toEqual([]); // no click, no key
      expect(h.clip.written).toEqual([]);
      expect(h.clip.restored).toBe(0); // nor a wait for a paste that never came
    });
  }

  it("asks about every key it will press, and with the keyboard usable clicks, selects, deletes and pastes", async () => {
    const h = typeHarness(() => null);
    await h.call("perceive_window", {});
    const r = await h.call("type_text", { id: 2, text: "hello", mode: "replace" });
    expect(r.textResultForLlm).toMatch(/^Done/);
    expect(h.s.log.slice(0, 2)).toEqual(["button 1 down", "button 1 up"]);
    expect(h.clip.written).toEqual(["hello"]);
    // Ctrl+A, Delete and Ctrl+V, each asked about up front (before the click) and again as it is pressed.
    const asked = (h.s.asked as { modifiers: number[]; sym: number }[]).map(k => `${k.modifiers.join("+")}:${k.sym.toString(16)}`);
    expect(asked).toEqual([`${CONTROL_L}:61`, ":ffff", `${CONTROL_L}:76`, `${CONTROL_L}:61`, ":ffff", `${CONTROL_L}:76`]);
  });
});
