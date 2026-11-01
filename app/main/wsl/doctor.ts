/**
 * The doctor's `wsl` row (§8.8): which WSL this PC has, whether WSLg can show Linux apps, which distros Ember sees,
 * and whether a Windows X server is showing Linux apps Ember can't use. WB owns the per-distro `wsl-helper:<distro>`
 * and `wsl-a11y:<distro>` rows. The row's words are pure (tested); the X-server check lists Windows' processes once,
 * read-only, with `tasklist` (hidden, 5 s), only when the doctor asks.
 */

import pathWin32 from "node:path/win32";
import type { PlatformDoctorRow } from "../platform/types";
import type { WslFacts } from "./types";
import { WSL_SPAWN_OPTIONS, envGet, type WslChild, type WslSpawn } from "./discover";
import { cleanEnv } from "../platform/compose";

/** Windows X servers whose windows Ember can't identify (§4.6; critique wsl-15), by image name. */
export const X_SERVERS: readonly { image: RegExp; name: string }[] = [
  { image: /^vcxsrv\.exe$/i, name: "VcXsrv" },
  { image: /^x410\.exe$/i, name: "X410" },
  { image: /^xming\.exe$/i, name: "Xming" },
  { image: /^xwin\.exe$/i, name: "Cygwin/X" },
  // GWSL.exe (its dashboard), GWSL_service.exe, and the X server itself: GWSL_vcxsrv.exe or GWSL_vcxsrv_lowdpi.exe
  // (the same names policy/remote-surface.ts refuses and masks).
  { image: /^gwsl(?:_\w+)?\.exe$/i, name: "GWSL" },
];

/** "2.3.26.0" → "2.3.26" (the doctor's short form). */
export function shortVersion(v: string): string {
  return v.split(".").slice(0, 3).join(".");
}

/** The X server among these process image names, or null. */
export function runningXServer(images: readonly string[]): string | null {
  for (const x of X_SERVERS) if (images.some(i => x.image.test(i))) return x.name;
  return null;
}

/**
 * The `wsl` row (§8.8), or none when WSL isn't installed (nothing to fix there). Warnings, most important first: no
 * distros; the inbox WSL (no WSLg, `wsl --update`); WSLg turned off in `.wslconfig`; an X server showing Linux apps.
 */
export function wslDoctorRows(f: WslFacts, o: { xServer: string | null }): PlatformDoctorRow[] {
  if (!f.installed) return [];
  const row = (status: PlatformDoctorRow["status"], detail: string, fix?: string): PlatformDoctorRow[] =>
    [{ id: "wsl", status, label: "WSL", detail, ...(fix ? { fix } : {}) }];
  if (f.distros.length === 0) return row("warn", "No WSL distros");
  if (f.wslVersion === null) return row("warn", "WSL needs an update for Linux apps", "Run `wsl --update`.");
  if (f.wslg.disabledByUser) return row("warn", "WSL is installed but WSLg is off", "Remove guiApplications=false from %USERPROFILE%\\.wslconfig.");
  if (o.xServer) return row("warn", "Linux apps shown by an X server (VcXsrv, X410…) can't be used; WSLg's can.");
  const names = f.distros.map(d => d.name).join(", ");
  return row("ok", `WSL ${shortVersion(f.wslVersion)}${f.wslg.available ? " with WSLg" : ""}; distros: ${names}`);
}

/** The first field of each `tasklist /FO CSV /NH` line (the image name). */
export function parseTasklist(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line.trim());
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/** Windows' running process image names (`tasklist /FO CSV /NH`, hidden, 5 s); null when they can't be listed. */
export function listProcessImages(spawn: WslSpawn, env: NodeJS.ProcessEnv, timeoutMs = 5_000): Promise<string[] | null> {
  const root = envGet(env, "SystemRoot") ?? envGet(env, "windir");
  if (!root) return Promise.resolve(null);
  const exe = pathWin32.join(root, "System32", "tasklist.exe");
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanEnv(env, { os: "win32" }))) if (v !== undefined) clean[k] = v;
  return new Promise(resolve => {
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (v: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: WslChild;
    try {
      child = spawn(exe, ["/FO", "CSV", "/NH"], { ...WSL_SPAWN_OPTIONS, env: clean });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    child.stdin?.on("error", () => undefined); // tasklist reads nothing
    child.stdin?.end();
    child.stdout?.on("data", b => chunks.push(b));
    child.on("error", () => finish(null));
    child.on("close", code => finish(code === 0 ? parseTasklist(Buffer.concat(chunks).toString("latin1")) : null));
  });
}
