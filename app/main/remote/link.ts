/**
 * The main thread's side of one SSH connection (§5.1.10-§5.1.12): the attempt that drives the link worker through the
 * bootstrap (the probe goes out for Ember's decision, progress comes back, a failure comes back with ssh's exit code
 * and stderr for classifying), and then the RemoteLink the rest of Ember uses: requests with their timeouts and the
 * Stop epoch (nothing older is sent after a Stop), events, bulk bytes, and the link's state ("stalled" at 5 s of
 * silence, "lost" at the grace, both measured in the worker). The worker owns ssh and the mux; this side never touches
 * either, so a stall of Electron's main thread can't stop the pings. Plain Node.
 */

import type { Logger } from "../logger";
import { OP_SCHEMAS, type ErrCode, type EvMap, type EvName, type Msg, type Op, type OpArgs, type OpResult, type Welcome } from "./protocol";
import type { RemoteLink } from "./types";

/** A decision the worker writes after the probe (paths, not bytes: the worker streams the archives itself). */
export type WorkerDecision =
  | { kind: "quit" }
  | { kind: "uninstall" }
  | { kind: "serve"; line: string; partsId: string }
  | { kind: "install"; line: string; partsId: string; archives: { name: "runtime" | "parts"; bytes: number; path: string }[] };

/** Main → worker. */
export type ToWorker =
  | {
    t: "start"; argv: string[]; env: Record<string, string>; spawn: { detached: boolean; windowsHide: boolean };
    script: string; deadlineMs: number; probeMs: number; stallMs: number; graceMs: number;
  }
  | { t: "pause" }
  | { t: "resume" }
  | { t: "decision"; decision: WorkerDecision }
  | { t: "req"; id: number; op: Op; a: unknown }
  | { t: "stop"; id: number; epoch: number }
  | { t: "grace"; ms: number }
  | { t: "close" }
  | { t: "kill"; why: string };

/** How the bootstrap ended, as the worker reports it. */
export type WorkerOutcome =
  | { kind: "serving" }
  | { kind: "done"; uninstalled: boolean }
  | { kind: "error"; code: string; detail?: string; probeBegan: boolean }
  | { kind: "eof"; probeBegan: boolean };

/** Worker → main. */
export type FromWorker =
  | { t: "spawned"; pid: number | null }
  | { t: "probe-begin" }
  | { t: "probe"; probe: Record<string, string> }
  | { t: "progress"; done: number; total: number }
  | { t: "deadline" }
  | { t: "outcome"; outcome: WorkerOutcome }
  | { t: "exit"; code: number | null; signal: string | null; stderr: string; killed?: string; spawnFailed?: boolean }
  | { t: "msg"; msg: Msg }
  | { t: "bytes"; channel: number; bytes: ArrayBuffer }
  | { t: "state"; state: "ready" | "stalled" | "lost" | "closed"; why?: string }
  | { t: "rtt"; rttMs: number }
  | { t: "stopped"; id: number; escalated: boolean }
  | { t: "log"; level: "debug" | "info" | "warn" | "error"; event: string; fields: Record<string, unknown> };

/** The main thread's handle on a worker (a worker_threads Worker, or an in-process core in tests). */
export interface LinkPort {
  post(m: ToWorker): void;
  onMessage(fn: (m: FromWorker) => void): () => void;
  /** The thread ended (crashed or terminated). */
  onExit(fn: (why: string) => void): () => void;
  terminate(): Promise<void>;
}

/** A remote's refusal or a failed request: `code` is the protocol's ErrCode, or "timeout"/"gone" from this side. */
export class RemoteError extends Error {
  constructor(readonly code: ErrCode | "timeout", message: string) { super(message); }
}

/** The PC-side timeout of each op (§5.4), before RTT is added where the design says "+ RTT". */
export function opTimeout(op: Op): { ms: number; plusRtt: boolean } {
  if (op === "hello") return { ms: 20_000, plusRtt: false };
  if (op === "apps.list") return { ms: 10_000, plusRtt: false };
  if (op === "cmd.facts" || op === "cmd.inspect" || op === "cmd.git" || op === "cmd.run") return { ms: 5_000, plusRtt: true };
  return { ms: 10_000, plusRtt: true };
}

