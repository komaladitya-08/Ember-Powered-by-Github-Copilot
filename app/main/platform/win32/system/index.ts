/**
 * Windows' SystemPlatform (§9): everything OS-specific beyond the window system and input, assembled from this
 * folder's modules. Constructing it touches nothing native and no Electron object (PlatformDeps' rule: main builds
 * the platform before app ready): koffi binds on the first call that needs Windows, and Electron's app, shell and
 * systemPreferences are only called when a member runs. Plain Node, unit-tested on Linux with fakes.
 */

import fs from "node:fs";
import { KEYS, SHORTCUTS } from "../../../../shared/shortcuts";
import { PLATFORM_WORDS } from "../../../../shared/words";
import type { Logger } from "../../../logger";
import type { PlatformDeps, SystemPlatform } from "../../types";
import { win32A11y } from "./a11y";
import { win32AdminPolicy } from "./admin-policy";
import { win32Apps, type AppsFs, type Win32AppsDeps } from "./apps";
import { win32Autostart } from "./autostart";
import { win32DoctorProbes } from "./doctor";
import { win32Environment } from "./environment";
import { loadWin32System, type Win32SysApi } from "./ffi";
import { CLIPBOARD_FORMATS_WIN32, isSecurityWindow, NEVER_LOOK_DEFAULTS_WIN32 } from "./interim";
import { knownFolders } from "./known-folders";
import { win32Lifecycle } from "./lifecycle";
import { bundledModelDirs, win32Paths, win32Which } from "./paths";
import { helperDir, powershellFacts } from "./powershell";
import { win32Settings } from "./settings";

/** What tests (and the composition) may replace. */
export interface Win32SystemOptions {
  /** The system calls (default: loadWin32System, bound on first use; null off Windows). */
  api?: () => Win32SysApi | null;
  /** Ember's root logger, once main has handed one to the platform (null before). */
  log?: () => Logger | null;
  fs?: AppsFs;
  spawn?: Win32AppsDeps["spawn"];
  /** Is this path an existing file (which, gh)? */
  isFile?: (p: string) => boolean;
  now?: () => number;
}

const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Windows' SystemPlatform. */
export function win32System(deps: PlatformDeps, o: Win32SystemOptions = {}): SystemPlatform {
  const api = o.api ?? loadWin32System;
  const log = o.log ?? (() => null);
  const env = deps.env;
  const folders = knownFolders(api);
  const helper = helperDir(deps);
  const powershell = powershellFacts({ api, env, dir: helper, now: o.now });
  const environment = win32Environment({ env, api, powershell, shell: deps.electron.shell, systemPreferences: deps.electron.systemPreferences });
  const lookup = win32Which({ env, programData: folders.programData, isFile: o.isFile ?? isFile, now: o.now });
  return {
    os: "win32",
    words: PLATFORM_WORDS.win32,
    shortcuts: SHORTCUTS.win32,
    keys: KEYS.win32,
    paths: win32Paths({ env }),
    apps: win32Apps({
      env, execPath: deps.execPath, folders, packageInstalled: family => api()?.packageFamilyInstalled(family) ?? null,
      fs: o.fs, spawn: o.spawn, now: o.now, log,
    }),
    settings: win32Settings({ api, log }),
    adminPolicy: win32AdminPolicy({ api, env }),
    autostart: win32Autostart({ app: deps.electron.app, packaged: deps.packaged, execPath: deps.execPath, appPath: deps.appPath }),
    auditSink: () => undefined, // D7: the file audit log only
    auditCopy: () => null,
    ghCliPath: () => lookup.ghCliPath(),
    which: cmd => lookup.which(cmd),
    spawnDefaults: { windowsHide: true },
    chromiumSwitches: [],
    environment: ctx => environment.environment(ctx),
    fixes: environment.fixes,
    doctorProbes: () => win32DoctorProbes({
      env, api, powershell, helperDir: helper, app: deps.electron.app, systemPreferences: deps.electron.systemPreferences,
    }),
    a11y: win32A11y({ api, systemPreferences: deps.electron.systemPreferences, now: o.now }),
    voice: { speakerMonitor: false, bundledModelDirs: res => bundledModelDirs(res, folders.programData()) },
    privacy: { neverLookDefaults: NEVER_LOOK_DEFAULTS_WIN32, isSecurityWindow: w => isSecurityWindow(w, "win32") },
    clipboardFormats: CLIPBOARD_FORMATS_WIN32,
    lifecycle: win32Lifecycle({ packaged: deps.packaged, execPath: deps.execPath, programs: folders.programs, shell: deps.electron.shell, log }),
  };
}
