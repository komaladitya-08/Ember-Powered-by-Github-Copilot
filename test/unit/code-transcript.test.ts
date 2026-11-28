/**
 * The coding window's transcript reducers (app/renderer/code/transcript.ts): each SDK event type the window draws, the
 * events it only keeps state for, unknown events kept folded, sub-agent nesting, idempotent replay, gaps and attach.
 */
import { describe, expect, it } from "vitest";
import type { CodeEventEnvelope, CodeSdkEvent } from "../../app/shared/code";
import {
  EMPTY_TRANSCRIPT, OUTPUT_KEEP, applyEnvelope, attachedTranscript, itemsOf, reduceEvent, requestOpened, requestResolved, sendRefused, sendTaken,
  sentLocally, type AssistantItem, type HookItem, type Item, type NoteItem, type ProblemItem, type ReasoningItem, type RequestItem, type ToolItem,
  type Transcript, type UserItem,
} from "../../app/renderer/code/transcript";

let n = 0;
const ev = (type: string, data: unknown, extra: Partial<CodeSdkEvent> = {}): CodeSdkEvent => ({ id: `e${++n}`, timestamp: "2026-11-27T10:00:00Z", type, data, ...extra });
const play = (...events: CodeSdkEvent[]): Transcript => events.reduce(reduceEvent, EMPTY_TRANSCRIPT);
const only = <K extends Item["kind"]>(t: Transcript, kind: K) => t.items.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind);
const envs = (sid: string, events: CodeSdkEvent[], from = 1): CodeEventEnvelope[] => events.map((event, i) => ({ sessionId: sid, seq: from + i, event }));

