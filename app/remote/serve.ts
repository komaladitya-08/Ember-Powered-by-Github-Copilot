/**
 * The agent's protocol server (§5.3, §5.4): the PC's requests over the framed SSH stdio, answered by a closed table of
 * handlers (one per op; anything else is unknown_op), and the agent's events. `hello` comes first and is checked: the
 * PC's id equals the one on the agent's argv, the parts are the same, the user consented on the PC, this computer's
 * policy lets Ember in, and no other PC's agent holds the lock. Every command passes gate 2 (gate.ts) and every desktop
 * step the desktop child's; each is audited first. Liveness (pings, the 1.5 s freshness gate, the 3 s desktop
 * dead-man, the command grace) runs here, and so does the kill switch: `stop` (the PC's), the console's Stop, the
 * policy turning Ember off, EOF, `bye`, the grace and a protocol error each stop commands, in-flight steps and the
 * desktop, and all but `stop` and the console's end the agent. The agent never sends a request, so nothing it says can
 * approve anything on the PC. Plain Node; everything it touches comes in as ServeDeps.
 */

import { KillSwitch } from "../main/agent/killswitch";
import { adminSummary, combineAdmin, commandMode, type AdminSummary } from "../main/admin";
import type { Logger } from "../main/logger";
import type { Classification, GitFacts, PathFact, RunExit, RunnerFacts } from "../main/commands/types";
import { newTaskWrites, noteWrites, type TaskWrites } from "../main/commands/scripts";
import { CAPS, PROTO, type ErrCode, type EvName, type Msg, type Op, type OpArgs, type OpResult, type Welcome } from "../main/remote/protocol";
import type { Mux } from "../main/remote/types";
import { serveRefusal, type PolicyWatch } from "./admin";
import type { RemoteAudit, AuditSource } from "./audit";
import type { RemoteRuns } from "./commands";
import { consentAccepted, type ConsentRecord } from "./consent";
import type { ClassifyCommand } from "./contracts";
import type { DesktopController } from "./desktop";
import type { ChildPolicy } from "./desktop-ipc";
import { IpcError } from "./desktop-ipc";
import { gateCommand, GATE_WORDS } from "./gate";
import { startLiveness, type Liveness } from "./liveness";
import type { LockResult } from "./lock";
import type { AgentOs } from "./places";
import { createHash } from "node:crypto";

/** The grace when neither policy names one (L10). */
const DEFAULT_GRACE_S = 20;
/** After a stop with runs live, the agent exits no sooner than this (the ladder's last sweep must not race it) and no later than EXIT_MAX_MS. */
const EXIT_MIN_MS = 1600;
const EXIT_MAX_MS = 3000;
/**
 * How long after its request arrives a command may still start (§3.16): past it the PC may have stopped waiting for
 * the answer (it waits 15 s and the round trip, remote-sidecar.ts), and a command it was told "wasn't started" must
 * never run. Gate 2's path check alone may take 5 s (gate.ts INSPECT_MS).
 */
export const RUN_START_MAX_MS = 10_000;
/** Run ids whose cmd.stop came before they started, remembered at most (they never start). */
const STOPPED_EARLY_MAX = 256;
/** Tasks whose downloads and writes gate 2 remembers (the most recently used); an older task's commands start afresh. */
export const TASKS_REMEMBERED = 64;
/** Why the agent stopped, for its audit (§5.3.11). */
export type StopSource = "local" | "link-lost" | "console" | "orphan" | "policy";

/** A request refused with a protocol error code. */
export class OpError extends Error {
  constructor(readonly code: ErrCode, message: string) { super(message); }
}

