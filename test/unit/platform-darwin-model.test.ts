/**
 * The macOS window logic over CGWindowList entries: which entries are kept, the X11-shaped stack (bottom to top,
 * menus and the Dock as popups that still cover), the apps' open windows, the front window of an app, AX windows
 * mapped to CGWindowIDs, where a click lands, finding a window by title with XInput's rules, own-window ids from
 * Electron's media source id, the security prompts' owners, secure input from its two signals, app bundles from
 * executables, and GetKeys' KeyMap.
 */

import { describe, expect, it } from "vitest";
import {
  OVERLAY_TITLE, SECURITY_OWNERS, axWindowId, bundleOf, clientWindowsOf, findWindowIn, frontWindowOf, keysInMap, ownFrontWindow,
  dockTitled, isDockItself, parseMediaSourceId, pointerLandsOn, processName, sameFrame, secureInputState, stackOf, unionRect, windowEntry,
  withDockStrip, type CGWindowEntry, type RawWindowInfo, type TitledWindow,
} from "../../app/main/platform/darwin/model";

const OWN = 4242;
const w = (id: number, pid: number, owner: string, title: string, x: number, y: number, width: number, height: number, layer = 0, alpha = 1): CGWindowEntry =>
  ({ id, pid, owner, title, bounds: { x, y, width, height }, layer, alpha });

/** Front to back, as CGWindowListCopyWindowInfo lists them. */
const LIST: CGWindowEntry[] = [
  w(900, OWN, "Ember", OVERLAY_TITLE, 0, 0, 1440, 900, 1000),
  w(120, 500, "TextEdit", "", 210, 160, 220, 120, 101), // TextEdit's open menu
  w(101, 500, "TextEdit", "notes.txt", 100, 100, 600, 400),
  w(103, 500, "TextEdit", "Other", 150, 150, 500, 300),
  w(104, 600, "Finder", "Downloads", 50, 50, 800, 500),
  w(105, 700, "Dock", "", 0, 850, 1440, 50, 20),
  w(106, 800, "Window Server", "Menubar", 0, 0, 1440, 24),
  w(107, 900, "Ghost", "", 0, 0, 100, 100, 0, 0),
  w(108, 901, "Tiny", "", 5, 5, 1, 1),
];

const raw = (o: Partial<RawWindowInfo>): RawWindowInfo => ({
  number: 7, pid: 70, owner: "App", name: "Title", bounds: { x: 1, y: 2, width: 3, height: 4 }, layer: 0, alpha: 1, ...o,
});

describe("reading a CGWindowList entry", () => {
  it("keeps a complete entry as it is", () => {
    expect(windowEntry(raw({}))).toEqual({ id: 7, pid: 70, owner: "App", title: "Title", bounds: { x: 1, y: 2, width: 3, height: 4 }, layer: 0, alpha: 1 });
  });
  it("drops an entry without a usable number, owner pid or bounds", () => {
    for (const bad of [{ number: null }, { number: 0 }, { number: 1.5 }, { number: 2 ** 32 }, { pid: null }, { pid: 0 }, { bounds: null },
      { bounds: { x: 0, y: 0, width: -1, height: 1 } }, { bounds: { x: NaN, y: 0, width: 1, height: 1 } }]) {
      expect(windowEntry(raw(bad))).toBeNull();
    }
  });
  it("takes a missing title or owner as empty, and a missing layer or alpha the cautious way (covers, not an app window)", () => {
    const e = windowEntry(raw({ owner: null, name: null, layer: null, alpha: null }))!;
    expect(e).toMatchObject({ owner: "", title: "", layer: 1, alpha: 1 });
  });
});

describe("the stack, as X11 gives it", () => {
  it("lists drawn windows bottom to top, without fully transparent or one-point windows", () => {
    expect(stackOf(LIST).map(s => s.id)).toEqual([106, 105, 104, 103, 101, 120, 900]);
  });
  it("uses the window id as client, the owner as wmClass, and the bounds as outer and inner", () => {
    const s = stackOf(LIST).find(x => x.id === 101)!;
    expect(s).toEqual({
      id: 101, client: 101, pid: 500, title: "notes.txt", wmClass: "TextEdit", x: 100, y: 100, width: 600, height: 400,
      outer: { x: 100, y: 100, width: 600, height: 400 }, inner: { x: 100, y: 100, width: 600, height: 400 }, overrideRedirect: false,
    });
  });
  it("marks everything off layer 0 (menus, the Dock, Ember's overlay) as a popup", () => {
    const popups = stackOf(LIST).filter(s => s.overrideRedirect).map(s => s.id);
    expect(popups).toEqual([105, 120, 900]);
  });
});