/** Ops a stalled link doesn't send (§5.1.11: no new step or command while the remote is silent). */
const STEPS: ReadonlySet<Op> = new Set<Op>(["act", "apps.launch", "cmd.run", "cmd.input"]);

/** One live link: the RemoteLink of §5.1, over the worker. */
export class WorkerLink implements RemoteLink {
  readonly id: string;
  readonly hostId: string;
  welcome: Welcome = undefined as unknown as Welcome;
  private st: "ready" | "stalled" | "lost" | "closed" = "ready";
  private ep = 0;
  private rtt = 0;
  private seq = 0;
  private readonly pending = new Map<number, { op: Op; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null; abort?: () => void }>();
  private readonly stopping = new Map<number, { started: number; resolve: (r: { ms: number; escalated: boolean }) => void }>();
  private readonly evs = new Map<string, Set<(d: unknown) => void>>();
  private readonly bytes = new Map<number, Set<(b: Uint8Array) => void>>();
  private readonly states = new Set<(s: "ready" | "stalled" | "lost" | "closed", why?: string) => void>();
  private readonly off: (() => void)[] = [];
  private sshGone: () => void = () => undefined;
  /** Resolves when ssh has exited (the worker said so) or the worker is gone. */
  private readonly exited = new Promise<void>(resolve => { this.sshGone = resolve; });

  constructor(private readonly port: LinkPort, o: { id: string; hostId: string; log?: Logger; now?: () => number }) {
    this.id = o.id;
    this.hostId = o.hostId;
    this.log = o.log;
    this.now = o.now ?? (() => performance.now());
    this.off.push(port.onMessage(m => this.onWorker(m)));
    this.off.push(port.onExit(why => { this.sshGone(); this.setState("lost", `worker: ${why}`); }));
  }

  private readonly log?: Logger;
  private readonly now: () => number;

  get state(): "ready" | "stalled" | "lost" | "closed" { return this.st; }
  get epoch(): number { return this.ep; }
  get rttMs(): number { return this.rtt; }

  /** The agent's answer to `hello`, kept once the link is up (connections.ts sets it after its checks). */
  setWelcome(w: Welcome): void { this.welcome = w; }

  private onWorker(m: FromWorker): void {
    switch (m.t) {
      case "msg": {
        const msg = m.msg;
        if (msg.t === "res") {
          const stop = this.stopping.get(msg.id);
          if (stop) {
            this.stopping.delete(msg.id);
            stop.resolve({ ms: Math.round(this.now() - stop.started), escalated: false });
            return;
          }
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (p.timer) clearTimeout(p.timer);
          p.abort?.();
          if (msg.ok) p.resolve(msg.v);
          else p.reject(new RemoteError(msg.e.code, msg.e.m));
        } else if (msg.t === "ev") {
          for (const fn of this.evs.get(msg.ev) ?? []) {
            try { fn(msg.d); } catch (err) { this.log?.warn("remote.listener_failed", { ev: msg.ev, err }); }
          }
        }
        return;
      }
      case "bytes":
        for (const fn of this.bytes.get(m.channel) ?? []) {
          try { fn(new Uint8Array(m.bytes)); } catch (err) { this.log?.warn("remote.listener_failed", { channel: m.channel, err }); }
        }
        return;
      case "state":
        this.setState(m.state, m.why);
        return;
      case "rtt":
        this.rtt = m.rttMs;
        return;
      case "stopped": {
        const stop = this.stopping.get(m.id);
        if (!stop) return;
        this.stopping.delete(m.id);
        stop.resolve({ ms: Math.round(this.now() - stop.started), escalated: m.escalated });
        return;
      }
      case "log":
        this.log?.[m.level]?.(m.event, m.fields);
        return;
      case "exit":
        this.sshGone();
        return;
      default:
        return;
    }
  }

  /** The command grace the agent applies (welcome.graceSeconds): the worker calls the link lost after it (§5.1.11). */
  setGrace(seconds: number): void {
    try { this.port.post({ t: "grace", ms: Math.min(120, Math.max(3, seconds)) * 1000 }); } catch { /* the worker is gone */ }
  }

