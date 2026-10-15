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
async function locate(name: SettingName): Promise<{ key: Key; encode: (v: string) => string; decode: (raw: string) => string }> {
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
      return { key: { schema: "org.gnome.desktop.interface", key: "gtk-theme" }, encode: v => (bool(v) === "true" ? "'Adwaita-dark'" : "'Adwaita'"), decode: raw => String(raw.includes("dark")) };
    }
  }
}

/** Changes a setting and reads it back. Returns the value now in effect. */
export async function changeSetting(name: SettingName, value: string): Promise<{ before: string; after: string }> {
  const { key, encode, decode } = await locate(name);
  if (!(await hasKey(key))) throw new Error(`${SETTINGS[name]} is not available on this desktop`);
  const before = decode(await run("gsettings", ["get", key.schema, key.key]));
  await run("gsettings", ["set", key.schema, key.key, encode(value)]);
  const after = decode(await run("gsettings", ["get", key.schema, key.key]));
  return { before, after };
}

export interface DesktopApp { id: string; name: string; file: string; keywords: string[]; exec?: string }

export function parseDesktopFile(text: string): { name: string; keywords: string[]; visible: boolean; exec?: string } | null {
  let section = "";
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) { section = t; continue; }
    if (section !== "[Desktop Entry]") continue;
    const i = t.indexOf("=");
    if (i > 0) kv[t.slice(0, i)] = t.slice(i + 1);
  }
  if (kv.Type !== "Application" || !kv.Name) return null;
  const visible = kv.NoDisplay !== "true" && kv.Hidden !== "true";
  return {
    name: kv.Name, keywords: [kv.GenericName, ...(kv.Keywords ?? "").split(";")].filter(Boolean).map(s => s!.toLowerCase()), visible,
    ...(kv.Exec ? { exec: kv.Exec } : {}),
  };
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
        if (parsed?.visible) seen.set(id, { id, name: parsed.name, file: path.join(dir, f), keywords: parsed.keywords, exec: parsed.exec });
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
  const fallback = () => {
    const argv = app.exec ? execArgv(app.exec) : [];
    if (!argv.length) return;
    const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" });
    c.on("error", () => { /* the caller notices no window appeared */ });
    c.unref();
  };
  const child = spawn("gtk-launch", [app.id], { detached: true, stdio: "ignore" });
  child.on("error", fallback);
  child.unref();
}
