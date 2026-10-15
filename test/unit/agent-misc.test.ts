import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseModels } from "../../app/main/agent/models";
import { isUsableToken, resolveToken, TokenStore, startDeviceFlow, pollDeviceFlow, type SecretBox } from "../../app/main/agent/auth";
import { hardenedSessionConfig, BUILTIN_AGENTS } from "../../app/main/agent/session-config";
import { explainStartError } from "../../app/main/agent/host";
import { locateRuntime } from "../../app/main/agent/runtime";

describe("chooseModels", () => {
  const models = [
    { id: "gpt-5", capabilities: { supports: { vision: true } } },
    { id: "gpt-5-mini", capabilities: { supports: { vision: true } } },
    { id: "text-only-mini", capabilities: { supports: { vision: false } } },
    { id: "disabled-big", capabilities: { supports: { vision: true } }, policy: { state: "disabled" } },
  ];
  it("uses a fast model for the conductor and a strong vision model for workers", () => {
    expect(chooseModels(models)).toEqual({ conductor: "gpt-5-mini", worker: "gpt-5" });
  });
  it("honours preferences, but never a non-vision worker", () => {
    expect(chooseModels(models, { conductor: "gpt-5", worker: "text-only-mini" })).toEqual({ conductor: "gpt-5", worker: "gpt-5" });
  });
  it("returns nulls when nothing is usable", () => {
    expect(chooseModels([])).toEqual({ conductor: null, worker: null });
  });
});

describe("auth", () => {
  it("accepts OAuth, app and fine-grained tokens but not classic ghp_", () => {
    expect(isUsableToken("gho_abc123")).toBe(true);
    expect(isUsableToken("ghu_abc123")).toBe(true);
    expect(isUsableToken("github_pat_11AA_bb")).toBe(true);
    expect(isUsableToken("ghp_abc123")).toBe(false);
    expect(isUsableToken("")).toBe(false);
  });

  it("prefers a stored token, then the environment, then the GitHub CLI", async () => {
    const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s.split("").reverse().join("")), decryptString: b => b.toString().split("").reverse().join("") };
    const store = new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-tok-")), "token"), box);
    const gh = async () => "gho_fromcli";
    expect(await resolveToken(store, {}, gh)).toEqual({ token: "gho_fromcli", source: "github-cli" });
    expect(await resolveToken(store, { GH_TOKEN: "gho_fromenv" }, gh)).toEqual({ token: "gho_fromenv", source: "environment" });
    store.save("gho_stored");
    expect(fs.readFileSync((store as unknown as { file: string }).file, "utf8")).not.toContain("gho_stored");
    expect(await resolveToken(store, { GH_TOKEN: "gho_fromenv" }, gh)).toEqual({ token: "gho_stored", source: "stored" });
  });

  it("refuses to store tokens without a keyring", () => {
    const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString(), getSelectedStorageBackend: () => "basic_text" };
    const store = new TokenStore(path.join(os.tmpdir(), `ember-tok-${Date.now()}`), box);
    expect(store.save("gho_x")).toBe(false);
  });

  it("runs the device flow, waiting through pending and slow_down", async () => {
    const replies = [
      { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      { access_token: "gho_done" },
    ];
    const calls: string[] = [];
    const fetch = async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => replies.shift() }; };
    const code = await startDeviceFlow(fetch, "client-id");
    expect(code.userCode).toBe("ABCD-1234");
    const waits: number[] = [];
    const token = await pollDeviceFlow(fetch, "client-id", code, { sleep: async ms => { waits.push(ms); } });
    expect(token).toBe("gho_done");
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(calls[0]).toContain("/login/device/code");
  });

  it("explains denial and expiry", async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: "access_denied" }) });
    await expect(pollDeviceFlow(fetch, "c", { deviceCode: "d", userCode: "u", verificationUri: "v", expiresIn: 60, interval: 0 }, { sleep: async () => {} }))
      .rejects.toThrow(/cancelled on GitHub/);
  });
});

describe("hardened session config", () => {
  it("removes every built-in tool and agent and streams", () => {
    const c = hardenedSessionConfig({ tools: [], systemMessage: { content: "x" }, workingDirectory: "/tmp/e", onPermissionRequest: () => ({ kind: "reject" }) as never }) as unknown as Record<string, unknown>;
    expect(c.availableTools).toEqual([]);
    expect(c.excludedBuiltinAgents).toEqual(BUILTIN_AGENTS);
    expect(c.streaming).toBe(true);
  });
});

describe("startup errors", () => {
  it("explains policy, auth and seat problems in plain words", () => {
    expect(explainStartError(new Error("Failed to load models: access denied by Copilot policy"))).toMatch(/Copilot CLI policy/);
    expect(explainStartError(new Error("401 Unauthorized"))).toMatch(/Sign in again/);
    expect(explainStartError(new Error("spawn ENOENT"))).toMatch(/Reinstall/);
  });
});

describe("runtime", () => {
  it("finds the bundled Copilot runtime in node_modules", () => {
    expect(locateRuntime({ appPath: process.cwd(), env: {} }).exists).toBe(true);
  });
  it("honours EMBER_COPILOT_RUNTIME", () => {
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-rt-")), "copilot-runtime");
    fs.writeFileSync(fake, "");
    expect(locateRuntime({ appPath: "/nowhere", env: { EMBER_COPILOT_RUNTIME: fake } }).path).toBe(fake);
  });
});