describe("the apps' open windows", () => {
  it("lists drawn normal windows front first, leaving out the system's own processes", () => {
    expect(clientWindowsOf(LIST).map(c => [c.id, c.wmClass, c.wmClassName])).toEqual([
      [101, "TextEdit", "TextEdit"], [103, "TextEdit", "TextEdit"], [104, "Finder", "Finder"],
    ]);
  });
  it("finds an app's front window, or the front window of any app", () => {
    expect(frontWindowOf(LIST, 500)?.id).toBe(101);
    expect(frontWindowOf(LIST, 600)?.id).toBe(104);
    expect(frontWindowOf(LIST, 999)).toBeNull();
    expect(frontWindowOf(LIST)?.id).toBe(101); // the overlay and the menu aren't normal windows
    // Without a pid, a system process's normal window (Control Center, the Dock…) isn't anyone's front window.
    const withSystem = [w(700, 77, "Control Center", "", 0, 0, 400, 300), ...LIST];
    expect(frontWindowOf(withSystem)?.id).toBe(101);
    expect(frontWindowOf(withSystem, 77)?.id).toBe(700);
  });
  it("finds Ember's own front window, never its click-through overlay", () => {
    expect(ownFrontWindow(LIST, OWN)).toBeNull();
    const withAsk = [w(950, OWN, "Ember", "Ask Ember", 400, 300, 560, 92, 1000), ...LIST];
    expect(ownFrontWindow(withAsk, OWN)?.id).toBe(950);
    const withHome = [...withAsk, w(960, OWN, "Ember", "Ember", 200, 200, 800, 600)];
    expect(ownFrontWindow(withHome, OWN)?.id).toBe(960); // a normal window first
  });
});

