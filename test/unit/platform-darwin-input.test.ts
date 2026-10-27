/**
 * macOS synthetic input over a stand-in desktop and event poster: key codes CGKeyCode + 8, the layout's own keys
 * for characters (none at all when the layout can't be read), held modifiers as flags on every event, drags while a
 * button is held, X's buttons and wheel, double clicks, text typed whatever the layout, everything Ember holds let go
 * (also at process exit), window lookups with AX titles, activation that never targets Ember, the reasons input is
 * refused (Accessibility; secure input on or unknown; Input Monitoring) and typing is (an input method), the lagging
 * pointer, and CursorBorrow driving it unchanged.
 */

import { describe, expect, it } from "vitest";
import { CursorBorrow, type Hand } from "../../app/main/hands/borrow";
import { KEYS } from "../../app/shared/shortcuts";
import {
  ACCESSIBILITY_REASON, DOUBLE_CLICK_MS, INPUT_METHOD_REASON, INPUT_MONITORING_REASON, INPUT_SOURCE_UNKNOWN_REASON,
  SECURE_INPUT_UNKNOWN_REASON, createDarwinInput, type DarwinInputDeps,
} from "../../app/main/platform/darwin/input";
import type { DarwinDesktop, DarwinPoster } from "../../app/main/platform/darwin/desktop";
import type { KeyboardLayoutSource } from "../../app/main/platform/darwin/hitoolbox";
import { UC_MODIFIER } from "../../app/main/platform/darwin/hitoolbox";
import { OVERLAY_TITLE, type AXWindowInfo, type CGWindowEntry } from "../../app/main/platform/darwin/model";

const OWN = 4242;
const ch = (c: string) => c.codePointAt(0)!;
const w = (id: number, pid: number, owner: string, title: string, x: number, y: number, width: number, height: number, layer = 0): CGWindowEntry =>
  ({ id, pid, owner, title, bounds: { x, y, width, height }, layer, alpha: 1 });

/** AZERTY-ish: a/q swapped, "&"/"1" on the first digit key, h, i, e as on QWERTY, a dead circumflex. */
const AZERTY: Record<number, [string, string]> = {
  0x00: ["q", "Q"], 0x0c: ["a", "A"], 0x01: ["s", "S"], 0x04: ["h", "H"], 0x22: ["i", "I"], 0x0e: ["e", "E"], 0x12: ["&", "1"], 0x21: ["", ""],
};
function layoutSource(keys: Record<number, [string, string]>, calls: string[] = []): KeyboardLayoutSource {
  return {
    translate: (key, mods) => (calls.push(`translate ${key}`), keys[key]?.[mods & UC_MODIFIER.shift ? 1 : 0] ?? ""),
    release: () => undefined,
  };
}

