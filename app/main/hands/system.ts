/**
 * Tier 0: things Ember changes without touching any window. A short list of
 * comfort settings (gsettings) and launching apps from their .desktop files.
 * The terminal and shell checks, the value grammar and the app environment are
 * shared with the Windows and macOS catalogues (their vocabularies are keyed by OS
 * in hands/terminals.ts); every OS argument defaults to Linux, today's behaviour.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OS } from "../../shared/shortcuts";
import type { AppCatalog, AppIdentity } from "../platform/types";
import {
  INTERPRETERS, LAUNCHERS, REFUSED, SHELLS, SHELL_APP, SHELL_APP_ID, SHELL_APP_NAME, SHELL_MODULES, TERMINALS, TERMINAL_CLASSES, TERMINAL_ID_WORDS, TERMINAL_NAME, WRAPPERS,
} from "./terminals";

const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())));
});

export const SETTINGS = {
  night_light: "Night Light (warmer screen colours)",
  dark_style: "Dark style for apps",
  do_not_disturb: "Do Not Disturb (hide notification banners)",
  text_size: "Text size, as a scale factor 0.5-3 (1 is normal)",
  battery_percentage: "Show battery percentage in the top bar",
  clock_seconds: "Show seconds in the top-bar clock",
} as const;

export type SettingName = keyof typeof SETTINGS;

interface Key { schema: string; key: string }

/**
 * The on/off grammar of change_setting values ("on", "true", "yes", "1"; anything else is off), shared by every
 * OS's settings so the model's words mean the same everywhere.
 */
export function parseOnOff(value: string): boolean {
  return /^(true|on|yes|1)$/i.test(value);
}

/** A text-size value: a scale factor from 0.5 to 3 (1 is normal); throws in plain words otherwise. */
export function parseScale(value: string): number {
  const n = Number(value);
  if (!(n >= 0.5 && n <= 3)) throw new Error("text size must be between 0.5 and 3");
  return n;
}

async function hasKey(k: Key): Promise<boolean> {
  try { await run("gsettings", ["writable", k.schema, k.key]); return true; } catch { return false; }
}

/** Where each setting lives, with a fallback for older GNOME (RHEL 8 ships 3.32). */
async function locate(name: SettingName): Promise<{ key: Key; encode: (v: string, raw: string) => string; decode: (raw: string) => string }> {
  const bool = (v: string) => (parseOnOff(v) ? "true" : "false");
  const asIs = (raw: string) => raw;
  switch (name) {
    case "night_light": return { key: { schema: "org.gnome.settings-daemon.plugins.color", key: "night-light-enabled" }, encode: bool, decode: asIs };
    case "do_not_disturb":
      // show-banners=false is Do Not Disturb.
      return { key: { schema: "org.gnome.desktop.notifications", key: "show-banners" }, encode: v => (bool(v) === "true" ? "false" : "true"), decode: raw => (raw === "false" ? "true" : "false") };
    case "text_size": return {
      key: { schema: "org.gnome.desktop.interface", key: "text-scaling-factor" },
      encode: v => String(parseScale(v)),
      decode: asIs,
    };
    case "battery_percentage": return { key: { schema: "org.gnome.desktop.interface", key: "show-battery-percentage" }, encode: bool, decode: asIs };
    case "clock_seconds": return { key: { schema: "org.gnome.desktop.interface", key: "clock-show-seconds" }, encode: bool, decode: asIs };
    case "dark_style": {
      const modern = { schema: "org.gnome.desktop.interface", key: "color-scheme" };
      if (await hasKey(modern)) return { key: modern, encode: v => (bool(v) === "true" ? "'prefer-dark'" : "'default'"), decode: raw => String(raw.includes("dark")) };
      // GNOME 3.32: the theme's own dark variant, so the user's theme stays theirs.
      return {
        key: { schema: "org.gnome.desktop.interface", key: "gtk-theme" },
        encode: (v, raw) => `'${darkTheme(raw.replace(/^'|'$/g, ""), bool(v) === "true", installedThemes()).replace(/'/g, "\\'")}'`,
        decode: raw => String(/-dark'?$/i.test(raw)),
      };
    }
  }
}

/**
 * The GTK theme for dark style on or off: "X" ↔ "X-dark" (any case), only to a
 * variant that exists. Adwaita's dark variant is built into GTK.
 */
export function darkTheme(current: string, on: boolean, available: string[]): string {
  const dark = /-dark$/i.test(current);
  if (!on) return dark ? current.replace(/-dark$/i, "") : current;
  if (dark) return current;
  if (current.toLowerCase() === "adwaita") return "Adwaita-dark";
  const found = available.find(t => t.toLowerCase() === `${current.toLowerCase()}-dark`);
  if (!found) throw new Error(`the theme ${current} has no dark version`);
  return found;
}

/** GTK themes installed for this user and system (names of folders with a gtk-3.0 theme). */
function installedThemes(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [path.join(os.homedir(), ".themes"), path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), "themes"),
    ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").map(d => path.join(d, "themes"))];
  const out: string[] = [];
  for (const d of dirs) {
    try { for (const t of fs.readdirSync(d)) if (fs.existsSync(path.join(d, t, "gtk-3.0"))) out.push(t); } catch { /* none here */ }
  }
  return out;
}

