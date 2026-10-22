import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { RunnerFacts, RunSpec } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";
import { LADDER_MS, startLadder, stragglerText, type LadderKind, type LadderOps, type Timers } from "../../app/main/commands/run/kill";
import { createRunner, isKeptRun, START_MARKER, type ChildLike, type RunnerDeps } from "../../app/main/commands/run/local";

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
  get pending(): number {
    return this.queue.length;
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

/** Ops that record what each step did, at what time. */
function recorder(timers: FakeTimers, sweepNames: (signal: NodeJS.Signals) => string[] = () => []) {
  const calls: string[] = [];
  const sweeps: { signal: NodeJS.Signals; resolve: () => void }[] = [];
  let holdSweeps = false;
  const ops: LadderOps = {
    interrupt: () => calls.push(`${timers.now} interrupt`),
    group: s => calls.push(`${timers.now} group ${s}`),
    session: s => calls.push(`${timers.now} session ${s}`),
    sweep: s => {
      calls.push(`${timers.now} sweep ${s}`);
      if (!holdSweeps) return Promise.resolve(sweepNames(s));
      return new Promise<string[]>(resolve => sweeps.push({ signal: s, resolve: () => resolve(sweepNames(s)) }));
    },
    terminate: () => calls.push(`${timers.now} terminate`),
  };
  return { ops, calls, sweeps, hold: () => { holdSweeps = true; } };
}

describe("the kill ladder", () => {
  it("runs a POSIX PTY run's steps at 0, 300, 1000 and 1500 ms (§3.13)", async () => {
    const timers = new FakeTimers();
    const r = recorder(timers, s => (s === "SIGKILL" && timers.now === 1500 ? ["sleep"] : []));
    const ladder = startLadder("posix-pty", r.ops, timers);
    // Step 1 is synchronous: the kill switch's 300 ms race.
    expect(r.calls).toEqual(["0 interrupt"]);
    let killed = false;
    void ladder.killed.then(() => { killed = true; });
    await timers.advance(LADDER_MS.term - 1);
    expect(r.calls).toEqual(["0 interrupt"]);
    await timers.advance(1);
    expect(r.calls.slice(1)).toEqual(["300 group SIGTERM", "300 session SIGTERM", "300 sweep SIGTERM"]);
    await timers.advance(LADDER_MS.kill - LADDER_MS.term);
    expect(r.calls.slice(4)).toEqual(["1000 group SIGKILL", "1000 session SIGKILL", "1000 sweep SIGKILL", "1000 terminate"]);
    expect(killed).toBe(true);
    await timers.advance(LADDER_MS.last - LADDER_MS.kill);
    expect(r.calls.slice(8)).toEqual(["1500 sweep SIGKILL"]);
    await expect(ladder.stragglers).resolves.toEqual(["sleep"]);
    expect(timers.pending).toBe(0);
  });

  it("starts a POSIX pipe run's ladder with SIGINT to the group", async () => {
    const timers = new FakeTimers();
    const r = recorder(timers);
    const ladder = startLadder("posix-pipe", r.ops, timers);
    expect(r.calls).toEqual(["0 group SIGINT"]);
    await timers.advance(LADDER_MS.last);
    expect(r.calls).toEqual([
      "0 group SIGINT",
      "300 group SIGTERM", "300 session SIGTERM", "300 sweep SIGTERM",
      "1000 group SIGKILL", "1000 session SIGKILL", "1000 sweep SIGKILL", "1000 terminate",
      "1500 sweep SIGKILL",
    ]);
    await expect(ladder.stragglers).resolves.toEqual([]);
  });

  it("terminates a Windows run's job host at once, with no polite phase and nothing left", async () => {
    const timers = new FakeTimers();
    const r = recorder(timers);
    const ladder = startLadder("windows", r.ops, timers);
    expect(r.calls).toEqual(["0 terminate"]);
    expect(timers.pending).toBe(0);
    await expect(ladder.killed).resolves.toBeUndefined();
    await expect(ladder.stragglers).resolves.toEqual([]);
  });

  it("never kills a WSL run's wsl.exe before the KILL sweep has run (critique wsl-16)", async () => {
    for (const kind of ["wsl-pty", "wsl-pipe"] as LadderKind[]) {
      const timers = new FakeTimers();
      const r = recorder(timers);
      r.hold();
      startLadder(kind, r.ops, timers);
      expect(r.calls).toEqual([kind === "wsl-pty" ? "0 interrupt" : "0 sweep SIGINT"]);
      await timers.advance(LADDER_MS.term);
      expect(r.calls.slice(1)).toEqual(["300 sweep SIGTERM"]);
      await timers.advance(LADDER_MS.kill - LADDER_MS.term);
      expect(r.calls.slice(2)).toEqual(["1000 sweep SIGKILL"]);
      // The KILL sweep (a wsl.exe start) answers at 1200 ms: only then does the job host go.
      await timers.advance(200);
      r.sweeps.find(s => s.signal === "SIGKILL")?.resolve();
      await flush();
      expect(r.calls.slice(3)).toEqual(["1200 terminate"]);
      await timers.advance(300);
      expect(r.calls.slice(4)).toEqual(["1500 sweep SIGKILL"]);
    }
  });

  it("ends a WSL run's job host at 1500 ms at the latest, before the last sweep", async () => {
    const timers = new FakeTimers();
    const r = recorder(timers);
    r.hold();
    const ladder = startLadder("wsl-pipe", r.ops, timers);
    await timers.advance(LADDER_MS.last);
    expect(r.calls.slice(-2)).toEqual(["1500 terminate", "1500 sweep SIGKILL"]);
    r.sweeps.forEach(s => s.resolve());
    await flush();
    // The late KILL sweep's answer doesn't terminate it twice.
    expect(r.calls.filter(c => c.endsWith("terminate"))).toHaveLength(1);
    await expect(ladder.stragglers).resolves.toEqual([]);
  });

  it("keeps going when an operation throws or a sweep fails", async () => {
    const timers = new FakeTimers();
    const ops: LadderOps = {
      interrupt: () => { throw new Error("EPIPE"); },
      group: () => { throw new Error("ESRCH"); },
      session: () => { throw new Error("no pkill"); },
      sweep: () => Promise.reject(new Error("no /proc")),
      terminate: () => { throw new Error("ESRCH"); },
    };
    const ladder = startLadder("posix-pty", ops, timers);
    await timers.advance(LADDER_MS.last);
    await expect(ladder.stragglers).resolves.toEqual([]);
    await expect(ladder.killed).resolves.toBeUndefined();
  });

  it("names what is left in the status line's words", () => {
    expect(stragglerText([])).toBe("");
    expect(stragglerText(["sleep"])).toBe("1 program it started is still running: sleep.");
    expect(stragglerText(["sleep", "node", "node"])).toBe("3 programs it started are still running: sleep, node.");
    expect(stragglerText(["a", "b", "c", "d", "e"])).toBe("5 programs it started are still running: a, b, c and 2 more.");
  });
});

// ─────────────── The ladder through the runner (fake spawn, signals and helpers) ───────────────

const RUN_ID = "fedcba9876543210";
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet, file: "" };
const ember = { paths: [], pids: [], names: /^ember$/ };
const linux: RunnerFacts = {
  os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/usr/bin/bash", sh: "/usr/bin/sh" }, script: { path: "/usr/bin/script", kind: "util-linux" },
  home: "/home/ana", user: "ana", privileged: false, pty: true, ember, extraPath: [],
};
const windows: RunnerFacts = {
  ...linux, os: "win32", shells: ["powershell"], shellPaths: { powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }, script: null, pty: false,
};
const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  runId: RUN_ID, taskId: "1-x", shell: "bash", command: "sleep 1000 & wait", cwd: "/home/ana", timeoutMs: 60_000, cols: 80, rows: 24,
  stamp: { taskId: "1-x", sha256: "b".repeat(64), verdict: "run", classes: [], rules: [], approval: null },
  ...over,
});

