/**
 * The Windows platform object (win32/platform.ts) on Linux with fake Electron parts: building it touches no Electron
 * object (a `screen` Proxy that throws on any property access, an app.getPath that throws) and loads no native
 * library; openWindows/openInput use port/win32's backends and log when they can't open; the window system keeps its
 * extras and gains systemDialogOpen; the host's launch is port/host's hostLaunch with the UIA bridge's script and cache
 * and a clean environment; and the Windows SystemPlatform is wired with its rows.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { ElectronParts, Input, PlatformDeps, StackedWindow } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";
import { KEYS, SHORTCUTS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { win32Platform, type Win32PlatformOptions } from "../../app/main/platform/win32/platform";
import type { Win32WindowSystem } from "../../app/main/platform/win32/windows";
import { fakeApi } from "./win32-system-fakes";

const requireCjs = createRequire(import.meta.url);
const koffi = requireCjs("koffi") as typeof import("koffi");

/** An object every property access of which throws (Electron's screen before ready). */
const untouchable = (what: string) => new Proxy({}, {
  get(_t, key) { throw new Error(`${what}.${String(key)} touched before ready`); },
  has(_t, key) { throw new Error(`${what} queried for ${String(key)}`); },
});

function fakeDeps(o: { packaged?: boolean; env?: NodeJS.ProcessEnv } = {}): PlatformDeps {
  const electron = {
    app: {
      isPackaged: o.packaged ?? true,
      getPath: () => { throw new Error("app.getPath called during construction"); },
      getAppPath: () => "C:\\Ember\\resources\\app.asar",
      getVersion: () => "1.0.0",
      isAccessibilitySupportEnabled: () => false,
      setLoginItemSettings: () => undefined,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      focus: () => undefined,
    },
    screen: untouchable("screen"),
    desktopCapturer: untouchable("desktopCapturer"),
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
    shell: { openExternal: async () => undefined },
    powerMonitor: untouchable("powerMonitor"),
    browserWindow: untouchable("browserWindow"),
  } as unknown as ElectronParts;
  return {
    electron, packaged: o.packaged ?? true, execPath: "C:\\Program Files\\Ember\\Ember.exe", appPath: "C:\\Program Files\\Ember\\resources\\app.asar",
    resourcesPath: "C:\\Program Files\\Ember\\resources", env: o.env ?? { SystemRoot: "C:\\Windows", Path: "C:\\Windows", GH_TOKEN: "gho_x", EMBER_AX_PROVIDER: "fake", EMBER_LOG_LEVEL: "info" },
  };
}

function fakeLog() {
  const lines: { level: string; msg: string; fields?: unknown }[] = [];
  const log = {
    debug: (msg: string, fields?: unknown) => lines.push({ level: "debug", msg, fields }),
    info: (msg: string, fields?: unknown) => lines.push({ level: "info", msg, fields }),
    warn: (msg: string, fields?: unknown) => lines.push({ level: "warn", msg, fields }),
    error: (msg: string, fields?: unknown) => lines.push({ level: "error", msg, fields }),
    child: () => log, file: "",
  } as unknown as Logger;
  return { log, lines };
}

/** A port/win32 window system stand-in with an extra member, counting its calls. */
function fakeWs(stack: StackedWindow[] = []) {
  const calls: string[] = [];
  const ws = {
    kind: "win32", compositorMayChange: false, stack: () => { calls.push("stack"); return stack; },
    activate(this: { kind: string }, id: number) { calls.push(`activate ${id} ${this.kind}`); },
    close: () => calls.push("close"),
  } as unknown as Win32WindowSystem;
  return { ws, calls };
}

