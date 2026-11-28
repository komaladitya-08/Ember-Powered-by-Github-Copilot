/**
 * The coding hub and its sessions (app/main/code/hub.ts, session-runtime.ts) over a fake SDK client: the session's
 * full-mode options, the sandbox and Ember's data denied, the pending table for every kind of request (each answered
 * once through the SDK's own call and cleared with who answered), Stop, the pre-tool hook, numbered events with
 * attach and replay, and the hub's guards (the setting, consent, the organisation's policy, a vault fill, a
 * connection, the audit log, the RPC guards, sign-out).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import { CodeHub, type CodeHubDeps } from "../../app/main/code/hub";
import { CODE_REFUSALS } from "../../app/main/code/guards";
import { SessionIndex, indexFile } from "../../app/main/code/session-index";
import { gitRunner } from "../../app/main/code/workspaces";
import { KillSwitch } from "../../app/main/agent/killswitch";
import type { ChatPolicy } from "../../app/main/agent/chat-policy";
import type { AuditEntry } from "../../app/main/policy/audit";
import { CODE_KEPT, CODE_LIMITS, type CodeEventEnvelope, type CodePendingRequest, type CodeRequestKind, type CodeSessionRow } from "../../app/shared/code";
import { REAL } from "../fixtures/code-window/real-shapes";

const OPEN: ChatPolicy = { managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true };
const quiet = { info() {}, warn() {} };

/** A fake SDK client: one session per create or resume, its RPC calls recorded, its events emitted by the test. */
function fakeClient(o: { sandbox?: "full" | "no-network" | "none"; pending?: { requestId: string }[]; history?: unknown[] } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const configs: SessionConfig[] = [];
  const support = o.sandbox === "none" ? { supported: false, capabilities: [] }
    : { supported: true, capabilities: [{ name: "shell", supported: true }, { name: "denied_paths", supported: true }, { name: "network", supported: o.sandbox !== "no-network" }] };
  let mode = "manual";
  let agent = "interactive";
  let trusted = false;
  let n = 0;
  const rec = (method: string, answer: unknown = { success: true }) => async (params?: unknown) => { calls.push({ method, params }); return typeof answer === "function" ? (answer as (p: unknown) => unknown)(params) : answer; };
  const rpc = {
    options: { update: rec("options.update") },
    sandbox: { getEnforcementStatus: rec("sandbox.getEnforcementStatus", { required: false, blocked: false }) },
    permissions: {
      setMode: rec("permissions.setMode", (p: { mode: string }) => { mode = p.mode; return { success: true, mode }; }),
      getMode: async () => ({ mode }),
      handlePendingPermissionRequest: rec("permissions.handlePendingPermissionRequest"),
      locations: { resolve: async () => ({ locationKey: "repo:acme/app", locationType: "repo" }) },
      pendingRequests: async () => ({ items: o.pending ?? [] }),
      paths: { list: rec("permissions.paths.list", { paths: [] }) },
      folderTrust: { isTrusted: async () => ({ trusted }), addTrusted: rec("permissions.folderTrust.addTrusted", () => { trusted = true; return { success: true }; }) },
    },
    mode: { get: async () => agent, set: rec("mode.set", (p: { mode: string }) => { agent = p.mode; return { status: "ok", modelChanged: false }; }) },
    name: { get: async () => ({ name: "" }), set: rec("name.set", undefined) },
    model: { getCurrent: async () => ({ modelId: "mock-model" }) },
    ui: Object.fromEntries(["handlePendingUserInput", "handlePendingExitPlanMode", "handlePendingAutoModeSwitch", "handlePendingSessionLimitsExhausted", "handlePendingSampling", "handlePendingElicitation"].map(m => [m, rec(`ui.${m}`)])),
    mcp: { oauth: { handlePendingRequest: rec("mcp.oauth.handlePendingRequest") } },
    history: { listRewindPoints: rec("history.listRewindPoints", { fileChangeTrackingEnabled: true, points: [] }) },
    cancelAllBackgroundAgents: rec("cancelAllBackgroundAgents"),
    interruptMainTurn: rec("interruptMainTurn"),
  };
  const session = (id: string) => ({ sessionId: id, rpc, send: rec("send", "msg-1"), abort: rec("abort", undefined), disconnect: rec("disconnect", undefined) });
  const client = {
    rpc: {
      sandbox: { getHostSupport: async () => support },
      sessions: { readPersistedEvents: async () => ({ events: o.history ?? [], cursor: "c", hasMore: false, cursorStatus: "ok" }), fork: rec("sessions.fork", { sessionId: "forked-1" }) },
      models: { list: rec("models.list", { models: [{ id: "m" }] }) },
    },
    createSession: async (c: SessionConfig) => { configs.push(c); return session(c.sessionId!); },
    resumeSession: async (id: string, c: SessionConfig) => { configs.push(c); return session(id); },
    listSessions: async () => [],
    getSessionMetadata: async () => undefined,
    deleteSession: rec("deleteSession", undefined),
  } as unknown as CopilotClient;
  /** Emits an SDK event the way the SDK dispatches it: its broadcast handlers first, then the session's listeners. */
  const emit = (type: string, data: Record<string, unknown>, ephemeral = false) => {
    const c = configs.at(-1)!;
    if (type === "elicitation.requested") void c.onElicitationRequest?.({ sessionId: "s", message: String(data.message ?? "") });
    if (type === "mcp.oauth_required") void c.onMcpAuthRequest?.(data as never, { sessionId: "s" });
    if (type === "user_input.requested") void c.onUserInputRequest?.(data as never, { sessionId: "s" });
    c.onEvent?.({ id: `e${++n}`, parentId: null, timestamp: "t", type, data, ...(ephemeral ? { ephemeral: true } : {}) } as never);
  };
  return { client, rpc, calls, configs, emit, called: (method: string) => calls.filter(c => c.method === method) };
}

