/**
 * The Agents and tasks tab's model (app/renderer/code/tasks-model.ts): tasks.list read into rows with what each may do,
 * progress merged in, the running count on the tab, elapsed time, this turn's sub-agents, the agents that can be
 * started and the scheduled prompts.
 */
import { describe, expect, it } from "vitest";
import type { CodeSdkEvent } from "../../app/shared/code";
import {
  agentTypes, elapsedMs, progressLine, runningCount, said, scheduleRows, taskRow, taskRows, taskSignal, turnSubAgents, withProgress,
} from "../../app/renderer/code/tasks-model";
import { EMPTY_TRANSCRIPT, reduceEvent, type Transcript } from "../../app/renderer/code/transcript";

let n = 0;
const ev = (type: string, data: unknown, agentId?: string): CodeSdkEvent => ({ id: `k${++n}`, timestamp: "2026-11-27T10:00:00Z", type, data, ...(agentId ? { agentId } : {}) });
const play = (...events: CodeSdkEvent[]): Transcript => events.reduce(reduceEvent, EMPTY_TRANSCRIPT);

const LIST = { tasks: [
  { type: "agent", id: "a1", toolCallId: "tc1", displayName: "Explore auth", description: "Look at auth", status: "idle", startedAt: "2026-11-27T10:00:00Z", agentType: "explore", prompt: "p", model: "m1", resolvedModel: "m2", executionMode: "background", canPromoteToBackground: false },
  { type: "shell", id: "s1", description: "Watch", command: "npm test -- --watch", status: "running", startedAt: "2026-11-27T10:01:00Z", attachmentMode: "detached" },
  { type: "agent", id: "a0", toolCallId: "tc0", description: "Done one", status: "completed", startedAt: "2026-11-27T09:00:00Z", completedAt: "2026-11-27T09:01:00Z", agentType: "task", prompt: "p", executionMode: "sync", canPromoteToBackground: true },
  { type: "client", id: "c1", clientTaskId: "x", description: "Extension work", status: "running", canCancel: false, startedAt: "2026-11-27T10:02:00Z", activeTimeMs: 3000, owner: {}, executionMode: "background", sequence: 1, updatedAt: "" },
  { type: "mystery", id: "z" },
  { id: "" },
] };

describe("the session's background tasks", () => {
  it("reads tasks.list running first, then waiting, then finished, with what each may do", () => {
    const rows = taskRows(LIST);
    expect(rows.map(r => [r.id, r.kind, r.state])).toEqual([["c1", "client", "running"], ["s1", "shell", "running"], ["a1", "agent", "idle"], ["a0", "agent", "completed"]]);
    const [client, shell, idle, done] = rows;
    expect(idle).toMatchObject({ name: "Explore auth", model: "m2", agentType: "explore", canMessage: true, canCancel: true, canRemove: false, background: true });
    expect(shell).toMatchObject({ name: "npm test -- --watch", command: "npm test -- --watch", canMessage: false, canCancel: true, background: true });
    expect(done).toMatchObject({ name: "Done one", canRemove: true, canCancel: false, canMessage: false, canPromote: true, background: false });
    // A client task is cancelled only where its owner can hear it.
    expect(client).toMatchObject({ canCancel: false, canMessage: false });
  });

  it("puts progress's latest line on a running task: an agent's intent, a shell's last line, a client's message", () => {
    expect(progressLine({ progress: { type: "agent", recentActivity: [{ message: "▸ bash" }], latestIntent: "Reading" } })).toBe("Reading");
    expect(progressLine({ progress: { type: "agent", recentActivity: [{ message: "a" }, { message: "✓ edit" }] } })).toBe("✓ edit");
    expect(progressLine({ progress: { type: "shell", recentOutput: "one\ntwo\n\n" } })).toBe("two");
    expect(progressLine({ progress: { type: "client", lastMessage: "Half way", recentActivity: [] } })).toBe("Half way");
    expect(progressLine({ progress: null })).toBeUndefined();
    expect(withProgress(taskRows(LIST), { s1: "two" }).find(r => r.id === "s1")?.doing).toBe("two");
  });

  it("counts what runs: background tasks running, and the turn's running sub-agents not among them", () => {
    const rows = taskRows(LIST);
    expect(runningCount(rows, [])).toBe(2);
    const sub = (toolCallId: string, state: "running" | "done") => ({ key: toolCallId, toolCallId, name: "x", state });
    expect(runningCount(rows, [sub("tc9", "running"), sub("tc1", "running"), sub("tc8", "done")])).toBe(3);
  });

  it("times a task by its active time while it works, else from start to end", () => {
    const now = Date.parse("2026-11-27T10:00:10Z");
    expect(elapsedMs({ state: "running", activeMs: 3000, activeSince: "2026-11-27T10:00:05Z" }, now)).toBe(8000);
    expect(elapsedMs({ state: "idle", activeMs: 3000, activeSince: "2026-11-27T10:00:05Z" }, now)).toBe(3000);
    expect(elapsedMs({ state: "completed", startedAt: "2026-11-27T09:00:00Z", completedAt: "2026-11-27T09:01:00Z" }, now)).toBe(60_000);
    expect(elapsedMs({ state: "running", startedAt: "2026-11-27T10:00:00Z" }, now)).toBe(10_000);
    expect(elapsedMs({ state: "running" }, now)).toBeUndefined();
  });

  it("reads getCurrentPromotable's task, and the SDK's yes as `{ field: true }` only", () => {
    expect(taskRow({ type: "agent", id: "p", description: "d", status: "running", canPromoteToBackground: true })?.canPromote).toBe(true);
    expect(taskRow(undefined)).toBeNull();
    expect(said({ cancelled: true }, "cancelled")).toBe(true);
    expect(said({ cancelled: "yes" }, "cancelled")).toBe(false);
  });
});

