/**
 * TaskManager: runs workers in the background while the user keeps working.
 * Plain TypeScript (no model decides scheduling): at most `maxRunning` tasks
 * run at once, the rest queue; two tasks never act in the same window at the
 * same moment (window leases); finished worker sessions are deleted after
 * ten minutes; results wait for the conductor to pick them up.
 */

import crypto from "node:crypto";
import type { TaskCard } from "../../shared/overlay";
import type { Logger } from "../logger";
import type { WindowTarget } from "../perception";
import type { Worker, WorkerResult, TaskSpec } from "./worker";
import type { AuditLog } from "../policy/audit";

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  goal: string;
  title: string;
  status: TaskStatus;
  detail: string;
  result: WorkerResult | null;
  started: number;
  finished: number | null;
}

export interface TaskManagerDeps {
  log: Logger;
  /** Builds the worker for a task (with its own presenter and tools). */
  makeWorker: (spec: TaskSpec, progress: (text: string) => void) => Worker;
  /** Deletes a worker's Copilot session (conversation and files). */
  deleteSession: (sessionId: string) => Promise<void>;
  /** The window the user is in right now. */
  currentWindow: () => (WindowTarget & { app?: string }) | null;
  setCards: (cards: TaskCard[]) => void;
  onFinished?: (task: Task) => void;
  /** The audit log gets each task's request and outcome. */
  audit?: AuditLog;
  maxRunning?: number;
  /** How long a finished worker session is kept for follow-up questions. */
  keepMs?: number;
}

const titleOf = (goal: string) => {
  const t = goal.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 39) + "…" : t;
};

export class TaskManager {
  private tasks = new Map<string, Task>();
  private queue: { task: Task; spec: TaskSpec }[] = [];
  private running = new Map<string, { worker: Worker; abort: AbortController }>();
  private leases = new Map<string, { owner: string; waiters: (() => void)[] }>();
  private unreported: Task[] = [];
  private n = 0;

  constructor(private d: TaskManagerDeps) {}

  start(goal: string, opts: { target?: WindowTarget & { app?: string }; mode?: "do" | "guide" } = {}): Task {
    const id = `${++this.n}-${crypto.randomUUID().slice(0, 8)}`;
    const task: Task = { id, goal, title: titleOf(goal), status: "queued", detail: "Waiting to start", result: null, started: Date.now(), finished: null };
    this.tasks.set(id, task);
    const target = opts.target ?? this.d.currentWindow() ?? {};
    this.queue.push({ task, spec: { id, goal, target, mode: opts.mode ?? "do" } });
    this.d.log.info("task.queued", { id, goal: task.title, target: target.title });
    this.d.audit?.write({ event: "task", task: id, phase: "asked", mode: opts.mode ?? "do", goal: goal.slice(0, 300), window: target.title });
    this.pump();
    this.publish();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  cancel(id: string): void {
    const q = this.queue.findIndex(x => x.task.id === id);
    if (q >= 0) {
      const [{ task }] = this.queue.splice(q, 1);
      this.finish(task, "cancelled", { success: false, summary: "Cancelled before it started." });
      return;
    }
    this.running.get(id)?.abort.abort();
  }

  cancelAll(): void {
    for (const { task } of [...this.queue]) this.cancel(task.id);
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  /** Results the conductor hasn't been told about yet (each is returned once). */
  takeReports(): Task[] {
    const out = this.unreported;
    this.unreported = [];
    return out;
  }

  /** Exclusive use of a window for one action. */
  async lease(key: string, owner: string): Promise<() => void> {
    const k = key.toLowerCase();
    for (;;) {
      const held = this.leases.get(k);
      if (!held) break;
      if (held.owner === owner) return () => undefined;
      await new Promise<void>(resolve => held.waiters.push(resolve));
    }
    const entry = { owner, waiters: [] as (() => void)[] };
    this.leases.set(k, entry);
    return () => {
      if (this.leases.get(k) === entry) this.leases.delete(k);
      for (const w of entry.waiters) w();
    };
  }

  private pump(): void {
    const max = this.d.maxRunning ?? 2;
    while (this.running.size < max && this.queue.length) {
      const { task, spec } = this.queue.shift()!;
      void this.run(task, spec);
    }
  }

  private async run(task: Task, spec: TaskSpec): Promise<void> {
    const abort = new AbortController();
    const worker = this.d.makeWorker(spec, text => { task.detail = text; this.publish(); });
    this.running.set(task.id, { worker, abort });
    task.status = "running";
    task.detail = "Working…";
    this.publish();
    this.d.log.info("task.started", { id: task.id });
    let result: WorkerResult;
    try {
      result = await worker.run(abort.signal);
    } catch (err) {
      this.d.log.error("task.error", { id: task.id, err });
      result = { success: false, summary: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.running.delete(task.id);
    this.finish(task, abort.signal.aborted || result.stopped ? "cancelled" : result.success ? "done" : "failed", result);
    const sessionId = worker.sessionId;
    await worker.dispose();
    if (sessionId) {
      const timer = setTimeout(() => { void this.d.deleteSession(sessionId).catch(err => this.d.log.warn("task.delete_failed", { sessionId, err })); }, this.d.keepMs ?? 10 * 60_000);
      timer.unref?.();
    }
    this.pump();
  }

  private finish(task: Task, status: TaskStatus, result: WorkerResult): void {
    task.status = status;
    task.result = result;
    task.detail = result.summary;
    task.finished = Date.now();
    this.unreported.push(task);
    this.d.log.info("task.finished", { id: task.id, status, ms: task.finished - task.started });
    this.d.audit?.write({ event: "task", task: task.id, phase: status, goal: task.title, summary: result.summary.slice(0, 300) });
    this.publish();
    this.d.onFinished?.(task);
    // Finished cards stay on screen briefly, then go.
    const timer = setTimeout(() => {
      if (this.tasks.get(task.id) === task && task.status !== "running") { this.tasks.delete(task.id); this.publish(); }
    }, 15_000);
    timer.unref?.();
  }

  private publish(): void {
    const cards: TaskCard[] = [...this.tasks.values()].map(t => ({
      id: t.id,
      title: t.title,
      status: t.status === "queued" ? "waiting" : t.status === "cancelled" ? "stopped" : t.status,
      detail: t.detail,
    }));
    this.d.setCards(cards);
  }
}
