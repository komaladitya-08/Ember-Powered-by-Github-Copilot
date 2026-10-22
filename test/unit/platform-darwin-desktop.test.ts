/**
 * The native side of the macOS backends over stand-in frameworks: the window list (front to back, cached for 30 ms
 * because a borrow polls it every 8 ms), every key's state in one GetKeys call where it binds, AX never asked about
 * Ember's own process, raising a window and, when macOS declines the activation, LaunchServices as the fallback
 * (never when the user took the focus meanwhile), the session's lock and secure-input holder, secure input and
 * Input Monitoring that answer null ("can't tell") where the call is missing, and the holder's name.
 */

import { describe, expect, it } from "vitest";
import { ACTIVATION_FALLBACK_MS, WINDOW_CACHE_MS, makeDesktop, secureInputOf, type DesktopOptions } from "../../app/main/platform/darwin/desktop";
import type { HIToolbox } from "../../app/main/platform/darwin/hitoolbox";
import { fakeAX, fakeCG, type FakeCGOptions } from "./platform-darwin-fakes";

const textEdit = {
  kCGWindowNumber: 101, kCGWindowOwnerPID: 500, kCGWindowOwnerName: "TextEdit", kCGWindowName: "notes.txt",
  kCGWindowBounds: { X: -100, Y: 25, Width: 600, Height: 400 }, kCGWindowLayer: 0, kCGWindowAlpha: 1,
};
const finder = { ...textEdit, kCGWindowNumber: 201, kCGWindowOwnerPID: 600, kCGWindowOwnerName: "Finder", kCGWindowName: "Downloads" };
const TEXTEDIT = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";

/** A HIToolbox whose answers the test sets. */
function fakeHI(o: Partial<{ secure: boolean | null; layout: boolean | null; keyMap: Buffer | null }> = {}): HIToolbox & { maps: number } {
  const hi = {
    maps: 0,
    secureInput: () => o.secure ?? null,
    inputSourceIsLayout: () => o.layout ?? null,
    keyMap: () => (o.keyMap === undefined || o.keyMap === null ? null : (hi.maps++, o.keyMap)),
    keyboardLayout: () => null,
  };
  return hi;
}

/** A desktop over the fakes, with a hand-cranked clock and timers and a recorded LaunchServices. */
function setup(cgo: Partial<FakeCGOptions> = {}, o: DesktopOptions & { hi?: HIToolbox | null } = {}) {
  const ax = fakeAX();
  const cg = fakeCG(ax.f, { windows: [textEdit], ...cgo });
  let t = 1000;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const opened: string[] = [];
  const logged: string[] = [];
  const desktop = makeDesktop(ax.cf, cg.cg, ax.ax, o.hi === undefined ? fakeHI() : o.hi, {
    ownPid: 4242,
    now: () => t,
    later: (ms, fn) => {
      const timer = { at: t + ms, fn, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    openApp: (bundle, done) => { opened.push(bundle); done(); },
    processPath: pid => (pid === 500 ? TEXTEDIT : pid === 77 ? "/usr/local/bin/pinentry" : null),
    log: { info: (event, fields) => logged.push(`${event} ${JSON.stringify(fields)}`) },
    ...o,
  });
  /** Moves the clock on, running the timers that come due. */
  const advance = (ms: number) => {
    t += ms;
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.at <= t) timer.fn();
      else timers.push(timer);
    }
  };
  return { ...ax, ...cg, desktop, advance, opened, logged, pending: () => timers.filter(x => !x.cancelled).length };
}

