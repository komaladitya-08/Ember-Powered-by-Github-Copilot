/**
 * The macOS platform object (design §8.1, §5.1) with fake Electron parts: building it touches no property of
 * Electron's screen, desktopCapturer, powerMonitor or BrowserWindow and calls no app.getPath (main builds it before
 * ready, when Electron's screen throws), no native library loads until a window system is opened (and none at all off
 * macOS), the window system gets the desktopCapturer capture, Electron's Screen Recording answer and Ember's focused
 * window, and the accessibility helper is Ember's own binary running the shared host with Ember's tokens left out.
 */

import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { darwinPlatform } from "../../app/main/platform/darwin/platform";
import type { DarwinWindowsDeps } from "../../app/main/platform/darwin/windows";
import type { DarwinInputDeps } from "../../app/main/platform/darwin/input";
import type { ElectronParts, OwnWindowHandle, WindowSystem } from "../../app/main/platform/types";
import { fakeDeps, fakeElectron, fakeRun } from "./darwin-system-fakes";

const requireCjs = createRequire(import.meta.url);
const koffi = requireCjs("koffi") as typeof import("koffi");
const quiet = { run: fakeRun().run, every: () => {} };

/** A Proxy that throws on every property access, as Electron's screen does before ready. */
const untouchable = (what: string) => new Proxy({}, { get: (_t, k) => { throw new Error(`${what}.${String(k)} touched before ready`); }, has: () => { throw new Error(`${what} touched`); } });

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), file: "" });

const fakeWs = () => ({ kind: "darwin", compositorMayChange: false, accessibilityTrusted: () => true, screenRecording: () => true, close: vi.fn() }) as unknown as WindowSystem;

