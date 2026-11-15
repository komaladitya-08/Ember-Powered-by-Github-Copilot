// Exercise the pinned runtime, not an SDK mock. All model responses and tool effects are local and deterministic.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection, type CopilotSession, type PermissionRequest, type PermissionRequestResult } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import type { OS } from "../../app/shared/shortcuts";

let mock: { baseUrl: string; close(): Promise<void> };
let dir: string;
let client: CopilotClient;
const sessions: CopilotSession[] = [];
beforeAll(async () => {
  mock = await startMockLlm({ delayMs: 1 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-sdk-permission-modes-"));
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  client = new CopilotClient({
    mode: "empty", baseDirectory: path.join(dir, "copilot"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  await client.start();
}, 60_000);
afterAll(async () => {
  await Promise.all(sessions.map(s => s.disconnect()));
  await client?.stop();
  await mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the bundled Copilot runtime permission modes", () => {
  for (const { mode, skipPermission, expectsRequest } of [
    { mode: "manual", skipPermission: true, expectsRequest: false },
    { mode: "manual", skipPermission: false, expectsRequest: true },
    { mode: "allow-all", skipPermission: true, expectsRequest: false },
    { mode: "allow-all", skipPermission: false, expectsRequest: false },
  ] as const) {
    it(`${mode}: skipPermission=${skipPermission} ${expectsRequest ? "requests permission" : "executes without a permission request"}`, async () => {
      const requests: PermissionRequest[] = [];
      let calls = 0;
      const session = await client.createSession({
        model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
        workingDirectory: dir, availableTools: [], enableConfigDiscovery: false,
        tools: [{ name: "probe_action", description: "Count a local test call", parameters: { type: "object", properties: {}, additionalProperties: false },
          defer: "never", skipPermission, handler: () => { calls++; return "done"; } }],
        onPermissionRequest: request => { requests.push(request); return { kind: "approved" }; },
      });
      sessions.push(session);
      expect(await session.rpc.permissions.setMode({ mode })).toMatchObject({ success: true, mode });
      expect(await session.rpc.permissions.getMode()).toEqual({ mode });
      const idle = new Promise<void>(resolve => session.on(e => { if (e.type === "session.idle") resolve(); }));
      await session.send({ prompt: "CALLTOOL:probe_action{}" });
      await idle;
      expect(calls).toBe(1);
      expect(requests.map(r => r.kind)).toEqual(expectsRequest ? ["custom-tool"] : []);
    }, 30_000);
  }

  it("reports the authoritative assisted mode, including when the provider does not support it", async () => {
    const session = await client.createSession({
      model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workingDirectory: dir, availableTools: [], enableConfigDiscovery: false,
      onPermissionRequest: () => ({ kind: "reject" }),
    });
    sessions.push(session);
    const result = await session.rpc.permissions.setMode({ mode: "assisted" });
    expect(await session.rpc.permissions.getMode()).toEqual({ mode: result.mode });
    if (result.success) expect(result.mode).toBe("assisted");
    else expect(result.mode).toBe("manual");
  }, 30_000);

  it("exposes agent autopilot separately from permission mode", async () => {
    const session = await client.createSession({
      model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workingDirectory: dir, availableTools: [], enableConfigDiscovery: false,
      onPermissionRequest: () => ({ kind: "reject" }),
    });
    sessions.push(session);
    await session.rpc.permissions.setMode({ mode: "manual" });
    const result = await session.rpc.mode.set({ mode: "autopilot" });
    expect(result.modeApplied).toBe(true);
    expect(await session.rpc.mode.get()).toBe("autopilot");
    expect(await session.rpc.permissions.getMode()).toEqual({ mode: "manual" });
  }, 30_000);

  it("delivers a native shell permission event before an async handler resumes", async () => {
    let observed: PermissionRequest | undefined;
    let matched = false;
    const session = await client.createSession({
      model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workingDirectory: dir, availableTools: ["builtin:bash"], enableConfigDiscovery: false,
      onPermissionRequest: async request => {
        await Promise.resolve();
        matched = observed === request && request.kind === "shell" && !!request.toolCallId;
        // Runtime 1.0.97 expects this wire variant even though SDK 1.0.21 declares "approved".
        return { kind: "approve-once" } as unknown as PermissionRequestResult;
      },
    });
    sessions.push(session);
    session.on(event => { if (event.type === "permission.requested") observed = event.data.permissionRequest; });
    await session.rpc.permissions.setMode({ mode: "manual" });
    const finished = new Promise<boolean>(resolve => session.on(event => {
      if (event.type === "tool.execution_complete") resolve(event.data.success);
    }));
    await session.send({ prompt: 'CALLTOOL:bash{"command":"printf probe","description":"print probe"}' });
    expect(await finished).toBe(true);
    expect(matched).toBe(true);
  }, 30_000);
});
