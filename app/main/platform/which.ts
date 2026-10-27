/**
 * which(): where a command lives on PATH, with each OS's rules, over an injected environment and file check so the
 * Windows and macOS rules are unit-tested on Linux. Windows: PATH is read whatever the case of its name, split on
 * ";", quotes stripped, and only .exe/.com files count, never .cmd/.bat (Node refuses to start those without a shell
 * since CVE-2024-27980, and Ember never uses a shell). Linux and macOS: today's ":"-split PATH and X_OK test.
 */

import fs from "node:fs";
import path from "node:path";
import type { OS } from "../../shared/shortcuts";

/** Extensions a Windows program Ember starts may have, in the order they are tried. */
const WIN32_EXTS = [".exe", ".com"];

/** PATH when the environment has none: the system folders (Linux and macOS; today's default). */
const POSIX_DEFAULT_PATH = "/usr/bin:/bin";

/** The value of `name` in `env`, compared without regard to case on Windows (its environment is case-insensitive). */
function envValue(env: NodeJS.ProcessEnv, name: string, os: OS): string | undefined {
  if (os !== "win32") return env[name];
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase() && env[k] !== undefined);
  return key === undefined ? undefined : env[key];
}

/** The default file test: Linux and macOS, executable by this user (X_OK, as before); Windows, an existing file (X_OK means nothing there). */
function defaultIsExecutable(os: OS): (p: string) => boolean {
  if (os === "win32") return p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  return p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
}

/**
 * The file names to try for `cmd` in one folder. Windows: `cmd` itself when it already ends in .exe or .com, else
 * `cmd.exe` then `cmd.com` (those of the two that PATHEXT lists, when it is set), so a .cmd or .bat file is never the
 * answer. Elsewhere: `cmd`.
 */
function candidates(cmd: string, os: OS, env: NodeJS.ProcessEnv): string[] {
  if (os !== "win32") return [cmd];
  if (WIN32_EXTS.includes(path.win32.extname(cmd).toLowerCase())) return [cmd];
  const pathext = envValue(env, "PATHEXT", os);
  const listed = pathext ? new Set(pathext.split(";").map(e => e.trim().toLowerCase()).filter(Boolean)) : null;
  return WIN32_EXTS.filter(e => !listed || listed.has(e)).map(e => cmd + e);
}

/**
 * The absolute path of `cmd` on PATH, or null. Folders come from PATH (os-specific delimiter, surrounding quotes
 * stripped, empty entries skipped on Windows), then `extraDirs` (folders an app started from Finder or at login
 * doesn't have on its PATH: Homebrew's, MacPorts'). A `cmd` that is already a path is checked as it is.
 */
export function which(cmd: string, o: { os: OS; env: NodeJS.ProcessEnv; extraDirs?: readonly string[]; isExecutable?: (p: string) => boolean }): string | null {
  const { os, env } = o;
  const p = os === "win32" ? path.win32 : path.posix;
  const isExecutable = o.isExecutable ?? defaultIsExecutable(os);
  if (!cmd) return null;
  const names = candidates(cmd, os, env);
  if (cmd.includes("/") || (os === "win32" && cmd.includes("\\"))) {
    for (const n of names) if (p.isAbsolute(n) && isExecutable(n)) return n;
    return null;
  }
  const delimiter = os === "win32" ? ";" : ":";
  const fromPath = envValue(env, "PATH", os) ?? (os === "win32" ? "" : POSIX_DEFAULT_PATH);
  const dirs = [...fromPath.split(delimiter), ...(o.extraDirs ?? [])].map(d => (os === "win32" ? d.replace(/"/g, "").trim() : d));
  for (const dir of dirs) {
    // Windows never searches the working folder through an empty entry; on Linux and macOS an empty or relative entry
    // means the working folder, as the shell reads it (resolved, so the answer is still an absolute path).
    if (os === "win32" && !p.isAbsolute(dir)) continue;
    const folder = os === "win32" ? dir : p.resolve(dir || ".");
    for (const n of names) {
      const full = p.join(folder, n);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}