/** Changes a setting and reads it back. Returns the value now in effect. */
export async function changeSetting(name: SettingName, value: string): Promise<{ before: string; after: string }> {
  const { key, encode, decode } = await locate(name);
  if (!(await hasKey(key))) throw new Error(`${SETTINGS[name]} is not available on this desktop`);
  const raw = await run("gsettings", ["get", key.schema, key.key]);
  const before = decode(raw);
  await run("gsettings", ["set", key.schema, key.key, encode(value, raw)]);
  const after = decode(await run("gsettings", ["get", key.schema, key.key]));
  return { before, after };
}

export interface DesktopApp {
  id: string; name: string; file: string; keywords: string[]; exec?: string;
  /** The GenericName key, lower case (e.g. "file manager"), when the file has one. It also leads `keywords`. */
  generic?: string;
  /** The Categories key (e.g. "TerminalEmulator"), when the file has one. */
  categories?: string[];
  /** Terminal=true: the app runs inside a terminal window. */
  terminal?: boolean;
  /** The launch command, already split into words (Windows and macOS, where `exec` is absent). */
  argv?: string[];
  /** Lower-case program names this app's windows report, when the catalogue knows them (Windows and macOS). */
  programs?: string[];
}

/** A key file's string escapes (\\s \\n \\t \\r \\\\), as GLib reads them; any other backslash stays for the Exec parser. */
const unescapeValue = (v: string) => v.replace(/\\([sntr\\])/g, (_, c: string) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c]!);

/** A key file boolean as GLib reads it: "true" or "1" (GLib also takes a prefix of "true"). */
const keyFileTrue = (v: string | undefined) => v !== undefined && /^(1|t|tr|tru|true)$/.test(v.trim());

export function parseDesktopFile(text: string): { name: string; keywords: string[]; visible: boolean; exec?: string; generic?: string; categories?: string[]; terminal?: boolean } | null {
  let section = "";
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) { section = t; continue; }
    if (section !== "[Desktop Entry]") continue;
    const i = t.indexOf("=");
    if (i > 0) kv[t.slice(0, i).trim()] = unescapeValue(t.slice(i + 1).trim());
  }
  if (kv.Type !== "Application" || !kv.Name) return null;
  const visible = !keyFileTrue(kv.NoDisplay) && !keyFileTrue(kv.Hidden);
  const categories = (kv.Categories ?? "").split(";").map(s => s.trim()).filter(Boolean);
  return {
    name: kv.Name, keywords: [kv.GenericName, ...(kv.Keywords ?? "").split(";")].filter(Boolean).map(s => s!.toLowerCase()), visible,
    ...(kv.Exec ? { exec: kv.Exec } : {}),
    ...(kv.GenericName ? { generic: kv.GenericName.toLowerCase() } : {}),
    ...(categories.length ? { categories } : {}),
    ...(keyFileTrue(kv.Terminal) ? { terminal: true } : {}),
  };
}

/** flatpak run options that take a value (the next word, unless given as --name=value). */
const FLATPAK_VALUE = new Set(["arch", "branch", "command", "cwd", "runtime", "runtime-version", "commit", "runtime-commit", "filesystem", "nofilesystem",
  "env", "unset-env", "persist", "socket", "nosocket", "device", "nodevice", "share", "unshare", "allow", "disallow", "talk-name", "no-talk-name",
  "own-name", "system-talk-name", "system-no-talk-name", "system-own-name", "add-policy", "remove-policy", "app-path", "usr-path", "instance-id-fd", "parent-pid", "env-fd"]);

