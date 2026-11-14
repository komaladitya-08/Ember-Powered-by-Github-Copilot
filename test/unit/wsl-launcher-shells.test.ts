/**
 * WSL's launcher in real POSIX shells (review x of e5cd0f4): the exact EMBER_INNER and environment launchArgv builds for
 * a WSL run, run here by bash, dash, zsh, mksh and busybox sh as wsl.exe would start them (pipes: `<shell> <no-rc> -c
 * WSL_EVAL`; PTY: util-linux `script -q -e -f -c WSL_EVAL /dev/null`), in a process group of their own as wsl.exe's
 * session is. What it checks: the launcher's end marker adds nothing a command could outlive the run with (`kill $$`),
 * Ctrl+C still reaches a program that handles it, `$$`, `exit`, `exec` and TERM mean what they did, and nothing is left
 * running after the run ends; and, as root, the WSL runner itself over a shell run as `nobody` under a root-owned parent
 * (WSL's init: a command can't kill it), in pipes mode. Each shell that isn't installed is skipped (Windows and macOS CI have none of these
 * paths), so it runs where the shells are: Linux CI and a developer's machine.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchArgv } from "../../app/main/commands/run/local";
import type { ExecResult, WslChild, WslExec } from "../../app/main/wsl/discover";
import { createWslRunner, FACTS_SCRIPT } from "../../app/main/wsl/runner";
import type { Logger } from "../../app/main/logger";
import { WSL_EVAL, NO_RC } from "../../app/main/commands/run/shells";
import type { RunnerFacts, RunSpec } from "../../app/main/commands/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-launcher-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** busybox runs as sh only by that name. */
function busyboxSh(): string | null {
  if (!fs.existsSync("/usr/bin/busybox")) return null;
  const link = path.join(tmp, "bb", "sh");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (!fs.existsSync(link)) fs.symlinkSync("/usr/bin/busybox", link);
  return link;
}

/** The shells, each as the facts would name it (bash and zsh by name, the rest as the distro's sh). */
const SHELLS: { name: string; shell: "bash" | "zsh" | "sh"; path: string | null }[] = [
  { name: "bash", shell: "bash", path: fs.existsSync("/usr/bin/bash") ? "/usr/bin/bash" : null },
  { name: "dash", shell: "sh", path: fs.existsSync("/usr/bin/dash") ? "/usr/bin/dash" : null },
  { name: "zsh", shell: "zsh", path: fs.existsSync("/usr/bin/zsh") ? "/usr/bin/zsh" : null },
  { name: "mksh", shell: "sh", path: fs.existsSync("/usr/bin/mksh") ? "/usr/bin/mksh" : null },
  { name: "busybox", shell: "sh", path: busyboxSh() },
];
const SCRIPT = fs.existsSync("/usr/bin/script") && /util-linux/.test(spawnSync("/usr/bin/script", ["--version"]).stdout?.toString() ?? "") ? "/usr/bin/script" : null;
const NODE = process.execPath;
const SAFE = /^\/[A-Za-z0-9/._-]*$/;

const NONCE = "00112233aabbccdd";
const JOB = { execPath: "C:\\Program Files\\Ember\\Ember.exe", script: "C:\\Program Files\\Ember\\resources\\app\\dist\\app\\job-host.cjs" };
let n = 0;

function facts(shell: "bash" | "zsh" | "sh", p: string, pty: boolean): RunnerFacts {
  return {
    os: "linux", shells: [shell], shellPaths: { [shell]: p }, script: pty ? { path: SCRIPT!, kind: "util-linux" } : null, home: tmp, user: "ana",
    privileged: false, pty, ember: { paths: [], pids: [], names: /^ember$/ }, extraPath: [], wsl: { mountRoot: "/mnt/", interop: false, windows: null },
  } as RunnerFacts;
}

function spec(command: string, shell: "bash" | "zsh" | "sh"): RunSpec {
  return {
    runId: (++n).toString(16).padStart(16, "0"), taskId: "t", shell, command, cwd: tmp, timeoutMs: 60_000, cols: 80, rows: 24,
    stamp: { taskId: "t", sha256: "0".repeat(64), verdict: "run", classes: [], rules: [], approval: null },
  };
}

interface Ran { code: number | null; signal: string | null; ms: number; out: string; left: string }

