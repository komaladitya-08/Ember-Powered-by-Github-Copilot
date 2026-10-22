/**
 * The functions and data the Windows composition takes from other packages of the port that run at the same time as
 * this one (the design's §2.5, §4.10-4.18 and §9.11): Phase 1's compose.ts (withSystemDialog, hostEnv, hoverShaper),
 * which.ts, hands/system.ts (parseOnOff, appEnv with `os`, isTerminalApp/hasBuiltInShell with `os`, programsOf),
 * hands/terminals.ts (LAUNCHERS), admin.ts (parseAdminPolicy, lockedDown), never-look.ts, clipboard-formats.ts,
 * policy/vocabulary.ts (the Windows security vocabulary) and port/host's TEST_SWITCHES. None of them is on this
 * branch yet, so each is written here once, with the signature and behaviour the design documents, and every other
 * Windows module imports it from this file only. When those packages merge, this file becomes re-exports of theirs
 * (one file to change, nothing else in win32/ moves); until then nothing here is live, because the Windows platform
 * object is switched on only in Phase 3.
 *
 * Plain Node: no Electron, no native code.
 */

import path from "node:path";
import fs from "node:fs";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../../admin";
import { savableFormat } from "../../../agent/clipboard";
import { execArgv, findApp, hasBuiltInShell as linuxHasBuiltInShell, isTerminalApp as linuxIsTerminalApp, type DesktopApp } from "../../../hands/system";
import type { OS } from "../../../../shared/shortcuts";
import type { AppIdentity, ClipboardFormats, FloatingKind, FloatingWindow, OverlayShaper, WindowSystem } from "../../types";

export { findApp };

// ───────────── compose.ts (P1-A) ─────────────

/**
 * A WindowSystem whose systemDialogOpen is `check`, and which is otherwise `ws` itself: a Proxy whose `get` answers
 * systemDialogOpen with `check` and every other key with Reflect.get(ws, key) (functions bound to `ws`), so backend
 * extras (port/win32's activate) survive and `this` inside a backend method is the backend (P1-A, §2.5).
 */
