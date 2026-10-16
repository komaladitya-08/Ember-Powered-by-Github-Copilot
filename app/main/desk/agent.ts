/**
 * Ember's side of the desk helper (agent-process.ts). Every X call on the desk
 * goes to the helper process: when the desk's X server dies, Xlib ends the
 * helper, not Ember. Callers keep the synchronous X11 and XInput interfaces:
 * a small relay thread talks to the helper while Ember's thread waits for the
 * answer (about 0.2 ms a call). If the helper exits or stops answering, the
 * desk counts as gone.
 */

import fs from "node:fs";
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import type { X11, X11Image } from "../x11";
import type { XInput } from "../hands/input";

export const DESK_STOPPED = "Ember's desk has stopped";

/** The relay thread: starts the helper and passes requests and answers along (it never waits itself). */
const RELAY = `
const { workerData, parentPort } = require("node:worker_threads");
const { fork } = require("node:child_process");
const { sig, port, script, env } = workerData;
const wake = () => { Atomics.store(sig, 0, 1); Atomics.notify(sig, 0); };
// The helper's stderr, for the report when it ends: the last of it, where the reason it died is. sharp (libvips)
// inside Electron prints a hundred or so "GLib-GObject-CRITICAL ... assertion 'G_IS_OBJECT (object)' failed" lines
// (and blank ones) with every picture: harmless, and they would push the reason out, so they aren't kept.
const NOISE = /^\\s*$|GLib-GObject-CRITICAL \\*\\*: [^\\n]*assertion '[^']*' failed/;
let child, err = "", line = "", over = false;
const keep = text => { if (text && !NOISE.test(text)) err = (err + text + "\\n").slice(-4000); };
const exited = why => {
  if (over) return;
  over = true;
  // Calls fail at once; the report waits (briefly) for the helper's last words.
  Atomics.store(sig, 1, 1);
  wake();
  let sent = false, timer;
  const report = () => { if (sent) return; sent = true; clearTimeout(timer); keep(line); line = ""; parentPort.postMessage({ exit: why, stderr: err.slice(-1500) }); port.close(); };
  if (!child || !child.stderr || child.stderr.readableEnded || child.stderr.destroyed) return report();
  timer = setTimeout(report, 250);
  child.stderr.once("close", report);
};
try {
  child = fork(script, [], { execPath: process.execPath, env, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
} catch (e) { exited(String(e && e.message || e)); }
if (child) {
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", d => {
    const lines = (line + d).split("\\n");
    line = lines.pop().slice(-4000);
    for (const l of lines) keep(l);
  });
  child.on("error", e => exited(String(e && e.message || e)));
  child.on("exit", (code, signal) => exited("the desk's helper exited (" + (signal || code) + ")"));
  child.on("message", m => {
    if (m.ready !== undefined) parentPort.postMessage({ ready: m.ready, error: m.error, calls: m.calls, pid: child.pid });
    else if (m.async) parentPort.postMessage(m);
    else { port.postMessage(m); wake(); }
  });
  port.on("message", m => { if (m.stop) { child.kill("SIGKILL"); return; } try { child.send(m); } catch { /* exiting */ } });
}
`;

interface Reply { id: number; v?: unknown; e?: string; async?: boolean }

/** The helper's scheduler state (R running, S sleeping, T stopped…) and CPU time so far, from /proc. */
function helperState(pid: number): { state: string; cpu: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: f[0], cpu: Number(f[11]) + Number(f[12]) };
  } catch {
    return null;
  }
}

export class DeskAgent {
  /** [0]: an answer is waiting; [1]: the helper is gone. */
  private sig = new Int32Array(new SharedArrayBuffer(8));
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private exitFns = new Set<(why: string) => void>();
  private gone: string | null = null;
  private stopped = false;
  private worker: Worker;
  private port: MessagePort;
  /** The helper's process id (0 until it has started). */
  pid = 0;
  /** The methods each of the helper's objects has (x11, input…). */
  calls: Record<string, string[]> = {};

