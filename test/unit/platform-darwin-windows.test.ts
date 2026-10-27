/**
 * The macOS window system over a stand-in DarwinDesktop: points throughout (DIP is the identity), X's button mask,
 * the stack bottom to top, the active and focused windows (Ember's own focused panel answered without AX, AX never
 * asked about Ember's process, titles from AX when Screen Recording is missing), the apps' open windows, capture that
 * fails closed, own-window ids from media source ids, system dialogs (every credential or consent prompt's owner, and
 * secure keyboard entry, which fails closed when it can't be checked), the holder of secure input, Input Monitoring,
 * and nothing after close().
 */

import { describe, expect, it, vi } from "vitest";
import { createDarwinWindows, type DarwinWindowsDeps } from "../../app/main/platform/darwin/windows";
import type { DarwinDesktop } from "../../app/main/platform/darwin/desktop";
import { OVERLAY_TITLE, type AXWindowInfo, type CGWindowEntry } from "../../app/main/platform/darwin/model";
import type { Rect, X11Image } from "../../app/main/platform/types";

const OWN = 4242;
const w = (id: number, pid: number, owner: string, title: string, x: number, y: number, width: number, height: number, layer = 0, alpha = 1): CGWindowEntry =>
  ({ id, pid, owner, title, bounds: { x, y, width, height }, layer, alpha });

/** Front to back. TextEdit's titles are empty, as without the Screen Recording permission. */
const LIST = (): CGWindowEntry[] => [
  w(900, OWN, "Ember", OVERLAY_TITLE, 0, 0, 1440, 900, 1000),
  w(950, OWN, "Ember", "Ask Ember", 440, 300, 560, 92, 1000),
  w(120, 500, "TextEdit", "", 210, 160, 220, 120, 101),
  w(101, 500, "TextEdit", "", 100, 100, 600, 400),
  w(103, 500, "TextEdit", "", 150, 150, 500, 300),
  w(104, 600, "Finder", "Downloads", 50, 50, 800, 500),
  w(105, 700, "Dock", "", 0, 850, 1440, 50, 20),
];

function fakeDesktop() {
  const s = {
    windows: LIST(),
    pointer: { x: 300.6, y: 200.2 } as { x: number; y: number } | null,
    buttons: new Set<number>(),
    flags: 0,
    keys: new Set<number>(),
    frontmost: 500 as number | null,
    focused: new Map<number, AXWindowInfo>([[500, { id: 103, title: "Other", frame: { x: 150, y: 150, width: 500, height: 300 } }]]),
    axWindows: new Map<number, AXWindowInfo[] | null>([
      [500, [{ id: 101, title: "notes.txt", frame: null }, { id: 103, title: "Other", frame: null }]],
      [600, null],
    ]),
    trusted: true,
    secure: false as boolean | null,
    session: { locked: false, secureInputPid: null as number | null } as { locked: boolean; secureInputPid: number | null } | null,
    screenAccess: true,
    listen: true as boolean | null,
    calls: [] as string[],
  };
  const desktop: DarwinDesktop = {
    windows: () => s.windows,
    pointer: () => s.pointer,
    buttonDown: b => s.buttons.has(b),
    flags: () => s.flags,
    keyDown: k => s.keys.has(k),
    keysDown: () => [...s.keys],
    frontmostPid: () => (s.calls.push("frontmost"), s.frontmost),
    focusedWindow: pid => (s.calls.push(`focused ${pid}`), s.focused.get(pid) ?? null),
    appWindows: pid => (s.calls.push(`windows ${pid}`), s.axWindows.get(pid) ?? null),
    raise: () => true,
    trusted: () => s.trusted,
    secureInput: () => s.secure,
    session: () => s.session,
    screenAccess: () => s.screenAccess,
    listenAccess: () => s.listen,
    requestListenAccess: () => (s.calls.push("request listen"), s.listen),
    postAccess: () => true,
    inputSourceIsLayout: () => true,
    processPath: pid => (pid === 77 ? "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent" : null),
    mainDisplay: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    displaysAt: () => 1,
    displayAsleep: () => false,
    keyboardLayout: () => null,
  };
  return { s, desktop };
}

const screen = {
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }),
  getAllDisplays: () => [
    { bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
    { bounds: { x: -1280, y: -100, width: 1280, height: 800 }, scaleFactor: 1 },
  ],
};
const ownWindow = (id: string) => ({ getMediaSourceId: () => id, getNativeWindowHandle: () => Buffer.alloc(8, 0xff) });

function setup(deps: Partial<DarwinWindowsDeps> = {}) {
  const { s, desktop } = fakeDesktop();
  const warned: string[] = [];
  const ws = createDarwinWindows(desktop, { screen, log: { warn: (e, f) => warned.push(`${e} ${JSON.stringify(f)}`), info: () => undefined }, ...deps }, { ownPid: OWN });
  return { s, ws, warned };
}

