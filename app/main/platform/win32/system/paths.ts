/**
 * Where Ember keeps things on Windows, and where it finds the GitHub CLI. Data lives in %LOCALAPPDATA%\ember, not the
 * roaming profile (D7): it holds Chromium's caches, Copilot's session state and 126 MB of speech models, which would
 * bloat a roaming profile. The settings window names it "%LOCALAPPDATA%\ember" unless EMBER_USER_DATA moved it.
 * Saving settings retries a rename refused by an antivirus scan or a sync client (EPERM/EBUSY/EACCES). Apps started
 * from the Start menu or at sign-in get the user's PATH, but gh may be installed where PATH doesn't reach (winget's
 * links, Scoop, Chocolatey), so those folders are tried after it; only gh.exe is accepted, never gh.cmd/gh.bat (Node
 * refuses to start those without a shell since CVE-2024-27980, and Ember never uses a shell).
 */

import path from "node:path";
import type { SystemPaths } from "../../types";
import { envValue, which } from "./interim";

const wpath = path.win32;

/** The default data folder: %LOCALAPPDATA%\ember (or <home>\AppData\Local\ember without the variable). */
export function defaultUserData(env: NodeJS.ProcessEnv, home: string): string {
  return wpath.join(envValue(env, "LOCALAPPDATA") ?? wpath.join(home, "AppData", "Local"), "ember");
}

/** Windows' SystemPaths. */
export function win32Paths(o: { env: NodeJS.ProcessEnv; arch?: string }): SystemPaths {
  const arch = o.arch ?? process.arch;
  return {
    userData: (_appData, home) => defaultUserData(o.env, home),
    runtimeId: `win32-${arch}`,
    runtimeExe: "copilot-runtime.exe",
    dataDirLabel(userData, file) {
      const local = envValue(o.env, "LOCALAPPDATA");
      const isDefault = !!local && wpath.normalize(userData).toLowerCase() === wpath.join(local, "ember").toLowerCase();
      const dir = isDefault ? "%LOCALAPPDATA%\\ember" : userData;
      return file ? `${dir}\\${file}` : dir;
    },
    renameRetries: 5,
  };
}

/** Where gh.exe may be when it isn't on PATH, in order (winget, Scoop and Chocolatey installs included). */
export function ghCandidates(env: NodeJS.ProcessEnv, programData: string | null): string[] {
  const out: string[] = [];
  const add = (dir: string | null | undefined, ...rest: string[]) => { if (dir) out.push(wpath.join(dir, ...rest)); };
  add(envValue(env, "ProgramFiles"), "GitHub CLI", "gh.exe");
  add(envValue(env, "LOCALAPPDATA"), "Microsoft", "WinGet", "Links", "gh.exe");
  add(envValue(env, "USERPROFILE"), "scoop", "shims", "gh.exe");
  add(programData, "chocolatey", "bin", "gh.exe");
  return out;
}

/** How long a gh lookup is kept (the sign-in loop asks every 3 s). */
export const GH_CACHE_MS = 60_000;

/** systemPlatform.ghCliPath and which, with Windows' rules. */
export function win32Which(o: {
  env: NodeJS.ProcessEnv; programData: () => string | null; isFile: (p: string) => boolean; now?: () => number;
}): { which(cmd: string): string | null; ghCliPath(): string | null } {
  const now = o.now ?? Date.now;
  let gh: { at: number; path: string | null } | null = null;
  const find = (cmd: string) => which(cmd, { os: "win32", env: o.env, isExecutable: o.isFile });
  return {
    which: find,
    ghCliPath() {
      if (gh && now() - gh.at < GH_CACHE_MS) return gh.path;
      const found = find("gh") ?? ghCandidates(o.env, o.programData()).find(p => o.isFile(p)) ?? null;
      gh = { at: now(), path: found };
      return found;
    },
  };
}

/** Folders a bundled copy of the speech models may be in, in order: beside Ember, then shared by an administrator. */
export function bundledModelDirs(resourcesPath: string, programData: string | null): string[] {
  return [wpath.join(resourcesPath, "voice-models"), ...(programData ? [wpath.join(programData, "Ember", "voice-models")] : [])];
}
