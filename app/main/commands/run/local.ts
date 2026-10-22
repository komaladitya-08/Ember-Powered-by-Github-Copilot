/**
 * This computer's command runner (§3.3, §3.10, §3.13; package RUN): one command run exactly as decided. POSIX runs go
 * through script(1) for a PTY where it exists (stdin a pipe held open until the run ends, since util-linux 2.32 ends
 * the session at stdin's EOF) or on pipes with stdin closed; Windows runs go through Ember's job host into Windows
 * PowerShell 5.1 on pipes (L3), in a kill-on-close job from birth. The command text is never on any argv: it travels in
 * EMBER_CMD and the fixed launchers of shells.ts read and unset it. The environment is commandEnv's (§3.3.1). Output
 * bytes go to subscribers as they come and are kept for shaping (the first 64 KiB and a rolling tail, 4 MiB in all);
 * the user's typing goes only to the program and to memory (never logged); a secret tracker withholds what answers a
 * password-like prompt (L2). Stop, the kill switch and timeouts run kill.ts's ladder. A POSIX run whose output ends
 * without the launcher's start marker failed to start, with its stderr as the reason.
 *
 * After an Ember crash (L10's residual): a Windows run ends with its job; a POSIX run's processes go on until they write
 * to their closed output (script(1) then dies of SIGPIPE and its PTY hangs up the session; a pipe run's shell gets
 * SIGPIPE) or end by themselves. util-linux 2.32's script ends the session at stdin's EOF, but newer ones (checked with
 * 2.39) only pass the EOF on, so a quiet `sleep 100` outlives Ember. No watchdog rides in the launcher: its text is fixed
 * and shared with WSL and remote runs, and a watchdog would itself carry the run's marker.
 *
 * Plain Node, no Electron: the remote agent runs the same code (createRunner with `remote: true`). koffi is never
 * loaded here (the job host loads it, on Windows only). Paths follow the target's rules (node:path/posix or /win32).
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import type { OS } from "../../../shared/shortcuts";
import type { TargetId } from "../../../shared/targets";
import type { Logger } from "../../logger";
import type { CommandRunner, GitFacts, JobHostRef, PathFact, RunExit, RunningCommand, RunSpec, RunnerFacts } from "../types";
import { commandEnv, mergeEnv } from "./env";
import { localFacts, SAFE_POSIX_PATH } from "./facts";
import { gitRunner, readGitFacts } from "./git-facts";
import { inspectPaths } from "./inspect";
import { trackSecretPrompts, type SecretTracker } from "../prompts";
import { REAL_TIMERS, startLadder, type Ladder, type LadderKind, type LadderOps, type Timers } from "./kill";
import { NO_RC, PS_INNER, WSL_EVAL, posixBody, posixInner } from "./shells";
import { linesKept, RUN_ID, sweepLocal } from "./sweep";
import { JOB_FAILED, JOB_FAILED_PREFIX, jobHostArgv } from "./win32-job";

export { jobHostArgv };

/** The OSC sequence POSIX_PRELUDE prints first: a run whose output ends without it failed to start (§3.13). */
export const START_MARKER = "\x1b]777;ember-start\x07";
const MARKER_BYTES = Buffer.from(START_MARKER, "latin1");

/** Output kept per run for shaping (§3.10): the first 64 KiB, and a rolling tail up to 4 MiB in all. */
export const KEEP_HEAD_BYTES = 64 * 1024;
export const KEEP_BYTES = 4 * 1024 * 1024;
/** How long output may still arrive after the run's own process exited (a background child can hold the pipes). */
export const DRAIN_MS = 300;
/** Default and longest run time (§3.13). */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 900_000;
/** stderr kept for a failed start's reason. */
const STDERR_KEEP = 8 * 1024;
/** Typed lines kept per run (the oldest go first), and the longest kept line. */
const MAX_TYPED_LINES = 1000;
const MAX_TYPED_LINE = 4096;
/** How long pgrep or pkill may take on the ladder. */
const HELPER_MS = 2000;

/** Why a run can't be launched as decided, in plain words: the run ends failed-to-start with it. */
export class LaunchError extends Error {}

/** A spawn's options as launchArgv gives them (§3.3's spawn table). */
export interface LaunchOptions { detached: boolean; windowsHide?: boolean; stdio: ["pipe" | "ignore", "pipe", "pipe"] }

