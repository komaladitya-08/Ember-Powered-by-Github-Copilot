/**
 * TaskManager: runs workers in the background while the user keeps working.
 * Plain TypeScript (no model decides scheduling): at most `maxRunning` tasks
 * run at once, the rest queue; two tasks never act in the same window at the
 * same moment (window leases); finished worker sessions are deleted after
 * ten minutes (or at once when Ember stops); results wait for the conductor
 * to pick them up. Every finished card can be closed; a failure stays longer so
 * the user can read it, then it goes on its own too.
 */

import crypto from "node:crypto";
import type { TaskCard } from "../../shared/overlay";
import type { Logger } from "../logger";
import type { WindowTarget } from "../perception";
import type { Worker, WorkerResult, TaskSpec } from "./worker";
import type { AuditEntry, AuditLog } from "../policy/audit";
import type { Agreement } from "../policy/policy";
import type { TargetId } from "../../shared/targets";
import { friendlyError } from "./presenter";

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
  mode?: "do" | "guide";
  /** The target it acts on, fixed for its life (absent: this computer). */
  targetId?: TargetId;
  /** Where it acts when not on this computer ("on build-01", "in Ubuntu (WSL)"): its card's badge (§2.4). */
  where?: string;
}

/**
 * What the TaskManager uses of a worker (§2.6): a stand-in that refuses a task (its target can't be used) needs
 * nothing more.
 */
export type WorkerLike = Pick<Worker, "run" | "steer" | "dispose" | "sessionId">;

export interface TaskManagerDeps {
  log: Logger;
  /** Builds the worker for a task (with its own presenter and tools). */
  makeWorker: (spec: TaskSpec, progress: (text: string) => void) => WorkerLike;
  /** Deletes a worker's Copilot session (conversation and files). */
  deleteSession: (sessionId: string) => Promise<void>;
  /** The window the user is in right now. */
  currentWindow: () => (WindowTarget & { app?: string }) | null;
  setCards: (cards: TaskCard[]) => void;
  onFinished?: (task: Task) => void;
  /** A finished card went: the user closed it (`byUser`), or its time was up. */
  onRemoved?: (task: Task, byUser: boolean) => void;
  /** The organisation's own endpoint is configured (a task's error doesn't mention a GitHub sign-in). */
  provider?: boolean;
  /** How this OS's settings shortcut is written ("Ctrl+Alt+E" on Linux), for a task's error that points to settings. */
  settingsKey?: string;
  /** The audit log gets each task's request and outcome. */
  audit?: AuditLog;
  maxRunning?: number;
  /** How long a finished worker session is kept for follow-up questions. */
  keepMs?: number;
  /** How long finished cards stay on screen. */
  cardMs?: number;
  /** How long a failed card stays before it goes on its own (longer, so it can be read and closed). */
  failureCardMs?: number;
}

/** A task's title on its card (and its bubbles' title): the goal on one line, at most 40 characters. */
export const titleOf = (goal: string) => {
  const t = goal.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 39) + "…" : t;
};

/** How a finished task went, in the user's words: "stopped", never "cancelled". */
export const statusWord = (s: TaskStatus) => (s === "cancelled" ? "stopped" : s);