let dir: string;
let userData: string;
let work: string;
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-hub-")));
  userData = path.join(dir, "userdata");
  work = path.join(dir, "work");
  fs.mkdirSync(userData);
  fs.mkdirSync(work);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function harness(over: Partial<CodeHubDeps> = {}, fake = fakeClient()) {
  const audit: AuditEntry[] = [];
  const sent: { channel: string; payload: unknown; to?: string }[] = [];
  const deps: CodeHubDeps = {
    hasConsent: () => true, enabled: () => true, policy: () => OPEN, vaultFilled: () => false,
    access: () => ({ provider: { type: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test" }, model: "mock-model", service: "user" }),
    client: async () => fake.client, userData, protectedPaths: () => [userData], place: () => ({ os: "linux", home: dir }),
    audit: () => ({ write: e => audit.push(e) }), emit: (channel, payload, to) => sent.push({ channel, payload, ...(to ? { to } : {}) }),
    pickFolder: async () => work, pickFiles: async () => [path.join(work, "a.txt")], log: quiet,
    git: async args => { if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${work}\n`; if (args[1] === "--abbrev-ref") return "main\n"; throw new Error("no"); },
    index: new SessionIndex(indexFile(path.join(userData, "code"))).load(),
    ...over,
  };
  const hub = new CodeHub(deps);
  const events = (to = "w1") => sent.filter(s => s.channel === "code:event" && s.to === to).map(s => s.payload as CodeEventEnvelope);
  const requests = () => sent.filter(s => s.channel === "code:request").map(s => s.payload as CodePendingRequest | { resolved: string; by: string });
  const rows = () => sent.filter(s => s.channel === "code:row").map(s => s.payload as CodeSessionRow);
  return { hub, fake, audit, sent, events, requests, rows, deps };
}

async function started(h: ReturnType<typeof harness>, options = {}): Promise<string> {
  const r = await h.hub.dispatch({ type: "create", options }, "user");
  if (!r.ok) throw new Error(r.reason);
  await h.hub.dispatch({ type: "attach", sessionId: r.value.id }, "user", "w1");
  return r.value.id;
}

describe("a coding session's options", () => {
  it("run the SDK's full Copilot mode in the chosen folder, with file tracking, and the sandbox denying Ember's data with outbound network", async () => {
    const h = harness();
    const id = await started(h, { model: "gpt-x", reasoningEffort: "high", agent: "explore" });
    const c = h.fake.configs[0];
    expect(c).toMatchObject({ sessionId: id, workingDirectory: work, model: "gpt-x", reasoningEffort: "high", agent: "explore", enableFileChangeTracking: true, enableSkills: true,
      memory: { enabled: true }, enableOnDemandInstructionDiscovery: true, enableHostGitOperations: true, enableSessionStore: true, enableSessionTelemetry: false, enableFileHooks: false });
    expect(c).not.toHaveProperty("gitHubToken");
    const update = h.fake.called("options.update")[0].params as { sandboxConfig: { enabled: boolean; allowBypass: boolean; userPolicy: { filesystem: { deniedPaths: string[] }; network: { allowOutbound: boolean } } } };
    expect(update.sandboxConfig).toMatchObject({ enabled: true, allowBypass: false, userPolicy: { network: { allowOutbound: true } } });
    expect(update.sandboxConfig.userPolicy.filesystem.deniedPaths).toContain(userData);
    expect(h.fake.called("sandbox.getEnforcementStatus")).toHaveLength(1);
    expect(h.rows().at(-1)).toMatchObject({ id, sandbox: "on", open: true, model: "mock-model" });
  });

  it("run without a sandbox where this computer has none, saying so on the row, with the repository's own hooks off", async () => {
    const h = harness({}, fakeClient({ sandbox: "none" }));
    const id = await started(h);
    expect(h.fake.called("options.update")).toEqual([]);
    expect(h.fake.configs[0].enableFileHooks).toBe(false);
    expect((await h.hub.dispatch({ type: "list" }, "user")).sessions.find(r => r.id === id)?.sandbox).toBe("off");
    const where = harness({}, fakeClient({ sandbox: "no-network" }));
    const other = await started(where);
    expect((await where.hub.dispatch({ type: "list" }, "user")).sessions.find(r => r.id === other)?.sandbox).toBe("no-network");
  });

  it("turn the repository's own hooks on only in the sandbox and once the user trusts the folder", async () => {
    const h = harness();
    const id = await started(h);
    const hooksOn = () => h.fake.called("options.update").some(c => (c.params as { enableFileHooks?: boolean }).enableFileHooks === true);
    expect(hooksOn()).toBe(false);
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "permissions.folderTrust.addTrusted", params: { path: work } } }, "user")).toMatchObject({ ok: true });
    expect(hooksOn()).toBe(true);
    const bare = harness({}, fakeClient({ sandbox: "none" }));
    const other = await started(bare);
    await bare.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: other, method: "permissions.folderTrust.addTrusted", params: { path: work } } }, "user");
    expect(bare.fake.called("options.update")).toEqual([]);
  });

  it("refuse a tool whose arguments name Ember's data before it runs, and every tool after Stop", async () => {
    const h = harness({}, fakeClient({ sandbox: "none" }));
    await started(h);
    const pre = h.fake.configs[0].hooks!.onPreToolUse!;
    const ask = (toolArgs: unknown) => pre({ toolName: "view", toolArgs, sessionId: "s", timestamp: 0, workingDirectory: work } as never, { sessionId: "s" } as never);
    expect(await ask({ path: path.join(userData, "settings.json") })).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: CODE_REFUSALS.emberToolPath });
    expect(await ask({ path: path.join(work, "a.txt") })).toBeUndefined();
    await h.hub.stopAll();
    expect(await ask({ path: path.join(work, "a.txt") })).toMatchObject({ permissionDecision: "deny" });
  });
});

/** What answering each kind of request sends to the SDK. */
const KINDS: { kind: CodeRequestKind; event: string; done: string; data: Record<string, unknown>; payload: unknown; method: string }[] = [
  { kind: "permission", event: "permission.requested", done: "permission.completed", data: { permissionRequest: { kind: "shell", fullCommandText: "npm test", intention: "t", commands: [{ identifier: "npm test", readOnly: false }], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true } },
    payload: { kind: "approve-for-location" }, method: "permissions.handlePendingPermissionRequest" },
  { kind: "user-input", event: "user_input.requested", done: "user_input.completed", data: { question: "Which?", choices: ["a", "b"], allowFreeform: false }, payload: { answer: "a", wasFreeform: false }, method: "ui.handlePendingUserInput" },
  { kind: "exit-plan-mode", event: "exit_plan_mode.requested", done: "exit_plan_mode.completed", data: { summary: "s", planContent: "", actions: ["interactive"], recommendedAction: "interactive" }, payload: { approved: true, selectedAction: "interactive" }, method: "ui.handlePendingExitPlanMode" },
  { kind: "auto-mode-switch", event: "auto_mode_switch.requested", done: "auto_mode_switch.completed", data: {}, payload: "no", method: "ui.handlePendingAutoModeSwitch" },
  { kind: "session-limits", event: "session_limits_exhausted.requested", done: "session_limits_exhausted.completed", data: { maxAiCredits: 5, usedAiCredits: 5 }, payload: { action: "cancel" }, method: "ui.handlePendingSessionLimitsExhausted" },
  { kind: "sampling", event: "sampling.requested", done: "sampling.completed", data: { serverName: "x", mcpRequestId: 1 }, payload: {}, method: "ui.handlePendingSampling" },
  { kind: "elicitation", event: "elicitation.requested", done: "elicitation.completed", data: { message: "Pick" }, payload: { action: "decline" }, method: "(handler)" },
  { kind: "mcp-oauth", event: "mcp.oauth_required", done: "mcp.oauth_completed", data: { serverName: "x", serverUrl: "https://x", reason: "initial" }, payload: { kind: "cancelled" }, method: "(handler)" },
];

describe("a pending request", () => {
  for (const k of KINDS) {
    it(`of kind ${k.kind} is shown to every window, answered once through the SDK's own call, and cleared with who answered`, async () => {
      const h = harness();
      const id = await started(h);
      const requestId = `r-${k.kind}`;
      h.fake.emit(k.event, { requestId, ...k.data }, k.kind !== "permission");
      const opened = h.requests().find((r): r is CodePendingRequest => "requestId" in r && r.requestId === requestId);
      expect(opened).toMatchObject({ sessionId: id, kind: k.kind });
      if (k.kind === "permission") expect(opened?.choices).toEqual(["approve-once", "approve-for-session", "approve-for-location", "reject"]);
      expect((await h.hub.dispatch({ type: "attach", sessionId: id, sinceSeq: 0 }, "user", "w2")).ok && h.hub.waiting().map(p => p.requestId)).toEqual([requestId]);
      expect(await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId, kind: k.kind, payload: k.payload } }, "user")).toEqual({ ok: true });
      if (k.method !== "(handler)") expect(h.fake.called(k.method).at(-1)?.params).toMatchObject({ requestId });
      if (k.kind === "permission") expect(h.fake.called(k.method).at(-1)?.params).toMatchObject({ result: { kind: "approve-for-location", locationKey: "repo:acme/app" } });
      expect(h.requests()).toContainEqual({ resolved: requestId, sessionId: id, by: "user" });
      expect(h.hub.waiting()).toEqual([]);
      expect(await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId, kind: k.kind, payload: k.payload } }, "user")).toMatchObject({ ok: false, reason: CODE_REFUSALS.request });
      h.fake.emit(k.done, { requestId, ...(k.kind === "permission" ? { result: { kind: "approved-for-location" } } : {}) }, true);
      if (k.kind === "permission") expect(h.audit.some(e => e.phase === "decision" && e.kind === "permission" && e.decision === "approved-for-location" && e.by === "user")).toBe(true);
    });
  }

  it("is answered by the person, never by the companion acting for them (docs/CODING-APP.md §5)", async () => {
    const h = harness();
    const id = await started(h);
    h.fake.emit("permission.requested", { requestId: "c1", ...KINDS[0].data });
    expect(await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: "c1", kind: "permission", payload: { kind: "approve-once" } } }, "companion"))
      .toEqual({ ok: false, reason: CODE_REFUSALS.companionAnswer });
    expect(h.hub.waiting().map(p => p.requestId)).toEqual(["c1"]);
  });

  it("stays waiting when its answer couldn't reach the runtime, and is over for every window when the runtime turns the answer down", async () => {
    const h = harness();
    const id = await started(h);
    h.fake.emit("user_input.requested", { requestId: "x1", ...KINDS[1].data }, true);
    const ui = h.fake.rpc.ui as Record<string, unknown>;
    const real = ui.handlePendingUserInput;
    ui.handlePendingUserInput = async () => { throw new Error("connection lost"); };
    expect(await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: "x1", kind: "user-input", payload: { answer: "a", wasFreeform: false } } }, "user")).toMatchObject({ ok: false });
    expect(h.hub.waiting().map(p => p.requestId)).toEqual(["x1"]);
    ui.handlePendingUserInput = async () => ({ success: false });
    expect(await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: "x1", kind: "user-input", payload: { answer: "a", wasFreeform: false } } }, "user")).toMatchObject({ ok: false });
    expect(h.hub.waiting()).toEqual([]);
    expect(h.requests()).toContainEqual({ resolved: "x1", sessionId: id, by: "sdk" });
    ui.handlePendingUserInput = real;
  });

  it("that the SDK's assisted judge approves is approved by it, never shown", async () => {
    const h = harness();
    const id = await started(h);
    await h.hub.dispatch({ type: "setPermissionMode", sessionId: id, mode: "assisted" }, "user");
    h.fake.emit("permission.requested", { requestId: "j1", ...KINDS[0].data, promptRequest: { assistedApproval: { recommendation: "approve" } } });
    await new Promise(r => setTimeout(r, 0));
    expect(h.hub.waiting()).toEqual([]);
    expect(h.fake.called("permissions.handlePendingPermissionRequest").at(-1)?.params).toMatchObject({ requestId: "j1", result: { kind: "approve-once" }, decisionContext: { source: "assisted_approval" } });
  });

  it("is refused on Stop, within the kill switch's budget: a permission rejected, the turn aborted, background agents cancelled, and only a refusal taken after", async () => {
    const h = harness();
    const id = await started(h);
    h.fake.emit("permission.requested", { requestId: "p1", ...KINDS[0].data });
    h.fake.emit("exit_plan_mode.requested", { requestId: "p2", ...KINDS[2].data }, true);
    const pulled = await new KillSwitch(() => [h.hub.stopPart()], { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never).pull("hotkey");
    expect(pulled.ms).toBeLessThan(300);
    expect(h.fake.called("permissions.handlePendingPermissionRequest").at(-1)?.params).toMatchObject({ requestId: "p1", result: { kind: "reject" } });
    expect(h.fake.called("ui.handlePendingExitPlanMode").at(-1)?.params).toMatchObject({ requestId: "p2", response: { approved: false } });
    expect(h.fake.called("abort")).toHaveLength(1);
    expect(h.fake.called("cancelAllBackgroundAgents")).toHaveLength(1);
    expect(h.requests()).toContainEqual({ resolved: "p1", sessionId: id, by: "system" });
    h.fake.emit("permission.requested", { requestId: "p3", ...KINDS[0].data });
    await new Promise(r => setTimeout(r, 0));
    expect(h.fake.called("permissions.handlePendingPermissionRequest").at(-1)?.params).toMatchObject({ requestId: "p3", result: { kind: "reject" } });
  });

  it("left waiting when the runtime stopped comes back when the session is opened again, with its choices", async () => {
    const request = { requestId: "old", ...KINDS[0].data };
    const fake = fakeClient({ pending: [{ requestId: "old" }], history: [{ id: "h1", timestamp: "t", type: "user.message", data: { content: "hi" } }, { id: "h2", timestamp: "t", type: "permission.requested", data: request }] });
    const h = harness({}, fake);
    h.deps.index!.addSession("kept", { projectId: "p", folder: work, isolation: "folder", createdBy: "user" });
    const attached = await h.hub.dispatch({ type: "attach", sessionId: "kept" }, "user", "w1");
    if (!attached.ok) throw new Error(attached.reason);
    expect(attached.value.reset).toBe(true);
    expect(attached.value.events.map(e => [e.seq, e.event.type])).toEqual([[1, "user.message"], [2, "permission.requested"]]);
    expect(attached.value.pending).toEqual([expect.objectContaining({ requestId: "old", kind: "permission", choices: expect.arrayContaining(["approve-once", "reject"]) })]);
    expect(fake.configs[0]).toMatchObject({ continuePendingWork: true });
  });
});