  private constructor(script: string, env: NodeJS.ProcessEnv, private timeoutMs: number) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    // Ember's own executable runs the helper: in Electron as plain Node.
    this.worker = new Worker(RELAY, { eval: true, workerData: { sig: this.sig, port: port2, script, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }, transferList: [port2] });
    // The relay never keeps Ember running.
    this.worker.unref();
    this.worker.on("message", (m: Reply & { exit?: string; stderr?: string }) => {
      if (m.exit !== undefined) this.ended(m.stderr ? `${m.exit}: ${m.stderr.trim()}` : m.exit);
      else if (m.async) this.settle(m);
    });
    this.worker.on("error", err => this.ended(`the desk's relay failed: ${err.message}`));
  }

  /**
   * Starts the helper on the desk's display. `env` is all it gets (DISPLAY, XAUTHORITY…).
   * `timeoutMs`: how long one call may take before the helper counts as hung.
   */
  static start(script: string, env: NodeJS.ProcessEnv, o: { timeoutMs?: number; startMs?: number } = {}): Promise<DeskAgent> {
    // Ember's main thread waits for each call: a hung desk must be given up on quickly (calls take ~0.3 ms).
    const agent = new DeskAgent(script, env, o.timeoutMs ?? 1000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { agent.stop(); reject(new Error("Ember's desk helper didn't start")); }, o.startMs ?? 15_000);
      const off = agent.onExit(why => { clearTimeout(timer); reject(new Error(why)); });
      agent.worker.on("message", (m: { ready?: boolean; error?: string; pid?: number; calls?: Record<string, string[]> }) => {
        if (m.ready === undefined) return;
        clearTimeout(timer);
        off();
        if (m.ready) { agent.pid = m.pid ?? 0; agent.calls = m.calls ?? {}; resolve(agent); } else { agent.stop(); reject(new Error(m.error ?? "Ember's desk helper didn't start")); }
      });
    });
  }

  /** False once the helper has exited, stopped answering or was stopped: every call then throws. */
  get alive(): boolean {
    return !this.gone && !this.stopped && Atomics.load(this.sig, 1) === 0;
  }

  /** Calls `fn` once if the helper ends on its own (not after stop()). Returns a function that stops listening. */
  onExit(fn: (why: string) => void): () => void {
    this.exitFns.add(fn);
    return () => { this.exitFns.delete(fn); };
  }

  /** One call on the desk, answered before it returns. Throws DESK_STOPPED once the helper is gone. */
  call<T>(target: string, method: string, args: unknown[] = []): T {
    if (!this.alive) throw new Error(DESK_STOPPED);
    const id = ++this.seq;
    Atomics.store(this.sig, 0, 0);
    this.port.postMessage({ id, t: target, m: method, a: args });
    const start = Date.now();
    let deadline = start + this.timeoutMs;
    let cpu = this.pid ? helperState(this.pid)?.cpu : undefined;
    for (;;) {
      const r = receiveMessageOnPort(this.port)?.message as Reply | undefined;
      if (r) {
        if (r.id !== id) continue;
        if (r.e !== undefined) throw new Error(r.e);
        return r.v as T;
      }
      if (Atomics.load(this.sig, 1)) throw new Error(DESK_STOPPED);
      let left = deadline - Date.now();
      if (left <= 0) {
        // Slow but working (a busy machine): a little longer, up to 5 s. Not moving at all (a stopped helper,
        // a stopped X server) is hung.
        const now = this.pid ? helperState(this.pid) : null;
        if (now && Date.now() - start < 5000 && (now.state === "R" || (cpu !== undefined && now.cpu > cpu))) {
          cpu = now.cpu;
          deadline = Math.min(start + 5000, Date.now() + this.timeoutMs);
          left = deadline - Date.now();
        }
      }
      if (left <= 0) {
        // A hung helper (a stopped X server) would hang Ember with it: it is ended, and the desk with it.
        this.kill();
        this.ended("the desk's helper stopped answering");
        throw new Error(DESK_STOPPED);
      }
      Atomics.wait(this.sig, 0, 0, left);
      Atomics.store(this.sig, 0, 0);
    }
  }

  /** A call answered later (Ember doesn't wait): for slow work such as the mini-view's picture. */
  request<T>(target: string, method: string, args: unknown[] = []): Promise<T> {
    if (!this.alive) return Promise.reject(new Error(DESK_STOPPED));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ id, t: target, m: method, a: args, async: true });
    });
  }

  /** Ends the helper (it makes no more calls); onExit isn't called. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.exitFns.clear();
    this.kill();
    this.rejectAll();
    // The relay goes once the helper has gone (it reports the exit, which no one hears now).
    setTimeout(() => void this.worker.terminate(), 1000).unref();
  }

  /** Kills the helper, unless it has already exited (its id could then be someone else's). */
  private kill(): void {
    if (Atomics.load(this.sig, 1)) return;
    try { this.port.postMessage({ stop: true }); } catch { /* closed */ }
    if (this.pid) try { process.kill(this.pid, "SIGKILL"); } catch { /* gone */ }
  }

  private settle(m: Reply): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.e !== undefined) p.reject(new Error(m.e)); else p.resolve(m.v);
  }

  private rejectAll(): void {
    for (const p of this.pending.values()) p.reject(new Error(DESK_STOPPED));
    this.pending.clear();
  }

  private ended(why: string): void {
    if (this.gone) return;
    this.gone = why;
    Atomics.store(this.sig, 1, 1);
    this.rejectAll();
    // Not from inside a caller's X call: they see DESK_STOPPED first, then the desk is torn down.
    const fns = [...this.exitFns];
    this.exitFns.clear();
    setImmediate(() => { for (const fn of fns) fn(why); });
    void this.worker.terminate();
  }
}

