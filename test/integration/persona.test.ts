// The system prompts Ember's sessions really get, read back from the offline mock model:
// Ember's own voice and rules are in, the platform safety section stays, and nothing
// written for a coding agent (files, the gh CLI, code search, "verify with curl") is left.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection, type SystemMessageConfig } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { hardenedSessionConfig } from "../../app/main/agent/session-config";
import { conductorTools } from "../../app/main/agent/conductor";
import { emberSystemMessage, TONE } from "../../app/main/agent/persona";
import { guideSystemMessage, workerSystemMessage, WORKER_RULES } from "../../app/main/agent/worker-persona";
import { locateRuntime } from "../../app/main/agent/runtime";
import { SettingsStore } from "../../app/main/settings";

let mock: { baseUrl: string; requests: { messages: { role: string; content: unknown }[] }[]; close(): Promise<void> };
let dir: string;
let client: CopilotClient;

beforeAll(async () => {
  mock = await startMockLlm({ delayMs: 1 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-persona-"));
  client = new CopilotClient({
    mode: "empty", baseDirectory: path.join(dir, "copilot"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd() }).path }),
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  await client.start();
}, 60000);

afterAll(async () => {
  await client?.stop();
  await mock?.close();
});

async function systemPrompt(name: string, systemMessage: SystemMessageConfig): Promise<string> {
  const settings = new SettingsStore(path.join(dir, `settings-${name}.json`));
  settings.load();
  const config = hardenedSessionConfig({
    model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
    tools: conductorTools(settings), systemMessage, workingDirectory: path.join(dir, "empty"),
    onPermissionRequest: () => ({ kind: "reject" }),
  });
  fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
  const session = await client.createSession({ ...config, sessionId: `persona-${name}` });
  const before = mock.requests.length;
  const idle = new Promise<void>(r => session.on(e => { if (e.type === "session.idle") r(); }));
  await session.send({ prompt: "hi" });
  await idle;
  await session.disconnect();
  const sys = mock.requests[before].messages.find(m => m.role === "system");
  return String(sys?.content ?? "");
}

const CODING_LEFTOVERS = [/tips_and_tricks/, /gh` CLI/, /code_search_tools/, /\bcurl\b/, /AI coding agent/, /view\/edit for existing files/, /rules_for_code_changes/];

describe("Ember's system prompts", () => {
  it("the conductor speaks in Ember's voice and keeps the safety rules", async () => {
    const text = await systemPrompt("conductor", emberSystemMessage());
    expect(text).toContain(TONE);
    expect(text).toContain("You are Ember");
    expect(text).toMatch(/prohibited_actions/);
    for (const r of CODING_LEFTOVERS) expect(text).not.toMatch(r);
  }, 60000);

  it("workers and guides get their own rules, also without coding-agent text", async () => {
    const worker = await systemPrompt("worker", workerSystemMessage());
    expect(worker).toContain(WORKER_RULES);
    expect(worker).toMatch(/prohibited_actions/);
    const guide = await systemPrompt("guide", guideSystemMessage());
    expect(guide).toContain("You are Ember's guide");
    for (const r of CODING_LEFTOVERS) { expect(worker).not.toMatch(r); expect(guide).not.toMatch(r); }
  }, 60000);
});