  private setState(s: "ready" | "stalled" | "lost" | "closed", why?: string): void {
    if (this.st === s || this.st === "lost" || this.st === "closed") return;
    this.st = s;
    if (s === "lost" || s === "closed") {
      for (const [id, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.abort?.();
        p.reject(new RemoteError("gone", s === "lost" ? "the link was lost" : "the link was closed"));
        this.pending.delete(id);
      }
      for (const [id, st] of this.stopping) {
        this.stopping.delete(id);
        st.resolve({ ms: Math.round(this.now() - st.started), escalated: false });
      }
    }
    for (const fn of this.states) {
      try { fn(s, why); } catch (err) { this.log?.warn("remote.listener_failed", { state: s, err }); }
    }
  }

  request<O extends Op>(op: O, args: OpArgs<O>, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OpResult<O>> {
    if (this.st === "lost" || this.st === "closed") return Promise.reject(new RemoteError("gone", "the link is down"));
    if (this.st === "stalled" && STEPS.has(op)) return Promise.reject(new RemoteError("stale", "the remote isn't answering"));
    const epoch = (args as { epoch?: unknown }).epoch;
    // Epoch fencing (§5.1.11): nothing from before a Stop is sent after it.
    if (typeof epoch === "number" && epoch < this.ep) return Promise.reject(new RemoteError("stopped", "stopped"));
    if (op === "stop") return Promise.reject(new RemoteError("bad_request", "use stop()"));
    // Ember's own requests are checked too: a bug here must not reach the remote.
    const parsed = OP_SCHEMAS[op].args.safeParse(args);
    if (!parsed.success) return Promise.reject(new RemoteError("bad_request", `bad arguments for ${op}`));
    if (o.signal?.aborted) return Promise.reject(new RemoteError("stopped", "cancelled"));
    const id = ++this.seq;
    return new Promise<OpResult<O>>((resolve, reject) => {
      const t = opTimeout(op);
      const ms = o.timeoutMs ?? t.ms + (t.plusRtt ? this.rtt : 0);
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new RemoteError("timeout", `${op} took too long`));
      }, ms);
      let abort: (() => void) | undefined;
      if (o.signal) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(new RemoteError("stopped", "cancelled"));
        };
        o.signal.addEventListener("abort", onAbort, { once: true });
        abort = () => o.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, { op, resolve: v => resolve(v as OpResult<O>), reject, timer, abort });
      this.port.post({ t: "req", id, op, a: parsed.data });
    });
  }

  on<E extends EvName>(ev: E, fn: (d: EvMap[E]) => void): () => void {
    const set = this.evs.get(ev) ?? new Set();
    this.evs.set(ev, set);
    const f = fn as (d: unknown) => void;
    set.add(f);
    return () => { set.delete(f); };
  }

  onBytes(channel: number, fn: (b: Uint8Array) => void): () => void {
    const set = this.bytes.get(channel) ?? new Set();
    this.bytes.set(channel, set);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.bytes.delete(channel);
    };
  }

  /** §5.1.11: the epoch at once (nothing older is sent after), the stop frame, the worker's escalation. Never throws. */
  stop(): Promise<{ ms: number; escalated: boolean }> {
    this.ep++;
    if (this.st === "lost" || this.st === "closed") return Promise.resolve({ ms: 0, escalated: false });
    const id = ++this.seq;
    const started = this.now();
    return new Promise(resolve => {
      this.stopping.set(id, { started, resolve });
      try {
        this.port.post({ t: "stop", id, epoch: this.ep });
      } catch {
        this.stopping.delete(id);
        resolve({ ms: 0, escalated: false });
      }
    });
  }

  onState(fn: (s: "ready" | "stalled" | "lost" | "closed", why?: string) => void): () => void {
    this.states.add(fn);
    return () => { this.states.delete(fn); };
  }

  /** Says goodbye (bye, briefly), ends ssh's stdin (the agent stops on EOF), waits for ssh to go and ends the worker. */
  async close(why: string): Promise<void> {
    if (this.st === "closed") return;
    if (this.st === "ready") await this.request("bye", {}, { timeoutMs: 2_000 }).catch(() => undefined);
    this.setState("closed", why);
    try { this.port.post({ t: "close" }); } catch { /* the worker is gone */ }
    // The worker ends ssh within 3 s of the close (EOF first, then a kill); the worker itself goes after it.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>(r => { timer = setTimeout(r, 4_000); })]);
    if (timer) clearTimeout(timer);
    for (const f of this.off.splice(0)) f();
    await this.port.terminate().catch(() => undefined);
  }

  /** Ends the link at once (the kill switch's last resort, Disconnect after close): ssh killed, the worker ended. */
  async kill(why: string): Promise<void> {
    try { this.port.post({ t: "kill", why }); } catch { /* gone */ }
    this.setState("lost", why);
    for (const f of this.off.splice(0)) f();
    this.sshGone();
    await this.port.terminate().catch(() => undefined);
  }
}