/** Control characters, a double quote or a backslash: none may stand in a WSL `--cd` folder (critique wsl-18). */
const WSL_CWD_BAD = /[\0-\x1f\x7f"\\]/; // eslint-disable-line no-control-regex -- control characters are exactly what's refused here
/** A WSL distro name as wsl.exe registers them. */
const DISTRO_NAME = /^[A-Za-z0-9._-]+$/;
/** An absolute Windows path Ember can hand to CreateProcess as a program. */
const WINDOWS_PROGRAM = /^[A-Za-z]:\\[^"\0\r\n<>|?*]+$/;

/** What crosses into a distro for every WSL run (WSLENV, each `/u`: from Windows into WSL only). */
export const WSLENV_RUN: readonly string[] = ["EMBER_INNER", "EMBER_CMD_B64", "EMBER_RUN_ID", "EMBER_COLS", "EMBER_ROWS", "TERM"];
/**
 * §3.3.1's non-interactive defaults as a WSL pipe run carries them into the distro (WSLENV takes a variable's value
 * from Windows' side, so the values are fixed here): a program that wants an answer fails at once instead of waiting.
 */
export const WSL_PIPE_DEFAULTS: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never" };

/** A UTF-16 surrogate without its pair: it can't be encoded as UTF-8, and Node would hand the shell U+FFFD in its place. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const posixShell = (shell: string): shell is "bash" | "zsh" | "sh" => shell === "bash" || shell === "zsh" || shell === "sh";
const size = (n: number, fallback: number) => (Number.isFinite(n) && n >= 1 ? String(Math.min(1000, Math.trunc(n))) : String(fallback));

/** The exact argv and spawn options of §3.3 for a run (pure). Throws LaunchError when the run can't be launched as decided. */
export function launchArgv(
  spec: RunSpec,
  facts: RunnerFacts,
  o: { jobHost: JobHostRef | null; wsl?: { exe: string; distro: string } },
): { command: string; args: string[]; options: LaunchOptions; env: Record<string, string> } {
  if (!RUN_ID.test(spec.runId)) throw new LaunchError("The run has no valid id.");
  if (typeof spec.command !== "string" || spec.command.includes("\0")) throw new LaunchError("The command holds a NUL character, which can't be handed to a shell.");
  // The bytes that run must be the text that was shown and decided: an unpaired surrogate would arrive changed.
  if (LONE_SURROGATE.test(spec.command) || typeof spec.cwd !== "string" || LONE_SURROGATE.test(spec.cwd) || spec.cwd.includes("\0")) {
    throw new LaunchError("The command or its folder holds a character that can't be passed on exactly as shown.");
  }
  const cols = size(spec.cols, 80), rows = size(spec.rows, 24);

  const posixPath = (): { shell: "bash" | "zsh" | "sh"; path: string } => {
    const shell = spec.shell;
    if (!posixShell(shell)) throw new LaunchError(`Ember doesn't run ${shell} commands here.`);
    if (!facts.shells.includes(shell)) throw new LaunchError(`${shell} isn't available here.`);
    const path = facts.shellPaths[shell];
    // The path is written into the launcher's text (posixInner): anything but these characters could change it.
    if (!path || !SAFE_POSIX_PATH.test(path)) throw new LaunchError(`Ember can't start ${shell}: its path has characters Ember doesn't put in a launcher.`);
    return { shell, path };
  };
  const safeScript = facts.script && SAFE_POSIX_PATH.test(facts.script.path) ? facts.script : null;
  if (facts.script && !safeScript) throw new LaunchError("Ember can't start script(1): its path has characters Ember doesn't pass on.");

  if (o.wsl) {
    if (!o.jobHost) throw new LaunchError("Ember's job host is missing, so it can't run commands in WSL safely.");
    if (!DISTRO_NAME.test(o.wsl.distro)) throw new LaunchError("Ember can't pass that distribution's name to WSL.");
    if (!WINDOWS_PROGRAM.test(o.wsl.exe)) throw new LaunchError("Ember can't find wsl.exe.");
    if (WSL_CWD_BAD.test(spec.cwd) || !spec.cwd.startsWith("/")) throw new LaunchError("Ember can't pass that folder to WSL.");
    const { shell, path } = posixPath();
    const pty = safeScript?.kind === "util-linux";
    const inner = pty ? posixInner(shell, path, "b64") : posixBody({ pty: false, from: "b64" });
    const rest = pty
      ? ["-d", o.wsl.distro, "--cd", spec.cwd, "--exec", "/usr/bin/env", "SHELL=/bin/sh", safeScript.path, "-q", "-e", "-f", "-c", WSL_EVAL, "/dev/null"]
      : ["-d", o.wsl.distro, "--cd", spec.cwd, "--exec", path, ...NO_RC[shell], "-c", WSL_EVAL];
    const argv = jobHostArgv(o.jobHost, o.wsl.exe, rest, pty);
    return {
      command: argv[0],
      args: argv.slice(1),
      options: { detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        WSL_UTF8: "1",
        EMBER_INNER: inner,
        EMBER_CMD_B64: Buffer.from(spec.command, "utf8").toString("base64"),
        EMBER_RUN_ID: spec.runId,
        ...(pty ? { EMBER_COLS: cols, EMBER_ROWS: rows } : {}),
        TERM: pty ? "xterm-256color" : "dumb",
        // A pipe run can't take typing: §3.3.1's non-interactive defaults, fixed values, cross into the distro too.
        ...(pty ? {} : WSL_PIPE_DEFAULTS),
        // Replaces the user's WSLENV: only these cross into the distro (X11 and the rest of Windows' don't).
        WSLENV: [...WSLENV_RUN, ...(pty ? [] : Object.keys(WSL_PIPE_DEFAULTS))].map(n => `${n}/u`).join(":"),
      },
    };
  }

  if (facts.os === "win32") {
    if (spec.shell !== "powershell") throw new LaunchError("On Windows, Ember runs commands in Windows PowerShell only.");
    if (!o.jobHost) throw new LaunchError("Ember's job host is missing, so it can't run commands safely here.");
    const ps = facts.shellPaths.powershell;
    if (!ps || !WINDOWS_PROGRAM.test(ps)) throw new LaunchError("Ember can't find Windows PowerShell.");
    const argv = jobHostArgv(o.jobHost, ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_INNER], false);
    return {
      command: argv[0],
      args: argv.slice(1),
      options: { detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      env: { ELECTRON_RUN_AS_NODE: "1", EMBER_CMD: spec.command, EMBER_RUN_ID: spec.runId },
    };
  }

  const { shell, path } = posixPath();
  if (safeScript) {
    const inner = posixInner(shell, path, "env");
    const args = safeScript.kind === "util-linux" ? ["-q", "-e", "-f", "-c", inner, "/dev/null"] : ["-q", "/dev/null", "/bin/sh", "-c", inner];
    return {
      command: safeScript.path,
      args,
      options: { detached: true, stdio: ["pipe", "pipe", "pipe"] },
      // script runs its -c text with $SHELL -c.
      env: { SHELL: "/bin/sh", TERM: "xterm-256color", EMBER_CMD: spec.command, EMBER_COLS: cols, EMBER_ROWS: rows, EMBER_RUN_ID: spec.runId },
    };
  }
  return {
    command: path,
    args: [...NO_RC[shell], "-c", posixBody({ pty: false, from: "env" })],
    options: { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    env: { TERM: "dumb", EMBER_CMD: spec.command, EMBER_RUN_ID: spec.runId },
  };
}

/** CL's secret tracker (§3.11 step 2; `commands/prompts.ts`), fed the run's output decoded as a stream. */
export type { SecretTracker };

/** What a run kept for shaping (§3.10, §3.11). */
export interface KeptOutput {
  /** The first 64 KiB and the rolling tail, joined; `omitted` bytes between them weren't kept. */
  bytes: Uint8Array;
  omitted: number;
  /** The secret tracker's spans as character offsets into `bytes` decoded as UTF-8 (ShapeOptions.secretSpans). */
  secretSpans: { from: number; to: number }[];
}

/** The runs this runner (and the remote agent's) starts: RunningCommand plus what output shaping and the status need. */
export interface KeptRun extends RunningCommand {
  /** The output kept so far, with the secret spans that fall in it. */
  kept(): KeptOutput;
  /** The programs the run left behind (named on the status line, §3.13); resolves after the run's last sweep. */
  readonly stragglers: Promise<string[]>;
}

/** Whether a RunningCommand is one of these (the flow shapes its output from kept()). */
export function isKeptRun(run: RunningCommand): run is KeptRun {
  return typeof (run as Partial<KeptRun>).kept === "function";
}

/** A started child as the runner uses it (a ChildProcess; fakes in the tests). */
export interface ChildLike {
  readonly pid?: number;
  readonly stdin: { write(chunk: Uint8Array | string): unknown; end(): unknown; on(event: "error", fn: (err: Error) => void): unknown } | null;
  readonly stdout: StreamLike | null;
  readonly stderr: StreamLike | null;
  on(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
/** A child's output stream as the runner uses it. */
export interface StreamLike {
  on(event: "data", fn: (chunk: Buffer) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  destroy(): unknown;
}

/** Everything the runner does to the machine (the real thing by default; fakes in the unit tests). */
export interface RunnerDeps {
  spawn(command: string, args: string[], options: SpawnOptions): ChildLike;
  timers: Timers;
  now(): number;
  /** A signal to a process, or to a process group with a negative pid (POSIX). May throw. */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Runs a helper (pgrep, pkill) to its end. */
  exec(file: string, args: string[]): Promise<{ code: number | null; stdout: string }>;
  /** The environment sweep (§3.13): the names of the processes carrying the run's marker, each sent `signal`. */
  sweep(runId: string, signal: NodeJS.Signals | null): Promise<string[]>;
  /** The runner's facts without the live parts (pids, privilege). */
  facts(): Promise<RunnerFacts>;
  inspect(paths: string[], cwd: string): Promise<PathFact[]>;
  gitFacts(cwd: string): Promise<GitFacts | null>;
  isDir(path: string): Promise<boolean>;
  tracker(o: { interactive: boolean }): SecretTracker;
}

/** createLocalRunner's options. */
export interface LocalRunnerOptions {
  log: Logger; os: OS; env: NodeJS.ProcessEnv;
  ember: { paths: string[]; pids: () => number[]; names: RegExp };
  home: string; user: string; elevated: () => boolean; extraPath: string[]; jobHost: JobHostRef | null;
}

/** createRunner's options: the local runner's, plus the target it reports and whether it runs on a remote (§3.3.1). */
export type RunnerOptions = LocalRunnerOptions & { target?: TargetId; remote?: boolean };

/** This computer's CommandRunner (local target). */
export function createLocalRunner(o: {
  log: Logger; os: OS; env: NodeJS.ProcessEnv;
  ember: { paths: string[]; pids: () => number[]; names: RegExp };
  home: string; user: string; elevated: () => boolean; extraPath: string[]; jobHost: JobHostRef | null;
}): CommandRunner {
  return createRunner(o);
}

/**
 * The runner with its machine dependencies open to replacement: the unit tests pass fakes, and the remote agent passes
 * `remote: true` (SSH's session variables leave the environment) and its own target id.
 */
export function createRunner(o: RunnerOptions, deps: Partial<RunnerDeps> = {}): CommandRunner {
  const d: RunnerDeps = { ...defaultDeps(o), ...deps };
  const runs = new Set<LocalRun>();
  // Found afresh on every facts() call (the flow asks once per task), one search at a time; a run starts on the last.
  let cached: RunnerFacts | null = null;
  let pending: Promise<RunnerFacts> | null = null;
  const refresh = (): Promise<RunnerFacts> => {
    pending ??= d.facts().then(
      f => {
        cached = f;
        pending = null;
        return f;
      },
      err => {
        pending = null;
        throw err;
      },
    );
    return pending;
  };
  const live = (f: RunnerFacts): RunnerFacts => {
    let privileged = true;
    try {
      privileged = o.elevated() === true;
    } catch {
      // can't tell: every command asks (D4.6, fail closed)
    }
    let pids: number[];
    try {
      pids = o.ember.pids();
    } catch {
      pids = []; // no live list: Ember's paths and names still apply
    }
    return { ...f, privileged, ember: { paths: [...o.ember.paths], pids, names: o.ember.names } };
  };

  return {
    target: o.target ?? "local",
    facts: async () => live(await refresh()),
    inspect: async (paths, cwd) => {
      try {
        return await d.inspect(paths, cwd);
      } catch {
        return paths.map(() => ({ exists: null, real: null }));
      }
    },
    gitFacts: async cwd => {
      try {
        return await d.gitFacts(cwd);
      } catch {
        return null;
      }
    },
    start(spec: RunSpec): RunningCommand {
      const run = new LocalRun(spec, o, d);
      runs.add(run);
      void run.done.then(() => runs.delete(run));
      if (cached) run.launch(cached);
      else refresh().then(f => run.launch(f), () => run.failToStart("Ember couldn't find out which shells this computer has."));
      return run;
    },
    async stopAll(why) {
      const all = [...runs];
      for (const run of all) run.stop(why === "killswitch" ? "killswitch" : "task");
      // The kill switch needs only step 1, sent above; quitting waits until each run ended or was sent SIGKILL.
      if (why === "quit") await Promise.all(all.map(run => Promise.race([run.done.then(() => undefined), run.killed()])));
    },
    get running() {
      return runs.size;
    },
  };
}

/** The real machine. */
function defaultDeps(o: RunnerOptions): RunnerDeps {
  const kill = (pid: number, signal: NodeJS.Signals) => {
    process.kill(pid, signal);
  };
  const exec = (file: string, args: string[]) => helperExec(file, args);
  return {
    spawn: (command, args, options) => nodeSpawn(command, args, options),
    timers: REAL_TIMERS,
    now: () => Date.now(),
    kill,
    exec,
    sweep: async (runId, signal) => {
      if (o.os === "win32") return []; // the job object holds the whole tree
      const found = await sweepLocal(runId, signal, {
        os: o.os,
        uid: typeof process.getuid === "function" ? process.getuid() : -1,
        self: [process.pid],
        readdir: dir => fs.promises.readdir(dir),
        readFile: file => fs.promises.readFile(file),
        // `ps -E -ww` lists every process's whole environment: only the run's lines are kept, so none is cut off.
        run: async (file, args) => helperExec(file, args, line => line.includes(`EMBER_RUN_ID=${runId}`)),
        kill,
      });
      return found.map(p => p.name);
    },
    facts: () => localFacts({ os: o.os, env: o.env, home: o.home, user: o.user, elevated: o.elevated, extraPath: o.extraPath, ember: { paths: o.ember.paths, pids: [], names: o.ember.names } }),
    inspect: (paths, cwd) => inspectPaths(paths, cwd, { os: o.os }),
    gitFacts: cwd => readGitFacts(cwd, gitRunner({ os: o.os, env: o.env, extraPath: o.extraPath })),
    isDir: p => fs.promises.stat(p).then(s => s.isDirectory(), () => false),
    tracker: trackSecretPrompts,
  };
}

/**
 * pgrep, pkill and ps from the system's folders with a fixed environment, stdin closed, at most HELPER_MS. With
 * `keepLine`, only the stdout lines it accepts are kept (no cap applies to what it drops); otherwise at most 1 MiB.
 */
function helperExec(file: string, args: string[], keepLine?: (line: string) => boolean): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    let stdout = "";
    const lines = keepLine ? linesKept(keepLine) : null;
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: lines ? lines.end() : stdout });
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(file, args, { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } });
    } catch {
      resolve({ code: null, stdout: "" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, HELPER_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => {
      if (lines) lines.push(s);
      else if (stdout.length < 1024 * 1024) stdout += s;
    });
    child.on("error", () => done(null));
    child.on("close", code => done(code));
  });
}

/** What each stop reason ends a run as. */
const STOP_ENDED = { user: "stopped-user", task: "stopped-task", killswitch: "killswitch", timeout: "timeout" } as const;
type StopWhy = keyof typeof STOP_ENDED;

/** One run (see the module comment). */
class LocalRun implements KeptRun {
  readonly runId: string;
  readonly done: Promise<RunExit>;
  readonly stragglers: Promise<string[]>;
  private resolveDone!: (exit: RunExit) => void;
  private resolveStragglers!: (names: string[]) => void;
  private readonly t0: number;
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  private isInteractive = false;
  private kind: LadderKind = "posix-pipe";
  private child: ChildLike | null = null;
  private launched = false;
  private ended = false;
  private stopWhy: StopWhy | null = null;
  private ladder: Ladder | null = null;
  private failure: string | null = null;
  /** A spawn failed and the folder is being checked for the message: the run ends when that is known. */
  private checking = false;
  private timer: unknown = null;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private exited = false;
  private openStreams = 0;
  private markerSeen = false;
  private markerCarry: Buffer = Buffer.alloc(0);
  private readonly decoder = new TextDecoder();
  private chars = 0;
  private tracker: SecretTracker | null = null;
  private readonly keep = new OutputKeep();
  private outBytes = 0;
  private stderrText = "";
  private typed: string[] = [];
  private line = "";
  private readonly inputDecoder = new TextDecoder();
  private esc: "" | "esc" | "csi" | "osc" | "osc-esc" | "ss3" = "";
  private lastWasCr = false;

  constructor(private readonly spec: RunSpec, private readonly o: RunnerOptions, private readonly d: RunnerDeps) {
    this.runId = spec.runId;
    this.t0 = d.now();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.stragglers = new Promise(resolve => { this.resolveStragglers = resolve; });
  }

  get interactive(): boolean {
    return this.isInteractive;
  }

  /** Starts the process once the facts are known (at once when they were already found). */
  launch(facts: RunnerFacts): void {
    if (this.launched || this.ended) return;
    this.launched = true;
    if (this.stopWhy) return this.finish();
    const spec = this.spec;
    const P = facts.os === "win32" ? win32 : posix;
    if (typeof spec.cwd !== "string" || !P.isAbsolute(spec.cwd)) return this.failToStart("The command's folder isn't a full path.");
    let launch: ReturnType<typeof launchArgv>;
    try {
      launch = launchArgv(spec, facts, { jobHost: this.o.jobHost });
    } catch (err) {
      return this.failToStart(err instanceof LaunchError ? err.message : "Ember couldn't prepare the command to run.");
    }
    this.kind = facts.os === "win32" ? "windows" : facts.script ? "posix-pty" : "posix-pipe";
    const pty = this.kind === "posix-pty";
    this.isInteractive = pty;
    try {
      this.tracker = this.d.tracker({ interactive: pty });
    } catch {
      this.tracker = null;
    }
    const env = mergeEnv(commandEnv(this.o.env, { os: facts.os, pty, remote: this.o.remote === true, extraPath: this.o.extraPath, runId: spec.runId }), launch.env, facts.os);

    let child: ChildLike;
    try {
      child = this.d.spawn(launch.command, launch.args, { ...launch.options, cwd: spec.cwd, env });
    } catch (err) {
      return this.spawnFailed(err, launch.command);
    }
    this.child = child;
    child.on("error", err => {
      // After a start, an error is a failed signal or write (nothing to do); before one, the program never ran.
      if (child.pid === undefined) this.spawnFailed(err, launch.command);
    });
    child.stdin?.on("error", () => {
      // The run's own process closed its stdin (it ended): typing and Ctrl+C have nowhere to go.
    });
    for (const [stream, isErr] of [[child.stdout, false], [child.stderr, true]] as const) {
      if (!stream) continue;
      this.openStreams++;
      stream.on("data", chunk => this.output(chunk, isErr));
      stream.on("error", () => {
        // a read error ends the stream; its close follows
      });
      stream.on("close", () => {
        this.openStreams--;
        if (this.exited && this.openStreams <= 0) this.finish();
      });
    }
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      if (this.openStreams <= 0) return this.finish();
      // A background child that kept the pipes open must not hold the run open.
      this.d.timers.setTimeout(() => this.finish(), DRAIN_MS);
    });
    const ms = spec.timeoutMs;
    const limit = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    this.timer = this.d.timers.setTimeout(() => this.stop("timeout"), limit);
    this.o.log.info("commands.started", { runId: spec.runId, shell: spec.shell, kind: this.kind, pid: child.pid });
  }

  /** The run ends before its program started, with `why` in plain words. */
  failToStart(why: string): void {
    if (this.ended) return;
    this.failure = why;
    this.finish();
  }

  private spawnFailed(err: unknown, program: string): void {
    if (this.ended || this.checking) return;
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "E2BIG") return this.failToStart("The command is too long to run.");
    // Node says ENOENT for a missing folder and for a missing program alike: the folder is checked to say which.
    this.checking = true;
    const name = program.slice(Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\")) + 1);
    void this.d.isDir(this.spec.cwd).catch(() => false).then(ok => {
      this.checking = false;
      this.failToStart(ok ? `Ember couldn't start ${name}${code ? ` (${code})` : ""}.` : `The folder ${this.spec.cwd} doesn't exist here.`);
    });
  }

  private output(chunk: Buffer, isErr: boolean): void {
    if (this.ended) return;
    this.keep.push(chunk);
    this.outBytes += chunk.length;
    if (isErr && this.stderrText.length < STDERR_KEEP) this.stderrText += chunk.toString("utf8").slice(0, STDERR_KEEP - this.stderrText.length);
    if (!this.markerSeen) {
      const hay = this.markerCarry.length ? Buffer.concat([this.markerCarry, chunk]) : chunk;
      if (hay.includes(MARKER_BYTES)) {
        this.markerSeen = true;
        this.markerCarry = Buffer.alloc(0);
      } else {
        this.markerCarry = Buffer.from(hay.subarray(Math.max(0, hay.length - (MARKER_BYTES.length - 1))));
      }
    }
    this.feed(this.decoder.decode(chunk, { stream: true }));
    for (const fn of this.listeners) {
      try {
        fn(chunk);
      } catch {
        // one subscriber's failure doesn't starve the others
      }
    }
  }

  private feed(text: string): void {
    if (!text) return;
    this.chars += text.length;
    try {
      this.tracker?.output(text);
    } catch {
      // the tracker's failure leaves spans as they are
    }
  }

  onOutput(fn: (chunk: Uint8Array) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  input(bytes: Uint8Array): void {
    if (!this.isInteractive || this.ended || !this.child?.stdin) return;
    try {
      this.child.stdin.write(Buffer.from(bytes));
    } catch {
      return; // stdin already closed: nothing was typed
    }
    this.noteTyping(this.inputDecoder.decode(bytes, { stream: true }));
  }

  /** Line editing as a terminal does it, enough to know the lines typed (L2); terminal sequences aren't text. */
  private noteTyping(text: string): void {
    for (const ch of text) {
      if (this.esc) {
        if (this.esc === "esc") this.esc = ch === "[" ? "csi" : ch === "]" ? "osc" : ch === "O" ? "ss3" : "";
        else if (this.esc === "csi") { if (ch >= "@" && ch <= "~") this.esc = ""; }
        else if (this.esc === "ss3") this.esc = "";
        else if (this.esc === "osc") { if (ch === "\x07") this.esc = ""; else if (ch === "\x1b") this.esc = "osc-esc"; }
        else this.esc = "";
        continue;
      }
      const cr = this.lastWasCr;
      this.lastWasCr = ch === "\r";
      if (ch === "\x1b") this.esc = "esc";
      else if (ch === "\r" || ch === "\n") {
        if (ch === "\n" && cr) continue; // \r\n is one Enter
        if (this.line !== "") {
          this.typed.push(this.line);
          if (this.typed.length > MAX_TYPED_LINES) this.typed.shift();
        }
        this.line = "";
        try {
          this.tracker?.enter();
        } catch {
          // the tracker's failure leaves spans as they are
        }
      } else if (ch === "\x7f" || ch === "\b") this.line = [...this.line].slice(0, -1).join("");
      else if (ch === "\x15" || ch === "\x03") this.line = "";
      else if (ch >= " " && this.line.length < MAX_TYPED_LINE) this.line += ch;
    }
  }

  typedLines(): string[] {
    return this.line !== "" ? [...this.typed, this.line] : [...this.typed];
  }

  forgetTyped(): void {
    this.typed = [];
    this.line = "";
  }

  kept(): KeptOutput {
    const head = this.keep.head(), tail = this.keep.tail();
    const bytes = Buffer.concat([head, tail]);
    let spans: { from: number; to: number }[];
    try {
      spans = this.tracker?.spans() ?? [];
    } catch {
      spans = []; // the tracker failed: nothing it marked can be named
    }
    const total = this.chars;
    const clipped = spans.map(s => ({ from: Math.max(0, s.from), to: Math.min(s.to, total) })).filter(s => s.to > s.from);
    if (this.keep.omitted === 0) return { bytes, omitted: 0, secretSpans: clipped };
    const headChars = new TextDecoder().decode(head).length;
    const tailChars = new TextDecoder().decode(tail).length;
    const dropped = Math.max(0, total - headChars - tailChars);
    const tailStart = headChars + dropped;
    const out: { from: number; to: number }[] = [];
    for (const s of clipped) {
      if (s.from < headChars) out.push({ from: s.from, to: Math.min(s.to, headChars) });
      if (s.to > tailStart) out.push({ from: Math.max(s.from, tailStart) - dropped, to: s.to - dropped });
    }
    return { bytes, omitted: this.keep.omitted, secretSpans: mergeSpans(out) };
  }

  stop(why: StopWhy): void {
    if (this.ended || this.stopWhy) return;
    this.stopWhy = why;
    this.o.log.info("commands.stop", { runId: this.runId, why });
    const child = this.child;
    if (!child) {
      // Not started yet (its facts are still coming, or its start failed): it never will.
      this.finish();
      return;
    }
    const pid = child.pid;
    const d = this.d;
    let session: Promise<number | null> = Promise.resolve(null);
    if (pid !== undefined && this.kind === "posix-pty") {
      // The shell lives in the session script(1) made for it (its pid), which the group signal doesn't reach.
      session = d.exec("pgrep", ["-P", String(pid)]).then(r => {
        const sid = Number((r.stdout.trim().split(/\s+/)[0] ?? ""));
        return Number.isInteger(sid) && sid > 1 ? sid : null;
      }, () => null);
    } else if (pid !== undefined && this.kind === "posix-pipe") {
      session = Promise.resolve(pid); // detached: the shell leads its own session
    }
    const ops: LadderOps = {
      interrupt: () => {
        child.stdin?.write("\x03");
      },
      group: signal => {
        if (pid !== undefined) d.kill(-pid, signal);
      },
      session: signal => {
        void session.then(sid => (sid === null ? undefined : d.exec("pkill", [`-${signal.replace(/^SIG/, "")}`, "-s", String(sid)]))).catch(() => undefined);
      },
      sweep: signal => d.sweep(this.runId, signal),
      terminate: () => {
        if (this.kind === "windows") child.kill();
        // Once it exited (and was reaped) its pid is free for another program: only its group and session remain.
        else if (pid !== undefined && !this.exited) d.kill(pid, "SIGKILL");
      },
    };
    this.ladder = startLadder(this.kind, ops, d.timers);
    void this.ladder.stragglers.then(names => this.reportStragglers(names));
  }

  /** Resolves once the ladder's KILL step went out (or at once when there's no ladder). */
  killed(): Promise<void> {
    return this.ladder ? this.ladder.killed : Promise.resolve();
  }

  private reportStragglers(names: string[]): void {
    if (names.length > 0) this.o.log.warn("commands.straggler", { runId: this.runId, count: names.length });
    this.resolveStragglers(names);
  }

  private finish(): void {
    if (this.ended || this.checking) return;
    this.ended = true;
    if (this.timer !== null) this.d.timers.clearTimeout(this.timer);
    this.feed(this.decoder.decode());
    const child = this.child;
    if (child) {
      for (const s of [child.stdout, child.stderr]) {
        try {
          s?.destroy();
        } catch {
          // already closed
        }
      }
      try {
        // Held open for the run's life (script(1), the job host); the run is over now.
        child.stdin?.end();
      } catch {
        // already closed
      }
    }
    const exit = this.exitInfo();
    this.o.log.info("commands.ended", { runId: this.runId, ended: exit.ended, code: exit.code, signal: exit.signal, ms: exit.ms, outBytes: this.outBytes });
    this.resolveDone(exit);
    if (!this.ladder) {
      // Not stopped: what it left running carrying its marker is reported, not killed (a run's end never waits for it).
      if (!child || this.kind === "windows") this.resolveStragglers([]);
      else void this.d.sweep(this.runId, null).then(names => this.reportStragglers(names), () => this.resolveStragglers([]));
    }
  }

  private exitInfo(): RunExit {
    const ms = Math.max(0, this.d.now() - this.t0);
    const base = { code: this.exitCode, signal: this.exitSignal, ms };
    if (this.failure !== null) return { ...base, ended: "failed-to-start", error: this.failure };
    if (this.stopWhy) return { ...base, ended: STOP_ENDED[this.stopWhy] };
    if (this.kind === "windows" && this.exitCode === JOB_FAILED && this.stderrText.startsWith(JOB_FAILED_PREFIX)) {
      const why = this.stderrText.slice(JOB_FAILED_PREFIX.length).split(/\r?\n/)[0].trim().slice(0, 300);
      return { ...base, ended: "failed-to-start", error: `Ember's job host couldn't start the command, so it didn't run${why ? ` (${why})` : ""}.` };
    }
    if (this.kind !== "windows" && !this.markerSeen) return { ...base, ended: "failed-to-start", error: this.startFailure() };
    return { ...base, ended: "exit" };
  }

  /** A POSIX start failure's reason: its stderr, else what the PTY showed, else the exit status. */
  private startFailure(): string {
    const clean = (s: string) => s.replace(TERMINAL_CODES, "").replace(OTHER_CONTROLS, "").trim();
    const text = clean(this.stderrText) || clean(new TextDecoder().decode(this.keep.head()));
    if (text) return `The command couldn't start: ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`;
    return `The command couldn't start${this.exitCode !== null ? ` (exit code ${this.exitCode})` : this.exitSignal ? ` (${this.exitSignal})` : ""}.`;
  }
}

