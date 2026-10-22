/**
 * Commands on this computer for real (design §10.2, jobs `commands-linux`, `commands-linux-el8`, `wsl-windows` and
 * `ssh-macos`): the local runner of app/main/commands/run with real script(1), shells, signals and, on Windows, the
 * built job host (dist/app/job-host.cjs, so `npm run build` first). Linux: a PTY through util-linux script, Ctrl+C,
 * the stop ladder against `sleep 1000 & wait` and a `setsid sleep`, exit codes, a password prompt's answer withheld
 * and the typed line known, `git log` without a pager, timeouts, the command text on no argv, script's stdin held open
 * (util-linux 2.32 ends the session at its EOF), and pipes with stdin closed without script. macOS: zsh by default,
 * BSD script's exit status, the `ps -E` sweep, Homebrew on PATH. Windows: PowerShell 5.1's UTF-8 output, exit codes
 * (a non-terminating cmdlet error included), Constrained Language Mode, the job host ending a Start-Process child at
 * once, no console window, and elevation. Skipped without EMBER_COMMANDS_TEST; with EMBER_COMMANDS_TEST=1 a missing
 * facility (script, the job host) fails instead.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OS } from "../../app/shared/shortcuts";
import type { Logger } from "../../app/main/logger";
import type { CommandRunner, RunExit, RunnerFacts, RunningCommand, RunSpec } from "../../app/main/commands/types";
import { createLocalRunner, createRunner, isKeptRun, type KeptRun } from "../../app/main/commands/run/local";
import { extraBinDirs } from "../../app/main/platform/darwin/system/index";
import { loadWin32System } from "../../app/main/platform/win32/system/ffi";

const required = process.env.EMBER_COMMANDS_TEST === "1";
const platform = process.platform as OS;
const root = fileURLToPath(new URL("../../", import.meta.url));
const jobHostScript = path.join(root, "dist", "app", "job-host.cjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet, file: "" };

async function waitFor(what: string, test: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!test()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** The text a terminal would show, without its control sequences. */
function plain(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, "") // eslint-disable-line no-control-regex -- terminal codes
    .replace(/\r/g, "");
}

/** A process still exists (signal 0 reaches it, and on Linux it isn't a zombie its new parent hasn't reaped yet). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  if (platform !== "linux") return true;
  try {
    // /proc/<pid>/stat: "pid (comm) S …"; the state follows the last ")".
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

/** Every live process (Linux) whose environment carries this run's marker. */
function carriers(runId: string): number[] {
  const out: number[] = [];
  for (const name of fs.readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    try {
      if (fs.readFileSync(`/proc/${name}/environ`).includes(Buffer.from(`EMBER_RUN_ID=${runId}\0`))) out.push(Number(name));
    } catch {
      // gone, or not ours
    }
  }
  return out;
}

interface Started { run: RunningCommand; kept: KeptRun; text(): string; exit: Promise<RunExit> }

let tmp = "";

function start(runner: CommandRunner, facts: RunnerFacts, command: string, o: { shell?: RunSpec["shell"]; timeoutMs?: number; cwd?: string } = {}): Started {
  const spec: RunSpec = {
    runId: randomBytes(8).toString("hex"),
    taskId: "1-integration",
    shell: o.shell ?? facts.shells[0],
    command,
    cwd: o.cwd ?? tmp,
    timeoutMs: o.timeoutMs ?? 30_000,
    cols: 100,
    rows: 30,
    stamp: { taskId: "1-integration", sha256: "0".repeat(64), verdict: "run", classes: [], rules: [], approval: null },
  };
  const run = runner.start(spec);
  if (!isKeptRun(run)) throw new Error("the local runner's runs keep their output");
  const chunks: Buffer[] = [];
  run.onOutput(c => chunks.push(Buffer.from(c)));
  return { run, kept: run, text: () => plain(Buffer.concat(chunks)), exit: run.done };
}

