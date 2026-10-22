/**
 * Ember's Platform on macOS (design §8.1): port/darwin's window system and input, with pixels from Electron's
 * desktopCapturer (electron-capture.ts) and Screen Recording read from Electron; click-through by hover polling and
 * non-activating panels for the overlay, handle and ask box (compose.ts hoverShaper); the shared accessibility host
 * run by Ember's own binary (port/host's hostLaunch); no desk, no X keyboard hold and no X clipboard; and the macOS
 * SystemPlatform (system/). Building it touches nothing of `screen`, desktopCapturer, powerMonitor or BrowserWindow
 * and loads no native library: main builds it before app ready, and koffi loads only when openWindows/openInput run.
 * There is no second secure-input or dialog check here: port/darwin's systemDialogOpen() is the one (§8.4).
 */

import path from "node:path";
import type { Platform, PlatformDeps, WindowSystem } from "../types";
import type { Logger } from "../../logger";
import { hoverShaper, hostEnv } from "../compose";
import { hostLaunch } from "../../../sidecar-host/launch";
import { openDarwinInput, openDarwinWindows, darwinInputError, darwinWindowsError } from "./index";
import { electronCapture } from "./electron-capture";
import { darwinSystem, type DarwinSystemSeams } from "./system";

/** Seams for the tests: the backends' openers (default port/darwin's), and the system modules' seams. */
export interface DarwinPlatformSeams extends Omit<DarwinSystemSeams, "windows" | "log"> {
  openWindows?: typeof openDarwinWindows;
  openInput?: typeof openDarwinInput;
}

/** The macOS platform object. */
export function darwinPlatform(deps: PlatformDeps, seams: DarwinPlatformSeams = {}): Platform {
  const { openWindows: openWs = openDarwinWindows, openInput: openIn = openDarwinInput, ...systemSeams } = seams;
  const { screen, desktopCapturer, systemPreferences, browserWindow } = deps.electron;
  // What openWindows returned, for the permission reads, fixes and doctor rows (undefined until it ran).
  let ws: WindowSystem | null | undefined;
  // Ember's logger, from openWindows (main has none to give before ready): the system modules log through it.
  let logger: Logger | null = null;
  const system = darwinSystem(deps, { ...systemSeams, windows: () => ws, log: () => logger });
  const screenAccess = () => systemPreferences.getMediaAccessStatus?.("screen") === "granted";
  // Ember's key panel (the ask box) has the keyboard while the user's app stays active: focus reads report it.
  const focusedOwnWindow = () => browserWindow.getFocusedWindow();

  return {
    os: "darwin",
    system,
    openWindows(log) {
      logger = log;
      ws = openWs({ screen, screenAccess, capture: electronCapture({ desktopCapturer, screen, log }), focusedOwnWindow, log });
      if (!ws) log.error("platform.windows_unavailable", { err: darwinWindowsError });
      return ws;
    },
    openInput(_ws, log) {
      // The doctor passes no logger: nothing is logged then.
      const input = openIn({ focusedOwnWindow, ...(log ? { log } : {}) });
      if (!input) log?.error("platform.input_unavailable", { err: darwinInputError });
      return input;
    },
    shortcutsReReported: false,
    overlay: hoverShaper("darwin"),
    keyboardHold: null,
    clipboard: null,
    desk: null,
    sidecarLaunch: ctx => hostLaunch({
      execPath: ctx.execPath,
      host: path.join(ctx.appDir, "ax-sidecar.cjs"),
      env: hostEnv(deps.env, { os: "darwin", packaged: ctx.packaged, ownerPid: process.pid }),
      platform: "darwin",
      packaged: ctx.packaged,
    }),
  };
}