describe("the coding transcript, message by message", () => {
  it("shows the person's message, and matches the one sent from the window to the SDK's user.message", () => {
    let t = sentLocally(EMPTY_TRANSCRIPT, "you1", "Fix it", ["a.ts"], undefined);
    t = sendTaken(t, "you1", "m-1");
    t = reduceEvent(t, ev("user.message", { content: "Fix it", messageId: "m-1", attachments: [{ type: "file", path: "/x/src/a.ts" }] }));
    const users = only(t, "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ key: "you1", text: "Fix it", attachments: ["a.ts"], messageId: "m-1" });
    expect(users[0].local).toBeUndefined();
  });

  it("says why a message didn't go, on its own row", () => {
    const t = sendRefused(sentLocally(EMPTY_TRANSCRIPT, "you1", "Fix it", []), "you1", "The session has ended.");
    expect((t.items[0] as UserItem).problem).toBe("The session has ended.");
  });

  it("streams Copilot's words by message id and settles them with the whole message", () => {
    const t = play(
      ev("assistant.turn_start", { turnId: "t" }),
      ev("assistant.message_start", { messageId: "a" }),
      ev("assistant.message_delta", { messageId: "a", deltaContent: "Hel" }),
      ev("assistant.message_delta", { messageId: "a", deltaContent: "lo" }),
    );
    expect(t.busy).toBe(true);
    expect(only(t, "assistant")[0]).toMatchObject({ text: "Hello", streaming: true });
    const done = reduceEvent(t, ev("assistant.message", { messageId: "a", content: "Hello there." }));
    expect(only(done, "assistant")).toEqual([expect.objectContaining({ text: "Hello there.", streaming: false })]);
    // A message of tool calls only adds nothing.
    expect(reduceEvent(done, ev("assistant.message", { messageId: "b", content: "" })).items).toHaveLength(1);
  });

  it("keeps reasoning apart, streamed and then whole", () => {
    const t = play(ev("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "Think" }), ev("assistant.reasoning", { reasoningId: "r", content: "Think hard." }));
    expect(only(t, "reasoning")).toEqual([expect.objectContaining({ reasoningId: "r", text: "Think hard.", streaming: false } satisfies Partial<ReasoningItem>)]);
  });

  it("ends the turn at session.idle: streaming words settle, and the intent goes", () => {
    const t = play(ev("assistant.turn_start", { turnId: "t" }), ev("assistant.intent", { intent: "Reading files" }), ev("assistant.message_delta", { messageId: "a", deltaContent: "x" }));
    expect(t.intent).toBe("Reading files");
    const idle = reduceEvent(t, ev("session.idle", {}, { ephemeral: true }));
    expect(idle.busy).toBe(false);
    expect(idle.intent).toBeUndefined();
    expect((idle.items[0] as AssistantItem).streaming).toBe(false);
    expect(reduceEvent(t, ev("assistant.turn_end", { turnId: "t" })).busy).toBe(true);
  });

  it("keeps the context meter's numbers and the last call's usage", () => {
    const t = play(ev("session.usage_info", { currentTokens: 1000, tokenLimit: 4000, messagesLength: 3 }), ev("assistant.usage", { model: "m", inputTokens: 900, outputTokens: 50 }));
    expect(t.usage).toEqual({ currentTokens: 1000, tokenLimit: 4000, messagesLength: 3 });
    expect(t.lastCall).toMatchObject({ model: "m", inputTokens: 900, outputTokens: 50 });
  });
});

describe("tool rows", () => {
  it("shows a shell command, its live output in order (a repeated chunk once), its exit code and the sandbox", () => {
    let t = play(ev("tool.execution_start", { toolCallId: "c", toolName: "bash", arguments: { command: "ls" }, shellToolInfo: { displayCommand: "ls -la", hasWriteFileRedirection: false, possiblePaths: [] } }));
    const chunk = ev("tool.shell_output", { toolCallId: "c", text: "a\n", sequence: 0 }, { ephemeral: true });
    t = reduceEvent(t, chunk);
    t = reduceEvent(t, ev("tool.shell_output", { toolCallId: "c", text: "a\n", sequence: 0 }));
    t = reduceEvent(t, ev("tool.shell_output", { toolCallId: "c", text: "b\n", sequence: 1 }));
    t = reduceEvent(t, ev("tool.execution_complete", { toolCallId: "c", success: false, shellExecution: { exitCode: 2 }, sandboxed: true, result: { content: "ignored" } }));
    expect(only(t, "tool")[0]).toMatchObject({ command: "ls -la", output: "a\nb\n", state: "failed", exitCode: 2, sandboxed: true } satisfies Partial<ToolItem>);
  });

  it("keeps only the last OUTPUT_KEEP characters of a long output, and says so", () => {
    let t = play(ev("tool.execution_start", { toolCallId: "c", toolName: "bash", arguments: { command: "yes" } }));
    t = reduceEvent(t, ev("tool.shell_output", { toolCallId: "c", text: "x".repeat(OUTPUT_KEEP + 10), sequence: 0 }));
    const row = only(t, "tool")[0];
    expect(row.output).toHaveLength(OUTPUT_KEEP);
    expect(row.outputCut).toBe(true);
  });

  it("takes a shell's result as its output where nothing streamed", () => {
    const t = play(ev("tool.execution_start", { toolCallId: "c", toolName: "bash", arguments: { command: "pwd" } }), ev("tool.execution_complete", { toolCallId: "c", success: true, shellExecution: { exitCode: 0 }, result: { content: "/home\n" } }));
    expect(only(t, "tool")[0]).toMatchObject({ output: "/home\n", exitCode: 0, state: "done" });
  });

  it("keeps an edit's files, progress, partial results, an error's remedy, and an MCP tool's server", () => {
    const t = play(
      ev("tool.execution_start", { toolCallId: "e", toolName: "edit", arguments: JSON.stringify({ path: "/a/b.ts" }) }),
      ev("tool.execution_progress", { toolCallId: "e", progressMessage: "Writing" }),
      ev("tool.execution_complete", { toolCallId: "e", success: true, fileEdits: [{ path: "/a/b.ts", kind: "edit" }] }),
      ev("tool.execution_start", { toolCallId: "m", toolName: "github-search", mcpServerName: "github", mcpToolName: "search", arguments: { q: "x" } }),
      ev("tool.execution_partial_result", { toolCallId: "m", partialOutput: "1 of 3" }),
      ev("tool.execution_complete", { toolCallId: "m", success: false, error: { message: "denied", remediation: "sign_in" } }),
    );
    const [edit, mcp] = only(t, "tool");
    expect(edit).toMatchObject({ args: { path: "/a/b.ts" }, fileEdits: [{ path: "/a/b.ts", kind: "edit" }], state: "done", progress: undefined });
    expect(mcp).toMatchObject({ mcp: { server: "github", tool: "search" }, state: "failed", error: { message: "denied", remediation: "sign_in" } });
  });

  it("keeps arguments that came cut as text, and makes a row for a tool whose start wasn't seen", () => {
    const t = play(ev("tool.execution_start", { toolCallId: "c", toolName: "x", arguments: "{\"cut" }), ev("tool.execution_complete", { toolCallId: "z", success: true }));
    const [cut, bare] = only(t, "tool");
    expect(cut).toMatchObject({ args: null, argsText: "{\"cut" });
    expect(bare).toMatchObject({ toolCallId: "z", state: "done" });
  });
});

describe("sub-agents", () => {
  it("nest their events under the tool call that started them, by agentId, and record how they ended", () => {
    const t = play(
      ev("tool.execution_start", { toolCallId: "task", toolName: "task", arguments: { prompt: "look" } }),
      ev("subagent.started", { toolCallId: "task", agentName: "explore", agentDisplayName: "Explore", agentDescription: "Look around" }, { agentId: "a1" }),
      ev("tool.execution_start", { toolCallId: "g", toolName: "grep", arguments: { pattern: "x" } }, { agentId: "a1" }),
      ev("assistant.message", { messageId: "sm", content: "Found it." }, { agentId: "a1" }),
      ev("subagent.completed", { toolCallId: "task", agentName: "explore", agentDisplayName: "Explore", totalToolCalls: 1, durationMs: 1200 }),
    );
    expect(itemsOf(t).map(i => i.key)).toHaveLength(1);
    expect(itemsOf(t, "task").map(i => i.kind)).toEqual(["tool", "assistant"]);
    expect(only(t, "tool")[0].agent).toMatchObject({ displayName: "Explore", state: "done", totalToolCalls: 1 });
    // A turn of the sub-agent's doesn't make the session busy or idle.
    expect(reduceEvent(t, ev("session.idle", {}, { agentId: "a1" })).busy).toBe(t.busy);
  });

  it("binds a sub-agent's first event to the one running sub-agent when its start carried no id, and by parentToolCallId otherwise", () => {
    let t = play(
      ev("tool.execution_start", { toolCallId: "task", toolName: "task" }),
      ev("subagent.started", { toolCallId: "task", agentName: "a", agentDisplayName: "A" }),
      ev("tool.execution_start", { toolCallId: "g", toolName: "grep" }, { agentId: "x9" }),
    );
    expect(t.agents).toEqual({ x9: "task" });
    expect(only(t, "tool")[1].owner).toBe("task");
    t = reduceEvent(t, ev("assistant.message", { messageId: "q", content: "by parent", parentToolCallId: "task" }));
    expect(only(t, "assistant")[0].owner).toBe("task");
    t = reduceEvent(t, ev("subagent.failed", { toolCallId: "task", agentName: "a", agentDisplayName: "A", error: "timed out" }));
    expect(only(t, "tool")[0].agent).toMatchObject({ state: "failed", error: "timed out" });
  });
});

describe("notes, problems and requests", () => {
  it("notes plan and to-do changes (a run of to-do writes once), and bumps the versions panels read again at", () => {
    const t = play(ev("session.plan_changed", { operation: "create" }), ev("session.todos_changed", {}), ev("session.todos_changed", {}));
    expect(only(t, "note").map(x => x.note)).toEqual(["plan", "todos"]);
    expect(t.versions).toMatchObject({ plan: 1, todos: 2 });
    const q = play(ev("pending_messages.modified", {}), ev("session.background_tasks_changed", {}));
    expect(q.versions).toMatchObject({ queue: 1, background: 1 });
    expect(q.items).toEqual([]);
  });

  it("makes one compaction note from start to end, and notes model, mode and permission changes with the state they set", () => {
    const t = play(
      ev("session.compaction_start", { trigger: "auto" }),
      ev("session.compaction_complete", { success: true, tokensRemoved: 5000 }),
      ev("session.model_change", { previousModel: "a", newModel: "b", reasoningEffort: "high" }),
      ev("session.mode_changed", { previousMode: "interactive", newMode: "plan" }),
      ev("session.permissions_changed", { previousMode: "manual", mode: "assisted" }),
      ev("session.title_changed", { title: "Fix it" }),
    );
    const notes = only(t, "note");
    expect(notes.map(x => x.note)).toEqual(["compaction", "model", "mode", "permissions"]);
    expect((notes[0] as NoteItem).fields).toMatchObject({ state: "done", tokensRemoved: 5000 });
    expect(t).toMatchObject({ model: "b", reasoningEffort: "high", agentMode: "plan", permissionMode: "assisted", title: "Fix it", compacting: false });
  });

  it("keeps skills, hooks (start to end as one row), errors and warnings with their remedy, aborts and notifications", () => {
    const t = play(
      ev("skill.invoked", { name: "pdf", content: "…", path: "/s" }),
      ev("hook.start", { hookInvocationId: "h", hookType: "preToolUse" }),
      ev("hook.end", { hookInvocationId: "h", hookType: "preToolUse", success: false, error: { message: "nope" } }),
      ev("session.error", { errorType: "authentication", message: "401 Unauthorized", remediation: "sign_in" }),
      ev("session.warning", { warningType: "quota", message: "Nearly out", remediation: "show_account" }),
      ev("abort", { reason: "user_initiated" }),
      ev("system.notification", { content: "<system_notification>Agent done</system_notification>", kind: { type: "agent_completed" } }),
    );
    expect(only(t, "hook")).toEqual([expect.objectContaining({ state: "failed", error: "nope" } satisfies Partial<HookItem>)]);
    expect(only(t, "problem").map(p => [p.level, p.remediation])).toEqual([["error", "sign_in"], ["warning", "show_account"]]);
    expect((only(t, "problem")[0] as ProblemItem).type).toBe("authentication");
    expect(only(t, "note").map(x => [x.note, x.fields.text ?? x.fields.name ?? x.fields.reason])).toEqual([["skill", "pdf"], ["abort", "user_initiated"], ["notification", "Agent done"]]);
  });

  it("opens a request item for each kind of *.requested event, once, and records its completion", () => {
    const kinds = [
      ["permission.requested", "permission"], ["user_input.requested", "user-input"], ["elicitation.requested", "elicitation"],
      ["exit_plan_mode.requested", "exit-plan-mode"], ["auto_mode_switch.requested", "auto-mode-switch"],
      ["session_limits_exhausted.requested", "session-limits"], ["mcp.oauth_required", "mcp-oauth"], ["sampling.requested", "sampling"],
    ] as const;
    let t = play(...kinds.map(([type], i) => ev(type, { requestId: `r${i}` })));
    t = reduceEvent(t, ev("permission.requested", { requestId: "r0" }));
    expect(only(t, "request").map(r => r.request)).toEqual(kinds.map(([, k]) => k));
    t = reduceEvent(t, ev("permission.completed", { requestId: "r0", result: { kind: "approved" } }));
    t = reduceEvent(t, ev("user_input.completed", { requestId: "r1", answer: "yes", wasFreeform: false }));
    t = reduceEvent(t, ev("exit_plan_mode.completed", { requestId: "r3", approved: true, selectedAction: "interactive" }));
    t = reduceEvent(t, ev("auto_mode_switch.completed", { requestId: "r4", response: "no" }));
    const r = only(t, "request");
    expect(r[0]).toMatchObject({ done: true, outcome: { kind: "approved" } } satisfies Partial<RequestItem>);
    expect(r[1].outcome).toEqual({ answer: "yes", wasFreeform: false });
    expect(r[3].outcome).toMatchObject({ approved: true, selectedAction: "interactive" });
    expect(r[4].outcome).toBe("no");
    expect(requestResolved(t, "r2", "companion").items.find(i => i.kind === "request" && i.requestId === "r2")).toMatchObject({ done: true, by: "companion" });
    expect(requestOpened(t, "r0", "permission", {})).toBe(t);
    expect(only(requestOpened(t, "new", "sampling", { serverName: "s" }), "request")).toHaveLength(9);
  });

  it("keeps an event type it has no drawing for as a folded event item, and drops quiet and debug ones", () => {
    const t = play(ev("session.brand_new_thing", { a: 1 }), ev("session.tools_updated", { model: "m" }), ev("model.call_failure", { source: "x" }),
      ev("model.messages_snapshot", { messages: [] }), ev("model.message", { content: "x" }), ev("sandbox.decision", { allowed: true }));
    expect(t.items).toEqual([expect.objectContaining({ kind: "event", type: "session.brand_new_thing", data: { a: 1 } })]);
  });
});

describe("envelopes: replay, gaps and attach", () => {
  const events = [ev("user.message", { content: "hi" }), ev("assistant.message", { messageId: "a", content: "hello" })];

  it("changes nothing for an envelope seen before (by seq, or by event id)", () => {
    const [e1, e2] = envs("s", events);
    const t = applyEnvelope(applyEnvelope(EMPTY_TRANSCRIPT, e1), e2);
    expect(applyEnvelope(t, e2)).toBe(t);
    expect(applyEnvelope(t, e1)).toBe(t);
    const again = applyEnvelope(t, { ...e2, seq: 3 });
    expect(again.items).toBe(t.items);
    expect(again.lastSeq).toBe(3);
  });

  it("marks a gap in seq as stale and applies nothing until attached again", () => {
    const [e1] = envs("s", events);
    const t = applyEnvelope(EMPTY_TRANSCRIPT, e1);
    const gap = applyEnvelope(t, { sessionId: "s", seq: 3, event: ev("assistant.message", { messageId: "z", content: "lost" }) });
    expect(gap.stale).toBe(true);
    expect(gap.items).toBe(t.items);
    expect(applyEnvelope(gap, { sessionId: "s", seq: 4, event: ev("abort", {}) })).toBe(gap);
  });

  it("asks to attach again from the start after a rewind or a cut of the history", () => {
    const t = reduceEvent(play(ev("user.message", { content: "a" })), ev("session.snapshot_rewind", { eventsRemoved: 1, upToEventId: "x" }));
    expect([t.stale, t.rebuild]).toEqual([true, true]);
  });

  it("keeps drawing after a context truncation, which cuts only what the model is sent (a kept history once went blank after it)", () => {
    const all = envs("s", [ev("user.message", { content: "a" }), ev("session.truncation", { messagesRemovedDuringTruncation: 3, tokensRemovedDuringTruncation: 900 }), ev("assistant.message", { messageId: "m", content: "after" })]);
    const t = attachedTranscript(undefined, all, 3);
    expect([t.stale, t.rebuild]).toEqual([false, undefined]);
    expect(t.items.map(i => i.kind)).toEqual(["user", "note", "assistant"]);
  });

  it("catches up from the last seq on attach, and builds the history again without one (keeping a message not yet confirmed)", () => {
    const all = envs("s", [...events, ev("abort", { reason: "user_initiated" })]);
    const t = applyEnvelope(EMPTY_TRANSCRIPT, all[0]);
    const stale = { ...applyEnvelope(t, all[2]), stale: true };
    const caught = attachedTranscript(stale, all.slice(1), 3, 1);
    expect(caught.stale).toBe(false);
    expect(caught.lastSeq).toBe(3);
    expect(caught.items.map(i => i.kind)).toEqual(["user", "assistant", "note"]);
    const local = sentLocally(caught, "you9", "pending words", []);
    const fresh = attachedTranscript(local, all, 7);
    expect(fresh.items.map(i => i.kind)).toEqual(["user", "assistant", "note", "user"]);
    expect(fresh.lastSeq).toBe(7);
    // Main's kept history may skip numbers (its ephemeral events): no gap.
    const sparse = attachedTranscript(undefined, [all[0], { ...all[2], seq: 5 }], 5);
    expect(sparse.stale).toBe(false);
    expect(sparse.items).toHaveLength(2);
  });
});