/**
 * Runs `command` through WSL's launcher in `sh` as wsl.exe would start it, in its own process group; `act` may signal
 * the group or type into the PTY. Waits for the run to end, then `settleMs` more, and says what of the group is left.
 */
async function launch(sh: { shell: "bash" | "zsh" | "sh"; path: string }, command: string, o: { pty?: boolean; act?: (c: ReturnType<typeof spawn>) => void; actAt?: number; settleMs?: number } = {}): Promise<Ran> {
  const pty = o.pty === true;
  const got = launchArgv(spec(command, sh.shell), facts(sh.shell, sh.path, pty), { jobHost: JOB, wsl: { exe: "C:\\Windows\\System32\\wsl.exe", distro: "Ubuntu", end: NONCE } });
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp };
  for (const k of got.env.WSLENV.split(":").map(e => e.split("/")[0])) if (got.env[k] !== undefined) env[k] = got.env[k];
  const [cmd, args] = pty ? [SCRIPT!, ["-q", "-e", "-f", "-c", WSL_EVAL, "/dev/null"]] : [sh.path, [...NO_RC[sh.shell], "-c", WSL_EVAL]];
  if (pty) env.SHELL = "/bin/sh";
  const t0 = Date.now();
  const c = spawn(cmd, args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  c.stdout!.on("data", (b: Buffer) => { out += b.toString("latin1"); });
  c.stderr!.on("data", (b: Buffer) => { out += b.toString("latin1"); });
  if (o.act) setTimeout(() => o.act!(c), o.actAt ?? 400);
  const end = await new Promise<{ code: number | null; signal: string | null }>(resolve => c.on("close", (code, signal) => resolve({ code, signal })));
  const ms = Date.now() - t0;
  await new Promise(r => setTimeout(r, o.settleMs ?? 300));
  // Zombies are dead already (a container's init may never reap them): only a live process is left running.
  const left = (spawnSync("pgrep", ["-g", String(c.pid), "-a"]).stdout?.toString() ?? "").split("\n").filter(l => l.trim() && !/<defunct>/.test(l)).join("\n");
  try {
    process.kill(-c.pid!, "SIGKILL");
  } catch {
    // the group is gone, as it should be
  }
  return { ...end, ms, out: out.replace(/\x1b\]777;ember-start\x07/g, ""), left }; // eslint-disable-line no-control-regex -- the start marker
}

/** The end marker's exit code, or null when there is none. */
const endCode = (out: string): number | null => {
  const m = new RegExp(`\x1b\\]777;ember-end;${NONCE};(\\d+)\x07`).exec(out);
  return m ? Number(m[1]) : null;
};

const CATCHER = `${NODE} -e "process.on('SIGINT',()=>console.log('caught'));setTimeout(()=>console.log('done'),1200)"`;