describe("the macOS desktop over stand-in frameworks", () => {
  it("reads the window list front to back, drops entries it can't place, and releases the list once", () => {
    const { desktop, f, lists } = setup({ windows: [{ ...textEdit }, { kCGWindowNumber: 7, kCGWindowOwnerPID: 1 }, { ...textEdit, kCGWindowNumber: 102, kCGWindowName: undefined, kCGWindowLayer: 101 }] });
    expect(desktop.windows()).toEqual([
      { id: 101, pid: 500, owner: "TextEdit", title: "notes.txt", bounds: { x: -100, y: 25, width: 600, height: 400 }, layer: 0, alpha: 1 },
      { id: 102, pid: 500, owner: "TextEdit", title: "", bounds: { x: -100, y: 25, width: 600, height: 400 }, layer: 101, alpha: 1 },
    ]);
    expect(f.released).toEqual(lists);
  });

  it("never asks AX about Ember's own process", () => {
    const { desktop, calls, pending } = setup({}, { ownPid: 500 });
    expect(desktop.focusedWindow(500)).toBeNull();
    expect(desktop.appWindows(500)).toBeNull();
    expect(desktop.raise(500, 101, { x: -100, y: 25, width: 600, height: 400 })).toBe(false);
    expect(calls).toEqual([]);
    expect(pending()).toBe(0); // and no LaunchServices fallback either
  });

  it("reads a window's frame over AX only when AX gives no window id, and releases the app element", () => {
    const withIds = setup({ windows: [] });
    expect(withIds.desktop.focusedWindow(500)).toEqual({ id: 101, title: "notes.txt", frame: null });
    expect(withIds.desktop.appWindows(500)).toEqual([{ id: 101, title: "notes.txt", frame: null }]);
    expect(withIds.f.released.some(r => withIds.f.objects.get(r)!.t === "axvalue")).toBe(false);
    const apps = [...withIds.f.objects.entries()].filter(([, o]) => o.t === "element" && o.v === "app").map(([r]) => r);
    expect(apps.map(r => withIds.f.counts.get(r))).toEqual([0, 0]);

    const noIds = fakeAX({ windowIds: false });
    const plain = makeDesktop(noIds.cf, fakeCG(noIds.f, { windows: [] }).cg, noIds.ax, null, { ownPid: 4242 });
    expect(plain.focusedWindow(500)).toEqual({ id: 0, title: "notes.txt", frame: { x: 100, y: 120, width: 600, height: 400 } });
  });

  it("raises the one window AX matches, and brings its app to the front", () => {
    const { desktop, calls } = setup({ windows: [] });
    expect(desktop.raise(500, 101, { x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(calls).toEqual(["app 500", "set AXFrontmost=true", "perform AXRaise", "set AXMain=true"]);
    calls.length = 0;
    desktop.raise(500, 999, { x: 0, y: 0, width: 1, height: 1 }); // AX lists no such window: nothing is raised
    expect(calls).toEqual(["app 500", "set AXFrontmost=true"]);
  });

  it("reads the lock state and the secure-input holder from the session, and says when it can't", () => {
    const session = (s: Record<string, unknown> | null) => setup({ windows: [], session: s }).desktop.session();
    expect(session({ kCGSSessionOnConsoleKey: true })).toEqual({ locked: false, secureInputPid: null });
    expect(session({ kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: true, kCGSSessionSecureInputPID: 88 })).toEqual({ locked: true, secureInputPid: 88 });
    expect(session({ kCGSSessionOnConsoleKey: false })).toEqual({ locked: true, secureInputPid: null });
    expect(session({ CGSSessionScreenIsLocked: 1, kCGSSessionSecureInputPID: 0 })).toEqual({ locked: true, secureInputPid: null });
    expect(session(null)).toBeNull();
  });
});

describe("the cost of a borrow's polling on macOS (M11)", () => {
  it("reuses the window list for 30 ms, then reads it again", () => {
    const { desktop, lists, advance } = setup();
    const first = desktop.windows();
    advance(WINDOW_CACHE_MS - 1);
    expect(desktop.windows()).toBe(first);
    expect(lists).toHaveLength(1);
    advance(1);
    expect(desktop.windows()).not.toBe(first);
    expect(lists).toHaveLength(2);
  });

  it("shares the cached list read-only, so one caller can't change what the next one sees", () => {
    const { desktop } = setup();
    const list = desktop.windows();
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => (list as unknown[]).push(1)).toThrow();
  });

  it("reads every key in one GetKeys call where it binds: key k is bit k & 7 of byte k >> 3", () => {
    const map = Buffer.alloc(16);
    map[0] = 0b0000_0001; // kVK_ANSI_A (0)
    map[7] = 0b0000_0001; // kVK_Shift (0x38 = 56: byte 7, bit 0)
    map[13] = 0b0000_0010; // kVK_F13 (0x69 = 105: byte 13, bit 1)
    map[15] = 0b1000_0000; // 127
    const hi = fakeHI({ keyMap: map });
    const { desktop, keyCalls } = setup({ keys: new Set([3]) }, { hi });
    expect(desktop.keysDown()).toEqual([0, 0x38, 0x69, 127]);
    expect(hi.maps).toBe(1);
    expect(keyCalls).toEqual([]);
  });

  it("asks CoreGraphics key by key, 0 to 127, where GetKeys doesn't bind", () => {
    const { desktop, keyCalls } = setup({ keys: new Set([3, 0x38]) }, { hi: fakeHI({ keyMap: null }) });
    expect(desktop.keysDown()).toEqual([3, 0x38]);
    expect(keyCalls).toEqual(Array.from({ length: 128 }, (_, k) => k));
    expect(setup({ keys: new Set([9]) }, { hi: null }).desktop.keysDown()).toEqual([9]);
  });
});

describe("activating an app on macOS 14 and later (M12)", () => {
  const at = { x: 0, y: 0, width: 1, height: 1 };

  it("activates through LaunchServices and raises the window again when macOS declined the activation", () => {
    const { desktop, calls, state, advance, opened, logged } = setup();
    state.frontmost = 600; // Finder stays in front: the activation was declined
    desktop.raise(500, 101, at);
    calls.length = 0;
    advance(ACTIVATION_FALLBACK_MS - 1);
    expect(opened).toEqual([]);
    advance(1);
    expect(opened).toEqual(["/System/Applications/TextEdit.app"]);
    expect(calls).toEqual(["app 500", "perform AXRaise", "set AXMain=true"]);
    expect(logged).toEqual(['platform.activation_fallback {"pid":500}']);
  });

  it("does nothing more when the app came to the front", () => {
    const { desktop, state, advance, opened } = setup();
    state.frontmost = 600;
    desktop.raise(500, 101, at);
    state.frontmost = 500;
    advance(ACTIVATION_FALLBACK_MS);
    expect(opened).toEqual([]);
  });

  it("never takes the focus back from an app the user switched to meanwhile", () => {
    const { desktop, state, advance, opened } = setup();
    state.frontmost = 600;
    desktop.raise(500, 101, at);
    state.frontmost = 700;
    advance(ACTIVATION_FALLBACK_MS);
    expect(opened).toEqual([]);
  });

  it("does nothing when AX can't name the frontmost app, or the process is outside an app bundle", () => {
    const unknown = setup();
    unknown.state.frontmost = null;
    unknown.desktop.raise(500, 101, at);
    unknown.advance(ACTIVATION_FALLBACK_MS);
    expect(unknown.opened).toEqual([]);

    const tool = setup({}, { processPath: () => "/usr/local/bin/some-tool" });
    tool.state.frontmost = 600;
    tool.desktop.raise(500, 101, at);
    tool.advance(ACTIVATION_FALLBACK_MS);
    expect(tool.opened).toEqual([]);
  });

  it("keeps only the latest activation's fallback, and drops it on dispose", () => {
    const { desktop, state, advance, opened, pending } = setup();
    state.frontmost = 600;
    desktop.raise(500, 101, at);
    desktop.raise(500, 101, at);
    expect(pending()).toBe(1);
    desktop.dispose!();
    expect(pending()).toBe(0);
    advance(ACTIVATION_FALLBACK_MS);
    expect(opened).toEqual([]);
  });

  it("doesn't raise again after LaunchServices when a newer activation started meanwhile", () => {
    let finish: () => void = () => undefined;
    const { desktop, state, advance, calls } = setup({}, { openApp: (_bundle, done) => { finish = done; } });
    state.frontmost = 600;
    desktop.raise(500, 101, at);
    advance(ACTIVATION_FALLBACK_MS);
    desktop.raise(500, 101, at);
    calls.length = 0;
    finish();
    expect(calls).toEqual([]);
  });
});

describe("secure keyboard entry and Input Monitoring on macOS (M18, M3)", () => {
  it("answers null for secure input where IsSecureEventInputEnabled can't be called", () => {
    expect(setup({}, { hi: null }).desktop.secureInput()).toBeNull();
    expect(setup({}, { hi: fakeHI({ secure: null }) }).desktop.secureInput()).toBeNull();
    expect(setup({}, { hi: fakeHI({ secure: true }) }).desktop.secureInput()).toBe(true);
    expect(setup({}, { hi: fakeHI({ secure: false }) }).desktop.secureInput()).toBe(false);
  });

  it("answers null for the input source without HIToolbox", () => {
    expect(setup({}, { hi: null }).desktop.inputSourceIsLayout()).toBeNull();
    expect(setup({}, { hi: fakeHI({ layout: false }) }).desktop.inputSourceIsLayout()).toBe(false);
  });

  it("asks CoreGraphics for Input Monitoring and the right to post, null where the calls don't exist", () => {
    const bound = setup({ listen: false, post: true });
    expect([bound.desktop.listenAccess(), bound.desktop.postAccess(), bound.desktop.requestListenAccess()]).toEqual([false, true, false]);
    expect(bound.requests).toEqual(["listen"]);
    const old = setup();
    expect([old.desktop.listenAccess(), old.desktop.postAccess(), old.desktop.requestListenAccess()]).toEqual([null, null, null]);
  });

  it("names the app holding secure input by its window, else by its process, and falls back to the session", () => {
    const of = (secure: boolean | null, session: Record<string, unknown> | null, windows = [textEdit, finder]) =>
      secureInputOf(setup({ windows, session }, { hi: fakeHI({ secure }) }).desktop);
    expect(of(true, { kCGSSessionSecureInputPID: 600 })).toEqual({ on: true, pid: 600, app: "Finder" });
    expect(of(true, { kCGSSessionSecureInputPID: 500 }, [])).toEqual({ on: true, pid: 500, app: "TextEdit" });
    expect(of(true, { kCGSSessionSecureInputPID: 77 }, [])).toEqual({ on: true, pid: 77, app: "pinentry" });
    expect(of(true, { kCGSSessionSecureInputPID: 99 }, [])).toEqual({ on: true, pid: 99, app: "" });
    expect(of(true, {})).toEqual({ on: true, pid: null, app: "" });
    expect(of(false, { kCGSSessionSecureInputPID: 600 })).toEqual({ on: false, pid: null, app: "" });
    // IsSecureEventInputEnabled missing: the session's pid is the signal, and without the session nobody can tell.
    expect(of(null, { kCGSSessionSecureInputPID: 600 })).toEqual({ on: true, pid: 600, app: "Finder" });
    expect(of(null, { kCGSSessionOnConsoleKey: true })).toEqual({ on: false, pid: null, app: "" });
    expect(of(null, null)).toEqual({ on: null, pid: null, app: "" });
  });
});