/** How an attempt ended. */
export type AttemptResult =
  /** The agent runs; `link` is ready for `hello`. */
  | { kind: "serving"; probe: Record<string, string> }
  /** QUIT after a refusal Ember decided (the decide hook's reason), or an UNINSTALL that finished. */
  | { kind: "done"; uninstalled: boolean }
  /** Anything else: the script's error, ssh's exit (code, stderr), a deadline, a cancel. */
  | { kind: "failed"; probeBegan: boolean; error?: { code: string; detail?: string }; exit: { code: number | null; signal: string | null; stderr: string } | null; deadline: boolean; cancelled: boolean; spawnFailed: boolean };

/**
 * Runs one attempt on a fresh worker: start, answer the probe with `decide`, report progress, and return how the
 * bootstrap ended. Prompts pause the 45 s deadline through `pause`/`resume` on the returned control. On "serving" the
 * port stays open for the WorkerLink; otherwise the caller terminates it.
 */
export function runAttempt(port: LinkPort, start: Extract<ToWorker, { t: "start" }>, o: {
  decide: (probe: Record<string, string>) => Promise<WorkerDecision>;
  progress?: (p: { step: "checking" } | { step: "copying"; done: number; total: number }) => void;
  signal?: AbortSignal;
  log?: Logger;
}): { result: Promise<AttemptResult>; pause(): void; resume(): void } {
  let deadline = false;
  let cancelled = false;
  let probe: Record<string, string> = {};
  const result = new Promise<AttemptResult>(resolve => {
    let outcome: WorkerOutcome | null = null;
    let finished = false;
    const finish = (r: AttemptResult) => {
      if (finished) return;
      finished = true;
      offMsg();
      offExit();
      o.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const failed = (exit: Extract<FromWorker, { t: "exit" }> | null): AttemptResult => ({
      kind: "failed",
      probeBegan: outcome?.kind === "error" || outcome?.kind === "eof" ? outcome.probeBegan : false,
      ...(outcome?.kind === "error" ? { error: { code: outcome.code, ...(outcome.detail ? { detail: outcome.detail } : {}) } } : {}),
      exit: exit ? { code: exit.code, signal: exit.signal, stderr: exit.stderr } : null,
      deadline, cancelled, spawnFailed: exit?.spawnFailed === true,
    });
    const onAbort = () => {
      cancelled = true;
      try { port.post({ t: "kill", why: "cancelled" }); } catch { /* gone */ }
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const offExit = port.onExit(() => finish(failed(null)));
    const offMsg = port.onMessage(m => {
      switch (m.t) {
        case "probe":
          probe = m.probe;
          o.progress?.({ step: "checking" });
          o.decide(m.probe).then(d => port.post({ t: "decision", decision: d }), err => {
            o.log?.warn("remote.decide_failed", { err });
            port.post({ t: "decision", decision: { kind: "quit" } });
          });
          return;
        case "progress":
          o.progress?.({ step: "copying", done: m.done, total: m.total });
          return;
        case "deadline":
          deadline = true;
          return;
        case "outcome":
          outcome = m.outcome;
          if (m.outcome.kind === "serving") finish({ kind: "serving", probe });
          else if (m.outcome.kind === "done") finish({ kind: "done", uninstalled: m.outcome.uninstalled });
          return;
        case "exit":
          if (outcome?.kind === "serving") return;
          finish(failed(m));
          return;
        case "log":
          o.log?.[m.level]?.(m.event, m.fields);
          return;
        default:
          return;
      }
    });
    if (o.signal?.aborted) onAbort();
    port.post(start);
  });
  return {
    result,
    pause: () => { try { port.post({ t: "pause" }); } catch { /* gone */ } },
    resume: () => { try { port.post({ t: "resume" }); } catch { /* gone */ } },
  };
}
