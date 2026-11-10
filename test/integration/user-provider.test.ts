// The user's own model provider on the real Copilot runtime, against the offline mock model: the settings and the key
// store main uses (app/main/provider.ts activeProvider, ProviderKeyStore), not EMBER_TEST_PROVIDER_URL. With it on and
// agreed to, Ember answers through it with the saved key and no GitHub sign-in; turned off, it goes back to Copilot
// (signed out here) without a restart. "Test connection" reaches the same server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { AgentHost } from "../../app/main/agent/host";
import { Worker } from "../../app/main/agent/worker";
import { Confirmer } from "../../app/main/agent/confirm";
import { Presenter } from "../../app/main/agent/presenter";
import { AuditLog } from "../../app/main/policy/audit";
import { PolicyEngine } from "../../app/main/policy/policy";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { SettingsStore } from "../../app/main/settings";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import { ProviderKeyStore, activeProvider, testConnection, type FetchLike } from "../../app/main/provider";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { projectPrompt } from "../../app/main/agent/project";
import { endpointHost } from "../../app/shared/provider";
import { createLogger } from "../../app/main/logger";
import type { SecretBox } from "../../app/main/agent/auth";
import type { EmberState } from "../../app/shared/overlay";
import type { OS } from "../../app/shared/shortcuts";

const { id: runtimeId, exe } = runtimeFor(process.platform as OS, process.arch);

const KEY = "sk-" + "m".repeat(40); // not a real key
const NONE: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
/** A keyring that seals by reversing (the test runs where no real one may exist). */
const box: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from([...s].reverse().join("")),
  decryptString: b => [...b.toString()].reverse().join(""),
  getSelectedStorageBackend: () => "gnome_libsecret",
};

let mock: { baseUrl: string; requests: { model: string; reasoningEffort?: string; authorization: string | null; messages: unknown[] }[]; close(): Promise<void> };
let dir: string;

beforeAll(async () => {
  mock = await startMockLlm({ delayMs: 5 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-own-provider-"));
}, 60000);

afterAll(async () => {
  await mock?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it("sends the selected effort from a worker to a reasoning-capable model on the real runtime", async () => {
  const userData = fs.mkdtempSync(path.join(dir, "effort-"));
  const runtime = locateRuntime({ appPath: process.cwd(), runtimeId, exe });
  const client = new CopilotClient({
    mode: "empty", useLoggedInUser: false, baseDirectory: path.join(userData, "copilot"),
    connection: RuntimeConnection.forStdio({ path: runtime.path }),
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  const settings = new SettingsStore(path.join(userData, "settings.json"));
  settings.load();
  settings.update({ taskReasoning: { model: "gpt-5", effort: "high" } });
  // A catalog fixture supplies the supported levels. The endpoint is a local mock to inspect the request.
  const worker = new Worker({
    client, settings, model: "gpt-5", reasoningEfforts: ["low", "medium", "high"], vision: false,
    provider: { type: "openai", wireApi: "completions", baseUrl: mock.baseUrl, apiKey: KEY },
    workDir: path.join(userData, "empty"), log: createLogger({ dir: path.join(userData, "logs") }),
    perception: {} as never, sidecar: {} as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}) }),
    confirmer: new Confirmer(() => undefined), audit: new AuditLog(path.join(userData, "audit")),
    presenter: new Presenter(() => undefined), lease: async () => () => undefined,
    flyTo: () => undefined, onProgress: () => undefined,
  }, { id: "effort", target: {}, goal: 'CALLTOOL:finish_task{"success":true,"summary":"Done."}' });
  try {
    await client.start();
    const before = mock.requests.length;
    expect(await worker.run(new AbortController().signal)).toMatchObject({ success: true });
    const requests = mock.requests.slice(before);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]).toMatchObject({ model: "gpt-5", reasoningEffort: "high" });
  } finally {
    await worker.dispose();
    await client.stop();
  }
}, 60_000);

const until = async (cond: () => boolean, ms = 30000) => { for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms;) await new Promise(r => setTimeout(r, 50)); return cond(); };

