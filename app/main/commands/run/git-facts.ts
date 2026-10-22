/**
 * A work tree's push facts (§3.7, critique security-8; package RUN): the branch checked out, `push.default` and the
 * upstream, read with three fixed, read-only git commands in the command's folder, so the intent matcher can tell what
 * a bare `git push` would push. Null outside a work tree and whenever an answer can't be trusted (a failed or timed-out
 * read of `push.default` must never pass for "unset", which means "simple"): then the command asks. git runs with the
 * command environment's rules (no Ember sign-in), no prompts and no optional locks, hidden on Windows.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import type { OS } from "../../../shared/shortcuts";
import type { GitFacts } from "../types";
import { commandEnv } from "./env";

/** The whole read's budget (§3.8.3 step 6). */
export const GIT_FACTS_MS = 5000;

/** The fixed argv of each read (§3.7). */
export const GIT_ARGV = {
  branch: ["rev-parse", "--abbrev-ref", "HEAD"],
  pushDefault: ["config", "--get", "push.default"],
  upstream: ["rev-parse", "--abbrev-ref", "@{u}"],
} as const;

/** Runs git with `args` in `cwd` to its end; `code` null when it couldn't run or ran out of time. */
export type GitRun = (args: readonly string[], o: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string }>;

/** The push facts of the work tree at `cwd`, or null (see the module comment). Never rejects. */
export async function readGitFacts(cwd: string, run: GitRun, timeoutMs = GIT_FACTS_MS): Promise<GitFacts | null> {
  try {
    const [branch, pushDefault, upstream] = await Promise.all([
      run(GIT_ARGV.branch, { cwd, timeoutMs }),
      run(GIT_ARGV.pushDefault, { cwd, timeoutMs }),
      run(GIT_ARGV.upstream, { cwd, timeoutMs }),
    ]);
    if (branch.code !== 0) return null;
    // `git config --get` exits 1 for a key that isn't set; anything else is a failure, not "unset".
    if (pushDefault.code !== 0 && pushDefault.code !== 1) return null;
    const name = firstLine(branch.stdout);
    if (name === "") return null;
    const pd = pushDefault.code === 0 ? firstLine(pushDefault.stdout) : "";
    const up = upstream.code === 0 ? firstLine(upstream.stdout) : "";
    return { branch: name === "HEAD" ? null : name, pushDefault: pd === "" ? null : pd, upstream: up === "" ? null : up };
  } catch {
    return null;
  }
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/)[0] ?? "").trim();
}

/**
 * git's absolute path from PATH's absolute folders (Windows: `git.exe` in each, PATH's name and quotes as Windows reads
 * them), never the command's folder: a bare `spawn("git", { cwd })` on Windows tries `<cwd>\git.exe` (and `git.com`)
 * before PATH (libuv's search_path), so a work tree holding its own git.exe would run it before the user was asked
 * anything; a relative or empty PATH entry does the same on POSIX. Null when no git is found (the facts are then null).
 */
export async function findGit(env: Record<string, string>, os: OS, isFile: (p: string) => Promise<boolean>): Promise<string | null> {
  const P = os === "win32" ? win32 : posix;
  const path = os === "win32" ? Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] : env.PATH;
  for (const raw of (path ?? "").split(os === "win32" ? ";" : ":")) {
    const dir = os === "win32" ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
    // Relative entries ("", ".", "bin") are the command's folder or under it: never searched.
    if (dir === "" || !P.isAbsolute(dir) || dir.includes("\0") || (os === "win32" && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/?.])/.test(dir))) continue;
    const file = P.join(dir, os === "win32" ? "git.exe" : "git");
    try {
      if (await isFile(file)) return file;
    } catch {
      // unreadable: the next folder
    }
  }
  return null;
}

/** An executable regular file (Windows: a regular file; X_OK says nothing there). */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return false;
    await fs.promises.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The real GitRun: `git` by its absolute path from the command environment's PATH, stdin closed, killed at the deadline. */
export function gitRunner(o: { os: OS; env: NodeJS.ProcessEnv; extraPath: string[] }): GitRun {
  const env = commandEnv(o.env, { os: o.os, pty: false, remote: false, extraPath: o.extraPath, runId: "" });
  delete env.EMBER_RUN_ID;
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
  return (args, { cwd, timeoutMs }) => findGit(env, o.os, isExecutableFile).then(git => new Promise(resolve => {
    if (git === null) {
      resolve({ code: null, stdout: "" });
      return;
    }
    let stdout = "";
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(git, [...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ code: null, stdout: "" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => {
      if (stdout.length < 4096) stdout += s;
    });
    child.on("error", () => done(null));
    child.on("close", code => done(code));
  }), () => ({ code: null, stdout: "" }));
}