describe("darwinPlatform", () => {
  it("is built before ready without touching screen, desktopCapturer, powerMonitor, BrowserWindow or app.getPath", () => {
    const e = fakeElectron();
    const electron = { ...e.electron, screen: untouchable("screen"), desktopCapturer: untouchable("desktopCapturer"),
      powerMonitor: untouchable("powerMonitor"), browserWindow: untouchable("browserWindow") } as unknown as ElectronParts;
    const p = darwinPlatform(fakeDeps(electron), quiet);
    expect(p.os).toBe("darwin");
    expect(p.system.os).toBe("darwin");
    expect(e.app.getPath).not.toHaveBeenCalled();
    // The overlay shaper, flags and lifecycle are plain data, readable before ready too.
    expect(p.overlay.forward).toBe(true);
    expect(p.system.lifecycle.sessionEnd).toBe("power-monitor-shutdown");
  });

  it("loads no native library while it is built, nor (off macOS) when its window system and input are opened", () => {
    const load = koffi.load;
    const loaded: unknown[] = [];
    koffi.load = ((...args: unknown[]) => { loaded.push(args[0]); return load.apply(koffi, args as Parameters<typeof load>); }) as typeof load;
    try {
      const p = darwinPlatform(fakeDeps(fakeElectron().electron), quiet);
      expect(loaded).toEqual([]);
      if (process.platform !== "darwin") {
        const l = log();
        expect(p.openWindows(l)).toBeNull();
        expect(l.error).toHaveBeenCalledWith("platform.windows_unavailable", { err: expect.any(Error) });
        expect(p.openInput(null, l)).toBeNull();
        expect(l.error).toHaveBeenCalledWith("platform.input_unavailable", { err: expect.any(Error) });
        expect(loaded).toEqual([]);
      }
    } finally {
      koffi.load = load;
    }
  });

  it("opens port/darwin's window system with the capture, Electron's Screen Recording answer and Ember's focused window", async () => {
    const e = fakeElectron();
    const own: OwnWindowHandle = { getNativeWindowHandle: () => Buffer.alloc(8), getMediaSourceId: () => "window:42:0" };
    e.browserWindow.getFocusedWindow.mockReturnValue(own as never);
    let got: DarwinWindowsDeps | undefined;
    const ws = fakeWs();
    const l = log();
    const p = darwinPlatform(fakeDeps(e.electron), { ...quiet, openWindows: d => { got = d; return ws as never; } });
    expect(p.openWindows(l)).toBe(ws);
    expect(got!.log).toBe(l); // port/darwin logs platform.secure_input_unknown there
    expect(got!.screen).toBe(e.electron.screen);
    expect(got!.focusedOwnWindow!()).toBe(own);
    expect(got!.screenAccess!()).toBe(true);
    vi.mocked(e.systemPreferences.getMediaAccessStatus).mockReturnValue("denied");
    expect(got!.screenAccess!()).toBe(false);
    // The capture is the desktopCapturer one: it asks Electron for screen thumbnails.
    e.desktopCapturer.getSources.mockResolvedValue([] as never);
    expect(await got!.capture!({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(e.desktopCapturer.getSources).toHaveBeenCalledWith(expect.objectContaining({ types: ["screen"], fetchWindowIcons: false }));
  });

  it("opens the input with Ember's focused window and the logger, and logs nothing for the doctor (log null)", () => {
    const e = fakeElectron();
    let got: DarwinInputDeps | undefined;
    const p = darwinPlatform(fakeDeps(e.electron), { ...quiet, openInput: d => { got = d; return null; } });
    expect(p.openInput(null, null)).toBeNull();
    expect(got!.focusedOwnWindow).toBeTypeOf("function");
    expect(got!.log).toBeUndefined();
    got!.focusedOwnWindow!();
    expect(e.browserWindow.getFocusedWindow).toHaveBeenCalled();
    const l = log();
    expect(p.openInput(null, l)).toBeNull();
    expect(got!.log).toBe(l);
    expect(l.error).toHaveBeenCalledWith("platform.input_unavailable", expect.anything());
  });

  it("reads permissions from the window system it opened", () => {
    const e = fakeElectron();
    const ws = { ...fakeWs(), accessibilityTrusted: () => false } as unknown as WindowSystem;
    const p = darwinPlatform(fakeDeps(e.electron), { ...quiet, openWindows: () => ws as never });
    expect(p.system.environment({ windows: undefined }).mac?.accessibility).toBe(true); // before it opened: Electron's answer
    p.openWindows(log());
    expect(p.system.environment({ windows: undefined }).mac?.accessibility).toBe(false);
  });

  it("has no X11 pieces: no re-reported shortcuts, keyboard hold, X clipboard or desk", () => {
    const p = darwinPlatform(fakeDeps(fakeElectron().electron), quiet);
    expect(p.shortcutsReReported).toBe(false);
    expect(p.keyboardHold).toBeNull();
    expect(p.clipboard).toBeNull();
    expect(p.desk).toBeNull();
  });

  it("never asks for setVisibleOnAllWorkspaces, and makes the floating windows non-activating panels", () => {
    const p = darwinPlatform(fakeDeps(fakeElectron().electron), quiet);
    for (const kind of ["overlay", "handle", "ask", "desk-view"] as const) expect(p.overlay.floating(kind).allWorkspaces).toBeNull();
    for (const kind of ["overlay", "handle", "ask"] as const) expect(p.overlay.floating(kind).options.type).toBe("panel");
    expect(p.overlay.setInputRegion({ getNativeWindowHandle: () => Buffer.alloc(8), getMediaSourceId: () => "" }, [], 2)).toBe(false);
  });

  it("starts the shared host as Ember's own binary in node mode, without Ember's tokens", () => {
    const env = { PATH: "/usr/bin:/bin", HOME: "/Users/ada", GH_TOKEN: "t", COPILOT_GITHUB_TOKEN: "c", EMBER_USER_DATA: "/x", EMBER_LOG_LEVEL: "debug",
      EMBER_AX_PROVIDER: "fake", NODE_OPTIONS: "--inspect" };
    const deps = fakeDeps(fakeElectron().electron, env);
    const ctx = { appDir: "/Applications/Ember.app/Contents/Resources/app/dist/app", appPath: deps.appPath, resourcesPath: deps.resourcesPath,
      packaged: true, userData: "/Users/ada/Library/Application Support/ember", execPath: deps.execPath };
    const launch = darwinPlatform(deps, quiet).sidecarLaunch(ctx)!;
    expect(launch.command).toBe("/Applications/Ember.app/Contents/MacOS/Ember");
    expect(launch.args).toEqual([path.join(ctx.appDir, "ax-sidecar.cjs")]);
    expect(launch.firstRequestMs).toBe(10_000);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.env.EMBER_OWNER_PID).toBe(String(process.pid));
    expect(launch.env.EMBER_LOG_LEVEL).toBe("debug");
    expect(launch.env.PATH).toBe("/usr/bin:/bin");
    for (const k of ["GH_TOKEN", "COPILOT_GITHUB_TOKEN", "EMBER_USER_DATA", "NODE_OPTIONS", "EMBER_AX_PROVIDER", "EMBER_UIA_SCRIPT", "EMBER_UIA_CACHE"]) {
      expect(launch.env[k], k).toBeUndefined();
    }
    // Unpackaged, the host's test switches stay (Ember-level tests choose the fake desktop with them).
    const dev = darwinPlatform({ ...deps, packaged: false }, quiet).sidecarLaunch({ ...ctx, packaged: false })!;
    expect(dev.env.EMBER_AX_PROVIDER).toBe("fake");
    expect(dev.env.GH_TOKEN).toBeUndefined();
  });
});