function fakeDesktop() {
  const s = {
    windows: [
      w(900, OWN, "Ember", OVERLAY_TITLE, 0, 0, 1440, 900, 1000),
      w(120, 500, "TextEdit", "", 210, 160, 220, 120, 101),
      w(101, 500, "TextEdit", "", 100, 100, 600, 400),
      w(103, 500, "TextEdit", "", 150, 150, 500, 300),
      w(104, 600, "Finder", "Downloads", 50, 50, 800, 500),
      w(108, 600, "Finder", "", 900, 50, 300, 200),
    ],
    pointer: { x: 400, y: 300 } as { x: number; y: number } | null,
    buttons: new Set<number>(),
    flags: 0,
    keys: new Set<number>(),
    frontmost: 500 as number | null,
    focused: new Map<number, AXWindowInfo>([[500, { id: 101, title: "notes.txt", frame: null }]]),
    axWindows: new Map<number, AXWindowInfo[] | null>([
      [500, [{ id: 101, title: "notes.txt", frame: null }, { id: 103, title: "Other", frame: null }]],
    ]),
    trusted: true,
    secure: false as boolean | null,
    secureInputPid: null as number | null,
    sessionReadable: true,
    listen: true as boolean | null,
    layoutSource: true as boolean | null,
    locked: false,
    asleep: false,
    layout: layoutSource(AZERTY) as KeyboardLayoutSource | null,
    calls: [] as string[],
  };
  const desktop: DarwinDesktop = {
    windows: () => s.windows,
    pointer: () => s.pointer,
    buttonDown: b => s.buttons.has(b),
    flags: () => s.flags,
    keyDown: k => s.keys.has(k),
    keysDown: () => (s.calls.push("keys"), [...s.keys]),
    frontmostPid: () => s.frontmost,
    focusedWindow: pid => s.focused.get(pid) ?? null,
    appWindows: pid => (s.calls.push(`ax windows ${pid}`), s.axWindows.get(pid) ?? null),
    raise: (pid, id) => {
      s.calls.push(`raise ${pid} ${id}`);
      s.focused.set(pid, { id, title: "", frame: null });
      const i = s.windows.findIndex(e => e.id === id);
      s.windows.unshift(...s.windows.splice(i, 1)); // now in front
      return true;
    },
    trusted: () => s.trusted,
    secureInput: () => s.secure,
    session: () => (s.sessionReadable ? { locked: s.locked, secureInputPid: s.secureInputPid } : null),
    screenAccess: () => true,
    listenAccess: () => s.listen,
    requestListenAccess: () => s.listen,
    postAccess: () => true,
    inputSourceIsLayout: () => s.layoutSource,
    processPath: () => null,
    mainDisplay: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    displaysAt: (x, y) => (x >= 0 && y >= 0 && x < 1440 && y < 900) || (x >= -1280 && x < 0 && y >= 100 && y < 900) ? 1 : 0,
    displayAsleep: () => s.asleep,
    keyboardLayout: () => s.layout,
    dispose: () => s.calls.push("dispose"),
  };
  return { s, desktop };
}

/** Records every event; a posted move or click moves the pretend pointer, as the window server would. */
function fakePoster(s: { pointer: { x: number; y: number } | null }) {
  const log: string[] = [];
  const hex = (n: number) => n.toString(16);
  const poster: DarwinPoster = {
    mouse: (type, x, y, button, click, flags) => { log.push(`mouse ${type} ${x},${y} b${button} c${click} f${hex(flags)}`); s.pointer = { x, y }; },
    key: (key, down, flags) => log.push(`key ${key} ${down ? "down" : "up"} f${hex(flags)}`),
    text: (key, text, down, flags) => log.push(`text ${key} ${text} ${down ? "down" : "up"} f${hex(flags)}`),
    scroll: (lines, columns, flags) => log.push(`scroll ${lines},${columns} f${hex(flags)}`),
    close: () => log.push("close"),
  };
  return { log, poster };
}

function setup(deps: DarwinInputDeps = {}) {
  const { s, desktop } = fakeDesktop();
  const warned: string[] = [];
  deps = { log: { warn: (e, f) => warned.push(`${e} ${JSON.stringify(f)}`), info: () => undefined }, ...deps };
  const { log, poster } = fakePoster(s);
  let t = 1000;
  const clock = { advance: (ms: number) => { t += ms; } };
  const exits: (() => void)[] = [];
  let unregistered = 0;
  const input = createDarwinInput(desktop, poster, deps, {
    ownPid: OWN,
    now: () => t,
    onExit: fn => { exits.push(fn); return () => { unregistered++; }; },
  });
  return { s, log, input, clock, exits, warned, unregistered: () => unregistered };
}

describe("macOS key codes and the layout in use", () => {
  it("gives every key a code of CGKeyCode + 8, so the A key is never 0", () => {
    const { input } = setup();
    expect(input.keycodeOf(input.keysymOf("Return"))).toBe(0x24 + 8);
    expect(input.keycodeOf(input.keysymOf("Super_L"))).toBe(0x37 + 8);
    expect(input.keycodeOf(ch("q"))).toBe(0x00 + 8); // AZERTY's q is QWERTY's a key, CGKeyCode 0
  });

  it("finds a character's key on the layout in use", () => {
    const { input } = setup();
    expect(input.keycodeOf(ch("a"))).toBe(0x0c + 8);
    expect(input.needsShift(ch("1"))).toBe(true);
    expect(input.needsShift(ch("&"))).toBe(false);
    expect(input.keycodeOf(ch("^"))).toBe(0); // only on a dead key
  });

  it("presses no character key at all when the layout can't be read: a US guess could be another shortcut", () => {
    const { s, input } = setup();
    s.layout = null;
    expect(input.layout()).toBeNull();
    expect(input.keycodeOf(ch("a"))).toBe(0);
    expect(input.keysym(ch("a"), true)).toBe(false);
    expect(input.keycodeOf(input.keysymOf("Tab"))).toBe(0x30 + 8);
    expect(input.needsShift(ch("A"))).toBe(true); // the US table still answers this
  });

  it("builds the layout once per input source", () => {
    const { s, input } = setup();
    const calls: string[] = [];
    s.layout = layoutSource(AZERTY, calls);
    const first = input.layout();
    const n = calls.length;
    expect(input.layout()).toBe(first);
    expect(calls.length).toBe(n);
  });
});

