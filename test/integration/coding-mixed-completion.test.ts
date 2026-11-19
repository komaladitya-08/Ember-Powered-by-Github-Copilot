// The actual pinned runtime against a deterministic local provider: no real file or desktop actions.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { CodingSession } from "../../app/main/agent/coding-session";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { withoutGitHubCredentials } from "../../app/main/agent/runtime-env";
import type { OS } from "../../app/shared/shortcuts";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

for (const scenario of ["success", "failure", "no-finish", "parallel", "failed-command", "denied-tool", "after-finish", "autopilot"] as const) {
  it(`requires an explicit standalone result for mixed handoff: ${scenario}`, async ctx => {
    let calls = 0;
    const mock = await startMockLlm({ delayMs: 0, respond: (_messages: unknown, tools: string[]) => {
      calls++;
      const finish = { name: "finish_coding", args: { success: scenario !== "failure", summary: scenario === "failure" ? "Tests failed." : "Built and tested." } };
      if (scenario === "failed-command" && calls === 1) return { tool: { name: "bash", args: { command: "exit 1" } } };
      if (scenario === "denied-tool" && calls === 1) return { tool: { name: "view", args: { path: "." } } };
      if ((scenario === "failed-command" || scenario === "denied-tool") && calls === 2) return { tool: finish };
      if (scenario === "after-finish" && calls === 2) return { tool: { name: "view", args: { path: "." } } };
      if (scenario === "autopilot" && calls === 2) return { tool: { name: "task_complete", args: { summary: "Built and tested." } } };
      if (calls === 1 && scenario !== "no-finish" && tools.includes("finish_coding")) {
        return scenario === "parallel" ? { tools: [finish, { name: "view", args: { path: "." } }] } : { tool: finish };
      }
      return { text: "Finished." };
    } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-mixed-result-"));
    const { id, exe } = runtimeFor(process.platform as OS, process.arch);
    const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
      env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
    let session: CodingSession | undefined;
    try {
      await client.start();
      const support = await client.rpc.sandbox.getHostSupport();
      if (!support.supported || !["shell", "denied_paths"].every(name => support.capabilities.some(c => c.name === name && c.supported))) { ctx.skip(); return; }
      session = await CodingSession.create({ client, workspace: dir, protectedPaths: [path.join(dir, "private")], mode: scenario === "autopilot" ? "autopilot" : "interactive",
        model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
        preToolUse: input => scenario === "denied-tool" && input.toolName === "view" ? "Not permitted." : null,
        permission: () => ({ kind: "approved" }), requireCompletion: true });
      await session.run("Complete the coding part.");
      expect(mock.requests[0].tools).toContain("finish_coding");
      const result = session.handoffResult();
      if (scenario === "success" || scenario === "autopilot") expect(result).toEqual({ success: true, summary: "Built and tested." });
      else if (scenario === "failure") expect(result).toEqual({ success: false, summary: "Tests failed." });
      else expect(result?.success).not.toBe(true);
      await session.stop();
      expect(session.handoffResult()).toBeNull();
    } finally {
      await session?.close(); await client.stop(); await mock.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
}