/** Everything serve uses. */
export interface ServeDeps {
  mux: Mux;
  log: Logger;
  /** The PC's id from `--pc` (the bootstrap checked its form). */
  pcId: string;
  partsId: string;
  os: AgentOs;
  arch: "x64" | "arm64";
  machineIdHash: string;
  isWsl: boolean;
  uid: number;
  user: string;
  home: string;
  host: string;
  pid: number;
  /** macOS: commands can't open protected folders (the full-disk-access check failed, L6). */
  tccLimited?: boolean;
  policy: PolicyWatch;
  lock: (pcId: string, graceMs: number) => Promise<LockResult>;
  /** The facts with Ember's live pids (`extraPids`: the desktop child's and its helpers'). */
  facts: () => Promise<RunnerFacts>;
  /**
   * Ember's own paths, pids and names as they are now (D4.5; critique integration-24: read at every classification,
   * since the desktop child comes and goes after the facts were read).
   */
  ember?: () => RunnerFacts["ember"];
  runs: RemoteRuns;
  inspect: (paths: string[], cwd: string) => Promise<PathFact[]>;
  /** A shell script's text from this machine (gate 2 judges what it does, L8); absent: scripts aren't read. */
  readScript?: (path: string, cwd: string) => Promise<string | null>;
  git: (cwd: string) => Promise<GitFacts | null>;
  classify: ClassifyCommand;
  audit: RemoteAudit;
  setAuditSource: (s: AuditSource) => void;
  consent: (rec: ConsentRecord) => void;
  desktop: DesktopController;
  /** The orphan sweep (after a stale agent's lock was taken over). */
  orphans: () => Promise<string[]>;
  /** Deletes versions and runtimes nobody uses any more (§5.2.6), once hello holds the lock; absent: nothing to do. */
  cleanup?: () => Promise<unknown>;
  exit: (code: number) => void;
  now: () => number;
}

/** A closed table: every op has exactly one handler. */
type Handlers = { [O in Op]: (a: OpArgs<O>, id: number) => Promise<OpResult<O>> };

/** The command grace both machines' policies leave (s): the smaller, 20 when neither says. */
export function graceSeconds(local: AdminSummary | null, remote: AdminSummary): number {
  return Math.min(local?.ssh.commandGraceSeconds ?? DEFAULT_GRACE_S, remote.ssh.commandGraceSeconds ?? DEFAULT_GRACE_S);
}

/** The agent's server for one link. */
export class Server {
  private hello: OpArgs<"hello"> | null = null;
  /** A hello is being checked (it waits for the lock): a second one meanwhile is refused, never served twice. */
  private greeting = false;
  private epoch = 0;
  private graceMs = DEFAULT_GRACE_S * 1000;
  private channel = 0;
  private liveness: Liveness | null = null;
  private lock: Extract<LockResult, { ok: true }> | null = null;
  private stopping: Promise<void> | null = null;
  /** Bumped by every pull of the kill switch: a command whose gate was still running then doesn't start. */
  private fence = 0;
  /** Runs the PC stopped before they started (still in gate 2, or their cmd.run not here yet): they never start. */
  private readonly stoppedEarly = new Set<string>();
  private facts: RunnerFacts | null = null;
  /**
   * What each task's commands downloaded and wrote here, by task id, the most recently used last: gate 2 judges a
   * later command with them (running a download is escape; a script of the task's own that can't be read asks).
   */
  private readonly tasks = new Map<string, { downloaded: Set<string>; written: TaskWrites }>();
  private readonly handlers: Handlers;

