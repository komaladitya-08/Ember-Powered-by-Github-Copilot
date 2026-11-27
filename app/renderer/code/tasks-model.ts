/**
 * The Agents and tasks tab's model, as pure functions: the SDK's `tasks.list` (background agents, background shells and
 * client-owned tasks) read into rows, with `tasks.getProgress`'s latest line merged in; the current turn's sub-agents
 * from the transcript; the agents `agent.list` offers to start; and `schedule.list`'s scheduled prompts. No DOM and no
 * IPC: panel-tasks.ts draws it, test/unit/code-tasks.test.ts tests it.
 *
 * Nothing here decides for the person: what a row may do (send a message, cancel, remove, move to the background) is
 * what the SDK's own fields say it may (`status`, `canPromoteToBackground`, a client task's `canCancel`).
 */
import { arr, bool, num, rec, str } from "./sdk";
import type { Transcript } from "./transcript";

/** A task's state, in the SDK's words (a client task's "orphaned" kept as it is). */
export type TaskState = "running" | "idle" | "completed" | "failed" | "cancelled" | "orphaned";
export type TaskKind = "agent" | "shell" | "client";

/** One row of the tab. */
export interface TaskRow {
  id: string;
  kind: TaskKind;
  name: string;
  description: string;
  state: TaskState;
  /** The agent type an agent task runs ("explore", "task", a custom agent). */
  agentType?: string;
  model?: string;
  /** A shell task's command. */
  command?: string;
  /** What it is doing now: progress's latest intent or line, else the agent's latest response. */
  doing?: string;
  startedAt?: string;
  completedAt?: string;
  /** Accumulated active time (agent and client tasks), and when the current active period began. */
  activeMs?: number;
  activeSince?: string;
  /** The tool call that started it (an agent task): its row in the transcript. */
  toolCallId?: string;
  background: boolean;
  canPromote: boolean;
  /** Whether Cancel is offered: running or idle (a client task only when its owner can receive it). */
  canCancel: boolean;
  /** Whether Remove is offered: finished (completed, failed or cancelled). */
  canRemove: boolean;
  /** Whether a message can be sent to it: an agent task that is running or idle. */
  canMessage: boolean;
  /** Its result or error, as the SDK sent them (shown as the task's own words, never as Ember's). */
  result?: string;
  error?: string;
}

const STATES = new Set<TaskState>(["running", "idle", "completed", "failed", "cancelled", "orphaned"]);
const live = (s: TaskState) => s === "running" || s === "idle";
const finished = (s: TaskState) => s === "completed" || s === "failed" || s === "cancelled";

/** One task of `tasks.list` (or `getCurrentPromotable`'s), read; null for one with no id or kind. */
export function taskRow(t: unknown): TaskRow | null {
  const id = str(t, "id"), type = str(t, "type");
  if (!id || (type !== "agent" && type !== "shell" && type !== "client")) return null;
  const raw = str(t, "status") ?? "running";
  const state: TaskState = STATES.has(raw as TaskState) ? (raw as TaskState) : "running";
  const description = str(t, "description", true) ?? "";
  const name = str(t, "displayName") ?? (type === "shell" ? str(t, "command") ?? description : description || str(t, "agentType") || id);
  const result = type === "client" ? undefined : str(t, "result");
  return {
    id, kind: type, name, description, state,
    ...(str(t, "agentType") ? { agentType: str(t, "agentType") } : {}),
    ...(str(t, "resolvedModel") ?? str(t, "model") ? { model: str(t, "resolvedModel") ?? str(t, "model") } : {}),
    ...(type === "shell" && str(t, "command") ? { command: str(t, "command") } : {}),
    ...(type === "agent" && str(t, "latestResponse") ? { doing: str(t, "latestResponse") } : {}),
    ...(str(t, "startedAt") ? { startedAt: str(t, "startedAt") } : {}),
    ...(str(t, "completedAt") ? { completedAt: str(t, "completedAt") } : {}),
    ...(num(t, "activeTimeMs") !== undefined ? { activeMs: num(t, "activeTimeMs") } : {}),
    ...(str(t, "activeStartedAt") ? { activeSince: str(t, "activeStartedAt") } : {}),
    ...(str(t, "toolCallId") ? { toolCallId: str(t, "toolCallId") } : {}),
    background: type === "client" || str(t, "executionMode") === "background" || (type === "shell" && str(t, "executionMode") !== "sync"),
    canPromote: bool(t, "canPromoteToBackground") ?? false,
    canCancel: live(state) && (type !== "client" || (bool(t, "canCancel") ?? false)),
    canRemove: finished(state),
    canMessage: type === "agent" && live(state),
    ...(result ? { result } : {}),
    ...(str(t, "error") ? { error: str(t, "error") } : {}),
  };
}

/** `tasks.list`'s tasks, read: running first, then idle, then the finished ones, each the latest first. */
export function taskRows(result: unknown): TaskRow[] {
  const order: Readonly<Record<TaskState, number>> = { running: 0, idle: 1, orphaned: 2, failed: 3, completed: 4, cancelled: 5 };
  return arr(result, "tasks").map(taskRow).filter((r): r is TaskRow => !!r)
    .sort((a, b) => order[a.state] - order[b.state] || (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0));
}

