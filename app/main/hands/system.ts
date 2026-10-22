/**
 * Tier 0: things Ember changes without touching any window. A short list of
 * comfort settings (gsettings) and launching apps from their .desktop files.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function hasKey(k: Key): Promise<boolean> {
  try { await run("gsettings", ["writable", k.schema, k.key]); return true; } catch { return false; }
}

/** Where each setting lives, with a fallback for older GNOME (RHEL 8 ships 3.32). */
async function locate(name: SettingName): Promise<{ key: Key; encode: (v: string, raw: string) => string; decode: (raw: string) => string }> {
  const bool = (v: string) => (/^(true|on|yes|1)$/i.test(v) ? "true" : "false");
  const asIs = (raw: string) => raw;
  switch (name) {
    case "night_light": return { key: { schema: "org.gnome.settings-daemon.plugins.color", key: "night-light-enabled" }, encode: bool, decode: asIs };
    case "do_not_disturb":
      // show-banners=false is Do Not Disturb.
      return { key: { schema: "org.gnome.desktop.notifications", key: "show-banners" }, encode: v => (bool(v) === "true" ? "false" : "true"), decode: raw => (raw === "false" ? "true" : "false") };
    case "text_size": return {
      key: { schema: "org.gnome.desktop.interface", key: "text-scaling-factor" },
      encode: v => { const n = Number(v); if (!(n >= 0.5 && n <= 3)) throw new Error("text size must be between 0.5 and 3"); return String(n); },
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

/** Terminal emulators, by program name or desktop id (lower case). */
const TERMINALS = new Set([
  "xterm", "uxterm", "lxterm", "koi8rxterm", "urxvt", "urxvtc", "urxvtd", "rxvt", "rxvt-unicode", "aterm", "eterm", "mlterm", "st", "stterm", "xvt",
  "wezterm", "wezterm-gui", "foot", "footclient", "kitty", "alacritty", "terminator", "tilix", "terminix", "konsole", "yakuake", "guake", "tilda",
  "terminology", "cool-retro-term", "kgx", "gnome-console", "blackbox", "blackbox-terminal", "gnome-terminal", "gnome-terminal-server", "ptyxis",
  "xfce4-terminal", "mate-terminal", "lxterminal", "qterminal", "sakura", "roxterm", "termite", "deepin-terminal", "hyper", "tabby", "contour",
  "ghostty", "rio", "zutty", "kmscon", "warp-terminal", "evilvte", "lilyterm", "pterm", "putty", "terminal", "x-terminal-emulator",
  "xdg-terminal", "xdg-terminal-exec",
]);
/** Command shells and terminal multiplexers: given no script, they wait for typed commands. */
const SHELLS = /^(sh|bash|rbash|dash|zsh|ksh|ksh93|mksh|pdksh|oksh|ash|yash|csh|tcsh|fish|elvish|xonsh|nu|pwsh|busybox|toybox|screen|tmux|byobu)$/;
/** Interpreters: with -c/-e they run the code given to them; alone, they wait for typed code. */
const INTERPRETERS = /^(python|pypy|perl|ruby|irb|node|nodejs|deno|bun|lua|luajit|php|tclsh|wish|guile|gjs|jshell|julia|rscript|expect|ipython|bpython|ptpython)[\d.]*$/i;
/** Python modules that are an interactive shell or an IDE (python -m idlelib). */
const SHELL_MODULES = /^(idlelib(\..*)?|code|pdb|asyncio|ipython|jupyter.*|qtconsole|thonny|spyder.*|bpython|ptpython)$/i;
/**
 * Apps with a terminal or shell built in (IDEs, programmers' editors, REPLs): whatever is typed into
 * them can run as a command (Emacs' M-x shell, Vim's :!, IDLE, an IDE's terminal panel). Program
 * names or desktop-id parts, with any version after them.
 */
const SHELL_APP = new RegExp("^(x?emacs(client)?|g?vimx?|evim|nvim(-qt)?|neovim(-qt)?|neovide|gnvim|idle|thonny|spyder|code(-insiders|-oss)?|codium|vscodium|visual-studio-code"
  + "|atom|pulsar|subl|sublime_text|sublimetext|sublime-text|kate|geany|gnome-builder|qtcreator|kdevelop|lazarus(-ide)?|monodevelop|netbeans|arduino(-?ide)?"
  + "|rstudio|octave(-gui|-cli)?|matlab|jupyter[\\w-]*|eclipse|idea|intellij[\\w-]*|pycharm|clion|goland|webstorm|rider|phpstorm|rubymine|datagrip|dataspell"
  + "|android-?studio|jetbrains[\\w-]*|fleet|zed|lapce|codeblocks|anjuta)"
  // Versions and editions after the name (emacs-26.1, idle3, idle-python3.6, pycharm-community, idea.sh).
  + "([-_]?\\d[\\w.]*|-(ce|community|professional|ultimate|edu|eap|nightly|preview|beta|stable|bin|gui|cli|qt|gtk\\d?|x11|nox|lucid|python[\\d.]*))*(\\.sh)?$");
const SHELL_APP_ID = /^(org\.gnome\.builder|com\.visualstudio\.code.*|com\.vscodium\.codium|org\.kde\.kate|cc\.arduino\..*|org\.qt-project\.qtcreator|com\.jetbrains\..*|com\.google\.androidstudio|org\.octave\.octave|org\.jupyter\..*)$/;
const SHELL_APP_NAME = /\b(x?emacs|g?vim|neovim|neovide|thonny|spyder|visual studio code|vs ?code|vscodium|code - oss|sublime text|kate|geany|gnome builder|qt ?creator|kdevelop|lazarus|monodevelop|netbeans|arduino|rstudio|octave|matlab|jupyter\w*|eclipse|intellij|jetbrains|pycharm|clion|goland|webstorm|phpstorm|rubymine|datagrip|dataspell|android studio|code::blocks|anjuta)\b/i;

/** Programs that start the next word as the real command (after their own options). */
const WRAPPERS: Record<string, { value?: string; long?: string[]; positional?: number; noCommand?: RegExp }> = {
  nohup: {}, setsid: {}, exec: { value: "a" }, "dbus-launch": { long: ["autolaunch", "config-file"] }, "dbus-run-session": { long: ["config-file", "dbus-daemon"] },
  nice: { value: "n", long: ["adjustment"] },
  ionice: { value: "cnpPu", long: ["class", "classdata", "pid", "pgid", "uid"], noCommand: /^-([a-z]*[pPu]|-pid|-pgid|-uid)/ },
  stdbuf: { value: "ioe", long: ["input", "output", "error"] },
  timeout: { value: "ks", long: ["kill-after", "signal"], positional: 1 },
  taskset: { positional: 1, noCommand: /^-([a-z]*p|-pid)/ },
  chrt: { value: "TPD", long: ["sched-runtime", "sched-period", "sched-deadline"], positional: 1, noCommand: /^-([a-z]*[pm]|-pid|-max)/ },
  flock: { value: "Ew", long: ["conflict-exit-code", "timeout", "wait"], positional: 1 },
  "systemd-cat": { value: "tp", long: ["identifier", "priority", "stderr-priority", "level-prefix"] },
  firejail: {}, torsocks: {}, proxychains: {}, proxychains4: {}, "prime-run": {}, primusrun: {}, optirun: {}, vglrun: { value: "dc" }, gamemoderun: {}, mangohud: {},
  // (Not xdg-terminal-exec: it always opens a terminal, whatever it runs in it, so it is a terminal itself.)
};
/**
 * Programs that run commands Ember can't follow, or as someone else: never started. (systemd-run
 * runs it inside the user's own session, sudo and friends as another user, the launchers start
 * another desktop entry, URL or D-Bus service.)
 */
const REFUSED = /^(sudo|sudoedit|pkexec|su|doas|runuser|run0|sg|newgrp|systemd-run|machinectl|nsenter|unshare|ssh|mosh|telnet|rsh|rlogin|gksu|gksudo|kdesu|kdesudo|beesu|xdg-su|flatpak-spawn|toolbox|distrobox|gtk-launch|gio|gvfs-open|gnome-open|xdg-open|kde-open5?|kioclient5?|exo-open|dex|dbus-send|gdbus|busctl|qdbus(-qt\d)?|dbus-update-activation-environment|snap|xdotool|xte|ydotool)$/;
/** flatpak run options that take a value (the next word, unless given as --name=value). */
const FLATPAK_VALUE = new Set(["arch", "branch", "command", "cwd", "runtime", "runtime-version", "commit", "runtime-commit", "filesystem", "nofilesystem",
  "env", "unset-env", "persist", "socket", "nosocket", "device", "nodevice", "share", "unshare", "allow", "disallow", "talk-name", "no-talk-name",
  "own-name", "system-talk-name", "system-no-talk-name", "system-own-name", "add-policy", "remove-policy", "app-path", "usr-path", "instance-id-fd", "parent-pid", "env-fd"]);

const base = (p: string) => path.basename(p).toLowerCase();
const named = (word: string) => TERMINALS.has(word) || TERMINALS.has(word.replace(/\.(py|pl|rb|js|sh)$/, ""));
const shellApp = (word: string) => SHELL_APP.test(word);

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
function runsTerminal(argv: string[], depth = 0): boolean {
  if (!argv.length) return false;
  if (depth > 8) return true; // wrappers inside wrappers: Ember doesn't follow that far
  const prog = base(argv[0]), args = argv.slice(1);
  if (REFUSED.test(prog)) return true;
  if (prog === "env") return runsTerminal(envCommand(args, 0), depth + 1);
  const wrapper = WRAPPERS[prog];
  if (wrapper) {
    if (wrapper.noCommand && args.some(a => wrapper.noCommand!.test(a))) return false;
    // flock -c runs its string with sh.
    if (prog === "flock") {
      const c = args.findIndex(a => a === "-c" || a === "--command" || a.startsWith("--command="));
      if (c >= 0) return runsTerminal(["sh", "-c", args[c].startsWith("--command=") ? args[c].slice(10) : args[c + 1] ?? ""], depth + 1);
    }
    return runsTerminal(afterOptions(args, wrapper.value, wrapper.long, wrapper.positional), depth + 1);
  }
  if (named(prog) || shellApp(prog) || argv.some(a => /TerminalEmulator/i.test(a))) return true;
  if (prog === "flatpak") {
    const f = flatpakCommand(args);
    if (f === true) return true;
    if (!f) return false;
    return idIsTerminal(f.id) || idHasShell(f.id) || (!!f.argv && runsTerminal(f.argv, depth + 1));
  }
  if (!SHELLS.test(prog) && !INTERPRETERS.test(prog)) return false;
  // Inline code (sh -c "…", python -c "…", perl -e "…"): refuse it if it starts any of the above.
  const inline = args.findIndex(a => /^-[a-zA-Z]*[ceE]$/.test(a));
  if (inline >= 0) {
    const code = args.slice(inline + 1).join(" ");
    if (SHELLS.test(prog) && runsTerminal(execArgv(code.replace(/[;&|()`$<>]/g, " ")), depth + 1)) return true;
    return (code.match(/[\w./+-]+/g) ?? []).some(w => named(base(w)) || shellApp(base(w)) || REFUSED.test(base(w)));
  }
  // python -m idlelib, python -m code: an interactive shell.
  const m = args.findIndex(a => a === "-m");
  if (m >= 0 && INTERPRETERS.test(prog)) return SHELL_MODULES.test(args[m + 1] ?? "");
  // A script runs: refuse only a script that is itself a terminal (terminator is a Python program) or an IDE.
  const script = args.find(a => !a.startsWith("-"));
  return script ? named(base(script)) || shellApp(base(script)) : true;
}

const idWords = (id: string) => id.toLowerCase().replace(/\.desktop$/, "").split(".");
const idIsTerminal = (id: string) => idWords(id).some(p => named(p) || p === "console" || p.split(/[-_]/).some(w => named(w) || w === "console"));
const idHasShell = (id: string) => SHELL_APP_ID.test(id.toLowerCase().replace(/\.desktop$/, "")) || idWords(id).some(shellApp);

/**
 * Does this app have a terminal or shell built in (an IDE, Emacs, Vim, IDLE)? Text typed into it
 * can run commands, so Ember doesn't open it (isTerminalApp() includes this). LibreOffice isn't
 * one: on Ember's desk it runs with macros off (desk/place.ts).
 */
export function hasBuiltInShell(app: Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "categories">>): boolean {
  if (app.categories?.some(c => /^IDE$/i.test(c))) return true;
  if (idHasShell(app.id) || SHELL_APP_NAME.test(app.name) || /\bIDLE\b/.test(app.name)) return true;
  const argv = app.exec ? execArgv(app.exec) : [];
  return argv.length > 0 && shellApp(base(argv[0]));
}

/**
 * Is this a terminal, a shell, or an app with one built in? Ember doesn't run commands, so it never
 * opens one, on its desk or on the user's screen: both ways of opening apps ask this. Checks the
 * desktop id, name, Categories (TerminalEmulator, IDE), Terminal=true and what the Exec line starts,
 * through wrappers (env, timeout, flatpak run --command…); programs that run commands as someone
 * else or elsewhere (sudo, systemd-run, gtk-launch, gio launch…) count too.
 */
export function isTerminalApp(app: Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "categories" | "terminal">>): boolean {
  if (app.terminal) return true;
  if (app.categories?.some(c => /^TerminalEmulator$/i.test(c))) return true;
  if (idIsTerminal(app.id) || hasBuiltInShell(app)) return true;
  if (/\b(terminal|console)\b/i.test(app.name) || named(app.name.trim().toLowerCase().replace(/\s+/g, "-"))) return true;
  return !!app.exec && runsTerminal(execArgv(app.exec));
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
 */
export function findApp(apps: DesktopApp[], query: string): DesktopApp | null {
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
    if (isTerminalApp(a)) return t - 2;
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
 * The environment for apps Ember starts, built from an allowlist: Ember's own
 * environment holds its GitHub sign-in and keys, which an app must never get.
 * Electron's markers are left out too: Chromium sets NO_AT_BRIDGE=1 (and GTK
 * disables accessibility if the variable exists at all), so apps would be
 * invisible to Ember's screen reading. `session: false` is for Ember's desk,
 * which adds its own display, bus and user folders.
 */
export function appEnv(base: NodeJS.ProcessEnv = process.env, o: { session?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (KEEP.test(k) || (o.session !== false && SESSION.test(k))) && !NEVER.test(k)) env[k] = v;
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
    const argv = app.exec ? execArgv(app.exec) : [];
    if (!argv.length) return;
    const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env: appEnv(), cwd: launchCwd() });
    c.on("error", () => { /* the caller notices no window appeared */ });
    c.unref();
  };
  const child = spawn("gtk-launch", [app.id], { detached: true, stdio: "ignore", env: appEnv(), cwd: launchCwd() });
  child.on("error", fallback);
  child.unref();
}
