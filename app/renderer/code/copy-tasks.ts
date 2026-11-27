/**
 * The Agents and tasks tab's words, as pure functions: sentence case, British spelling, curly quotes round names, and
 * plain sentences in place of anything the SDK said. Pinned in test/unit/code-tasks-copy.test.ts.
 */
import { duration } from "./copy-terminal";
import type { ScheduleRow, TaskKind, TaskState } from "./tasks-model";

export const TAB_LABEL = "Agents and tasks";
export const BACKGROUND_HEADING = "In the background";
export const TURN_HEADING = "This turn's sub-agents";
export const START_HEADING = "Start an agent";
export const SCHEDULES_HEADING = "Schedules";
export const NO_TASKS = "Nothing is running in the background.";
export const NO_SUB_AGENTS = "Copilot hasn't started a sub-agent in this turn.";
export const NO_SCHEDULES = "No prompts are scheduled.";
export const LOADING_TASKS = "Reading the session's tasks…";
export const TASKS_FAILED = "The session's tasks couldn't be read. Try again.";

export const SEND_MESSAGE = "Message…";
export const SEND = "Send";
export const CANCEL_TASK = "Cancel";
export const REMOVE_TASK = "Remove";
export const MOVE_TO_BACKGROUND = "Move to background";
export const PROMOTE_CURRENT = "Move the current work to the background";
export const SHOW_IN_TRANSCRIPT = "Show in transcript";
export const STOP_SCHEDULE = "Stop";
export const CLOSE = "Close";

export const AGENT_TYPE = "Agent";
export const AGENT_PROMPT = "What should it do?";
export const AGENT_NAME = "Name";
export const START_AGENT = "Start agent";
export const FLEET = "Fleet…";
export const FLEET_PROMPT = "What should the fleet do?";
export const START_FLEET = "Start fleet";
export const FLEET_WHAT = "Copilot splits the work between several agents that run at once.";
export const NO_AGENT_TYPES = "No agents can be started in this session.";

/** A task's state in words (beside its mark). */
export function stateWords(state: TaskState | "done"): string {
  switch (state) {
    case "running": return "Running";
    case "idle": return "Waiting for a message";
    case "completed": case "done": return "Finished";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    case "orphaned": return "Lost touch";
  }
}
/** A state as the design system's mark (`data-status`). */
export function stateMark(state: TaskState | "done"): "running" | "waiting" | "done" | "failed" | "stopped" | "queued" {
  switch (state) {
    case "running": return "running";
    case "idle": return "waiting";
    case "completed": case "done": return "done";
    case "failed": return "failed";
    case "cancelled": return "stopped";
    case "orphaned": return "queued";
  }
}

/** A task's kind in words. */
export const kindWords = (kind: TaskKind, agentType?: string): string =>
  kind === "agent" ? (agentType ? `Agent: ${agentType}` : "Agent") : kind === "shell" ? "Command" : "Task from an extension";

/** A row's line of facts: kind, model, time. */
export function taskFacts(kind: TaskKind, agentType: string | undefined, model: string | undefined, ms: number | undefined): string {
  return [kindWords(kind, agentType), model, ms !== undefined ? duration(ms) : undefined].filter(Boolean).join(" · ");
}

/** The tab's name for screen readers with its count. */
export const tabLabel = (running: number): string => (running ? `${TAB_LABEL}, ${running} running` : TAB_LABEL);

/** Buttons' full names. */
export const cancelLabel = (name: string): string => `Cancel “${name}”`;
export const removeLabel = (name: string): string => `Remove “${name}”`;
export const messageLabel = (name: string): string => `Send “${name}” a message`;
export const promoteLabel = (name: string): string => `Move “${name}” to the background`;
export const showLabel = (name: string): string => `Show “${name}” in the transcript`;
export const stopScheduleLabel = (prompt: string): string => `Stop the schedule “${prompt.length > 50 ? `${prompt.slice(0, 49)}…` : prompt}”`;
export const messageFieldLabel = (name: string): string => `Message for “${name}”`;

/** A sub-agent's row facts. */
export function subAgentFacts(model: string | undefined, steps: number | undefined, ms: number | undefined): string {
  return [model, steps !== undefined ? `${steps} ${steps === 1 ? "step" : "steps"}` : undefined, ms !== undefined ? duration(ms) : undefined].filter(Boolean).join(" · ");
}

/** When a schedule runs, in words. */
export function scheduleWhen(r: ScheduleRow): string {
  const next = r.nextRunAt && Number.isFinite(Date.parse(r.nextRunAt)) ? `next at ${new Date(r.nextRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
  let how: string;
  if (r.selfPaced) how = "When Copilot chooses";
  else if (r.intervalMs !== undefined) how = `Every ${duration(r.intervalMs)}`;
  else if (r.cron) how = `On a schedule (${r.cron})`;
  else how = r.recurring ? "Again and again" : "Once";
  return next ? `${how}, ${next}` : how;
}

// Outcomes, as plain sentences (never the SDK's own text).
export const CANT_CANCEL = "That task couldn't be cancelled. It may have finished.";
export const CANT_REMOVE = "That task couldn't be removed. Cancel it first.";
export const CANT_SEND = "The message didn't reach that agent. It may have finished.";
export const CANT_PROMOTE = "That work couldn't be moved to the background.";
export const CANT_START = "That agent couldn't start. Try again.";
export const CANT_FLEET = "The fleet couldn't start. Try again.";
export const CANT_STOP_SCHEDULE = "That schedule couldn't be stopped. It may have run already.";
export const STARTED = (name: string): string => `“${name}” started.`;
export const FLEET_STARTED = "The fleet started.";
export const SENT = (name: string): string => `Sent to “${name}”.`;
export const NEEDS_PROMPT = "Say what it should do first.";
export const NEEDS_NAME = "Give it a name first.";
