import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { BACKLOG, RemoteRuns, startError, type RunsDeps } from "../../app/remote/commands";
import { CONTRACTS } from "../../app/remote/contracts";
import { emberNamesRegExp } from "../../app/main/remote/protocol";
import type { RunExit, RunnerFacts, RunSpec } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const START = "\x1b]777;ember-start\x07";

const facts = (pty: boolean): RunnerFacts => ({
  os: "linux",
  shells: ["bash", "sh"],
  shellPaths: { bash: "/usr/bin/bash", sh: "/usr/bin/sh" },
  script: pty ? { path: "/usr/bin/script", kind: "util-linux" } : null,
  home: "/home/deploy",
  user: "deploy",
  privileged: false,
  pty,
  ember: { paths: [], pids: [], names: emberNamesRegExp(["ember-remote"]) },
  extraPath: [],
});

const spec = (o: Partial<RunSpec> = {}): RunSpec => ({
  runId: "0123456789abcdef", taskId: "1-abc", shell: "bash", command: "make test && echo 'done'", cwd: "/home/deploy/proj",
  timeoutMs: 120_000, cols: 100, rows: 30,
  stamp: { taskId: "1-abc", sha256: "0".repeat(64), verdict: "run", classes: [], rules: [], approval: null },
  ...o,
});

/** An output pipe: data when the test says, and whether the reader paused it. */
class FakeOut extends EventEmitter {
  paused = false;
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; return this; }
}

/** A process that does nothing until the test says, recording what reaches it. */
class FakeChild extends EventEmitter {
  pid = 4321;
  stdout = new FakeOut();
  stderr = new FakeOut();
  typed: string[] = [];
  stdin: { writable: boolean; write: (b: Uint8Array | string) => boolean; end: () => void; on: () => void } | null;
  constructor(withStdin: boolean) {
    super();
    this.stdin = withStdin ? {
      writable: true,
      write: b => { this.typed.push(Buffer.from(b).toString("latin1")); return true; },
      end: () => { if (this.stdin) this.stdin.writable = false; },
      on: () => undefined,
    } : null;
  }
  out(s: string) { this.stdout.emit("data", Buffer.from(s, "latin1")); }
  err(s: string) { this.stderr.emit("data", Buffer.from(s, "latin1")); }
  close(code: number | null, signal: NodeJS.Signals | null = null) { this.emit("close", code, signal); }
}

/** RemoteRuns over fakes, with everything it does recorded. */
function harness(o: Partial<Pick<RunsDeps, "backlog" | "drop" | "baseEnv">> = {}) {
  const log: string[] = [];
  const spawned: { command: string; args: string[]; options: SpawnOptions; child: FakeChild }[] = [];
  const sent: { channel: number; bytes: string }[] = [];
  const exits: { runId: string; exit: RunExit; outBytes: number }[] = [];
  const stamps = new Set<string>();
  const watched = new Map<number, { runId: string; pgid: number; sid?: number }>();
  const at = () => Date.now();
  const deps: RunsDeps = {
    contracts: CONTRACTS,
    os: "linux",
    baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/deploy", SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22", GH_TOKEN: "secret" },
    spawn: (command, args, options) => {
      const child = new FakeChild(options.stdio instanceof Array && options.stdio[0] === "pipe");
      spawned.push({ command, args, options, child });
      return child as unknown as ChildProcess;
    },
    kill: (pid, signal) => { log.push(`${at()} kill ${pid} ${signal}`); },
    sweep: async (runId, signal) => { log.push(`${at()} sweep ${runId} ${signal}`); },
    killSession: async (sid, signal) => { log.push(`${at()} session ${sid} ${signal}`); },
    childOf: async () => 777,
    stamps: { write: id => { stamps.add(id); }, remove: id => { stamps.delete(id); } },
    watch: {
      add: (runId, pgid) => { watched.set(1, { runId, pgid }); return 1; },
      session: (slot, sid) => { watched.get(slot)!.sid = sid; },
      remove: slot => { watched.delete(slot); },
    },
    send: (channel, bytes) => { sent.push({ channel, bytes: Buffer.from(bytes).toString("latin1") }); },
    exited: (runId, exit, outBytes) => { exits.push({ runId, exit, outBytes }); },
    log: quiet,
    now: at,
    ...o,
  };
  return { runs: new RemoteRuns(deps), log, spawned, sent, exits, stamps, watched };
}

