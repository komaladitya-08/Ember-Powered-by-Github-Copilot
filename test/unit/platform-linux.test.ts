/**
 * The Linux composition (platform/linux/index.ts): today's modules behind the Platform object. Built before app ready,
 * it touches nothing of Electron's `screen` and calls no app.getPath (Electron's screen throws before ready; userData
 * isn't set yet); X11 and XTest load only when opened, and only with $DISPLAY; the doctor's openInput logs nothing, as
 * it never did. libX11 is a fake here, put in Node's require cache where x11.ts and hands/input.ts load koffi from.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { loadPlatform } from "../../app/main/platform";
import type * as LinuxWindowSystem from "../../app/main/platform/linux/window-system";

/** An X11 window system the platform's openWindows gets in place of opening libX11 (null: the real openLinuxWindows). */
const openedX11 = vi.hoisted(() => ({ ws: null as WindowSystem | null }));
vi.mock("../../app/main/platform/linux/window-system", async importOriginal => {
  const real = await importOriginal<typeof LinuxWindowSystem>();
  return { ...real, openLinuxWindows: (o: Parameters<typeof real.openLinuxWindows>[0]) => (o.env.DISPLAY && openedX11.ws) || real.openLinuxWindows(o) };
});
import { linuxDesk } from "../../app/main/platform/linux/desk";
import { DeskManager } from "../../app/main/desk/desk";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import type { Logger } from "../../app/main/logger";
import type { ElectronParts, OwnWindowHandle, PlatformDeps, WindowSystem } from "../../app/main/platform/types";

/** Every library koffi was asked to load, in order. */
let loads: string[] = [];

const requireCjs = createRequire(import.meta.url);
const koffiPath = requireCjs.resolve("koffi");
let realKoffi: NodeModule | undefined;

beforeEach(() => {
  loads = [];
  realKoffi = requireCjs.cache[koffiPath];
  // Any library: missing (as on a machine without libX11 or libXtst).
  const fake = { load(name: string) { loads.push(name); throw new Error(`${name}: cannot open shared object file`); } };
  requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: fake } as unknown as NodeModule;
});

afterEach(() => {
  openedX11.ws = null;
  if (realKoffi) requireCjs.cache[koffiPath] = realKoffi;
  else delete requireCjs.cache[koffiPath];
});

/** An object any property access of which throws (Electron's screen before ready, and what nothing may touch). */
const untouchable = <T extends object>(what: string): T => new Proxy({}, { get(_t, key) { throw new Error(`${what}.${String(key)} touched while building the platform`); } }) as T;

function deps(env: NodeJS.ProcessEnv = {}): PlatformDeps {
  const electron: ElectronParts = {
    app: {
      isPackaged: false,
      getPath: () => { throw new Error("app.getPath called before userData is set"); },
      getAppPath: () => "/repo",
      getVersion: () => "0.0.0",
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
  };
  return { electron, packaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo", resourcesPath: "/repo/node_modules/electron/dist/resources", env };
}

function recordingLog() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (event: string, fields?: Record<string, unknown>) => { events.push({ level, event, fields }); };
  const log = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => log } as unknown as Logger;
  return { log, events };
}

const handleOf = (xid: number): OwnWindowHandle => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(xid, 0);
  return { getNativeWindowHandle: () => b, getMediaSourceId: () => "window:1:0" };
};

