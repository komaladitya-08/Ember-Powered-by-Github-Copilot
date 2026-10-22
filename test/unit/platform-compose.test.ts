/**
 * The helpers the per-OS compositions share (platform/compose.ts): the system-dialog wrapper keeps a backend's extras
 * and their binding, helper environments lose tokens and Ember's switches (case-insensitively on Windows), and Ember's
 * floating windows on Windows and macOS are made as design §8.3 says, with no macOS call that would transform the
 * process (finding M1).
 */

import { describe, expect, it, vi } from "vitest";
import { applyAllWorkspaces, cleanEnv, hostEnv, hoverShaper, primaryScaledUnion, toHelperStatus, withSystemDialog } from "../../app/main/platform/compose";
import { linuxOverlayShaper } from "../../app/main/platform/linux/overlay-shaper";
import type { FloatingKind, OwnWindowHandle, WindowSystem } from "../../app/main/platform/types";

const KINDS: FloatingKind[] = ["overlay", "handle", "ask", "desk-view"];

/** A window system whose members only record that they ran, plus an extra (as port/win32's activate) that reads `this`. */
function fakeWindows() {
  const calls: string[] = [];
  const ws = {
    kind: "win32" as const,
    compositorMayChange: false,
    secret: 41,
    get answer() { return this.secret + 1; },
    activate(id: number) { calls.push(`activate ${id} ${this.secret}`); return true; },
    hasCompositor: () => true,
    pointer() { calls.push("pointer"); return { x: 1, y: 2, mask: 0 }; },
    keysDown: () => null,
    activeWindow: () => null,
    focusWindow: () => null,
    clientWindows: () => [],
    stack: () => [],
    capture: () => null,
    close: () => undefined,
    windowId: () => 7,
    toDip: (r: { x: number; y: number; width: number; height: number }) => r,
    toDipPoint: (p: { x: number; y: number }) => p,
    screenBounds: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  };
  return { ws: ws as typeof ws & WindowSystem, calls };
}

describe("withSystemDialog", () => {
  it("answers systemDialogOpen with the check, and everything else from the backend", () => {
    const { ws } = fakeWindows();
    let open = false;
    const wrapped = withSystemDialog(ws, () => open);
    expect(wrapped.systemDialogOpen()).toBe(false);
    open = true;
    expect(wrapped.systemDialogOpen()).toBe(true);
    expect("systemDialogOpen" in wrapped).toBe(true);
    expect(wrapped.kind).toBe("win32");
    expect(wrapped.compositorMayChange).toBe(false);
    expect(wrapped.windowId({} as OwnWindowHandle)).toBe(7);
  });

  it("keeps a backend's extra members, bound to the backend (a method reading `this` sees the backend, not the proxy)", () => {
    const { ws, calls } = fakeWindows();
    const wrapped = withSystemDialog(ws, () => false);
    expect(wrapped.activate(5)).toBe(true);
    const detached = wrapped.activate;
    detached(6);
    expect(calls).toEqual(["activate 5 41", "activate 6 41"]);
    // Getters run against the backend too.
    expect(wrapped.answer).toBe(42);
    // One bound function per method (the overlay polls pointer() 60 times a second).
    expect(wrapped.pointer).toBe(wrapped.pointer);
  });

  it("lets a throwing check through to the caller, whose own wrapper fails closed", () => {
    const { ws } = fakeWindows();
    const wrapped = withSystemDialog(ws, () => { throw new Error("no desktop"); });
    expect(() => wrapped.systemDialogOpen()).toThrow("no desktop");
    const platformDialog = () => { try { return wrapped.systemDialogOpen(); } catch { return true; } };
    expect(platformDialog()).toBe(true);
  });
});

