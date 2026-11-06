// BE audit #1, observed on the real pinned runtime (@github/copilot-sdk 1.0.21 and its runtime binary), fully offline:
// does the runtime hand its COPILOT_SDK_AUTH_TOKEN to the MCP servers it starts, and does Ember's launcher keep it from
// the extension's own process? The client is built as Ember builds it (runtimeClientOptions) with a dummy marker
// token. Nothing here may reach a network, so the test runs only with EMBER_RUNTIME_ENV_LIVE=1 AND inside a network
// namespace that has no interface but loopback (scripts/runtime-env-live.sh makes one with `unshare -rn`); anywhere else
// it refuses to start the runtime. It is not in CI. The model is the local mock model on 127.0.0.1.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { CopilotClient } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { runtimeClientOptions } from "../../app/main/agent/runtime-env";
import { hardenedSessionConfig } from "../../app/main/agent/session-config";
import { appEnv } from "../../app/main/hands/system";
import type { OS } from "../../app/shared/shortcuts";

const { id: runtimeId, exe } = runtimeFor(process.platform as OS, process.arch);
const MARKER = "ghu_TESTMARKER_LIVE_0123456789abcdef";
const AMBIENT = "ghp_TESTMARKER_LIVE_AMBIENT_0123456789";

/** True only when the only network interface here is loopback (/proc/net/dev; no packet is sent to find out). */
function onlyLoopback(): boolean {
  try {
    const names = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).map(l => l.split(":")[0]?.trim()).filter(Boolean);
    return names.length > 0 && names.every(n => n === "lo");
  } catch {
    return false;
  }
}

const live = process.env.EMBER_RUNTIME_ENV_LIVE === "1" && process.platform === "linux";

