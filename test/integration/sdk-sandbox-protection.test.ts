// Exercise the bundled runtime's process sandbox with disposable data and a local model; never uses an account.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection, type CopilotSession } from "@github/copilot-sdk";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { withoutGitHubCredentials } from "../../app/main/agent/runtime-env";
import type { OS } from "../../app/shared/shortcuts";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.platform !== "linux")("native shell sandbox denies direct and symlink paths but not existing hardlinks", async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-sdk-sandbox-"));
  const privateDir = path.join(dir, "private"), file = path.join(privateDir, "value.txt");
  fs.mkdirSync(privateDir); fs.writeFileSync(file, "PRIVATE_SANDBOX_CANARY");
  const alias = path.join(dir, "alias");
  fs.symlinkSync(privateDir, alias);
  const hardlink = path.join(dir, "hardlink.txt");
  fs.linkSync(file, hardlink);
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  const sessions: CopilotSession[] = [];
  try {
    await client.start();
    const support = await client.rpc.sandbox.getHostSupport();
    const supports = (name: string) => support.capabilities.some(c => c.name === name && c.supported);
    if (!support.supported || !supports("denied_paths") || !supports("shell")) { ctx.skip(); return; }
    for (const denied of [false, true]) {
      const events: number[] = [];
      const session = await client.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
        workingDirectory: dir, enableConfigDiscovery: false, availableTools: ["builtin:*"],
        onPermissionRequest: () => ({ kind: "approve-once" } as never) });
      sessions.push(session);
      session.on(e => { if (e.type === "tool.execution_complete" && e.data.shellExecution) events.push(e.data.shellExecution.exitCode ?? -1); });
      expect(await session.rpc.options.update({ sandboxConfig: { enabled: true, allowBypass: false,
        userPolicy: { filesystem: { deniedPaths: denied ? [privateDir] : [] }, network: { allowOutbound: false } } } })).toMatchObject({ success: true });
      // The workspace contains the private folder; the no-deny control establishes that it is otherwise readable.
      await session.sendAndWait({ prompt: `CALLTOOL:bash${JSON.stringify({ command: `node -e "require('fs').writeFileSync('ordinary-${denied}.txt','ok')"` })}` }, 15_000);
      for (const target of [file, path.join(alias, "value.txt"), hardlink]) {
        const encoded = Buffer.from(target).toString("base64");
        const command = `node -e "console.log(require('fs').readFileSync(Buffer.from('${encoded}','base64').toString(),'utf8'))"`;
        await session.sendAndWait({ prompt: `CALLTOOL:bash${JSON.stringify({ command })}` }, 15_000);
      }
      expect(fs.readFileSync(path.join(dir, `ordinary-${denied}.txt`), "utf8")).toBe("ok");
      // This SDK sandbox blocks names, not inodes. A host must handle the existing-hardlink case separately.
      expect(events).toEqual(denied ? [0, 1, 1, 0] : [0, 0, 0, 0]);
    }
  } finally {
    await Promise.all(sessions.map(s => s.disconnect()));
    await client.stop(); await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.platform !== "linux")("does not run a shell without a sandbox when its requested network policy is unsupported", async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-sdk-sandbox-failure-"));
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  let session: CopilotSession | undefined;
  try {
    await client.start();
    const support = await client.rpc.sandbox.getHostSupport();
    const supports = (name: string) => support.capabilities.some(c => c.name === name && c.supported);
    if (!support.supported || !supports("shell") || supports("network")) { ctx.skip(); return; }
    session = await client.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workingDirectory: dir, enableConfigDiscovery: false, availableTools: ["builtin:*"],
      onPermissionRequest: () => ({ kind: "approve-once" } as never) });
    const exits: number[] = [];
    session.on(e => { if (e.type === "tool.execution_complete" && e.data.shellExecution) exits.push(e.data.shellExecution.exitCode ?? -1); });
    expect(await session.rpc.options.update({ sandboxConfig: { enabled: true, allowBypass: false,
      userPolicy: { filesystem: { deniedPaths: [path.join(dir, "private")] }, network: { allowOutbound: true } } } })).toMatchObject({ success: true });
    await session.sendAndWait({ prompt: `CALLTOOL:bash${JSON.stringify({ command: `node -e "require('fs').writeFileSync('unsandboxed.txt','bad')"` })}` }, 15_000);
    expect(fs.existsSync(path.join(dir, "unsandboxed.txt"))).toBe(false);
    expect(exits).toEqual([1]);
  } finally {
    await session?.disconnect();
    await client.stop(); await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.platform !== "linux")("records SDK sandbox environment masking with a synthetic token", async ctx => {
  const mock = await startMockLlm({ delayMs: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-sdk-sandbox-mask-"));
  const fakeToken = "gho_" + "m".repeat(36);
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const client = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "runtime"), useLoggedInUser: false, gitHubToken: fakeToken,
    connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path }),
    env: { ...withoutGitHubCredentials(process.env), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  let session: CopilotSession | undefined;
  try {
    await client.start();
    const support = await client.rpc.sandbox.getHostSupport();
    if (!support.supported || !support.capabilities.some(c => c.name === "shell" && c.supported)) { ctx.skip(); return; }
    session = await client.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workingDirectory: dir, enableConfigDiscovery: false, availableTools: ["builtin:*"],
      onPermissionRequest: () => ({ kind: "approve-once" } as never) });
    expect(await session.rpc.options.update({ sandboxConfig: { enabled: true, allowBypass: false,
      credentials: { envVars: { COPILOT_SDK_AUTH_TOKEN: { injectHosts: ["api.github.com"] } } },
      userPolicy: { network: { allowOutbound: false } } } })).toMatchObject({ success: true });
    const command = `node -e "require('fs').writeFileSync('value.txt',process.env.COPILOT_SDK_AUTH_TOKEN||'')"`;
    await session.sendAndWait({ prompt: `CALLTOOL:bash${JSON.stringify({ command })}` }, 15_000);
    const value = fs.readFileSync(path.join(dir, "value.txt"), "utf8");
    // The runtime currently supplies a placeholder instead of the synthetic token. Other channels are not tested.
    expect(value.length > 0).toBe(true);
    expect(value === fakeToken).toBe(false);
    // Diagnostic: on this runtime, masking the child environment is insufficient because a sandboxed process can
    // still inspect the synthetic value in PID 1's environment. Only a boolean is written; no token is printed.
    const inspect = `node -e "require('fs').writeFileSync('proc-match.txt',String(require('fs').readFileSync('/proc/1/environ').includes(Buffer.from(process.argv[1]))))" ${fakeToken}`;
    await session.sendAndWait({ prompt: `CALLTOOL:bash${JSON.stringify({ command: inspect })}` }, 15_000);
    expect(fs.readFileSync(path.join(dir, "proc-match.txt"), "utf8")).toBe("true");
  } finally {
    await session?.disconnect(); await client.stop(); await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
