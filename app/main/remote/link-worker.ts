/**
 * The link worker thread (§5.1.12; owned by package SA): owns one connection's ssh child from spawn to exit, the
 * bootstrap's I/O (bootstrap.ts), then the framed stream (MX's mux), the pings, "stalled" and "lost", and Stop's
 * escalation, off Electron's main thread, so a stall there (the desk's Atomics.wait, up to 5 s) never starves the pings
 * or trips the remote's dead-man (X9). It checks every message from the remote against the protocol's strict schemas
 * (§7.2: a result for a request it forwarded, an event by name; a request from the remote is a protocol error) before
 * the main thread sees it, and never logs a payload. Built to dist/app/remote-link.cjs; plain Node.
 *
 * The core (runLinkCore) takes its process, mux and port by injection so unit tests drive it without a thread.
 */

import { spawn as spawnChild } from "node:child_process";
import { createReadStream } from "node:fs";
import { PassThrough } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import type { Logger } from "../logger";
import { runBootstrap, type Decision } from "./bootstrap";
import { createMux } from "./mux";
import { CAPS, ERR_CODES, EV_SCHEMAS, OP_SCHEMAS, type EvName, type Msg, type Op } from "./protocol";
import type { Mux } from "./types";
import type { FromWorker, ToWorker, WorkerDecision } from "./link";

/** The most of ssh's stderr kept (its tail), for classifying a failure; never logged. */
export const STDERR_MAX = 16 * 1024;