describe("macOS keys", () => {
  it("carries the modifiers Ember holds as flags on every event, with their side's device bit", () => {
    const { log, input } = setup();
    input.keysym(input.keysymOf("Super_L"), true);
    input.keysym(input.keysymOf("Shift_R"), true);
    input.keycode(0x0c + 8, true);
    input.keycode(0x0c + 8, false);
    input.keysym(input.keysymOf("Shift_R"), false);
    input.keysym(input.keysymOf("Super_L"), false);
    expect(log).toEqual([
      "key 55 down f100108", "key 60 down f12010c", "key 12 down f12010c", "key 12 up f12010c", "key 60 up f100108", "key 55 up f100",
    ]);
  });

  it("puts the hardware's own flags on arrows and function keys", () => {
    const { log, input } = setup();
    input.keysym(input.keysymOf("Up"), true);
    input.keysym(input.keysymOf("F5"), true);
    expect(log).toEqual(["key 126 down fa00100", "key 96 down f800100"]);
  });

  it("ignores codes that aren't keys", () => {
    const { log, input } = setup();
    input.keycode(0, true);
    input.keycode(7, true);
    input.keycode(200, true);
    expect(log).toEqual([]);
  });

  it("reports the keys held now as codes, leaving Caps Lock out, from one read of every key (M11)", () => {
    const { s, input } = setup();
    s.keys = new Set([0x00, 0x38, 0x39]);
    expect(input.keysDown()).toEqual([8, 0x38 + 8]);
    expect(s.calls.filter(c => c === "keys")).toEqual(["keys"]);
  });
});

describe("macOS text", () => {
  it("types any character on the A key with its text attached, whatever the layout", () => {
    const { s, log, input } = setup();
    s.layout = null;
    expect(input.textKey("é", true)).toBe(true);
    expect(input.textKey("é", false)).toBe(true);
    expect(input.textKey("😀", true)).toBe(true);
    expect(log).toEqual(["text 0 é down f100", "text 0 é up f100", "text 0 😀 down f100"]);
  });

  it("types line breaks and tabs with their own keys", () => {
    const { log, input } = setup();
    input.textKey("\n", true);
    input.textKey("\t", true);
    expect(log).toEqual(["key 36 down f100", "key 48 down f100"]);
  });

  it("types nothing while an input method (or a source it can't read) would compose from the A key, but still lets go (M16)", () => {
    const { s, log, input } = setup();
    expect(input.textKey("a", true)).toBe(true);
    s.layoutSource = false;
    expect(input.textKey("a", false)).toBe(true);
    expect(input.textKey("あ", true)).toBe(false);
    expect(input.textKey("\n", true)).toBe(false);
    s.layoutSource = null;
    expect(input.textKey("b", true)).toBe(false);
    expect(log).toEqual(["text 0 a down f100", "text 0 a up f100"]);
  });

  it("refuses control characters, several characters, and anything under Command, Control or Option", () => {
    const { log, input } = setup();
    expect(input.textKey("\u0007", true)).toBe(false);
    expect(input.textKey("ab", true)).toBe(false);
    input.keysym(input.keysymOf("Super_L"), true);
    expect(input.textKey("a", true)).toBe(false); // the A key under Command is Select All
    expect(log).toEqual(["key 55 down f100108"]);
  });
});

