/**
 * Commands on the remote (§3.3, §3.10, §3.13, §5.3.11): each run starts with RUN's launcher (a PTY through `script(1)`
 * with its stdin kept open for the run's life, else pipes with stdin closed), the command text only in EMBER_CMD, the
 * run's environment from RUN's `commandEnv` (remote: the SSH login's variables removed), its raw output on its own
 * bulk channel, and a stamp in runs/ for the orphan sweep. Stop runs the POSIX ladder: when someone is watching (the
 * PC's Stop, the kill switch, a timeout, the console's Stop) `^C` or SIGINT at once, SIGTERM to the group, script's
 * session and the environment sweep at 300 ms, SIGKILL to all of them and to `script` at 1 s, a last sweep at 1.5 s;
 * when nobody is (EOF, the grace, a protocol error) SIGTERM at once and SIGKILL at 300 ms, the last sweep at 1.5 s.
 * The typed input goes to the PTY only and is never logged. Plain Node: spawn, signals and timers come in as fakes in
 * tests.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Logger } from "../main/logger";
import type { RunExit, RunnerFacts, RunSpec } from "../main/commands/types";
import type { AgentContracts } from "./contracts";
import type { AgentOs } from "./places";

/** Why a run is stopped: the PC's cmd.stop reasons, the kill switch (`stop`), the console's Stop, or the link gone. */
export type StopWhy = "user" | "task" | "timeout" | "killswitch" | "lost";

/** The start marker every POSIX run prints first (shells.ts POSIX_PRELUDE): a run whose output lacks it never started. */
const START_MARK = Buffer.from("\x1b]777;ember-start\x07", "latin1");
/** An exit marker some launchers print (BSD script's exit status, §3.3): its code wins over script's own. */
const EXIT_MARK = /\x1b\]777;ember-exit;(\d{1,3})\x07/; // eslint-disable-line no-control-regex -- the OSC sequence is matched byte for byte
/** stderr kept for a failed start's reason (only its first part is ever shown). */
const STDERR_KEEP = 8 * 1024;
/** RunExit.error's cap (protocol CAPS.str.reason). */
const ERROR_MAX = 500;

/** The ladder's steps after Stop (ms). */
export const LADDER = { term: 300, kill: 1000, last: 1500 } as const;
/** The ladder when nobody is watching: SIGTERM at once, SIGKILL at 300 ms, the last sweep at 1.5 s. */
export const LADDER_UNATTENDED = { kill: 300, last: 1500 } as const;

/** What the runs need of the agent and the machine. */
export interface RunsDeps {
  contracts: Pick<AgentContracts, "launchArgv" | "commandEnv">;
  os: AgentOs;
  /** The agent's own (sanitised) environment: commandEnv's base. */
  baseEnv: NodeJS.ProcessEnv;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** process.kill (a negative pid signals a process group). */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** The environment sweep for a run (contracts' sweepScript as `/bin/sh -s -- <SIG> <runId>`). */
  sweep: (runId: string, signal: "INT" | "TERM" | "KILL") => Promise<void>;
  /** A signal to every process of a session (`pkill -<SIG> -s <sid>`). */
  killSession: (sid: number, signal: "TERM" | "KILL") => Promise<void>;
  /** The first child of a process (`pgrep -P <pid>`): the session leader script(1) started. */
  childOf: (pid: number) => Promise<number | null>;
  /** Run stamps for the orphan sweep (orphans.ts). */
  stamps: { write(runId: string): void; remove(runId: string): void };
  /** The watchdog's table (watchdog.ts), or null without a watchdog. */
  watch: { add(runId: string, pgid: number): number | null; session(slot: number, sid: number): void; remove(slot: number): void } | null;
  /** A run's output bytes, on its bulk channel. */
  send: (channel: number, bytes: Uint8Array) => void;
  /** A run ended: its exit and how many output bytes went on its channel. */
  exited: (runId: string, exit: RunExit, outBytes: number) => void;
  log: Logger;
  now: () => number;
}

interface Run {
  spec: RunSpec;
  channel: number;
  child: ChildProcess | null;
  pid: number | null;
  sid: number | null;
  slot: number | null;
  interactive: boolean;
  started: boolean;
  tail: Buffer;
  stderr: string;
  exitMark: number | null;
  outBytes: number;
  t0: number;
  stopWhy: StopWhy | null;
  ladder: Promise<void> | null;
  timers: NodeJS.Timeout[];
  ended: Promise<void>;
  end: () => void;
}

/** RunExit.ended for a stop. */
const ENDED_BY: Record<StopWhy, RunExit["ended"]> = { user: "stopped-user", task: "stopped-task", timeout: "timeout", killswitch: "killswitch", lost: "lost" };

/** A plain one-line reason from a failed start's stderr (control characters dropped, at most 500 characters). */
export function startError(stderr: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what's removed
  const text = stderr.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, ERROR_MAX);
}