/** One OS's terminal and shell vocabulary (hands/terminals.ts). */
interface Vocabulary {
  os: OS;
  terminals: ReadonlySet<string>;
  shells: RegExp;
  interpreters: RegExp;
  shellModules: RegExp;
  shellApp: RegExp;
  shellAppId: RegExp;
  shellAppName: RegExp;
  terminalName: RegExp;
  /** Id words that make an app a terminal however it is named (Linux and Windows "console"; none on macOS). */
  terminalIdWords: readonly string[];
  wrappers: (typeof WRAPPERS)[OS];
  refused: RegExp;
}

const vocabularies = new Map<OS, Vocabulary>();
function vocabulary(os: OS): Vocabulary {
  let v = vocabularies.get(os);
  if (!v) {
    v = {
      os, terminals: TERMINALS[os], shells: SHELLS[os], interpreters: INTERPRETERS[os], shellModules: SHELL_MODULES[os], shellApp: SHELL_APP[os],
      shellAppId: SHELL_APP_ID[os], shellAppName: SHELL_APP_NAME[os], terminalName: TERMINAL_NAME[os], terminalIdWords: TERMINAL_ID_WORDS[os],
      wrappers: WRAPPERS[os], refused: REFUSED[os],
    };
    vocabularies.set(os, v);
  }
  return v;
}

/** File extensions a Windows or macOS program, shortcut or bundle name may carry (never stripped on Linux, where a name is the name). */
const PROGRAM_EXT = /\.(exe|com|bat|cmd|ps1|lnk|app)$/i;

/**
 * A command word's program name, lower case. Windows paths split on either slash and lose their extension
 * ("C:\\Windows\\System32\\cmd.exe" → "cmd"), so the vocabularies hold bare names; Linux is today's posix basename.
 */
const base = (p: string, os: OS = "linux") => (os === "linux" ? path.posix.basename(p).toLowerCase()
  : (os === "win32" ? path.win32 : path.posix).basename(p).toLowerCase().replace(PROGRAM_EXT, ""));
const named = (word: string, v: Vocabulary) => v.terminals.has(word) || v.terminals.has(word.replace(/\.(py|pl|rb|js|sh)$/, ""))
  || (v.os !== "linux" && v.terminals.has(word.replace(PROGRAM_EXT, "")));
const shellApp = (word: string, v: Vocabulary) => v.shellApp.test(word) || (v.os !== "linux" && v.shellApp.test(word.replace(PROGRAM_EXT, "")));

/** The words after a command's own options (`value`: short options taking a value; `long`: long ones), less `positional` more. */
function afterOptions(args: string[], value = "", long: string[] = [], positional = 0): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (a.startsWith("--")) { i += !a.includes("=") && long.includes(a.slice(2)) ? 2 : 1; continue; }
    if (a.startsWith("-") && a.length > 1) {
      // A cluster (-ab, -n5): a letter taking a value takes the rest of the word, or the next word if it's last.
      const k = [...a.slice(1)].findIndex(c => value.includes(c));
      i += k >= 0 && k === a.length - 2 ? 2 : 1;
      continue;
    }
    break;
  }
  return args.slice(i + positional);
}

/** What `env [options] [NAME=VALUE…] command` runs (-S splits its string into more arguments). */
function envCommand(args: string[], depth: number): string[] {
  let i = 0;
  while (i < args.length && depth < 8) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (a === "-") { i++; continue; }
    if (a.startsWith("--split-string=")) return envCommand([...execArgv(a.slice(15)), ...args.slice(i + 1)], depth + 1);
    if (a === "--split-string") return envCommand([...execArgv(args[i + 1] ?? ""), ...args.slice(i + 2)], depth + 1);
    if (a.startsWith("--")) { i += !a.includes("=") && ["unset", "chdir"].includes(a.slice(2)) ? 2 : 1; continue; }
    if (a.startsWith("-") && a.length > 1) {
      const s = a.indexOf("S"), uc = [...a.slice(1)].findIndex(c => c === "u" || c === "C") + 1;
      if (s > 0 && (!uc || s < uc)) {
        const rest = a.slice(s + 1);
        return envCommand([...execArgv(rest || (args[i + 1] ?? "")), ...args.slice(i + (rest ? 1 : 2))], depth + 1);
      }
      i += uc && uc === a.length - 1 ? 2 : 1;
      continue;
    }
    break;
  }
  while (i < args.length && /^[^=-][^=]*=/.test(args[i])) i++; // NAME=VALUE
  return args.slice(i);
}