for (const sh of SHELLS) {
  const live = sh.path !== null && SAFE.test(sh.path) && SAFE.test(NODE);
  describe.skipIf(!live)(`WSL's launcher in ${sh.name}`, () => {
    const s = { shell: sh.shell, path: sh.path ?? "" };

    it("lets nothing of a command go on after `kill $$` has ended its run (review wslio-x-1)", async () => {
      const flag = path.join(tmp, `after-${sh.name}`);
      const r = await launch(s, `echo before; kill $$; sleep 1; echo after; touch ${flag}`, { settleMs: 1500 });
      expect(r.out).toContain("before");
      expect(r.out).not.toContain("after");
      // Nor a shell's report of it: the one shell before died without one.
      expect(r.out).not.toMatch(/Terminated|Killed/);
      expect(fs.existsSync(flag)).toBe(false);
      expect(r.left).toBe("");
    }, 20_000);

    it("lets Ctrl+C reach a program that handles it, and ends the run when the program does (review wslio-x-2)", async () => {
      // Pipes: the INT a Ctrl+C sends to the foreground group (the runner's INT sweep reaches the same processes).
      const r = await launch(s, CATCHER, { act: c => process.kill(-c.pid!, "SIGINT") });
      expect(r.out).toMatch(/caught[\s\S]*done/);
      expect(r.ms).toBeGreaterThan(1100);
      expect(endCode(r.out)).not.toBeNull();
      expect(r.out.indexOf("done")).toBeLessThan(r.out.search(/\x1b\]777;ember-end/)); // eslint-disable-line no-control-regex -- the end marker
      expect(r.left).toBe("");
    }, 20_000);

    it.skipIf(!SCRIPT)("lets Ctrl+C typed into the PTY reach a program that handles it (review wslio-x-2)", async () => {
      const r = await launch(s, CATCHER, { pty: true, act: c => c.stdin!.write("\x03") });
      expect(r.out).toMatch(/caught[\s\S]*done/);
      expect(r.ms).toBeGreaterThan(1100);
      expect(r.left).toBe("");
    }, 20_000);

    it("keeps $$, exit, exec and the exit code as the command's own, with the end marker last", async () => {
      const pid = await launch(s, 'echo "pid=$$"; sh -c \'echo "ppid=$PPID"\'');
      const ids = /pid=(\d+)[\s\S]*ppid=(\d+)/.exec(pid.out);
      // $$ is the shell the command's own programs are started by (a subshell's $$ would name its parent instead).
      expect(ids?.[1]).toBe(ids?.[2]);
      const ex = await launch(s, "echo x; exit 7; echo never");
      expect([ex.code, endCode(ex.out), ex.out.includes("never")]).toEqual([7, 7, false]);
      const exe = await launch(s, "exec >/dev/null; echo gone");
      expect([exe.code, endCode(exe.out), exe.out.includes("gone")]).toEqual([0, 0, false]);
      const sig = await launch(s, "kill -9 $$");
      expect([sig.code, endCode(sig.out), /Killed/.test(sig.out)]).toEqual([137, 137, false]);
    }, 20_000);

    it("hands the command neither its text's variables nor the end marker's nonce (review wslio-x-4)", async () => {
      const r = await launch(s, 'echo "[${EMBER_END-}][${n-}][${EMBER_C-}][${EMBER_CMD_B64-}]"; env | sed -n "s/^\\(EMBER_[A-Z_]*\\)=.*/\\1/p" | sort | tr "\\n" " "');
      expect(r.out).toContain("[][][][]");
      // What the command saw before the end marker came, the sweeps' EMBER_RUN_ID among them; never EMBER_END or EMBER_C.
      expect(r.out).toContain("EMBER_CWD EMBER_INNER EMBER_RUN_ID ");
      expect(endCode(r.out)).toBe(0);
    }, 20_000);

    it("ends at TERM to the group, the Stop ladder's second step, leaving nothing running", async () => {
      const r = await launch(s, "echo ready; sleep 30", { act: c => process.kill(-c.pid!, "SIGTERM") });
      expect(r.ms).toBeLessThan(5000);
      expect(r.left).toBe("");
    }, 20_000);
  });
}

/**
 * WSL's per-session init, as far as a command can tell: a root-owned parent that ignores TERM, INT and HUP and runs the
 * shell as `nobody`, so a command's `kill $PPID` reaches only what Ember started.
 */
const RELAY = `for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {});
const c = require("node:child_process").spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit", uid: 65534, gid: 65534 });
c.on("exit", (code, sig) => process.exit(code ?? 128 + (require("node:os").constants.signals[sig] || 0)));`;
const ROOT = typeof process.getuid === "function" && process.getuid() === 0 && spawnSync("id", ["nobody"]).status === 0;
/** A folder nobody can work in (the test's own may sit under a private TMPDIR). */
let shared = "";
function sharedDir(): string {
  if (!shared) {
    shared = fs.mkdtempSync("/tmp/ember-wsl-nobody-");
    fs.chmodSync(shared, 0o777);
  }
  return shared;
}
afterAll(() => { if (shared) fs.rmSync(shared, { recursive: true, force: true }); });
const quiet: Logger = { file: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet } as unknown as Logger;

/**
 * The WSL runner over this machine: its runs are `sh` as nobody under RELAY; its fixed scripts (sweeps) run here. A
 * distro's `sh` is named sh (the facts know a shell by its name), so dash, mksh and busybox run by a link of that name
 * in a folder nobody can read.
 */
