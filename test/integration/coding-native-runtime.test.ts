// The coding session through the actual pinned runtime, with a local mock provider and a disposable folder.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { CodingSession } from "../../app/main/agent/coding-session";
import { createCodingPermissionHandler } from "../../app/main/agent/coding-permission";
import { createCodingSafety } from "../../app/main/agent/coding-safety";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { withoutGitHubCredentials } from "../../app/main/agent/runtime-env";
import type { OS } from "../../app/shared/shortcuts";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

const guard = (workspace: string, privateDir: string) => createCodingSafety({ workspace, home: path.dirname(workspace),
  os: process.platform as OS, ember: { paths: [privateDir], pids: [], names: /^ember$/ } });
const sandboxReady = async (client: CopilotClient) => {
  const support = await client.rpc.sandbox.getHostSupport();
  return support.supported && ["shell", "denied_paths"].every(name => support.capabilities.some(c => c.name === name && c.supported));
};

it("runs an interactive coding turn with native tools on the real runtime", async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-runtime-"));
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  let session: CodingSession | undefined;
  try {
    await client.start();
    if (!await sandboxReady(client)) { ctx.skip(); return; }
    session = await CodingSession.create({ client, workspace: dir, protectedPaths: [path.join(dir, "private")], mode: "interactive", model: "mock-model",
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, permission: () => ({ kind: "reject" }), preToolUse: guard(dir, path.join(dir, "private")) });
    const response = await session.run("Inspect this project.");
    expect(response).toContain("Inspect this project");
    expect(mock.requests[0].tools.length).toBeGreaterThan(0);
    expect(mock.requests[0].tools).toContain("view");
  } finally {
    await session?.close();
    await client.stop();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

for (const placement of ["sibling", "ancestor", "hardlink"] as const) it(`records the native view protection boundary when workspace is ${placement}`, async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-private-"));
  const workspace = placement === "ancestor" ? dir : path.join(dir, "project"), privateDir = path.join(dir, "ember");
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(privateDir);
  const secretFile = path.join(privateDir, "vault.json");
  const canary = "EMBER_PRIVATE_VAULT_TEST_CANARY";
  fs.writeFileSync(secretFile, canary);
  const target = placement === "hardlink" ? path.join(workspace, "linked.txt") : secretFile;
  if (placement === "hardlink") fs.linkSync(secretFile, target);
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  const abort = new AbortController();
  let session: CodingSession | undefined;
  try {
    await client.start();
    if (!await sandboxReady(client)) { ctx.skip(); return; }
    const permission = createCodingPermissionHandler({ mode: () => "interactive", signal: abort.signal,
      confirmer: { ask: async () => "allow" }, task: { id: "test", title: "test", goal: "inspect" }, workspace,
      home: dir, os: process.platform as OS, commandPolicy: () => ({ state: "on", askEvery: false }),
      ember: { paths: [privateDir], pids: [], names: /^ember$/ } });
    session = await CodingSession.create({ client, workspace, protectedPaths: [privateDir], mode: "interactive", model: "mock-model",
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, permission, preToolUse: guard(workspace, privateDir) });
    await session.run(`CALLTOOL:view${JSON.stringify({ path: target })}`);
    // Diagnostic only: the unfinished coding path is gated off. The SDK sandbox and path guard do not block a
    // pre-existing hardlink, so a future implementation must change this before the coding gate is enabled.
    expect(JSON.stringify(mock.requests).includes(canary)).toBe(placement === "hardlink");
  } finally {
    abort.abort();
    await session?.close();
    await client.stop();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("executes an approved native shell action in the selected workspace", async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-shell-"));
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  const seen: string[] = [];
  let session: CodingSession | undefined;
  try {
    await client.start();
    if (!await sandboxReady(client)) { ctx.skip(); return; }
    session = await CodingSession.create({ client, workspace: dir, protectedPaths: [path.join(dir, "private")], mode: "interactive", model: "mock-model",
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, permission: request => { seen.push(request.kind); return { kind: "approved" }; }, preToolUse: guard(dir, path.join(dir, "private")) });
    await session.run(`CALLTOOL:bash${JSON.stringify({ command: `node -e "require('fs').writeFileSync('native-test.txt','ok')"` })}`);
    expect(seen).toContain("shell");
    expect(fs.readFileSync(path.join(dir, "native-test.txt"), "utf8")).toBe("ok");
  } finally {
    await session?.close();
    await client.stop();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("does not run a native command approved after Stop", async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-stop-"));
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  let enter!: () => void, approve!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const answer = new Promise<{ kind: "approved" }>(resolve => { approve = () => resolve({ kind: "approved" }); });
  let session: CodingSession | undefined;
  try {
    await client.start();
    if (!await sandboxReady(client)) { ctx.skip(); return; }
    session = await CodingSession.create({ client, workspace: dir, protectedPaths: [path.join(dir, "private")], mode: "interactive", model: "mock-model",
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, permission: () => { enter(); return answer; }, preToolUse: guard(dir, path.join(dir, "private")) });
    const run = session.run(`CALLTOOL:bash${JSON.stringify({ command: `node -e "require('fs').writeFileSync('late.txt','ok')"` })}`);
    const stoppedRun = run.then(() => null, err => err);
    await entered;
    const stopped = session.stop();
    approve();
    await stopped;
    expect(await stoppedRun).toBeInstanceOf(Error);
    expect(fs.existsSync(path.join(dir, "late.txt"))).toBe(false);
  } finally {
    approve?.();
    await session?.close();
    await client.stop();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("documents whether a sandboxed native shell inherits the runtime's fake SDK token", async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-auth-"));
  const fakeToken = "gho_" + "a".repeat(36); // synthetic; never a real sign-in
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false, gitHubToken: fakeToken,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  let session: CodingSession | undefined;
  try {
    await client.start();
    if (!await sandboxReady(client)) { ctx.skip(); return; }
    session = await CodingSession.create({ client, workspace: dir, protectedPaths: [path.join(dir, "private")], mode: "interactive", model: "mock-model",
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, permission: () => ({ kind: "approved" }), preToolUse: guard(dir, path.join(dir, "private")) });
    const command = `node -e "require('fs').writeFileSync('inherited.txt',process.env.COPILOT_SDK_AUTH_TOKEN||'')"`;
    await session.run(`CALLTOOL:bash${JSON.stringify({ command })}`);
    // Diagnostic only: the coding route remains disabled until this and the private-file hardlink gap are resolved.
    expect(fs.readFileSync(path.join(dir, "inherited.txt"), "utf8") === fakeToken).toBe(true);
  } finally {
    await session?.close(); await client.stop(); await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("finishes a real native Autopilot turn after task_complete", async ctx => {
  let calls = 0;
  const mock = await startMockLlm({ delayMs: 0, respond: (_messages: unknown, tools: string[]) => {
    calls++;
    return calls === 1 && tools.includes("task_complete") ? { tool: { name: "task_complete", args: { summary: "Task complete." } } } : { text: "Task complete." };
  } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-auto-runtime-"));
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  let session: CodingSession | undefined;
  try {
    await client.start();
    if (!await sandboxReady(client)) { ctx.skip(); return; }
    session = await CodingSession.create({ client, workspace: dir, protectedPaths: [path.join(dir, "private")], mode: "autopilot", model: "mock-model",
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, permission: () => ({ kind: "approved" }), preToolUse: guard(dir, path.join(dir, "private")), signal: abort.signal });
    expect(await session.run("Finish the task.", abort.signal)).toContain("Task complete");
    expect(mock.requests[0].tools).toContain("task_complete");
  } finally {
    clearTimeout(timer);
    await session?.close();
    await client.stop();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