/** `tasks.getProgress`'s latest word on a task: an agent's latest intent or activity line, a shell's last output line, a client's message. */
export function progressLine(result: unknown): string | undefined {
  const p = rec(rec(result)?.progress);
  if (!p) return undefined;
  const type = str(p, "type");
  if (type === "agent") return str(p, "latestIntent") ?? str(arr(p, "recentActivity").at(-1), "message");
  if (type === "shell") return (str(p, "recentOutput", true) ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
  if (type === "client") return str(p, "lastMessage") ?? str(p, "phase");
  return undefined;
}

/** Rows with the progress lines read for them (by task id). */
export function withProgress(rows: readonly TaskRow[], lines: Readonly<Record<string, string | undefined>>): TaskRow[] {
  return rows.map(r => (lines[r.id] ? { ...r, doing: lines[r.id] } : r));
}

/** How many tasks are running (the tab's count): background tasks running, and the turn's sub-agents running that aren't among them. */
export function runningCount(rows: readonly TaskRow[], subAgents: readonly SubAgentRow[]): number {
  const calls = new Set(rows.map(r => r.toolCallId).filter(Boolean));
  return rows.filter(r => r.state === "running").length + subAgents.filter(a => a.state === "running" && !calls.has(a.toolCallId)).length;
}

/**
 * How long a task has been at work at `now`: its accumulated active time plus the current active period, else from its
 * start to its end (or now while it runs). Undefined when the SDK gave no times.
 */
export function elapsedMs(r: Pick<TaskRow, "state" | "startedAt" | "completedAt" | "activeMs" | "activeSince">, now: number): number | undefined {
  if (r.activeMs !== undefined) {
    const since = r.activeSince ? Date.parse(r.activeSince) : NaN;
    return r.activeMs + (r.state === "running" && Number.isFinite(since) ? Math.max(0, now - since) : 0);
  }
  const start = r.startedAt ? Date.parse(r.startedAt) : NaN;
  if (!Number.isFinite(start)) return undefined;
  const end = r.completedAt ? Date.parse(r.completedAt) : live(r.state) ? now : NaN;
  return Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

// ───── The current turn's sub-agents ─────

/** A sub-agent the model started with a tool call, from the transcript. */
export interface SubAgentRow { key: string; toolCallId: string; name: string; description?: string; model?: string; state: "running" | "done" | "failed" | "cancelled"; durationMs?: number; steps?: number }

/** The sub-agents of the latest turn (from the person's last message on), in order. */
export function turnSubAgents(t: Transcript | undefined): SubAgentRow[] {
  if (!t) return [];
  let from = 0;
  for (let n = t.items.length - 1; n >= 0; n--) if (t.items[n].kind === "user" && !t.items[n].owner) { from = n; break; }
  return t.items.slice(from).flatMap(i => (i.kind === "tool" && i.agent ? [{
    key: i.key, toolCallId: i.toolCallId, name: i.agent.displayName, ...(i.agent.description ? { description: i.agent.description } : {}),
    ...(i.agent.model ? { model: i.agent.model } : {}), state: i.agent.state,
    ...(i.agent.durationMs !== undefined ? { durationMs: i.agent.durationMs } : {}), ...(i.agent.totalToolCalls !== undefined ? { steps: i.agent.totalToolCalls } : {}),
  }] : []));
}

/** What the tab's lists depend on in a transcript, so it reads `tasks.list` again only when one of them changed. */
export function taskSignal(t: Transcript | undefined): string {
  if (!t) return "";
  const agents = t.items.filter(i => i.kind === "tool" && !!i.agent).map(i => (i.kind === "tool" ? `${i.toolCallId}:${i.agent?.state}` : "")).join(",");
  return `${t.versions.background}|${t.busy ? 1 : 0}|${agents}`;
}

// ───── Starting an agent, and schedules ─────

/** An agent `agent.list` offers to start (only those a person may choose: `userInvocable` isn't false). */
export interface AgentType { id: string; name: string; description: string }
export function agentTypes(result: unknown): AgentType[] {
  return arr(result, "agents").flatMap(a => {
    const id = str(a, "id") ?? str(a, "name");
    if (!id || bool(a, "userInvocable") === false) return [];
    return [{ id, name: str(a, "displayName") ?? str(a, "name") ?? id, description: str(a, "description", true) ?? "" }];
  });
}

/** A scheduled prompt of `schedule.list`. */
export interface ScheduleRow { id: number; prompt: string; recurring: boolean; intervalMs?: number; cron?: string; at?: number; selfPaced: boolean; nextRunAt?: string }
export function scheduleRows(result: unknown): ScheduleRow[] {
  return arr(result, "entries").flatMap(e => {
    const id = num(e, "id");
    if (id === undefined) return [];
    return [{
      id, prompt: str(e, "displayPrompt") ?? str(e, "prompt", true) ?? "", recurring: bool(e, "recurring") ?? false, selfPaced: bool(e, "selfPaced") ?? false,
      ...(num(e, "intervalMs") !== undefined ? { intervalMs: num(e, "intervalMs") } : {}), ...(str(e, "cron") ? { cron: str(e, "cron") } : {}),
      ...(num(e, "at") !== undefined ? { at: num(e, "at") } : {}), ...(str(e, "nextRunAt") ? { nextRunAt: str(e, "nextRunAt") } : {}),
    }];
  });
}

/** Whether a promise of the SDK's came true: `{ [field]: true }` (cancelled, removed, sent, promoted, started). */
export const said = (result: unknown, field: string): boolean => bool(result, field) === true;
