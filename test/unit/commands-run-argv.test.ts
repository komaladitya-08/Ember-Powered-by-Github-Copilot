import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { SpawnOptions } from "node:child_process";
import type { RunnerFacts, RunSpec } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";
import type { Timers } from "../../app/main/commands/run/kill";
import { BSD_SCRIPT_LAUNCH, NO_RC, PS_INNER, WSL_CD, WSL_EVAL, posixBody, posixInner } from "../../app/main/commands/run/shells";
import {
  createRunner, DEFAULT_TIMEOUT_MS, isKeptRun, KEEP_BYTES, KEEP_HEAD_BYTES, launchArgv, LaunchError, START_MARKER,
  type ChildLike, type KeptRun, type RunnerDeps, type RunnerOptions,
} from "../../app/main/commands/run/local";

// ─────────────── Fixtures and fakes (no process is ever started) ───────────────

const RUN_ID = "0123456789abcdef";
const JOB_HOST = { execPath: "C:\\Program Files\\Ember\\Ember.exe", script: "C:\\Program Files\\Ember\\resources\\app\\dist\\app\\job-host.cjs" };
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ember = { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ };

const linux: RunnerFacts = {
  os: "linux", shells: ["bash", "sh", "zsh"], shellPaths: { bash: "/usr/bin/bash", sh: "/usr/bin/sh", zsh: "/usr/bin/zsh" },
  script: { path: "/usr/bin/script", kind: "util-linux" }, home: "/home/ana", user: "ana", privileged: false, pty: true, ember, extraPath: [],
};
const linuxPipes: RunnerFacts = { ...linux, script: null, pty: false };
const mac: RunnerFacts = {
  ...linux, os: "darwin", shells: ["zsh", "bash", "sh"], shellPaths: { zsh: "/bin/zsh", bash: "/bin/bash", sh: "/bin/sh" },
  script: { path: "/usr/bin/script", kind: "bsd" }, home: "/Users/ana",
};
const windows: RunnerFacts = {
  ...linux, os: "win32", shells: ["powershell"], shellPaths: { powershell: PS }, script: null, pty: false, home: "C:\\Users\\ana",
};

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: RUN_ID, taskId: "1-abcdef12", shell: "bash", command: "rm -r build && echo ünïcødé 'quoted' \"double\"",
    cwd: "/home/ana/src", timeoutMs: 120_000, cols: 100, rows: 30,
    stamp: { taskId: "1-abcdef12", sha256: "a".repeat(64), verdict: "run", classes: [], rules: [], approval: null },
    ...over,
  };
}

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet, file: "" };