describe("the macOS window system", () => {
  it("is a compositing window system whose compositor never comes and goes", () => {
    const { ws } = setup();
    expect(ws.kind).toBe("darwin");
    expect(ws.hasCompositor()).toBe(true);
    expect(ws.compositorMayChange).toBe(false);
  });

  it("reports the pointer in whole points with X's button mask", () => {
    const { s, ws } = setup();
    expect(ws.pointer()).toEqual({ x: 301, y: 200, mask: 0 });
    s.buttons = new Set([0, 1, 2]); // CG's left, right, centre
    expect(ws.pointer()!.mask).toBe(256 | 1024 | 512);
    s.buttons = new Set([1]);
    expect(ws.pointer()!.mask).toBe(1024);
    s.pointer = null;
    expect(ws.pointer()).toBeNull();
  });

  it("reads the chord held now from the session's flags and the space key", () => {
    const { s, ws } = setup();
    expect(ws.keysDown()).toEqual({ control: false, alt: false, space: false, shift: false, command: false });
    s.flags = 0x40000 | 0x20000 | 0x100000;
    s.keys = new Set([0x31]);
    expect(ws.keysDown()).toEqual({ control: true, alt: false, space: true, shift: true, command: true });
    s.flags = 0x80000;
    expect(ws.keysDown()!.alt).toBe(true);
  });

  it("gives the stack bottom to top, menus and Ember's floating windows as popups", () => {
    const { ws } = setup();
    const stack = ws.stack();
    expect(stack.map(x => x.id)).toEqual([105, 104, 103, 101, 120, 950, 900]);
    expect(stack.filter(x => x.overrideRedirect).map(x => x.id)).toEqual([105, 120, 950, 900]);
    expect(stack.every(x => x.client === x.id)).toBe(true);
  });

  it("converts nothing: points are Electron's DIP on macOS", () => {
    const { ws } = setup();
    expect(ws.toDip({ x: -5, y: 3.5, width: 10, height: 20 })).toEqual({ x: -5, y: 3.5, width: 10, height: 20 });
    expect(ws.toDipPoint({ x: -5, y: 7 })).toEqual({ x: -5, y: 7 });
  });

  it("measures the screen across every display, also one above and left of the main display", () => {
    const { ws } = setup();
    expect(ws.screenBounds()).toEqual({ x: -1280, y: -100, width: 2720, height: 1000 });
  });
});

describe("the active and focused windows on macOS", () => {
  it("makes the frontmost app's front window active, its title from AX when CGWindowList has none", () => {
    const { s, ws } = setup();
    s.focused.set(500, { id: 101, title: "notes.txt", frame: null });
    expect(ws.activeWindow()).toEqual({ id: 101, pid: 500, title: "notes.txt", x: 100, y: 100, width: 600, height: 400, wmClass: "TextEdit" });
  });

  it("doesn't ask AX for a title CGWindowList already gave", () => {
    const { s, ws } = setup();
    s.frontmost = 600;
    expect(ws.activeWindow()).toMatchObject({ id: 104, title: "Downloads", wmClass: "Finder" });
    expect(s.calls).toEqual(["frontmost"]);
  });

  it("follows AX to the focused window, which may not be the front one", () => {
    const { ws } = setup();
    expect(ws.focusWindow()).toMatchObject({ id: 103, pid: 500, title: "Other" });
  });

  it("matches the focused window by frame when AX gives no window id", () => {
    const { s, ws } = setup();
    s.focused.set(500, { id: 0, title: "Other", frame: { x: 150, y: 150, width: 500, height: 300 } });
    expect(ws.focusWindow()?.id).toBe(103);
  });

  it("reports no focused window when AX names one that isn't on screen, rather than guessing the front one", () => {
    const { s, ws } = setup();
    s.focused.set(500, { id: 4444, title: "Sheet", frame: null });
    expect(ws.focusWindow()).toBeNull();
    s.focused.set(500, { id: 0, title: "Panel", frame: { x: 1, y: 2, width: 3, height: 4 } });
    expect(ws.focusWindow()).toBeNull();
    expect(ws.activeWindow()?.id).toBe(101); // the active window is still the app's front one
  });

  it("falls back to the app's front window when AX can't name a focused window", () => {
    const { s, ws } = setup();
    s.focused.delete(500);
    expect(ws.focusWindow()?.id).toBe(101);
  });

  it("answers for Ember's own focused panel from Electron, without asking AX anything", () => {
    const { s, ws } = setup({ focusedOwnWindow: () => ownWindow("window:950:0") });
    expect(ws.focusWindow()).toEqual({ id: 950, pid: OWN, title: "Ask Ember", x: 440, y: 300, width: 560, height: 92, wmClass: "Ember" });
    expect(s.calls).toEqual([]);
    // The panel doesn't make Ember the active app: the user's app stays active.
    expect(ws.activeWindow()?.id).toBe(101);
  });

  it("still gives Ember's window id when Electron's focused window isn't on screen yet", () => {
    const { ws } = setup({ focusedOwnWindow: () => ownWindow("window:977:0") });
    expect(ws.focusWindow()).toMatchObject({ id: 977, pid: OWN, title: "" });
  });

  it("never asks AX about Ember's own process when Ember is the frontmost app", () => {
    const { s, ws } = setup();
    s.frontmost = OWN;
    expect(ws.focusWindow()).toMatchObject({ id: 950, pid: OWN });
    expect(ws.activeWindow()).toMatchObject({ id: 950, pid: OWN });
    expect(s.calls.filter(c => c.startsWith("focused") || c.startsWith("windows"))).toEqual([]);
  });

  it("falls back to the first app window, front to back, when AX can't tell (not trusted)", () => {
    const { s, ws } = setup();
    s.frontmost = null;
    expect(ws.focusWindow()?.id).toBe(101);
    expect(ws.activeWindow()?.id).toBe(101);
  });

  it("reports no window when the frontmost app shows none", () => {
    const { s, ws } = setup();
    s.frontmost = 999;
    expect(ws.focusWindow()).toBeNull();
    expect(ws.activeWindow()).toBeNull();
  });
});