  constructor(private d: ServeDeps) {
    this.graceMs = graceSeconds(null, d.policy.summary) * 1000;
    this.handlers = {
      "hello": a => this.onHello(a),
      "policy.sync": async a => {
        if (this.hello) this.hello = { ...this.hello, neverLook: a.neverLook, localAdmin: a.localAdmin };
        this.policyChanged();
        return {};
      },
      "desktop.state": async () => this.d.desktop.ensure(this.desktopAsk()),
      "perceive.read": a => this.read("perceive.read", a),
      "perceive.focused": a => this.read("perceive.focused", a),
      "perceive.perceive": a => this.perceive(a),
      "perceive.atPoint": a => this.read("perceive.atPoint", a),
      "perceive.windows": a => this.read("perceive.windows", a),
      "perceive.openWindows": a => this.read("perceive.openWindows", a),
      "perceive.systemDialog": a => this.read("perceive.systemDialog", a),
      "ax.readElement": a => this.read("ax.readElement", a),
      "ax.canDo": a => this.read("ax.canDo", a),
      "ax.listOptions": a => this.read("ax.listOptions", a),
      "act": a => this.step("act", a),
      "apps.list": a => this.read("apps.list", a),
      "apps.launch": a => this.step("apps.launch", a),
      "cmd.facts": async () => this.currentFacts(),
      "cmd.inspect": async a => ({ paths: (await this.d.inspect(a.paths.slice(0, CAPS.paths), a.cwd)).slice(0, CAPS.paths) }),
      "cmd.git": async a => ({ git: await this.d.git(a.cwd) }),
      "cmd.run": a => this.run(a),
      "cmd.input": async a => {
        if (!this.d.runs.knows(a.runId)) throw new OpError("gone", "No such command is running here.");
        // The user's typing: to the PTY only, never logged.
        this.d.runs.input(a.runId, Buffer.from(a.data, "base64"));
        return {};
      },
      "cmd.stop": async a => {
        if (!this.d.runs.knows(a.runId)) {
          // The PC stopped waiting for this run's start (or its cmd.run, a large one on data, is still behind this
          // stop on ctl): it never starts here.
          this.stoppedEarly.add(a.runId);
          if (this.stoppedEarly.size > STOPPED_EARLY_MAX) this.stoppedEarly.delete(this.stoppedEarly.values().next().value as string);
          throw new OpError("gone", "No such command is running here.");
        }
        this.d.runs.stop(a.runId, a.why);
        return {};
      },
      "stop": async a => {
        this.epoch = Math.max(this.epoch, a.epoch);
        return this.killSwitch("local", true);
      },
      "audit.recent": async a => ({ entries: this.d.audit.recent(a.limit) }),
      "bye": async () => {
        setImmediate(() => void this.shutdown("local", true));
        return {};
      },
    };
  }

  /** Starts serving: messages, the link's end, liveness and the policy's re-reads. */
  start(): void {
    const d = this.d;
    d.mux.onMessage(m => this.onMessage(m));
    d.mux.onClose(why => {
      d.log.info("remote.link_closed", { why });
      void this.shutdown("link-lost", false);
    });
    this.liveness = startLiveness({
      silentMs: () => d.mux.silentMs(),
      ping: () => d.mux.ping(),
      graceMs: () => this.graceMs,
      onDeadman: () => {
        d.log.warn("remote.deadman", {});
        // Desktop work and in-flight steps stop; commands keep running until the grace (L10).
        d.desktop.pause();
      },
      onAlive: () => d.log.info("remote.link_alive", {}),
      onGrace: () => {
        d.log.warn("remote.grace_over", {});
        void this.shutdown("link-lost", false);
      },
    });
  }

  private onMessage(m: Msg): void {
    if (m.t !== "req") return; // the mux lets only requests reach the agent
    const { id, op } = m;
    const handler = Object.hasOwn(this.handlers, op) ? (this.handlers as unknown as Record<string, (a: unknown, id: number) => Promise<unknown>>)[op] : null;
    const answer = (v: unknown) => this.send({ t: "res", id, ok: true, v }, id);
    const refuse = (code: ErrCode, why: string) => this.send({ t: "res", id, ok: false, e: { code, m: why.slice(0, CAPS.str.reason) } }, id);
    if (!handler) { refuse("unknown_op", `This helper doesn't know ${op}.`); return; }
    if (this.stopping) { refuse("stopped", "Ember is stopping on this computer."); return; }
    if (!this.hello && op !== "hello") { refuse("not_ready", "Ember hasn't said hello yet."); return; }
    handler(m.a, id).then(answer, (err: unknown) => {
      if (err instanceof OpError || err instanceof IpcError) refuse(err.code, err.message);
      else {
        this.d.log.error("remote.op_failed", { op, err });
        refuse("internal", "Something went wrong on this computer.");
      }
    });
  }