describe("the macOS pointer", () => {
  it("moves, and drags while a button is held", () => {
    const { log, input } = setup();
    input.move(10.4, 20.6);
    input.button(1, true);
    input.move(30, 40);
    input.button(1, false);
    input.button(3, true);
    input.move(50, 60);
    expect(log).toEqual([
      "mouse 5 10,21 b0 c0 f100", "mouse 1 10,21 b0 c1 f100", "mouse 6 30,40 b0 c1 f100", "mouse 2 30,40 b0 c1 f100",
      "mouse 3 30,40 b1 c1 f100", "mouse 7 50,60 b1 c1 f100",
    ]);
  });

  it("maps X's middle, back and forward buttons to CoreGraphics' other buttons", () => {
    const { log, input } = setup();
    for (const b of [2, 8, 9]) { input.button(b, true); input.button(b, false); }
    expect(log.map(l => l.split(" ").slice(0, 2).concat(l.split(" ")[3]!).join(" "))).toEqual([
      "mouse 25 b2", "mouse 26 b2", "mouse 25 b3", "mouse 26 b3", "mouse 25 b4", "mouse 26 b4",
    ]);
  });

  it("turns two quick presses at the same spot into a double click", () => {
    const { log, input, clock } = setup();
    input.button(1, true); input.button(1, false);
    clock.advance(100);
    input.button(1, true); input.button(1, false);
    clock.advance(DOUBLE_CLICK_MS + 1);
    input.button(1, true); input.button(1, false);
    expect(log.map(l => l.split(" ")[4])).toEqual(["c1", "c1", "c2", "c2", "c1", "c1"]);
  });

  it("scrolls one notch per wheel press, in lines, and never holds the wheel", () => {
    const { log, input } = setup();
    for (const b of [4, 5, 6, 7]) { input.button(b, true); input.button(b, false); }
    input.releaseAll();
    expect(log).toEqual(["scroll 3,0 f100", "scroll -3,0 f100", "scroll 0,3 f100", "scroll 0,-3 f100"]);
  });

  it("doesn't press where it can't tell the pointer is", () => {
    const { s, log, input } = setup();
    s.pointer = null;
    input.button(1, true);
    expect(log).toEqual([]);
  });

  it("says its posted moves land a little later, so CursorBorrow allows for the previous step (L5)", () => {
    expect(setup().input.pointerLags).toBe(true);
  });

  it("reports the pointer with X's button and modifier mask bits", () => {
    const { s, input } = setup();
    s.buttons = new Set([0, 2]);
    s.flags = 0x20000 | 0x100000;
    expect(input.pointerState()).toEqual({ x: 400, y: 300, mask: 256 | 512 | 1 | 64 });
    expect(input.pointer()).toEqual({ x: 400, y: 300 });
  });

  it("knows which points are on a display, also left of the main one", () => {
    const { input } = setup();
    expect(input.onScreen(-100, 200)).toBe(true);
    expect(input.onScreen(-100, 50)).toBe(false);
    expect(input.onScreen(NaN, 1)).toBe(false);
    expect(input.screenSize()).toEqual({ width: 1440, height: 900 });
  });
});

describe("letting go on macOS", () => {
  it("releases ordinary keys first, then modifiers, then text keys and buttons", () => {
    const { log, input } = setup();
    input.textKey("é", true);
    input.keysym(input.keysymOf("Control_L"), true);
    input.keycode(0x01 + 8, true);
    input.button(1, true);
    log.length = 0;
    input.releaseAll();
    expect(log).toEqual(["key 1 up f40101", "key 59 up f100", "text 0 é up f100", "mouse 2 400,300 b0 c1 f100"]);
    log.length = 0;
    input.releaseAll();
    expect(log).toEqual([]);
  });

  it("lets go at process exit, and close() lets go, stops listening for exit and does nothing after", () => {
    const { s, log, input, exits, unregistered } = setup();
    input.keysym(input.keysymOf("Shift_L"), true);
    exits[0]!();
    expect(log.at(-1)).toBe("key 56 up f100");
    input.keysym(input.keysymOf("Shift_L"), true);
    input.close();
    expect(log.slice(-2)).toEqual(["key 56 up f100", "close"]);
    expect(unregistered()).toBe(1);
    expect(s.calls).toContain("dispose");
    expect(input.blockedReason(101)).toBeNull();
    input.move(1, 1);
    input.button(1, true);
    expect(input.keysym(input.keysymOf("a"), true)).toBe(false);
    expect(input.textKey("a", true)).toBe(false);
    expect([input.pointer(), input.keysDown(), input.focusedWindow(), input.findWindow("notes.txt", 500)]).toEqual([null, [], 0, 0]);
    expect(log.at(-1)).toBe("close");
    input.close();
    expect(unregistered()).toBe(1);
  });
});

