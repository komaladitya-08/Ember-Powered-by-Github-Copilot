/**
 * The real GitRun (app/main/commands/run/git-facts.ts): git is found by absolute PATH folders only, run with the
 * command environment's rules (no Ember marker, no prompts, no optional locks), stdin closed, stdout capped and killed
 * at the deadline. Fake git programs are real shell scripts in fresh temp folders; the POSIX-only ones run everywhere
 * but Windows, which keeps the no-git and system-git cases.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitRunner, readGitFacts } from "../../app/main/commands/run/git-facts";

type Platform = "linux" | "darwin" | "win32";
const platform = process.platform as Platform;
const sep = platform === "win32" ? ";" : ":";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-git-runner-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A POSIX single-quoted shell word, so a temp path is safe even when it holds quotes. */
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Writes an executable `git` shell script into `dir`. */
function fakeGit(dir: string, body: string): string {
  const file = path.join(dir, "git");
  fs.writeFileSync(file, `#!/bin/sh\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

const runner = (env: NodeJS.ProcessEnv, extraPath: string[] = []) => gitRunner({ os: platform, env, extraPath });

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function readWhenWritten(file: string, ms = 2000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      if (Date.now() > deadline) throw new Error(`${file} was never written`);
      await wait(10);
    }
  }
}

async function waitUntilDead(pid: number, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`pid ${pid} is still alive`);
    await wait(10);
  }
}

/** The system git executable when PATH has one (the same absolute-folder rule findGit uses). */
function systemGitPath(): string | null {
  const pathVar = Object.entries(process.env).find(([k]) => k.toUpperCase() === "PATH")?.[1];
  for (const raw of (pathVar ?? "").split(sep)) {
    const dir = platform === "win32" ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, platform === "win32" ? "git.exe" : "git");
    try {
      if (fs.statSync(file).isFile()) {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      }
    } catch {
      // unreadable: the next folder
    }
  }
  return null;
}

const systemGit = systemGitPath();

describe("gitRunner without git", () => {
  it("answers code null, and never runs a git in the command's folder", async () => {
    const cwd = tempDir();
    const marker = path.join(cwd, "marker");
    fakeGit(cwd, `printf ran > ${shq(marker)}\n`);

    const empty = tempDir();
    await expect(runner({ PATH: empty })(["rev-parse"], { cwd, timeoutMs: 1000 })).resolves.toEqual({ code: null, stdout: "" });
    expect(fs.existsSync(marker)).toBe(false);

    // Relative and empty PATH entries are the command's folder or under it: never searched.
    await expect(runner({ PATH: `.${sep}` })(["rev-parse"], { cwd, timeoutMs: 1000 })).resolves.toEqual({ code: null, stdout: "" });
    expect(fs.existsSync(marker)).toBe(false);

    // No PATH at all is no git either.
    await expect(runner({})(["rev-parse"], { cwd, timeoutMs: 1000 })).resolves.toEqual({ code: null, stdout: "" });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe.runIf(process.platform !== "win32")("gitRunner with a fake git on PATH", () => {
  it("skips a directory, a non-executable file and a dangling entry, then uses the next folder", async () => {
    const dirAsGit = tempDir();
    fs.mkdirSync(path.join(dirAsGit, "git"));
    const plainFile = tempDir();
    const plainMarker = path.join(plainFile, "marker");
    fs.writeFileSync(path.join(plainFile, "git"), `#!/bin/sh\nprintf ran > ${shq(plainMarker)}\n`, { mode: 0o644 });
    fs.chmodSync(path.join(plainFile, "git"), 0o644);
    const dangling = tempDir();
    fs.symlinkSync(path.join(dangling, "missing"), path.join(dangling, "git"));
    const used = tempDir();
    fakeGit(used, "printf 'later\\n'\n");

    const cwd = tempDir();
    const env = { PATH: [dirAsGit, plainFile, dangling, used].join(sep) };
    await expect(runner(env)(["x"], { cwd, timeoutMs: 2000 })).resolves.toEqual({ code: 0, stdout: "later\n" });
    expect(fs.existsSync(plainMarker)).toBe(false);
  });

  it("passes the args verbatim and runs in cwd", async () => {
    const bin = tempDir();
    fakeGit(bin, `printf '%s\\n' "$PWD"\nprintf '%s\\n' "$@"\n`);
    const cwd = fs.realpathSync(tempDir());
    await expect(runner({ PATH: bin })(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 2000 })).resolves.toEqual({
      code: 0, stdout: `${cwd}\nrev-parse\n--abbrev-ref\nHEAD\n`,
    });
  });

  it("returns the exit code and stdout, and ignores stderr", async () => {
    const bin = tempDir();
    fakeGit(bin, "printf 'out\\n'\nprintf 'err\\n' >&2\nexit 3\n");
    await expect(runner({ PATH: bin })(["x"], { cwd: tempDir(), timeoutMs: 2000 })).resolves.toEqual({ code: 3, stdout: "out\n" });
  });

  it("closes stdin, so a reader sees EOF at once", async () => {
    const bin = tempDir();
    fakeGit(bin, "read line\nexit 0\n");
    const started = Date.now();
    await expect(runner({ PATH: bin })(["x"], { cwd: tempDir(), timeoutMs: 1000 })).resolves.toEqual({ code: 0, stdout: "" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("sets no-lock and no-prompt variables and drops the caller's EMBER_RUN_ID", async () => {
    const bin = tempDir();
    fakeGit(bin, `printf '%s\\n' "$GIT_OPTIONAL_LOCKS" "$GIT_TERMINAL_PROMPT" "\${EMBER_RUN_ID-<unset>}"\n`);
    const env = { PATH: bin, EMBER_RUN_ID: "caller", GIT_OPTIONAL_LOCKS: "1", GIT_TERMINAL_PROMPT: "1" };
    const got = await runner(env)(["x"], { cwd: tempDir(), timeoutMs: 2000 });
    expect(got.code).toBe(0);
    expect(got.stdout.split("\n")).toEqual(["0", "0", "<unset>", ""]);
  });

  it("answers code null when the child cannot start or spawn rejects the args", async () => {
    const bin = tempDir();
    fakeGit(bin, "printf 'never\\n'\n");
    const run = runner({ PATH: bin });
    await expect(run(["x"], { cwd: path.join(tempDir(), "missing"), timeoutMs: 1000 })).resolves.toEqual({ code: null, stdout: "" });
    await expect(run(["bad\0arg"], { cwd: tempDir(), timeoutMs: 1000 })).resolves.toEqual({ code: null, stdout: "" });
  });

  it("finds git in an extraPath folder appended to PATH", async () => {
    const bin = tempDir();
    fakeGit(bin, "printf 'extra\\n'\n");
    const empty = tempDir();
    await expect(runner({ PATH: empty }, [bin])(["x"], { cwd: tempDir(), timeoutMs: 2000 })).resolves.toEqual({ code: 0, stdout: "extra\n" });
  });

  it("kills the child at the deadline, answers code null and leaves no process behind", async () => {
    const bin = tempDir();
    const pidFile = path.join(bin, "pid");
    fakeGit(bin, `printf '%s' "$$" > ${shq(pidFile)}\nexec /bin/sleep 10\n`);

    const started = Date.now();
    const got = await runner({ PATH: bin })(["x"], { cwd: tempDir(), timeoutMs: 200 });
    const elapsed = Date.now() - started;
    expect(got).toEqual({ code: null, stdout: "" });
    expect(elapsed).toBeLessThan(2000);

    const pid = Number((await readWhenWritten(pidFile)).trim());
    expect(pid).toBeGreaterThan(0);
    await waitUntilDead(pid);
  });

  it("caps stdout near 4096 bytes when git prints 20000", async () => {
    const bin = tempDir();
    const chunk = "x".repeat(2500);
    fakeGit(bin, `for i in 1 2 3 4 5 6 7 8; do\nprintf '%s' '${chunk}'\n/bin/sleep 0.02\ndone\n`);
    const got = await runner({ PATH: bin })(["x"], { cwd: tempDir(), timeoutMs: 5000 });
    expect(got.code).toBe(0);
    expect(got.stdout.length).toBeGreaterThanOrEqual(4096);
    expect(got.stdout.length).toBeLessThan(20000);
  });
});

describe.runIf(systemGit !== null)("gitRunner with the system git", () => {
  it("reads the branch of a fresh repository end to end", async ({ skip }) => {
    if (systemGit === null) return skip();
    const repo = tempDir();
    const home = tempDir();
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1",
    };
    try {
      execFileSync(systemGit, ["init", "-q", "-b", "main"], { cwd: repo, env, stdio: "ignore" });
      execFileSync(systemGit, ["-c", "user.name=Ember Test", "-c", "user.email=ember@example.test", "commit", "-q", "--allow-empty", "-m", "init"], {
        cwd: repo, env, stdio: "ignore",
      });
    } catch {
      return skip(); // an old git or a locked-down machine: no cheap real repository
    }

    const run = gitRunner({ os: platform, env, extraPath: [] });
    await expect(readGitFacts(repo, run)).resolves.toEqual({ branch: "main", pushDefault: null, upstream: null });
  });
});