describe("the user's own model provider on the real Copilot runtime", () => {
  it("answers through it with the saved key, and goes back to Copilot when it is turned off", async () => {
    const userData = fs.mkdtempSync(path.join(dir, "host-"));
    const settings = new SettingsStore(path.join(userData, "settings.json"));
    settings.load();
    settings.update({
      provider: {
        ...settings.get().provider, on: true, type: "openai", baseUrl: mock.baseUrl, conductor: "mock-model",
        consent: { version: FEATURE_CONSENT_VERSION.provider, at: new Date().toISOString(), host: endpointHost(mock.baseUrl)! },
      },
    });
    const keys = new ProviderKeyStore(path.join(userData, "provider-key.bin"), box);
    expect(await keys.save(KEY, endpointHost(mock.baseUrl)!)).toEqual({
      ok: true,
      keyId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    });
    const key = await keys.load();
    const states: Partial<EmberState>[] = [];
    // What happened, said when an expectation fails (a flake must say why).
    const phases: string[] = [];
    let turnsEnded = 0;
    const host = new AgentHost({
      userData, runtimePath: locateRuntime({ appPath: process.cwd(), runtimeId, exe }).path, settings,
      log: createLogger({ dir: path.join(userData, "logs") }),
      setState: p => states.push(p), onStatus: st => phases.push(`${st.phase}${st.reason ? `/${st.reason}` : ""}: ${st.detail}`),
      onTurnEnd: () => { turnsEnded++; },
      provider: () => activeProvider({ fixed: null, settings: settings.get(), admin: NONE, key }),
      // Asked first, as main does for a server on this computer: it answers, so Ember connects (integrations-1).
      probeProvider: () => testConnection(settings.get().provider, key, globalThis.fetch as unknown as FetchLike),
    });
    try {
      expect(await host.start(null), phases.join("\n")).toBe("ready");
      expect(host.getStatus()).toMatchObject({ service: { kind: "user", host: endpointHost(mock.baseUrl) }, conductorModel: "mock-model" });
      const before = mock.requests.length;
      await host.ask("hello from my own provider");
      expect(await until(() => states.some(s => s.bubble?.thought?.includes("You said:") === true && s.bubble.streaming === false))).toBe(true);
      const sent = mock.requests.slice(before);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.map(r => [r.authorization === `Bearer ${KEY}`, r.model])).toEqual(sent.map(() => [true, "mock-model"]));
      // Nothing in the settings file or the log holds the key.
      expect(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).not.toContain(KEY);
      const logs = fs.readdirSync(path.join(userData, "logs")).map(f => fs.readFileSync(path.join(userData, "logs", f), "utf8")).join("\n");
      expect(logs).not.toContain(KEY);
      // Turned off once the turn has ended (its answer shows a moment before the runtime says the turn is over, and the
      // switch never cuts a turn off): back to Copilot at once, which has no sign-in here.
      expect(await until(() => turnsEnded > 0), `turns ended: ${turnsEnded}`).toBe(true);
      // The real SDK reports the live conversation context even for this custom model. Its default limit is only a guess.
      expect(host.getStatus().conversationContext).toMatchObject({ kind: "usage", currentTokens: expect.any(Number) });
      expect(host.getStatus().conversationContext).not.toHaveProperty("tokenLimit");
      const source = path.join(dir, "example.ts");
      fs.writeFileSync(source, "export const greeting = 'hello from the selected project file';");
      const run = new AbortController();
      const project = await projectPrompt([source], "review", "Explain the greeting.", run.signal, userData);
      const projectBefore = mock.requests.length;
      expect(await host.runProject(project, run)).toContain("You said:");
      const projectSent = JSON.stringify(mock.requests.slice(projectBefore));
      expect(projectSent).toContain("hello from the selected project file");
      expect(projectSent).toContain("Explain the greeting.");
      expect(projectSent).not.toContain("hello from my own provider");
      settings.update({ provider: { ...settings.get().provider, on: false } });
      expect(await host.providerChanged(), phases.join("\n")).toBe("signed-out");
      expect(host.getStatus().conversationContext).toBeUndefined();
    } finally {
      await host.stop();
    }
  }, 120000);

  it("says the model server on this computer isn't running, not Connected, when nothing listens at its address (integrations-1)", async () => {
    // A port that was just free: a model server that was stopped.
    const gone = await startMockLlm({ delayMs: 5 });
    const baseUrl: string = gone.baseUrl;
    await gone.close();
    const userData = fs.mkdtempSync(path.join(dir, "down-"));
    const settings = new SettingsStore(path.join(userData, "settings.json"));
    settings.load();
    const where = endpointHost(baseUrl)!;
    settings.update({ provider: { ...settings.get().provider, on: true, type: "openai", baseUrl, conductor: "mock-model", consent: { version: FEATURE_CONSENT_VERSION.provider, at: new Date().toISOString(), host: where } } });
    const phases: string[] = [];
    const host = new AgentHost({
      userData, runtimePath: locateRuntime({ appPath: process.cwd(), runtimeId, exe }).path, settings,
      log: createLogger({ dir: path.join(userData, "logs") }), setState: () => undefined,
      onStatus: st => phases.push(`${st.phase}${st.reason ? `/${st.reason}` : ""}: ${st.detail}`),
      provider: () => activeProvider({ fixed: null, settings: settings.get(), admin: NONE, key: null }),
      // main's probe: the same one GET as Test connection (here Node's fetch, main's is Electron's).
      probeProvider: () => testConnection(settings.get().provider, null, globalThis.fetch as unknown as FetchLike),
    });
    try {
      expect(await host.start(null), phases.join("\n")).toBe("error");
      expect(host.getStatus()).toMatchObject({ phase: "error", reason: "network", detail: `Ember can't reach the model server on this computer (${where}). Start it, and Ember will connect in a moment.` });
      expect(phases.some(p => p.startsWith("ready"))).toBe(false);
    } finally {
      await host.stop();
    }
  }, 60000);

  it("tests the connection with one request to the model list, and sends nothing to a host not agreed to (B1)", async () => {
    const host = endpointHost(mock.baseUrl)!;
    const p = { ...new SettingsStore(path.join(dir, "none.json")).get().provider, on: true, baseUrl: mock.baseUrl };
    const before = mock.requests.length;
    const refused = await testConnection(p, { key: KEY, host }, globalThis.fetch as unknown as FetchLike);
    expect(refused.ok).toBe(false);
    expect(mock.requests.length).toBe(before);
    const agreed = { ...p, consent: { version: FEATURE_CONSENT_VERSION.provider, at: new Date().toISOString(), host } };
    const r = await testConnection(agreed, { key: KEY, host }, globalThis.fetch as unknown as FetchLike);
    expect(r).toEqual({ ok: true, host, models: 1, ids: ["mock-model"] });
  });
});
