/**
 * Serve's side of the remote desktop (§5.3.4-§5.3.5, §5.3.9, §5.3.11): whether this computer offers a desktop at all
 * (macOS and a remote that is WSL on another PC: commands only), discovery cached for 2 s (re-run before every task and
 * every step, so a screen that locks mid-task stops it), the desktop child started with the session's environment and
 * told the policies, its notice paused by the dead-man and resumed by the next `desktop.state`, and stopped by Stop,
 * the console's Stop, a lost link or a change of session. `desktop.changed` only ever lowers access (§7.2.7). Plain
 * Node; the child's process and the discovery come in as functions.
 */

import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../main/logger";
import type { DesktopState } from "../main/remote/protocol";
import { desktopChildEnv, type DesktopFound, type NoDesktop } from "./desktop-linux";
import { IpcError, lineRpc, type ChildPolicy, type InitResult, type LineRpc } from "./desktop-ipc";

/** Discovery's answer is reused this long (§5.3.4 step 8). */
export const DISCOVERY_MS = 2000;
/** How long the child gets to verify the desktop: the sidecar's start, the notice, and the console's two minutes. */
const INIT_MS = 30_000;
const INIT_CONSENT_MS = 150_000;
/** A read or a step: the sidecar's own timeouts are shorter. */
const OP_MS = 60_000;
/**
 * While the desktop is in use it is looked at again this often (§5.3.4 step 8 between steps too): a screen that locks or
 * a session that goes inactive while no step comes is told to the PC at once (desktop.changed with access none), so it
 * stops that computer's tasks then, not at their next step.
 */
export const WATCH_MS = 5000;

/** What the controller needs of serve and the machine. */
export interface DesktopDeps {
  /** Why this computer offers no desktop whatever its sessions (macOS, WSL on another PC), or null. */
  unavailable: string | null;
  host: string;
  discover: () => Promise<DesktopFound | NoDesktop>;
  /** Starts `ember-remote.cjs desktop` in its own process group with `env`, stdio piped. */
  spawnChild: (env: NodeJS.ProcessEnv) => ChildProcess;
  /** The agent's own (sanitised) environment: the child's base (desktopChildEnv). */
  baseEnv: NodeJS.ProcessEnv;
  scripts: { atspi: string; notice: string };
  /** The write-ahead audit of a step, which also checks the link's epoch and freshness (throws an IpcError). */
  audit: (entry: Record<string, unknown>, epoch: number) => Promise<void>;
  /** desktop.changed (always a lowering). */
  changed: (s: DesktopState) => void;
  /** Someone at the screen pressed Stop on the notice. */
  consoleStop: () => void;
  log: Logger;
  now: () => number;
  /** Runs `fn` every `ms` until stopped (default: an unref'd setInterval); tests pass their own. */
  every?: (fn: () => void, ms: number) => { stop(): void };
}

/** The inputs of one `desktop.state` that the PC and both policies decide. */
export interface DesktopAsk {
  /** The PC's name for the notice. */
  pc: string;
  /** Both machines' `ssh.desktop` (false: commands only). */
  allowed: boolean;
  /** This computer's `ssh.requireConsoleConsent`. */
  consent: boolean;
  policy: ChildPolicy;
}

interface Child { proc: ChildProcess; rpc: LineRpc; session: string; access: "screen" | "text"; type: "x11" | "wayland" }

/** The remote desktop as serve drives it. */
export class DesktopController {
  private child: Child | null = null;
  private last: DesktopState = { access: "none", notice: "off" };
  private cached: { at: number; found: DesktopFound | NoDesktop } | null = null;
  private paused = false;
  private starting: Promise<DesktopState> | null = null;
  /** Bumped by every stop() from outside (Stop, the console's Stop, a policy that turns the desktop off, the exit). */
  private gen = 0;
  /** The look every WATCH_MS while a child runs, and whether one is under way. */
  private watch: { stop(): void } | null = null;
  private looking = false;

  constructor(private d: DesktopDeps) {}

  /** The desktop as last known. */
  get state(): DesktopState {
    return this.last;
  }

  /** The child's pid (Ember's own process, D4.5), or null. */
  get pid(): number | null {
    return this.child?.proc.pid ?? null;
  }

  /** Discovery, reused for 2 s unless `fresh`. */
  private async discover(fresh = false): Promise<DesktopFound | NoDesktop> {
    if (!fresh && this.cached && this.d.now() - this.cached.at < DISCOVERY_MS) return this.cached.found;
    let found: DesktopFound | NoDesktop;
    try {
      found = await this.d.discover();
    } catch (err) {
      this.d.log.warn("remote.desktop_discovery_failed", { err });
      found = { access: "none", why: `Ember couldn't check ${this.d.host}'s desktop.` };
    }
    this.cached = { at: this.d.now(), found };
    return found;
  }