describe("a coding window's events", () => {
  it("come numbered one after another to the windows attached; a window that attaches again from its last seq gets only what it missed", async () => {
    const h = harness();
    const id = await started(h);
    const base = (await h.hub.dispatch({ type: "attach", sessionId: id }, "user", "w1") as { value: { seq: number } }).value.seq;
    // Shown with the focus (markRead): what follows while it is isn't unread.
    await h.hub.dispatch({ type: "markRead", sessionId: id }, "user", "w1");
    h.fake.emit("assistant.message_delta", { deltaContent: "a" }, true);
    h.fake.emit("assistant.message", { content: "ab" });
    expect(h.events().filter(e => e.seq > base).map(e => e.seq)).toEqual([base + 1, base + 2]);
    await h.hub.dispatch({ type: "detach", sessionId: id }, "user", "w1");
    h.fake.emit("assistant.turn_end", {});
    expect(h.events().some(e => e.event.type === "assistant.turn_end")).toBe(false);
    await new Promise(r => setTimeout(r, 0));
    expect(h.rows().filter(r => r.id === id).at(-1)?.unread).toBe(1);
    const caught = await h.hub.dispatch({ type: "attach", sessionId: id, sinceSeq: base + 2 }, "user", "w1");
    if (!caught.ok) throw new Error(caught.reason);
    expect(caught.value.events.map(e => e.event.type)).toEqual(["assistant.turn_end"]);
    expect(caught.value).toMatchObject({ seq: base + 3, row: { unread: 0 } });
    expect(caught.value.reset).toBeUndefined();
  });

  it("never carry a value the vault filled", async () => {
    const canary = "VAULTCANARY-1f2e3d";
    const h = harness({ redact: { active: true, holds: t => JSON.stringify(t).includes(canary), text: s => s.split(canary).join("[vault]"), deep: <T>(v: T) => v } });
    await started(h);
    h.fake.emit("tool.execution_complete", { toolCallId: "c", success: true, result: { content: `x ${canary}` } });
    expect(JSON.stringify(h.events())).not.toContain(canary);
  });
});