/** One line for the conversation: "Tidy the desktop: done. Moved 3 files." or "Tidy the desktop: stopped." */
export function taskOutcome(t: Pick<Task, "title" | "status" | "result">): string {
  const summary = t.result?.summary.trim() ?? "";
  // "Stopped." or "Stopped before it started." says it already.
  if (t.status === "cancelled" && /^stopped\b/i.test(summary)) return `${t.title}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
  return `${t.title}: ${statusWord(t.status)}${summary ? `. ${summary}` : "."}`;
}

export class TaskManager {
  private tasks = new Map<string, Task>();
  private queue: { task: Task; spec: TaskSpec }[] = [];
  private running = new Map<string, { worker: WorkerLike; abort: AbortController }>();
  private leases = new Map<string, { owner: string; waiters: (() => void)[] }>();
  private unreported: Task[] = [];
  private n = 0;
  /** Finished workers' sessions waiting to be deleted, with their timers. */
  private toDelete = new Map<string, ReturnType<typeof setTimeout>>();
  private runs = new Set<Promise<void>>();
  /** Ember stopped or restarted: this manager's cards are gone from the screen and never come back. */
  private closed = false;
  /** Why every task was stopped when the user didn't stop them (Copilot stopped under them): they end as failed. */
  private cutOff: string | null = null;

  constructor(private d: TaskManagerDeps) {}

  /**
   * `userWords`: what the user said in the turn that started it (risky steps are checked against those); `agreed`:
   * Ember's questions they answered then (TaskSpec.agreed); `screen`: what the conversation read on the screen in that
   * turn (text from it typed into a window is asked about). `targetId`: the target the host bound the task to (§2.3;
   * absent: this computer), and `where` its card's badge when that isn't this computer.
   */
  start(goal: string, opts: { target?: WindowTarget & { app?: string }; mode?: "do" | "guide"; userWords?: string; agreed?: Agreement[]; screen?: string; targetId?: TargetId; where?: string } = {}): Task {
    const id = `${++this.n}-${crypto.randomUUID().slice(0, 8)}`;
    const task: Task = { id, goal, title: titleOf(goal), status: "queued", detail: "Waiting to start", result: null, started: Date.now(), finished: null,
      ...(opts.targetId ? { targetId: opts.targetId } : {}), ...(opts.where ? { where: opts.where } : {}) };
    this.tasks.set(id, task);
    const target = opts.target ?? this.d.currentWindow() ?? {};
    this.queue.push({ task, spec: { id, goal, target, mode: opts.mode ?? "do", ...(opts.userWords !== undefined ? { userWords: opts.userWords } : {}),
      ...(opts.agreed?.length ? { agreed: opts.agreed } : {}), ...(opts.screen ? { screen: opts.screen } : {}), ...(opts.targetId ? { targetId: opts.targetId } : {}) } });
    // The goal and window title are the user's words and screen text: the log keeps only their size.
    this.d.log.info("task.queued", { id, chars: goal.length, mode: opts.mode ?? "do" });
    this.record({ event: "task", task: id, phase: "asked", mode: opts.mode ?? "do", goal: goal.slice(0, 300), window: target.title,
      ...(opts.targetId && opts.targetId !== "local" ? { target: opts.targetId } : {}) });
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
      if (this.cutOff) this.finish(task, "failed", { success: false, summary: this.cutOff });
      else this.finish(task, "cancelled", { success: false, summary: "Stopped before it started." });
      return;
    }
    this.running.get(id)?.abort.abort();
  }

  /** Stops every task. `failed`: why, when it wasn't the user (they end as failed with that, not as stopped). */
  cancelAll(failed?: string): void {
    if (failed) this.cutOff = failed;
    for (const { task } of [...this.queue]) this.cancel(task.id);
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  /** The user's new instruction for a task: a running one is told now, a waiting one starts with it. `userWords`, `screen`, `agreed`: as for start(). */
  async steer(id: string, text: string, userWords?: string, screen?: string, agreed?: Agreement[]): Promise<boolean> {
    const r = this.running.get(id);
    if (r) return r.worker.steer(text, userWords, screen, agreed);
    const q = this.queue.find(x => x.task.id === id);
    if (!q) return false;
    const words = q.spec.userWords !== undefined ? { userWords: userWords ? `${q.spec.userWords}\n${userWords}` : q.spec.userWords } : {};
    const seen = screen ? { screen: q.spec.screen ? `${q.spec.screen}\n${screen}` : screen } : {};
    const yes = agreed?.length ? { agreed: [...(q.spec.agreed ?? []), ...agreed] } : {};
    q.spec = { ...q.spec, goal: `${q.spec.goal}\n(The user then added: ${text.replace(/</g, "‹")})`, ...words, ...seen, ...yes };
    return true;
  }

  /** A finished card the user closed. */
  dismiss(id: string): void {
    const t = this.tasks.get(id);
    if (t && t.status !== "running" && t.status !== "queued") { this.tasks.delete(id); this.publish(); this.d.onRemoved?.(t, true); }
  }

  /** Takes this manager's cards off the screen for good (Ember stopped or restarted; a new manager takes over). */
  close(): void {
    this.closed = true;
    this.d.setCards([]);
  }

  /** Waits (up to `ms`) for running workers to wind down after cancelAll(). */
  async drain(ms: number): Promise<void> {
    if (!this.runs.size) return;
    await Promise.race([Promise.allSettled([...this.runs]), new Promise(r => setTimeout(r, ms))]);
  }

  /** Deletes every finished worker's session now (Ember is stopping or restarting: the timers would be lost). */
  async flushDeletes(): Promise<void> {
    const ids = [...this.toDelete.keys()];
    for (const t of this.toDelete.values()) clearTimeout(t);
    this.toDelete.clear();
    await Promise.all(ids.map(id => this.d.deleteSession(id).catch(err => this.d.log.warn("task.delete_failed", { sessionId: id, err }))));
  }

  /** Results the conductor hasn't been told about yet (each is returned once). */
  takeReports(): Task[] {
    const out = this.unreported;
    this.unreported = [];
    return out;
  }

  /**
   * Exclusive use of a window for one action. If `signal` aborts while waiting,
   * it returns at once with nothing held (the caller checks its signal and stops).
   */
  async lease(key: string, owner: string, signal?: AbortSignal): Promise<() => void> {
    const k = key.toLowerCase();
    for (;;) {
      if (signal?.aborted) return () => undefined;
      const held = this.leases.get(k);
      if (!held) break;
      if (held.owner === owner) return () => undefined;
      await new Promise<void>(resolve => {
        const wake = () => { signal?.removeEventListener("abort", wake); resolve(); };
        held.waiters.push(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
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
      // run() ends every task on screen whatever happens (review #79); anything left over is logged, never unhandled.
      const run = this.run(task, spec).catch(err => this.d.log.error("task.run_failed", { id: task.id, err }));
      this.runs.add(run);
      void run.finally(() => this.runs.delete(run));
    }
  }

  private async run(task: Task, spec: TaskSpec): Promise<void> {
    const abort = new AbortController();
    const worker = this.d.makeWorker(spec, text => { task.detail = text; this.publish(); });
    task.mode = spec.mode ?? "do";
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
      // One plain sentence for the card, the bubble, speech and the conversation (the log keeps the raw error).
      result = { success: false, summary: friendlyError(err instanceof Error ? err.message : String(err), undefined, { provider: this.d.provider, settingsKey: this.d.settingsKey }) };
    }
    this.running.delete(task.id);
    try {
      if (abort.signal.aborted && this.cutOff) this.finish(task, "failed", { success: false, summary: this.cutOff });
      // Stopped by the user (Stop, taking the mouse back, "Not now"): calm, not a failure.
      else this.finish(task, abort.signal.aborted || result.stopped ? "cancelled" : result.success ? "done" : "failed", result);
    } finally {
      // Whatever a listener did, the worker lets go and the queue moves on (review #79).
      try {
        const sessionId = worker.sessionId;
        await worker.dispose();
        if (sessionId) {
          const timer = setTimeout(() => {
            this.toDelete.delete(sessionId);
            void this.d.deleteSession(sessionId).catch(err => this.d.log.warn("task.delete_failed", { sessionId, err }));
          }, this.d.keepMs ?? 10 * 60_000);
          timer.unref?.();
          this.toDelete.set(sessionId, timer);
        }
      } finally {
        this.pump();
      }
    }
  }

  private finish(task: Task, status: TaskStatus, result: WorkerResult): void {
    task.status = status;
    task.result = result;
    task.detail = result.summary;
    task.finished = Date.now();
    this.unreported.push(task);
    this.d.log.info("task.finished", { id: task.id, status, ms: task.finished - task.started });
    // The card first: the screen shows how it went even when its record or a listener fails (review #79).
    this.publish();
    // Finished cards stay on screen briefly, then go; a failure stays longer so it can be read (and closed sooner).
    const timer = setTimeout(() => {
      if (this.tasks.get(task.id) === task && task.status !== "running") { this.tasks.delete(task.id); this.publish(); this.d.onRemoved?.(task, false); }
    }, status === "failed" ? this.d.failureCardMs ?? 60_000 : this.d.cardMs ?? 15_000);
    timer.unref?.();
    this.record({ event: "task", task: task.id, phase: status, goal: task.title, summary: result.summary.slice(0, 300) });
    this.d.onFinished?.(task);
  }

  /**
   * A task's request or outcome in the audit log. It records what the queue did and never decides it: a write that
   * fails (a full disk, an unwritable audit file) is logged and the queue goes on as if it had worked, so a task the
   * user was told failed can't run later, and a finished one doesn't stay "Working…" (review #79). Steps in the
   * user's apps fail closed in the worker instead.
   */
  private record(e: AuditEntry): void {
    try {
      this.d.audit?.write(e);
    } catch (err) {
      this.d.log.warn("task.audit_failed", { id: e.task, phase: e.phase, err });
    }
  }

  private publish(): void {
    if (this.closed) return;
    const cards: TaskCard[] = [...this.tasks.values()].map(t => ({
      id: t.id,
      title: t.title,
      status: t.status === "queued" ? "waiting" : t.status === "cancelled" ? "stopped" : t.status,
      detail: t.detail,
      actions: t.status === "running" || t.status === "queued"
        ? [{ id: `task:${t.id}:stop`, label: "Stop" }]
        : [{ id: `task:${t.id}:dismiss`, label: "Close" }],
      ...(t.where ? { where: t.where } : {}),
    }));
    this.d.setCards(cards);
  }
}