/** The commands running on this remote. */
export class RemoteRuns {
  private runs = new Map<string, Run>();
  /** Ended runs, kept briefly so a late cmd.stop or cmd.input for one isn't "gone". */
  private ended = new Set<string>();

  constructor(private d: RunsDeps) {}

  /** Runs not yet ended. */
  get running(): number {
    return this.runs.size;
  }

  /** The pids of every live run's process (Ember's own processes, D4.5). */
  pids(): number[] {
    return [...this.runs.values()].flatMap(r => (r.pid ? [r.pid] : []));
  }

  /** Has `runId` run here (live or recently ended)? */
  knows(runId: string): boolean {
    return this.runs.has(runId) || this.ended.has(runId);
  }

  /**
   * Starts `spec` on bulk channel `channel`. Never throws: a run that can't start ends at once (its `exited` comes with
   * `failed-to-start` and the reason). Returns whether the user can type into it.
   */
  start(spec: RunSpec, channel: number, facts: RunnerFacts): { interactive: boolean } {
    if (this.runs.has(spec.runId) || this.ended.has(spec.runId)) throw new Error("that run id was used already");
    let end!: () => void;
    const ended = new Promise<void>(r => { end = r; });
    const run: Run = {
      spec, channel, child: null, pid: null, sid: null, slot: null, interactive: false, started: false, tail: Buffer.alloc(0), stderr: "",
      exitMark: null, outBytes: 0, t0: this.d.now(), stopWhy: null, ladder: null, timers: [], ended, end,
    };
    this.runs.set(spec.runId, run);
    let launch: ReturnType<AgentContracts["launchArgv"]>;
    try {
      launch = this.d.contracts.launchArgv(spec, facts, { jobHost: null });
    } catch (err) {
      this.finish(run, { code: null, signal: null, ended: "failed-to-start", ms: 0, error: startError((err as Error).message, "It couldn't start.") });
      return { interactive: false };
    }
    const pty = launch.options.stdio[0] === "pipe";
    const env = {
      ...this.d.contracts.commandEnv(this.d.baseEnv, { os: this.d.os, pty, remote: true, extraPath: facts.extraPath, runId: spec.runId }),
      ...launch.env,
    };
    let child: ChildProcess;
    try {
      child = this.d.spawn(launch.command, launch.args, { ...launch.options, cwd: spec.cwd, env });
    } catch (err) {
      this.finish(run, { code: null, signal: null, ended: "failed-to-start", ms: 0, error: startError((err as Error).message, "It couldn't start.") });
      return { interactive: false };
    }
    run.child = child;
    run.pid = child.pid ?? null;
    run.interactive = pty && !!child.stdin;
    child.stdin?.on("error", () => { /* the run ended while typing reached it */ });
    if (run.pid) {
      this.d.stamps.write(spec.runId);
      run.slot = this.d.watch?.add(spec.runId, run.pid) ?? null;
      // script(1) makes its child a session of its own, which a group signal doesn't reach: note its id early.
      if (pty) for (const ms of [100, 600]) run.timers.push(setTimeout(() => void this.findSession(run), ms));
    }
    const out = (chunk: Buffer, isErr: boolean) => {
      run.outBytes += chunk.length;
      if (isErr && run.stderr.length < STDERR_KEEP) run.stderr += chunk.toString("utf8");
      if (!run.started || run.exitMark === null) this.scan(run, chunk);
      this.d.send(run.channel, chunk);
    };
    child.stdout?.on("data", (c: Buffer) => out(c, false));
    child.stderr?.on("data", (c: Buffer) => out(c, true));
    child.on("error", err => {
      const errno = (err as NodeJS.ErrnoException).code;
      // A spawn that failed names the program, not the folder: say both (an ENOENT is either).
      if (!run.started) run.stderr ||= errno === "ENOENT" ? `The folder ${spec.cwd} or the shell isn't on this computer.` : (err as Error).message;
      this.d.log.warn("remote.run_error", { runId: spec.runId, code: errno });
    });
    child.on("close", (code, signal) => this.closed(run, code, signal));
    run.timers.push(setTimeout(() => this.stop(spec.runId, "timeout"), spec.timeoutMs));
    this.d.log.info("remote.run_started", { runId: spec.runId, pty, pid: run.pid });
    return { interactive: run.interactive };
  }

  /** The user's typing for an interactive run (never logged). False when the run isn't live or takes no typing. */
  input(runId: string, bytes: Uint8Array): boolean {
    const run = this.runs.get(runId);
    if (!run?.interactive || !run.child?.stdin?.writable) return false;
    run.child.stdin.write(bytes);
    return true;
  }