function child(pid: number) {
  const events = new EventEmitter();
  const stdout = new EventEmitter() as EventEmitter & { destroy(): void };
  const stderr = new EventEmitter() as EventEmitter & { destroy(): void };
  stdout.destroy = () => stdout.emit("close");
  stderr.destroy = () => stderr.emit("close");
  const c = {
    pid,
    written: [] as string[],
    killed: 0,
    stdin: { write: (b: string | Uint8Array) => c.written.push(String(b)), end: () => undefined, on: () => undefined },
    stdout, stderr,
    on: (e: string, fn: (...a: never[]) => void) => events.on(e, fn as (...a: unknown[]) => void),
    kill: () => {
      c.killed++;
      return true;
    },
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => {
      events.emit("exit", code, signal);
      stdout.emit("close");
      stderr.emit("close");
    },
  };
  return c;
}

function setup(facts: RunnerFacts) {
  const timers = new FakeTimers();
  const record: string[] = [];
  const children: ReturnType<typeof child>[] = [];
  const warned: [string, unknown][] = [];
  const deps: Partial<RunnerDeps> = {
    spawn: () => {
      const c = child(5000 + children.length);
      children.push(c);
      return c as unknown as ChildLike;
    },
    timers,
    now: () => timers.now,
    kill: (pid, signal) => record.push(`${timers.now} kill ${pid} ${signal}`),
    exec: async (file, args) => {
      record.push(`${timers.now} ${file} ${args.join(" ")}`);
      return { code: 0, stdout: file === "pgrep" ? "5001\n" : "" };
    },
    sweep: async (runId, signal) => {
      record.push(`${timers.now} sweep ${runId} ${signal}`);
      return signal === "SIGKILL" && timers.now >= 1500 ? ["sleep"] : [];
    },
    facts: async () => facts,
    isDir: async () => true,
    tracker: () => ({ output() {}, enter() {}, spans: () => [] }),
  };
  const log: Logger = { ...quiet, warn: (m, f) => warned.push([m, f]) };
  const runner = createRunner({ log, os: facts.os, env: {}, ember: { paths: [], pids: () => [], names: /^ember$/ }, home: "/home/ana", user: "ana", elevated: () => false, extraPath: [], jobHost: facts.os === "win32" ? { execPath: "C:\\Ember\\Ember.exe", script: "C:\\Ember\\job-host.cjs" } : null }, deps);
  return { timers, record, children, runner, warned };
}

