/**
 * BE audit #1: where the GitHub sign-in goes when Ember starts the Copilot runtime. A real SDK client starts a fake
 * runtime (a script that dumps its own argv and environment, then starts what the runtime would start); the marker
 * tokens are dummies. The pinned SDK (@github/copilot-sdk 1.0.21, client.js buildRuntimeEnv/startCLIServer) puts the
 * token in the runtime's environment as COPILOT_SDK_AUTH_TOKEN and on its command line only as that name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { CopilotClient } from "@github/copilot-sdk";
import { runtimeClientOptions, withoutGitHubCredentials, redactGitHubTokens } from "../../app/main/agent/runtime-env";
import { explainStartError } from "../../app/main/agent/host";
import { redactingLogger } from "../../app/main/provider";
import { appEnv } from "../../app/main/hands/system";
import type { Logger } from "../../app/main/logger";

const APP_TOKEN = "ghu_TESTMARKER_APPTOKEN_0123456789";
const AMBIENT = {
  GITHUB_TOKEN: "ghp_TESTMARKER_AMBIENT_GITHUB_TOKEN",
  GH_TOKEN: "gho_TESTMARKER_AMBIENT_GH_TOKEN",
  COPILOT_GITHUB_TOKEN: "ghu_TESTMARKER_AMBIENT_COPILOT",
  GH_ENTERPRISE_TOKEN: "ghe_TESTMARKER_AMBIENT_ENTERPRISE",
  GITHUB_ENTERPRISE_TOKEN: "ghe_TESTMARKER_AMBIENT_GHE2",
};
const MARKERS = [APP_TOKEN, ...Object.values(AMBIENT)];

let dir: string;
let launcher: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-runtime-token-"));
  launcher = path.join(dir, "launch.cjs");
  await build({ entryPoints: ["app/main/extensions/launch.ts"], outfile: launcher, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["koffi"], logLevel: "silent" });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The fake runtime: dumps argv and env, then starts the extension launcher as the runtime would (its env first, then the config's). */
function writeFakeRuntime(): string {
  const file = path.join(dir, "fake-runtime.js");
  fs.writeFileSync(file, `
const fs = require("fs"), path = require("path"), cp = require("child_process");
const out = process.env.FAKE_OUT;
fs.writeFileSync(path.join(out, "runtime.json"), JSON.stringify({ argv: process.argv, env: process.env }));
const spec = JSON.parse(fs.readFileSync(path.join(out, "mcp-spec.json"), "utf8"));
// What the runtime does for an MCP server in the session config: Ember's launcher, with the runtime's own env under the config's.
cp.spawn(process.execPath, [spec.launcher], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", EMBER_MCP_SPEC: JSON.stringify(spec.launch) }, stdio: "ignore" });
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  return file;
}

async function waitFor(file: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, "utf8");
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no ${file}`);
}

