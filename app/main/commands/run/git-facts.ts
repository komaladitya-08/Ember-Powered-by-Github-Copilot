/**
 * A work tree's push facts (§3.7, critique security-8; package RUN): the branch checked out, `push.default` and the
 * upstream, read with three fixed, read-only git commands in the command's folder, so the intent matcher can tell what
 * a bare `git push` would push. Null outside a work tree and whenever an answer can't be trusted (a failed or timed-out
 * read of `push.default` must never pass for "unset", which means "simple"): then the command asks. git runs with the
 * command environment's rules (no Ember sign-in), no prompts and no optional locks, hidden on Windows.
 */

import { spawn } from "node:child_process";
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

/** The real GitRun: `git` from the command environment's PATH, stdin closed, killed at the deadline. */
export function gitRunner(o: { os: OS; env: NodeJS.ProcessEnv; extraPath: string[] }): GitRun {
  const env = commandEnv(o.env, { os: o.os, pty: false, remote: false, extraPath: o.extraPath, runId: "" });
  delete env.EMBER_RUN_ID;
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
  return (args, { cwd, timeoutMs }) => new Promise(resolve => {
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
      child = spawn("git", [...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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
  });
}
