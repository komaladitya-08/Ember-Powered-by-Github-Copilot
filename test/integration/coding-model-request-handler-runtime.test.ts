// Actual pinned SDK/runtime, synthetic host credential and local model. The native tool only writes a temporary
// fixture. This proves request interception and streaming, not OS isolation or protection from runtime memory access.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { CopilotClient, RuntimeConnection, type CopilotSession } from "@github/copilot-sdk";
import { CodingModelBroker } from "../../app/main/agent/coding-model-broker";
import { CodingModelRequestHandler, codingModelPlaceholderProvider, CODING_MODEL_PLACEHOLDER_KEY } from "../../app/main/agent/coding-model-request-handler";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { withoutGitHubCredentials } from "../../app/main/agent/runtime-env";
import type { OS } from "../../app/shared/shortcuts";
// @ts-expect-error -- plain JavaScript offline fixture
import { startMockLlm } from "../mock-llm/server.mjs";

it("brokers actual runtime HTTP/SSE and builtin file work without sending the host credential to the runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-model-broker-runtime-"));
  const workspace = path.join(root, "project"), state = path.join(root, "runtime");
  fs.mkdirSync(workspace);
  const file = path.join(workspace, "broker-result.txt"), content = "The brokered native tool finished.";
  const secret = `host_only_synthetic_${crypto.randomUUID()}`;
  let calls = 0;
  const mock = await startMockLlm({ delayMs: 0, respond: () => ++calls === 1
    ? { tool: { name: "create", args: { path: file, file_text: content } } }
    : { text: "The temporary file is ready for review." } });
  const lifetime = new AbortController();
  const limits = { requests: 10, concurrent: 1, requestBytes: 1024 * 1024, responseBytes: 4 * 1024 * 1024,
    totalBytes: 16 * 1024 * 1024, requestMs: 15_000, lifetimeMs: 60_000 };
  const broker = new CodingModelBroker({ baseUrl: mock.baseUrl, model: "mock-model", apiKey: secret, limits, signal: lifetime.signal });
  const sessionId = `ember-broker-${crypto.randomUUID()}`;
  const handler = new CodingModelRequestHandler({ sessionId, broker, maxBodyBytes: limits.requestBytes });
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const runtime = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe });
  expect(runtime.exists).toBe(true);
  const client = new CopilotClient({ mode: "empty", baseDirectory: state, useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: runtime.path }), requestHandler: handler,
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  let session: CopilotSession | undefined;
  const chunks: string[] = [];
  try {
    await client.start();
    session = await client.createSession({ sessionId, model: "mock-model", provider: codingModelPlaceholderProvider(),
      workingDirectory: workspace, enableConfigDiscovery: false, availableTools: ["builtin:*"], streaming: true,
      onPermissionRequest: () => ({ kind: "approve-once" } as never) });
    session.on(event => { if (event.type === "assistant.message_delta") chunks.push(event.data.deltaContent); });
    const answer = await session.sendAndWait({ prompt: "Create the temporary result file and report the observed outcome." }, 25_000);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(answer?.data.content).toContain("ready for review");
    expect(chunks.join("")).toContain("ready for review");
    expect(mock.requests.length).toBe(2);
    expect(mock.requests.every((request: { authorization: string | null }) => request.authorization === `Bearer ${secret}`)).toBe(true);
    expect(JSON.stringify(mock.requests.at(-1)?.messages)).toContain("create");
    expect(broker.usage).toMatchObject({ requests: 2, active: 0, retired: false });
    // Runtime-owned persisted files contain no host provider credential. The runtime's provider is only a dummy.
    const contains = (directory: string, needle: string): boolean => fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? contains(target, needle) : entry.isFile() && fs.readFileSync(target).includes(needle);
    });
    expect(contains(state, secret)).toBe(false);
    expect(CODING_MODEL_PLACEHOLDER_KEY).not.toBe(secret);
    handler.retire();
    expect(broker.usage.retired).toBe(true);
    // A new turn after revocation cannot reach even this harmless local model.
    const previous = mock.requests.length;
    await session.sendAndWait({ prompt: "Inspect the fixture again." }, 10_000).catch(() => undefined);
    expect(mock.requests).toHaveLength(previous);
  } finally {
    handler.retire();
    await session?.disconnect().catch(() => undefined);
    await client.stop().catch(() => undefined);
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 55_000);