describe("a command on the remote", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it("runs in a PTY through script(1) with the text only in EMBER_CMD, its stdin open, and the SSH login's variables gone", () => {
    const h = harness();
    expect(h.runs.start(spec(), 7, facts(true))).toEqual({ interactive: true });
    const s = h.spawned[0];
    expect(s.command).toBe("/usr/bin/script");
    expect(s.args.slice(0, 5)).toEqual(["-q", "-e", "-f", "-c", expect.stringContaining("exec /usr/bin/bash --noprofile --norc -c '")]);
    expect(s.args.join(" ")).not.toContain("make test");
    expect(s.options).toMatchObject({ detached: true, cwd: "/home/deploy/proj", stdio: ["pipe", "pipe", "pipe"] });
    const env = s.options.env!;
    expect(env.EMBER_CMD).toBe("make test && echo 'done'");
    expect(env.EMBER_RUN_ID).toBe("0123456789abcdef");
    expect([env.EMBER_COLS, env.EMBER_ROWS, env.TERM, env.SHELL]).toEqual(["100", "30", "xterm-256color", "/bin/sh"]);
    expect(env.SSH_CONNECTION).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(h.stamps.has("0123456789abcdef")).toBe(true);
    expect(h.watched.get(1)).toMatchObject({ runId: "0123456789abcdef", pgid: 4321 });
  });

  it("starts the shell in the task's folder as the PC named it, over the SSH login's PWD, so its `cd ..` goes where the PC judged", () => {
    // A shell keeps an inherited PWD only when it names its folder; the login's (the home folder) doesn't, and the shell
    // would start from the real path of a folder reached through a link (§3.6, L25).
    for (const pty of [true, false]) {
      const h = harness({ baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/deploy", PWD: "/home/deploy" } });
      h.runs.start(spec({ cwd: "/home/deploy/link" }), 7, facts(pty));
      expect(h.spawned[0].options.env!.PWD, String(pty)).toBe("/home/deploy/link");
    }
  });

  it("sends its raw output on its channel and ends with its exit code; the stamp and the watch go", () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(true));
    const c = h.spawned[0].child;
    c.out(`${START}building\r\n`);
    c.out("ok\r\n");
    c.close(0);
    expect(h.sent).toEqual([{ channel: 7, bytes: `${START}building\r\n` }, { channel: 7, bytes: "ok\r\n" }]);
    expect(h.exits).toEqual([{ runId: "0123456789abcdef", exit: { code: 0, signal: null, ended: "exit", ms: 0 }, outBytes: START.length + 14 }]);
    expect(h.stamps.size).toBe(0);
    expect(h.watched.size).toBe(0);
    expect(h.runs.running).toBe(0);
    expect(h.runs.knows("0123456789abcdef")).toBe(true);
  });

  it("finds the start marker split across chunks", () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(true));
    const c = h.spawned[0].child;
    c.out(START.slice(0, 6));
    c.out(START.slice(6));
    c.close(3);
    expect(h.exits[0].exit).toMatchObject({ code: 3, ended: "exit" });
  });

  it("ends failed-to-start, with stderr as the reason (one plain line, at most 500 characters), when the marker never came", () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(false));
    const c = h.spawned[0].child;
    c.err(`bash: line 1: cd: \x1b[31mno such\x1b[0m folder\n${"x".repeat(900)}`);
    c.close(1);
    const exit = h.exits[0].exit;
    expect(exit.ended).toBe("failed-to-start");
    expect(exit.error!.startsWith("bash: line 1: cd: no such folder x")).toBe(true);
    expect(exit.error!.length).toBe(500);
  });

  it("fails to start, without spawning, when the shell isn't there", () => {
    const h = harness();
    h.runs.start(spec({ shell: "zsh" }), 7, facts(true));
    expect(h.spawned).toEqual([]);
    expect(h.exits[0].exit).toMatchObject({ ended: "failed-to-start", error: "zsh isn't available here." });
  });

  it("passes the user's typing to the PTY only, and none once the run ended", () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(true));
    expect(h.runs.input("0123456789abcdef", Buffer.from("secret\r"))).toBe(true);
    expect(h.spawned[0].child.typed).toEqual(["secret\r"]);
    h.spawned[0].child.close(0);
    expect(h.runs.input("0123456789abcdef", Buffer.from("x"))).toBe(false);
    const p = harness();
    p.runs.start(spec(), 7, facts(false));
    expect(p.runs.input("0123456789abcdef", Buffer.from("x"))).toBe(false);
  });

  it("stops with ^C at once, then SIGTERM to the group, the session and the sweep at 300 ms, SIGKILL at 1 s and a last sweep at 1.5 s", async () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(true));
    await vi.advanceTimersByTimeAsync(700); // script's session is known by now
    vi.setSystemTime(1000);
    h.runs.stop("0123456789abcdef", "user");
    expect(h.spawned[0].child.typed).toEqual(["\x03"]);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.log).toEqual([
      "1300 kill -4321 SIGTERM", "1300 session 777 TERM", "1300 sweep 0123456789abcdef TERM",
      "2000 kill -4321 SIGKILL", "2000 session 777 KILL", "2000 sweep 0123456789abcdef KILL", "2000 kill 4321 SIGKILL",
      "2500 sweep 0123456789abcdef KILL",
    ]);
    expect(h.watched.get(1)?.sid).toBe(777);
    h.spawned[0].child.close(null, "SIGKILL");
    expect(h.exits[0].exit).toMatchObject({ code: null, signal: "SIGKILL", ended: "stopped-user" });
  });

  it("stops a pipe run with SIGINT to its group first", async () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(false));
    h.runs.stop("0123456789abcdef", "task");
    expect(h.log).toEqual(["0 kill -4321 SIGINT"]);
    await vi.advanceTimersByTimeAsync(1500);
    h.spawned[0].child.close(130);
    expect(h.exits[0].exit.ended).toBe("stopped-task");
  });

  it("starts at SIGTERM when nobody is watching (EOF, the grace) and kills at 300 ms", async () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(true));
    await vi.advanceTimersByTimeAsync(700);
    vi.setSystemTime(1000);
    await h.runs.stopAll("lost", false);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.spawned[0].child.typed).toEqual([]);
    expect(h.log).toEqual([
      "1000 kill -4321 SIGTERM", "1000 session 777 TERM", "1000 sweep 0123456789abcdef TERM",
      "1300 kill -4321 SIGKILL", "1300 session 777 KILL", "1300 sweep 0123456789abcdef KILL", "1300 kill 4321 SIGKILL",
      "2500 sweep 0123456789abcdef KILL",
    ]);
    h.spawned[0].child.close(null, "SIGKILL");
    expect(h.exits[0].exit.ended).toBe("lost");
    await h.runs.ladders();
  });

  it("stops a run at its timeout", async () => {
    const h = harness();
    h.runs.start(spec({ timeoutMs: 5000 }), 7, facts(true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.spawned[0].child.typed).toEqual(["\x03"]);
    h.spawned[0].child.close(130);
    expect(h.exits[0].exit.ended).toBe("timeout");
  });

  it("pauses every run's output while the link's bulk backlog is high, and lets it flow again once it drains", async () => {
    let queued = 0;
    const h = harness({ backlog: () => queued });
    h.runs.start(spec(), 7, facts(true));
    h.runs.start(spec({ runId: "00000000000000bb" }), 8, facts(true));
    const [a, b] = h.spawned.map(s => s.child);
    a.out(`${START}line\r\n`);
    expect([a.stdout.paused, b.stdout.paused]).toEqual([false, false]);
    queued = BACKLOG.high + 1;
    a.out("x".repeat(64 * 1024));
    expect([a.stdout.paused, a.stderr.paused, b.stdout.paused, b.stderr.paused]).toEqual([true, true, true, true]);
    // A run that starts meanwhile waits too.
    h.runs.start(spec({ runId: "00000000000000cc" }), 9, facts(true));
    expect(h.spawned[2].child.stdout.paused).toBe(true);
    queued = BACKLOG.low + 1;
    await vi.advanceTimersByTimeAsync(BACKLOG.pollMs * 3);
    expect(a.stdout.paused).toBe(true);
    queued = BACKLOG.low;
    await vi.advanceTimersByTimeAsync(BACKLOG.pollMs);
    expect(h.spawned.map(s => s.child.stdout.paused)).toEqual([false, false, false]);
  });

  it("never holds back a run being stopped, and drops the kill switch's runs' queued output (outBytes counts what went)", async () => {
    let queued = BACKLOG.high + 1;
    const dropped: number[] = [];
    const h = harness({ backlog: () => queued, drop: ch => { dropped.push(ch); return 5; } });
    h.runs.start(spec(), 7, facts(true));
    const c = h.spawned[0].child;
    c.out(`${START}0123456789`);
    expect(c.stdout.paused).toBe(true);
    h.runs.stop("0123456789abcdef", "user");
    expect(c.stdout.paused).toBe(false);
    expect(dropped).toEqual([]);
    void h.runs.stopAll("killswitch", true);
    expect(dropped).toEqual([7]);
    c.out("after the kill switch");
    expect(h.sent.map(x => x.bytes).join("")).toBe(`${START}0123456789`);
    c.close(130);
    expect(h.exits[0].outBytes).toBe(START.length + 10 - 5);
    queued = 0;
    await h.runs.ladders();
  });

  it("drops what a stopped run prints past the cap (one that ignores ^C and SIGTERM until SIGKILL), sending nothing after", async () => {
    let queued = 0;
    const h = harness({ backlog: () => queued, drop: () => 0 });
    h.runs.start(spec(), 7, facts(true));
    const c = h.spawned[0].child;
    c.out(`${START}before`);
    h.runs.stop("0123456789abcdef", "user");
    c.out(" stopping");
    queued = BACKLOG.high + 1;
    for (let i = 0; i < 10; i++) c.out("y\n".repeat(32 * 1024));
    // It still flows (its end must be seen), but nothing past the cap is queued, nor once the queue drains.
    expect(c.stdout.paused).toBe(false);
    queued = 0;
    c.out("tail");
    expect(h.sent.map(x => x.bytes).join("")).toBe(`${START}before stopping`);
    c.close(130);
    expect(h.exits[0].outBytes).toBe(`${START}before stopping`.length);
    await h.runs.ladders();
  });

  it("refuses a run id used before", () => {
    const h = harness();
    h.runs.start(spec(), 7, facts(true));
    expect(() => h.runs.start(spec(), 8, facts(true))).toThrow(/used already/);
  });
});

describe("startError", () => {
  it("keeps one plain line", () => {
    expect(startError("\x1b]777;x\x07a\tb\n\nc ", "fallback")).toBe("a b c");
    expect(startError("", "fallback")).toBe("fallback");
  });
});