describe("the coding hub's guards", () => {
  it("start nothing while the feature is off, before consent, under a policy that allows none, after a vault fill, or offline", async () => {
    for (const [over, why] of [
      [{ enabled: () => false }, CODE_REFUSALS.off], [{ hasConsent: () => false }, CODE_REFUSALS.consent],
      [{ policy: () => null }, CODE_REFUSALS.policy], [{ vaultFilled: () => true }, CODE_REFUSALS.vault], [{ access: () => null }, CODE_REFUSALS.offline],
    ] as [Partial<CodeHubDeps>, string][]) {
      const h = harness(over);
      expect(await h.hub.dispatch({ type: "create", options: {} }, "user")).toEqual({ ok: false, reason: why });
      expect(h.fake.configs).toEqual([]);
    }
    const before = harness({ hasConsent: () => false });
    let asked = false;
    before.deps.client = async () => { asked = true; return before.fake.client; };
    expect((await before.hub.dispatch({ type: "list" }, "user")).sessions).toEqual([]);
    expect(asked).toBe(false);
  });

  it("keep the organisation's cap on permission modes, saying which mode stays, and audit each change with who made it", async () => {
    const h = harness({ policy: () => ({ ...OPEN, permissionModes: ["manual"] }) });
    const id = await started(h);
    expect(await h.hub.dispatch({ type: "setPermissionMode", sessionId: id, mode: "allow-all" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.modeRefused, code: "mode:manual" });
    expect(h.fake.called("permissions.setMode").map(c => (c.params as { mode: string }).mode)).not.toContain("allow-all");
    expect(await h.hub.dispatch({ type: "create", options: { permissionMode: "allow-all" } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.modeRefused });
    expect(await h.hub.dispatch({ type: "setAgentMode", sessionId: id, mode: "plan" }, "user")).toEqual({ ok: true, value: { mode: "plan" } });
    expect(h.audit).toContainEqual(expect.objectContaining({ event: "code", phase: "mode", by: "user", agentMode: "plan" }));
    // The companion changes no mode (docs/CODING-APP.md §5): refused in the hub, and the refusal audited with its actor.
    expect(await h.hub.dispatch({ type: "setAgentMode", sessionId: id, mode: "interactive" }, "companion")).toMatchObject({ ok: false });
    expect(h.audit).toContainEqual(expect.objectContaining({ event: "code", phase: "companion", command: "setAgentMode", refused: true }));
  });

  it("record a message as its length only, and stop the session when a record can't be written", async () => {
    const h = harness();
    const id = await started(h);
    expect(await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: "fix the bug in parser.ts" } }, "user")).toEqual({ ok: true, value: { messageId: "msg-1" } });
    expect(h.audit).toContainEqual(expect.objectContaining({ phase: "sent", chars: 24, by: "user" }));
    expect(JSON.stringify(h.audit)).not.toContain("parser");
    h.deps.audit = () => ({ write: () => { throw new Error("disk full"); } });
    expect(await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: "again" } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.audit });
    expect(h.fake.called("abort").length).toBeGreaterThan(0);
  });

  it("attach only paths main offered or in the session's folder, never Ember's data, and pictures within the limit", async () => {
    const h = harness();
    const id = await started(h);
    fs.writeFileSync(path.join(work, "a.txt"), "a");
    const picked = await h.hub.dispatch({ type: "pickAttachments", sessionId: id }, "user");
    expect(picked).toEqual({ ok: true, value: [{ type: "file", path: path.join(work, "a.txt"), displayName: "a.txt" }] });
    const send = (attachments: unknown) => h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: "see", attachments: attachments as never } }, "user");
    expect(await send([{ type: "file", path: path.join(work, "a.txt") }])).toMatchObject({ ok: true });
    expect(await send([{ type: "file", path: path.join(dir, "elsewhere.txt") }])).toEqual({ ok: false, reason: CODE_REFUSALS.attachment });
    expect(await send([{ type: "file", path: path.join(userData, "settings.json") }])).toEqual({ ok: false, reason: CODE_REFUSALS.attachment });
    expect(await send([{ type: "blob", data: "aGk=", mimeType: "text/html" }])).toEqual({ ok: false, reason: CODE_REFUSALS.attachment });
    expect(await send([{ type: "blob", data: "aGk=", mimeType: "image/png" }])).toMatchObject({ ok: true });
  });

  it("let a window call the SDK's RPC methods on the allow-list, and refuse the rest in plain words", async () => {
    const h = harness();
    const id = await started(h);
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "history.listRewindPoints" } }, "user")).toEqual({ ok: true, value: { fileChangeTrackingEnabled: true, points: [] } });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "models.list" } }, "user")).toEqual({ ok: true, value: { models: [{ id: "m" }] } });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "options.update", params: { sandboxConfig: { enabled: false } } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcNotAllowed });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "permissions.paths.list", params: { where: userData } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcPath });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: "nope", method: "history.listRewindPoints" } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.closed });
  });

  it("stop every session when the gate closes, and stop and let go of every one at sign-out", async () => {
    let consent = true;
    const h = harness({ hasConsent: () => consent });
    const id = await started(h);
    consent = false;
    await h.hub.changed();
    expect(h.fake.called("abort")).toHaveLength(1);
    consent = true;
    await h.hub.accountEnded();
    expect(h.fake.called("disconnect")).toHaveLength(1);
    expect((await h.hub.dispatch({ type: "list" }, "user")).sessions.find(r => r.id === id)?.open).toBe(false);
    expect(h.audit).toContainEqual(expect.objectContaining({ phase: "close", session: id }));
  });

  it("keeps pinned and archived in Ember's index, forks into a new row that names its parent, and removes a session with its record", async () => {
    const h = harness();
    const id = await started(h, { name: "First" });
    expect(await h.hub.dispatch({ type: "update", sessionId: id, change: { pinned: true, archived: true, name: "Renamed" } }, "user")).toMatchObject({ ok: true, value: { pinned: true, archived: true, name: "Renamed" } });
    expect(h.fake.called("name.set").at(-1)?.params).toEqual({ name: "Renamed" });
    const forked = await h.hub.dispatch({ type: "fork", sessionId: id, name: "Fork" }, "user");
    expect(forked).toMatchObject({ ok: true, value: { id: "forked-1", parentId: id, name: "Fork", open: false } });
    expect(await h.hub.dispatch({ type: "remove", sessionId: id }, "user")).toEqual({ ok: true });
    expect(h.fake.called("deleteSession").at(-1)?.params).toBe(id);
    expect(h.deps.index!.session(id)).toBeUndefined();
    expect(h.sent).toContainEqual({ channel: "code:row", payload: { removed: id } });
    expect(await h.hub.dispatch({ type: "remove", sessionId: id }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.unknown });
  });
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
function hasGit(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; /* no git here: the worktree test skips */ }
}
function gitIn(cwd: string, ...args: string[]): string { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }); }