  /** Sends a message; a result the protocol's schema refuses becomes an "internal" error for that request. */
  private send(msg: Msg, id?: number): void {
    try {
      this.d.mux.send(msg);
    } catch (err) {
      this.d.log.error("remote.send_refused", { err: err instanceof Error ? err.message : String(err), t: msg.t });
      if (id !== undefined && !(msg.t === "res" && !msg.ok)) {
        try { this.d.mux.send({ t: "res", id, ok: false, e: { code: "internal", m: "This computer's answer couldn't be sent." } }); } catch { /* the link is gone */ }
      }
    }
  }

  /** Sends an event (never a request). */
  event(ev: EvName, d: unknown): void {
    if (!this.hello || this.stopping) return;
    this.send({ t: "ev", ev, d });
  }

  // -- hello -----------------------------------------------------------------------------------------------------------

  private async onHello(a: OpArgs<"hello">): Promise<Welcome> {
    if (this.hello || this.greeting) throw new OpError("bad_request", "hello was said already.");
    this.greeting = true;
    try {
      return await this.greet(a);
    } finally {
      this.greeting = false;
    }
  }

  private async greet(a: OpArgs<"hello">): Promise<Welcome> {
    const d = this.d;
    if (a.pcId !== d.pcId) throw new OpError("denied", "This helper was started for another computer.");
    if (a.partsId !== d.partsId) throw new OpError("bad_request", "This helper is another version of Ember's.");
    if (!consentAccepted(a.consent)) throw new OpError("denied", `The user hasn't agreed to Ember working on ${d.host}.`);
    d.policy.refresh();
    const refusal = serveRefusal(d.policy.current, d.host);
    if (refusal) {
      d.audit.write({ event: "remote", step: "refused", reason: refusal });
      // The answer goes first; then the agent ends.
      setTimeout(() => void this.shutdown("policy", false), 200);
      throw new OpError("denied", refusal);
    }
    const graceMs = graceSeconds(a.localAdmin, d.policy.summary) * 1000;
    const lock = await d.lock(a.pcId, graceMs);
    if (!lock.ok) throw new OpError("busy", `Ember from another computer is already working on ${d.host}.`);
    this.lock = lock;
    d.setAuditSource({ from: a.local.name, pcId: a.pcId });
    if (lock.tookOver !== null) {
      const runs = await d.orphans();
      if (runs.length) d.audit.write({ event: "stop", source: "orphan", runs });
    }
    this.epoch = a.epoch;
    this.graceMs = graceMs;
    this.hello = a;
    d.consent({ version: a.consent.version, from: a.local.name, pcId: a.pcId, at: a.consent.at, user: d.user });
    d.audit.write({ event: "remote", step: "hello", os: a.local.os, consentVersion: a.consent.version, graceSeconds: graceMs / 1000 });
    // Under the lock now: old versions and runtimes go (asynchronously; a failure only leaves them for next time).
    if (d.cleanup) void d.cleanup().catch(err => d.log.warn("remote.cleanup_failed", { err }));
    const facts = await this.currentFacts();
    const desktop = await d.desktop.preview(this.desktopAllowed());
    return {
      proto: PROTO,
      partsId: d.partsId,
      os: d.os,
      arch: d.arch,
      machineIdHash: d.machineIdHash,
      isWsl: d.isWsl,
      uid: d.uid,
      user: d.user,
      home: d.home,
      facts,
      desktop,
      remoteAdmin: d.policy.summary,
      pid: d.pid,
      ...(d.tccLimited ? { tccLimited: true } : {}),
      graceSeconds: graceMs / 1000,
    };
  }

  private async currentFacts(): Promise<RunnerFacts> {
    this.facts = await this.d.facts();
    return this.facts;
  }

  // -- policies --------------------------------------------------------------------------------------------------------

