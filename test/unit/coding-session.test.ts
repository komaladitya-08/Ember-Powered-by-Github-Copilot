import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotClient, PermissionRequest, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { CodingSession, codingWorkspace } from "../../app/main/agent/coding-session";

const dirs: string[] = [];
const folder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-coding-")); dirs.push(d); return d; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fake() {
  let config!: SessionConfig;
  let agentMode = "interactive";
  let permissionMode = "manual";
  const listeners = new Set<(event: SessionEvent) => void>();
  const reply = deferred<{ data: { content: string } }>();
  const api = {
    sessionId: "coding-1", on: (f: (event: SessionEvent) => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    send: vi.fn(async () => "message-1"), sendAndWait: vi.fn(() => reply.promise), abort: vi.fn(async (): Promise<void> => undefined), disconnect: vi.fn(async (): Promise<void> => undefined),
    rpc: {
      permissions: { setMode: vi.fn(async ({ mode }: { mode: string }) => { permissionMode = mode; return { success: true, mode }; }) },
      mode: { set: vi.fn(async ({ mode }: { mode: string }) => { agentMode = mode; return { modeApplied: true }; }), get: vi.fn(async () => agentMode) },
      options: { update: vi.fn(async () => ({ success: true })) },
    },
  };
  const client = { rpc: { sandbox: { getHostSupport: vi.fn(async () => ({ supported: true, capabilities: [{name: "shell", supported: true}, {name: "denied_paths", supported: true}, {name: "network", supported: true}] })) } }, createSession: vi.fn(async (c: SessionConfig) => { config = c; return api; }), deleteSession: vi.fn(async () => undefined) } as unknown as CopilotClient;
  return { client, api, reply, config: () => config, permissionMode: () => permissionMode, event: (event: SessionEvent) => { for (const listener of listeners) listener(event); } };
}