describe("this turn's sub-agents", () => {
  const t = play(
    ev("user.message", { content: "first" }),
    ev("tool.execution_start", { toolCallId: "old", toolName: "task" }),
    ev("subagent.started", { toolCallId: "old", agentName: "explore", agentDisplayName: "Old", agentDescription: "d" }, "x0"),
    ev("subagent.completed", { toolCallId: "old", agentName: "explore", agentDisplayName: "Old" }),
    ev("user.message", { content: "second" }),
    ev("tool.execution_start", { toolCallId: "new", toolName: "task" }),
    ev("subagent.started", { toolCallId: "new", agentName: "explore", agentDisplayName: "Explore", agentDescription: "Find redirects", model: "mini" }, "x1"),
  );
  it("lists the sub-agents since the person's last message, with their row's key", () => {
    expect(turnSubAgents(t)).toEqual([{ key: expect.any(String), toolCallId: "new", name: "Explore", description: "Find redirects", model: "mini", state: "running" }]);
    expect(turnSubAgents(undefined)).toEqual([]);
  });
  it("changes its signal when a sub-agent starts or ends, or the SDK says background tasks changed", () => {
    const a = taskSignal(t);
    const b = taskSignal(reduceEvent(t, ev("subagent.completed", { toolCallId: "new", agentName: "explore", agentDisplayName: "Explore" })));
    const c = taskSignal(reduceEvent(t, ev("session.background_tasks_changed", {})));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("starting agents and schedules", () => {
  it("offers only the agents a person may start", () => {
    expect(agentTypes({ agents: [
      { id: "explore", name: "explore", displayName: "Explore", description: "Looks" },
      { id: "hidden", name: "hidden", displayName: "Hidden", description: "", userInvocable: false },
      { name: "named", displayName: "Named", description: "" },
    ] })).toEqual([{ id: "explore", name: "Explore", description: "Looks" }, { id: "named", name: "Named", description: "" }]);
  });
  it("reads schedule.list's entries by their number", () => {
    expect(scheduleRows({ entries: [{ id: 2, prompt: "/review", displayPrompt: "Review", recurring: true, intervalMs: 60_000, nextRunAt: "2026-11-27T10:00:00Z" }, { prompt: "no id" }] }))
      .toEqual([{ id: 2, prompt: "Review", recurring: true, selfPaced: false, intervalMs: 60_000, nextRunAt: "2026-11-27T10:00:00Z" }]);
  });
});
