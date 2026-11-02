/**
 * The words of Home's "Task activity" (docs/DESIGN.md "Home"): one group per task, newest first, with its state, its
 * plan, a row for each thing it did (steps of one kind in a row folded together, each still listed inside), its
 * questions with how they were answered, and how it ended. Pure functions, unit-tested (home-tasks.test.ts). The words
 * are Ember's own (app/shared/activity.ts), except a note's, the plan's, the summary's and the view's, which are the
 * worker's and are drawn as plain text.
 */

import { STATUS_WORDS, clockText, stepsWords, summarizeActivity, triedWords, type ActivityItem, type ActivityState, type StepGroup, type TaskEntry } from "../../shared/activity";
import { HAND_WORDS } from "../../shared/view";

/** The list while no task has run this session. */
export const TASKS_EMPTY = "No tasks yet. Ask Ember to do something in your apps, with Ask Ember… above, and each step shows here as it happens.";

/** The tag before a note's words: the worker's own, never Ember's voice. */
export const NOTE_TAG = "Note";

/** A row's time: how long after the task started, "0:03", "1:12", "1:02:05" (tabular figures). */
export function offsetText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A row's time for screen readers: "3 seconds in", "1 minute 12 seconds in". */
export function offsetWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `${[m ? unit(m, "minute") : "", s % 60 || !m ? unit(s % 60, "second") : ""].filter(Boolean).join(" ")} in`;
}

/**
 * The line under a task's title: its state, how long it has worked (or took), how it works now and where ("Waiting for
 * you · 1:14 · In the background", "Done · Took 1:12", "Working · Just started · On my desk · on build-01").
 */
export function taskMeta(t: Pick<TaskEntry, "status" | "hand" | "where" | "activity">, now: number): string {
  return [STATUS_WORDS[t.status === "queued" ? "queued" : t.status], clockText(t.activity, now), t.hand ? HAND_WORDS[t.hand] : "", t.where ?? ""]
    .filter(Boolean).join(" · ");
}

/** The steps so far in one sentence (the card's summary), or null before the first step. */
export function stepsLine(t: Pick<TaskEntry, "activity">): string | null {
  return summarizeActivity(t.activity.counts, t.activity.failedSteps);
}

/** One step folded into a row, as listed when the row is opened. */
export interface StepLine { id: string; at: number; state: ActivityState; words: string }

/** One row of a task's timeline. */
export interface TimelineRow {
  /** The first item's id (an opened row stays open across updates by it). */
  id: string;
  at: number;
  state: ActivityState;
  words: string;
  /** A question's decision, under the row. */
  asked?: string;
  /** The worker's own words (a note). */
  model?: true;
  /** Several steps of one kind folded together: each of them, to list when the row is opened. */
  steps?: StepLine[];
}

/**
 * A task's items as rows: steps of one kind and outcome in a row fold into one ("Typed text 6 times in Files"), and
 * open to list each; a step still under way, a question, a note, a refusal and a problem are rows of their own.
 */
export function timelineRows(items: readonly ActivityItem[]): TimelineRow[] {
  const rows: (TimelineRow & { group?: StepGroup; apps?: Set<string> })[] = [];
  for (const it of items) {
    const last = rows.at(-1);
    const folds = it.kind === "step" && it.state !== "running" && !!it.group;
    if (folds && last && last.group === it.group && last.state === it.state) {
      const step: StepLine = { id: it.id, at: it.at, state: it.state, words: it.words };
      last.steps = last.steps ? [...last.steps, step] : [step];
      if (it.app) last.apps!.add(it.app);
      const one = last.apps!.size === 1 ? [...last.apps!][0] : undefined;
      last.words = it.state === "failed" ? triedWords(it.group!, last.steps.length, one) : stepsWords(it.group!, last.steps.length, one);
      continue;
    }
    rows.push({
      id: it.id, at: it.at, state: it.state, words: it.words,
      ...(it.asked ? { asked: it.asked } : {}), ...(it.model ? { model: true as const } : {}),
      ...(folds ? { group: it.group, apps: new Set(it.app ? [it.app] : []), steps: [{ id: it.id, at: it.at, state: it.state, words: it.words }] } : {}),
    });
  }
  return rows.map(({ group: _g, apps: _a, steps, ...r }) => ({ ...r, ...(steps && steps.length > 1 ? { steps } : {}) }));
}

/** The words before a timeline that lost its oldest rows ("12 earlier steps aren't listed"). */
export function droppedText(n: number): string | null {
  return n > 0 ? `${n} earlier ${n === 1 ? "item isn't" : "items aren't"} listed` : null;
}

/** What the screen reader hears when a task's state changes (once per change, from the polite live region). */
export function taskAnnouncement(title: string, status: TaskEntry["status"]): string {
  return `${title}: ${STATUS_WORDS[status]}`;
}

/** Which tasks the list shows, once there are many (TASK_FILTER_FROM): all, those that need the user, at work, ended. */
export type TaskFilter = "all" | "needs" | "working" | "ended";
export const TASK_FILTER_FROM = 5;
export const TASK_FILTERS: readonly { id: TaskFilter; label: string }[] = [
  { id: "all", label: "All" }, { id: "needs", label: "Needs you" }, { id: "working", label: "Working" }, { id: "ended", label: "Ended" },
];
/** What the list says when the filter leaves nothing. */
export const FILTER_EMPTY = "No tasks here. Choose All to see every task.";

const IN_FILTER: Readonly<Record<TaskFilter, (s: TaskEntry["status"]) => boolean>> = {
  all: () => true,
  needs: s => s === "waiting",
  working: s => s === "running" || s === "queued",
  ended: s => s === "done" || s === "failed" || s === "stopped",
};

/** The tasks a filter shows, in the list's order. */
export function filterTasks<T extends Pick<TaskEntry, "status">>(tasks: readonly T[], f: TaskFilter): T[] {
  return tasks.filter(t => IN_FILTER[f](t.status));
}

/** A filter's button: its name and how many it shows ("Needs you (1)"); All has no count. */
export function filterLabel(f: TaskFilter, tasks: readonly Pick<TaskEntry, "status">[]): string {
  const label = TASK_FILTERS.find(x => x.id === f)!.label;
  return f === "all" ? label : `${label} (${filterTasks(tasks, f).length})`;
}