/** What `flatpak run …` runs: --command's program with the app's arguments, or the app itself. true: refuse. */
function flatpakCommand(args: string[]): { id: string; argv: string[] | null } | true | null {
  const sub = args.findIndex(a => !a.startsWith("-"));
  if (sub < 0) return null;
  if (args[sub] === "enter") return true; // a command inside a running app's sandbox
  if (args[sub] !== "run") return null;
  let command: string | null = null, i = sub + 1;
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i];
    if (a === "--") { i++; break; }
    const [name, val] = a.replace(/^--?/, "").split(/=(.*)/s);
    const value = val ?? (FLATPAK_VALUE.has(name) ? args[++i] ?? "" : undefined);
    if (name === "command") command = value ?? "";
  }
  const id = args[i] ?? "";
  return { id, argv: command !== null ? [command, ...args.slice(i + 1)] : null };
}

/** Does this argv (an Exec line) start a terminal, a shell or an app with one built in, or wait for typed commands? */
function runsTerminal(argv: string[], v: Vocabulary, depth = 0): boolean {
  if (!argv.length) return false;
  if (depth > 8) return true; // wrappers inside wrappers: Ember doesn't follow that far
  const word = (w: string) => base(w, v.os);
  const prog = word(argv[0]), args = argv.slice(1);
  if (v.refused.test(prog)) return true;
  if (prog === "env") return runsTerminal(envCommand(args, 0), v, depth + 1);
  // Windows: "explorer.exe shell:AppsFolder\<AUMID>" starts that packaged app, judged by its id as flatpak's are
  // (Microsoft.WindowsTerminal_8wekyb3d8bbwe!App is Windows Terminal, whatever the shortcut is called). Only ever an
  // extra refusal: a desktop app's AUMID is a known folder's GUID and a path ({1AC14E77-…}\cmd.exe is System32's
  // cmd.exe), which explorer.exe's wrapper rule below still reads by its program's name.
  const packaged = v.os === "win32" && prog === "explorer" ? /^shell:appsfolder\\(.+)$/i.exec(args[0] ?? "") : null;
  if (packaged && (idIsTerminal(packaged[1], v) || idHasShell(packaged[1], v))) return true;
  const wrapper = v.wrappers[prog];
  if (wrapper) {
    if (wrapper.noCommand && args.some(a => wrapper.noCommand!.test(a))) return false;
    // flock -c runs its string with sh.
    if (prog === "flock") {
      const c = args.findIndex(a => a === "-c" || a === "--command" || a.startsWith("--command="));
      if (c >= 0) return runsTerminal(["sh", "-c", args[c].startsWith("--command=") ? args[c].slice(10) : args[c + 1] ?? ""], v, depth + 1);
    }
    return runsTerminal(afterOptions(args, wrapper.value, wrapper.long, wrapper.positional), v, depth + 1);
  }
  if (named(prog, v) || shellApp(prog, v) || argv.some(a => /TerminalEmulator/i.test(a))) return true;
  if (prog === "flatpak") {
    const f = flatpakCommand(args);
    if (f === true) return true;
    if (!f) return false;
    return idIsTerminal(f.id, v) || idHasShell(f.id, v) || (!!f.argv && runsTerminal(f.argv, v, depth + 1));
  }
  if (!v.shells.test(prog) && !v.interpreters.test(prog)) return false;
  // Inline code (sh -c "…", python -c "…", perl -e "…"): refuse it if it starts any of the above.
  const inline = args.findIndex(a => /^-[a-zA-Z]*[ceE]$/.test(a));
  if (inline >= 0) {
    const code = args.slice(inline + 1).join(" ");
    if (v.shells.test(prog) && runsTerminal(execArgv(code.replace(/[;&|()`$<>]/g, " ")), v, depth + 1)) return true;
    return (code.match(/[\w./+-]+/g) ?? []).some(w => named(word(w), v) || shellApp(word(w), v) || v.refused.test(word(w)));
  }
  // python -m idlelib, python -m code: an interactive shell.
  const m = args.findIndex(a => a === "-m");
  if (m >= 0 && v.interpreters.test(prog)) return v.shellModules.test(args[m + 1] ?? "");
  // A script runs: refuse only a script that is itself a terminal (terminator is a Python program) or an IDE.
  const script = args.find(a => !a.startsWith("-"));
  return script ? named(word(script), v) || shellApp(word(script), v) : true;
}

/** A desktop id's words. Off Linux also split at "!" and "_": a UWP app id (Microsoft.WindowsTerminal_8wekyb3d8bbwe!App). */
const idWords = (id: string, v: Vocabulary) => id.toLowerCase().replace(/\.desktop$/, "").split(v.os === "linux" ? "." : /[.!_]/);
/**
 * Does a word of this id (or a part of one, split at "-" and "_") name a terminal, or is it one of the OS's terminal id
 * words (GNOME's Console is org.gnome.Console; on macOS com.apple.Console is the log viewer, so none there)?
 */
const idIsTerminal = (id: string, v: Vocabulary) => idWords(id, v).some(p => named(p, v) || v.terminalIdWords.includes(p)
  || p.split(/[-_]/).some(w => named(w, v) || v.terminalIdWords.includes(w)));
const idHasShell = (id: string, v: Vocabulary) => v.shellAppId.test(id.toLowerCase().replace(/\.desktop$/, "")) || idWords(id, v).some(w => shellApp(w, v));

/** An app's launch command as words: the catalogue's own split (Windows, macOS) or the parsed Exec line (Linux). */
const argvOf = (app: Pick<AppIdentity, "argv" | "exec">): string[] => app.argv ?? (app.exec ? execArgv(app.exec) : []);

/**
 * Does this app have a terminal or shell built in (an IDE, Emacs, Vim, IDLE)? Text typed into it
 * can run commands, so Ember doesn't open it (isTerminalApp() includes this). LibreOffice isn't
 * one: on Ember's desk it runs with macros off (desk/place.ts). `os` picks the vocabulary.
 */
export function hasBuiltInShell(app: AppIdentity, os: OS = "linux"): boolean {
  const v = vocabulary(os);
  if (app.categories?.some(c => /^IDE$/i.test(c))) return true;
  if (idHasShell(app.id, v) || v.shellAppName.test(app.name) || /\bIDLE\b/.test(app.name)) return true;
  const argv = argvOf(app);
  return argv.length > 0 && shellApp(base(argv[0], os), v);
}

/**
 * Is this a terminal, a shell, or an app with one built in? Ember doesn't run commands, so it never
 * opens one, on its desk or on the user's screen: both ways of opening apps ask this. Checks the
 * desktop id, name, Categories (TerminalEmulator, IDE), Terminal=true and what the Exec line starts,
 * through wrappers (env, timeout, flatpak run --command…); programs that run commands as someone
 * else or elsewhere (sudo, systemd-run, gtk-launch, gio launch…) count too. A window's class, when
 * the caller knows it, counts on Windows (a console host runs whatever command-line tool it hosts).
 */
export function isTerminalApp(app: AppIdentity, os: OS = "linux"): boolean {
  const v = vocabulary(os);
  if (app.terminal) return true;
  if (app.windowClass) {
    const cls = app.windowClass.toLowerCase();
    if (TERMINAL_CLASSES[os].some(c => c.toLowerCase() === cls)) return true;
  }
  if (app.categories?.some(c => /^TerminalEmulator$/i.test(c))) return true;
  if (idIsTerminal(app.id, v) || hasBuiltInShell(app, os)) return true;
  if (v.terminalName.test(app.name) || named(app.name.trim().toLowerCase().replace(/\s+/g, "-"), v)) return true;
  const argv = argvOf(app);
  return argv.length > 0 && runsTerminal(argv, v);
}

/**
 * Is the app whose windows report `name` (a window's app, as the policy is given it) a terminal or an app with a shell
 * built in? By the name, as isTerminalApp takes it, and on macOS also by every installed app shown by that name (`apps`:
 * the OS's catalogue; a bundle's file name, display name or bundle name, compared through appKey), judged with all the
 * catalogue knows of it: its bundle id and executable. So Terminal, iTerm2, Warp, Ghostty or kitty shown under another
 * name (a renamed bundle, a preview build's) is still known by com.apple.Terminal, dev.warp.Warp-Preview and the like.
 * Never by an executable's name, which a window doesn't report (Warp's is "stable": Preview isn't Warp Preview's
 * "preview"). An app outside the catalogue's folders is known by its name only. Elsewhere the name alone, exactly as
 * before: a Windows window's app is its program, which the name check reads already, and Linux's is unchanged.
 */
export function isTerminalWindowApp(name: string, apps: Pick<AppCatalog, "list" | "isTerminalApp" | "appKey">, os: OS = "linux"): boolean {
  if (apps.isTerminalApp({ id: name, name })) return true;
  if (os !== "darwin") return false;
  const key = apps.appKey(name.trim());
  // The macOS catalogue's keywords are the bundle's display and bundle names (and an Apple app's generic name).
  const shownAs = (a: DesktopApp) => [a.name, ...a.keywords].some(n => apps.appKey(n.trim()) === key);
  return !!key && apps.list().some(a => shownAs(a) && apps.isTerminalApp(a));
}

/**
 * The programs an app's windows belong to (lower case, as the accessibility helper's `app` reports them): the
 * catalogue's own list when it has one (Windows, macOS), else its launcher's file name and its desktop id. Never an
 * interpreter's or launcher's name (`launchers`: hands/terminals.ts LAUNCHERS for this OS), which any window could share.
 */
export function programsOf(app: DesktopApp, launchers: RegExp = LAUNCHERS.linux): Set<string> {
  const keep = (names: string[]) => new Set(names.map(n => n.toLowerCase()).filter(n => n && !launchers.test(n)));
  if (app.programs) return keep(app.programs);
  const argv = argvOf(app);
  return keep([app.id.replace(/\.desktop$/, ""), ...argv.filter(a => !/^[-%]/.test(a)).map(a => path.basename(a))]);
}

export function listApps(env: NodeJS.ProcessEnv = process.env): DesktopApp[] {
  const dirs = [env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":")];
  const seen = new Map<string, DesktopApp>();
  for (const d of dirs) {
    const dir = path.join(d, "applications");
    let files: string[];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".desktop")); } catch { continue; }
    for (const f of files) {
      const id = f.replace(/\.desktop$/, "");
      if (seen.has(id)) continue; // earlier dirs win, as in the XDG spec
      try {
        const parsed = parseDesktopFile(fs.readFileSync(path.join(dir, f), "utf8"));
        if (parsed?.visible) seen.set(id, { id, name: parsed.name, file: path.join(dir, f), keywords: parsed.keywords, exec: parsed.exec, generic: parsed.generic, categories: parsed.categories, terminal: parsed.terminal });
      } catch { /* unreadable */ }
    }
  }
  return [...seen.values()];
}

/** A query and a desktop-file phrase as words, with camelCase split and simple plurals folded ("files" → "file"). */
function appWords(text: string): string[] {
  return text.replace(/\.desktop$/i, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Text as one run of lower-case letters and digits, so "gthumb" meets "gThumb" and "LibreOffice" (which appWords split). */
const compact = (text: string) => text.toLowerCase().replace(/\.desktop$/, "").replace(/[^a-z0-9]/g, "");
/** Text as lower-case words, camelCase left whole: "PulseAudio Volume Control" → "pulseaudio volume control". */
const lowerWords = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ");

/**
 * The installed app that best answers `query`. Exact names and ids win, then the app's GenericName
 * and name words, then words of its desktop id, then Categories and keywords. Ordinary keywords rank
 * last: a helper such as Bulk Rename lists "files" too, but its generic name is "Bulk Rename", so
 * "open the file manager" (or "Files") chooses Thunar instead of the first app in directory order.
 * The tiers run from best to worst, so an app takes the best one it reaches: XFCE's settings dialogs
 * all have "settings" in their ids, and "Settings" must still reach Settings Manager by its name.
 * `os` picks the terminal vocabulary for the tie-break (the ranking itself is the same everywhere).
 */
export function findApp(apps: DesktopApp[], query: string, os: OS = "linux"): DesktopApp | null {
  const q = appWords(query).join(" ");
  if (!q) return null;
  const cq = compact(query); // never empty: q has a letter or digit
  const lq = lowerWords(query);
  const qw = q.split(" ");
  const allIn = (phrase: string) => { const w = phrase.split(" "); return qw.every(x => w.includes(x)); };
  const tier = (a: DesktopApp): number => {
    const name = appWords(a.name).join(" ");
    const id = appWords(a.id).join(" ");
    const cname = compact(a.name);
    // A query typed in lower case isn't split like the app's camelCase name, so compare them run together too.
    if (name === q || id === q || cname === cq || compact(a.id) === cq) return 100;
    const primary = a.generic ? appWords(a.generic).join(" ") : "";
    if (primary === q) return 95;
    if (primary && allIn(primary)) return 90;
    if (name.startsWith(q + " ")) return 85;
    // Never across a space: run together, "Document Viewer" would contain "tv" and "Window Manager" "wm".
    if (name.includes(q) || lowerWords(a.name).includes(lq)) return 80;
    // The last part of a reverse-DNS id ("org.telegram.desktop") is often a common word, so it ranks no higher than an id word.
    if (id.split(" ").includes(q) || compact(a.id.split(".").pop()!) === cq) return 75;
    const phrases = [...(a.categories ?? []), ...a.keywords].map(k => appWords(k).join(" ")).filter(Boolean);
    if (phrases.includes(q)) return 70;
    if (phrases.some(allIn)) return 65;
    if (phrases.some(p => p.includes(q))) return 50;
    return 0;
  };
  // Within a tier, the app whose own keywords name the query wins, whichever is listed first: "Settings"
  // finds Settings Manager (Keywords …;settings;…) before Settings Editor, which XFCE 4.20's ids sort
  // ahead of it. An app Ember won't start never wins a tie: Vim's GenericName is "Text Editor" too, and
  // its Keywords=Text;editor must not take "editor" from Mousepad. Tiers are 5 apart, so these small
  // steps (-2 to +1) never move an app into another tier.
  const score = (a: DesktopApp): number => {
    const t = tier(a);
    if (!t) return 0;
    if (isTerminalApp(a, os)) return t - 2;
    return t + (a.keywords.some(k => appWords(k).join(" ") === q) ? 1 : 0);
  };
  let best: DesktopApp | null = null, bestScore = 0;
  for (const a of apps) {
    const s = score(a);
    if (s > bestScore) { best = a; bestScore = s; }
  }
  return best;
}

/** What any app Ember starts may inherit: who the user is, language, input methods, proxies. */
const KEEP = /^(HOME|USER|LOGNAME|SHELL|PATH|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|XDG_DATA_DIRS|XDG_CONFIG_DIRS|XDG_CURRENT_DESKTOP|XMODIFIERS|(GTK|QT|QT4|CLUTTER|SDL|GLFW)_IM_MODULE|(http|https|ftp|all|no)_proxy|(HTTP|HTTPS|FTP|ALL|NO)_PROXY|SSL_CERT_(FILE|DIR))$/;
/** Also kept for apps on the user's own screen: their session (display, bus, user dirs, scaling, accessibility). */
const SESSION = /^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XDG_SESSION_(TYPE|DESKTOP|CLASS|ID)|XDG_SEAT|XDG_VTNR|XDG_MENU_PREFIX|DESKTOP_SESSION|GDMSESSION|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|GTK_MODULES|GTK_THEME|GNOME_ACCESSIBILITY|ACCESSIBILITY_ENABLED|QT_ACCESSIBILITY|QT_LINUX_ACCESSIBILITY_ALWAYS_ON|GDK_SCALE|GDK_DPI_SCALE|QT_SCALE_FACTOR|QT_SCREEN_SCALE_FACTORS|QT_AUTO_SCREEN_SCALE_FACTOR|QT_QPA_PLATFORMTHEME)$/;
/** Never, whatever the lists above say: Ember's sign-in, keys and agents stay with Ember. */
const NEVER = /(_TOKEN|_API_KEY|_SECRET|_PASSWORD)$|^(GH_|GITHUB_|COPILOT_|EMBER_|GPG_|GNOME_KEYRING_|SSH_|ELECTRON_)|^(SESSION_MANAGER|NO_AT_BRIDGE|CHROME_DESKTOP)$/;
/**
 * Windows: the same rules without regard to case (its environment names are case-insensitive, and Node keeps the
 * stored spelling: "Path", "SystemRoot"), plus what every Windows program expects to find (system folders, the
 * user's profile folders, the processor and the session). The X session list doesn't apply there.
 */
const KEEP_WIN32 = new RegExp(KEEP.source, "i");
const WIN32_KEEP = /^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles(\(x86\))?|CommonProgramW6432|PUBLIC|ALLUSERSPROFILE|OS|PROCESSOR_[A-Z0-9_]+|NUMBER_OF_PROCESSORS|COMPUTERNAME|SESSIONNAME|LOGONSERVER|USERDNSDOMAIN|DriverData|OneDrive(Commercial|Consumer)?)$/i;
const NEVER_WIN32 = new RegExp(NEVER.source, "i");

/**
 * The environment for apps Ember starts, built from an allowlist: Ember's own
 * environment holds its GitHub sign-in and keys, which an app must never get.
 * Electron's markers are left out too: Chromium sets NO_AT_BRIDGE=1 (and GTK
 * disables accessibility if the variable exists at all), so apps would be
 * invisible to Ember's screen reading. `session: false` is for Ember's desk,
 * which adds its own display, bus and user folders. `os: "win32"` compares names
 * without regard to case and keeps Windows' own variables (default: Linux's rules).
 */
export function appEnv(base: NodeJS.ProcessEnv = process.env, o: { session?: boolean; os?: OS } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const win32 = o.os === "win32";
  const keep = win32 ? (k: string) => KEEP_WIN32.test(k) || WIN32_KEEP.test(k) : (k: string) => KEEP.test(k) || (o.session !== false && SESSION.test(k));
  const never = win32 ? NEVER_WIN32 : NEVER;
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && keep(k) && !never.test(k)) env[k] = v;
  }
  if (base.ORIGINAL_XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = base.ORIGINAL_XDG_CURRENT_DESKTOP;
  return env;
}

/**
 * The Exec line as argv, read the way GLib does (g_shell_parse_argv): words split on blanks, '…'
 * taken as it is, "…" with \\ escaping only $ ` " \\ and a newline, a backslash elsewhere escaping
 * the next character, # starting a comment. Field codes (%U, %f…) are dropped. No shell is involved.
 */
export function execArgv(exec: string): string[] {
  const out: string[] = [];
  let cur = "", any = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (c === "'") {
      const end = exec.indexOf("'", i + 1);
      cur += exec.slice(i + 1, end < 0 ? exec.length : end);
      i = end < 0 ? exec.length : end;
      any = true;
    } else if (c === '"') {
      for (i++; i < exec.length && exec[i] !== '"'; i++) {
        if (exec[i] === "\\" && i + 1 < exec.length && '$`"\\\n'.includes(exec[i + 1])) i++;
        cur += exec[i];
      }
      any = true;
    } else if (c === "\\") {
      if (i + 1 < exec.length && exec[i + 1] !== "\n") cur += exec[i + 1];
      i++;
      any = true;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else if (c === "#" && !any) {
      break; // a comment, to the end of the line
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out.filter(a => !/^%[a-zA-Z]$/.test(a)).map(a => a.replace(/%%/g, "%"));
}

/**
 * Where an app Ember starts belongs: the user's home, never Ember's own working
 * folder. Apps that save into their working directory (a new document's Save
 * dialog, a file manager's new window) would otherwise put files where the
 * user can't find them, such as the folder Ember happened to be started from.
 */
const launchCwd = () => os.homedir();

/** Launches an app the way the desktop does (gtk-launch), or from its Exec line, detached from Ember. */
export function launchApp(app: DesktopApp): void {
  if (isTerminalApp(app)) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
  const fallback = () => {
    const argv = argvOf(app);
    if (!argv.length) return;
    const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env: appEnv(), cwd: launchCwd() });
    c.on("error", () => { /* the caller notices no window appeared */ });
    c.unref();
  };
  const child = spawn("gtk-launch", [app.id], { detached: true, stdio: "ignore", env: appEnv(), cwd: launchCwd() });
  child.on("error", fallback);
  child.unref();
}