describe.skipIf(!live)("the real Copilot runtime's environment, offline (BE audit #1)", () => {
  let dir: string;
  let mock: { baseUrl: string; close(): Promise<void> };
  let launcher: string;

  beforeAll(async () => {
    if (!onlyLoopback()) throw new Error("refusing to start the runtime: this is not a network-less namespace (use scripts/runtime-env-live.sh)");
    mock = await startMockLlm({ delayMs: 2 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-runtime-env-live-"));
    launcher = path.join(dir, "mcp-launch.cjs");
    await build({ entryPoints: ["app/main/extensions/launch.ts"], outfile: launcher, bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent", external: ["koffi"] });
  }, 60_000);
  afterAll(async () => {
    await mock?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shows what an MCP server started by the runtime, and one started through Ember's launcher, can see", async () => {
    const runtime = locateRuntime({ appPath: process.cwd(), runtimeId, exe });
    expect(runtime.exists).toBe(true);
    const dump = path.join(dir, "dump.cjs");
    // Records its own argv and environment, then exits (the runtime's handshake with it fails; the spawn is what counts).
    // It also reads its parent's environment (/proc/<ppid>/environ): the runtime for a direct server, Ember's launcher for a launched one.
    fs.writeFileSync(dump, `const fs = require("fs");
let parentEnv = null;
try { parentEnv = Object.fromEntries(fs.readFileSync("/proc/" + process.ppid + "/environ", "utf8").split("\\0").filter(Boolean).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })); } catch {}
fs.writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv, env: process.env, parentEnv }));`);
    const directOut = path.join(dir, "direct.json");
    const launchedOut = path.join(dir, "launched.json");
    const leaseFile = path.join(dir, `${crypto.randomUUID()}.lease`);
    fs.writeFileSync(leaseFile, "");
    const spec = {
      command: process.execPath, args: [dump, launchedOut], env: { ...appEnv({ PATH: process.env.PATH, HOME: dir } as NodeJS.ProcessEnv), ELECTRON_RUN_AS_NODE: "1" },
      cwd: dir, runDir: dir, leaseFile, group: true,
    };
    const options = runtimeClientOptions({
      userData: dir, runtimePath: runtime.path, token: MARKER, provider: false,
      env: { PATH: process.env.PATH, HOME: dir, GITHUB_TOKEN: AMBIENT, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    });
    const client = new CopilotClient(options);
    const seen: string[] = [];
    try {
      await client.start();
      // The session config is Ember's own (hardenedSessionConfig), so what the runtime is told about each MCP server is what Ember sends.
      const tool = (server: string) => ({ server, name: `${server}-x` });
      const ext = {
        mcpServers: {
          direct: { type: "stdio", command: process.execPath, args: [dump, directOut], env: { ELECTRON_RUN_AS_NODE: "1" }, tools: ["x"] },
          launched: { type: "stdio", command: process.execPath, args: [launcher], env: { ELECTRON_RUN_AS_NODE: "1", EMBER_MCP_SPEC: JSON.stringify(spec) }, tools: ["x"] },
        },
        tools: [tool("direct").name, tool("launched").name],
        preToolUse: async () => ({ permissionDecision: "deny" }),
        postToolUse: async () => undefined,
        verify: () => undefined,
      };
      const config = hardenedSessionConfig({
        tools: [], systemMessage: { mode: "replace", content: "test" }, workingDirectory: dir,
        onPermissionRequest: () => ({ kind: "reject" }) as never, extensions: ext as never,
        provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, model: "mock-model",
      });
      expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["direct", "launched"]);
      const session = await client.createSession(config);
      seen.push("session created");
      await session.send({ prompt: "hello" }).catch((e: unknown) => { seen.push(`send: ${String(e).split(MARKER).join("[marker]")}`); });
      for (let i = 0; i < 100 && !(fs.existsSync(directOut) && fs.existsSync(launchedOut)); i++) await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      seen.push(`stopped: ${String(e).split(MARKER).join("[marker]")}`);
    } finally {
      await client.forceStop().catch(() => undefined);
    }
    const read = (f: string) => (fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as { argv: string[]; env: Record<string, string>; parentEnv: Record<string, string> | null }) : null);
    const direct = read(directOut), launched = read(launchedOut);
    // The observation, for whoever reads the log; the assertions below are what must hold either way.
    process.stderr.write(`RUNTIME-ENV-LIVE ${JSON.stringify({
      steps: seen,
      directStarted: !!direct,
      directHasSdkTokenVar: direct ? "COPILOT_SDK_AUTH_TOKEN" in direct.env : null,
      directHasMarker: direct ? JSON.stringify(direct.env).includes(MARKER) : null,
      runtimeEnvHoldsMarker: direct?.parentEnv ? JSON.stringify(direct.parentEnv).includes(MARKER) : null,
      runtimeCredentialNames: direct?.parentEnv ? Object.keys(direct.parentEnv).filter(k => /TOKEN|COPILOT|GITHUB|^GH_/.test(k)) : null,
      launcherEnvHoldsMarker: launched?.parentEnv ? JSON.stringify(launched.parentEnv).includes(MARKER) : null,
      directEnvNames: direct ? Object.keys(direct.env).filter(k => /TOKEN|COPILOT|GITHUB|GH_/.test(k)) : null,
      launchedStarted: !!launched,
      launchedHasMarker: launched ? JSON.stringify(launched.env).includes(MARKER) : null,
      launchedEnvNames: launched ? Object.keys(launched.env).filter(k => /TOKEN|COPILOT|GITHUB|GH_/.test(k)) : null,
    })}\n`);
    // No MCP server Ember configures, started directly or through the launcher, may hold a credential: the dummy sign-in,
    // the ambient one, or any value in a credential variable (Ember blanks each by name; the runtime merges that over its own).
    const credential = /^((GH|GITHUB|COPILOT)_([A-Z0-9]+_)*TOKEN|COPILOT_SDK_AUTH_TOKEN|COPILOT_CONNECTION_TOKEN)$/i;
    for (const [name, got] of [["direct", direct], ["launched", launched]] as const) {
      expect(got, `${name} started`).not.toBeNull();
      if (!got) continue;
      expect(JSON.stringify(got.env), `${name}: marker in env`).not.toContain(MARKER);
      expect(JSON.stringify(got.env), `${name}: ambient in env`).not.toContain(AMBIENT);
      expect(Object.entries(got.env).filter(([k, v]) => credential.test(k) && v !== ""), `${name}: credential variables with a value`).toEqual([]);
      // Its parent is the runtime (direct) or the launcher (launched); what the runtime itself holds is reported above, not asserted.
      if (name === "launched") {
        expect(JSON.stringify(got.parentEnv), "launcher's own environment").not.toContain(MARKER);
        expect(JSON.stringify(got.parentEnv)).not.toContain(AMBIENT);
      }
    }
    if (direct?.parentEnv) expect(JSON.stringify(direct.parentEnv)).not.toContain(AMBIENT);
  }, 90_000);
});
