/**
 * TaskManager: runs workers in the background while the user keeps working.
 * Plain TypeScript (no model decides scheduling): at most `maxRunning` tasks
 * act at once, the rest queue (guides have a limit of their own beside them); two tasks never act in the same window at the
 * same moment (window leases); a finished worker's session is deleted as soon
 * as it ends (nothing resumes it, and it holds what the task read); results wait for the conductor
 * to pick them up. Every finished card can be closed; a failure stays longer so
 * the user can read it, then it goes on its own too.
 */

import crypto from "node:crypto";
import type { TaskWindow } from "./task-controls";
import { TASK_READING_LEASE_MS, TASK_STOPPING, type TaskCard } from "../../shared/overlay";
import type { Logger } from "../logger";
import type { WindowTarget } from "../perception";
import type { Worker, WorkerResult, TaskSpec } from "./worker";
import type { AuditEntry, AuditLog } from "../policy/audit";
import type { Agreement } from "../policy/policy";
import type { TargetId } from "../../shared/targets";
import { friendlyError, type ServiceKind } from "./presenter";
import type { PlanStep, TaskHand, ViewDoc } from "../../shared/view";
import { STATUS_WORDS, summarizeActivity, type StepGroup, type TaskActivity, type TaskEntry } from "../../shared/activity";
import { ActivityLog, type ActivityEvent } from "./activity";

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";
/** Why a stopped task stopped (Task.endedBy). */
export type StopCause = "expired" | "declined" | "took-over" | "stop";

export interface Task {
  id: string;
  goal: string;
  title: string;
  status: TaskStatus;
  detail: string;
  result: WorkerResult | null;
  /** When it was asked for (it may wait in the queue), and when it began to run (absent until then). */
  started: number;
  ranAt?: number;
  finished: number | null;
  /**
   * Why it stopped when the user didn't stop it (its computer went, or someone there pressed Stop): set by AgentHost,
   * so a catch-up doesn't say "you stopped it".
   */
  stopReason?: string;
  /**
   * How a stopped task ended, from Ember's own flags (never model text): its question went unanswered ("expired"), the
   * user said "Not now" ("declined"), took the mouse back ("took-over"), or stopped it ("stop"). Set only once it is
   * stopped, so a catch-up says "you stopped it" only when they did (tasks-approvals-v1).
   */
  endedBy?: StopCause;
  mode?: "do" | "guide";
  /** The target it acts on, fixed for its life (absent: this computer). */
  targetId?: TargetId;
  /** Where it acts when not on this computer ("on build-01", "in Ubuntu (WSL)"): its card's badge (§2.4). */
  where?: string;
  /** How it works now, and its plan (its worker's onUpdate): shown on its card while it works. */
  hand?: TaskHand;
  plan?: PlanStep[];
  /** What it shows on its card: its live view (show_view, update_view) while it works, then finish_task's (or the live one). */
  view?: ViewDoc;
  /** The last app window successfully read by this worker, never inferred from its goal or summary. */
  window?: TaskWindow;
}

/** What a worker tells its card besides its steps: its plan, how it works now, its live view. */
export interface TaskUpdate { plan?: PlanStep[]; hand?: TaskHand; view?: ViewDoc; window?: TaskWindow | null }

/**
 * What the TaskManager uses of a worker (§2.6): a stand-in that refuses a task (its target can't be used) needs
 * nothing more.
 */
export type WorkerLike = Pick<Worker, "run" | "steer" | "dispose" | "sessionId">;