export function withSystemDialog<T extends WindowSystem>(ws: T, check: () => boolean): T & { systemDialogOpen(): boolean } {
  return new Proxy(ws, {
    get(target, key) {
      if (key === "systemDialogOpen") return check;
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    has: (target, key) => key === "systemDialogOpen" || Reflect.has(target, key),
  }) as T & { systemDialogOpen(): boolean };
}

/** Tokens and keys a helper never needs (appEnv's NEVER list, §2.5). */
const SECRET_NAME = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$|^(GH_|GITHUB_|COPILOT_)/;
const DROPPED = new Set(["NODE_OPTIONS", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_ENABLE_LOGGING"]);

/**
 * An environment for a helper Ember starts: `env` minus tokens, minus EMBER_* except EMBER_LOG_LEVEL and `keep`,
 * minus NODE_OPTIONS, ELECTRON_NO_ATTACH_CONSOLE and ELECTRON_ENABLE_LOGGING (keys deleted). On win32 every name is
 * compared case-insensitively, as Windows' environment is (P1-A, §2.5).
 */
export function cleanEnv(env: NodeJS.ProcessEnv, o: { os: OS; keep?: readonly string[] }): NodeJS.ProcessEnv {
  const norm = (k: string) => (o.os === "win32" ? k.toUpperCase() : k);
  const keep = new Set((o.keep ?? []).map(norm));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const n = norm(k);
    if (SECRET_NAME.test(n) || DROPPED.has(n)) continue;
    if (n.startsWith("EMBER_") && n !== "EMBER_LOG_LEVEL" && !keep.has(n)) continue;
    out[k] = v;
  }
  return out;
}

/** port/host's TEST_SWITCHES (app/sidecar-host/launch.ts; exported by the PH correction). */
export const HOST_TEST_SWITCHES: readonly string[] = ["EMBER_AX_PROVIDER", "EMBER_AX_FAKE_DESKTOP", "EMBER_AX_FAKE_LOG"];

/** The host's environment: cleanEnv, the test switches only unpackaged, and EMBER_OWNER_PID (P1-A, §2.5). */
export function hostEnv(env: NodeJS.ProcessEnv, o: { os: OS; packaged: boolean; ownerPid: number }): NodeJS.ProcessEnv {
  return { ...cleanEnv(env, { os: o.os, keep: o.packaged ? [] : HOST_TEST_SWITCHES }), EMBER_OWNER_PID: String(o.ownerPid) };
}

/** §8.3's win32 and darwin rows of Ember's floating windows. */
function floatingFor(os: "win32" | "darwin", kind: FloatingKind): FloatingWindow {
  if (kind === "desk-view") return { options: {}, allWorkspaces: null };
  if (os === "win32") return { options: { type: "toolbar", thickFrame: false, roundedCorners: false }, allWorkspaces: null };
  if (kind === "ask") return { options: { type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true }, allWorkspaces: null };
  return { options: { type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, roundedCorners: false }, allWorkspaces: null };
}

/** The overlay shaper of Windows and macOS: no input region (hover polling decides), §8.3's options (P1-A). */
export function hoverShaper(os: "win32" | "darwin"): OverlayShaper {
  return {
    setInputRegion: () => false,
    release() { /* nothing is held open */ },
    forward: os === "darwin",
    floating: kind => floatingFor(os, kind),
  };
}

// ───────────── which.ts (P1-D) ─────────────

const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** A variable's value, compared by name case-insensitively on Windows. */
export function envValue(env: NodeJS.ProcessEnv, name: string, os: OS = "win32"): string | undefined {
  if (os !== "win32") return env[name];
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === upper && v !== undefined) return v;
  return undefined;
}

/**
 * The absolute path of `cmd` on PATH (path.delimiter of `os`; quotes stripped; win32 tries `cmd` as given when it
 * already ends in .exe/.com, else .exe then .com, never .cmd/.bat; extra folders appended), or null (P1-D, §2.5).
 */
export function which(cmd: string, o: { os: OS; env: NodeJS.ProcessEnv; extraDirs?: readonly string[]; isExecutable?: (p: string) => boolean }): string | null {
  const win = o.os === "win32";
  const p = win ? path.win32 : path.posix;
  const exec = o.isExecutable ?? (win ? isFile : (f: string) => { try { fs.accessSync(f, fs.constants.X_OK); return isFile(f); } catch { return false; } });
  const raw = envValue(o.env, "PATH", o.os) ?? (win ? "" : "/usr/bin:/bin");
  const dirs = [...raw.split(win ? ";" : ":"), ...(o.extraDirs ?? [])].map(d => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const names = !win ? [cmd] : /\.(exe|com)$/i.test(cmd) ? [cmd] : [`${cmd}.exe`, `${cmd}.com`];
  for (const d of dirs) {
    if (!p.isAbsolute(d)) continue; // a relative PATH entry would resolve against Ember's working folder
    for (const n of names) {
      const f = p.join(d, n);
      if (exec(f)) return f;
    }
  }
  return null;
}

// ───────────── hands/system.ts and hands/terminals.ts (P1-D, rows by V) ─────────────

/** The on/off grammar changeSetting's encoders use ("on", "true", "yes", "1" are on; anything else is off). */
export function parseOnOff(value: string): boolean {
  return /^(true|on|yes|1)$/i.test(value);
}

/** What any app Ember starts may inherit (appEnv's KEEP), plus Windows' own names (system.md §2.2). */
const KEEP = /^(HOME|USER|LOGNAME|SHELL|PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|(http|https|ftp|all|no)_proxy|SSL_CERT_(FILE|DIR))$/i;
const KEEP_WIN32 = /^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles(\(x86\))?|CommonProgramW6432|PUBLIC|ALLUSERSPROFILE|OS|PROCESSOR_[A-Z_]+|NUMBER_OF_PROCESSORS|COMPUTERNAME|SESSIONNAME|LOGONSERVER|USERDNSDOMAIN|DriverData|OneDrive(Commercial|Consumer)?)$/i;
const NEVER = /(_TOKEN|_API_KEY|_SECRET|_PASSWORD)$|^(GH_|GITHUB_|COPILOT_|EMBER_|GPG_|GNOME_KEYRING_|SSH_|ELECTRON_)|^(SESSION_MANAGER|NO_AT_BRIDGE|CHROME_DESKTOP)$/i;

/** appEnv(base, { os: "win32" }): the allowlisted environment for apps, names compared case-insensitively. */
export function appEnv(base: NodeJS.ProcessEnv, o: { os: OS }): NodeJS.ProcessEnv {
  void o;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && (KEEP.test(k) || KEEP_WIN32.test(k)) && !NEVER.test(k)) env[k] = v;
  return env;
}