function localRunner(o: { env?: NodeJS.ProcessEnv; extraPath?: string[] } = {}): CommandRunner {
  return createLocalRunner({
    log: quiet,
    os: platform,
    env: o.env ?? process.env,
    ember: { paths: [], pids: () => [process.pid], names: /^ember$/ },
    home: os.homedir(),
    user: os.userInfo().username,
    elevated: () => (platform === "win32" ? loadWin32System()?.elevated() === true : process.getuid?.() === 0),
    extraPath: o.extraPath ?? [],
    jobHost: platform === "win32" ? { execPath: process.execPath, script: jobHostScript } : null,
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-commands-"));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(required && platform === "linux")("commands on Linux", () => {
  const runner = localRunner({ env: { ...process.env, GH_TOKEN: "gho_not-a-real-token" } });
  let facts: RunnerFacts;
  beforeAll(async () => {
    facts = await runner.facts();
  });

  it("finds bash, sh and util-linux script, so runs get a PTY", () => {
    expect(facts.shells[0]).toBe("bash");
    expect(facts.shells).toContain("sh");
    expect(facts.script?.kind).toBe("util-linux");
    expect(facts.pty).toBe(true);
  });

  it("runs in a PTY that tty names, and reports exit codes exactly", async () => {
    const tty = start(runner, facts, "tty");
    expect((await tty.exit).ended).toBe("exit");
    expect(tty.text()).toMatch(/\/dev\/pts\/\d+/);
    expect(tty.run.interactive).toBe(true);
    await expect(start(runner, facts, "exit 3").exit).resolves.toMatchObject({ ended: "exit", code: 3 });
    await expect(start(runner, facts, "false").exit).resolves.toMatchObject({ ended: "exit", code: 1 });
    await expect(start(runner, facts, "exit 4", { shell: "sh" }).exit).resolves.toMatchObject({ ended: "exit", code: 4 });
  });

  it("runs the text exactly as bash -c would: here-docs, several lines, quotes", async () => {
    const r = start(runner, facts, "cat <<'EOF'\nfirst 'quoted' \"line\"\nEOF\necho second $((6*7))");
    expect((await r.exit).code).toBe(0);
    expect(r.text()).toContain("first 'quoted' \"line\"\nsecond 42");
  });

  it("never puts the command text on an argv, unsets EMBER_CMD and keeps Ember's token from the command", async () => {
    const unique = `ember-unique-${randomBytes(4).toString("hex")}`;
    const r = start(runner, facts, `echo "[$EMBER_CMD][$GH_TOKEN][\${EMBER_RUN_ID:+marked}]"; sleep 1; : ${unique}`);
    await sleep(500);
    const onArgv = fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)).filter(n => {
      try {
        return fs.readFileSync(`/proc/${n}/cmdline`).includes(unique);
      } catch {
        return false;
      }
    });
    expect(onArgv).toEqual([]);
    expect((await r.exit).code).toBe(0);
    expect(r.text()).toContain("[][][marked]");
  });

  it("passes Ctrl+C typed into the window to the program", async () => {
    const r = start(runner, facts, "sleep 30; echo after");
    await sleep(500);
    const t0 = Date.now();
    r.run.input(new Uint8Array([3]));
    const exit = await r.exit;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(exit.ended).toBe("exit");
    expect(exit.code).not.toBe(0);
    expect(r.text()).not.toContain("after");
  });

  it("stops `sleep 1000 & wait` and what it left in the background within 1.5 s", async () => {
    const r = start(runner, facts, "sleep 1000 & echo PID=$!; wait");
    await waitFor("the background pid", () => /PID=\d+/.test(r.text()), 5000);
    const pid = Number(/PID=(\d+)/.exec(r.text())?.[1]);
    const t0 = Date.now();
    r.run.stop("user");
    const exit = await r.exit;
    expect(exit.ended).toBe("stopped-user");
    await expect(r.kept.stragglers).resolves.toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(alive(pid)).toBe(false);
    expect(carriers(r.run.runId)).toEqual([]);
  });

  it("stops a `setsid sleep` that left the run's session (the environment sweep)", async () => {
    const r = start(runner, facts, "setsid sleep 1000 & echo PID=$!; sleep 1000");
    await waitFor("the setsid pid", () => /PID=\d+/.test(r.text()), 5000);
    const pid = Number(/PID=(\d+)/.exec(r.text())?.[1]);
    await sleep(200);
    r.run.stop("killswitch");
    expect((await r.exit).ended).toBe("killswitch");
    await r.kept.stragglers;
    await waitFor("the setsid sleep to end", () => !alive(pid), 2000);
    expect(carriers(r.run.runId)).toEqual([]);
  });

  it("withholds the answer to a password prompt and knows the typed line", async () => {
    const r = start(runner, facts, 'read -s -p "Password: " pw; echo; echo "len=${#pw}"; printf "Token: "; read t; echo "got ${#t}"');
    await waitFor("the password prompt", () => r.text().includes("Password:"), 5000);
    r.run.input(new TextEncoder().encode("hunter2-secret\r"));
    await waitFor("the token prompt", () => r.text().includes("Token:"), 5000);
    r.run.input(new TextEncoder().encode("abc-token-123\r"));
    expect((await r.exit).code).toBe(0);
    expect(r.text()).toContain("len=14");
    expect(r.text()).toContain("got 13");
    expect(r.run.typedLines()).toEqual(["hunter2-secret", "abc-token-123"]);
    const kept = r.kept.kept();
    const text = new TextDecoder().decode(kept.bytes);
    // The echoed token answer lies inside a secret span; what is left outside the spans never holds it.
    let outside = "", at = 0;
    for (const s of kept.secretSpans) {
      outside += text.slice(at, s.from);
      at = s.to;
    }
    outside += text.slice(at);
    expect(text).toContain("abc-token-123");
    expect(outside).not.toContain("abc-token-123");
    expect(outside).toContain("Password:");
    r.run.forgetTyped();
    expect(r.run.typedLines()).toEqual([]);
  });

  it("runs git log to its end without a pager waiting for keys", async () => {
    const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Ember Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    // More lines than the PTY's 30 rows: a pager would wait for a key.
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(repo, "f.txt"), String(i));
      git("add", "f.txt");
      git("commit", "-q", "-m", `change ${i}`);
    }
    const r = start(runner, facts, "git log", { cwd: repo, timeoutMs: 10_000 });
    const exit = await r.exit;
    expect(exit).toMatchObject({ ended: "exit", code: 0 });
    expect(r.text()).toContain("change 0");
  }, 30_000);

  it("stops a run at its timeout and says so", async () => {
    const t0 = Date.now();
    const r = start(runner, facts, "sleep 30", { timeoutMs: 1000 });
    expect((await r.exit).ended).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("keeps script's stdin open while the command runs (util-linux 2.32 would end the session at its EOF)", async () => {
    const r = start(runner, facts, "sleep 2; echo still-here");
    expect((await r.exit).code).toBe(0);
    expect(r.text()).toContain("still-here");
  });

  it("fails to start, with the reason, when the shell can't be started", async () => {
    const broken = createRunner(
      { log: quiet, os: "linux", env: process.env, ember: { paths: [], pids: () => [], names: /^ember$/ }, home: os.homedir(), user: "u", elevated: () => false, extraPath: [], jobHost: null },
      { facts: async () => ({ ...facts, shellPaths: { ...facts.shellPaths, bash: "/nonexistent/bash" } }) },
    );
    const r = start(broken, facts, "echo never");
    const exit = await r.exit;
    expect(exit.ended).toBe("failed-to-start");
    expect(exit.error).toMatch(/nonexistent/);
  });

  it("runs on pipes with stdin closed when there is no script(1), and nothing waits for a password", async () => {
    const pipes = createRunner(
      { log: quiet, os: "linux", env: process.env, ember: { paths: [], pids: () => [], names: /^ember$/ }, home: os.homedir(), user: "u", elevated: () => false, extraPath: [], jobHost: null },
      { facts: async () => ({ ...facts, script: null, pty: false }) },
    );
    const pf = await pipes.facts();
    const tty = start(pipes, pf, "tty; cat; echo \"[$TERM][$GIT_TERMINAL_PROMPT][$DEBIAN_FRONTEND]\"");
    const exit = await tty.exit;
    expect(tty.run.interactive).toBe(false);
    expect(exit.ended).toBe("exit");
    expect(tty.text()).toContain("not a tty");
    expect(tty.text()).toContain("[dumb][0][noninteractive]");
    // A pipe run's prompt can't be answered: everything after it is withheld to the end.
    const pw = start(pipes, pf, 'printf "Password: "; sleep 0.2; echo after-the-prompt');
    await pw.exit;
    const kept = pw.kept.kept();
    expect(kept.secretSpans).toHaveLength(1);
    const text = new TextDecoder().decode(kept.bytes);
    expect(text.slice(kept.secretSpans[0].from, kept.secretSpans[0].to)).toContain("after-the-prompt");
    // The stop ladder on pipes: SIGINT to the group first.
    const long = start(pipes, pf, "sleep 1000 & echo PID=$!; wait");
    await waitFor("the background pid", () => /PID=\d+/.test(long.text()), 5000);
    const pid = Number(/PID=(\d+)/.exec(long.text())?.[1]);
    long.run.stop("task");
    expect((await long.exit).ended).toBe("stopped-task");
    await long.kept.stragglers;
    await waitFor("the background sleep to end", () => !alive(pid), 2000);
  });

  it("stops every run at once for the kill switch", async () => {
    const a = start(runner, facts, "sleep 1000");
    const b = start(runner, facts, "sleep 1000");
    await sleep(300);
    expect(runner.running).toBeGreaterThanOrEqual(2);
    const t0 = Date.now();
    await runner.stopAll("killswitch");
    expect(Date.now() - t0).toBeLessThan(300);
    await expect(a.exit).resolves.toMatchObject({ ended: "killswitch" });
    await expect(b.exit).resolves.toMatchObject({ ended: "killswitch" });
  });

  it("inspects real paths and reads git's push facts", async () => {
    const target = fs.mkdtempSync(path.join(tmp, "real-"));
    fs.symlinkSync(target, path.join(tmp, "link"));
    const [viaLink, missing] = await runner.inspect(["link/key", path.join(tmp, "nope", "x")], tmp);
    expect(viaLink).toEqual({ exists: false, real: path.join(fs.realpathSync(target), "key") });
    expect(missing).toEqual({ exists: false, real: path.join(fs.realpathSync(tmp), "nope", "x") });
    const repo = fs.mkdtempSync(path.join(tmp, "push-"));
    execFileSync("git", ["init", "-q", "-b", "feature-x"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=E", "-c", "user.email=e@example.com", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
    execFileSync("git", ["config", "push.default", "current"], { cwd: repo });
    await expect(runner.gitFacts(repo)).resolves.toEqual({ branch: "feature-x", pushDefault: "current", upstream: null });
    await expect(runner.gitFacts(tmp)).resolves.toBeNull();
  });
});

describe.runIf(required && platform === "darwin")("commands on macOS", () => {
  const extra = extraBinDirs(os.homedir()).filter(d => fs.existsSync(d));
  const runner = localRunner({ extraPath: extra });
  let facts: RunnerFacts;
  beforeAll(async () => {
    facts = await runner.facts();
  });

  it("offers zsh first and BSD script for a PTY", () => {
    expect(facts.shells[0]).toBe("zsh");
    expect(facts.script).toEqual({ path: "/usr/bin/script", kind: "bsd" });
  });

  it("returns the command's exit status through BSD script", async () => {
    await expect(start(runner, facts, "exit 3").exit).resolves.toMatchObject({ ended: "exit", code: 3 });
    const tty = start(runner, facts, "tty");
    expect((await tty.exit).code).toBe(0);
    expect(tty.text()).toMatch(/\/dev\/ttys\d+/);
  });

  it("stops what a run left in the background (the ps -E sweep)", async () => {
    const r = start(runner, facts, "sleep 1000 & echo PID=$!; wait");
    await waitFor("the background pid", () => /PID=\d+/.test(r.text()), 5000);
    const pid = Number(/PID=(\d+)/.exec(r.text())?.[1]);
    r.run.stop("user");
    expect((await r.exit).ended).toBe("stopped-user");
    await r.kept.stragglers;
    await waitFor("the background sleep to end", () => !alive(pid), 2000);
  });

  it("has Homebrew's folders on PATH", async () => {
    const r = start(runner, facts, 'printf "%s\\n" "$PATH"');
    await r.exit;
    for (const d of extra) expect(r.text()).toContain(d);
  });
});

describe.runIf(required && platform === "win32")("commands on Windows", () => {
  const runner = localRunner();
  let facts: RunnerFacts;
  beforeAll(async () => {
    expect(fs.existsSync(jobHostScript), "run `npm run build` first: the job host is dist/app/job-host.cjs").toBe(true);
    facts = await runner.facts();
  });

  it("offers Windows PowerShell only, on pipes", () => {
    expect(facts.shells).toEqual(["powershell"]);
    expect(facts.pty).toBe(false);
  });

  it("decodes PowerShell's output as UTF-8", async () => {
    const r = start(runner, facts, 'Write-Output "héllo ✓ 日本"');
    expect((await r.exit).code).toBe(0);
    expect(r.text()).toContain("héllo ✓ 日本");
  });

  it("reports exit codes, a native program's and a non-terminating cmdlet error's", async () => {
    await expect(start(runner, facts, "exit 3").exit).resolves.toMatchObject({ ended: "exit", code: 3 });
    await expect(start(runner, facts, "cmd /c exit 5").exit).resolves.toMatchObject({ ended: "exit", code: 5 });
    await expect(start(runner, facts, "Get-Item C:\\no\\such\\path-ember").exit).resolves.toMatchObject({ ended: "exit", code: 1 });
    await expect(start(runner, facts, "Write-Output ok").exit).resolves.toMatchObject({ ended: "exit", code: 0 });
  });

  it("puts the command text on no command line", async () => {
    const unique = `ember-unique-${randomBytes(4).toString("hex")}`;
    const r = start(runner, facts, `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${unique}*' }).Count`);
    expect((await r.exit).code).toBe(0);
    expect(r.text().trim()).toBe("0");
  });

  it("runs under Constrained Language Mode too", async () => {
    const clm = localRunner({ env: { ...process.env, __PSLockdownPolicy: "4" } });
    const r = start(clm, await clm.facts(), "$ExecutionContext.SessionState.LanguageMode");
    expect((await r.exit).code).toBe(0);
    console.log(`language mode with __PSLockdownPolicy=4: ${r.text().trim()}`);
    expect(r.text().trim()).toMatch(/Language$/);
  });

  it("ends a Start-Process child at once when the run stops (the job object)", async () => {
    const r = start(runner, facts, "$p = Start-Process -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1' -PassThru -WindowStyle Hidden; \"PID=$($p.Id)\"; Start-Sleep 300");
    await waitFor("the child's pid", () => /PID=\d+/.test(r.text()), 15_000);
    const pid = Number(/PID=(\d+)/.exec(r.text())?.[1]);
    expect(alive(pid)).toBe(true);
    r.run.stop("user");
    expect((await r.exit).ended).toBe("stopped-user");
    await waitFor("the Start-Process child to end", () => !alive(pid), 1500);
  });

  it("opens no console window", async () => {
    const r = start(runner, facts, "(Get-Process -Id $PID).MainWindowHandle");
    expect((await r.exit).code).toBe(0);
    expect(r.text().trim()).toBe("0");
  });

  it("knows it runs elevated from the token, as the platform reads it", async () => {
    expect(facts.privileged).toBe(loadWin32System()?.elevated() === true);
  });
});

describe.runIf(!required)("commands on this computer", () => {
  it.skip("run only with EMBER_COMMANDS_TEST=1", () => undefined);
});