class FakeTimers implements Timers {
  now = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private next = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.next;
    this.queue.push({ at: this.now + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter(t => t.id !== handle);
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = this.queue[0];
      if (!t || t.at > end) break;
      this.queue.shift();
      this.now = t.at;
      t.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

interface FakeChild extends ChildLike {
  written: (string | Buffer)[];
  stdinEnded: boolean;
  killed: (NodeJS.Signals | undefined)[];
  out(text: string | Buffer): void;
  err(text: string): void;
  end(code: number | null, signal?: NodeJS.Signals | null): void;
}

/** A started child (pid null: one whose start failed, which has no pid). */
function fakeChild(pid: number | null = 4242): FakeChild {
  const events = new EventEmitter();
  const stdout = new FakeStream(), stderr = new FakeStream();
  const child: FakeChild = {
    pid: pid ?? undefined,
    written: [],
    stdinEnded: false,
    killed: [],
    stdin: {
      write: (chunk: Uint8Array | string) => {
        child.written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk));
        return true;
      },
      end: () => {
        child.stdinEnded = true;
      },
      on: () => child.stdin,
    },
    stdout,
    stderr,
    on: (event: string, fn: (...args: never[]) => void) => events.on(event, fn as (...args: unknown[]) => void),
    kill: (signal?: NodeJS.Signals) => {
      child.killed.push(signal);
      return true;
    },
    out: text => stdout.emit("data", Buffer.isBuffer(text) ? text : Buffer.from(text)),
    err: text => stderr.emit("data", Buffer.from(text)),
    end: (code, signal = null) => {
      events.emit("exit", code, signal);
      stdout.emit("close");
      stderr.emit("close");
    },
  } as FakeChild;
  (child as unknown as { emit: EventEmitter["emit"] }).emit = events.emit.bind(events);
  return child;
}

interface Harness {
  deps: RunnerDeps;
  timers: FakeTimers;
  spawned: { command: string; args: string[]; options: SpawnOptions }[];
  children: FakeChild[];
  kills: [number, NodeJS.Signals][];
  execs: [string, string[]][];
  sweeps: [string, NodeJS.Signals | null][];
  logs: [string, Record<string, unknown> | undefined][];
}

function harness(facts: RunnerFacts, over: Partial<RunnerDeps> = {}): Harness & { runner: ReturnType<typeof createRunner>; options: RunnerOptions } {
  const timers = new FakeTimers();
  const h: Harness = {
    timers, spawned: [], children: [], kills: [], execs: [], sweeps: [], logs: [],
    deps: {
      spawn: (command, args, options) => {
        h.spawned.push({ command, args, options });
        const c = fakeChild();
        h.children.push(c);
        return c;
      },
      timers,
      now: () => timers.now,
      kill: (pid, signal) => {
        h.kills.push([pid, signal]);
      },
      exec: async (file, args) => {
        h.execs.push([file, args]);
        return { code: 0, stdout: file === "pgrep" ? "4243\n" : "" };
      },
      sweep: async (runId, signal) => {
        h.sweeps.push([runId, signal]);
        return [];
      },
      facts: async () => facts,
      inspect: async paths => paths.map(() => ({ exists: null, real: null })),
      readScript: async () => null,
      gitFacts: async () => null,
      isDir: async () => true,
      tracker: () => ({ output() {}, enter() {}, spans: () => [] }),
      ...over,
    },
  };
  const log: Logger = { ...quiet, info: (msg, f) => h.logs.push([msg, f]), warn: (msg, f) => h.logs.push([msg, f]) };
  const options: RunnerOptions = {
    log, os: facts.os, env: { PATH: "/usr/bin:/bin", HOME: "/home/ana", GH_TOKEN: "gho_secret", NODE_OPTIONS: "--inspect" },
    ember: { paths: ["/home/ana/.config/ember"], pids: () => [10, 11], names: /^ember$/ },
    home: facts.home, user: "ana", elevated: () => false, extraPath: [], jobHost: facts.os === "win32" ? JOB_HOST : null,
  };
  return { ...h, options, runner: createRunner(options, h.deps) };
}

/** Starts a run once the runner's facts are cached (as the flow does: facts first, then start). */
async function started(h: ReturnType<typeof harness>, s: RunSpec = spec()): Promise<{ run: KeptRun; child: FakeChild }> {
  await h.runner.facts();
  const run = h.runner.start(s);
  if (!isKeptRun(run)) throw new Error("not a kept run");
  return { run, child: h.children[h.children.length - 1] };
}

// ─────────────── launchArgv: §3.3's table, exactly ───────────────

describe("launchArgv", () => {
  it("runs Linux commands through util-linux script with the text only in EMBER_CMD", () => {
    const s = spec();
    expect(launchArgv(s, linux, { jobHost: null })).toEqual({
      command: "/usr/bin/script",
      args: ["-q", "-e", "-f", "-c", posixInner("bash", "/usr/bin/bash", "env"), "/dev/null"],
      options: { detached: true, stdio: ["pipe", "pipe", "pipe"] },
      env: { SHELL: "/bin/sh", TERM: "xterm-256color", EMBER_CMD: s.command, EMBER_COLS: "100", EMBER_ROWS: "30", EMBER_RUN_ID: RUN_ID, PWD: "/home/ana/src" },
    });
    expect(launchArgv(spec({ shell: "zsh" }), linux, { jobHost: null }).args[4]).toBe(posixInner("zsh", "/usr/bin/zsh", "env"));
    expect(launchArgv(spec({ shell: "sh" }), linux, { jobHost: null }).args[4]).toBe(posixInner("sh", "/usr/bin/sh", "env"));
  });

  it("runs macOS commands through BSD script started by bash, whose stdin is a real pipe", () => {
    const s = spec({ shell: "zsh" });
    const got = launchArgv(s, mac, { jobHost: null });
    expect(got.command).toBe("/bin/bash");
    expect(got.args).toEqual([...NO_RC.bash, "-c", BSD_SCRIPT_LAUNCH]);
    expect(got.options).toEqual({ detached: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(got.env).toMatchObject({
      SHELL: "/bin/sh", TERM: "xterm-256color", EMBER_CMD: s.command, EMBER_RUN_ID: RUN_ID, PWD: "/home/ana/src",
      EMBER_SCRIPT: "/usr/bin/script", EMBER_INNER: posixInner("zsh", "/bin/zsh", "env"),
    });
  });

  it("starts BSD script with zsh when there is no bash, and fails to start with neither", () => {
    const noBash: RunnerFacts = { ...mac, shells: ["zsh", "sh"], shellPaths: { zsh: "/bin/zsh", sh: "/bin/sh" } };
    expect(launchArgv(spec({ shell: "zsh" }), noBash, { jobHost: null })).toMatchObject({ command: "/bin/zsh", args: [...NO_RC.zsh, "-c", BSD_SCRIPT_LAUNCH] });
    const shOnly: RunnerFacts = { ...mac, shells: ["sh"], shellPaths: { sh: "/bin/sh" } };
    expect(() => launchArgv(spec({ shell: "sh" }), shOnly, { jobHost: null })).toThrow(/needs bash or zsh/);
  });

  it("keeps the command and the run's marker away from the BSD launcher's cat", () => {
    expect(BSD_SCRIPT_LAUNCH).toContain('exec "$s" -q /dev/null /bin/sh -c "$i" < <(');
    expect(BSD_SCRIPT_LAUNCH.endsWith("< <(unset EMBER_RUN_ID EMBER_CMD; exec /bin/cat)")).toBe(true);
  });

  it("runs on pipes with stdin closed and TERM=dumb without script", () => {
    const s = spec();
    expect(launchArgv(s, linuxPipes, { jobHost: null })).toEqual({
      command: "/usr/bin/bash",
      args: [...NO_RC.bash, "-c", posixBody({ pty: false, from: "env" })],
      options: { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      env: { TERM: "dumb", EMBER_CMD: s.command, EMBER_RUN_ID: RUN_ID, PWD: "/home/ana/src" },
    });
    expect(launchArgv(spec({ shell: "zsh" }), linuxPipes, { jobHost: null }).args).toEqual(["-f", "-c", posixBody({ pty: false, from: "env" })]);
    expect(launchArgv(spec({ shell: "sh" }), linuxPipes, { jobHost: null }).args).toEqual(["-c", posixBody({ pty: false, from: "env" })]);
  });

  it("runs Windows commands in PowerShell 5.1 inside the job host, hidden, never detached", () => {
    const s = spec({ shell: "powershell", cwd: "C:\\Users\\ana\\src" });
    expect(launchArgv(s, windows, { jobHost: JOB_HOST })).toEqual({
      command: JOB_HOST.execPath,
      args: [JOB_HOST.script, "--batch", "--", PS, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_INNER],
      options: { detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      env: { ELECTRON_RUN_AS_NODE: "1", EMBER_CMD: s.command, EMBER_RUN_ID: RUN_ID },
    });
  });

  it("runs WSL commands with script through the job host, the text as base64 and WSLENV replaced", () => {
    const s = spec({ cwd: "/home/ana/src" });
    const got = launchArgv(s, linux, { jobHost: JOB_HOST, wsl: { exe: "C:\\Windows\\System32\\wsl.exe", distro: "Ubuntu-22.04" } });
    expect(got.command).toBe(JOB_HOST.execPath);
    expect(got.args).toEqual([
      JOB_HOST.script, "--interactive", "--", "C:\\Windows\\System32\\wsl.exe",
      "-d", "Ubuntu-22.04", "--cd", "/", "--exec", "/usr/bin/env", "SHELL=/bin/sh", "/usr/bin/script", "-q", "-e", "-f", "-c", WSL_EVAL, "/dev/null",
    ]);
    expect(got.options).toEqual({ detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(got.env).toEqual({
      ELECTRON_RUN_AS_NODE: "1", WSL_UTF8: "1", EMBER_INNER: `${WSL_CD}; ${posixInner("bash", "/usr/bin/bash", "b64")}`,
      EMBER_CMD_B64: Buffer.from(s.command, "utf8").toString("base64"), EMBER_RUN_ID: RUN_ID, EMBER_CWD: "/home/ana/src", EMBER_COLS: "100", EMBER_ROWS: "30",
      TERM: "xterm-256color", PWD: "/home/ana/src", WSLENV: "EMBER_INNER/u:EMBER_CMD_B64/u:EMBER_RUN_ID/u:EMBER_CWD/u:EMBER_COLS/u:EMBER_ROWS/u:TERM/u:PWD/u",
    });
    expect(Buffer.from(got.env.EMBER_CMD_B64, "base64").toString("utf8")).toBe(s.command);
  });

  it("runs WSL commands without script in batch mode on WSL_EVAL", () => {
    const got = launchArgv(spec(), linuxPipes, { jobHost: JOB_HOST, wsl: { exe: "C:\\Windows\\System32\\wsl.exe", distro: "Debian" } });
    expect(got.args).toEqual([JOB_HOST.script, "--batch", "--", "C:\\Windows\\System32\\wsl.exe", "-d", "Debian", "--cd", "/", "--exec", "/usr/bin/bash", "--noprofile", "--norc", "-c", WSL_EVAL]);
    // wsl.exe starts the shell in /; the shell goes to the run's folder itself, failing when it isn't there (CI).
    expect(got.env.EMBER_INNER).toBe(`${WSL_CD}; ${posixBody({ pty: false, from: "b64" })}`);
    expect(got.env.EMBER_CWD).toBe("/home/ana/src");
    expect(got.env.TERM).toBe("dumb");
    // Nobody can type into a pipe run: the non-interactive defaults (fixed values) cross into the distro (RUN's gap).
    expect(got.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never" });
    expect(got.env.WSLENV).toBe("EMBER_INNER/u:EMBER_CMD_B64/u:EMBER_RUN_ID/u:EMBER_CWD/u:EMBER_COLS/u:EMBER_ROWS/u:TERM/u:PWD/u:GIT_TERMINAL_PROMPT/u:DEBIAN_FRONTEND/u:SSH_ASKPASS_REQUIRE/u");
    // The shell inside starts with the run's folder as Ember named it, links included (§3.6, L25).
    expect(got.env.PWD).toBe("/home/ana/src");
  });

  it("never puts the command text on the argv, whatever the target", () => {
    const texts = ["rm -rf build/ && echo zq9-done", "echo 'a b' \"c\" $HOME `id` zq9-ünïcødé", "Remove-Item -Recurse C:\\x; Write-Output zq9-ok", "cat <<EOF\nzq9-line\nEOF"];
    for (const command of texts) {
      const launches = [
        launchArgv(spec({ command }), linux, { jobHost: null }),
        launchArgv(spec({ command, shell: "zsh" }), mac, { jobHost: null }),
        launchArgv(spec({ command }), linuxPipes, { jobHost: null }),
        launchArgv(spec({ command, shell: "powershell", cwd: "C:\\x" }), windows, { jobHost: JOB_HOST }),
        launchArgv(spec({ command }), linux, { jobHost: JOB_HOST, wsl: { exe: "C:\\Windows\\System32\\wsl.exe", distro: "Ubuntu" } }),
      ];
      for (const l of launches) {
        const argv = [l.command, ...l.args].join("\n");
        expect(argv).not.toContain(command);
        expect(argv).not.toContain("zq9");
      }
    }
  });

  it("refuses a run it can't launch exactly as decided, in plain words", () => {
    const refuse = (f: () => unknown, words: RegExp) => {
      expect(f).toThrow(LaunchError);
      expect(f).toThrow(words);
    };
    // The shell's path is written into the launcher's text: only [A-Za-z0-9/._-] (S0a review).
    refuse(() => launchArgv(spec(), { ...linux, shellPaths: { ...linux.shellPaths, bash: "/opt/my tools/bash" } }, { jobHost: null }), /path/);
    refuse(() => launchArgv(spec(), { ...linux, shellPaths: { ...linux.shellPaths, bash: "/usr/bin/ba'sh" } }, { jobHost: null }), /path/);
    refuse(() => launchArgv(spec(), { ...linux, shellPaths: { ...linux.shellPaths, bash: "bin/bash" } }, { jobHost: null }), /path/);
    refuse(() => launchArgv(spec(), { ...linuxPipes, shellPaths: { ...linux.shellPaths, bash: "/usr/bin/$(id)" } }, { jobHost: null }), /path/);
    refuse(() => launchArgv(spec(), { ...linux, script: { path: "/usr/bin/scr ipt", kind: "util-linux" } }, { jobHost: null }), /script/);
    refuse(() => launchArgv(spec({ shell: "zsh" }), { ...linux, shells: ["bash", "sh"] }, { jobHost: null }), /zsh isn't available/);
    refuse(() => launchArgv(spec({ shell: "powershell" }), linux, { jobHost: null }), /powershell/);
    refuse(() => launchArgv(spec({ shell: "cmd" }), windows, { jobHost: JOB_HOST }), /PowerShell only/);
    refuse(() => launchArgv(spec({ shell: "bash" }), windows, { jobHost: JOB_HOST }), /PowerShell only/);
    refuse(() => launchArgv(spec({ shell: "powershell" }), windows, { jobHost: null }), /job host/);
    refuse(() => launchArgv(spec({ shell: "powershell" }), { ...windows, shellPaths: { powershell: "powershell.exe" } }, { jobHost: JOB_HOST }), /PowerShell/);
    refuse(() => launchArgv(spec({ command: "echo a\0b" }), linux, { jobHost: null }), /NUL/);
    // An unpaired surrogate would reach the shell as U+FFFD: not the text that was shown.
    for (const command of ["echo \uD800", "echo \uDC00x", "rm \uDBFF"]) refuse(() => launchArgv(spec({ command }), linux, { jobHost: null }), /exactly as shown/);
    refuse(() => launchArgv(spec({ cwd: "/home/ana/\uD800" }), linux, { jobHost: null }), /exactly as shown/);
    expect(launchArgv(spec({ command: "echo \u{1F600} \uD83D\uDE00" }), linux, { jobHost: null }).env.EMBER_CMD).toBe("echo \u{1F600} \u{1F600}");
    refuse(() => launchArgv(spec({ runId: "../../etc" }), linux, { jobHost: null }), /id/);
    const wsl = { exe: "C:\\Windows\\System32\\wsl.exe", distro: "Ubuntu" };
    for (const cwd of ['/home/ana/"x"', "/home/ana/a\\b", "/home/ana/a\nb", "/home/ana/\x1b[2J", "relative/dir"]) {
      refuse(() => launchArgv(spec({ cwd }), linux, { jobHost: JOB_HOST, wsl }), /can't pass that folder to WSL/);
    }
    refuse(() => launchArgv(spec(), linux, { jobHost: null, wsl }), /job host/);
    refuse(() => launchArgv(spec(), linux, { jobHost: JOB_HOST, wsl: { ...wsl, distro: "Ubuntu --exec x" } }), /name/);
  });

  it("keeps the PTY's size within reason", () => {
    expect(launchArgv(spec({ cols: 0, rows: Number.NaN }), linux, { jobHost: null }).env).toMatchObject({ EMBER_COLS: "80", EMBER_ROWS: "24" });
    expect(launchArgv(spec({ cols: 5000.7, rows: 40.9 }), linux, { jobHost: null }).env).toMatchObject({ EMBER_COLS: "1000", EMBER_ROWS: "40" });
  });
});

// ─────────────── The runner's spawn and its runs (fake spawn and timers) ───────────────

describe("the local runner's spawn", () => {
  it("spawns exactly launchArgv's argv and options in the run's folder, with commandEnv's environment", async () => {
    const h = harness(linux);
    await started(h);
    const want = launchArgv(spec(), linux, { jobHost: null });
    expect(h.spawned).toHaveLength(1);
    const got = h.spawned[0];
    expect(got.command).toBe(want.command);
    expect(got.args).toEqual(want.args);
    expect(got.options).toMatchObject({ ...want.options, cwd: "/home/ana/src" });
    const env = got.options.env as Record<string, string>;
    expect(env).toMatchObject({ EMBER_CMD: spec().command, EMBER_RUN_ID: RUN_ID, SHELL: "/bin/sh", TERM: "xterm-256color", HOME: "/home/ana" });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    // A PTY run can be answered: no non-interactive defaults.
    expect(env.GIT_TERMINAL_PROMPT).toBeUndefined();
  });

  it("names the run's folder in PWD on POSIX, over an inherited one, so the shell's `cd ..` starts where Ember judged", async () => {
    const h = harness(linux);
    const runner = createRunner({ ...h.options, env: { PATH: "/usr/bin", PWD: "/somewhere/else" } }, h.deps);
    await runner.facts();
    runner.start(spec({ cwd: "/home/ana/link" }));
    expect((h.spawned[0].options.env as Record<string, string>).PWD).toBe("/home/ana/link");
    const win = harness(windows);
    const wr = createRunner({ ...win.options, env: { Path: "C:\\Windows", PWD: "C:\\x" } }, win.deps);
    await wr.facts();
    wr.start(spec({ shell: "powershell", cwd: "C:\\Users\\ana" }));
    expect((win.spawned[0].options.env as Record<string, string>).PWD).toBe("C:\\x");
  });

  it("gives pipe runs and Windows runs the non-interactive defaults, Windows names compared without case", async () => {
    const pipes = harness(linuxPipes);
    await started(pipes);
    expect(pipes.spawned[0].options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never", TERM: "dumb" });
    expect(pipes.spawned[0].options.stdio).toEqual(["ignore", "pipe", "pipe"]);

    const win = harness(windows);
    win.options.env = { Path: "C:\\Windows\\System32", Gh_Token: "x", Electron_Run_As_Node: "0", SystemRoot: "C:\\Windows" };
    const runner = createRunner({ ...win.options, extraPath: ["C:\\Tools"] }, win.deps);
    await runner.facts();
    runner.start(spec({ shell: "powershell", cwd: "C:\\Users\\ana" }));
    const env = win.spawned[0].options.env as Record<string, string>;
    expect(env.Path).toBe("C:\\Windows\\System32;C:\\Tools");
    expect(Object.keys(env).filter(k => k.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(Object.keys(env).filter(k => k.toUpperCase() === "GH_TOKEN")).toEqual([]);
    // The user's own spelling is gone with its value; only the job host's switch is left.
    expect(Object.entries(env).filter(([k]) => k.toUpperCase() === "ELECTRON_RUN_AS_NODE")).toEqual([["ELECTRON_RUN_AS_NODE", "1"]]);
    expect(env).toMatchObject({ EMBER_CMD: spec().command, GIT_TERMINAL_PROMPT: "0" });
    expect(win.spawned[0].options).toMatchObject({ detached: false, windowsHide: true, cwd: "C:\\Users\\ana" });
  });

  it("removes SSH's session variables only for a remote's runs", async () => {
    const env = { PATH: "/usr/bin", SSH_CONNECTION: "1 2 3 4", SSH_AUTH_SOCK: "/tmp/agent" };
    const local = harness(linux);
    const runner = createRunner({ ...local.options, env }, local.deps);
    await runner.facts();
    runner.start(spec());
    expect(local.spawned[0].options.env).toMatchObject({ SSH_CONNECTION: "1 2 3 4", SSH_AUTH_SOCK: "/tmp/agent" });
    const remote = harness(linux);
    const agent = createRunner({ ...remote.options, env, remote: true, target: "ssh:build-01" }, remote.deps);
    expect(agent.target).toBe("ssh:build-01");
    await agent.facts();
    agent.start(spec());
    const renv = remote.spawned[0].options.env as Record<string, string>;
    expect(renv.SSH_CONNECTION).toBeUndefined();
    expect(renv.SSH_AUTH_SOCK).toBe("/tmp/agent");
  });

  it("waits for its facts when started before they are known, and fails to start when they can't be found", async () => {
    let release!: (f: RunnerFacts) => void;
    const h = harness(linux, { facts: () => new Promise<RunnerFacts>(resolve => { release = resolve; }) });
    const run = h.runner.start(spec());
    expect(h.spawned).toHaveLength(0);
    expect(h.runner.running).toBe(1);
    release(linux);
    await flush();
    expect(h.spawned).toHaveLength(1);

    const broken = harness(linux, { facts: async () => { throw new Error("no"); } });
    await expect(broken.runner.facts()).rejects.toThrow("no");
    const failed = await broken.runner.start(spec()).done;
    expect(failed).toMatchObject({ ended: "failed-to-start", code: null });
    expect(failed.error).toMatch(/shells/);
    void run;
  });

  it("reports live facts: Ember's pids now and the privilege from the injected function", async () => {
    let elevated = false;
    const h = harness(linux);
    const runner = createRunner({ ...h.options, elevated: () => elevated }, h.deps);
    await expect(runner.facts()).resolves.toMatchObject({ privileged: false, ember: { pids: [10, 11] } });
    elevated = true;
    await expect(runner.facts()).resolves.toMatchObject({ privileged: true });
    const failing = createRunner({ ...h.options, elevated: () => { throw new Error("can't read the token"); } }, h.deps);
    await expect(failing.facts()).resolves.toMatchObject({ privileged: true });
  });

  it("finds its facts afresh for each task, one search at a time, and starts runs on the last ones found", async () => {
    let searches = 0;
    let found: RunnerFacts = linux;
    const h = harness(linux, { facts: async () => { searches++; return found; } });
    await Promise.all([h.runner.facts(), h.runner.facts()]);
    expect(searches).toBe(1);
    found = { ...linux, script: null, pty: false };
    await expect(h.runner.facts()).resolves.toMatchObject({ pty: false });
    expect(searches).toBe(2);
    h.runner.start(spec());
    expect(h.spawned[0].command).toBe("/usr/bin/bash");
  });
});

describe("a local run", () => {
  it("has started once the launcher's marker came, and ends with the program's exit status", async () => {
    const h = harness(linux);
    const { run, child } = await started(h);
    const seen: string[] = [];
    run.onOutput(c => seen.push(Buffer.from(c).toString("utf8")));
    child.out(`${START_MARKER.slice(0, 5)}`);
    child.out(`${START_MARKER.slice(5)}hello\r\n`);
    h.timers.now = 1234;
    child.end(3);
    const exit = await run.done;
    expect(exit).toEqual({ code: 3, signal: null, ended: "exit", ms: 1234 });
    expect(seen.join("")).toBe(`${START_MARKER}hello\r\n`);
    expect(child.stdinEnded).toBe(true);
    expect(h.runner.running).toBe(0);
  });

  it("failed to start when its output ended without the marker, with stderr as the reason", async () => {
    const h = harness(linuxPipes);
    const { run, child } = await started(h);
    child.err("bash: /home/ana/src: No such file or directory\n");
    child.end(127);
    await expect(run.done).resolves.toMatchObject({ ended: "failed-to-start", code: 127, error: "The command couldn't start: bash: /home/ana/src: No such file or directory" });
    // A PTY shows the reason on its output.
    const pty = harness(linux);
    const p = await started(pty);
    p.child.out("\x1b[0m/bin/sh: 1: exec: /usr/bin/bash: not found\r\n");
    p.child.end(127);
    await expect(p.run.done).resolves.toMatchObject({ ended: "failed-to-start", error: "The command couldn't start: /bin/sh: 1: exec: /usr/bin/bash: not found" });
  });

  it("knows a Windows run that the job host couldn't contain failed to start", async () => {
    const h = harness(windows);
    const { run, child } = await started(h, spec({ shell: "powershell", cwd: "C:\\x" }));
    child.err("job: AssignProcessToJobObject failed (error 5)\n");
    child.end(125);
    const exit = await run.done;
    expect(exit.ended).toBe("failed-to-start");
    expect(exit.error).toBe("Ember's job host couldn't start the command, so it didn't run (AssignProcessToJobObject failed (error 5)).");
    // A job host that couldn't start PowerShell says so, not that the job failed.
    const ps = await started(h, spec({ shell: "powershell", cwd: "C:\\x" }));
    ps.child.err("job: can't start C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe: ENOENT\n");
    ps.child.end(125);
    await expect(ps.run.done).resolves.toMatchObject({ ended: "failed-to-start", error: expect.stringContaining("can't start C:\\Windows") });
    // A command's own `exit 125` is its exit.
    const own = await started(h, spec({ shell: "powershell", cwd: "C:\\x" }));
    own.child.end(125);
    await expect(own.run.done).resolves.toMatchObject({ ended: "exit", code: 125 });
  });

  it("fails to start in plain words when the program or its folder is missing", async () => {
    const thrown = harness(linux, { spawn: () => { throw Object.assign(new Error("E2BIG"), { code: "E2BIG" }); } });
    await thrown.runner.facts();
    await expect(thrown.runner.start(spec()).done).resolves.toMatchObject({ ended: "failed-to-start", error: "The command is too long to run." });

    const noDir = harness(linux, { isDir: async () => false });
    const missing = fakeChild(null);
    noDir.deps.spawn = () => missing;
    const runner = createRunner(noDir.options, noDir.deps);
    await runner.facts();
    const run = runner.start(spec());
    (missing as unknown as EventEmitter).emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(run.done).resolves.toMatchObject({ ended: "failed-to-start", error: "The folder /home/ana/src doesn't exist here." });

    const noProgram = harness(linux);
    const gone = fakeChild(null);
    noProgram.deps.spawn = () => gone;
    const r2 = createRunner(noProgram.options, noProgram.deps);
    await r2.facts();
    const run2 = r2.start(spec());
    (gone as unknown as EventEmitter).emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(run2.done).resolves.toMatchObject({ ended: "failed-to-start", error: "Ember couldn't start script (ENOENT)." });
  });

  it("refuses a folder that isn't a full path before starting anything", async () => {
    const h = harness(linux);
    await h.runner.facts();
    await expect(h.runner.start(spec({ cwd: "src" })).done).resolves.toMatchObject({ ended: "failed-to-start" });
    await expect(h.runner.start(spec({ shell: "fish" as never })).done).resolves.toMatchObject({ ended: "failed-to-start" });
    expect(h.spawned).toHaveLength(0);
  });

  it("ends when its process exits even if a background child holds the pipes", async () => {
    const h = harness(linux);
    const { run, child } = await started(h);
    child.out(START_MARKER);
    (child as unknown as EventEmitter).emit("exit", 0, null);
    let ended = false;
    void run.done.then(() => { ended = true; });
    await flush();
    expect(ended).toBe(false);
    await h.timers.advance(300);
    expect(ended).toBe(true);
    expect((child.stdout as unknown as FakeStream).destroyed).toBe(true);
  });

  it("takes typing only when interactive, keeps typed lines in memory, and feeds Enter to the secret tracker", async () => {
    const entered: number[] = [];
    let fed = "";
    const h = harness(linux, { tracker: () => ({ output: t => { fed += t; }, enter: () => entered.push(fed.length), spans: () => [] }) });
    const { run, child } = await started(h);
    expect(run.interactive).toBe(true);
    child.out(`${START_MARKER}Password: `);
    const typed = (s: string) => run.input(new TextEncoder().encode(s));
    typed("hunter");
    typed("2x\x7f\r");
    typed("\x1b[A\x1b[?1;2c\x1b]11;rgb:0/0/0\x07line two\r\n");
    typed("partial");
    expect(child.written.map(String).join("")).toBe("hunter2x\x7f\r\x1b[A\x1b[?1;2c\x1b]11;rgb:0/0/0\x07line two\r\npartial");
    expect(run.typedLines()).toEqual(["hunter2", "line two", "partial"]);
    expect(entered).toEqual([fed.length, fed.length]);
    run.forgetTyped();
    expect(run.typedLines()).toEqual([]);

    const pipes = harness(linuxPipes);
    const p = await started(pipes);
    expect(p.run.interactive).toBe(false);
    p.run.input(new TextEncoder().encode("ignored\r"));
    expect(p.child.written).toEqual([]);
    expect(p.run.typedLines()).toEqual([]);
  });

  it("keeps the first 64 KiB and a rolling tail up to 4 MiB, cut between characters, with the secret spans mapped", async () => {
    const spans: { from: number; to: number }[] = [];
    let length = 0;
    const h = harness(linuxPipes, { tracker: () => ({ output: t => { length += t.length; }, enter() {}, spans: () => spans }) });
    const { run, child } = await started(h);
    child.out(START_MARKER);
    const big = Buffer.from("é".repeat(512 * 1024)); // 1 MiB of two-byte characters
    for (let i = 0; i < 5; i++) child.out(big);
    child.out("end");
    child.end(0);
    await run.done;
    const total = START_MARKER.length + 5 * 512 * 1024 + 3;
    expect(length).toBe(total);
    const kept = run.kept();
    expect(kept.bytes.length + kept.omitted).toBe(MARKER_LEN + 5 * big.length + 3);
    expect(kept.bytes.length).toBeLessThanOrEqual(KEEP_BYTES);
    expect(kept.bytes.length).toBeGreaterThan(KEEP_BYTES - 4);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(kept.bytes);
    expect(text.startsWith(START_MARKER)).toBe(true);
    expect(text.endsWith("éend")).toBe(true);
    // A span in the head, one across the cut, one in the tail; one wholly in the dropped middle.
    const headChars = new TextDecoder().decode(kept.bytes.subarray(0, KEEP_HEAD_BYTES)).length;
    spans.push({ from: 10, to: 20 }, { from: headChars - 5, to: total - 10 }, { from: total - 3, to: total + 50 }, { from: headChars + 100, to: headChars + 200 });
    const mapped = run.kept().secretSpans;
    const keptChars = text.length;
    expect(mapped[0]).toEqual({ from: 10, to: 20 });
    expect(mapped).toContainEqual({ from: headChars - 5, to: keptChars - 10 });
    expect(mapped).toContainEqual({ from: keptChars - 3, to: keptChars });
    expect(mapped).toHaveLength(3);
  });

  it("gives each subscriber the bytes as they come, and stops giving them to one that left", async () => {
    const h = harness(linux);
    const { run, child } = await started(h);
    const a: number[] = [], b: number[] = [];
    const offA = run.onOutput(c => a.push(c.length));
    run.onOutput(() => { throw new Error("a broken subscriber"); });
    run.onOutput(c => b.push(c.length));
    child.out("abc");
    offA();
    child.out("de");
    expect(a).toEqual([3]);
    expect(b).toEqual([3, 2]);
  });

  it("stops at its timeout (at most 15 minutes; 2 minutes when none is given)", async () => {
    const h = harness(linux);
    const { run, child } = await started(h, spec({ timeoutMs: 5000 }));
    await h.timers.advance(4999);
    expect(child.written).toEqual([]);
    await h.timers.advance(1);
    expect(child.written).toEqual(["\x03"]);
    child.end(130);
    await expect(run.done).resolves.toMatchObject({ ended: "timeout" });

    const none = harness(linux);
    const n = await started(none, spec({ timeoutMs: 0 }));
    await none.timers.advance(DEFAULT_TIMEOUT_MS - 1);
    expect(n.child.written).toEqual([]);
    await none.timers.advance(1);
    expect(n.child.written).toEqual(["\x03"]);
  });

  it("logs the run's id and end, never its text or typing", async () => {
    const h = harness(linux);
    const { run, child } = await started(h);
    child.out(START_MARKER);
    run.input(new TextEncoder().encode("secret-typed\r"));
    child.end(0);
    await run.done;
    const logged = JSON.stringify(h.logs);
    expect(logged).toContain(RUN_ID);
    expect(logged).not.toContain("secret-typed");
    expect(logged).not.toContain("build");
    expect(h.logs.map(l => l[0])).toEqual(["commands.started", "commands.ended"]);
  });
});

const MARKER_LEN = Buffer.byteLength(START_MARKER);