describe("macOS windows for input", () => {
  it("finds a window by its AX title, with XInput's rules", () => {
    const { input } = setup();
    expect(input.findWindow("notes.txt", 500)).toBe(101);
    expect(input.findWindow("oth", 500)).toBe(103);
    expect(input.findWindow("Downloads")).toBe(0); // Finder's other window can't be read over AX: it might match too
    expect(input.findWindow("notes.txt", 999, "textedit")).toBe(101);
    expect(input.findWindow("")).toBe(0);
  });

  it("reports the focused window, and Ember's own focused window from Electron", () => {
    expect(setup().input.focusedWindow()).toBe(101);
    const { input } = setup({ focusedOwnWindow: () => ({ getMediaSourceId: () => "window:900:0", getNativeWindowHandle: () => Buffer.alloc(8) }) });
    expect(input.focusedWindow()).toBe(900);
    expect(input.activeWindow()).toBe(101);
  });

  it("brings another app's window to the front, but not one that already has the keyboard or is Ember's", () => {
    const { s, input } = setup();
    input.activate(101);
    input.activate(900);
    input.activate(777);
    expect(s.calls).toEqual([]);
    input.activate(103);
    expect(s.calls).toEqual(["raise 500 103"]);
  });

  it("knows whether a click at the pointer lands in the window", () => {
    const { s, input } = setup();
    expect(input.pointerOn(101)).toBe(true);
    s.pointer = { x: 220, y: 170 };
    expect(input.pointerOn(101)).toBe(true); // TextEdit's own menu
    expect(input.pointerOn(104)).toBe(false);
    s.pointer = null;
    expect(input.pointerOn(101)).toBe(false);
  });
});

