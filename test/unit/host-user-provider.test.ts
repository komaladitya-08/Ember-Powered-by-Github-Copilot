/**
 * AgentHost with the user's own model provider (app/main/provider.ts): while it is in force no GitHub sign-in reaches
 * the runtime and the sessions get its config; turning it on or off reconnects without a restart (between turns, never
 * under a running task), a new conversation starts on the other service while memory stays, and the status names the
 * host only, never the key.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../app/main/logger";

/* eslint-disable @typescript-eslint/no-explicit-any -- a pretend SDK */
const sim = vi.hoisted(() => ({ clients: [] as any[], sessions: [] as any[] }));
vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class FakeClient {
    constructor(public opts: any) { sim.clients.push(this); }
    async start() { /* nothing */ }
    async stop() { return []; }
    async forceStop() { /* nothing */ }
    async getAuthStatus() { return { isAuthenticated: true, login: "octo" }; }
    async listModels() { return [{ id: "copilot-model", name: "Copilot model", capabilities: { supports: { vision: true } } }]; }
    async listSessions() { return []; }
    async deleteSession() { /* nothing */ }
    ping() { return Promise.resolve({}); }
    async createSession(cfg: any) { sim.sessions.push(cfg); return { sessionId: cfg.sessionId ?? `s${sim.sessions.length}`, on: () => () => undefined, rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: [] }) } }, disconnect: async () => undefined }; }
    async resumeSession(id: string) { throw new Error(`Session not found: ${id}`); }
  }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { AgentHost, USER_PROVIDER_NO_MODEL } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import type { ActiveProvider } from "../../app/main/provider";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const TOKEN = "gho_" + "t".repeat(36); // not a real token
const KEY = "sk-" + "k".repeat(40); // not a real key
const OWN: ActiveProvider = { kind: "user", config: { type: "openai", baseUrl: "https://models.example.com/v1", apiKey: KEY }, models: { conductor: "gpt-4.1", worker: null } };

function makeHost(provider: () => ActiveProvider | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-own-"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const statuses: string[] = [];
  const host = new AgentHost({ userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, setState: () => undefined, onStatus: s => statuses.push(JSON.stringify(s)), provider });
  return { host, statuses };
}

describe("AgentHost with the user's own model provider", () => {
  it("sends no GitHub sign-in to the runtime and gives the sessions the provider's config and models", async () => {
    sim.clients = []; sim.sessions = [];
    const { host } = makeHost(() => OWN);
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    expect(sim.clients[0].opts.gitHubToken).toBeUndefined();
    expect(sim.sessions[0].provider).toEqual(OWN.config);
    expect(sim.sessions[0].model).toBe("gpt-4.1");
    expect(host.getStatus()).toMatchObject({ phase: "ready", detail: "Connected to models.example.com.", service: { kind: "user", host: "models.example.com" }, conductorModel: "gpt-4.1", workerModel: "gpt-4.1" });
    expect(host.getStatus().login).toBeUndefined();
  });

  it("works without any GitHub sign-in at all", async () => {
    sim.clients = []; sim.sessions = [];
    const { host } = makeHost(() => OWN);
    expect(await host.start(null)).toBe("ready");
  });

  it("never puts the key in the status it reports", async () => {
    sim.clients = []; sim.sessions = [];
    const { host, statuses } = makeHost(() => OWN);
    await host.start(TOKEN, "stored");
    expect(statuses.join("\n")).not.toContain(KEY);
    expect(JSON.stringify(host.getStatus())).not.toContain(KEY);
  });

  it("says to enter a model when none is named", async () => {
    sim.clients = []; sim.sessions = [];
    const { host } = makeHost(() => ({ ...OWN, models: { conductor: null, worker: null } }));
    expect(await host.start(null)).toBe("error");
    expect(host.getStatus()).toMatchObject({ reason: "models", detail: USER_PROVIDER_NO_MODEL });
  });

  it("switches to it and back without a restart, with a new conversation on each service", async () => {
    sim.clients = []; sim.sessions = [];
    let now: ActiveProvider | null = null;
    const { host } = makeHost(() => now);
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    expect(sim.clients[0].opts.gitHubToken).toBe(TOKEN);
    expect(host.getStatus()).toMatchObject({ login: "octo", service: undefined });
    const copilotSession = host.conductor!.sessionId;
    // Nothing changed: nothing reconnects.
    expect(host.providerChanged()).toBeNull();
    expect(sim.clients).toHaveLength(1);
    now = OWN;
    await host.providerChanged();
    expect(sim.clients).toHaveLength(2);
    expect(sim.clients[1].opts.gitHubToken).toBeUndefined();
    expect(host.getStatus()).toMatchObject({ phase: "ready", service: { kind: "user" } });
    // The Copilot conversation isn't resumed on the user's service: a new one started there.
    expect(host.conductor!.sessionId).not.toBe(copilotSession);
    expect(sim.sessions.at(-1).provider).toEqual(OWN.config);
    now = null;
    await host.providerChanged();
    expect(sim.clients).toHaveLength(3);
    expect(sim.clients[2].opts.gitHubToken).toBe(TOKEN);
    expect(host.getStatus()).toMatchObject({ phase: "ready", login: "octo", service: undefined });
  });

  it("connects as soon as it is turned on while Ember had no sign-in", async () => {
    sim.clients = []; sim.sessions = [];
    let now: ActiveProvider | null = null;
    const { host } = makeHost(() => now);
    expect(await host.start(null)).toBe("signed-out");
    expect(sim.clients).toHaveLength(0);
    now = OWN;
    await host.providerChanged();
    expect(host.getStatus().phase).toBe("ready");
  });

  it("reconnects for a changed model", async () => {
    sim.clients = []; sim.sessions = [];
    let now: ActiveProvider | null = OWN;
    const { host } = makeHost(() => now);
    await host.start(null);
    now = { ...OWN, models: { conductor: "gpt-4.1-mini", worker: null } };
    await host.providerChanged();
    expect(sim.clients).toHaveLength(2);
    expect(host.getStatus().conductorModel).toBe("gpt-4.1-mini");
  });
});
