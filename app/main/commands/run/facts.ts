/**
 * What this computer's command runner knows about itself (RunnerFacts; §3.3, §3.10; package RUN): the shells it can
 * run, the default first (Linux: bash, else sh; macOS: zsh, else bash, else sh; Windows: Windows PowerShell 5.1 only,
 * L3), each shell's absolute path (POSIX: made only of [A-Za-z0-9/._-], else that shell isn't offered: the path is
 * written into the launcher's text), script(1) for a PTY (util-linux, told by `script --version`, since BusyBox's has no
 * `-e`; BSD's on macOS), and whether commands run privileged, from the platform's own answer (uid 0 or an elevated
 * token; never parsed from `whoami`, critique integration-23). The remote agent computes its facts with the same code.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import type { OS } from "../../../shared/shortcuts";
import type { RunnerFacts, ShellId } from "../types";

/** A POSIX shell or script(1) path Ember writes into a launcher: absolute and made only of these characters. */
export const SAFE_POSIX_PATH = /^\/[A-Za-z0-9/._-]+$/;

/** The POSIX shells in the order each OS prefers them (the first found is the default). */
const POSIX_ORDER: Readonly<Record<"linux" | "darwin", readonly ("bash" | "zsh" | "sh")[]>> = {
  linux: ["bash", "sh", "zsh"],
  darwin: ["zsh", "bash", "sh"],
};
/** Where shells and script(1) are looked for after the environment's PATH and the extra folders. */
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"];
/** How long `script --version` may take. */
const PROBE_MS = 3000;

/** What localFacts probes (the real filesystem and processes by default; fakes in the tests). */
export interface FactProbes {
  /** An absolute path names an executable regular file. */
  executable(p: string): Promise<boolean>;
  /** Runs a program to its end with stdin closed; `out` is stdout and stderr together; `code` null when it couldn't. */
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }>;
}

/** Windows PowerShell 5.1's path under a Windows folder (%SystemRoot%; C:\Windows when it isn't a plain one). */
export function powershellPath(env: NodeJS.ProcessEnv): string {
  const get = (name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];
  const root = [get("SYSTEMROOT"), get("WINDIR")].find(r => typeof r === "string" && /^[A-Za-z]:\\[^"<>|?*\0\r\n]*$/.test(r)) ?? "C:\\Windows";
  return `${root.replace(/\\+$/, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** This computer's RunnerFacts (shells, script, home, user, privileged, extraPath). */
export function localFacts(o: { os: OS; env: NodeJS.ProcessEnv; home: string; user: string; elevated: () => boolean; extraPath: string[]; ember: RunnerFacts["ember"] }): Promise<RunnerFacts> {
  return localFactsWith(o, NODE_PROBES);
}

/** localFacts with its probes passed in. */
export async function localFactsWith(
  o: { os: OS; env: NodeJS.ProcessEnv; home: string; user: string; elevated: () => boolean; extraPath: string[]; ember: RunnerFacts["ember"] },
  probes: FactProbes,
): Promise<RunnerFacts> {
  let privileged: boolean;
  try {
    privileged = o.elevated() === true;
  } catch {
    privileged = true; // can't tell: every command asks (fail closed)
  }
  const base = { os: o.os, home: o.home, user: o.user, privileged, ember: o.ember, extraPath: [...o.extraPath] };
  if (o.os === "win32") {
    return { ...base, shells: ["powershell"], shellPaths: { powershell: powershellPath(o.env) }, script: null, pty: false };
  }

  const dirs = searchDirs(o.env, o.extraPath);
  const shells: ShellId[] = [];
  const shellPaths: RunnerFacts["shellPaths"] = {};
  for (const shell of POSIX_ORDER[o.os]) {
    const found = await firstExecutable(dirs.map(d => `${d}/${shell}`), probes);
    if (found) {
      shells.push(shell);
      shellPaths[shell] = found;
    }
  }
  const script = await findScript(o.os, dirs, probes);
  return { ...base, shells, shellPaths, script, pty: script !== null };
}

/** The folders searched: PATH's absolute entries, the extra folders, then the system's (each once). */
function searchDirs(env: NodeJS.ProcessEnv, extraPath: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of [...(env.PATH ?? "").split(":"), ...extraPath, ...SYSTEM_DIRS]) {
    const dir = d.replace(/\/+$/, "");
    // A relative entry ("." or "bin") would make the shell depend on the folder Ember was started in.
    if (!dir.startsWith("/") || out.includes(dir)) continue;
    out.push(dir);
  }
  return out;
}

/** The first candidate that is executable and safe to write into a launcher. */
async function firstExecutable(candidates: readonly string[], probes: FactProbes): Promise<string | null> {
  for (const c of candidates) {
    if (!SAFE_POSIX_PATH.test(c)) continue;
    try {
      if (await probes.executable(c)) return c;
    } catch {
      // unreadable: the next candidate
    }
  }
  return null;
}

/** script(1) for a PTY: util-linux's (by `--version`) on Linux, BSD's /usr/bin/script on macOS; else null. */
async function findScript(os: "linux" | "darwin", dirs: readonly string[], probes: FactProbes): Promise<RunnerFacts["script"]> {
  if (os === "darwin") {
    const path = await firstExecutable(["/usr/bin/script"], probes);
    return path ? { path, kind: "bsd" } : null;
  }
  for (const dir of ["/usr/bin", "/bin", ...dirs]) {
    const path = `${dir}/script`;
    if (!SAFE_POSIX_PATH.test(path)) continue;
    if (!(await probes.executable(path).catch(() => false))) continue;
    try {
      const r = await probes.run(path, ["--version"], PROBE_MS);
      // util-linux prints "script from util-linux 2.32.1"; BusyBox's script has no -e and isn't used.
      if (r.code === 0 && /util-linux/.test(r.out)) return { path, kind: "util-linux" };
    } catch {
      // couldn't run it: the next one
    }
  }
  return null;
}

/** The real probes. */
const NODE_PROBES: FactProbes = {
  async executable(p) {
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) return false;
      await fs.promises.access(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  run: (file, args, timeoutMs) => new Promise(resolve => {
    let out = "";
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    } catch {
      resolve({ code: null, out: "" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    const add = (b: Buffer) => {
      if (out.length < 4096) out += b.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", () => done(null));
    child.on("close", code => done(code));
  }),
};