describe("building the Windows platform", () => {
  it("touches no Electron object, calls no loader and loads no native library", () => {
    const load = koffi.load;
    const loaded: unknown[] = [];
    koffi.load = ((...args: unknown[]) => { loaded.push(args[0]); return load.apply(koffi, args as Parameters<typeof load>); }) as typeof load;
    const asked: string[] = [];
    try {
      const p = win32Platform(fakeDeps(), {
        api: () => { asked.push("system api"); return null; },
        win32Api: () => { asked.push("win32 api"); return null; },
        openWindows: () => { asked.push("open windows"); return null; },
        openInput: () => { asked.push("open input"); return null; },
      });
      expect(p.os).toBe("win32");
      expect(p.system.os).toBe("win32");
    } finally {
      koffi.load = load;
    }
    expect(loaded).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("builds without options too (the real loaders stay unused until opened)", () => {
    expect(() => win32Platform(fakeDeps())).not.toThrow();
  });

  it("has no keyboard hold, X clipboard or desk, trusts each shortcut press, and polls hover for its windows", () => {
    const p = win32Platform(fakeDeps());
    expect(p.keyboardHold).toBeNull();
    expect(p.clipboard).toBeNull();
    expect(p.desk).toBeNull();
    expect(p.shortcutsReReported).toBe(false);
    expect(p.overlay.forward).toBe(false);
    expect(p.overlay.floating("overlay")).toEqual({ options: { type: "toolbar", thickFrame: false, roundedCorners: false }, allWorkspaces: null });
  });
});

describe("opening the window system and input", () => {
  it("opens port/win32's window system with Electron's screen, keeping its extras and adding systemDialogOpen", () => {
    const deps = fakeDeps();
    const { ws, calls } = fakeWs([]);
    let given: unknown;
    const o: Win32PlatformOptions = {
      openWindows: d => { given = d.screen; return ws; },
      win32Api: () => ({ inputDesktopName: () => "Default", className: () => "Notepad", exStyle: () => 0 }) as never,
      api: () => fakeApi(),
    };
    const opened = win32Platform(deps, o).openWindows(fakeLog().log)!;
    expect(given).toBe(deps.electron.screen);
    expect(opened.systemDialogOpen?.()).toBe(false);
    (opened as Win32WindowSystem).activate(7);
    expect(calls).toEqual(["stack", "activate 7 win32"]);
  });

  it("says a system dialog is open when the secure desktop has the screen, and when the Win32 API is missing", () => {
    const { ws } = fakeWs([]);
    const secure = win32Platform(fakeDeps(), { openWindows: () => ws, win32Api: () => ({ inputDesktopName: () => null, className: () => "", exStyle: () => 0 }) as never, api: () => fakeApi() });
    expect(secure.openWindows(fakeLog().log)!.systemDialogOpen!()).toBe(true);
    const missing = win32Platform(fakeDeps(), { openWindows: () => ws, win32Api: () => null, api: () => fakeApi() });
    expect(missing.openWindows(fakeLog().log)!.systemDialogOpen!()).toBe(true);
  });

  it("logs platform.windows_unavailable and platform.input_unavailable when the backends can't open", () => {
    const { log, lines } = fakeLog();
    const p = win32Platform(fakeDeps(), { openWindows: () => null, openInput: () => null });
    expect(p.openWindows(log)).toBeNull();
    expect(p.openInput(null, log)).toBeNull();
    expect(lines.map(l => [l.level, l.msg])).toEqual([["error", "platform.windows_unavailable"], ["error", "platform.input_unavailable"]]);
    expect(lines[0].fields).toHaveProperty("err");
  });

  it("logs nothing for a missing input backend when given no logger (the doctor)", () => {
    const p = win32Platform(fakeDeps(), { openInput: () => null });
    expect(() => p.openInput(null, null)).not.toThrow();
  });

  it("hands the input backend through", () => {
    const input = { close: () => undefined } as unknown as Input;
    expect(win32Platform(fakeDeps(), { openInput: () => input }).openInput(null, null)).toBe(input);
  });

  it("sends the system's own log lines to the logger it was opened with", () => {
    const { log, lines } = fakeLog();
    const p = win32Platform(fakeDeps({ packaged: true }), { openWindows: () => null, api: () => fakeApi() });
    p.openWindows(log);
    p.system.lifecycle.ensureShortcut(); // the fake shell has no shortcut writer
    expect(lines.map(l => l.msg)).toContain("platform.shortcut_failed");
  });
});

describe("the accessibility helper's launch on Windows", () => {
  const ctx = {
    appDir: "C:\\Program Files\\Ember\\resources\\app.asar\\dist\\app", appPath: "C:\\Program Files\\Ember\\resources\\app.asar",
    resourcesPath: "C:\\Program Files\\Ember\\resources", packaged: true, userData: "C:\\Users\\Ana\\AppData\\Local\\ember", execPath: "C:\\Program Files\\Ember\\Ember.exe",
  };

  it("runs the shared host as Ember's own program in node mode, with the bridge's script and cache and no console window", () => {
    const launch = win32Platform(fakeDeps()).sidecarLaunch(ctx)!;
    expect(launch.command).toBe("C:\\Program Files\\Ember\\Ember.exe");
    expect(launch.args).toEqual(["C:\\Program Files\\Ember\\resources\\app.asar\\dist\\app\\ax-sidecar.cjs"]);
    expect(launch.firstRequestMs).toBe(20_000);
    expect(launch.windowsHide).toBe(true);
    expect(launch.env).toEqual({
      SystemRoot: "C:\\Windows", Path: "C:\\Windows", EMBER_LOG_LEVEL: "info", ELECTRON_RUN_AS_NODE: "1", EMBER_OWNER_PID: String(process.pid),
      EMBER_UIA_SCRIPT: "C:\\Program Files\\Ember\\resources\\sidecar\\uia\\ember_uia.ps1", EMBER_UIA_CACHE: "C:\\Users\\Ana\\AppData\\Local\\ember\\uia-cache",
    });
  });

  it("uses the repository's script and keeps the test switches in development", () => {
    const launch = win32Platform(fakeDeps({ packaged: false })).sidecarLaunch({ ...ctx, packaged: false, appPath: "C:\\src\\ember", appDir: "C:\\src\\ember\\dist\\app" })!;
    expect(launch.env.EMBER_UIA_SCRIPT).toBe("C:\\src\\ember\\sidecar\\uia\\ember_uia.ps1");
    expect(launch.env.EMBER_AX_PROVIDER).toBe("fake");
    expect(launch.env.GH_TOKEN).toBeUndefined();
  });
});

describe("the Windows SystemPlatform", () => {
  it("carries the Windows rows of words, shortcuts and keys, and Windows' fixed answers", () => {
    const s = win32Platform(fakeDeps()).system;
    expect(s.words).toBe(PLATFORM_WORDS.win32);
    expect(s.shortcuts).toBe(SHORTCUTS.win32);
    expect(s.keys).toBe(KEYS.win32);
    expect(s.chromiumSwitches).toEqual(["enable-features=RunVideoCaptureServiceInBrowserProcess"]);
    expect(s.spawnDefaults).toEqual({ windowsHide: true });
    expect(s.auditSink(() => undefined)).toBeUndefined();
    expect(s.auditCopy()).toBeNull();
    expect(s.voice.speakerMonitor).toBe(false);
    expect(s.lifecycle.appUserModelId).toBe("io.github.komaladitya08.ember");
    expect(s.lifecycle.sessionEnd).toBe("window-session-end");
    expect(s.settings.available).toEqual({ dark_style: "Dark mode for apps" });
    expect(s.adminPolicy.location).toBe("HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)");
    expect(s.paths.runtimeExe).toBe("copilot-runtime.exe");
    expect(s.privacy.isSecurityWindow({ app: "consent" })).toBe(true);
    expect(s.privacy.isSecurityWindow({ app: "notepad", title: "notes.txt - Notepad" })).toBe(false);
    expect(s.fixes.ids).toEqual(["open-microphone-settings", "unblock-helper"]);
  });

  it("answers the environment without Electron's screen, before any window system opened", () => {
    const s = win32Platform(fakeDeps(), { api: () => null }).system;
    const inputs = s.environment({ windows: undefined }) as ReturnType<typeof s.environment> & { windows: { powershell: string } };
    expect(inputs.platform).toBe("win32");
    expect(inputs.windows.powershell).toBe("unknown");
  });
});