function localRunner(named: { name: string; shell: "bash" | "zsh" | "sh"; path: string }) {
  let shPath = named.path;
  if (named.shell === "sh") {
    const dir = path.join(sharedDir(), named.name);
    fs.mkdirSync(dir, { recursive: true });
    shPath = path.join(dir, "sh");
    if (!fs.existsSync(shPath)) fs.symlinkSync(fs.realpathSync(named.path), shPath);
  }
  const sh = { shell: named.shell, path: shPath };
  const exec: WslExec = {
    run: async (args, o) => {
      const stdin = o.stdin ?? "";
      const end = /ember-end;([0-9a-f]{16});%s/.exec(stdin)?.[1] ?? "";
      if (stdin.includes(FACTS_SCRIPT.split("\n")[0])) {
        // Facts without util-linux script: the pipes launch, the one a distro like Alpine gets.
        const out = `uid=65534\nuser=nobody\nhome=${sharedDir()}\nshell=${sh.path}\nbase64=1\n\x1b]777;ember-end;${end};0\x07`;
        return { code: 0, stdout: Buffer.from(out, "latin1"), stderr: Buffer.alloc(0), timedOut: false, error: null } satisfies ExecResult;
      }
      const dash = args.indexOf("--");
      const r = spawnSync("/bin/sh", ["-s", ...(dash >= 0 ? args.slice(dash) : [])], { input: stdin, timeout: o.timeoutMs });
      return { code: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0), timedOut: false, error: null } satisfies ExecResult;
    },
  };
  return createWslRunner({
    log: quiet, distro: "Ubuntu", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, jobHost: JOB, exec, exe: () => "C:\\Windows\\System32\\wsl.exe",
    listed: async () => ({ name: "Ubuntu", version: 2, isDefault: true, defaultUid: null, running: true, needsSetup: false }),
    isRunning: () => true, runningNow: async () => new Set(["Ubuntu"]), windows: () => ({ home: "C:\\Users\\a", localAppData: "", appData: "", temp: "", systemRoot: "C:\\Windows", emberPaths: [] }),
    winPaths: [], learnedUid: () => undefined,
    spawn: (_command, _args, options) => {
      // What wsl.exe would hand the distro: the variables WSLENV lists, and the shell on WSL_EVAL.
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sharedDir() };
      for (const k of (options.env.WSLENV ?? "").split(":").map(e => e.split("/")[0])) if (k && options.env[k] !== undefined) env[k] = options.env[k];
      return spawn(process.execPath, ["-e", RELAY, sh.path, ...NO_RC[sh.shell], "-c", WSL_EVAL], { env, stdio: ["pipe", "pipe", "pipe"] }) as unknown as WslChild;
    },
  });
}

for (const sh of SHELLS) {
  const live = ROOT && sh.path !== null && SAFE.test(sh.path);
  describe.skipIf(!live)(`the WSL runner over ${sh.name} as nobody, in pipes mode`, () => {
    const s = { name: sh.name, shell: sh.shell, path: sh.path ?? "" };

    it("ends what a command left running after `kill -9 $PPID` ended its launcher, before the run is reported (review wslio-y-1)", async () => {
      const flag = path.join(sharedDir(), `ppid-${sh.name}`);
      const runner = localRunner(s);
      const cmd = runner.start({ ...spec(`echo a; kill -9 $PPID; sleep 1.5; echo b; touch ${flag}`, sh.shell), cwd: sharedDir() });
      let out = "";
      cmd.onOutput(c => { out += Buffer.from(c).toString("latin1"); });
      const exit = await cmd.done;
      expect(exit).toMatchObject({ ended: "exit", outputCut: true, endLost: true });
      // Nothing of it is left when the run is reported, and nothing of it runs afterwards.
      await expect(cmd.stragglers).resolves.toEqual([]);
      await new Promise(r => setTimeout(r, 2000));
      expect(out).toContain("a");
      expect(out).not.toMatch(/\bb\b/);
      expect(fs.existsSync(flag)).toBe(false);
    }, 20_000);

    it("reports a run that ends with its marker as it ended, nothing swept", async () => {
      const runner = localRunner(s);
      const cmd = runner.start({ ...spec("echo ok; exit 4", sh.shell), cwd: sharedDir() });
      const exit = await cmd.done;
      expect(exit).toMatchObject({ ended: "exit", code: 4 });
      expect(exit.outputCut).toBeUndefined();
    }, 20_000);
  });
}
