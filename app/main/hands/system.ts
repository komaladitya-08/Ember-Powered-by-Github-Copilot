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
  /** The Categories key (e.g. "TerminalEmulator"), when the file has one. */
  categories?: string[];
  /** Terminal=true: the app runs inside a terminal window. */
  terminal?: boolean;
}

export function parseDesktopFile(text: string): { name: string; keywords: string[]; visible: boolean; exec?: string; categories?: string[]; terminal?: boolean } | null {
  let section = "";
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) { section = t; continue; }
    if (section !== "[Desktop Entry]") continue;
    const i = t.indexOf("=");
    if (i > 0) kv[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  if (kv.Type !== "Application" || !kv.Name) return null;
  const visible = kv.NoDisplay !== "true" && kv.Hidden !== "true";
  const categories = (kv.Categories ?? "").split(";").map(s => s.trim()).filter(Boolean);
  return {
    name: kv.Name, keywords: [kv.GenericName, ...(kv.Keywords ?? "").split(";")].filter(Boolean).map(s => s!.toLowerCase()), visible,
    ...(kv.Exec ? { exec: kv.Exec } : {}),
    ...(categories.length ? { categories } : {}),
    ...(kv.Terminal === "true" ? { terminal: true } : {}),
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
/** Interpreters: with -c/-e they run the code given to them. */
const INTERPRETERS = /^(python|pypy|perl|ruby|irb|node|nodejs|deno|bun|lua|luajit|php|tclsh|wish|guile|gjs|jshell|julia|rscript|expect)[\d.]*$/i;
/** Programs that start the next word as the real command. */
const WRAPPERS = new Set(["env", "nohup", "setsid", "nice", "ionice", "exec", "stdbuf", "dbus-launch", "dbus-run-session", "chrt", "taskset"]);

const base = (p: string) => path.basename(p).toLowerCase();
const named = (word: string) => TERMINALS.has(word) || TERMINALS.has(word.replace(/\.(py|pl|rb|js|sh)$/, ""));

/** Does this argv (an Exec line, after wrappers) start a terminal or wait for typed commands? */
function runsTerminal(argv: string[], depth = 0): boolean {
  let i = 0;
  while (i < argv.length && WRAPPERS.has(base(argv[i]))) {
    i++;
    while (i < argv.length && (argv[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(argv[i]) || /^\d+$/.test(argv[i]))) i++;
  }
  const args = argv.slice(i);
  if (!args.length) return false;
  const prog = base(args[0]);
  if (named(prog) || args.some(a => /TerminalEmulator/i.test(a))) return true;
  if (prog === "flatpak") {
    const id = args.slice(args.indexOf("run") + 1).find(a => !a.startsWith("-"));
    return !!id && idIsTerminal(id);
  }
  if (!SHELLS.test(prog) && !INTERPRETERS.test(prog)) return false;
  // Inline code (sh -c "…", python -c "…", perl -e "…"): refuse it if it names a terminal anywhere.
  const inline = args.findIndex((a, k) => k > 0 && /^-[a-zA-Z]*[ceE]$/.test(a));
  if (inline > 0) {
    // (The rest of the line: single quotes aren't Exec quoting, so 'a b' arrives split.)
    const code = args.slice(inline + 1).join(" ").replace(/['"]/g, " ");
    if (depth < 3 && SHELLS.test(prog) && runsTerminal(execArgv(code.replace(/[;&|()`$<>]/g, " ")), depth + 1)) return true;
    return (code.match(/[\w./+-]+/g) ?? []).some(w => named(base(w)));
  }
  // A script runs: refuse only a script that is itself a terminal (terminator is a Python program).
  const script = args.slice(1).find(a => !a.startsWith("-"));
  return script ? named(base(script)) : true;
}

const idIsTerminal = (id: string) => {
  const parts = id.toLowerCase().replace(/\.desktop$/, "").split(".");
  return parts.some(p => named(p) || p === "console" || p.split(/[-_]/).some(w => named(w) || w === "console"));
};

/**
 * Is this a terminal (or a shell)? Ember doesn't run commands, so it never
 * opens one, on its desk or on the user's screen. Checks the desktop id, name,
 * Categories (TerminalEmulator), Terminal=true and what the Exec line starts.
 */
export function isTerminalApp(app: Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "categories" | "terminal">>): boolean {
  if (app.terminal) return true;
  if (app.categories?.some(c => /^TerminalEmulator$/i.test(c))) return true;
  if (idIsTerminal(app.id)) return true;
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
        if (parsed?.visible) seen.set(id, { id, name: parsed.name, file: path.join(dir, f), keywords: parsed.keywords, exec: parsed.exec, categories: parsed.categories, terminal: parsed.terminal });
      } catch { /* unreadable */ }
    }
  }
  return [...seen.values()];
}

export function findApp(apps: DesktopApp[], query: string): DesktopApp | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return apps.find(a => a.name.toLowerCase() === q || a.id.toLowerCase() === q)
    ?? apps.find(a => a.name.toLowerCase().includes(q))
    ?? apps.find(a => a.keywords.some(k => k === q || k.includes(q)))
    ?? null;
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

/** The Exec line as argv, without field codes (%U, %f…). No shell is involved. */
export function execArgv(exec: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false, any = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (c === '"') { quoted = !quoted; any = true; continue; }
    if (c === "\\" && quoted && i + 1 < exec.length) { cur += exec[++i]; continue; }
    if (c === " " && !quoted) { if (any) out.push(cur); cur = ""; any = false; continue; }
    cur += c; any = true;
  }
  if (any) out.push(cur);
  return out.filter(a => !/^%[a-zA-Z]$/.test(a)).map(a => a.replace(/%%/g, "%"));
}

/** Launches an app the way the desktop does (gtk-launch), or from its Exec line, detached from Ember. */
export function launchApp(app: DesktopApp): void {
  if (isTerminalApp(app)) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
  const fallback = () => {
    const argv = app.exec ? execArgv(app.exec) : [];
    if (!argv.length) return;
    const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env: appEnv() });
    c.on("error", () => { /* the caller notices no window appeared */ });
    c.unref();
  };
  const child = spawn("gtk-launch", [app.id], { detached: true, stdio: "ignore", env: appEnv() });
  child.on("error", fallback);
  child.unref();
}