describe("cleanEnv", () => {
  const env = {
    Path: "C:\\Windows", HOME: "/home/u", GH_TOKEN: "t1", gh_token: "t2", GitHub_Token: "t3", Copilot_Agent: "x",
    MY_API_KEY: "k", aws_secret: "s", DB_PASSWORD: "p", EMBER_LOG_LEVEL: "debug", Ember_Log_Level: "info", EMBER_TEST_HOOKS: "1",
    ember_user_data: "/tmp/e", NODE_OPTIONS: "--inspect", Node_Options: "--require x", ELECTRON_NO_ATTACH_CONSOLE: "1",
    electron_enable_logging: "1", ELECTRON_RUN_AS_NODE: "1", __PSLockdownPolicy: "4", SystemRoot: "C:\\Windows", EMPTY: undefined,
  };

  it("on Windows, drops tokens, Ember's switches and Node's options whatever their case, and keeps the rest", () => {
    const out = cleanEnv(env, { os: "win32" });
    expect(out).toEqual({
      Path: "C:\\Windows", HOME: "/home/u", EMBER_LOG_LEVEL: "debug", Ember_Log_Level: "info", ELECTRON_RUN_AS_NODE: "1",
      __PSLockdownPolicy: "4", SystemRoot: "C:\\Windows",
    });
    // Deleted, not set to "undefined".
    expect(Object.keys(out)).not.toContain("NODE_OPTIONS");
    expect(Object.keys(out)).not.toContain("EMPTY");
  });

  it("keeps the names asked for, in any case on Windows", () => {
    const out = cleanEnv({ EMBER_AX_PROVIDER: "fake", ember_ax_fake_log: "/tmp/l", EMBER_OTHER: "1" }, { os: "win32", keep: ["EMBER_AX_PROVIDER", "EMBER_AX_FAKE_LOG"] });
    expect(out).toEqual({ EMBER_AX_PROVIDER: "fake", ember_ax_fake_log: "/tmp/l" });
  });

  it("elsewhere compares Ember's and Node's names exactly as the OS does, but drops tokens in any case", () => {
    const out = cleanEnv(env, { os: "darwin" });
    expect(out).toEqual({
      Path: "C:\\Windows", HOME: "/home/u", EMBER_LOG_LEVEL: "debug", Ember_Log_Level: "info", ember_user_data: "/tmp/e",
      Node_Options: "--require x", electron_enable_logging: "1", ELECTRON_RUN_AS_NODE: "1", __PSLockdownPolicy: "4", SystemRoot: "C:\\Windows",
    });
  });

  it("doesn't change the environment it is given", () => {
    const given = { GH_TOKEN: "t", PATH: "/bin" };
    cleanEnv(given, { os: "linux" });
    expect(given).toEqual({ GH_TOKEN: "t", PATH: "/bin" });
  });
});

describe("hostEnv", () => {
  const env = { PATH: "/bin", GITHUB_TOKEN: "t", EMBER_AX_PROVIDER: "fake", EMBER_AX_FAKE_DESKTOP: "d.json", EMBER_AX_FAKE_LOG: "l", EMBER_ADMIN_POLICY: "/tmp/p.json" };

  it("names Ember's own process for the host (it never reads Ember's windows), and keeps the test switches only unpackaged", () => {
    expect(hostEnv(env, { os: "darwin", packaged: false, ownerPid: 4242 })).toEqual({
      PATH: "/bin", EMBER_AX_PROVIDER: "fake", EMBER_AX_FAKE_DESKTOP: "d.json", EMBER_AX_FAKE_LOG: "l", EMBER_OWNER_PID: "4242",
    });
    expect(hostEnv(env, { os: "darwin", packaged: true, ownerPid: 4242 })).toEqual({ PATH: "/bin", EMBER_OWNER_PID: "4242" });
  });

  it("drops a mixed-case token on Windows and replaces an inherited owner pid", () => {
    expect(hostEnv({ Path: "C:\\", Gh_Token: "t", Ember_Owner_Pid: "1" }, { os: "win32", packaged: true, ownerPid: 9 })).toEqual({ Path: "C:\\", EMBER_OWNER_PID: "9" });
  });
});