describe("native coding session", () => {
  it("passes GitHub auth only to the session and rejects mixing it with a provider", async () => {
    const f = fake(), workspace = folder(), protectedPaths = [folder()];
    const opts = { client: f.client, workspace, protectedPaths, mode: "interactive" as const, preToolUse: () => null, permission: () => ({ kind: "reject" as const }) };
    const session = await CodingSession.create({ ...opts, gitHubToken: "fake-test-token" });
    expect(f.config().gitHubToken).toBe("fake-test-token");
    await session.close();
    await expect(CodingSession.create({ ...opts, gitHubToken: "fake-test-token", provider: { type: "openai", baseUrl: "http://localhost", apiKey: "fake" } })).rejects.toThrow("both");
  });
  it("offers native tools in a validated workspace and preserves the SDK default system prompt", async () => {
    const f = fake(), workspace = folder();
    const session = await CodingSession.create({ client: f.client, workspace, mode: "interactive", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "approved" }) });
    expect(f.config().workingDirectory).toBe(await codingWorkspace(workspace));
    expect(f.config().availableTools).toEqual(["builtin:*"]);
    expect(f.config().systemMessage).toBeUndefined();
    expect(f.permissionMode()).toBe("manual");
    expect(f.api.rpc.options.update).toHaveBeenCalledWith(expect.objectContaining({ sandboxConfig: expect.objectContaining({ enabled: true, allowBypass: false,
      userPolicy: expect.objectContaining({ filesystem: expect.objectContaining({ deniedPaths: expect.arrayContaining([path.join(os.tmpdir(), "ember-test-private")]) }) }) }) }));
    await session.close();
    expect(f.api.disconnect).toHaveBeenCalledOnce();
    await expect(codingWorkspace("relative")).rejects.toThrow();
  });

  it("refuses to create a coding session when the host cannot enforce denied paths", async () => {
    const f = fake();
    vi.mocked(f.client.rpc.sandbox.getHostSupport).mockResolvedValueOnce({ supported: true, capabilities: [{ name: "shell", supported: true }, { name: "denied_paths", supported: false }] });
    await expect(CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [folder()], preToolUse: () => null,
      permission: () => ({ kind: "reject" }) })).rejects.toThrow("sandbox");
    expect(f.client.createSession).not.toHaveBeenCalled();
  });

  it("reports when the sandbox cannot permit network access", async () => {
    const f = fake();
    vi.mocked(f.client.rpc.sandbox.getHostSupport).mockResolvedValueOnce({ supported: true, capabilities: [{ name: "shell", supported: true }, { name: "denied_paths", supported: true }, { name: "network", supported: false }] });
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [folder()], preToolUse: () => null,
      permission: () => ({ kind: "reject" }) });
    expect(session.modeStatus.warning).toContain("network");
    expect(f.api.rpc.options.update).toHaveBeenCalledWith(expect.objectContaining({ sandboxConfig: expect.objectContaining({ userPolicy: expect.objectContaining({ network: { allowOutbound: false } }) }) }));
    await session.close();
  });

  it("reports a native Assisted mode refusal and falls back to manual", async () => {
    const f = fake();
    f.api.rpc.permissions.setMode.mockImplementation(async ({ mode }) => mode === "assisted" ? { success: false, mode: "manual" } : { success: true, mode });
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "assisted", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    expect(session.modeStatus).toMatchObject({ requested: "assisted", permissionMode: "manual", warning: expect.stringContaining("unavailable") });
    await session.close();
  });

  it("enables allow-all only when the host explicitly permits it", async () => {
    const f = fake();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "autopilot", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    expect(session.modeStatus.permissionMode).toBe("manual");
    await session.setMode("autopilot", true);
    expect(session.modeStatus.permissionMode).toBe("allow-all");
    await session.close();
  });

  it("rejects a late approval when Stop occurs and aborts the active SDK run", async () => {
    const f = fake(), answer = deferred<{ kind: "approved" }>();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => answer.promise });
    const run = session.run("Inspect the project");
    const request = f.config().onPermissionRequest!({ kind: "read", path: "/x", intention: "inspect" } as PermissionRequest, { sessionId: "coding-1" });
    await session.stop();
    answer.resolve({ kind: "approved" });
    expect(await request).toMatchObject({ kind: "reject" });
    await expect(run).rejects.toThrow("stopped");
    expect(f.api.abort).toHaveBeenCalledOnce();
    await session.close();
  });

  it("translates a native approval for the bundled runtime without changing custom-tool approvals", async () => {
    const f = fake();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "approved" }) });
    const run = session.run("Inspect");
    const permit = f.config().onPermissionRequest!;
    expect(await permit({ kind: "read", path: "/x", intention: "inspect" } as PermissionRequest, { sessionId: "coding-1" })).toEqual({ kind: "approve-once" });
    expect(await permit({ kind: "custom-tool" } as PermissionRequest, { sessionId: "coding-1" })).toEqual({ kind: "approved" });
    f.reply.resolve({ data: { content: "Done" } });
    await expect(run).resolves.toBe("Done");
    await session.close();
  });

  it("denies native tools before execution when the safety guard refuses", async () => {
    const f = fake();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "autopilot", canAllowAll: true,
      protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: input => input.toolName === "view" ? "Private data is protected." : null, permission: () => ({ kind: "approved" }) });
    const run = session.run("Inspect");
    const hook = f.config().hooks!.onPreToolUse!;
    const input = { toolName: "view", toolArgs: { path: "/private" }, sessionId: session.sessionId, timestamp: new Date(), workingDirectory: session.workspace };
    expect(await hook(input, { sessionId: session.sessionId })).toEqual({ permissionDecision: "deny", permissionDecisionReason: "Private data is protected." });
    await session.stop();
    await expect(run).rejects.toThrow("stopped");
    await session.close();
  });

  it("fails closed when the safety guard errors", async () => {
    const f = fake();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive",
      protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => { throw new Error("probe failed"); }, permission: () => ({ kind: "approved" }) });
    const run = session.run("Inspect");
    const hook = f.config().hooks!.onPreToolUse!;
    const input = { toolName: "view", toolArgs: { path: "/x" }, sessionId: session.sessionId, timestamp: new Date(), workingDirectory: session.workspace };
    expect(await hook(input, { sessionId: session.sessionId })).toMatchObject({ permissionDecision: "deny" });
    f.reply.resolve({ data: { content: "Done" } });
    await run;
    await session.close();
  });

  it("does not report an idle Autopilot as a successful task without task_complete", async () => {
    const f = fake();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "autopilot", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    const run = session.run("Fix it");
    f.event({ type: "session.idle", data: {} } as SessionEvent);
    await session.stop();
    await expect(run).rejects.toThrow("stopped");
    await session.close();
  });

  it("waits for a root task_complete and then idle in native Autopilot", async () => {
    const f = fake();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "autopilot", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    const run = session.run("Fix it");
    f.event({ type: "session.task_complete", data: { success: true, summary: "Fixed." } } as SessionEvent);
    f.event({ type: "session.idle", data: {} } as SessionEvent);
    await expect(run).resolves.toBe("Fixed.");
    await session.close();
  });

  it("does not hand off on an ambiguous native Autopilot completion", async () => {
    const f = fake();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "autopilot", protectedPaths: [folder()], preToolUse: () => null, permission: () => ({ kind: "reject" }), requireCompletion: true });
    const run = session.run("Fix it");
    f.event({ type: "assistant.message", data: { toolRequests: [{ name: "finish_coding", toolCallId: "finish" }] } } as SessionEvent);
    f.event({ type: "tool.execution_start", data: { toolName: "finish_coding", toolCallId: "finish" } } as SessionEvent);
    const finish = f.config().tools!.find(tool => tool.name === "finish_coding")!;
    await finish.handler!({ success: true, summary: "Done." }, { toolName: "finish_coding", sessionId: session.sessionId, toolCallId: "finish", arguments: {} });
    f.event({ type: "tool.execution_complete", data: { toolCallId: "finish", success: true } } as SessionEvent);
    f.event({ type: "session.task_complete", data: { summary: "Done." } } as SessionEvent);
    f.event({ type: "session.idle", data: {} } as SessionEvent);
    await expect(run).rejects.toThrow();
    expect(session.handoffResult()).toBeNull();
    await session.close();
  });

  it("aborts the runtime if a coding request fails", async () => {
    const f = fake();
    f.api.sendAndWait.mockRejectedValueOnce(new Error("Timeout"));
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    await expect(session.run("Inspect")).rejects.toThrow("Timeout");
    expect(f.api.abort).toHaveBeenCalledOnce();
    await session.close();
  });

  it("waits for an in-flight abort before disconnecting a stopped session", async () => {
    const f = fake(), release = deferred<void>();
    f.api.abort.mockImplementation(() => release.promise);
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [folder()], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    const run = session.run("Inspect").catch(err => err);
    const stop = session.stop();
    const closing = session.close();
    await Promise.resolve();
    expect(f.api.abort).toHaveBeenCalledOnce();
    expect(f.api.disconnect).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([run, stop, closing]);
    expect(f.api.disconnect).toHaveBeenCalledOnce();
  });

  it("does not claim a task stopped when the runtime abort fails", async () => {
    const f = fake();
    f.api.abort.mockRejectedValueOnce(new Error("runtime unavailable"));
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [folder()], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    const run = session.run("Inspect").catch(err => err);
    await expect(session.stop()).rejects.toThrow("did not confirm");
    expect(await run).toBeInstanceOf(Error);
    await expect(session.close()).rejects.toThrow("did not confirm");
    expect(f.api.disconnect).toHaveBeenCalledOnce();
  });

  it("makes every close caller wait for the same teardown and preserves a failed teardown", async () => {
    const f = fake(), disconnected = deferred<void>();
    f.api.disconnect.mockImplementation(() => disconnected.promise);
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [folder()], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    const first = session.close(), second = session.close();
    expect(second).toBe(first);
    let settled = false;
    void second.then(() => { settled = true; });
    await vi.waitFor(() => expect(f.api.disconnect).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    disconnected.resolve();
    await Promise.all([first, second]);
    expect(f.client.deleteSession).toHaveBeenCalledOnce();

    const g = fake();
    g.api.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
    const failed = await CodingSession.create({ client: g.client, workspace: folder(), mode: "interactive", protectedPaths: [folder()], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    await expect(failed.close()).rejects.toThrow("disconnect failed");
    await expect(failed.close()).rejects.toThrow("disconnect failed");
    expect(g.api.disconnect).toHaveBeenCalledOnce();
    expect(g.client.deleteSession).toHaveBeenCalledOnce();
  });

  it("serializes concurrent changes so a later Interactive switch cannot leave allow-all enabled", async () => {
    const f = fake(), blocked = deferred<{ success: boolean; mode: string }>();
    const session = await CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "reject" }) });
    f.api.rpc.permissions.setMode.mockImplementation(async ({ mode }) => mode === "allow-all" ? blocked.promise : { success: true, mode });
    const auto = session.setMode("autopilot", true);
    await vi.waitFor(() => expect(f.api.rpc.permissions.setMode).toHaveBeenCalledWith({ mode: "allow-all" }));
    const interactive = session.setMode("interactive");
    blocked.resolve({ success: true, mode: "allow-all" });
    await expect(auto).rejects.toThrow("mode changed");
    await expect(interactive).resolves.toMatchObject({ requested: "interactive", permissionMode: "manual" });
    await session.close();
  });

  it("cleans up a session that is created after cancellation", async () => {
    const f = fake(), making = deferred<unknown>(), abort = new AbortController();
    vi.mocked(f.client.createSession).mockImplementation(() => making.promise as ReturnType<CopilotClient["createSession"]>);
    const pending = CodingSession.create({ client: f.client, workspace: folder(), mode: "interactive", protectedPaths: [path.join(os.tmpdir(), "ember-test-private")], preToolUse: () => null, permission: () => ({ kind: "reject" }), signal: abort.signal });
    await vi.waitFor(() => expect(f.client.createSession).toHaveBeenCalled());
    abort.abort();
    await expect(pending).rejects.toThrow("stopped");
    making.resolve(f.api);
    await vi.waitFor(() => expect(f.api.disconnect).toHaveBeenCalled());
    expect(f.client.deleteSession).toHaveBeenCalled();
  });
});
