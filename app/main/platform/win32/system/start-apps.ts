/**
 * The packaged apps on the Start menu: Store apps such as ChatGPT and WhatsApp have no shortcut file, so the catalogue
 * didn't know them and Ember said they weren't installed (audit log of 2026-11-02). Windows' own list comes from
 * Get-StartApps, read in the background (about 0.6 s, never on the main thread's way) and kept for ten minutes. A list that
 * can't be read leaves the catalogue as it was. Plain Node, with spawn injected, so its rules are tested on any OS.
 */

import type { SpawnOptions } from "node:child_process";

export interface StartApp { name: string; aumid: string }

/** "<package family>!<app id>": anything else on the list is a shortcut, which the catalogue reads itself, or isn't an app. */
const AUMID = /^[\w.-]+_[a-z0-9]{13}![\w.-]+$/i;
/** Uninstallers and the like are on the Start menu too; Ember never offers them. */
const NOT_AN_APP = /\b(uninstall|remove|setup|installer|repair)\b/i;
const KEEP_MS = 10 * 60_000;

/** What Get-StartApps said, as packaged apps Ember may offer. Anything it can't read is left out. */
export function parseStartApps(json: string): StartApp[] {
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return []; }
  const out: StartApp[] = [];
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const { Name: name, AppID: aumid } = (row ?? {}) as { Name?: unknown; AppID?: unknown };
    if (typeof name === "string" && typeof aumid === "string" && name.trim() && AUMID.test(aumid) && !NOT_AN_APP.test(name)) out.push({ name: name.trim(), aumid });
  }
  return out;
}

type Child = {
  stdout: { setEncoding?(e: string): unknown; on(event: "data", fn: (d: string) => void): unknown } | null;
  on(event: "close" | "error", fn: (x: unknown) => void): unknown;
};

/**
 * The list as last read; looking starts a read when it is empty or old. `changed`: a new list came, so a listing built
 * from the last one is stale.
 */
export function startAppsReader(spawn: (command: string, args: string[], options: SpawnOptions) => Child, changed: () => void, now: () => number = Date.now): () => readonly StartApp[] {
  let apps: StartApp[] = [], at = Number.NEGATIVE_INFINITY, reading = false;
  const read = () => {
    reading = true;
    let out = "";
    const done = (ok: boolean) => {
      if (!reading) return;
      reading = false;
      at = now();
      if (!ok) return;
      const next = parseStartApps(out);
      if (next.length && JSON.stringify(next) !== JSON.stringify(apps)) { apps = next; changed(); }
    };
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", d => { out += d; });
      child.on("error", () => done(false));
      child.on("close", code => done(code === 0));
    } catch { done(false); }
  };
  return () => {
    if (!reading && now() - at >= KEEP_MS) read();
    return apps;
  };
}