/** The child process the core drives (node's ChildProcess, or a fake). */
export interface ChildLike {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream & { end(): unknown; destroyed?: boolean };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(ev: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(ev: "error", fn: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** What the core needs from the process it runs in. */
export interface CoreDeps {
  spawn(program: string, args: readonly string[], o: { env: Record<string, string>; detached: boolean; windowsHide: boolean }): ChildLike;
  createMux(o: { read: NodeJS.ReadableStream; write: NodeJS.WritableStream; role: "pc"; partsId: string; log: Logger }): Mux;
  openArchive(path: string): AsyncIterable<Uint8Array>;
  /** Kills ssh and what it started (POSIX: its process group, `detached`; Windows: the job host's job). */
  kill(child: ChildLike, detached: boolean): void;
}

/** The core's side of the channel to the main thread. */
export interface WorkerPort {
  post(m: FromWorker, transfer?: ArrayBuffer[]): void;
  on(fn: (m: ToWorker) => void): void;
}

/** A deadline that a prompt the user is answering pauses (§5.1.5). */
export class Deadline {
  private timer: NodeJS.Timeout | null = null;
  private left: number;
  private since = 0;
  private done = false;

  constructor(ms: number, private readonly fire: () => void, private readonly now: () => number = () => Date.now()) {
    this.left = ms;
    this.resume();
  }

  pause(): void {
    if (this.done || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.left = Math.max(0, this.left - (this.now() - this.since));
  }

  resume(): void {
    if (this.done || this.timer) return;
    this.since = this.now();
    this.timer = setTimeout(() => { this.done = true; this.timer = null; this.fire(); }, this.left);
  }

  cancel(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A Logger whose lines go to the main thread as kinds and sizes only (the mux logs no payloads). */
function workerLogger(port: WorkerPort): Logger {
  const line = (level: "debug" | "info" | "warn" | "error") => (event: string, fields?: Record<string, unknown>) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (typeof v === "number" || typeof v === "boolean") safe[k] = v;
      else if (typeof v === "string") safe[k] = v.slice(0, 100);
    }
    port.post({ t: "log", level, event: String(event).slice(0, 80), fields: safe });
  };
  const log: Logger = { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error"), child: () => log, file: "" };
  return log;
}

/** The escalation deadline (§5.1.11): min(10 s, max(1 s, 3 × idle RTT + bytes in flight ÷ throughput)). */
export function escalationMs(rttMs: number, inFlight: { bytes: number; throughput: number }): number {
  // Bytes in flight with no throughput measured yet can't be timed: the cap applies.
  const transfer = inFlight.bytes <= 0 ? 0 : inFlight.throughput > 0 ? (inFlight.bytes / inFlight.throughput) * 1000 : Infinity;
  const ms = 3 * (Number.isFinite(rttMs) ? Math.max(0, rttMs) : 0) + (Number.isFinite(transfer) ? transfer : 10_000);
  return Math.min(10_000, Math.max(1_000, ms));
}

/** Is `msg` a well-formed result or event for this link (§7.2)? The checked message, or null. */
export function checkIncoming(msg: Msg, pending: ReadonlyMap<number, Op>): Msg | null {
  if (!msg || typeof msg !== "object") return null;
  if (msg.t === "res") {
    const op = pending.get(msg.id);
    if (!op) return null;
    if (msg.ok === true) {
      const r = OP_SCHEMAS[op].result.safeParse(msg.v);
      return r.success ? { t: "res", id: msg.id, ok: true, v: r.data } : null;
    }
    if (msg.ok === false && msg.e && (ERR_CODES as readonly string[]).includes(msg.e.code) && typeof msg.e.m === "string" && msg.e.m.length <= CAPS.str.reason) {
      return { t: "res", id: msg.id, ok: false, e: { code: msg.e.code, m: msg.e.m } };
    }
    return null;
  }
  if (msg.t === "ev") {
    const schema = (EV_SCHEMAS as Record<string, (typeof EV_SCHEMAS)[EvName] | undefined>)[msg.ev];
    if (!schema) return null;
    const r = schema.safeParse(msg.d);
    return r.success ? { t: "ev", ev: msg.ev, d: r.data } : null;
  }
  // The agent never sends a request (§5.4): anything else is a protocol error.
  return null;
}

/** Runs one connection: spawn, bootstrap, serve. Returns when the port's owner has what it needs (the thread stays). */
export function runLinkCore(port: WorkerPort, deps: CoreDeps): void {
  const log = workerLogger(port);
  let child: ChildLike | null = null;
  let detached = false;
  let mux: Mux | null = null;
  let state: "starting" | "ready" | "stalled" | "lost" | "closed" = "starting";
  let stderr = "";
  let killedWhy: string | null = null;
  let deadline: Deadline | null = null;
  let probeTimer: NodeJS.Timeout | null = null;
  let tick: NodeJS.Timeout | null = null;
  let graceMs = 20_000;
  let stallMs = 5_000;
  let decide: ((d: WorkerDecision) => void) | null = null;
  const pending = new Map<number, Op>();
  const stops = new Map<number, NodeJS.Timeout>();
  let exited = false;

  const kill = (why: string) => {
    if (!child || exited) return;
    killedWhy ??= why;
    try { deps.kill(child, detached); } catch { /* gone already */ }
  };

  const setState = (s: "ready" | "stalled" | "lost" | "closed", why?: string) => {
    if (state === s || state === "lost" || state === "closed") return;
    state = s;
    port.post({ t: "state", state: s, ...(why ? { why } : {}) });
    if (s === "lost" || s === "closed") {
      if (tick) clearInterval(tick);
      tick = null;
      for (const t of stops.values()) clearTimeout(t);
      stops.clear();
    }
  };

  const lost = (why: string) => {
    if (state === "lost" || state === "closed") return;
    setState("lost", why);
    kill(why);
  };

  const startServing = (rest: Buffer, partsId: string) => {
    const read = new PassThrough();
    read.write(rest);
    (child as ChildLike).stdout.pipe(read);
    try {
      mux = deps.createMux({ read, write: (child as ChildLike).stdin, role: "pc", partsId, log });
    } catch {
      lost("framing");
      return;
    }
    const m = mux;
    m.onMessage(raw => {
      const msg = checkIncoming(raw, pending);
      if (!msg) {
        log.warn("remote.protocol_error", { t: String((raw as { t?: unknown })?.t ?? "?") });
        try { m.reset(1, "protocol"); } catch { /* closing anyway */ }
        lost("protocol");
        return;
      }
      if (msg.t === "res") {
        pending.delete(msg.id);
        const t = stops.get(msg.id);
        if (t) { clearTimeout(t); stops.delete(msg.id); }
      }
      port.post({ t: "msg", msg });
    });
    m.onBytes((channel, bytes) => {
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      port.post({ t: "bytes", channel, bytes: copy.buffer }, [copy.buffer]);
    });
    m.onClose(why => lost(`closed: ${String(why).slice(0, 60)}`));
    state = "ready";
    let lastRtt = -1;
    tick = setInterval(() => {
      if (state !== "ready" && state !== "stalled") return;
      try { m.ping(); } catch { /* the mux is closing: onClose says so */ }
      const silent = m.silentMs();
      if (silent >= graceMs) return lost("silent");
      if (state === "ready" && silent >= stallMs) setState("stalled");
      else if (state === "stalled" && silent < stallMs) setState("ready");
      if (m.rttMs !== lastRtt) { lastRtt = m.rttMs; port.post({ t: "rtt", rttMs: m.rttMs }); }
    }, 500);
  };

  const start = (msg: Extract<ToWorker, { t: "start" }>) => {
    detached = msg.spawn.detached;
    graceMs = msg.graceMs;
    stallMs = msg.stallMs;
    try {
      child = deps.spawn(msg.argv[0], msg.argv.slice(1), { env: msg.env, detached: msg.spawn.detached, windowsHide: msg.spawn.windowsHide });
    } catch (err) {
      port.post({ t: "outcome", outcome: { kind: "eof", probeBegan: false } });
      port.post({ t: "exit", code: null, signal: null, stderr: String((err as Error)?.message ?? err).slice(0, 200), spawnFailed: true });
      return;
    }
    const c = child;
    port.post({ t: "spawned", pid: c.pid ?? null });
    c.stderr.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : d.toString("utf8");
      if (stderr.length > STDERR_MAX * 2) stderr = stderr.slice(-STDERR_MAX);
    });
    let exitInfo: { code: number | null; signal: string | null } | null = null;
    const exitWaiters: (() => void)[] = [];
    const onExit = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      exitInfo = { code, signal };
      deadline?.cancel();
      if (probeTimer) clearTimeout(probeTimer);
      if (state === "ready" || state === "stalled") lost("ssh exited");
      for (const w of exitWaiters.splice(0)) w();
    };
    c.on("exit", onExit);
    c.on("error", () => onExit(null, null));
    const afterExit = () => new Promise<void>(resolve => (exited ? resolve() : exitWaiters.push(resolve)));
    const reportExit = async () => {
      await afterExit();
      // Let stderr's last bytes arrive.
      await new Promise(r => setTimeout(r, 20));
      const info = exitInfo ?? { code: null, signal: null };
      port.post({ t: "exit", code: info.code, signal: info.signal, stderr: stderr.slice(-STDERR_MAX), ...(killedWhy ? { killed: killedWhy } : {}) });
    };
    deadline = new Deadline(msg.deadlineMs, () => { port.post({ t: "deadline" }); kill("deadline"); });
    void runBootstrap({ stdin: c.stdin, stdout: c.stdout }, {
      script: msg.script,
      onProbeBegin: () => {
        deadline?.cancel();
        port.post({ t: "probe-begin" });
        probeTimer = setTimeout(() => { port.post({ t: "deadline" }); kill("probe"); }, msg.probeMs);
      },
      decide: probe => {
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = null;
        port.post({ t: "probe", probe });
        return new Promise<Decision>(resolve => {
          decide = d => {
            decide = null;
            if (d.kind === "install") {
              resolve({ kind: "install", line: d.line, archives: d.archives.map(a => ({ name: a.name, bytes: a.bytes, open: () => deps.openArchive(a.path) })) });
            } else if (d.kind === "serve") {
              resolve({ kind: "serve", line: d.line });
            } else {
              resolve(d);
            }
          };
        });
      },
      progress: (done, total) => port.post({ t: "progress", done, total }),
    }).then(outcome => {
      deadline?.cancel();
      if (outcome.kind === "serving") {
        port.post({ t: "outcome", outcome: { kind: "serving" } });
        startServing(outcome.rest, partsId);
        void reportExit();
        return;
      }
      port.post({
        t: "outcome",
        outcome: outcome.kind === "done" ? { kind: "done", uninstalled: outcome.uninstalled }
          : outcome.kind === "error" ? { kind: "error", code: outcome.code, ...(outcome.detail ? { detail: outcome.detail } : {}), probeBegan: outcome.probeBegan }
          : { kind: "eof", probeBegan: outcome.probeBegan },
      });
      // The script ends by itself; ssh with it. A stuck one is ended.
      try { c.stdin.end(); } catch { /* closed already */ }
      const stuck = setTimeout(() => kill("ended"), 5_000);
      void afterExit().then(() => clearTimeout(stuck));
      void reportExit();
    }, () => {
      kill("bootstrap");
      void reportExit();
    });
  };

  let partsId = "";

  port.on(msg => {
    switch (msg.t) {
      case "start":
        if (!child) start(msg);
        return;
      case "pause":
        deadline?.pause();
        return;
      case "resume":
        deadline?.resume();
        return;
      case "decision":
        if (msg.decision.kind === "serve" || msg.decision.kind === "install") partsId = msg.decision.partsId;
        decide?.(msg.decision);
        return;
      case "grace":
        graceMs = Math.min(120_000, Math.max(3_000, msg.ms));
        return;
      case "req":
        if (!mux || (state !== "ready" && state !== "stalled")) {
          port.post({ t: "msg", msg: { t: "res", id: msg.id, ok: false, e: { code: "gone", m: "the link is down" } } });
          return;
        }
        pending.set(msg.id, msg.op);
        mux.send({ t: "req", id: msg.id, op: msg.op, a: msg.a });
        return;
      case "stop": {
        if (!mux || (state !== "ready" && state !== "stalled")) {
          port.post({ t: "stopped", id: msg.id, escalated: false });
          return;
        }
        pending.set(msg.id, "stop");
        // Written at once (ctl goes before any queued data or bulk frame), with the escalation deadline running.
        mux.send({ t: "req", id: msg.id, op: "stop", a: { epoch: msg.epoch } });
        const ms = escalationMs(mux.rttMs, mux.inFlight());
        stops.set(msg.id, setTimeout(() => {
          stops.delete(msg.id);
          port.post({ t: "stopped", id: msg.id, escalated: true });
          lost("stop unanswered");
        }, ms));
        return;
      }
      case "close":
        if (state === "closed") return;
        setState("closed", "closed");
        try { child?.stdin.end(); } catch { /* closed already */ }
        // The agent stops on EOF; ssh exits with it. One that doesn't is ended.
        setTimeout(() => kill("close"), 3_000);
        return;
      case "kill":
        kill(msg.why);
        if (state === "ready" || state === "stalled") setState("lost", msg.why);
        return;
    }
  });
}

/** Kills ssh: on POSIX its whole process group (a ProxyCommand's hop included); on Windows the job host. */
function killChild(child: ChildLike, detached: boolean): void {
  if (detached && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // No group (already gone): the process itself below.
    }
  }
  child.kill("SIGKILL");
}

/** The real dependencies, in the worker thread. */
export function realDeps(): CoreDeps {
  return {
    spawn: (program, args, o) => spawnChild(program, [...args], { env: o.env, detached: o.detached, windowsHide: o.windowsHide, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildLike,
    createMux: o => createMux(o),
    openArchive: p => createReadStream(p, { highWaterMark: 64 * 1024 }),
    kill: killChild,
  };
}

// Only in the worker thread Ember starts (workerData marks it), never when a test imports the module.
if (parentPort && (workerData as { emberLinkWorker?: boolean } | null)?.emberLinkWorker === true) {
  const p = parentPort;
  runLinkCore({ post: (m, transfer) => p.postMessage(m, transfer ?? []), on: fn => { p.on("message", fn); } }, realDeps());
}