describe("the coding hub's additions to the contract", () => {
  it("counts what happens in a session nobody shows as unread, kept in the index at once, and nothing while a window shows it with the focus (markRead)", async () => {
    const h = harness();
    const id = await started(h);
    h.fake.emit("assistant.message", { content: "one" });
    expect(h.rows().filter(r => r.id === id).at(-1)?.unread).toBe(1);
    await h.deps.index!.flushed();
    const saved = () => (JSON.parse(fs.readFileSync(indexFile(path.join(userData, "code")), "utf8")) as { sessions: Record<string, { unread: number }> }).sessions[id].unread;
    expect(saved()).toBe(1);
    await h.hub.dispatch({ type: "markRead", sessionId: id }, "user", "w1");
    expect(h.rows().filter(r => r.id === id).at(-1)?.unread).toBe(0);
    h.fake.emit("assistant.message", { content: "two" });
    h.fake.emit("permission.requested", { requestId: "r1", ...KINDS[0].data });
    expect((await h.hub.dispatch({ type: "list" }, "user")).sessions.find(r => r.id === id)?.unread).toBe(0);
    await h.deps.index!.flushed();
    expect(saved()).toBe(0);
    // The window let it go (detached, or closed): what follows is unread again.
    await h.hub.dispatch({ type: "detach", sessionId: id }, "user", "w1");
    h.fake.emit("assistant.message", { content: "three" });
    expect((await h.hub.dispatch({ type: "list" }, "user")).sessions.find(r => r.id === id)?.unread).toBe(1);
    await h.hub.dispatch({ type: "markRead", sessionId: id }, "user", "w2");
    h.hub.windowGone("w2");
    h.fake.emit("assistant.message", { content: "four" });
    expect((await h.hub.dispatch({ type: "list" }, "user")).sessions.find(r => r.id === id)?.unread).toBe(1);
  });

  it("refuses to remove a project while any session is under it, in a plain sentence, and removes it once none is", async () => {
    const h = harness();
    const id = await started(h);
    const projectId = h.deps.index!.session(id)!.projectId;
    await h.hub.dispatch({ type: "update", sessionId: id, change: { archived: true } }, "user");
    expect(await h.hub.dispatch({ type: "removeProject", projectId }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.projectHasSessions, code: "has-sessions" });
    expect(h.deps.index!.project(projectId)).toBeDefined();
    await h.hub.dispatch({ type: "remove", sessionId: id }, "user");
    expect(await h.hub.dispatch({ type: "removeProject", projectId }, "user")).toEqual({ ok: true });
    expect(await h.hub.dispatch({ type: "removeProject", projectId }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.project });
  });

  it("lists a session the runtime keeps and the index doesn't under the project of its folder, and one in a folder Ember won't work in under none", async () => {
    const fake = fakeClient();
    (fake.client as unknown as { listSessions: () => Promise<unknown[]> }).listSessions = async () => [
      { sessionId: "kept-1", summary: "Older work", startTime: "2026-11-01T10:00:00Z", modifiedTime: "2026-11-02T10:00:00Z", context: { workingDirectory: work } },
      { sessionId: "kept-2", summary: "In Ember's data", startTime: "2026-11-01T10:00:00Z", modifiedTime: "2026-11-02T10:00:00Z", context: { workingDirectory: userData } },
    ];
    const h = harness({}, fake);
    const listed = await h.hub.dispatch({ type: "list" }, "user");
    const project = listed.projects.find(p => p.folder === work);
    expect(project).toMatchObject({ name: "work", gitRoot: work });
    expect(listed.sessions.find(r => r.id === "kept-1")).toMatchObject({ projectId: project!.id, folder: work, name: "Older work", createdBy: "system" });
    expect(listed.sessions.find(r => r.id === "kept-2")).toMatchObject({ projectId: "", folder: userData });
    expect(h.deps.index!.session("kept-1")).toMatchObject({ projectId: project!.id });
    expect(h.deps.index!.session("kept-2")).toBeUndefined();
  });

  it("opens only an http or https address with no sign-in in it, through main's opener, auditing its host alone", async () => {
    const opened: string[] = [];
    const h = harness({ openExternal: async url => { opened.push(url); } });
    const url = "https://docs.example.com/guide/private-file.md?token=abc";
    expect(await h.hub.dispatch({ type: "openLink", url }, "user")).toEqual({ ok: true });
    expect(opened).toEqual([url]);
    expect(h.audit).toContainEqual({ event: "code", phase: "link", by: "user", host: "docs.example.com" });
    expect(JSON.stringify(h.audit)).not.toContain("private-file");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "mailto:a@example.com", "not a url", `https://example.com/${"a".repeat(2100)}`])
      expect(await h.hub.dispatch({ type: "openLink", url: bad }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.link });
    expect(await h.hub.dispatch({ type: "openLink", url: "https://me:secret@example.com/" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.linkCredentials });
    expect(opened).toHaveLength(1);
    expect(await harness().hub.dispatch({ type: "openLink", url }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.linkFailed });
    expect(await harness({ openExternal: async () => { throw new Error("no browser"); } }).hub.dispatch({ type: "openLink", url }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.linkFailed });
    expect(await harness({ enabled: () => false, openExternal: async u => { opened.push(u); } }).hub.dispatch({ type: "openLink", url }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.off });
    expect(opened).toHaveLength(1);
  });

  it.skipIf(!hasGit())("gives a fork of a worktree session a worktree of its own with its parent's work, which outlives the parent", async () => {
    gitIn(work, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(work, "a.txt"), "a\n");
    gitIn(work, "add", ".");
    gitIn(work, "commit", "-qm", "init");
    const h = harness({ git: gitRunner(gitEnv) });
    const parent = await h.hub.dispatch({ type: "create", options: { isolation: "worktree" } }, "user");
    if (!parent.ok) throw new Error(parent.reason);
    const from = parent.value.folder;
    fs.writeFileSync(path.join(from, "a.txt"), "a changed\n");
    fs.writeFileSync(path.join(from, "new.txt"), "untracked\n");
    const forked = await h.hub.dispatch({ type: "fork", sessionId: parent.value.id }, "user");
    if (!forked.ok) throw new Error(forked.reason);
    expect(forked.value).toMatchObject({ isolation: "worktree", parentId: parent.value.id });
    expect(forked.value.folder).not.toBe(from);
    expect(forked.value.branch).not.toBe(parent.value.branch);
    expect(fs.readFileSync(path.join(forked.value.folder, "a.txt"), "utf8")).toBe("a changed\n");
    expect(fs.readFileSync(path.join(forked.value.folder, "new.txt"), "utf8")).toBe("untracked\n");
    // The parent's own folder is as it was, and removing the parent leaves the fork's whole.
    expect(fs.readFileSync(path.join(from, "a.txt"), "utf8")).toBe("a changed\n");
    expect(await h.hub.dispatch({ type: "remove", sessionId: parent.value.id }, "user")).toEqual({ ok: true });
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(path.join(forked.value.folder, "a.txt"), "utf8")).toBe("a changed\n");
    expect(await h.hub.dispatch({ type: "remove", sessionId: forked.value.id }, "user")).toEqual({ ok: true });
    expect(fs.existsSync(forked.value.folder)).toBe(false);
  }, 30_000);

  it("makes no fork of a worktree session whose worktree it can't make, deleting the copy the runtime made", async () => {
    const h = harness();
    h.deps.index!.addProject({ folder: work, name: "work", gitRoot: work });
    const projectId = h.deps.index!.projectAt(work)!.id;
    const tree = path.join(userData, "code", "worktrees", "tree-1");
    h.deps.index!.addSession("tree-1", { projectId, folder: tree, isolation: "worktree", createdBy: "user", branch: "ember/tree1", worktree: tree, gitRoot: work });
    expect(await h.hub.dispatch({ type: "fork", sessionId: "tree-1" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.forkTree });
    expect(h.fake.called("deleteSession").at(-1)?.params).toBe("forked-1");
    expect(h.deps.index!.session("forked-1")).toBeUndefined();
  });
});

