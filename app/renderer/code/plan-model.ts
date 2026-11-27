/**
 * The Plan tab's logic, with no DOM: the SDK's `plan.read`, its to-dos with their dependencies
 * (`plan.readSqlTodosWithDependencies`, or `plan.readSqlTodos` without them), the Autopilot objective
 * (`autopilotObjective.getState` and the objective file), and the exit-plan-mode request main has waiting. Results are
 * `unknown` and narrowed field by field; the to-do table is the agent's own and best-effort, so every field may be
 * missing. Tested in test/unit/code-plan-model.test.ts.
 */
import { CODE_LIMITS, type CodePendingRequest } from "../../shared/code";
import { pendingOf, type CodeState } from "./store";
import type { RequestItem } from "./transcript";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === "string" && (o[k] as string).trim() ? o[k] as string : undefined);

/** `PlanReadResult` read: null when it isn't one. */
export interface PlanFile { exists: boolean; content: string }
export function planFrom(value: unknown): PlanFile | null {
  if (!isObj(value) || typeof value.exists !== "boolean") return null;
  return { exists: value.exists && typeof value.content === "string", content: typeof value.content === "string" ? value.content : "" };
}

/** A to-do's state, from the agent's free-form `status`. */
export type TodoStatus = "pending" | "in-progress" | "done" | "blocked" | "skipped" | "other";
export function todoStatus(raw: string | undefined): TodoStatus {
  const s = (raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!s || s === "pending" || s === "todo" || s === "to-do" || s === "not-started" || s === "open" || s === "new") return "pending";
  if (s === "in-progress" || s === "doing" || s === "active" || s === "started" || s === "running" || s === "working") return "in-progress";
  if (s === "done" || s === "completed" || s === "complete" || s === "finished" || s === "closed") return "done";
  if (s === "blocked" || s === "waiting") return "blocked";
  if (s === "cancelled" || s === "canceled" || s === "skipped" || s === "dropped" || s === "wont-do") return "skipped";
  return "other";
}
/** The shared state symbol each to-do state is drawn with (ember.css `[data-status]`). */
export const TODO_SYMBOL: Readonly<Record<TodoStatus, string>> = { pending: "queued", "in-progress": "running", done: "done", blocked: "stopped", skipped: "stopped", other: "queued" };

export interface Todo {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  /** The agent's own word, when Ember has no name for it. */
  rawStatus?: string;
  /** What it waits for: other to-dos, by their titles (or ids, when the table doesn't have them). */
  after: string[];
  /** Whether everything it waits for is done. */
  ready: boolean;
}
export interface TodoList { todos: Todo[]; withDependencies: boolean }

/** `PlanReadSqlTodosWithDependenciesResult` (or `PlanReadSqlTodosResult`) read, in the table's order. */
export function todosFrom(value: unknown, withDependencies: boolean): TodoList | null {
  if (!isObj(value) || !Array.isArray(value.rows)) return null;
  const rows = value.rows.filter(isObj);
  const todos: Todo[] = rows.map((r, i) => {
    const raw = str(r, "status");
    const status = todoStatus(raw);
    return {
      id: str(r, "id") ?? `#${i + 1}`, title: str(r, "title") ?? str(r, "description") ?? str(r, "id") ?? `#${i + 1}`,
      ...(str(r, "description") && str(r, "title") ? { description: str(r, "description") } : {}),
      status, ...(status === "other" && raw ? { rawStatus: raw } : {}), after: [], ready: true,
    };
  });
  const byId = new Map(todos.map(t => [t.id, t]));
  const deps = Array.isArray(value.dependencies) ? value.dependencies.filter(isObj) : [];
  for (const d of deps) {
    const t = byId.get(str(d, "todoId") ?? "");
    const on = str(d, "dependsOn");
    if (!t || !on || on === t.id) continue;
    const other = byId.get(on);
    const name = other?.title ?? on;
    if (!t.after.includes(name)) t.after.push(name);
    if (!other || (other.status !== "done" && other.status !== "skipped")) t.ready = false;
  }
  return { todos, withDependencies };
}

/** How far the list has got: done (and skipped) out of all. */
export function todoProgress(list: readonly Todo[]): { done: number; total: number } {
  return { done: list.filter(t => t.status === "done" || t.status === "skipped").length, total: list.length };
}

export type ObjectiveStatus = "active" | "paused" | "completed" | "other";
export interface Objective {
  /** The objective file's text (null: none). */
  content: string | null;
  /** The runtime's state of it (null: no objective running; undefined: not read). */
  state?: { id: number; objective: string; status: ObjectiveStatus; turns: number; pauseReason?: string; summary?: string } | null;
}

/** `AutopilotObjectiveGetStateResult` read; undefined when it isn't one. */
export function objectiveStateFrom(value: unknown): Objective["state"] {
  if (!isObj(value) || !("state" in value)) return undefined;
  const s = value.state;
  if (s === null) return null;
  if (!isObj(s)) return undefined;
  const st = s.status;
  return {
    id: typeof s.id === "number" ? s.id : 0, objective: typeof s.objective === "string" ? s.objective : "",
    status: st === "active" || st === "paused" || st === "completed" ? st : "other",
    turns: typeof s.turnCount === "number" && s.turnCount >= 0 ? s.turnCount : 0,
    ...(str(s, "pauseReason") ? { pauseReason: str(s, "pauseReason") } : {}),
    ...(str(s, "completionSummary") ? { summary: str(s, "completionSummary") } : {}),
  };
}
/** `WorkspacesReadAutopilotObjectiveResult` read; undefined when it isn't one. */
export function objectiveFileFrom(value: unknown): string | null | undefined {
  if (!isObj(value) || !("content" in value)) return undefined;
  return typeof value.content === "string" ? value.content : null;
}
/** The objective's words to show and edit: the file's, else the runtime's. */
export function objectiveText(o: Objective): string {
  return (o.content ?? "").trim() ? o.content! : o.state?.objective ?? "";
}

/** Whether `text` fits one RPC call's params, as main bounds them (bytes of the JSON, with room for the rest). */
export function fitsParams(text: string): boolean {
  return new TextEncoder().encode(JSON.stringify({ content: text })).length <= CODE_LIMITS.params - 256;
}

/** The exit-plan-mode request main has waiting in `sessionId`, if one is (the oldest, when more are). */
export function pendingPlanExit(s: CodeState, sessionId: string | null): CodePendingRequest | null {
  if (!sessionId) return null;
  return pendingOf(s, sessionId).find(p => p.kind === "exit-plan-mode") ?? null;
}

/** The request as a card draws it, from main's pending entry (main's table says what waits, never the events alone). */
export function requestItemOf(p: CodePendingRequest): RequestItem {
  return { kind: "request", key: `plan-tab-${p.requestId}`, requestId: p.requestId, request: p.kind, data: p.data, done: false };
}
