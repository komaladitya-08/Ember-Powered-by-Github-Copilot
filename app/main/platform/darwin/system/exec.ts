/**
 * How the macOS system modules run Apple's command-line tools (/usr/bin/open, defaults, osascript, pgrep, tccutil):
 * by absolute path, never through a shell, with a timeout, and answered as a value instead of a rejection, so every
 * caller decides what an exit status means (`defaults read` exits 1 for "not set", `pgrep` 1 for "none running").
 * The modules take a Run, so they are unit-tested with a fake on any OS.
 */

import { execFile } from "node:child_process";

/** What a run of a tool came to. `code` is the exit status, or null when the tool didn't start or was killed. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it didn't start or end normally: "ENOENT", or "timeout" when the timeout killed it. */
  failure?: string;
}

/** Options for one run. `timeout` defaults to 5000 ms. */
export interface RunOptions { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number }

/** Runs `file` with `args` and resolves with what happened (it never rejects). */
export type Run = (file: string, args: readonly string[], o?: RunOptions) => Promise<RunResult>;

/** The real Run, over execFile (no shell; output capped at 1 MiB, more than any of these tools prints). */
export const execRun: Run = (file, args, o = {}) => new Promise<RunResult>(resolve => {
  try {
    execFile(file, [...args], { encoding: "utf8", timeout: o.timeout ?? 5000, env: o.env, cwd: o.cwd, maxBuffer: 1 << 20, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const failure = e.killed ? "timeout" : typeof e.code === "string" ? e.code : undefined;
        resolve({ code: typeof e.code === "number" ? e.code : null, stdout: stdout ?? "", stderr: stderr ?? "", ...(failure ? { failure } : {}) });
      });
  } catch (err) {
    // execFile throws synchronously for bad arguments (a NUL in an argument): treat it as a run that didn't start.
    resolve({ code: null, stdout: "", stderr: String(err), failure: "EINVAL" });
  }
});