describe("the apps' open windows on macOS", () => {
  it("lists normal app windows with AX titles where CGWindowList has none, one AX read per app", () => {
    const { s, ws } = setup();
    expect(ws.clientWindows().map(c => [c.id, c.title, c.wmClass, c.wmClassName])).toEqual([
      [101, "notes.txt", "TextEdit", "TextEdit"], [103, "Other", "TextEdit", "TextEdit"], [104, "Downloads", "Finder", "Finder"],
    ]);
    expect(s.calls).toEqual(["windows 500"]);
  });

  it("stops asking AX once its time budget is spent", () => {
    const { s, desktop } = fakeDesktop();
    s.windows.push(w(130, 510, "Pages", "", 0, 0, 300, 300), w(140, 520, "Numbers", "", 0, 0, 300, 300));
    let t = 0;
    const ws = createDarwinWindows(desktop, { screen }, { ownPid: OWN, titleBudgetMs: 100, now: () => (t += 60) });
    ws.clientWindows();
    expect(s.calls).toEqual(["windows 500"]);
  });
});

describe("capturing on macOS", () => {
  const image = async (r: Rect): Promise<X11Image> => ({ ...r, bgra: Buffer.alloc(r.width * r.height * 4) });

  it("captures nothing without a capture function or the Screen Recording permission", () => {
    expect(setup().ws.capture(0, 0, 10, 10)).toBeNull();
    const capture = vi.fn(image);
    const { s, ws } = setup({ capture });
    s.screenAccess = false;
    expect(ws.capture(0, 0, 10, 10)).toBeNull();
    expect(setup({ capture, screenAccess: () => false }).ws.capture(0, 0, 10, 10)).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("clips the request to every display together and hands back the injected function's image", async () => {
    const capture = vi.fn(image);
    const { ws } = setup({ capture });
    const img = await ws.capture(-1300, -120, 40, 40);
    expect(capture).toHaveBeenCalledWith({ x: -1280, y: -100, width: 20, height: 20 });
    expect(img).toMatchObject({ x: -1280, y: -100, width: 20, height: 20 });
  });

  it("uses the injected permission check over CoreGraphics' own", async () => {
    const { s, ws } = setup({ capture: image, screenAccess: () => true });
    s.screenAccess = false;
    expect(await ws.capture(0, 0, 4, 4)).not.toBeNull();
    expect(ws.screenRecording()).toBe(true);
  });
});

describe("Ember's own windows on macOS", () => {
  it("takes the CGWindowID from the media source id, never the native handle (an NSView* here)", () => {
    const { ws } = setup();
    expect(ws.windowId(ownWindow("window:950:0"))).toBe(950);
    expect(ws.windowId(ownWindow("screen:1:0"))).toBe(0);
    expect(ws.windowId({ getMediaSourceId: () => { throw new Error("destroyed"); }, getNativeWindowHandle: () => Buffer.alloc(8) })).toBe(0);
  });
});

describe("system dialogs and permissions on macOS", () => {
  it("sees an authentication dialog or secure keyboard entry as a reason for no screenshot", () => {
    const { s, ws } = setup();
    expect(ws.systemDialogOpen()).toBe(false);
    s.windows.unshift(w(990, 77, "SecurityAgent", "", 500, 300, 400, 200, 1000));
    expect(ws.systemDialogOpen()).toBe(true);
    s.windows.shift();
    s.secure = true;
    expect(ws.systemDialogOpen()).toBe(true);
  });

  it("assumes a dialog is up when it can't check", () => {
    const { desktop } = fakeDesktop();
    desktop.secureInput = () => { throw new Error("gone"); };
    expect(createDarwinWindows(desktop, { screen }).systemDialogOpen()).toBe(true);
  });

  it("sees every system prompt that takes credentials or consent (M17)", () => {
    const owners = [
      "SecurityAgent", "coreautha", "coreauthd", "universalAccessAuthWarn", "UserNotificationCenter", "CoreServicesUIAgent",
      "AuthenticationServicesAgent", "ScreenSaverEngine",
    ];
    for (const owner of owners) {
      const { s, ws } = setup();
      s.windows.unshift(w(990, 77, owner, "", 500, 300, 400, 200, 0));
      expect(ws.systemDialogOpen(), owner).toBe(true);
      s.windows[0]!.alpha = 0; // ordered in but fully transparent: nothing to see
      expect(ws.systemDialogOpen(), owner).toBe(false);
    }
    const { s, ws } = setup();
    s.windows.unshift(w(990, 78, "Finder", "", 500, 300, 400, 200, 0));
    expect(ws.systemDialogOpen()).toBe(false);
  });

  it("falls back to the session's secure-input pid when IsSecureEventInputEnabled can't be called (M18)", () => {
    const { s, ws, warned } = setup();
    s.secure = null;
    expect(ws.systemDialogOpen()).toBe(false);
    s.session = { locked: false, secureInputPid: 600 };
    expect(ws.systemDialogOpen()).toBe(true);
    expect(warned).toEqual([]);
  });

  it("fails closed, and logs it once, when neither the call nor the session can tell (M18)", () => {
    const { s, ws, warned } = setup();
    s.secure = null;
    s.session = null;
    expect(ws.systemDialogOpen()).toBe(true);
    expect(ws.systemDialogOpen()).toBe(true);
    expect(ws.secureInput()).toEqual({ on: null, pid: null, app: "" });
    expect(warned).toEqual(['platform.secure_input_unknown {"part":"windows"}']);
  });

  it("names the app holding secure input, for the refusal text and the doctor", () => {
    const { s, ws } = setup();
    expect(ws.secureInput()).toEqual({ on: false, pid: null, app: "" });
    s.secure = true;
    s.session = { locked: false, secureInputPid: 600 };
    expect(ws.secureInput()).toEqual({ on: true, pid: 600, app: "Finder" });
    s.session = { locked: false, secureInputPid: 77 }; // no window: named by its process
    expect(ws.secureInput()).toEqual({ on: true, pid: 77, app: "SecurityAgent" });
  });

  it("reports the Accessibility and Screen Recording permissions", () => {
    const { s, ws } = setup();
    expect([ws.accessibilityTrusted(), ws.screenRecording()]).toEqual([true, true]);
    s.trusted = false;
    s.screenAccess = false;
    expect([ws.accessibilityTrusted(), ws.screenRecording()]).toEqual([false, false]);
  });

  it("reports Input Monitoring and asks for it, null where macOS has no such call (M3)", () => {
    const { s, ws } = setup();
    expect(ws.inputMonitoring()).toBe(true);
    s.listen = false;
    expect(ws.inputMonitoring()).toBe(false);
    expect(ws.requestInputMonitoring()).toBe(false);
    expect(s.calls).toEqual(["request listen"]);
    s.listen = null;
    expect([ws.inputMonitoring(), ws.requestInputMonitoring()]).toEqual([null, null]);
  });
});

describe("the macOS window system after close()", () => {
  it("answers like X11's after close", async () => {
    const { ws } = setup({ capture: async r => ({ ...r, bgra: Buffer.alloc(r.width * r.height * 4) }) });
    ws.close();
    expect(ws.hasCompositor()).toBe(true);
    expect([ws.pointer(), ws.keysDown(), ws.activeWindow(), ws.focusWindow(), ws.capture(0, 0, 5, 5)]).toEqual([null, null, null, null, null]);
    expect([ws.clientWindows(), ws.stack()]).toEqual([[], []]);
    expect(ws.systemDialogOpen()).toBe(true);
    expect([ws.secureInput(), ws.inputMonitoring(), ws.requestInputMonitoring()]).toEqual([{ on: null, pid: null, app: "" }, null, null]);
    ws.close();
  });
});