describe("the runtime's environment (BE audit #1)", () => {
  it("removes every ambient GitHub credential and nothing else", () => {
    const env = withoutGitHubCredentials({ ...AMBIENT, GH_HOST: "github.com", PATH: "/usr/bin", COPILOT_SDK_AUTH_TOKEN: "x", HTTPS_PROXY: "http://p:1", github_token: "lower" });
    expect(Object.keys(env).sort()).toEqual(["GH_HOST", "HTTPS_PROXY", "PATH"]);
  });

  it("starts the real SDK's runtime with the sign-in only in COPILOT_SDK_AUTH_TOKEN, never in argv, and with no ambient token", async () => {
    const out = path.join(dir, "run1");
    fs.mkdirSync(out);
    const env = appEnv({ PATH: process.env.PATH, HOME: dir } as NodeJS.ProcessEnv);
    const launch = { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(path.join(out, "server.json"))}, JSON.stringify({ argv: process.argv, env: process.env }))`], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, cwd: dir, runDir: dir, leaseFile: path.join(dir, `${crypto.randomUUID()}.lease`), group: true };
    fs.writeFileSync(launch.leaseFile, "");
    fs.writeFileSync(path.join(out, "mcp-spec.json"), JSON.stringify({ launcher, launch }));
    const options = runtimeClientOptions({
      userData: out, runtimePath: writeFakeRuntime(), token: APP_TOKEN, provider: false,
      env: { ...process.env, ...AMBIENT, FAKE_OUT: out },
    });
    const client = new CopilotClient(options);
    const started = client.start().catch(() => undefined); // the fake never answers the handshake
    try {
      const runtime = JSON.parse(await waitFor(path.join(out, "runtime.json"))) as { argv: string[]; env: Record<string, string> };
      // Where it is: exactly one environment variable of the runtime, named on its command line.
      expect(runtime.argv.join(" ")).toContain("--auth-token-env COPILOT_SDK_AUTH_TOKEN");
      expect(runtime.env.COPILOT_SDK_AUTH_TOKEN).toBe(APP_TOKEN);
      expect(Object.entries(runtime.env).filter(([, v]) => v.includes(APP_TOKEN)).map(([k]) => k)).toEqual(["COPILOT_SDK_AUTH_TOKEN"]);
      for (const m of MARKERS) expect(runtime.argv.some(a => a.includes(m))).toBe(false);
      // Ambient tokens never reach the runtime.
      for (const m of Object.values(AMBIENT)) expect(JSON.stringify(runtime.env)).not.toContain(m);
      // The extension server Ember's launcher starts has neither the app's token nor an ambient one, in env or argv.
      const server = await waitFor(path.join(out, "server.json"));
      for (const m of MARKERS) expect(server).not.toContain(m);
    } finally {
      await client.forceStop().catch(() => undefined);
      await started;
    }
  }, 20_000);

  it("gives a runtime no GitHub sign-in at all when another model service is in use, ambient tokens included", async () => {
    const out = path.join(dir, "run2");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "mcp-spec.json"), JSON.stringify({ launcher, launch: { command: "x" } }));
    const options = runtimeClientOptions({ userData: out, runtimePath: writeFakeRuntime(), token: APP_TOKEN, provider: true, env: { ...process.env, ...AMBIENT, FAKE_OUT: out } });
    const client = new CopilotClient(options);
    const started = client.start().catch(() => undefined);
    try {
      const dump = await waitFor(path.join(out, "runtime.json"));
      for (const m of MARKERS) expect(dump).not.toContain(m);
      expect(dump).not.toContain("COPILOT_SDK_AUTH_TOKEN");
    } finally {
      await client.forceStop().catch(() => undefined);
      await started;
    }
  }, 20_000);
});

describe("tokens in logs and messages (BE audit #1)", () => {
  it("redacts GitHub token shapes, whoever's they are", () => {
    expect(redactGitHubTokens(`bad ${APP_TOKEN} and ${AMBIENT.GITHUB_TOKEN} and github_pat_TESTMARKER_0123456789abcdef`)).toBe("bad [token] and [token] and [token]");
    expect(redactGitHubTokens("ghost_writer and github_pattern stay")).toBe("ghost_writer and github_pattern stay");
  });

  it("keeps a token out of every log line, field and error, with no provider key set", () => {
    const lines: string[] = [];
    const put = (m: string, f?: unknown) => { lines.push(m + JSON.stringify(f)); };
    const base = { debug: put, info: put, warn: put, error: put, child: () => base, file: undefined } as unknown as Logger;
    const log = redactingLogger(base, () => null);
    log.warn(`spawn failed with ${APP_TOKEN}`, { err: new Error(`env COPILOT_SDK_AUTH_TOKEN=${APP_TOKEN}`), nested: { header: `token ${AMBIENT.GH_TOKEN}` } });
    expect(lines).toHaveLength(1);
    for (const m of MARKERS) expect(lines[0]).not.toContain(m);
  });

  it("keeps a token out of the sentence the settings window shows for a failed start", () => {
    const text = explainStartError(new Error(`runtime exited: COPILOT_SDK_AUTH_TOKEN=${APP_TOKEN} (boom)`));
    expect(text).not.toContain(APP_TOKEN);
  });
});