  /** What welcome says before anything is started: discovery only, the notice not shown yet. */
  async preview(allowed: boolean): Promise<DesktopState> {
    if (this.d.unavailable) return (this.last = { access: "none", why: this.d.unavailable, notice: "off" });
    if (!allowed) return (this.last = { access: "none", why: this.offWhy(), notice: "off" });
    const f = await this.discover(true);
    this.last = f.access === "none"
      ? { access: "none", why: f.why, ...(f.session ? { session: f.session } : {}), notice: "off" }
      : { access: f.access, session: { type: f.session.type, locked: false, active: true }, notice: "off" };
    return this.last;
  }

  private offWhy(): string {
    return `An administrator turned off Ember's use of ${this.d.host}'s screen: it can run commands there.`;
  }

  /**
   * `desktop.state` (before a task's first step): discovery again, then the child started (or resumed) and verified,
   * its notice showing; none with why when anything fails.
   */
  ensure(ask: DesktopAsk): Promise<DesktopState> {
    if (this.starting) return this.starting;
    const p: Promise<DesktopState> = this.ensureNow(ask).finally(() => { if (this.starting === p) this.starting = null; });
    this.starting = p;
    return p;
  }

  private async ensureNow(ask: DesktopAsk): Promise<DesktopState> {
    // A stop while this waits (Stop, the console's Stop, the policy turning the desktop off: each decided after `ask`
    // was) wins: nothing is started or resumed for a request from before it.
    const gen = this.gen;
    if (this.d.unavailable) return this.lower({ access: "none", why: this.d.unavailable, notice: "off" });
    if (!ask.allowed) return this.lower({ access: "none", why: this.offWhy(), notice: "off" });
    const f = await this.discover(true);
    if (gen !== this.gen) return this.stoppedMeanwhile();
    if (f.access === "none") return this.lower({ access: "none", why: f.why, ...(f.session ? { session: f.session } : {}), notice: "off" });
    const c = this.child;
    if (c && c.session === f.session.id && c.access === f.access) {
      await c.rpc.request("policy", ask.policy, OP_MS).catch(() => undefined);
      if (gen !== this.gen || this.child !== c) return this.stoppedMeanwhile();
      if (this.paused) {
        try {
          await c.rpc.request("resume", {}, OP_MS);
          this.paused = false;
        } catch (err) {
          return this.lower({ access: "none", why: err instanceof Error ? err.message : `${this.d.host}'s screen can't be used now.`, notice: "off" });
        }
        if (gen !== this.gen || this.child !== c) return this.stoppedMeanwhile();
      }
      this.watching();
      return (this.last = { access: f.access, session: { type: f.session.type, locked: false, active: true }, notice: "shown" });
    }
    this.halt();
    return this.startChild(f, ask);
  }

  /**
   * What a desktop.state from before a stop answers: no desktop (the next one starts afresh). A newer one may be under
   * way or have started a helper since (its look answered first): what it found stays the desktop's state, untold.
   */
  private stoppedMeanwhile(): DesktopState {
    const s: DesktopState = { access: "none", why: `Ember stopped using ${this.d.host}'s screen.`, notice: "off" };
    return this.child || this.starting ? s : this.lower(s);
  }