/** Overlapping or touching spans joined. */
function mergeSpans(spans: { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = spans.filter(s => s.to > s.from).sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/** Output kept for shaping: the first KEEP_HEAD_BYTES, then a rolling tail; cuts fall between UTF-8 characters. */
class OutputKeep {
  private readonly headChunks: Buffer[] = [];
  private headLen = 0;
  private headFull = false;
  private readonly tailChunks: Buffer[] = [];
  private tailLen = 0;
  /** Bytes dropped between the head and the tail. */
  omitted = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (!this.headFull) {
      const room = KEEP_HEAD_BYTES - this.headLen;
      if (rest.length < room) {
        this.headChunks.push(rest);
        this.headLen += rest.length;
        return;
      }
      let n = room;
      // Never split a UTF-8 sequence: the head ends before the lead byte of one that doesn't fit.
      while (n > 0 && n < rest.length && (rest[n] & 0xc0) === 0x80) n--;
      if (n > 0) {
        this.headChunks.push(rest.subarray(0, n));
        this.headLen += n;
      }
      this.headFull = true;
      rest = rest.subarray(n);
      if (rest.length === 0) return;
    }
    this.tailChunks.push(rest);
    this.tailLen += rest.length;
    const cap = KEEP_BYTES - this.headLen;
    while (this.tailLen > cap && this.tailChunks.length > 0) {
      const first = this.tailChunks[0];
      let drop = Math.min(first.length, this.tailLen - cap);
      // The tail starts on a character's first byte.
      while (drop < first.length && (first[drop] & 0xc0) === 0x80) drop++;
      if (drop >= first.length) {
        this.tailChunks.shift();
        this.tailLen -= first.length;
        this.omitted += first.length;
      } else {
        this.tailChunks[0] = first.subarray(drop);
        this.tailLen -= drop;
        this.omitted += drop;
      }
    }
  }

  head(): Buffer {
    return Buffer.concat(this.headChunks);
  }

  tail(): Buffer {
    return Buffer.concat(this.tailChunks);
  }
}

/** Terminal sequences (OSC, CSI, two-byte escapes), removed before a failed start's reason is shown. */
const TERMINAL_CODES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g; // eslint-disable-line no-control-regex -- terminal codes are what's removed
/** Control characters other than tab and newline. */
const OTHER_CONTROLS = /[\0-\x08\x0b-\x1f\x7f]/g; // eslint-disable-line no-control-regex -- control characters are what's removed