describe("the hub's window on the runtime's real answers", () => {
  it("never sends an MCP server's variable or header values to the window, and puts the stored ones back on an edit (real mcp.config.list)", async () => {
    const h = harness();
    let stored = structuredClone(REAL.mcpConfigRaw) as unknown as { servers: Record<string, Record<string, unknown>> };
    const sentUpdates: unknown[] = [];
    (h.fake.client.rpc as unknown as Record<string, unknown>).mcp = { config: {
      list: async () => structuredClone(stored),
      update: async (p: { name: string; config: Record<string, unknown> }) => { sentUpdates.push(p); stored = { servers: { ...stored.servers, [p.name]: p.config } }; return null; },
      add: async (p: unknown) => { sentUpdates.push(p); return null; },
    } };
    const listed = await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "mcp.config.list" } }, "user");
    if (!listed.ok) throw new Error(listed.reason);
    expect(JSON.stringify(listed.value)).not.toMatch(/s3cret|Bearer tok/);
    const servers = (listed.value as typeof stored).servers;
    expect(servers.probe.env).toEqual({ PROBE_SECRET: CODE_KEPT });
    expect(servers.web.headers).toEqual({ Authorization: CODE_KEPT });
    expect(servers.probe.command).toBe("/usr/bin/node");
    // The window sends the marker back for a value left as it was: the runtime gets the stored one.
    const updated = await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "mcp.config.update", params: { name: "probe", config: { ...servers.probe, args: ["/tmp/p/mcp-server.cjs", "--x"], env: { PROBE_SECRET: CODE_KEPT, NEW: "typed" } } } } }, "user");
    expect(updated).toMatchObject({ ok: true });
    expect(sentUpdates.at(-1)).toEqual({ name: "probe", config: { tools: ["*"], command: "/usr/bin/node", args: ["/tmp/p/mcp-server.cjs", "--x"], env: { PROBE_SECRET: "s3cret", NEW: "typed" } } });
    // A marker with nothing stored behind it is refused, never sent as a value.
    const n = sentUpdates.length;
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "mcp.config.add", params: { name: "other", config: { command: "x", env: { K: CODE_KEPT } } } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcKept });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "mcp.config.update", params: { name: "probe", config: { command: "x", env: { OTHER: CODE_KEPT } } } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcKept });
    expect(sentUpdates.length).toBe(n);
  });

  it("says a runtime method's failure in Ember's words, never the model service's or the runtime's (real messages)", async () => {
    const h = harness();
    const id = await started(h);
    (h.fake.rpc as unknown as Record<string, unknown>).workspaces = { statFile: async () => { throw new Error(REAL.errors.statFile); }, diff: async () => { throw new Error(REAL.errors.includeContents); } };
    (h.fake.client.rpc as unknown as Record<string, unknown>).models = { list: async () => { throw new Error(REAL.errors.signedOut); } };
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "workspaces.statFile", params: { path: "a.txt" } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcUnsupported });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "workspaces.diff", params: { mode: "unstaged", includeContents: true } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcUnsupported });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "models.list", params: {} } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcSignIn });
  });

  it("gives the tokenless runtime's account-wide lists the sign-in, never a token the window sent (models.list answered Not authenticated)", async () => {
    const token = "gho_" + "t".repeat(36);
    const seen: unknown[] = [];
    const h = harness({ access: () => ({ gitHubToken: token, model: "gpt-5.5", service: false }) });
    (h.fake.client.rpc as unknown as Record<string, unknown>).models = { list: async (p: unknown) => { seen.push(p); return { models: [] }; } };
    (h.fake.client.rpc as unknown as Record<string, unknown>).account = { getQuota: async (p: unknown) => { seen.push(p); return { quotaSnapshots: {} }; } };
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "models.list", params: { gitHubToken: "gho_window" } } }, "user")).toMatchObject({ ok: true });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "account.getQuota", params: {} } }, "user")).toMatchObject({ ok: true });
    expect(seen).toEqual([{ gitHubToken: token }, { gitHubToken: token }]);
    // With a provider of the user's own there is no sign-in: none goes, the window's neither.
    const own = harness();
    const ownSeen: unknown[] = [];
    (own.fake.client.rpc as unknown as Record<string, unknown>).models = { list: async (p: unknown) => { ownSeen.push(p); return { models: [] }; } };
    await own.hub.dispatch({ type: "rpc", call: { scope: "client", method: "models.list", params: { gitHubToken: "gho_window" } } }, "user");
    expect(ownSeen).toEqual([{}]);
  });

  it("lets a client discovery call name a worktree Ember made for a session, and still refuses the rest of Ember's data", async () => {
    const h = harness();
    const seen: unknown[] = [];
    (h.fake.client.rpc as unknown as Record<string, unknown>).skills = { discover: async (p: unknown) => { seen.push(p); return { skills: [], errors: [] }; } };
    h.deps.index!.addProject({ folder: work, name: "work", gitRoot: work });
    const projectId = h.deps.index!.projectAt(work)!.id;
    const tree = path.join(userData, "code", "worktrees", "tree-1");
    h.deps.index!.addSession("tree-1", { projectId, folder: tree, isolation: "worktree", createdBy: "user", branch: "ember/tree1", worktree: tree, gitRoot: work });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "skills.discover", params: { projectPaths: [tree] } } }, "user")).toMatchObject({ ok: true });
    expect(seen).toEqual([{ projectPaths: [tree] }]);
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "skills.discover", params: { projectPaths: [path.join(userData, "code", "worktrees", "not-a-session")] } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcPath });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "skills.discover", params: { projectPaths: [path.join(userData, "settings.json")] } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.rpcPath });
  });
});