  /** Looks at the desktop every WATCH_MS while a child runs (recheck stops it and tells the PC when it has gone). */
  private watching(): void {
    if (this.watch) return;
    const every = this.d.every ?? ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref();
      return { stop: () => clearInterval(t) };
    });
    this.watch = every(() => {
      if (!this.child || this.paused || this.looking) return;
      this.looking = true;
      void this.recheck().catch(err => this.d.log.warn("remote.desktop_watch_failed", { err })).finally(() => { this.looking = false; });
    }, WATCH_MS);
  }

  private async startChild(f: DesktopFound, ask: DesktopAsk): Promise<DesktopState> {
    const env = desktopChildEnv(this.d.baseEnv, f.env);
    let proc: ChildProcess;
    try {
      proc = this.d.spawnChild(env);
    } catch (err) {
      this.d.log.error("remote.desktop_child_failed", { err });
      return this.lower({ access: "none", why: `Ember couldn't start its desktop helper on ${this.d.host}.`, notice: "off" });
    }
    if (!proc.stdin || !proc.stdout) return this.lower({ access: "none", why: `Ember couldn't start its desktop helper on ${this.d.host}.`, notice: "off" });
    // Its stderr (Node's warnings, Xlib's complaints) is read into the log: a pipe nobody reads fills and stalls it.
    if (proc.stderr) readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on("line", l => this.d.log.debug("remote.desktop_child_stderr", { line: l.slice(0, 300) }));
    const child: Child = { proc, session: f.session.id, access: f.access, type: f.session.type, rpc: null as unknown as LineRpc };
    child.rpc = lineRpc({
      input: proc.stdout, output: proc.stdin, log: this.d.log,
      onRequest: async (op, a) => {
        if (op !== "audit") throw new IpcError("unknown_op", op);
        const { entry, epoch } = a as { entry: Record<string, unknown>; epoch: number };
        await this.d.audit(entry, epoch);
        return {};
      },
      onEvent: (ev, d) => {
        if (ev === "stop") this.d.consoleStop();
        else if (ev === "gone") this.lost(`Ember's notice went away from ${this.d.host}'s screen, so it stopped using it.`, d);
      },
      onClose: () => {
        if (this.child === child) this.lost(`Ember's desktop helper on ${this.d.host} stopped.`);
      },
    });
    proc.stdin.on("error", () => { /* the child went: onClose follows */ });
    proc.on("exit", () => child.rpc.close("the desktop helper exited"));
    this.child = child;
    this.paused = false;
    let r: InitResult;
    try {
      r = await child.rpc.request("init", {
        type: f.session.type, access: f.access, pc: ask.pc, host: this.d.host, consent: ask.consent, policy: ask.policy,
        atspi: this.d.scripts.atspi, notice: this.d.scripts.notice,
      }, ask.consent ? INIT_CONSENT_MS : INIT_MS) as InitResult;
    } catch (err) {
      // (Only this request's own helper: a stop may have ended it, and a newer request started another.)
      if (this.child === child) this.halt();
      return this.lower({ access: "none", why: err instanceof Error ? err.message : `Ember's desktop helper on ${this.d.host} didn't start.`, notice: "failed" });
    }
    if (r.access === "none") {
      if (this.child === child) this.halt();
      return this.lower({ access: "none", ...(r.why ? { why: r.why } : {}), notice: r.notice });
    }
    this.watching();
    return (this.last = { access: r.access, session: { type: f.session.type, locked: false, active: true }, notice: "shown" });
  }

  /** The desktop went away under a running child: stop it and tell the PC. */
  private lost(why: string, _d?: unknown): void {
    if (!this.child) return;
    this.halt();
    this.lower({ access: "none", why, notice: "failed" });
  }

  /** Records a lower state and tells the PC when it is lower than what it knew. */
  private lower(s: DesktopState): DesktopState {
    const was = this.last;
    this.last = s;
    if (was.access !== "none" || was.notice === "shown") this.d.changed(s);
    return s;
  }

  /**
   * Before every step (§5.3.4 step 8): the desktop is still there, unlocked and the same session (discovery reused for
   * 2 s); otherwise the child stops and the PC hears desktop.changed. Returns why it can't be used, or null.
   */
  async recheck(): Promise<string | null> {
    if (!this.child) return this.last.why ?? `Ember isn't using ${this.d.host}'s screen now.`;
    if (this.paused) return `Ember stopped using ${this.d.host}'s screen while the connection was silent.`;
    const f = await this.discover();
    // Stopped while it looked: nothing to stop, and what it found no longer matters.
    if (!this.child) return this.last.why ?? `Ember isn't using ${this.d.host}'s screen now.`;
    if (f.access === "none" || f.session.id !== this.child.session) {
      const why = f.access === "none" ? f.why : `${this.d.host}'s desktop session changed.`;
      this.halt();
      this.lower({ access: "none", why, ...(f.access === "none" && f.session ? { session: f.session } : {}), notice: "off" });
      return why;
    }
    return null;
  }

  /** A read or a step for the child. */
  request(op: string, args: unknown): Promise<unknown> {
    if (!this.child) return Promise.reject(new IpcError("not_ready", this.last.why ?? `Ember isn't using ${this.d.host}'s screen now.`));
    return this.child.rpc.request(op, args, OP_MS);
  }

  /** New policies for the child. */
  policy(p: ChildPolicy): void {
    this.child?.rpc.request("policy", p, OP_MS).catch(() => undefined);
  }

  /** The dead-man (§5.3.11): sidecar reads cancelled, the notice says Ember stopped; the next desktop.state resumes. */
  pause(): void {
    if (!this.child || this.paused) return;
    this.paused = true;
    this.child.rpc.request("pause", {}, OP_MS).catch(() => undefined);
  }

  /**
   * Stops the child (its notice closes with it), and with it any desktop.state still under way: that one starts
   * nothing (Stop, the console's Stop, a policy that turns the desktop off, the agent's exit).
   */
  stop(): void {
    this.gen++;
    this.starting = null;
    this.halt();
  }

  /** Stops the child, for the controller's own reasons (the session changed or went, a child that failed). */
  private halt(): void {
    this.watch?.stop();
    this.watch = null;
    const c = this.child;
    if (!c) return;
    this.child = null;
    this.paused = false;
    c.rpc.close("stopped");
    try { c.proc.stdin?.end(); } catch { /* gone */ }
    const pid = c.proc.pid;
    // Its stdin's end stops it; the group (its sidecar and notice too) goes if it hasn't within 1 s.
    if (pid) {
      this.stopped.add(pid);
      c.proc.once("exit", () => this.stopped.delete(pid));
      setTimeout(() => {
        this.stopped.delete(pid);
        try { process.kill(-pid, "SIGKILL"); } catch { /* gone already */ }
      }, 1000).unref();
    }
  }

  /** Children stopped whose group may still be there (their 1 s isn't up). */
  private stopped = new Set<number>();

  /**
   * The agent is exiting now: every stopped child's group that hasn't gone yet is killed at once (their 1 s timers die
   * with the agent, and nothing of Ember's may stay behind on the remote, R2).
   */
  reap(): void {
    this.stop();
    for (const pid of this.stopped) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone already */ }
    }
    this.stopped.clear();
  }
}