export interface TaskManagerDeps {
  log: Logger;
  /**
   * Builds the worker for a task (with its own presenter and tools). `activity` takes what the worker tells of its
   * steps, questions and problems (app/main/agent/activity.ts): its card shows them.
   */
  makeWorker: (spec: TaskSpec, progress: (text: string) => void, update?: (u: TaskUpdate) => void, activity?: (e: ActivityEvent) => void) => WorkerLike;
  /** Deletes a worker's Copilot session (conversation and files). */
  deleteSession: (sessionId: string) => Promise<void>;
  /** The window the user is in right now. */
  currentWindow: () => (WindowTarget & { app?: string }) | null;
  setCards: (cards: TaskCard[]) => void;
  /**
   * A task's view changed (null: its card went): main carries it to the overlay apart from the cards (ViewHub), checked
   * already (view-schema.ts). Its card says which rev it shows (TaskCard.viewRev).
   */
  onView?: (taskId: string, view: ViewDoc | null) => void;
  onFinished?: (task: Task) => void;
  /** A finished card went: the user closed it (`byUser`), or its time was up. */
  onRemoved?: (task: Task, byUser: boolean) => void;
  /** Which model service the tasks use (ServiceKind: a task's error doesn't mention a GitHub sign-in unless it is Copilot). */
  provider?: ServiceKind;
  /**
   * Whether tasks may act now (false: the organisation turned acting off). A failed card offers Try again only while
   * they may: the retry would refuse to start otherwise, a button that does nothing. Default: they may.
   */
  actionsAllowed?: () => boolean;
  /**
   * How this OS's settings shortcut is written ("Ctrl+Alt+E" on Linux), for a task's error that points to settings: or
   * the one Ember holds when the task fails, null while another app holds it (none is named then, cross-review X5).
   */
  settingsKey?: string | (() => string | null);
  /** The audit log gets each task's request and outcome. */
  audit?: AuditLog;
  /** How many tasks that act run at once (default 2); guides don't count towards it (they have the same limit of their own). */
  maxRunning?: number;
  /** How long a finished worker's session is kept before it is deleted (default 0: at once; no follow-up resumes it). */
  keepMs?: number;
  /** How long finished cards stay on screen. */
  cardMs?: number;
  /** More time to read and answer, read when each card finishes. */
  readTime?: () => number;
  /** Availability/focus of a worker-read local window. Main revalidates its native identity on focus. */
  taskWindow?: (task: Task, focus: boolean) => boolean;
  /** How long a failed card stays before it goes on its own (longer, so it can be read and closed). */
  failureCardMs?: number;
}

/** Longest task title (its card shows two lines of it). */
const TITLE_MAX = 72;

/**
 * A task's title on its card (and its bubbles' title): the goal on one line, at most 72 characters, cut at a word.
 * Cut at 40 it lost the end of most requests and still wrapped to two lines ("…a shopping l…", audit #2).
 */