describe("AX windows and CGWindowIDs", () => {
  it("takes the id AX gave", () => {
    expect(axWindowId({ id: 103, title: "", frame: null }, LIST, 500)).toBe(103);
  });
  it("otherwise matches the process's one window with the same frame (within a point)", () => {
    expect(axWindowId({ id: 0, title: "x", frame: { x: 100.4, y: 99.6, width: 600, height: 400 } }, LIST, 500)).toBe(101);
    expect(axWindowId({ id: 0, title: "x", frame: { x: 100, y: 100, width: 600, height: 400 } }, LIST, 600)).toBe(0);
  });
  it("breaks a tie by title, and gives no id when the tie stays", () => {
    const twins = [w(1, 5, "A", "One", 0, 0, 10, 10), w(2, 5, "A", "Two", 0, 0, 10, 10)];
    expect(axWindowId({ id: 0, title: "Two", frame: { x: 0, y: 0, width: 10, height: 10 } }, twins, 5)).toBe(2);
    expect(axWindowId({ id: 0, title: "", frame: { x: 0, y: 0, width: 10, height: 10 } }, twins, 5)).toBe(0);
  });
  it("compares frames edge by edge", () => {
    expect(sameFrame({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: -1, width: 11, height: 9 })).toBe(true);
    expect(sameFrame({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 12, height: 10 })).toBe(false);
    expect(sameFrame(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
  });
});

describe("where a click lands", () => {
  it("lands in the window on top at that spot, past Ember's click-through overlay", () => {
    expect(pointerLandsOn(LIST, 400, 300, 101, OWN)).toBe(true);
    expect(pointerLandsOn(LIST, 400, 300, 104, OWN)).toBe(false);
  });
  it("counts a menu the same app opened over the window as the app's own", () => {
    expect(pointerLandsOn(LIST, 220, 170, 101, OWN)).toBe(true);
    expect(pointerLandsOn(LIST, 220, 170, 104, OWN)).toBe(false);
  });
  it("doesn't land in the window under the menu bar, the Dock or another of Ember's windows", () => {
    expect(pointerLandsOn(LIST, 120, 10, 101, OWN)).toBe(false);
    expect(pointerLandsOn(LIST, 120, 860, 104, OWN)).toBe(false);
    const withAsk = [w(950, OWN, "Ember", "Ask Ember", 380, 280, 100, 50, 1000), ...LIST];
    expect(pointerLandsOn(withAsk, 400, 300, 101, OWN)).toBe(false);
  });
  it("passes over the Dock's own display-covering window outside its strip, and only when AX gave the strip", () => {
    // macos-15 at rest: the Dock's own window, titled "Dock", over the whole display above every app (CI run 120).
    const dock = w(7, 700, "Dock", "Dock", 0, 0, 1440, 900, 20);
    const list = [dock, ...LIST.filter(e => e.owner !== "Dock")];
    expect(pointerLandsOn(list, 400, 300, 101, OWN)).toBe(false);
    const strip = { x: 300, y: 830, width: 840, height: 70 };
    const cut = withDockStrip(list, strip);
    expect(cut[0]).toEqual({ ...dock, bounds: strip });
    expect(pointerLandsOn(cut, 400, 300, 101, OWN)).toBe(true);
    expect(pointerLandsOn(cut, 400, 850, 104, OWN)).toBe(false);
    // AX can't tell: the whole display stays covered.
    expect(withDockStrip(list, null)).toEqual(list);
    // Another display's Dock window doesn't meet the strip: it goes.
    expect(withDockStrip([w(8, 700, "Dock", "Dock", 1440, 0, 1920, 1080, 20)], strip)).toEqual([]);
    // Mission Control's untitled window at the Dock's level, beside the titled Dock: not cut, it still covers.
    const mc = w(64, 700, "Dock", "", 0, 0, 1440, 900, 20);
    const up = withDockStrip([mc, dock, ...LIST.filter(e => e.owner !== "Dock")], strip);
    expect(up.slice(0, 2)).toEqual([mc, { ...dock, bounds: strip }]);
    expect(pointerLandsOn(up, 400, 300, 101, OWN)).toBe(false);
    // Without titles (no Screen Recording) the level is all there is: both are taken for the Dock and cut.
    expect(withDockStrip([{ ...mc }, { ...dock, title: "" }], strip).map(e => e.bounds)).toEqual([strip, strip]);
  });

  it("tells the Dock's own window from Mission Control's by its level, or by its title", () => {
    expect(isDockItself(w(7, 700, "Dock", "", 0, 0, 1440, 900, 20))).toBe(true);
    expect(isDockItself(w(7, 700, "Dock", "Dock", 0, 0, 1440, 900, 25))).toBe(true);
    expect(isDockItself(w(9, 700, "Dock", "", 0, 0, 1440, 900, 18))).toBe(false);
    expect(isDockItself(w(9, 701, "TextEdit", "Dock", 0, 0, 100, 100, 20))).toBe(false);
    // Titles read (a window of the Dock's is titled "Dock"): an untitled one at its level is something else it draws.
    expect(isDockItself(w(64, 700, "Dock", "", 0, 0, 1440, 900, 20), true)).toBe(false);
    expect(isDockItself(w(7, 700, "Dock", "Dock", 0, 0, 1440, 900, 20), true)).toBe(true);
    expect(dockTitled([w(64, 700, "Dock", "", 0, 0, 1440, 900, 20), w(7, 700, "Dock", "Dock", 0, 0, 1440, 900, 20)])).toBe(true);
    expect(dockTitled([w(64, 700, "Dock", "", 0, 0, 1440, 900, 20), w(9, 701, "TextEdit", "Dock", 0, 0, 100, 100, 0)])).toBe(false);
  });

  it("lands in the element's own window when the caller says the element is there", () => {
    expect(pointerLandsOn(LIST, 120, 120, 103, OWN)).toBe(false);
    expect(pointerLandsOn(LIST, 120, 120, 103, OWN, 101)).toBe(true);
  });
  it("is false for a window that isn't on screen", () => {
    expect(pointerLandsOn(LIST, 400, 300, 777, OWN)).toBe(false);
  });
});

describe("finding a window by title, with XInput's rules", () => {
  const all: TitledWindow[] = [
    { id: 1, pid: 10, owner: "TextEdit", title: "Report.txt" },
    { id: 2, pid: 10, owner: "TextEdit", title: "Report.txt — Edited" },
    { id: 3, pid: 20, owner: "Pages", title: "Report.txt" },
    { id: 4, pid: 30, owner: "Notes", title: "Shopping" },
  ];
  it("prefers the process's exact title, then a unique title containing it (any case)", () => {
    expect(findWindowIn(all, "Report.txt", 10)).toBe(1);
    expect(findWindowIn(all, "edited", 10)).toBe(2);
    expect(findWindowIn(all, "report", 10)).toBe(0); // both of its windows contain it
  });
  it("without the process, only an exact title counts, and it must be the only one", () => {
    expect(findWindowIn(all, "Report.txt")).toBe(0);
    expect(findWindowIn(all, "Shopping")).toBe(4);
    expect(findWindowIn(all, "Shop")).toBe(0);
    expect(findWindowIn(all, "Report.txt", undefined, "pages")).toBe(3);
    expect(findWindowIn(all, "Report.txt", 99, "textedit")).toBe(1); // a pid with no window here: the exact title in that app
  });
  it("won't answer when a window whose title couldn't be read might also match", () => {
    const unknown: TitledWindow[] = [...all, { id: 5, pid: 30, owner: "Notes", title: null }];
    expect(findWindowIn(unknown, "Shopping")).toBe(0);
    expect(findWindowIn(unknown, "Shopping", 30)).toBe(0);
    expect(findWindowIn(unknown, "Report.txt", 10)).toBe(1); // another app's unknown title doesn't matter
    expect(findWindowIn(unknown, "Report.txt", undefined, "pages")).toBe(3);
  });
  it("finds nothing for an empty title", () => {
    expect(findWindowIn(all, "")).toBe(0);
  });
});

describe("Ember's own window ids", () => {
  it("reads the CGWindowID from Electron's media source id", () => {
    expect(parseMediaSourceId("window:12345:0")).toBe(12345);
    expect(parseMediaSourceId("window:4294967295:0")).toBe(4294967295);
  });
  it("gives 0 for anything else", () => {
    for (const bad of ["screen:1:0", "window:0:0", "window:abc:0", "window:4294967296:0", "window:12", "", null, undefined, 7]) {
      expect(parseMediaSourceId(bad)).toBe(0);
    }
  });
});

describe("the screen's extent", () => {
  it("joins displays, also ones left of or above the main display", () => {
    expect(unionRect([{ x: 0, y: 0, width: 1440, height: 900 }, { x: -1280, y: -200, width: 1280, height: 800 }])).toEqual({ x: -1280, y: -200, width: 2720, height: 1100 });
    expect(unionRect([])).toBeNull();
    expect(unionRect([{ x: 0, y: 0, width: 0, height: 10 }])).toBeNull();
  });
});

describe("the system's credential and consent prompts (M17)", () => {
  it("names every owner whose window takes credentials or consent", () => {
    expect([...SECURITY_OWNERS].sort()).toEqual([
      "AuthenticationServicesAgent", "CoreServicesUIAgent", "ScreenSaverEngine", "SecurityAgent", "UserNotificationCenter",
      "coreautha", "coreauthd", "universalAccessAuthWarn",
    ]);
  });

  it("knows them, Keychain Access and Passwords by SECURITY_APP.darwin (any case, other languages, bundle ids), but not loginwindow or an app", () => {
    for (const owner of ["SecurityAgent", "securityagent", "Keychain Access", "Schlüsselbundverwaltung", "com.apple.keychainaccess", "Passwords", "UserNotificationCenter"]) {
      expect(SECURITY_OWNERS.has(owner), owner).toBe(true);
    }
    for (const owner of ["loginwindow", "com.apple.loginwindow", "TextEdit", "Finder", "Dock", "Ember", ""]) expect(SECURITY_OWNERS.has(owner), owner).toBe(false);
  });
});

describe("secure keyboard entry from its two signals (M18)", () => {
  it("goes by IsSecureEventInputEnabled when it answers, naming the session's holder only while it is on", () => {
    expect(secureInputState(true, { secureInputPid: 88 })).toEqual({ on: true, pid: 88 });
    expect(secureInputState(true, null)).toEqual({ on: true, pid: null });
    expect(secureInputState(false, { secureInputPid: 88 })).toEqual({ on: false, pid: null });
  });

  it("goes by the session's secure-input pid when the call can't be made, and can't tell without either", () => {
    expect(secureInputState(null, { secureInputPid: 88 })).toEqual({ on: true, pid: 88 });
    expect(secureInputState(null, { secureInputPid: null })).toEqual({ on: false, pid: null });
    expect(secureInputState(null, null)).toEqual({ on: null, pid: null });
  });
});

describe("app bundles and process names", () => {
  it("finds the innermost app bundle above an executable, and none outside one", () => {
    expect(bundleOf("/System/Applications/TextEdit.app/Contents/MacOS/TextEdit")).toBe("/System/Applications/TextEdit.app");
    expect(bundleOf("/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator"))
      .toBe("/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app");
    expect(bundleOf("/Applications/My Tools/Some App.app/Contents/MacOS/Some App")).toBe("/Applications/My Tools/Some App.app");
    expect(bundleOf("/usr/local/bin/pinentry")).toBeNull();
    expect(bundleOf("/.app/x")).toBeNull();
    expect(bundleOf("relative/Thing.app/Contents/MacOS/Thing")).toBeNull();
    expect([bundleOf(""), bundleOf(null)]).toEqual([null, null]);
  });

  it("names a process by its bundle, else by its file", () => {
    expect(processName("/Applications/1Password.app/Contents/MacOS/1Password")).toBe("1Password");
    expect(processName("/usr/local/bin/pinentry-mac")).toBe("pinentry-mac");
    expect(processName(null)).toBe("");
  });
});

describe("GetKeys' KeyMap", () => {
  it("reads key k from bit k & 7 of byte k >> 3", () => {
    const map = Buffer.alloc(16);
    map[0] = 0b1000_0001;
    map[6] = 0b0000_0010;
    map[15] = 0b1000_0000;
    expect(keysInMap(map)).toEqual([0, 7, 49, 127]);
    expect(keysInMap(Buffer.alloc(16))).toEqual([]);
  });
});
