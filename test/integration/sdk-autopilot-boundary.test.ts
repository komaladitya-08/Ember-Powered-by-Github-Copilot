// The real bundled Copilot runtime with a local, deterministic model: no account or external requests.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { hardenedSessionConfig, verifySessionTools } from "../../app/main/agent/session-config";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import type { OS } from "../../app/shared/shortcuts";

it("does not assume SDK Autopilot can finish with Ember's current tool allowlist", async () => {
  const mock = await startMockLlm({ delayMs: 0, respond: () => ({ text: "Finished." }) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-sdk-mode-"));
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const runtime = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe });
  expect(runtime.exists).toBe(true);
  const client = new CopilotClient({ mode: "empty", baseDirectory: dir, useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: runtime.path }),
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  let session: Awaited<ReturnType<typeof client.createSession>> | undefined;
  try {
    await client.start();
    session = await client.createSession(hardenedSessionConfig({
      model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, tools: [],
      systemMessage: { mode: "replace", content: "You are a test assistant." }, workingDirectory: dir,
      onPermissionRequest: () => ({ kind: "reject" }),
    }));
    await verifySessionTools(session, []);
    await session.rpc.mode.set({ mode: "autopilot" });
    expect(await session.rpc.mode.get()).toBe("autopilot");
    await session.send({ prompt: "Finish this task." });
    const deadline = Date.now() + 20_000;
    while (mock.requests.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(mock.requests.every((r: { tools: string[] }) => !r.tools.includes("task_complete"))).toBe(true);
    const continuation = mock.requests.slice(1).flatMap((r: { messages: { content: unknown }[] }) => r.messages)
      .map((m: { content: unknown }) => String(m.content)).join("\n");
    expect(continuation).toContain("task_complete");
  } finally {
    if (session) {
      await session.abort().catch(() => undefined);
      await client.deleteSession(session.sessionId).catch(() => undefined);
    }
    await client.stop().catch(() => undefined);
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