/** Windows programs that are terminals, shells or command surfaces (§9.11; V owns the real rows). */
const WIN_TERMINALS = new Set(["cmd", "powershell", "pwsh", "pwsh-preview", "windowsterminal", "wt", "openconsole", "conhost", "wsl", "wslhost",
  "bash", "ubuntu", "ubuntu2004", "ubuntu2204", "ubuntu2404", "debian", "kali", "mintty", "git-bash", "cmder", "conemu", "conemu64", "mobaxterm",
  "securecrt", "xshell", "termius", "putty"]);
const WIN_SHELL_APPS = new Set(["devenv", "powershell_ise", "notepad++", "cursor", "windsurf", "code", "code - insiders", "searchhost", "searchapp",
  "startmenuexperiencehost", "searchui", "taskmgr"]);
const WIN_REFUSED = /^(runas|psexec(64)?|mshta|wscript|cscript|regsvr32|msiexec|cmstp|installutil|msbuild|forfiles|pcalua|schtasks|at|sc|reg|bitsadmin|certutil|wmic)$/;
const WIN_NAME = /\b(terminal|console|command prompt|powershell|anaconda prompt|git bash|developer (command prompt|powershell))\b/i;
const WIN_TERMINAL_CLASSES = new Set(["consolewindowclass", "cascadia_hosting_window_class", "pseudoconsolewindow", "mintty", "putty", "virtualconsoleclass"]);

/** A program's name as Windows apps report it: the file name, lower case, without its extension. */
const programWord = (p: string) => path.win32.basename(p).toLowerCase().replace(/\.(exe|com|bat|cmd|ps1|lnk)$/, "");
/** argv as an Exec line (each word single-quoted), so today's Exec-line rules (shells, interpreters, wrappers) apply. */
const asExec = (argv: readonly string[]) => argv.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
const windowsView = (app: AppIdentity) => {
  const argv = app.argv ?? (app.exec ? execArgv(app.exec) : []);
  const programs = [...(argv.length ? [programWord(argv[0])] : []), ...((app as { programs?: string[] }).programs ?? [])];
  return { programs, exec: argv.length ? asExec([programWord(argv[0]), ...argv.slice(1)]) : app.exec };
};

/** hasBuiltInShell(app, os) (P1-D, Windows rows by V). */
export function hasBuiltInShell(app: AppIdentity, os: OS): boolean {
  if (os !== "win32") return linuxHasBuiltInShell(app);
  const v = windowsView(app);
  return linuxHasBuiltInShell({ ...app, exec: v.exec }) || v.programs.some(p => WIN_SHELL_APPS.has(p));
}

/** isTerminalApp(app, os) (P1-D, Windows rows by V): a terminal, shell, command surface or app with a shell built in. */
export function isTerminalApp(app: AppIdentity, os: OS): boolean {
  if (os !== "win32") return linuxIsTerminalApp(app);
  if (app.windowClass && WIN_TERMINAL_CLASSES.has(app.windowClass.toLowerCase())) return true;
  const v = windowsView(app);
  if (v.programs.some(p => WIN_TERMINALS.has(p) || WIN_REFUSED.test(p))) return true;
  if (WIN_NAME.test(app.name)) return true;
  return hasBuiltInShell(app, os) || linuxIsTerminalApp({ ...app, exec: v.exec });
}

/** LAUNCHERS (hands/terminals.ts): programs any app's window could belong to, so they never identify one. */
export const LAUNCHERS: Readonly<Record<OS, RegExp>> = {
  linux: /^(python[\d.]*|sh|bash|env|flatpak|java|perl|ruby|node|gjs|mono|gtk-launch)$/,
  // Never explorer: File Explorer's windows belong to explorer.exe.
  win32: /^(rundll32|dllhost|applicationframehost|javaw|pythonw|py|wscript|cscript|msiexec)$/,
  darwin: /^(open|osascript|java)$/,
};

