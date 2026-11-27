/**
 * A native chat session (chat-session.ts) over a small fake SDK client: what it gives the runtime, how a request goes
 * to the person and back unchanged, the SDK judge's approval, Stop, the organisation's cap, the vault's redaction and
 * the event stream. The real runtime is test/integration/chat-session.test.ts.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import { ChatSession, ChatUnavailable } from "../../app/main/agent/chat-session";
import { JUDGE_CONTEXT, STOPPED_DECISION } from "../../app/main/agent/chat-permission";
import type { ChatPolicy } from "../../app/main/agent/chat-policy";
import type { ChatEvent } from "../../app/shared/chat";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-chat-unit-"));
const work = path.join(root, "work");
const data = path.join(root, "data");
fs.mkdirSync(work);
fs.mkdirSync(path.join(data, "inside"), { recursive: true });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const OPEN: ChatPolicy = { managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true };
const SANDBOX = { supported: true, capabilities: [{ name: "shell", supported: true }, { name: "denied_paths", supported: true }] };

type Listener = (e: unknown) => void;

function fake(o: { support?: unknown; refuse?: string[] } = {}) {
  const listeners = new Set<Listener>();
  const answered: { requestId: string; result: unknown; decisionContext?: unknown }[] = [];
  const calls: string[] = [];
  const state = { mode: "manual", agent: "interactive" as string, name: null as string | null };
  let config: SessionConfig | undefined;
  const session = {
    sessionId: "",
    on: (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    send: async () => { calls.push("send"); return "m1"; },
    abort: async () => { calls.push("abort"); },
    disconnect: async () => { calls.push("disconnect"); },
    rpc: {
      options: { update: async (u: unknown) => { calls.push(`options:${JSON.stringify(u)}`); return { success: true }; } },
      permissions: {
        setMode: async ({ mode }: { mode: string }) => { calls.push(`setMode:${mode}`); if (o.refuse?.includes(mode)) return { success: false, mode: state.mode }; state.mode = mode; return { success: true, mode }; },
        getMode: async () => ({ mode: state.mode }),
        handlePendingPermissionRequest: async (p: { requestId: string; result: unknown }) => { answered.push(p); return { success: true }; },
      },
      mode: { get: async () => state.agent, set: async ({ mode }: { mode: string }) => { state.agent = mode; return { modeApplied: true }; } },
      name: { set: async ({ name }: { name: string }) => { state.name = name; }, get: async () => ({ name: state.name }) },
      cancelAllBackgroundAgents: async () => { calls.push("cancelAll"); return { cancelled: 0 }; },
    },
  };
  const client = {
    rpc: { sandbox: { getHostSupport: async () => o.support ?? SANDBOX } },
    createSession: async (c: SessionConfig) => { config = c; session.sessionId = c.sessionId!; return session; },
    resumeSession: async (id: string, c: SessionConfig) => { config = c; session.sessionId = id; return session; },
  } as unknown as CopilotClient;
  return { client, emit: (e: unknown) => { for (const l of listeners) l(e); }, answered, calls, state, config: () => config!, session };
}

async function open(f: ReturnType<typeof fake>, extra: Partial<Parameters<typeof ChatSession.open>[0]> = {}) {
  const events: ChatEvent[] = [];
  const chat = await ChatSession.open({ client: f.client, folder: work, protectedPaths: [data], policy: OPEN, onEvent: e => events.push(e), ...extra });
  return { chat, events };
}

const shellRequest = (requestId: string, more: Record<string, unknown> = {}) => ({
  type: "permission.requested", data: { requestId, permissionRequest: { kind: "shell", fullCommandText: "ls", intention: "list", commands: [{ identifier: "ls", readOnly: true }],
    possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false, toolCallId: "call_1" }, ...more },
});

describe("a native chat session's runtime config", () => {
  it("offers the runtime's own tools in the user's folder, with Ember's data denied by the sandbox and the policy as managedSettings", async () => {
    const f = fake();
    const managed: ChatPolicy = { ...OPEN, managedSettings: { permissions: { deny: ["Shell"] } } };
    const { chat } = await open(f, { policy: managed, gitHubToken: "gho_test", model: "m", name: "  My chat  " });
    const c = f.config();
    expect(c).toMatchObject({ availableTools: ["builtin:*"], workingDirectory: fs.realpathSync.native(work), enableConfigDiscovery: false, streaming: true, gitHubToken: "gho_test", model: "m",
      managedSettings: { permissions: { deny: ["Shell"] } } });
    expect(c.sessionId).toMatch(/^ember-chat-/);
    expect(await c.onPermissionRequest!({ kind: "shell" } as never, { sessionId: "x" })).toEqual({ kind: "no-result" });
    const sandbox = f.calls.find(x => x.startsWith("options:"))!;
    expect(sandbox).toContain('"allowBypass":false');
    expect(sandbox).toContain(JSON.stringify(data).slice(1, -1));
    expect(f.calls).toContain("setMode:manual");
    expect(chat.name).toBe("My chat");
    expect(f.state.name).toBe("My chat");
  });

  it("refuses a computer whose sandbox can't deny paths, and a folder inside Ember's own data (fail closed)", async () => {
    await expect(open(fake({ support: { supported: true, capabilities: [{ name: "shell", supported: true }] } }))).rejects.toBeInstanceOf(ChatUnavailable);
    await expect(open(fake({ support: { supported: false, capabilities: [] } }))).rejects.toBeInstanceOf(ChatUnavailable);
    await expect(open(fake(), { folder: path.join(data, "inside") })).rejects.toThrow("Ember's own data");
    await expect(open(fake(), { folder: path.join(root, "missing") })).rejects.toBeInstanceOf(ChatUnavailable);
    await expect(open(fake(), { resumeId: "someone-else" })).rejects.toBeInstanceOf(ChatUnavailable);
  });
});

describe("a native chat session's permission requests", () => {
  it("go to the person and come back as the SDK decision they chose, unchanged", async () => {
    const f = fake();
    const { chat, events } = await open(f);
    f.emit(shellRequest("r1"));
    expect(events.at(-1)).toMatchObject({ type: "permission-requested", requestId: "r1", request: { kind: "shell", command: "ls" }, choices: ["approve-once", "reject"] });
    expect(chat.waiting).toBe(1);
    await chat.decide("r1", { kind: "approve-once" });
    expect(f.answered).toEqual([{ requestId: "r1", result: { kind: "approve-once" } }]);
    f.emit({ type: "permission.completed", data: { requestId: "r1", toolCallId: "call_1", result: { kind: "approved" } } });
    expect(events.at(-1)).toEqual({ type: "permission-resolved", session: chat.id, requestId: "r1", kind: "shell", decision: "approved", by: "user" });
    await expect(chat.decide("r1", { kind: "approve-once" })).rejects.toBeInstanceOf(ChatUnavailable);
  });

  it("are approved once, as the judge's, only where the SDK's judge recommends it in assisted mode", async () => {
    const f = fake();
    const { chat, events } = await open(f);
    await chat.setPermissionMode("assisted");
    f.emit(shellRequest("r1", { promptRequest: { kind: "commands", assistedApproval: { recommendation: "approve", reason: "read-only" } } }));
    await new Promise(r => setTimeout(r, 0));
    expect(f.answered).toEqual([{ requestId: "r1", result: { kind: "approve-once" }, decisionContext: JUDGE_CONTEXT }]);
    expect(events.some(e => e.type === "permission-requested")).toBe(false);
    f.emit({ type: "permission.completed", data: { requestId: "r1", result: { kind: "approved" } } });
    expect(events.at(-1)).toMatchObject({ type: "permission-resolved", by: "judge" });
    f.emit(shellRequest("r2", { promptRequest: { kind: "commands", assistedApproval: { recommendation: "requireApproval" } } }));
    expect(events.at(-1)).toMatchObject({ type: "permission-requested", requestId: "r2", assisted: { recommendation: "requireApproval" } });
    expect(f.answered).toHaveLength(1);
  });

  it("are never the judge's in manual mode, whatever it recommends", async () => {
    const f = fake();
    const { events } = await open(f);
    f.emit(shellRequest("r1", { promptRequest: { kind: "commands", assistedApproval: { recommendation: "approve" } } }));
    expect(f.answered).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "permission-requested", requestId: "r1" });
  });

  it("leave alone a request the SDK's own hook resolved", async () => {
    const f = fake();
    const { chat, events } = await open(f);
    f.emit(shellRequest("r1", { resolvedByHook: true }));
    expect(chat.waiting).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("a native chat session's modes", () => {
  it("never leaves allow-all in force when a stricter mode is refused", async () => {
    const f = fake({ refuse: ["assisted"] });
    const { chat } = await open(f);
    await chat.setPermissionMode("allow-all");
    expect(await chat.setPermissionMode("assisted")).toEqual({ requested: "assisted", mode: "manual", applied: false });
  });

  it("refuses a mode the organisation's policy doesn't allow before asking the runtime", async () => {
    const f = fake();
    const { chat } = await open(f, { policy: { ...OPEN, permissionModes: ["manual"] } });
    f.calls.length = 0;
    expect(await chat.setPermissionMode("allow-all")).toEqual({ requested: "allow-all", mode: "manual", applied: false });
    expect(f.calls).toEqual([]);
  });

  it("sets the agent mode apart from the permission mode and reports the runtime's", async () => {
    const f = fake();
    const { chat, events } = await open(f);
    expect(await chat.setAgentMode("plan")).toEqual({ requested: "plan", mode: "plan", applied: true });
    expect(chat.permissionMode).toBe("manual");
    expect(events.at(-1)).toMatchObject({ type: "mode-changed", agentMode: "plan", permissionMode: "manual" });
    f.emit({ type: "session.mode_changed", data: { previousMode: "plan", newMode: "interactive" } });
    expect(chat.agentMode).toBe("interactive");
  });
});

describe("a native chat session's Stop", () => {
  it("rejects what waits, withdraws the model's question, aborts the turn and cancels background agents, and holds every tool until the next message", async () => {
    const f = fake();
    const { chat, events } = await open(f);
    f.emit(shellRequest("r1"));
    const question = f.config().onUserInputRequest!({ question: "Which?", choices: ["a", "b"] }, { sessionId: chat.id });
    const asked = events.find(e => e.type === "user-input-requested");
    expect(asked).toMatchObject({ question: "Which?", choices: ["a", "b"], allowFreeform: true });
    await chat.stop();
    await expect(question).rejects.toThrow();
    expect(f.answered).toEqual([{ requestId: "r1", result: STOPPED_DECISION }]);
    expect(f.calls).toEqual(expect.arrayContaining(["abort", "cancelAll"]));
    const pre = f.config().hooks!.onPreToolUse!;
    expect(await pre({ toolName: "bash" } as never, { sessionId: chat.id })).toMatchObject({ permissionDecision: "deny" });
    // A request that arrives after Stop is rejected at once.
    f.emit(shellRequest("r2"));
    await new Promise(r => setTimeout(r, 0));
    expect(f.answered.at(-1)).toEqual({ requestId: "r2", result: STOPPED_DECISION });
    await chat.send("again");
    expect(await pre({ toolName: "bash" } as never, { sessionId: chat.id })).toBeUndefined();
  });

  it("takes an answer to the model's question only as the question allows", async () => {
    const f = fake();
    const { chat, events } = await open(f);
    const question = f.config().onUserInputRequest!({ question: "Pick", choices: ["one"], allowFreeform: false }, { sessionId: chat.id });
    const id = (events.find(e => e.type === "user-input-requested") as { requestId: string }).requestId;
    expect(() => chat.answer(id, "free text", true)).toThrow(ChatUnavailable);
    expect(() => chat.answer(id, "two", false)).toThrow(ChatUnavailable);
    chat.answer(id, "one", false);
    await expect(question).resolves.toEqual({ answer: "one", wasFreeform: false });
  });
});

describe("a native chat session's tool results and events", () => {
  it("rewrites a tool's result that holds a value the vault filled, and nothing else", async () => {
    const f = fake();
    const redact = { active: true, holds: (t: unknown) => JSON.stringify(t).includes("SECRETVALUE"), text: (s: string) => s.replace(/SECRETVALUE/g, "[x]"),
      deep: <T>(v: T) => JSON.parse(JSON.stringify(v).replace(/SECRETVALUE/g, "[x]")) as T };
    await open(f, { redact });
    const post = f.config().hooks!.onPostToolUse!;
    expect(await post({ toolName: "bash", toolArgs: {}, toolResult: { textResultForLlm: "has SECRETVALUE", resultType: "success" } } as never, { sessionId: "s" }))
      .toEqual({ modifiedResult: { textResultForLlm: "has [x]", resultType: "success" } });
    expect(await post({ toolName: "bash", toolArgs: {}, toolResult: { textResultForLlm: "plain", resultType: "success" } } as never, { sessionId: "s" })).toBeUndefined();
  });

  it("tells Home of text, reasoning, tools with who let them run, idle and errors in plain words", async () => {
    const f = fake();
    const { chat, events } = await open(f);
    await chat.setPermissionMode("allow-all");
    events.length = 0;
    f.emit({ type: "assistant.message_delta", data: { messageId: "m", deltaContent: "Hel" } });
    f.emit({ type: "assistant.message_delta", agentId: "sub", data: { messageId: "s", deltaContent: "sub-agent words" } });
    f.emit({ type: "assistant.reasoning_delta", data: { reasoningId: "q", deltaContent: "thinking" } });
    f.emit({ type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "ls" } } });
    f.emit({ type: "tool.shell_output", data: { toolCallId: "c1", text: "a.txt\n", sequence: 1 } });
    f.emit({ type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "a.txt" }, shellExecution: { exitCode: 0 }, fileEdits: [{ path: "/w/a", kind: "edit" }] } });
    f.emit({ type: "assistant.message", data: { messageId: "m", content: "Hello" } });
    f.emit({ type: "session.error", data: { errorType: "network", message: "ECONNRESET at socket.js:12 stack" } });
    f.emit({ type: "session.idle", data: {} });
    const s = chat.id;
    expect(events).toEqual([
      { session: s, type: "text-delta", messageId: "m", text: "Hel" },
      { session: s, type: "reasoning-delta", reasoningId: "q", text: "thinking" },
      { session: s, type: "tool-start", toolCallId: "c1", tool: "bash", args: '{"command":"ls"}' },
      { session: s, type: "tool-output", toolCallId: "c1", text: "a.txt\n" },
      { session: s, type: "tool-complete", toolCallId: "c1", tool: "bash", approvedBy: "allow-all", success: true, result: "a.txt", exitCode: 0, fileEdits: [{ path: "/w/a", kind: "edit" }] },
      { session: s, type: "message", messageId: "m", text: "Hello" },
      { session: s, type: "error", message: expect.any(String) },
      { session: s, type: "idle", aborted: false },
    ]);
    const error = events.find(e => e.type === "error") as { message: string };
    expect(error.message).not.toContain("socket.js");
    expect(chat.busy).toBe(false);
  });
});
