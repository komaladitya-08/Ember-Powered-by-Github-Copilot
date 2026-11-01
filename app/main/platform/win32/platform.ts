/**
 * The Windows platform object (§7.1): port/win32's window system and input (opened after app ready, when Electron's
 * screen works), with systemDialogOpen added (§7.2), hover polling for Ember's floating windows (no input region on
 * Windows; tool windows so they show on every virtual desktop), the shared accessibility host started as Ember's own
 * program with the UI Automation bridge's script and cache, and the Windows SystemPlatform. There is no keyboard
 * hold, no X clipboard and no desk on Windows. loadPlatform() picks this by process.platform (Phase 3).
 *
 * Constructing it touches no Electron object and loads no native library (PlatformDeps' rule): only openWindows(),
 * openInput(), sidecarLaunch() and the system probes do, and main calls those after ready.
 */

import path from "node:path";
import { hostLaunch } from "../../../sidecar-host/launch";
import type { Logger } from "../../logger";
import type { Platform, PlatformDeps } from "../types";
import { loadWin32, win32Error, type Win32Api } from "./ffi";
import { openWin32Input } from "./input";
import { win32System, type Win32SystemOptions } from "./system";
import { loadWin32System } from "./system/ffi";
import { hostEnv, hoverShaper, isSecurityClass, isSecurityWindow, withSystemDialog } from "./system/interim";
import { win32SystemDialog, type SecurityVocabulary } from "./system/system-dialog";
import { openWin32Windows } from "./windows";

/** The Windows security vocabulary systemDialogOpen matches (policy/vocabulary.ts's win32 rows). */
const SECURITY: SecurityVocabulary = { isSecurityWindow: w => isSecurityWindow(w, "win32"), isSecurityClass };

/** What tests may replace. */
export interface Win32PlatformOptions extends Win32SystemOptions {
  openWindows?: typeof openWin32Windows;
  openInput?: typeof openWin32Input;
  /** port/win32's bindings (default loadWin32), for systemDialogOpen. */
  win32Api?: () => Win32Api | null;
}

/** The Windows Platform. */
export function win32Platform(deps: PlatformDeps, o: Win32PlatformOptions = {}): Platform {
  /** Ember's root logger, from the first open (the system's few log lines go there). */
  let rootLog: Logger | null = null;
  const sysApi = o.api ?? loadWin32System;
  const system = win32System(deps, { ...o, api: sysApi, log: () => rootLog });
  const openWindows = o.openWindows ?? openWin32Windows;
  const openInput = o.openInput ?? openWin32Input;
  const win32Api = o.win32Api ?? loadWin32;
  return {
    os: "win32",
    system,
    openWindows: log => {
      rootLog ??= log;
      const ws = openWindows({ screen: deps.electron.screen }); // only called after app ready (main §4.1 item 28)
      if (!ws) {
        log.error("platform.windows_unavailable", { err: win32Error });
        return null;
      }
      // Keeps Win32WindowSystem's extras (activate, the synchronous capture); the bindings are port/win32's, memoised.
      return withSystemDialog(ws, () => {
        const sys = sysApi();
        return win32SystemDialog(ws, win32Api(), sys ? hwnd => sys.monitorRect(hwnd) : null, SECURITY);
      });
    },
    openInput: (_ws, log) => {
      if (log) rootLog ??= log;
      const input = openInput();
      if (!input) log?.error("platform.input_unavailable", { err: win32Error });
      return input;
    },
    // RegisterHotKey fires once per press: main trusts and debounces it (G6).
    shortcutsReReported: false,
    overlay: hoverShaper("win32"),
    keyboardHold: null,
    clipboard: null,
    desk: null,
    sidecarLaunch: ctx => hostLaunch({
      execPath: ctx.execPath,
      host: path.win32.join(ctx.appDir, "ax-sidecar.cjs"),
      uiaScript: path.win32.join(ctx.packaged ? ctx.resourcesPath : ctx.appPath, "sidecar", "uia", "ember_uia.ps1"),
      uiaCache: path.win32.join(ctx.userData, "uia-cache"),
      env: hostEnv(deps.env, { os: "win32", packaged: ctx.packaged, ownerPid: process.pid }),
      platform: "win32",
      packaged: ctx.packaged,
    }),
  };
}
