// Session-scoped credential probe on a real runtime. Uses only synthetic values and a local model.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotSession } from "@github/copilot-sdk";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { CodingRuntime } from "../../app/main/agent/coding-runtime";
import type { OS } from "../../app/shared/shortcuts";
// @ts-expect-error -- JavaScript test helper
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.platform !== "linux")("keeps a synthetic session RPC token out of sandbox process environments", async ctx => {
  const script = "const f=require('fs');const xs=[Buffer.from('gho_'+String.fromCharCode(113).repeat(36)),Buffer.from('sk_local_'+String.fromCharCode(114).repeat(36))];let found=false;for(const p of f.readdirSync('/proc'))if(/^\\d+$/.test(p))try{const e=f.readFileSync('/proc/'+p+'/environ');found ||= xs.some(x=>e.includes(x))}catch{}f.writeFileSync('found.txt',String(found))";
  let calls = 0;
  const mock = await startMockLlm({ delayMs: 0, respond: () => ++calls === 1
    ? { tool: { name: "bash", args: { command: `node -e ${JSON.stringify(script)}` } } } : { text: "done" } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-session-token-"));
  const secret = "gho_" + "q".repeat(36);
  const providerSecret = "sk_local_" + "r".repeat(36);
  const { id, exe } = runtimeFor(process.platform as OS, process.arch);
  const runtime = await CodingRuntime.start({ userData: dir, runtimePath: locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path,
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
  const client = runtime.client;
  let session: CopilotSession | undefined;
  try {
    const support = await client.rpc.sandbox.getHostSupport();
    if (!support.supported || !support.capabilities.some(c => c.name === "shell" && c.supported)) { ctx.skip(); return; }
    session = await client.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: providerSecret },
      workingDirectory: dir, enableConfigDiscovery: false, availableTools: ["builtin:*"], onPermissionRequest: () => ({ kind: "approve-once" } as never) });
    expect(await session.rpc.gitHubAuth.setCredentials({ credentials: { type: "token", host: "github.com", token: secret } })).toMatchObject({ success: true });
    expect(await session.rpc.options.update({ sandboxConfig: { enabled: true, allowBypass: false,
      userPolicy: { network: { allowOutbound: false } } } })).toMatchObject({ success: true });
    // Only a boolean leaves the child. Check all accessible processes, not just the shell or sandbox PID 1.
    await session.sendAndWait({ prompt: "Run the local environment probe." }, 15_000);
    expect(fs.readFileSync(path.join(dir, "found.txt"), "utf8")).toBe("false");
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests.every((r: { authorization: string | null }) => r.authorization === `Bearer ${providerSecret}`)).toBe(true);
    // No printed secrets: return a boolean if either synthetic value is persisted anywhere under the runtime directory.
    const holds = (folder: string): boolean => fs.readdirSync(folder, { withFileTypes: true }).some(entry => {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) return holds(file);
      if (!entry.isFile()) return false;
      const data = fs.readFileSync(file);
      return data.includes(secret) || data.includes(providerSecret);
    });
    expect(holds(path.join(dir, "coding-runtimes"))).toBe(false);
  } finally {
    await session?.disconnect(); await runtime.close(); await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);
