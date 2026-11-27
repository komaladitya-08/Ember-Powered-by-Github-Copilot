/**
 * The Plan tab's words: pure, in sentence case and British spelling, curly double quotes round names, "…" on what
 * opens something. Never the SDK's own error text: main's refusals (already sentences) follow Ember's lead. Pinned in
 * test/unit/code-plan-copy.test.ts.
 */
import type { ObjectiveStatus, TodoStatus } from "./plan-model";

const n = (k: number) => k.toLocaleString("en-GB");

export const TAB_MARK = "needs you";
export const WAITING_HEADING = "Waiting for you";
export const WAITING_HINT = "The same question is in the conversation: answer it in either place.";

// ───── The plan file ─────
export const PLAN_HEADING = "Plan";
export const PLAN_NONE = "Copilot hasn't written a plan for this session.";
export const PLAN_NONE_HINT = "In Plan mode, Copilot writes its plan here before it changes anything.";
export const PLAN_WRITE = "Write a plan";
export const PLAN_EDIT = "Edit";
export const PLAN_SAVE = "Save plan";
export const PLAN_DELETE = "Delete plan…";
export const PLAN_EDITOR = "The plan, in Markdown";
export const PLAN_DOC = "The plan";
export const PLAN_CHANGED = "Copilot changed the plan while you were editing it. Saving puts your version in its place.";
export const PLAN_SAVED = "Plan saved.";
export const PLAN_DELETED = "Plan deleted.";
export const PLAN_TOO_LONG = "The plan is too long to save from here.";
export const DELETE_PLAN_QUESTION = "Delete the plan?";
export const DELETE_PLAN_DETAIL = "The session's plan file is removed, and Copilot no longer has it to work from. This can't be undone.";
export const DELETE = "Delete";
export const KEEP = "Keep it";
export const CANCEL = "Cancel";
export const SAVING = "Saving…";

// ───── To-dos ─────
export const TODOS_HEADING = "To-dos";
export const TODOS_NONE = "Copilot hasn't made a to-do list for this session.";
export function todoProgress(done: number, total: number): string { return `${n(done)} of ${n(total)} done`; }
export const TODO_STATUS: Readonly<Record<TodoStatus, string>> = { pending: "Not started", "in-progress": "In progress", done: "Done", blocked: "Blocked", skipped: "Skipped", other: "Other" };
export function todoStatusWord(status: TodoStatus, raw?: string): string { return status === "other" && raw ? raw : TODO_STATUS[status]; }
export function afterWords(titles: readonly string[]): string { return `After ${titles.map(t => `“${t}”`).join(", ")}`; }
export const WAITS = "Waits for the to-dos before it";
export const NO_DEPENDENCIES = "Dependencies between to-dos aren't available here, so they aren't shown.";

// ───── The Autopilot objective ─────
export const OBJECTIVE_HEADING = "Autopilot objective";
export const OBJECTIVE_NONE = "No objective is set.";
export const OBJECTIVE_NONE_HINT = "On Autopilot, Copilot keeps working toward its objective until it's met.";
export const OBJECTIVE_SET = "Set an objective";
export const OBJECTIVE_EDIT = "Edit";
export const OBJECTIVE_SAVE = "Save objective";
export const OBJECTIVE_DELETE = "Delete objective…";
export const OBJECTIVE_EDITOR = "The objective";
export const OBJECTIVE_STATUS: Readonly<Record<ObjectiveStatus, string>> = { active: "Working toward it", paused: "Paused", completed: "Met", other: "Set" };
export function objectiveTurns(k: number): string { return k ? `${n(k)} ${k === 1 ? "turn" : "turns"} so far` : "Not started yet"; }
export function pausedBecause(reason: string): string { return `Paused: ${reason}`; }
export function metSummary(summary: string): string { return `What was done: ${summary}`; }
export const OBJECTIVE_SAVED = "Objective saved.";
export const OBJECTIVE_DELETED = "Objective deleted.";
export const OBJECTIVE_TOO_LONG = "The objective is too long to save from here.";
export const OBJECTIVE_EMPTY = "Write the objective first.";
export const DELETE_OBJECTIVE_QUESTION = "Delete the objective?";
export const DELETE_OBJECTIVE_DETAIL = "Autopilot stops working toward it. This can't be undone.";
export const OBJECTIVE_CHANGED = "The objective changed while you were editing it. Saving puts your version in its place.";

/** A refusal or failure, in Ember's words, with main's sentence after. */
export function readFailed(what: "plan" | "todos" | "objective", reason: string): string {
  const lead = what === "plan" ? "Ember couldn't read the plan." : what === "todos" ? "Ember couldn't read the to-dos." : "Ember couldn't read the Autopilot objective.";
  return `${lead} ${reason}`.trim();
}
export function writeFailed(what: "plan" | "objective", act: "save" | "delete", reason: string): string {
  return `Ember couldn't ${act} the ${what === "plan" ? "plan" : "objective"}. ${reason}`.trim();
}
/** A method the window's allow-list doesn't have yet. */
export function notAvailable(what: "todos" | "objective"): string {
  return what === "todos" ? "To-dos can't be read in this window yet." : "The Autopilot objective can't be read in this window yet.";
}