  /** Stops a run with the attended ladder (^C first). False when no such run is live. */
  stop(runId: string, why: StopWhy): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (!run.stopWhy) run.stopWhy = why;
    run.ladder ??= this.ladder(run, true);
    return true;
  }

  /**
   * Stops every run: attended (^C first) or not (SIGTERM first). Resolves once each was signalled; `ladders()` resolves
   * when every ladder's last sweep has run.
   */
  async stopAll(why: StopWhy, attended: boolean): Promise<void> {
    for (const run of this.runs.values()) {
      if (!run.stopWhy) run.stopWhy = why;
      run.ladder ??= this.ladder(run, attended);
    }
  }

  /** Resolves when every run that is live now has ended. */
  allEnded(): Promise<void> {
    return Promise.all([...this.runs.values()].map(r => r.ended)).then(() => undefined);
  }

  /** Resolves when every ladder started so far has run its last step. */
  ladders(): Promise<void> {
    return Promise.all([...this.runs.values()].map(r => r.ladder ?? Promise.resolve())).then(() => undefined);
  }

  /** Looks for the start and exit markers across chunk boundaries. */
  private scan(run: Run, chunk: Buffer): void {
    const seen = Buffer.concat([run.tail, chunk]);
    if (!run.started && seen.includes(START_MARK)) run.started = true;
    const m = EXIT_MARK.exec(seen.toString("latin1"));
    if (m) run.exitMark = Number(m[1]);
    run.tail = seen.subarray(Math.max(0, seen.length - 64));
  }

  private async findSession(run: Run): Promise<void> {
    if (run.sid || !run.pid || !this.runs.has(run.spec.runId)) return;
    const sid = await this.d.childOf(run.pid).catch(() => null);
    if (!sid || run.sid) return;
    run.sid = sid;
    if (run.slot !== null) this.d.watch?.session(run.slot, sid);
  }

  /** The stop ladder (§3.13); every step is sent whatever happened to the last, so stragglers are reached too. */
  private async ladder(run: Run, attended: boolean): Promise<void> {
    const { runId } = run.spec;
    const group = (signal: NodeJS.Signals) => {
      if (!run.pid) return;
      try { this.d.kill(-run.pid, signal); } catch { /* the group is gone */ }
    };
    const session = async (signal: "TERM" | "KILL") => {
      if (!run.sid) await this.findSession(run);
      if (run.sid) await this.d.killSession(run.sid, signal).catch(() => undefined);
    };
    const sweep = (signal: "TERM" | "KILL") => this.d.sweep(runId, signal).catch(() => undefined);
    const t0 = this.d.now();
    const at = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, t0 + ms - this.d.now())));
    this.d.log.info("remote.run_stop", { runId, why: run.stopWhy, attended });
    if (attended) {
      // t = 0, synchronously: ^C through the PTY reaches the foreground group whoever owns it (sudo's child too).
      if (run.interactive && run.child?.stdin?.writable) run.child.stdin.write("\x03");
      else group("SIGINT");
      await at(LADDER.term);
      group("SIGTERM");
      await Promise.all([session("TERM"), sweep("TERM")]);
      await at(LADDER.kill);
    } else {
      group("SIGTERM");
      await Promise.all([session("TERM"), sweep("TERM")]);
      await at(LADDER_UNATTENDED.kill);
    }
    group("SIGKILL");
    await Promise.all([session("KILL"), sweep("KILL")]);
    if (run.pid) {
      // script itself: its exit hangs up the PTY (SIGHUP to the session).
      try { this.d.kill(run.pid, "SIGKILL"); } catch { /* gone */ }
    }
    await at(LADDER.last);
    await sweep("KILL");
    this.d.log.info("remote.run_stop_done", { runId, ended: !this.runs.has(runId) });
  }

  private closed(run: Run, code: number | null, signal: NodeJS.Signals | null): void {
    const ms = Math.max(0, this.d.now() - run.t0);
    // A process that never ran reports a negative errno as its code.
    if (code !== null && code < 0) code = null;
    let exit: RunExit;
    if (run.stopWhy) exit = { code, signal, ended: ENDED_BY[run.stopWhy], ms };
    else if (!run.started) exit = { code, signal, ended: "failed-to-start", ms, error: startError(run.stderr, "It couldn't start (it printed nothing).") };
    else exit = { code: run.exitMark ?? code, signal, ended: "exit", ms };
    this.finish(run, exit);
  }

  private finish(run: Run, exit: RunExit): void {
    const { runId } = run.spec;
    if (!this.runs.has(runId)) return;
    for (const t of run.timers) clearTimeout(t);
    this.runs.delete(runId);
    this.ended.add(runId);
    if (this.ended.size > 256) this.ended.delete(this.ended.values().next().value as string);
    // Typing can't reach a run that ended; its PTY's stdin is closed with it.
    try { run.child?.stdin?.end(); } catch { /* closed already */ }
    if (run.pid) this.d.stamps.remove(runId);
    if (run.slot !== null) this.d.watch?.remove(run.slot);
    this.d.log.info("remote.run_ended", { runId, ended: exit.ended, code: exit.code, ms: exit.ms });
    run.end();
    this.d.exited(runId, exit, run.outBytes);
  }
}
