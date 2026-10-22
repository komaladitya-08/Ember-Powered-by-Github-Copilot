/**
 * The agent's watchdog (§5.1.11, §3.13, critique remote-8): a worker thread that kills the agent when its main loop
 * stalls for more than 2 s (a stalled agent can neither answer Stop nor notice the link is gone), and first kills every
 * running command: each run's process group and `script`'s session, then the environment sweep for its run id, and
 * only then the agent. The main thread keeps the live runs' process-group ids, session ids and run ids in a
 * SharedArrayBuffer (WatchTable) and bumps a heartbeat there every 250 ms; the thread reads it with its own clock, so no
 * clock crosses threads. The thread is the agent's own bundle started again with `workerData.role` set (main.ts).
 * Plain Node.
 */

import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import type { Logger } from "../main/logger";

/** The main loop counts as stalled after this long without a heartbeat. */
export const STALL_MS = 2000;
/** How often the main thread beats and the watchdog looks. */
export const BEAT_MS = 250;
/** Runs the table can hold (far more than the few a target runs at once). */
export const WATCH_SLOTS = 32;
/** workerData.role of the watchdog thread. */
export const WATCHDOG_ROLE = "ember-remote-watchdog";

const HEAD = 2;
const SLOT = 5;

/** The shared table: [heartbeat, unused, then per slot: used, pgid, sid, run id's high and low 32 bits]. */
export class WatchTable {
  readonly sab: SharedArrayBuffer;
  private readonly view: Int32Array;

  constructor(sab: SharedArrayBuffer = new SharedArrayBuffer((HEAD + WATCH_SLOTS * SLOT) * 4)) {
    this.sab = sab;
    this.view = new Int32Array(sab);
  }

  /** The main loop is alive. */
  beat(): void {
    Atomics.add(this.view, 0, 1);
  }

  /** Records a run (its process group); the slot, or null when every slot is taken (the run isn't watched then). */
  add(runId: string, pgid: number): number | null {
    if (!/^[0-9a-f]{16}$/.test(runId) || !Number.isInteger(pgid) || pgid <= 1) return null;
    for (let s = 0; s < WATCH_SLOTS; s++) {
      const at = HEAD + s * SLOT;
      if (Atomics.load(this.view, at) !== 0) continue;
      Atomics.store(this.view, at + 1, pgid);
      Atomics.store(this.view, at + 2, 0);
      Atomics.store(this.view, at + 3, parseInt(runId.slice(0, 8), 16) | 0);
      Atomics.store(this.view, at + 4, parseInt(runId.slice(8), 16) | 0);
      Atomics.store(this.view, at, 1);
      return s;
    }
    return null;
  }

  /** The session `script` made for a PTY run (the pid of its child). */
  session(slot: number, sid: number): void {
    if (slot >= 0 && slot < WATCH_SLOTS && Number.isInteger(sid) && sid > 1) Atomics.store(this.view, HEAD + slot * SLOT + 2, sid);
  }

  remove(slot: number): void {
    if (slot >= 0 && slot < WATCH_SLOTS) Atomics.store(this.view, HEAD + slot * SLOT, 0);
  }
}

/** What the table holds now (read on the watchdog's side). */
export function readTable(view: Int32Array): { beat: number; runs: { pgid: number; sid: number; runId: string }[] } {
  const runs: { pgid: number; sid: number; runId: string }[] = [];
  const hex = (v: number) => (v >>> 0).toString(16).padStart(8, "0");
  for (let s = 0; s < WATCH_SLOTS; s++) {
    const at = HEAD + s * SLOT;
    if (Atomics.load(view, at) !== 1) continue;
    runs.push({ pgid: Atomics.load(view, at + 1), sid: Atomics.load(view, at + 2), runId: hex(Atomics.load(view, at + 3)) + hex(Atomics.load(view, at + 4)) });
  }
  return { beat: Atomics.load(view, 0), runs };
}

/** What the watchdog does to processes. */
export interface WatchdogActions {
  kill(pid: number, signal: NodeJS.Signals): void;
  /** SIGKILL to every process of a session (`pkill -KILL -s <sid>`). */
  killSession(sid: number): void;
  /** The environment sweep for a run id, with SIGKILL. */
  sweep(runId: string): void;
  now(): number;
}

/**
 * One look at the table: returns true when the main loop had stalled and everything was killed (the runs' groups,
 * sessions and sweeps first, the agent last; each step whatever the one before did).
 */
export function watchdogCheck(view: Int32Array, agentPid: number, act: WatchdogActions, state: { beat: number; since: number }): boolean {
  const { beat, runs } = readTable(view);
  const now = act.now();
  if (beat !== state.beat) {
    state.beat = beat;
    state.since = now;
    return false;
  }
  if (now - state.since <= STALL_MS) return false;
  for (const r of runs) {
    try { act.kill(-r.pgid, "SIGKILL"); } catch { /* the group is gone */ }
    if (r.sid > 1) {
      try { act.killSession(r.sid); } catch { /* the session is gone */ }
    }
  }
  for (const r of runs) {
    try { act.sweep(r.runId); } catch { /* best effort: the agent goes next whatever happens */ }
  }
  act.kill(agentPid, "SIGKILL");
  return true;
}

/** What the watchdog thread is started with. */
export interface WatchdogData {
  role: typeof WATCHDOG_ROLE;
  sab: SharedArrayBuffer;
  agentPid: number;
  sweepScript: string;
}

/** The watchdog thread's loop (main.ts runs it when started with WATCHDOG_ROLE). */
export function runWatchdogThread(data: WatchdogData): void {
  const view = new Int32Array(data.sab);
  const state = { beat: readTable(view).beat, since: Date.now() };
  const act: WatchdogActions = {
    kill: (pid, signal) => { process.kill(pid, signal); },
    killSession: sid => { spawnSync("pkill", ["-KILL", "-s", String(sid)], { stdio: "ignore", timeout: 1000 }); },
    sweep: runId => {
      if (/^[0-9a-f]{16}$/.test(runId)) spawnSync("/bin/sh", ["-s", "--", "KILL", runId], { input: data.sweepScript, stdio: ["pipe", "ignore", "ignore"], timeout: 2000 });
    },
    now: () => Date.now(),
  };
  setInterval(() => { watchdogCheck(view, data.agentPid, act, state); }, BEAT_MS);
}

/** Starts the watchdog thread (`file`: the agent's own bundle) and the main thread's heartbeat. */
export function startWatchdog(o: { table: WatchTable; file: string; sweepScript: string; log: Logger }): { stop(): void } {
  const data: WatchdogData = { role: WATCHDOG_ROLE, sab: o.table.sab, agentPid: process.pid, sweepScript: o.sweepScript };
  const worker = new Worker(o.file, { workerData: data, stdout: false, stderr: false });
  worker.on("error", err => o.log.error("remote.watchdog_failed", { err }));
  worker.unref();
  o.table.beat();
  const beat = setInterval(() => o.table.beat(), BEAT_MS);
  beat.unref();
  return {
    stop() {
      clearInterval(beat);
      void worker.terminate();
    },
  };
}