describe("stopping a local run", () => {
  it("sends Ctrl+C into script's stdin at once, then reaches the group, script's child session and the sweep", async () => {
    const s = setup(linux);
    await s.runner.facts();
    const run = s.runner.start(spec());
    const c = s.children[0];
    c.stdout.emit("data", Buffer.from(START_MARKER));
    run.stop("user");
    expect(c.written).toEqual(["\x03"]);
    await flush();
    expect(s.record).toEqual(["0 pgrep -P 5000"]);
    await s.timers.advance(300);
    expect(s.record.slice(1)).toEqual(["300 kill -5000 SIGTERM", `300 sweep ${RUN_ID} SIGTERM`, "300 pkill -TERM -s 5001"]);
    c.exit(130);
    await expect(run.done).resolves.toMatchObject({ ended: "stopped-user", code: 130 });
    await s.timers.advance(700);
    expect(s.record.slice(4)).toEqual(["1000 kill -5000 SIGKILL", `1000 sweep ${RUN_ID} SIGKILL`, "1000 kill 5000 SIGKILL", "1000 pkill -KILL -s 5001"]);
    await s.timers.advance(500);
    expect(s.record.slice(8)).toEqual([`1500 sweep ${RUN_ID} SIGKILL`]);
    if (!isKeptRun(run)) throw new Error("not kept");
    await expect(run.stragglers).resolves.toEqual(["sleep"]);
    expect(s.warned).toEqual([["commands.straggler", { runId: RUN_ID, count: 1 }]]);
  });

  it("sends SIGINT to a pipe run's group at once and reaches its own session (the shell leads it)", async () => {
    const s = setup({ ...linux, script: null, pty: false });
    await s.runner.facts();
    const run = s.runner.start(spec());
    run.stop("task");
    expect(s.record).toEqual(["0 kill -5000 SIGINT"]);
    await s.timers.advance(300);
    expect(s.record.slice(1)).toEqual(["300 kill -5000 SIGTERM", `300 sweep ${RUN_ID} SIGTERM`, "300 pkill -TERM -s 5000"]);
    s.children[0].exit(null, "SIGTERM");
    await expect(run.done).resolves.toMatchObject({ ended: "stopped-task", code: null, signal: "SIGTERM" });
  });

  it("terminates a Windows run's job host at once and nothing else", async () => {
    const s = setup(windows);
    await s.runner.facts();
    const run = s.runner.start(spec({ shell: "powershell", cwd: "C:\\Users\\ana" }));
    run.stop("killswitch");
    expect(s.children[0].killed).toBe(1);
    expect(s.children[0].written).toEqual([]);
    await s.timers.advance(2000);
    expect(s.record).toEqual([]);
    s.children[0].exit(1);
    await expect(run.done).resolves.toMatchObject({ ended: "killswitch" });
  });

  it("stops every run for the kill switch synchronously, and waits for SIGKILL or the end when quitting", async () => {
    const s = setup(linux);
    await s.runner.facts();
    const a = s.runner.start(spec());
    const b = s.runner.start(spec({ runId: "0000000000000001" }));
    expect(s.runner.running).toBe(2);
    const pulled = s.runner.stopAll("killswitch");
    expect(s.children.map(c => c.written)).toEqual([["\x03"], ["\x03"]]);
    await pulled;
    s.children.forEach(c => c.exit(130));
    await expect(a.done).resolves.toMatchObject({ ended: "killswitch" });
    await expect(b.done).resolves.toMatchObject({ ended: "killswitch" });
    await flush();
    expect(s.runner.running).toBe(0);

    const q = setup(linux);
    await q.runner.facts();
    const c = q.runner.start(spec());
    let quit = false;
    void q.runner.stopAll("quit").then(() => { quit = true; });
    await q.timers.advance(999);
    expect(quit).toBe(false);
    await q.timers.advance(1);
    expect(quit).toBe(true);
    q.children[0].exit(null, "SIGKILL");
    await expect(c.done).resolves.toMatchObject({ ended: "stopped-task" });
  });

  it("stops a run whose facts are still coming without ever starting it", async () => {
    let release!: (f: RunnerFacts) => void;
    const s = setup(linux);
    const runner = createRunner(
      { log: quiet, os: "linux", env: {}, ember: { paths: [], pids: () => [], names: /^ember$/ }, home: "/h", user: "u", elevated: () => false, extraPath: [], jobHost: null },
      { spawn: () => { throw new Error("must not start"); }, timers: s.timers, now: () => 0, facts: () => new Promise(r => { release = r; }) },
    );
    const run = runner.start(spec());
    run.stop("user");
    await expect(run.done).resolves.toMatchObject({ ended: "stopped-user", code: null });
    release(linux);
    await flush();
    expect(runner.running).toBe(0);
  });

  it("ignores a second stop: the first reason is the run's", async () => {
    const s = setup(linux);
    await s.runner.facts();
    const run = s.runner.start(spec());
    run.stop("timeout");
    run.stop("user");
    expect(s.children[0].written).toEqual(["\x03"]);
    s.children[0].exit(130);
    await expect(run.done).resolves.toMatchObject({ ended: "timeout" });
    run.stop("user");
  });

  it("reports, without killing, what an unstopped run left carrying its marker", async () => {
    const s = setup(linux);
    await s.runner.facts();
    const run = s.runner.start(spec());
    s.children[0].stdout.emit("data", Buffer.from(START_MARKER));
    s.children[0].exit(0);
    await run.done;
    await flush();
    expect(s.record).toEqual([`0 sweep ${RUN_ID} null`]);
  });
});