describe("hoverShaper (Windows and macOS)", () => {
  it("has no input region, so OverlayManager's hover polling runs, and closes nothing", () => {
    for (const os of ["win32", "darwin"] as const) {
      const s = hoverShaper(os);
      expect(s.setInputRegion({} as OwnWindowHandle, [{ x: 0, y: 0, width: 5, height: 5 }], 1)).toBe(false);
      expect(() => s.release()).not.toThrow();
    }
  });

  it("forwards the pointer through click-through windows only on macOS (on Windows that would hook every app's mouse)", () => {
    expect(hoverShaper("darwin").forward).toBe(true);
    expect(hoverShaper("win32").forward).toBe(false);
  });

  it("makes Windows' overlay, handle and ask box tool windows without a thick frame or rounded corners", () => {
    const s = hoverShaper("win32");
    for (const kind of ["overlay", "handle", "ask"] as const) {
      expect(s.floating(kind)).toEqual({ options: { type: "toolbar", thickFrame: false, roundedCorners: false }, allWorkspaces: null });
    }
    expect(s.floating("desk-view")).toEqual({ options: {}, allWorkspaces: null });
  });

  it("makes macOS's floating windows panels that take the first click, with the ask box keeping its corners", () => {
    const s = hoverShaper("darwin");
    for (const kind of ["overlay", "handle"] as const) {
      expect(s.floating(kind)).toEqual({ options: { type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, roundedCorners: false }, allWorkspaces: null });
    }
    expect(s.floating("ask")).toEqual({ options: { type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true }, allWorkspaces: null });
    expect(s.floating("desk-view")).toEqual({ options: {}, allWorkspaces: null });
  });

  it("never asks macOS to put a window on every Space in a way that transforms the process (Dock icon, menu bar, focus) (M1)", () => {
    const s = hoverShaper("darwin");
    for (const kind of KINDS) {
      const rule = s.floating(kind).allWorkspaces;
      expect(rule === null || (typeof rule === "object" && rule.skipTransformProcessType === true)).toBe(true);
      // Today: no call at all (a panel already joins every Space).
      expect(rule).toBeNull();
    }
  });

  it("hands out copies: a caller changing one doesn't change the next", () => {
    const s = hoverShaper("win32");
    (s.floating("overlay").options as Record<string, unknown>).type = "panel";
    expect(s.floating("overlay").options.type).toBe("toolbar");
  });
});

describe("the Linux overlay shaper's floating windows", () => {
  it("are today's windows exactly: no extra options, the overlay over full-screen apps, the handle on every workspace", () => {
    const s = linuxOverlayShaper();
    expect(s.forward).toBe(false);
    expect(s.floating("overlay")).toEqual({ options: {}, allWorkspaces: { visibleOnFullScreen: true } });
    expect(s.floating("handle")).toEqual({ options: {}, allWorkspaces: "plain" });
    expect(s.floating("ask")).toEqual({ options: {}, allWorkspaces: null });
    expect(s.floating("desk-view")).toEqual({ options: {}, allWorkspaces: null });
  });
});

describe("applyAllWorkspaces", () => {
  it("makes no call for null, today's plain call for \"plain\", and passes an object on", () => {
    const win = { setVisibleOnAllWorkspaces: vi.fn() };
    applyAllWorkspaces(win, null);
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
    applyAllWorkspaces(win, "plain");
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(true);
    expect(win.setVisibleOnAllWorkspaces.mock.lastCall).toHaveLength(1);
    applyAllWorkspaces(win, { visibleOnFullScreen: true });
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(true, { visibleOnFullScreen: true });
  });
});

describe("primaryScaledUnion", () => {
  it("is every display's DIP bounds together, times the primary display's scale (X11's one global scale)", () => {
    const screen = {
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 2 }),
      getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 2 }, { bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 }],
    };
    expect(primaryScaledUnion(screen)).toEqual({ x: -3840, y: -400, width: 6400, height: 2160 });
    expect(primaryScaledUnion({ ...screen, getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 0 }) }).width).toBe(3200);
  });
});

describe("toHelperStatus", () => {
  it("keeps the host's status fields of the right type only (another process's answer is data)", () => {
    expect(toHelperStatus({ toolkitAccessibility: true, detail: "PowerShell refused to run the bridge (execution policy)", languageMode: "FullLanguage", dpi: "PerMonitorV2", processDpi: "PerMonitorV2" }))
      .toEqual({ toolkitAccessibility: true, detail: "PowerShell refused to run the bridge (execution policy)", languageMode: "FullLanguage", dpi: "PerMonitorV2", processDpi: "PerMonitorV2" });
    expect(toHelperStatus({ toolkitAccessibility: "yes", detail: 5, languageMode: null })).toEqual({ toolkitAccessibility: null });
    expect(toHelperStatus({ toolkitAccessibility: false })).toEqual({ toolkitAccessibility: false });
  });
});
