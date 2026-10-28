/**
 * Linux's SystemPlatform: thin adapters over the modules Ember has always used (XDG apps and gsettings in
 * hands/system.ts, the XDG autostart entry, /etc/ember/policy.json, the systemd journal, GNOME's accessibility
 * switches), called with today's arguments, so Linux behaves exactly as before (design §3). Constructing it touches
 * nothing (no Electron call, no file, no process): each member does its work when it is asked.
 */

import path from "node:path";
import type { PlatformDeps, SystemPlatform } from "../types";
import { which } from "../which";
import { linuxEnvironment, execSync, type ExecSync } from "./environment";
import { linuxDoctorProbes } from "./doctor-probes";
import { SETTINGS, changeSetting, findApp, hasBuiltInShell, isTerminalApp, launchApp, listApps, programsOf } from "../../hands/system";
import { ADMIN_POLICY_FILE, loadAdminPolicy, providerApiKey } from "../../admin";
import { autostartFile, foreignAutostartNote, launchCommand, syncAutostart } from "../../autostart";
import { journalAvailable, journalSink } from "../../policy/audit";
import { isSecurityWindow } from "../../policy/policy";
import { CLIPBOARD_FORMATS } from "../../agent/clipboard-formats";
import { NEVER_LOOK_DEFAULTS } from "../../../shared/never-look";
import { KEYS, SHORTCUTS } from "../../../shared/shortcuts";
import { PLATFORM_WORDS } from "../../../shared/words";

/** The machine's state as the adapters read it; tests pass fakes, Ember the real thing. */
export interface LinuxSystemIO {
  exec?: ExecSync;
  exists?: (file: string) => boolean;
  /** For the screen-reader cache (60 s, as before). */
  setTimeout?: (fn: () => void, ms: number) => { unref?(): unknown };
}

/** Where the settings window says the audit copy goes, when systemd-cat can write to the journal. */
const JOURNAL_COPY = "the system journal (journalctl -t ember-audit)";

/** The Linux SystemPlatform for `deps` (main's PlatformDeps). */
export function linuxSystem(deps: PlatformDeps, io: LinuxSystemIO = {}): SystemPlatform {
  const exec = io.exec ?? execSync;
  const later = io.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const whichLinux = (cmd: string) => which(cmd, { os: "linux", env: deps.env });

  let screenReader: boolean | null = null;
  /** Orca running (GNOME's screen-reader switch, asked at most once a minute), or anything else using Chromium's accessibility. */
  const screenReaderOn = (): boolean => {
    if (screenReader === null) {
      try { screenReader = exec("gsettings", ["get", "org.gnome.desktop.a11y.applications", "screen-reader-enabled"], { encoding: "utf8", timeout: 2000 }).trim() === "true"; } catch { screenReader = false; }
      later(() => { screenReader = null; }, 60_000).unref?.();
    }
    return screenReader || deps.electron.app.isAccessibilitySupportEnabled();
  };

  return {
    os: "linux",
    words: PLATFORM_WORDS.linux,
    shortcuts: SHORTCUTS.linux,
    keys: KEYS.linux,
    paths: {
      userData: (appData, _home) => path.join(appData, "ember"),
      runtimeId: "linux-x64",
      runtimeExe: "copilot-runtime",
      // The settings window has always shown this fixed text (EMBER_USER_DATA is a development switch).
      dataDirLabel: (_userData, file) => `~/.config/ember${file ? `/${file}` : ""}`,
      renameRetries: 0,
    },
    apps: {
      list: () => listApps(deps.env),
      find: (apps, query) => findApp(apps, query),
      launch: app => launchApp(app),
      isTerminalApp: app => isTerminalApp(app),
      hasBuiltInShell: app => hasBuiltInShell(app),
      programsOf: app => programsOf(app),
      appKey: name => name.toLowerCase(),
    },
    settings: { available: SETTINGS, change: (name, value) => changeSetting(name, value) },
    adminPolicy: {
      location: ADMIN_POLICY_FILE,
      load: dev => (dev === undefined ? loadAdminPolicy() : loadAdminPolicy(dev)),
      providerApiKey: p => providerApiKey(p),
    },
    autostart: {
      sync: on => syncAutostart(on, launchCommand({ packaged: deps.packaged, execPath: deps.execPath, appPath: deps.appPath, env: deps.env }), autostartFile(deps.env)),
      launchedAtLogin: argv => argv.includes("--autostart"),
      // An entry the user or an admin made starts Ember whatever the switch says (review #85).
      note: () => foreignAutostartNote(autostartFile(deps.env)),
    },
    auditSink: onError => journalSink(onError),
    auditCopy: () => (journalAvailable(io.exists) ? JOURNAL_COPY : null),
    // Always "gh" from PATH, as before.
    ghCliPath: () => null,
    which: whichLinux,
    spawnDefaults: {},
    // Chromium on Linux speaks (speechSynthesis) only through speech-dispatcher, and only with this switch.
    chromiumSwitches: ["enable-speech-dispatcher"],
    environment: linuxEnvironment({ env: deps.env, exec }),
    fixes: {
      ids: ["enable-accessibility"],
      apply: async fix => {
        if (fix !== "enable-accessibility") throw new Error(`unknown fix: ${fix}`);
        exec("gsettings", ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"], { timeout: 5000 });
      },
      label: () => "Turn on",
    },
    doctorProbes: () => linuxDoctorProbes({ execPath: deps.execPath, which: whichLinux, exec, exists: io.exists }),
    a11y: {
      screenReaderOn,
      // GNOME's "Animations" switch off counts as asking for calm mode.
      systemReducedMotion: () => {
        try { return exec("gsettings", ["get", "org.gnome.desktop.interface", "enable-animations"], { encoding: "utf8", timeout: 2000 }).trim() === "false"; } catch { return false; }
      },
    },
    voice: {
      speakerMonitor: true,
      // Speech models installed with Ember (the ember-voice-models package), then those in the AppImage's resources.
      bundledModelDirs: resourcesPath => ["/usr/share/ember/voice-models", path.join(resourcesPath, "voice-models")],
    },
    privacy: { neverLookDefaults: NEVER_LOOK_DEFAULTS.linux, isSecurityWindow: w => isSecurityWindow(w) },
    clipboardFormats: CLIPBOARD_FORMATS.linux,
    lifecycle: {
      appUserModelId: null,
      ensureShortcut() { /* only Windows' toasts need a Start Menu shortcut */ },
      appMenu: false,
      reopenShowsSettings: false,
      sessionEnd: null,
      focusOwnApp() { /* GNOME lets Ember's own windows take focus */ },
      activateOwnWithInput: true,
      activateForAsk: true,
    },
  };
}