describe("the Linux platform", () => {
  it("is built without touching Electron's screen, desktopCapturer, powerMonitor or BrowserWindow, or asking app.getPath (L14)", () => {
    expect(() => loadPlatform(deps({ DISPLAY: ":0" }), "linux")).not.toThrow();
    expect(loads).toEqual([]);
  });

  it("is Linux's, with X11's re-reported shortcuts, XShape, the keyboard hold, the X clipboard and the desk", () => {
    const p = loadPlatform(deps(), "linux");
    expect(p.os).toBe("linux");
    expect(p.shortcutsReReported).toBe(true);
    expect(p.overlay.forward).toBe(false);
    expect(typeof p.keyboardHold).toBe("function");
    expect(p.clipboard).not.toBeNull();
    expect(p.desk).toBe(linuxDesk);
  });

  it("starts the Python AT-SPI sidecar as always (no launch of its own)", () => {
    const p = loadPlatform(deps(), "linux");
    expect(p.sidecarLaunch({ appDir: "/repo/dist/app", appPath: "/repo", resourcesPath: "/r", packaged: false, userData: "/u", execPath: "/e" })).toBeUndefined();
  });

  it("opens no window system without $DISPLAY, and no input without one, without loading any library", () => {
    const p = loadPlatform(deps({}), "linux");
    expect(p.openWindows(recordingLog().log)).toBeNull();
    expect(p.openInput(null, recordingLog().log)).toBeNull();
    expect(loads).toEqual([]);
  });

  it("with $DISPLAY tries X11 when opened, and is null when libX11 can't load", () => {
    const p = loadPlatform(deps({ DISPLAY: ":99" }), "linux");
    expect(p.openWindows(recordingLog().log)).toBeNull();
    expect(loads).toEqual(["libX11.so.6"]);
  });

  describe("in a Wayland session (review #240)", () => {
    const WAYLAND = "this is a Wayland session, so Ember can't take screenshots or use the mouse and keyboard here: log out and choose “GNOME on Xorg” on the login screen";
    /** What openLinuxWindows gives once X opened: no system-dialog check of its own, as on Xorg. */
    const x11 = (): WindowSystem => ({ kind: "x11", activeWindow: () => ({ id: 1, pid: 77, title: "Notes", x: 0, y: 0, width: 10, height: 10, wmClass: "gedit gedit" }) }) as unknown as WindowSystem;

    it("keeps Ember from screenshots and the mouse on this computer, saying why: XWayland shows it only X11 apps", () => {
      for (const env of [{ DISPLAY: ":0", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }]) {
        openedX11.ws = x11();
        const ws = loadPlatform(deps(env), "linux").openWindows(recordingLog().log)!;
        expect(ws.systemDialogOpen?.()).toBe(true);
        expect(ws.systemDialogReason?.()).toBe(WAYLAND);
        // Reading through XWayland still works as it did (the accessibility tree is the session's own).
        expect(ws.activeWindow()?.title).toBe("Notes");
      }
    });

    it("changes nothing on Xorg, nor where the session type is unset without a Wayland display (Xvfb, xrdp, ssh -X)", () => {
      for (const env of [{ DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, { DISPLAY: ":0", XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" }, { DISPLAY: ":55" }]) {
        const opened = openedX11.ws = x11();
        const ws = loadPlatform(deps(env), "linux").openWindows(recordingLog().log)!;
        expect(ws).toBe(opened);
        expect("systemDialogOpen" in ws).toBe(false);
      }
    });

    it("is still null when X can't be opened there", () => {
      expect(loadPlatform(deps({ DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" }), "linux").openWindows(recordingLog().log)).toBeNull();
      expect(loadPlatform(deps({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }), "linux").openWindows(recordingLog().log)).toBeNull();
    });
  });

  it("warns xtest.unavailable with XTest's error on the logger it is given, as main did", () => {
    const p = loadPlatform(deps({ DISPLAY: ":0" }), "linux");
    const { log, events } = recordingLog();
    expect(p.openInput({ kind: "x11" } as WindowSystem, log)).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "warn", event: "xtest.unavailable" });
    expect(String(events[0]!.fields?.err)).toContain("libX11.so.6");
  });

  it("logs nothing when the doctor opens input without a logger (it never logged xtest.unavailable)", () => {
    const p = loadPlatform(deps({ DISPLAY: ":0" }), "linux");
    const { events } = recordingLog();
    expect(p.openInput({ kind: "x11" } as WindowSystem, null)).toBeNull();
    expect(events).toEqual([]);
  });

  it("tells Ember's clipboard apart by an X id only with $DISPLAY (today's gate)", () => {
    expect(loadPlatform(deps({ DISPLAY: ":0" }), "linux").clipboard!.ownerId(handleOf(0x3a00007))).toBe(0x3a00007);
    expect(loadPlatform(deps({}), "linux").clipboard!.ownerId(handleOf(0x3a00007))).toBe(0);
  });

  it("offers the desk exactly when DeskManager says it can start", () => {
    expect(linuxDesk.available()).toEqual(DeskManager.available());
  });

  it("carries today's Linux system: shortcuts, Chromium switch, data folder, fixes and lifecycle", () => {
    const sys = loadPlatform(deps(), "linux").system;
    expect(sys.os).toBe("linux");
    expect(sys.shortcuts).toBe(SHORTCUTS.linux);
    expect(sys.chromiumSwitches).toEqual(["enable-speech-dispatcher"]);
    // "/home/u/.config/ember" on Linux; path.join's own separators where this suite also runs (Windows CI).
    expect(sys.paths.userData("/home/u/.config", "/home/u")).toBe(path.join("/home/u/.config", "ember"));
    expect(sys.fixes.ids).toEqual(["enable-accessibility"]);
    expect(sys.lifecycle.sessionEnd).toBeNull();
    expect(sys.lifecycle.appMenu).toBe(false);
    expect(sys.lifecycle.appUserModelId).toBeNull();
    expect(sys.lifecycle.activateOwnWithInput).toBe(true);
    expect(sys.lifecycle.activateForAsk).toBe(true);
    expect(sys.voice.speakerMonitor).toBe(true);
    expect(loads).toEqual([]);
  });
});