/** programsOf(app, launchers): the lower-case names an app's windows report (its `programs` when the catalogue knows them). */
export function programsOf(app: DesktopApp, launchers: RegExp): Set<string> {
  const argv = app.argv ?? (app.exec ? execArgv(app.exec) : []);
  const names = app.programs ?? [app.id.replace(/\.desktop$/, ""), ...argv.filter(a => !/^[-%]/.test(a)).map(a => path.basename(a))];
  return new Set(names.map(n => n.toLowerCase()).filter(n => n && !launchers.test(n)));
}

// ───────────── admin.ts (P1-D) ─────────────

/** Everything off that could act or listen (admin.ts's LOCKDOWN). */
const LOCKDOWN = AdminPolicySchema.parse({
  features: { voice: false, actions: false, cursor: false, desk: false, screenImages: false },
  allowGrants: false,
  confirmEveryAction: true,
});

/** A policy that exists but can't be used: Ember is locked down (admin.ts lockedDown). */
export function lockedDown(source: string, error: string): LoadedAdminPolicy {
  return { policy: LOCKDOWN, source, error };
}

/** The JSON and schema half of loadAdminPolicy, with its error texts (admin.ts parseAdminPolicy). */
export function parseAdminPolicy(raw: string, source: string): LoadedAdminPolicy {
  try {
    const parsed = AdminPolicySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { policy: parsed.data, source };
    const issue = parsed.error.issues[0];
    return lockedDown(source, `${source}: ${issue.path.join(".") || "(top)"}: ${issue.message}`);
  } catch (err) {
    return lockedDown(source, `${source} is not valid JSON: ${(err as Error).message}`);
  }
}

// ───────────── never-look.ts, clipboard-formats.ts, policy/vocabulary.ts (P1-D, P1-C; Windows rows by V) ─────────────

/** NEVER_LOOK_DEFAULTS.win32 (§9.11). */
export const NEVER_LOOK_DEFAULTS_WIN32: readonly string[] = ["keepass", "1password", "bitwarden", "lastpass", "dashlane", "nordpass", "roboform", "enpass", "keeper", "credentialuibroker"];

const OS_FORMAT = /^electron application\/osclipboard;format="(.*)"$/;
/** Windows password managers' "don't keep this" formats (§9.11), and KDE's for a Linux-born marker. */
const PASSWORD_MARKERS = new Set(["x-kde-passwordManagerHint", "ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"]);
/**
 * CLIPBOARD_FORMATS.win32: MIME types only until V verifies Windows' (§9.11, R13), but already treating the Windows
 * password-manager markers as passwords, so a copied password is never saved and put back (fail closed).
 */
export const CLIPBOARD_FORMATS_WIN32: ClipboardFormats = {
  savable: savableFormat,
  passwordMarker: t => PASSWORD_MARKERS.has(OS_FORMAT.exec(t)?.[1] ?? t),
  ownTextMarkers: [],
};

/** SECURITY_APP.win32, SECURITY_CLASS.win32 and SECURITY_TITLE.win32 (§9.11), the one Windows security vocabulary. */
const SECURITY_APP_WIN32 = new Set(["credentialuibroker", "consent", "logonui", "lockapp", "sechealthui", "securityhealthhost", "smartscreen", "bdeunlock",
  "bdeuisrv", "microsoft.aad.brokerplugin", "wwahost", "pinenrollmentbroker", "bioenrollmenthost", "credentialenrollmentmanager"]);
const SECURITY_CLASS_WIN32 = new Set(["credential dialog xaml host", "$$$secure uap dummy window class for interim dialog"]);
const SECURITY_TITLE_WIN32 = /^(windows security|user account control|enter network credentials|windows hello|making sure it's you|credential manager|stored user names and passwords|bitlocker drive encryption|windows defender firewall with advanced security)$/;

/** isSecurityWindow(w, "win32") (policy.ts, P1-C): an authentication or security window, by program or title. */
export function isSecurityWindow(w: { app?: string; title?: string; name?: string }, os: OS): boolean {
  void os;
  const app = (w.app ?? "").trim().toLowerCase().replace(/\.exe$/, "");
  const title = (w.title ?? w.name ?? "").trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  return SECURITY_APP_WIN32.has(app) || SECURITY_TITLE_WIN32.test(title);
}

/** A credential or consent dialog's window class (SECURITY_CLASS.win32), compared case-insensitively. */
export function isSecurityClass(className: string): boolean {
  return SECURITY_CLASS_WIN32.has(className.trim().toLowerCase());
}