describe.skipIf(!hasGit())("listing and reading a session's working folder (listFolder, readFile)", () => {
  function repo(): void {
    const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    g("init", "-q", "-b", "main");
    fs.mkdirSync(path.join(work, "src", "deep"), { recursive: true });
    fs.mkdirSync(path.join(work, "ignored"));
    fs.writeFileSync(path.join(work, ".gitignore"), "ignored/\n*.log\n");
    fs.writeFileSync(path.join(work, "a.txt"), "alpha\n");
    fs.writeFileSync(path.join(work, "src", "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(work, "src", "deep", "c.md"), "# C\n");
    fs.writeFileSync(path.join(work, "debug.log"), "log\n");
    fs.writeFileSync(path.join(work, "ignored", "x.txt"), "x\n");
    fs.writeFileSync(path.join(work, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
    fs.writeFileSync(path.join(work, "big.txt"), "x".repeat(CODE_LIMITS.fileBytes + 1));
    fs.writeFileSync(path.join(userData, "settings.json"), "PRIVATE");
    fs.symlinkSync(path.join(userData, "settings.json"), path.join(work, "escape.txt"));
    fs.symlinkSync(path.join(work, "src"), path.join(work, "src-link"));
    g("add", "."); g("commit", "-qm", "init");
  }

  it("lists a folder rooted at the session's folder, folders first, without .git, what git ignores or a link out of it, and offers its files for attaching", async () => {
    repo();
    const h = harness({ git: gitRunner() });
    const id = await started(h);
    const top = await h.hub.dispatch({ type: "listFolder", sessionId: id, relDir: "" }, "user");
    if (!top.ok) throw new Error(top.reason);
    expect(top.value.entries.map(e => [e.name, e.kind])).toEqual([["src", "folder"], ["src-link", "folder"], [".gitignore", "file"], ["a.txt", "file"], ["big.txt", "file"], ["logo.png", "file"]]);
    expect(top.value.gitPrefix).toBe("");
    expect(top.value.entries.find(e => e.name === "a.txt")).toEqual({ name: "a.txt", kind: "file", size: 6, path: path.join(work, "a.txt") });
    const src = await h.hub.dispatch({ type: "listFolder", sessionId: id, relDir: "src" }, "user");
    expect(src).toMatchObject({ ok: true, value: { entries: [{ name: "deep", kind: "folder" }, { name: "b.ts", kind: "file" }] } });
    // A listed file may be attached.
    expect(await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: "look", attachments: [{ type: "file", path: path.join(work, "src", "b.ts") }] } }, "user")).toMatchObject({ ok: true });
    // Out of the folder, into .git, by a link or into Ember's data: refused with one sentence.
    for (const rel of ["..", "../userdata", "/etc", ".git", "src/../../userdata", "escape.txt"]) {
      expect(await h.hub.dispatch({ type: "listFolder", sessionId: id, relDir: rel }, "user"), rel).toEqual({ ok: false, reason: CODE_REFUSALS.folderPath });
    }
    expect(await h.hub.dispatch({ type: "readFile", sessionId: id, relPath: "escape.txt" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.folderPath });
    expect(await h.hub.dispatch({ type: "readFile", sessionId: id, relPath: ".git/config" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.folderPath });
  });

  it("reads a file's text, says a binary or too large one is that, and lists a subfolder session with where it sits in its repository", async () => {
    repo();
    const h = harness({ git: gitRunner() });
    const id = await started(h);
    expect(await h.hub.dispatch({ type: "readFile", sessionId: id, relPath: "src/b.ts" }, "user")).toEqual({ ok: true, value: { text: "export const b = 1;\n", size: 20 } });
    expect(await h.hub.dispatch({ type: "readFile", sessionId: id, relPath: "logo.png" }, "user")).toEqual({ ok: true, value: { binary: true, size: 7 } });
    expect(await h.hub.dispatch({ type: "readFile", sessionId: id, relPath: "big.txt" }, "user")).toEqual({ ok: true, value: { tooLarge: true, size: CODE_LIMITS.fileBytes + 1 } });
    expect(await h.hub.dispatch({ type: "readFile", sessionId: id, relPath: "nope.txt" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.folderPath });
    expect(await h.hub.dispatch({ type: "readFile", sessionId: "unknown-session", relPath: "a.txt" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.unknown });
    const sub = harness({ git: gitRunner(), pickFolder: async () => path.join(work, "src") });
    const sid = await started(sub);
    expect(await sub.hub.dispatch({ type: "listFolder", sessionId: sid, relDir: "" }, "user")).toMatchObject({ ok: true, value: { gitPrefix: "src/", entries: [{ name: "deep" }, { name: "b.ts" }] } });
  });

  it("lists a folder that isn't a repository with its build and dependency folders left out", async () => {
    fs.mkdirSync(path.join(work, "node_modules"));
    fs.mkdirSync(path.join(work, "lib"));
    fs.writeFileSync(path.join(work, "x.js"), "1");
    const h = harness({ git: gitRunner() });
    const id = await started(h);
    const r = await h.hub.dispatch({ type: "listFolder", sessionId: id, relDir: "" }, "user");
    expect(r).toMatchObject({ ok: true, value: { entries: [{ name: "lib", kind: "folder" }, { name: "x.js", kind: "file" }] } });
    expect((r as { value: { gitPrefix?: string } }).value.gitPrefix).toBeUndefined();
  });
});

describe("the companion acting for the user (docs/CODING-APP.md §5)", () => {
  const refused = (r: unknown) => expect(r).toMatchObject({ ok: false });

  it("may list, start in a known project, send, stop and Stop everything, and is refused every other command in the hub, each audited with its actor", async () => {
    const h = harness();
    const id = await started(h);
    const projectId = h.hub.companionRead(id)!.row.projectId;
    const forbidden = [
      { type: "respond", answer: { sessionId: id, requestId: "x", kind: "permission", payload: {} } },
      { type: "setPermissionMode", sessionId: id, mode: "allow-all" }, { type: "setAgentMode", sessionId: id, mode: "autopilot" },
      { type: "update", sessionId: id, change: { name: "x" } }, { type: "fork", sessionId: id }, { type: "remove", sessionId: id },
      { type: "addProject" }, { type: "removeProject", projectId }, { type: "pickAttachments", sessionId: id },
      { type: "rpc", call: { scope: "client", method: "models.list" } }, { type: "attach", sessionId: id }, { type: "openLink", url: "https://example.com" },
      { type: "create", options: {} }, { type: "create", options: { projectId, permissionMode: "allow-all" } }, { type: "create", options: { projectId, agentMode: "autopilot" } },
      { type: "send", message: { sessionId: id, prompt: "x", attachments: [{ type: "file", path: path.join(work, "a.txt") }] } },
      { type: "send", message: { sessionId: id, prompt: "x", agentMode: "shell" } },
    ] as const;
    for (const c of forbidden) refused(await h.hub.dispatch(c as never, "companion"));
    expect(h.fake.called("permissions.setMode").map(c => (c.params as { mode: string }).mode)).not.toContain("allow-all");
    expect(h.deps.index!.session(id)).toBeDefined();
    expect(h.audit.filter(e => e.phase === "companion" && e.refused === true)).toHaveLength(forbidden.length);
    const made = await h.hub.dispatch({ type: "create", options: { projectId } }, "companion");
    expect(made).toMatchObject({ ok: true, value: { createdBy: "companion", permissionMode: "manual", agentMode: "interactive" } });
    expect(await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: "fix the test" } }, "companion")).toMatchObject({ ok: true });
    expect(h.audit).toContainEqual(expect.objectContaining({ event: "code", phase: "sent", by: "companion", chars: 12 }));
    expect(await h.hub.dispatch({ type: "interrupt", sessionId: id }, "companion")).toEqual({ ok: true });
    expect(h.audit).toContainEqual(expect.objectContaining({ event: "code", phase: "interrupt", by: "companion" }));
  });

  it("is held to its pace: past twenty commands a minute it is refused until the minute moves on, while Stop everything always goes", async () => {
    let t = 1_000_000;
    const h = harness({ now: () => t });
    for (let i = 0; i < 20; i++) expect(await h.hub.dispatch({ type: "list" }, "companion")).toHaveProperty("projects");
    expect(await h.hub.dispatch({ type: "list" }, "companion")).toMatchObject({ ok: false });
    await h.hub.dispatch({ type: "stopAll" }, "companion");
    expect(h.audit.at(-1)).toMatchObject({ phase: "companion", command: "stopAll" });
    expect(h.audit.at(-1)?.refused).toBeUndefined();
    t += 60_001;
    expect(await h.hub.dispatch({ type: "list" }, "companion")).toHaveProperty("projects");
  });

  it("reads a session's row, held events and waiting requests without opening anything, and nothing while sessions may not run", async () => {
    let on = true;
    const h = harness({ enabled: () => on });
    const id = await started(h);
    h.fake.emit("permission.requested", { requestId: "c1", ...KINDS[0].data });
    const seen = h.hub.companionRead(id)!;
    expect(seen.row.id).toBe(id);
    expect(seen.waiting.map(w => w.requestId)).toEqual(["c1"]);
    expect(h.hub.projectNameOf(id)).toBe(path.basename(work));
    expect(h.audit).toContainEqual(expect.objectContaining({ event: "code", session: id, phase: "companion", command: "read" }));
    expect(h.hub.companionRead("nobody")).toBeNull();
    on = false;
    expect(h.hub.companionRead(id)).toBeNull();
  });
});