export const titleOf = (goal: string) => {
  const t = goal.trim().replace(/\s+/g, " ");
  if (t.length <= TITLE_MAX) return t;
  const cut = t.slice(0, TITLE_MAX - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word >= TITLE_MAX / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.-]+$/, "")}…`;
};

/** Finished tasks whose activity is kept (in memory only, until Ember quits) for Home's "Task activity". */
const ACTIVITY_KEPT = 20;

/** How a task was asked for (TaskManager.start's options). */
export interface StartOptions {
  target?: WindowTarget & { app?: string };
  mode?: "do" | "guide";
  userWords?: string;
  agreed?: Agreement[];
  screen?: string;
  targetId?: TargetId;
  where?: string;
  commandWords?: string;
  /** TaskSpec.typedOnly. */
  typedOnly?: boolean;
  /** TaskSpec.partWay: an earlier try of it stopped part-way (a retry). */
  partWay?: boolean;
}

/**
 * A task the user may try again from its card: one that did work (not a guide) and failed, or whose question went
 * unanswered while they were away (tasks-approvals-4: a timeout is no refusal, and Try again asks every question again).
 * Never one they said "Not now" to, stopped or took the mouse back from.
 */
const retryable = (t: Task) => t.mode === "do" && (t.status === "failed" || (t.status === "cancelled" && t.endedBy === "expired"));

/** Kinds of step that change nothing (a look, a switch of window, a pointer): a try that took only these did no part of it. */
const LOOKS_ONLY: ReadonlySet<StepGroup> = new Set(["read", "windows", "switch", "scroll", "point", "wait"]);

/** A finished task's words on its card: at most 400 characters (finish_task's limit; the fallback, the worker's last answer, has none). */
const detailOf = (summary: string) => (summary.length > 400 ? summary.slice(0, 399).trimEnd() + "…" : summary);

/**
 * How a finished task went, in the user's words, as its card says it (STATUS_WORDS): "didn't finish", never "failed";
 * "stopped", never "cancelled" (tasks-approvals-9).
 */
export const statusWord = (s: TaskStatus) =>
  STATUS_WORDS[s === "cancelled" ? "stopped" : s === "failed" ? "failed" : s === "done" ? "done" : s === "running" ? "running" : "queued"].toLowerCase();

/**
 * The notification for a finished task while the user is away from the computer (main's onTaskFinished): one that
 * finished, couldn't finish, or whose question went unanswered (tasks-approvals-4: it needed them, and they weren't
 * there). Null for one the user stopped themselves, which needs no telling.
 */
export function taskNotice(t: { title: string; status: string; endedBy?: StopCause; summary: string }): { title: string; body: string } | null {
  if (t.status === "cancelled" && t.endedBy !== "expired") return null;
  return { title: t.status === "done" ? `Ember finished: ${t.title}` : `Ember couldn't finish: ${t.title}`, body: t.summary };
}

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
  /** Running tasks told to stop that are still winding down: their cards say so at once (a press that shows nothing gets pressed again). */
  private stopping = new Set<string>();
  /** Each task's activity, from when it starts to run (kept for ACTIVITY_KEPT finished tasks after their cards go). */
  private logs = new Map<string, { log: ActivityLog; task: Task }>();
  /** What each task was asked with, so a failed one can be tried again from its card. */
  private specs = new Map<string, { goal: string; opts: StartOptions }>();

  private expiry = new Map<string, { remaining: number; since: number; timer: ReturnType<typeof setTimeout> | null }>();
  private readers = new Map<string, Map<number, ReturnType<typeof setTimeout>>>();

  constructor(private d: TaskManagerDeps) {}

  /** A card stays while its visible details, pointer, or keyboard are reading it. Each renderer holds a short lease. */
  reading(id: string, reader: number, on: boolean): void {
    if (this.closed || !this.tasks.has(id)) return;
    let readers = this.readers.get(id);
    const old = readers?.get(reader);
    if (old) clearTimeout(old);
    if (on) {
      if (!readers?.size) {
        const expiry = this.expiry.get(id);
        if (expiry?.timer) { clearTimeout(expiry.timer); expiry.timer = null; expiry.remaining = Math.max(0, expiry.remaining - (Date.now() - expiry.since)); }
      }
      if (!readers) { readers = new Map(); this.readers.set(id, readers); }
      const timer = setTimeout(() => this.reading(id, reader, false), TASK_READING_LEASE_MS);
      timer.unref?.();
      readers.set(reader, timer);
    } else {
      readers?.delete(reader);
      if (!readers?.size) {
        this.readers.delete(id);
        const expiry = this.expiry.get(id);
        if (expiry) { expiry.remaining = Math.max(expiry.remaining, 5000 * this.readScale()); this.expireLater(id); }
      }
    }
  }

  private readScale(): number {
    const n = this.d.readTime?.() ?? 1;
    return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1;
  }

  private forgetCardTime(id: string): void {
    const expiry = this.expiry.get(id);
    if (expiry?.timer) clearTimeout(expiry.timer);
    this.expiry.delete(id);
    for (const timer of this.readers.get(id)?.values() ?? []) clearTimeout(timer);
    this.readers.delete(id);
  }

  private expireLater(id: string): void {
    const expiry = this.expiry.get(id);
    if (!expiry || expiry.timer || this.readers.get(id)?.size || this.closed) return;
    expiry.since = Date.now();
    expiry.timer = setTimeout(() => {
      const task = this.tasks.get(id);
      this.forgetCardTime(id);
      if (!task || task.status === "running" || task.status === "queued") return;
      this.tasks.delete(id); this.specs.delete(id); this.dropView(task); this.publish(); this.d.onRemoved?.(task, false);
    }, expiry.remaining);
    expiry.timer.unref?.();
  }

  /**
   * `userWords`: what the user said in the turn that started it (risky steps are checked against those); `agreed`:
   * Ember's questions they answered then (TaskSpec.agreed); `screen`: what the conversation read on the screen in that
   * turn (text from it typed into a window is asked about). `targetId`: the target the host bound the task to (§2.3;
   * absent: this computer), and `where` its card's badge when that isn't this computer. `commandWords`: TaskSpec's.
   */
  start(goal: string, opts: StartOptions = {}): Task {
    const id = `${++this.n}-${crypto.randomUUID().slice(0, 8)}`;
    // (Said while it waits behind others at work: one that starts at once says "Working…" at once.)
    const task: Task = { id, goal, title: titleOf(goal), status: "queued", detail: opts.mode === "guide" ? "Starts when another guide ends" : "Starts when another task ends", result: null, started: Date.now(), finished: null,
      ...(opts.targetId ? { targetId: opts.targetId } : {}), ...(opts.where ? { where: opts.where } : {}) };
    this.tasks.set(id, task);
    const target = { ...(opts.target ?? this.d.currentWindow() ?? {}) };
    // Legacy callers supply the user's request as the goal. Materialise that fallback once: later goals contain
    // model-authored steering and must never become authority on a retry. Commands never used that fallback.
    this.specs.set(id, { goal, opts: { ...opts, target, userWords: opts.userWords ?? goal,
      ...(opts.userWords === undefined && opts.commandWords === undefined ? { commandWords: "", typedOnly: true } : {}),
      ...(opts.agreed ? { agreed: [...opts.agreed] } : {}) } });
    this.queue.push({ task, spec: { id, goal, target, mode: opts.mode ?? "do", ...(opts.userWords !== undefined ? { userWords: opts.userWords } : {}),
      ...(opts.agreed?.length ? { agreed: opts.agreed } : {}), ...(opts.screen ? { screen: opts.screen } : {}), ...(opts.targetId ? { targetId: opts.targetId } : {}),
      ...(opts.commandWords !== undefined ? { commandWords: opts.commandWords } : {}), ...(opts.typedOnly ? { typedOnly: true } : {}), ...(opts.partWay ? { partWay: true } : {}) } });
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

  /** What a task did and is doing (null before it ran, or once it is no longer kept). */
  activity(id: string): TaskActivity | null {
    return this.logs.get(id)?.log.get() ?? null;
  }

  /**
   * Every kept task's activity, newest first, with what its card showed (Home's "Task activity"; in memory only, gone
   * when Ember quits). A task's state reads as on its card.
   */
  activities(): TaskEntry[] {
    // A task still in line (or one whose worker couldn't be made) has no log yet: listed with an empty one, so Home
    // counts every task of the session (the status panel's "earlier" count is the audit's tasks less these).
    const unlogged = [...this.tasks.values()].filter(t => !this.logs.has(t.id)).map(t => [t.id, { log: new ActivityLog(t.started), task: t }] as const);
    return [...unlogged.reverse(), ...[...this.logs].reverse()].map(([id, { log, task: t }]) => {
      const activity = log.get();
      if (t.finished !== null && activity.endedAt === undefined) activity.endedAt = t.finished;
      const status: TaskEntry["status"] = t.status === "cancelled" ? "stopped" : t.status === "running" && activity.asking ? "waiting" : t.status;
      const ended = t.status !== "running" && t.status !== "queued";
      return {
        id, title: t.title, status,
        ...(t.where ? { where: t.where } : {}),
        ...(t.hand && !ended ? { hand: t.hand } : {}),
        ...(t.plan?.length ? { plan: t.status === "done" ? t.plan.map(p => ({ ...p, state: "done" as const })) : t.plan.map(p => ({ ...p })) } : {}),
        ...(ended && t.result?.summary ? { summary: t.result.summary } : {}),
        ...(t.view ? { view: t.view } : {}),
        controls: { stop: this.canStop(id), retry: this.canRetry(id), window: !this.closed && this.tasks.has(id) && (this.d.taskWindow?.(t, false) ?? false) },
        ...(t.status === "cancelled" && t.endedBy === "expired" ? { unanswered: true as const } : {}),
        activity,
      };
    });
  }

  /** A live task can be stopped once, even while another task is asking a question. */
  canStop(id: string): boolean {
    const t = this.tasks.get(id);
    return !this.closed && !!t && (t.status === "running" || t.status === "queued") && !this.stopping.has(id);
  }

  canRetry(id: string): boolean {
    const t = this.tasks.get(id);
    return !!t && this.specs.has(id) && retryable(t) && !this.cutOff && !this.closed && this.actionsAllowed();
  }

  openWindow(id: string): boolean {
    const t = this.tasks.get(id);
    return !this.closed && !!t && (this.d.taskWindow?.(t, true) ?? false);
  }

  /**
   * The user pressed Try again on a failed task's card: the same request starts again as a new task (with the same
   * words, so every question is asked again), and the failed card goes. Null when it can't be.
   */
  retry(id: string): Task | null {
    const t = this.tasks.get(id);
    const spec = this.specs.get(id);
    if (!t || !spec || !this.canRetry(id)) return null;
    // An earlier try that changed something (typed, clicked, ran a command) may have done part of it: the new worker is
    // told so (TaskSpec.partWay: its first prompt only), never in the user's words, so every question is still asked,
    // and its card's title stays the request's (tasks-approvals-3).
    const did = this.logs.get(id)?.log.get();
    const changed = !!did && Object.entries(did.counts).some(([g, n]) => !LOOKS_ONLY.has(g as StepGroup) && (n ?? 0) > 0);
    this.dismiss(id);
    return this.start(spec.goal, { ...spec.opts, ...(changed ? { partWay: true } : {}) });
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  /**
   * Stop everything's sweep: the cards kept as long as a failure's (a task that didn't finish, or whose question went
   * unanswered) go at once, the keyboard's and the screen reader's way to clear them (tasks-approvals-r1).
   */
  dismissFailures(): void {
    for (const t of [...this.tasks.values()]) if (t.status === "failed" || (t.status === "cancelled" && t.endedBy === "expired")) this.dismiss(t.id);
  }

  /**
   * The user's own words a task that may be tried again was asked with (its userWords, and those its commands hear):
   * what a spoken "try again" carries, as Try again on its card does (tasks-approvals-1). Never its goal, which the
   * model wrote. Null for a task that can't be tried again.
   */
  askedWith(id: string): { userWords: string; commandWords?: string; typedOnly?: boolean } | null {
    const t = this.tasks.get(id);
    const spec = this.specs.get(id);
    if (!t || !spec || !retryable(t) || spec.opts.userWords === undefined) return null;
    const o = spec.opts;
    return { userWords: o.userWords!, ...(o.commandWords !== undefined ? { commandWords: o.commandWords } : {}), ...(o.typedOnly ? { typedOnly: true } : {}) };
  }

  /**
   * What a running task is held up by: its question waiting for the user's answer ("answer"), or a Stop it is winding
   * down from ("stopping"); null otherwise (as its card says: "waiting" and TASK_STOPPING).
   */
  holdUp(id: string): "answer" | "stopping" | null {
    const t = this.tasks.get(id);
    if (t?.status !== "running") return null;
    if (this.stopping.has(id)) return "stopping";
    return this.logs.get(id)?.log.asking ? "answer" : null;
  }

  cancel(id: string): void {
    const q = this.queue.findIndex(x => x.task.id === id);
    if (q >= 0) {
      const [{ task }] = this.queue.splice(q, 1);
      if (this.cutOff) this.finish(task, "failed", { success: false, summary: this.cutOff });
      else this.finish(task, "cancelled", { success: false, summary: "Stopped before it started." }, "stop");
      return;
    }
    const r = this.running.get(id);
    if (!r) return;
    r.abort.abort();
    this.stopping.add(id);
    this.publish();
  }

  /** Stops every task. `failed`: why, when it wasn't the user (they end as failed with that, not as stopped). */
  cancelAll(failed?: string): void {
    if (failed) this.cutOff = failed;
    for (const { task } of [...this.queue]) this.cancel(task.id);
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  /** The user's new instruction for a task: a running one is told now, a waiting one starts with it. `userWords`, `screen`, `agreed`, `commandWords`: as for start(). */
  async steer(id: string, text: string, userWords?: string, screen?: string, agreed?: Agreement[], commandWords?: string): Promise<boolean> {
    if (!this.specs.has(id)) return false;
    const r = this.running.get(id);
    const q = this.queue.find(x => x.task.id === id);
    if (!r && !q) return false;
    if (r) {
      const accepted = await r.worker.steer(text, userWords, screen, agreed, commandWords);
      if (!accepted) return false;
    }
    // Only accepted instructions become retryable. Read the latest recipe after the await so concurrent accepted
    // updates do not overwrite each other. Never use a conductor's rewritten goal as the user's own words.
    const current = this.specs.get(id);
    if (!current) return true; // The card was removed while its worker accepted the update.
    const opts = current.opts;
    const words = { userWords: userWords ? `${opts.userWords}\n${userWords}` : opts.userWords };
    const seen = screen ? { screen: opts.screen ? `${opts.screen}\n${screen}` : screen } : {};
    const yes = agreed?.length ? { agreed: [...(opts.agreed ?? []), ...agreed] } : {};
    // Commands never inherit model-authored steering, or a legacy goal without separately supplied user words.
    const heard = commandWords !== undefined || opts.commandWords !== undefined
      ? { commandWords: [opts.commandWords ?? opts.userWords ?? "", commandWords ?? userWords ?? ""].filter(w => w.trim()).join("\n") } : {};
    const provenance = commandWords !== undefined ? { typedOnly: false }
      : heard.commandWords !== undefined && opts.commandWords === undefined ? { typedOnly: true } : {};
    const next = {
      goal: `${current.goal}\n(The user then added: ${text.replace(/</g, "‹")})`,
      opts: { ...opts, ...words, ...seen, ...yes, ...heard,
        ...provenance },
    };
    this.specs.set(id, next);
    if (q) q.spec = { ...q.spec, goal: next.goal, ...words, ...seen, ...yes, ...heard,
      ...provenance };
    return true;
  }

  /** A finished card the user closed. */
  dismiss(id: string): void {
    const t = this.tasks.get(id);
    if (t && t.status !== "running" && t.status !== "queued") { this.forgetCardTime(id); this.tasks.delete(id); this.specs.delete(id); this.dropView(t); this.publish(); this.d.onRemoved?.(t, true); }
  }

  /** A task's view, to its card (a listener's fault never stops the task). */
  private showView(task: Task, view: ViewDoc): void {
    // A closed manager's cards are gone for good: a worker still winding down shows nothing more.
    if (this.closed) return;
    task.view = view;
    try { this.d.onView?.(task.id, view); } catch (err) { this.d.log.warn("task.view_failed", { id: task.id, err }); }
  }

  /** Its card went: so does its view. */
  private dropView(task: Task): void {
    if (!task.view) return;
    try { this.d.onView?.(task.id, null); } catch (err) { this.d.log.warn("task.view_failed", { id: task.id, err }); }
  }

  /** Takes this manager's cards off the screen for good (Ember stopped or restarted; a new manager takes over). */
  close(): void {
    this.closed = true;
    for (const id of new Set([...this.expiry.keys(), ...this.readers.keys()])) this.forgetCardTime(id);
    for (const t of this.tasks.values()) this.dropView(t);
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

  /**
   * Starts what may start now, in order: at most `maxRunning` tasks that act, and beside them at most `maxRunning`
   * guides (a guide only points and waits for the user's clicks, so it never waits behind tasks that may run for minutes).
   */
  private pump(): void {
    const max = this.d.maxRunning ?? 2;
    const running = (guide: boolean) => [...this.running.keys()].filter(id => (this.tasks.get(id)?.mode === "guide") === guide).length;
    for (let i = 0; i < this.queue.length;) {
      const { task, spec } = this.queue[i];
      if (running(spec.mode === "guide") >= max) { i++; continue; }
      this.queue.splice(i, 1);
      // run() ends every task on screen whatever happens (review #79); anything left over is logged, never unhandled.
      const run = this.run(task, spec).catch(err => this.d.log.error("task.run_failed", { id: task.id, err }));
      this.runs.add(run);
      void run.finally(() => this.runs.delete(run));
    }
  }

  private async run(task: Task, spec: TaskSpec): Promise<void> {
    const abort = new AbortController();
    let worker: WorkerLike;
    // Known before its worker is made: a task whose worker couldn't be made is still one that would act (Try again).
    task.mode = spec.mode ?? "do";
    try {
      // Its activity starts now: its card's clock counts from here, not from when it was queued.
      const log = new ActivityLog(Date.now());
      this.logs.set(task.id, { log, task });
      worker = this.d.makeWorker(spec, text => { task.detail = text; this.publish(); }, u => {
        if (u.plan) task.plan = u.plan;
        if (u.hand && u.hand !== (task.hand ?? "background")) log.add({ type: "hand", hand: u.hand }, Date.now());
        if (u.hand) task.hand = u.hand;
        if (u.view) this.showView(task, u.view);
        if (u.window) task.window = { ...u.window };
        else if (u.window === null) delete task.window;
        this.publish();
      }, e => { if (log.add(e, Date.now())) this.publish(); });
    } catch (err) {
      // Its worker couldn't be made: the task fails now (closable, said plainly) rather than waiting for ever with a
      // Stop that does nothing, and what queued behind it gets its turn.
      this.d.log.error("task.error", { id: task.id, err });
      this.finish(task, "failed", { success: false, summary: task.mode === "do" ? "I couldn't start this task. Try again; if it keeps happening, restart Ember." : "I couldn't start this. Ask again; if it keeps happening, restart Ember." });
      this.pump();
      return;
    }
    // A task that does the work starts in the background (a guide is Ember beside the cursor, pointing).
    if (task.mode === "do") task.hand ??= "background";
    this.running.set(task.id, { worker, abort });
    task.status = "running";
    task.ranAt = Date.now();
    task.detail = "Working…";
    this.publish();
    this.d.log.info("task.started", { id: task.id });
    let result: WorkerResult;
    try {
      result = await worker.run(abort.signal);
    } catch (err) {
      this.d.log.error("task.error", { id: task.id, err });
      // One plain sentence for the card, the bubble, speech and the conversation (the log keeps the raw error).
      const key = this.d.settingsKey;
      let settingsKey: string | null | undefined = null;
      try { settingsKey = typeof key === "function" ? key() : key; } catch { /* named none: it may be taken */ }
      result = { success: false, summary: friendlyError(err instanceof Error ? err.message : String(err), undefined, { provider: this.d.provider, settingsKey }) };
    }
    this.running.delete(task.id);
    try {
      if (abort.signal.aborted && this.cutOff) this.finish(task, "failed", { success: false, summary: this.cutOff });
      // Stopped by the user (Stop, taking the mouse back, "Not now"), or its question went unanswered: calm, not a
      // failure. A Stop is a Stop whatever the worker said as it wound down.
      else this.finish(task, abort.signal.aborted || result.stopped ? "cancelled" : result.success ? "done" : "failed", result,
        abort.signal.aborted ? "stop" : result.expired ? "expired" : result.declined ? "declined" : result.tookOver ? "took-over" : "stop");
    } finally {
      // Whatever a listener did, the worker lets go and the queue moves on (review #79).
      try {
        const sessionId = worker.sessionId;
        await worker.dispose();
        if (sessionId) {
          const timer = setTimeout(() => {
            this.toDelete.delete(sessionId);
            void this.d.deleteSession(sessionId).catch(err => this.d.log.warn("task.delete_failed", { sessionId, err }));
          }, this.d.keepMs ?? 0);
          timer.unref?.();
          this.toDelete.set(sessionId, timer);
        }
      } finally {
        this.pump();
      }
    }
  }

  private finish(task: Task, status: TaskStatus, result: WorkerResult, endedBy?: StopCause): void {
    this.stopping.delete(task.id);
    // Stopped by its step or time limit: what it had done by then, from Ember's own count of its steps (never the
    // model's words), so the user and the next turn know before anything is tried again (tasks-approvals-3).
    const did = result.limit ? this.logs.get(task.id)?.log.get() : undefined;
    const steps = did ? summarizeActivity(did.counts, did.failedSteps) : null;
    if (steps) result = { ...result, summary: `${result.summary} Before I stopped: ${steps.charAt(0).toLowerCase()}${steps.slice(1)}.` };
    const unanswered = status === "cancelled" && endedBy === "expired";
    this.logs.get(task.id)?.log.add({ type: "end", status: status === "done" ? "done" : status === "failed" ? "failed" : "stopped", ...(unanswered ? { unanswered } : {}) }, Date.now());
    task.status = status;
    if (status === "cancelled") task.endedBy = endedBy ?? "stop";
    // Only a failure (or a question that went unanswered) can be tried again: what it was asked with goes for the rest.
    if (!retryable(task)) this.specs.delete(task.id);
    task.result = result;
    // finish_task's view takes the live view's place (one rev on, so the card draws only what changed); without one,
    // the live view stays as the result.
    if (result.view) this.showView(task, task.view ? { ...result.view, rev: task.view.rev + 1 } : result.view);
    // The card shows a card's worth; the whole summary goes to the conversation (task.result).
    task.detail = detailOf(result.summary);
    task.finished = Date.now();
    this.unreported.push(task);
    this.d.log.info("task.finished", { id: task.id, status, ms: task.finished - task.started });
    // The card first: the screen shows how it went even when its record or a listener fails (review #79).
    this.publish();
    // Open/hovered/focused cards pause their countdown; More time applies to every result, including failures/views.
    // (A question that went unanswered stays as long: the user was away, and comes back to read it.)
    const duration = status === "failed" || task.endedBy === "expired" || task.view ? this.d.failureCardMs ?? 60_000 : this.d.cardMs ?? 15_000;
    this.expiry.set(task.id, { remaining: duration * this.readScale(), since: Date.now(), timer: null });
    this.expireLater(task.id);
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

  /** Keeps the activity of every task with a card, and of the ACTIVITY_KEPT newest finished ones besides. */
  private keepLogs(): void {
    const gone = [...this.logs.keys()].filter(id => !this.tasks.has(id) && this.logs.get(id)!.log.ended);
    for (const id of gone.slice(0, Math.max(0, gone.length - ACTIVITY_KEPT))) this.logs.delete(id);
  }

  /** Tasks may act now (TaskManagerDeps.actionsAllowed). */
  private actionsAllowed(): boolean {
    try { return this.d.actionsAllowed?.() !== false; } catch { return false; /* can't tell: no button that might do nothing */ }
  }

  private publish(): void {
    if (this.closed) return;
    this.keepLogs();
    const cards: TaskCard[] = [...this.tasks.values()].map(t => {
      const log = this.logs.get(t.id)?.log;
      const stopping = t.status === "running" && this.stopping.has(t.id);
      return {
        id: t.id,
        title: t.title,
        // A task whose question waits for the user is waiting for them (its card says so), not working.
        status: t.status === "cancelled" ? "stopped" : t.status === "running" && log?.asking && !stopping ? "waiting" : t.status,
        detail: stopping ? TASK_STOPPING : t.detail,
        actions: t.status === "running" || t.status === "queued"
          ? [{ id: `task:${t.id}:stop`, label: "Stop" }]
          : retryable(t) && this.specs.has(t.id) && !this.cutOff && this.actionsAllowed()
            ? [{ id: `task:${t.id}:retry`, label: "Try again" }, { id: `task:${t.id}:dismiss`, label: "Close" }]
            : [{ id: `task:${t.id}:dismiss`, label: "Close" }],
        ...(t.where ? { where: t.where } : {}),
        // While it works: how, its plan and its live view. Once it ended: what it found or made, and its plan (each step as it got).
        ...(t.hand && (t.status === "running" || t.status === "queued") ? { hand: t.hand } : {}),
        ...(t.plan?.length ? { plan: t.status === "done" ? t.plan.map(p => ({ ...p, state: "done" as const })) : t.plan } : {}),
        ...(t.view ? { viewRev: t.view.rev } : {}),
        ...(log ? { activity: log.card() } : {}),
        ...(t.status === "cancelled" && t.endedBy === "expired" ? { unanswered: true as const } : {}),
      };
    });
    this.d.setCards(cards);
  }
}