  /** Both machines' policies combined (the stricter of each). */
  private combined(): AdminSummary {
    const remote = this.d.policy.summary;
    return this.hello ? combineAdmin(this.hello.localAdmin, remote) : remote;
  }

  private desktopAllowed(): boolean {
    const c = this.combined();
    return c.ssh.desktop !== false && c.features.ssh !== false && !this.d.policy.current.error;
  }

  /** What the desktop child is told: both never-look lists, the stricter of both machines' rules. */
  private childPolicy(): ChildPolicy {
    const c = this.combined();
    const seen = new Set<string>();
    const neverLook = [...(this.hello?.neverLook ?? []), ...c.neverLook].filter(n => {
      const k = n.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      neverLook,
      actionsAllowed: c.features.actions !== false,
      confirmEveryAction: c.confirmEveryAction,
      ...(c.maxActionsPerMinute !== undefined ? { maxActionsPerMinute: c.maxActionsPerMinute } : {}),
      screenImages: c.features.screenImages !== false,
    };
  }

  private desktopAsk() {
    // Console consent when either machine's administrator asks for it (combineAdmin ORs it, §9.1).
    return { pc: this.hello?.local.name ?? "", allowed: this.desktopAllowed(), consent: this.combined().ssh.requireConsoleConsent === true, policy: this.childPolicy() };
  }

  /** The remote policy changed (read every 10 s) or the PC's did (policy.sync). */
  policyChanged(): void {
    const d = this.d;
    this.graceMs = graceSeconds(this.hello?.localAdmin ?? null, d.policy.summary) * 1000;
    const refusal = serveRefusal(d.policy.current, d.host);
    if (refusal) {
      d.log.warn("remote.policy_refuses", {});
      void this.shutdown("policy", true);
      return;
    }
    if (!this.desktopAllowed()) d.desktop.stop();
    else d.desktop.policy(this.childPolicy());
  }

  /** PolicyWatch's change callback: the PC hears the remote's new summary first. */
  onRemotePolicy(): void {
    this.event("policy.changed", adminSummary(this.d.policy.current));
    this.policyChanged();
  }

  // -- desktop ---------------------------------------------------------------------------------------------------------

  private async read<O extends Op>(op: O, a: OpArgs<O>): Promise<OpResult<O>> {
    const v = await this.d.desktop.request(op, a);
    return v as OpResult<O>;
  }

  private async perceive(a: OpArgs<"perceive.perceive">): Promise<OpResult<"perceive.perceive">> {
    const v = await this.d.desktop.request("perceive.perceive", a) as { seen: OpResult<"perceive.perceive">["seen"]; image: { png: string; width: number; height: number; rect: { x: number; y: number; width: number; height: number }; scale: number } | null; noShot?: string };
    if (!v.image) return { seen: v.seen, image: null, ...(v.noShot ? { noShot: v.noShot } : {}) };
    const bytes = Buffer.from(v.image.png, "base64");
    if (bytes.length > CAPS.image.bytes || v.image.width > CAPS.image.side || v.image.height > CAPS.image.side) {
      return { seen: v.seen, image: null, noShot: "the screenshot was too large to send" };
    }
    // The bytes go on their own bulk channel before the answer that says where and what they are.
    const channel = ++this.channel;
    this.d.mux.sendBytes(channel, bytes);
    return {
      seen: v.seen,
      image: { channel, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: v.image.width, height: v.image.height, rect: v.image.rect, scale: v.image.scale, mime: "image/png" },
    };
  }

  /** act and apps.launch: freshness and epoch here, the desktop again, then the child's gate 2 and the step. */
  private async step<O extends "act" | "apps.launch">(op: O, a: OpArgs<O>): Promise<OpResult<O>> {
    if (a.epoch < this.epoch) return { status: "stopped" } as OpResult<O>;
    if (!this.liveness?.fresh()) return { status: "stale" } as OpResult<O>;
    const why = await this.d.desktop.recheck();
    if (why) return { status: "deny", reason: why.slice(0, CAPS.str.reason) } as OpResult<O>;
    return await this.d.desktop.request(op, a) as OpResult<O>;
  }

  /** The child's write-ahead audit of a step: refused when the link moved on since (the step then doesn't happen). */
  async auditStep(entry: Record<string, unknown>, epoch: number): Promise<void> {
    if (this.stopping || epoch < this.epoch) throw new IpcError("stopped", "Ember was stopped.");
    if (!this.liveness?.fresh()) throw new IpcError("stale", "The connection went quiet.");
    if (!this.d.audit.write({ ...entry, event: (entry.event === "decision" ? "decision" : "action") })) throw new IpcError("denied", GATE_WORDS.noStepAudit);
  }

  // -- commands --------------------------------------------------------------------------------------------------------

  private async run(a: OpArgs<"cmd.run">): Promise<OpResult<"cmd.run">> {
    const d = this.d;
    const fence = this.fence;
    const arrived = d.now();
    if (this.stoppedEarly.has(a.spec.runId)) throw new OpError("stopped", "Ember was stopped.");
    const known = this.facts ?? await this.currentFacts();
    // Ember's own pids as they are now (the desktop child may have started since the facts were read).
    const facts: RunnerFacts = d.ember ? { ...known, ember: d.ember() } : known;
    const g = await gateCommand({
      spec: a.spec, epoch: a.epoch, agentEpoch: this.epoch, fresh: !!this.liveness?.fresh(), targetId: null,
      mode: commandMode(d.policy.current, "ssh"), facts, classify: d.classify, inspect: d.inspect,
      ...(d.readScript ? { readScript: d.readScript } : {}), task: this.taskMemory(a.spec.taskId), now: d.now,
    });
    const { spec } = a;
    if (g.status !== "ok") {
      if (!("reason" in g)) throw new OpError(g.status, g.status === "stopped" ? "Ember was stopped." : "The connection went quiet, so the command didn't start.");
      d.audit.write({ event: "decision", task: spec.taskId, op: spec.runId, kind: "command", shell: spec.shell, cwd: spec.cwd, verdict: g.status, reason: g.reason, ...(g.rules ? { rules: g.rules } : {}) });
      return g;
    }
    // The gate awaited the paths' facts (up to 5 s): a stop may have come meanwhile, or the link gone quiet. Checked
    // again here, where nothing else can run until the command has started (the audit write is synchronous).
    if (a.epoch < this.epoch || this.stopping || fence !== this.fence || this.stoppedEarly.has(spec.runId)) throw new OpError("stopped", "Ember was stopped.");
    if (!this.liveness?.fresh()) throw new OpError("stale", "The connection went quiet, so the command didn't start.");
    // Started this late, its answer could reach a PC that already said it wasn't started (RUN_START_MAX_MS).
    if (d.now() - arrived > RUN_START_MAX_MS) throw new OpError("stale", "This computer took too long to check the command, so it didn't start.");
    // Write-ahead: no record, no command.
    const written = d.audit.write({
      event: "command", phase: "start", task: spec.taskId, op: spec.runId, runId: spec.runId, shell: spec.shell, cwd: spec.cwd, command: spec.command,
      verdict: spec.stamp.verdict, classes: spec.stamp.classes, rules: spec.stamp.rules, approved: g.approved,
    });
    if (!written) return { status: "deny", reason: GATE_WORDS.noAudit };
    const channel = ++this.channel;
    const { interactive } = d.runs.start(spec, channel, facts);
    this.noteTask(spec.taskId, g.cls);
    return { status: "started", channel, interactive };
  }

  /** A task's memory here (made on first use; the oldest task is forgotten past TASKS_REMEMBERED). */
  private taskMemory(taskId: string): { downloaded: Set<string>; written: TaskWrites } {
    let m = this.tasks.get(taskId);
    if (m) this.tasks.delete(taskId);
    else m = { downloaded: new Set(), written: newTaskWrites() };
    this.tasks.set(taskId, m);
    while (this.tasks.size > TASKS_REMEMBERED) this.tasks.delete(this.tasks.keys().next().value as string);
    return m;
  }

  /** What a command that started may have downloaded and written, whatever its end (part of it may have run). */
  private noteTask(taskId: string, cls: Classification): void {
    const m = this.taskMemory(taskId);
    for (const p of cls.downloads) m.downloaded.add(p);
    noteWrites(m.written, cls);
  }

  /** A run ended: the PC hears it after the run's answer (cmd.run's "started" goes first), and the audit records it. */
  runExited(runId: string, exit: RunExit, outBytes: number): void {
    const safe: RunExit = { ...exit, ...(exit.error !== undefined ? { error: exit.error.slice(0, CAPS.str.reason) } : {}) };
    this.d.audit.write({ event: "command", phase: "end", op: runId, runId, ended: safe.ended, code: safe.code, signal: safe.signal, ms: safe.ms, outBytes });
    setImmediate(() => this.event("cmd.exit", { runId, exit: safe, outBytes }));
  }

  // -- stopping --------------------------------------------------------------------------------------------------------

  /**
   * Pulls the agent's kill switch: every run's ladder (attended: ^C first; else SIGTERM first), in-flight steps fenced,
   * the desktop child stopped. Returns within the kill switch's 300 ms race.
   */
  private async killSwitch(source: StopSource, attended: boolean): Promise<{ ms: number; late: string[] }> {
    const d = this.d;
    const ks = new KillSwitch(() => [
      { name: "commands", stop: () => d.runs.stopAll(source === "link-lost" ? "lost" : "killswitch", attended) },
      // In-flight commands are fenced here; in-flight steps end with the desktop child, whose audit request can no
      // longer be answered, so no step that hasn't been recorded yet can happen.
      { name: "ops", stop: () => { this.fence++; } },
      { name: "desktop", stop: () => d.desktop.stop() },
    ], d.log);
    // KillSwitch's sources name the PC's controls; the console's Stop is its own, the rest are the agent's audit's.
    const r = await ks.pull(source === "console" ? "remote-console" : "menu");
    d.audit.write({ event: "stop", source, ms: r.ms, late: r.late });
    return { ms: r.ms, late: r.late.slice(0, CAPS.lines) };
  }

  /** Someone at the remote's screen pressed Stop: everything stops there, the PC hears it, the link stays. */
  async consoleStop(): Promise<void> {
    await this.killSwitch("console", true);
    this.event("console.stop", { at: new Date(this.d.now()).toISOString() });
  }

  /**
   * Stops everything and ends the agent (§5.3.11): after every run has ended, no sooner than 1.6 s when runs were live
   * (the ladder's SIGKILL and last sweep must not race the exit) and no later than 3 s.
   */
  shutdown(source: StopSource, attended: boolean): Promise<void> {
    this.stopping ??= (async () => {
      const d = this.d;
      const t0 = d.now();
      const hadRuns = d.runs.running > 0;
      this.liveness?.stop();
      d.policy.stop();
      try {
        await this.killSwitch(source, attended);
      } catch (err) {
        d.log.error("remote.stop_failed", { err });
      }
      let left = EXIT_MAX_MS - (d.now() - t0);
      if (hadRuns && left > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all([d.runs.allEnded(), d.runs.ladders()]), new Promise(r => { timer = setTimeout(r, left); })]);
        clearTimeout(timer);
        const wait = Math.min(EXIT_MIN_MS, EXIT_MAX_MS) - (d.now() - t0);
        left = EXIT_MAX_MS - (d.now() - t0);
        if (wait > 0 && left > 0) await new Promise(r => setTimeout(r, Math.min(wait, left)));
      }
      this.lock?.release();
      d.log.info("remote.exit", { source, ms: d.now() - t0 });
      d.exit(0);
    })();
    return this.stopping;
  }
}