/**
 * An object whose methods are made in the helper: the ones the helper's object has (so the
 * optional ones of X11 and XInput are there exactly when they work). close() lets go of what
 * is held there; the connections themselves go with the helper.
 */
function facade<T>(agent: DeskAgent, target: string): T {
  const calls = agent.calls[target] ?? [];
  const o: Record<string, unknown> = {
    close: () => { if (agent.alive && calls.includes("releaseAll")) try { agent.call(target, "releaseAll"); } catch { /* gone meanwhile */ } },
  };
  for (const m of calls) if (m !== "close") o[m] = (...a: unknown[]) => agent.call(target, m, a);
  return o as T;
}

/** The desk's X11 (windows, screenshots), through the helper. */
export function deskX11(agent: DeskAgent): X11 {
  const x = facade<X11>(agent, "x11");
  // Pixels arrive as a plain Uint8Array.
  x.capture = (...a) => {
    const img = agent.call<X11Image | null>("x11", "capture", a);
    return img && { ...img, bgra: Buffer.from(img.bgra.buffer, img.bgra.byteOffset, img.bgra.byteLength) };
  };
  return x;
}

/** The desk's XTest input, through the helper. */
export function deskInput(agent: DeskAgent): XInput {
  return facade<XInput>(agent, "input");
}

/** Keys for characters the desk's US keyboard may not have (see keys.ts). */
export interface DeskKeys {
  /** The key that types this keysym: `shift` true if it needs Shift, false if it must go without, null if it makes no difference. */
  key(sym: number): { code: number; shift: boolean | null } | null;
  /** Spare keys lent to characters get nothing on them again. */
  restore(): void;
}

export function deskKeys(agent: DeskAgent): DeskKeys {
  return {
    key: sym => agent.call("keys", "key", [sym]),
    restore: () => agent.call("keys", "restore"),
  };
}

/** The mini-view's picture: the desk as a JPEG, made in the helper so Ember's thread never waits for it. */
export interface DeskSnapshot { jpeg: Buffer; width: number; height: number; title: string }

export async function deskSnapshot(agent: DeskAgent, width: number, quality: number): Promise<DeskSnapshot | null> {
  const s = await agent.request<(Omit<DeskSnapshot, "jpeg"> & { jpeg: Uint8Array }) | null>("view", "snapshot", [width, quality]);
  return s && { ...s, jpeg: Buffer.from(s.jpeg.buffer, s.jpeg.byteOffset, s.jpeg.byteLength) };
}
