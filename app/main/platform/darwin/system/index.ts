/**
 * Ember's SystemPlatform on macOS (design §9): words, shortcuts and keys for a Mac; data in ~/Library/Application
 * Support/ember; .app bundles opened through LaunchServices; Dark Mode through System Events; the administrator's
 * policy in /Library/Application Support/Ember; a login item through SMAppService; the permission checks, fixes and
 * doctor rows; VoiceOver and reduced motion; and the app lifecycle. Plain Node: Electron's objects come from
 * PlatformDeps, and nothing here touches `screen`, desktopCapturer, powerMonitor or BrowserWindow, or calls
 * app.getPath, while it is built (main builds it before app ready); the permission reads use the window system
 * darwinPlatform opens later, through `seams.windows`.
 */

import os from "node:os";
import path from "node:path";
import type { PlatformDeps, SystemPlatform, WindowSystem } from "../../types";
import { PLATFORM_WORDS } from "../../../../shared/words";
import { KEYS, SHORTCUTS } from "../../../../shared/shortcuts";
import { NEVER_LOOK_DEFAULTS } from "../../../../shared/never-look";
import { isSecurityWindow } from "../../../policy/policy";
import { CLIPBOARD_FORMATS } from "../../../agent/clipboard-formats";
import { which } from "../../which";
import { darwinApps } from "./apps";
import { darwinSettings } from "./settings";
import { darwinAdminPolicy } from "./admin-policy";
import { darwinAutostart } from "./autostart";
import { darwinEnvironment, darwinFixes, type DarwinEnvDeps } from "./environment";
import { darwinDoctorProbes } from "./doctor";
import { darwinA11y } from "./a11y";
import { darwinLifecycle } from "./lifecycle";
import { execRun, type Run } from "./exec";

/** macOS paths are POSIX paths: joined as such wherever this module runs (its unit tests run on Windows too). */
const mac = path.posix;

/** Where Homebrew, MacPorts and pipx put command-line tools: apps started from Finder get launchd's PATH without them. */
export function extraBinDirs(home: string): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", mac.join(home, ".local", "bin")];
}

/** How long a found (or missing) gh is remembered: the sign-in loop asks every 3 s. */
export const GH_CACHE_MS = 60_000;

/** What darwinPlatform shares with the system modules, and seams for the tests. */
export interface DarwinSystemSeams {
  /** The window system darwinPlatform opened (undefined before openWindows ran, null when it couldn't). */
  windows?: () => WindowSystem | null | undefined;
  run?: Run;
  home?: () => string;
  now?: () => number;
  /** Is this file there and executable (which and gh)? */
  isExecutable?: (p: string) => boolean;
  /** Schedules the VoiceOver probe (tests pass a no-op). */
  every?: (fn: () => void, ms: number) => void;
}

/** The macOS SystemPlatform. */
export function darwinSystem(deps: PlatformDeps, seams: DarwinSystemSeams = {}): SystemPlatform {
  const { app, systemPreferences, shell, desktopCapturer } = deps.electron;
  const run = seams.run ?? execRun;
  const home = seams.home ?? os.homedir;
  const now = seams.now ?? Date.now;
  const windows = seams.windows ?? (() => undefined);
  const envDeps: DarwinEnvDeps = { env: deps.env, app, systemPreferences, desktopCapturer, shell, windows, run };

  const whichDarwin = (cmd: string): string | null =>
    which(cmd, { os: "darwin", env: deps.env, extraDirs: extraBinDirs(home()), ...(seams.isExecutable ? { isExecutable: seams.isExecutable } : {}) });
  let gh: { at: number; path: string | null } | null = null;

  return {
    os: "darwin",
    words: PLATFORM_WORDS.darwin,
    shortcuts: SHORTCUTS.darwin,
    keys: KEYS.darwin,
    paths: {
      userData: (appData: string) => mac.join(appData, "ember"),
      runtimeId: `darwin-${process.arch}`,
      runtimeExe: "copilot-runtime",
      dataDirLabel(userData: string, file?: string): string {
        const h = home();
        const shown = userData === h ? "~" : userData.startsWith(h + "/") ? `~${userData.slice(h.length)}` : userData;
        return file ? `${shown}/${file}` : shown;
      },
      renameRetries: 0,
    },
    apps: darwinApps({ env: deps.env, run, home, now }),
    settings: darwinSettings({ run }),
    adminPolicy: darwinAdminPolicy(),
    autostart: darwinAutostart(app),
    // D7: the file audit log only; macOS's unified log is not a place users or admins read Ember's record.
    auditSink: () => undefined,
    auditCopy: () => null,
    ghCliPath(): string | null {
      if (gh && now() - gh.at < GH_CACHE_MS) return gh.path;
      // which() already looks in Homebrew's, MacPorts' and ~/.local's folders (launchd's PATH has none of them).
      gh = { at: now(), path: whichDarwin("gh") };
      return gh.path;
    },
    which: whichDarwin,
    spawnDefaults: {},
    chromiumSwitches: [],
    environment: ctx => darwinEnvironment(envDeps, ctx),
    fixes: darwinFixes(envDeps),
    doctorProbes: () => darwinDoctorProbes(envDeps),
    a11y: darwinA11y({ systemPreferences, run, ...(seams.every ? { every: seams.every } : {}) }),
    voice: {
      speakerMonitor: false,
      bundledModelDirs: (resourcesPath: string) => [mac.join(resourcesPath, "voice-models"), "/Library/Application Support/Ember/voice-models"],
    },
    privacy: {
      neverLookDefaults: NEVER_LOOK_DEFAULTS.darwin,
      isSecurityWindow: w => isSecurityWindow(w, "darwin"),
    },
    clipboardFormats: CLIPBOARD_FORMATS.darwin,
    lifecycle: darwinLifecycle({ app, systemPreferences }),
  };
}