describe("why input can't reach a window on macOS", () => {
  it("names the Accessibility permission when Ember isn't trusted", () => {
    const { s, input } = setup();
    expect(input.blockedReason(101)).toBeNull();
    s.trusted = false;
    expect(input.blockedReason(101)).toBe(ACCESSIBILITY_REASON);
    expect(ACCESSIBILITY_REASON).toBe("Ember needs the Accessibility permission (System Settings › Privacy & Security › Accessibility) to use the mouse and keyboard.");
  });

  it("stops for secure keyboard entry held by any app, the target's own password field included", () => {
    const { s, input } = setup();
    s.secure = true;
    s.secureInputPid = 500; // TextEdit, the target: its password field would get Ember's keys
    expect(input.blockedReason(101)).toMatch(/^Secure keyboard entry is on in TextEdit \(/);
    expect(input.keyboardGrabbed(101)).toBe(true);
    s.secureInputPid = 600;
    expect(input.blockedReason(101)).toMatch(/^Secure keyboard entry is on in Finder \(/);
    expect(input.keyboardGrabbed(101)).toBe(true);
    s.secureInputPid = null;
    expect(input.blockedReason(101)).toMatch(/^Secure keyboard entry is on \(/);
    expect(input.keyboardGrabbed()).toBe(true);
    s.secure = false;
    expect(input.blockedReason(101)).toBeNull();
    expect(input.keyboardGrabbed(101)).toBe(false);
  });

  it("goes by the session's secure-input pid when IsSecureEventInputEnabled can't be called (M18)", () => {
    const { s, input, warned } = setup();
    s.secure = null;
    expect(input.blockedReason(101)).toBeNull();
    s.secureInputPid = 600;
    expect(input.blockedReason(101)).toMatch(/^Secure keyboard entry is on in Finder \(/);
    expect(input.keyboardGrabbed(101)).toBe(true);
    expect(warned).toEqual([]);
  });

  it("won't use the keyboard when it can't tell whether a password is being typed, and logs that once (M18)", () => {
    const { s, input, warned } = setup();
    s.secure = null;
    s.sessionReadable = false;
    expect(input.blockedReason(101)).toBe(SECURE_INPUT_UNKNOWN_REASON);
    expect(SECURE_INPUT_UNKNOWN_REASON).toBe("Ember can't tell whether a password is being typed, so it won't use the keyboard.");
    expect(input.keyboardGrabbed(101)).toBe(true);
    expect(warned).toEqual(['platform.secure_input_unknown {"part":"input"}']);
  });

  it("refuses without Input Monitoring, as it might not see the user take over the keyboard (M3, Q10)", () => {
    const { s, input } = setup();
    s.listen = false;
    expect(input.blockedReason(101)).toBe(INPUT_MONITORING_REASON);
    // It stops the mouse too, and says so (review #65).
    expect(INPUT_MONITORING_REASON).toBe("Ember needs Input Monitoring (System Settings › Privacy & Security › Input Monitoring) to notice when you take over the keyboard, so it won't use the mouse or keyboard without it.");
    s.listen = null; // a macOS without the call has no such permission
    expect(input.blockedReason(101)).toBeNull();
  });

  it("refuses typing, not the mouse, while the input source is an input method or can't be read (M16, review #65)", () => {
    const { s, input } = setup();
    const SUPER_L = 0xffeb, CONTROL_L = 0xffe3, ALT_L = 0xffe9, SHIFT_L = 0xffe1;
    s.layoutSource = false;
    expect(input.blockedReason(101)).toBeNull();
    expect(input.keyboardBlockedReason()).toBe(INPUT_METHOD_REASON);
    expect(INPUT_METHOD_REASON).toBe("An input method (Japanese, Pinyin, Korean…) is selected, so Ember won't type with the keyboard: switch to a keyboard layout, or let Ember fill the field directly.");
    // A key that types a character is composed; Shift alone doesn't change that.
    for (const sym of [ch("a"), ch("1"), ch(" "), ch("/"), 0xffb1 /* KP_1 */]) expect(input.keyboardBlockedReason({ modifiers: [], sym })).toBe(INPUT_METHOD_REASON);
    expect(input.keyboardBlockedReason({ modifiers: [SHIFT_L], sym: ch("A") })).toBe(INPUT_METHOD_REASON);
    // Command, Control or Option make it a shortcut, and keys that type nothing are never composed.
    for (const mod of [SUPER_L, CONTROL_L, ALT_L]) expect(input.keyboardBlockedReason({ modifiers: [mod], sym: ch("s") })).toBeNull();
    for (const sym of [0xff0d /* Return */, 0xff1b /* Escape */, 0xff09 /* Tab */, 0xff54 /* Down */, 0xffc2 /* F5 */, 0xffff /* Delete */]) {
      expect(input.keyboardBlockedReason({ modifiers: [], sym })).toBeNull();
    }
    s.layoutSource = null;
    expect(input.blockedReason(101)).toBeNull();
    expect(input.keyboardBlockedReason()).toBe(INPUT_SOURCE_UNKNOWN_REASON);
    expect(INPUT_SOURCE_UNKNOWN_REASON).toBe("Ember can't tell whether an input method is in use, so it won't type with the keyboard.");
    s.layoutSource = true;
    expect(input.keyboardBlockedReason()).toBeNull();
    expect(input.keyboardBlockedReason({ modifiers: [], sym: ch("a") })).toBeNull();
  });

  it("names the most basic missing piece first: Accessibility, then secure input, Input Monitoring", () => {
    const { s, input } = setup();
    s.trusted = false;
    s.secure = true;
    s.listen = false;
    s.layoutSource = false;
    expect(input.blockedReason(101)).toBe(ACCESSIBILITY_REASON);
    s.trusted = true;
    expect(input.blockedReason(101)).toMatch(/^Secure keyboard entry is on/);
    s.secure = false;
    expect(input.blockedReason(101)).toBe(INPUT_MONITORING_REASON);
    s.listen = true;
    expect(input.blockedReason(101)).toBeNull(); // an input method stops only typing (review #65)
  });

  it("sees a locked session or a sleeping display", () => {
    const { s, input } = setup();
    expect(input.screenLocked()).toBe(false);
    s.locked = true;
    expect(input.screenLocked()).toBe(true);
    s.locked = false;
    s.asleep = true;
    expect(input.screenLocked()).toBe(true);
  });
});

describe("CursorBorrow on macOS input", () => {
  const fast = { idleMs: 0, sleep: () => Promise.resolve(), window: 101 };

  it("presses Command with AZERTY's own a key for super+a, and types through textKey whatever the layout", async () => {
    const { log, input } = setup();
    await new CursorBorrow(input).borrow(async hand => {
      await hand.keys("super+a");
      await hand.type("He");
    }, fast);
    // Off Linux the borrow types each character with the backend's textKey (design §4.8), not the layout's keys.
    expect(log.filter(l => /^(key|text)/.test(l))).toEqual([
      "key 55 down f100108", "key 12 down f100108", "key 12 up f100108", "key 55 up f100",
      "text 0 H down f100", "text 0 H up f100", "text 0 e down f100", "text 0 e up f100",
    ]);
  });

  it("brings the window to the front first, glides, clicks and scrolls there", async () => {
    const { s, log, input } = setup();
    await new CursorBorrow(input).borrow(async hand => {
      await hand.glideTo(420, 310);
      await hand.click();
      await hand.scroll("down", 2);
    }, { ...fast, window: 103 });
    expect(s.calls).toContain("raise 500 103");
    const kinds = log.map(l => l.split(" ").slice(0, 2).join(" "));
    expect(kinds).toContain("mouse 1");
    expect(kinds).toContain("mouse 2");
    expect(log.filter(l => l.startsWith("scroll"))).toEqual(["scroll -3,0 f100", "scroll -3,0 f100"]);
    expect(s.pointer).toEqual({ x: 400, y: 300 }); // glided home afterwards
  });

  it("under an input method still clicks, scrolls and presses Command shortcuts, and refuses typing before any key (review #65)", async () => {
    const { s, log, input } = setup();
    s.layoutSource = false;
    const b = new CursorBorrow(input);
    await b.borrow(async hand => {
      await hand.glideTo(420, 310);
      await hand.click();
      await hand.scroll("down", 1);
      await hand.keys("super+a");
      await hand.keys("Return");
    }, fast);
    const kinds = log.map(l => l.split(" ").slice(0, 2).join(" "));
    expect(kinds).toContain("mouse 1");
    expect(log).toContain("scroll -3,0 f100");
    expect(log.filter(l => l.startsWith("key 12 down"))).toHaveLength(1); // AZERTY's a, with Command
    log.length = 0;
    for (const act of [(h: Hand) => h.type("Hi"), (h: Hand) => h.keys("a"), async (h: Hand) => h.checkTyping("Hi")]) {
      await expect(b.borrow(act, fast)).rejects.toThrow(INPUT_METHOD_REASON);
    }
    expect(log.filter(l => /^(key|text)/.test(l))).toEqual([]);
  });

  it("keeps the layout's Command-level answer for a digit shortcut (review #63 changes Windows and Linux only)", async () => {
    // On this AZERTY "1" is the shifted level of key 0x12 with Command held too, so Command+1 takes Shift here.
    const { log, input } = setup();
    await new CursorBorrow(input, { keys: KEYS.darwin }).borrow(hand => hand.keys("cmd+1"), fast);
    expect(log.filter(l => l.startsWith("key")).map(l => l.split(" ").slice(1, 3).join(" "))).toEqual(["55 down", "56 down", "18 down", "18 up", "56 up", "55 up"]);
  });

  it("refuses a shortcut whose key the layout doesn't have, pressing nothing", async () => {
    const { log, input } = setup();
    const err = await new CursorBorrow(input).borrow(hand => hand.keys("super+z"), fast).catch(e => e);
    expect(String(err)).toMatch(/can't press super\+z/);
    expect(log.filter(l => l.startsWith("key"))).toEqual([]);
  });
});
