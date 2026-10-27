/**
 * AgentHost while the administrator's policy locks Ember down (review #107): no model service is connected at all
 * (no runtime client starts, so nothing read on the screen goes to GitHub Copilot or anywhere else), the status says
 * why in plain words, a question gets that answer, and a sign-in or a reconnect doesn't get round it.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../app/main/logger";

/* eslint-disable @typescript-eslint/no-explicit-any -- a pretend SDK */
const sim = vi.hoisted(() => ({ clients: [] as any[] }));
vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class FakeClient {
    constructor(public opts: any) { sim.clients.push(this); }
    async start() { /* nothing */ }
    async stop() { return []; }
    async forceStop() { /* nothing */ }
    async getAuthStatus() { return { isAuthenticated: true, login: "octo" }; }
    async listModels() { return [{ id: "m", name: "m", capabilities: { supports: { vision: true } } }]; }
    async listSessions() { return []; }
    async deleteSession() { /* nothing */ }
    ping() { return Promise.resolve({}); }
    async createSession(cfg: any) { return { sessionId: cfg.sessionId ?? "s", on: () => () => undefined, rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: [] }) } }, disconnect: async () => undefined }; }
    async resumeSession(id: string) { throw new Error(`Session not found: ${id}`); }
  }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { AgentHost, idleWord, NOTICE_TITLE, type HostOptions } from "../../app/main/agent/host";
import { modelServiceRefusal, parseAdminPolicy } from "../../app/main/admin";
import { SettingsStore } from "../../app/main/settings";
import type { BubbleState, EmberState } from "../../app/shared/overlay";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const TOKEN = "gho_" + "t".repeat(36); // not a real token
const BROKEN = parseAdminPolicy(JSON.stringify({ provider: { type: "openai", baseUrl: "https://llm.example.com/v1" }, futureKey: 1 }), "/etc/ember/policy.json");

function makeHost(extra: Partial<HostOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-lock-"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const bubbles: BubbleState[] = [];
  const host = new AgentHost({
    userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet,
    setState: (p: Partial<EmberState>) => { if (p.bubble) bubbles.push(p.bubble); }, onStatus: () => undefined, ...extra,
  });
  return { host, bubbles };
}

describe("AgentHost while the policy locks Ember down", () => {
  it("connects nothing: no runtime client starts, and the status says why", async () => {
    sim.clients = [];
    const why = modelServiceRefusal(BROKEN)!;
    const { host } = makeHost({ refuseConnect: () => why });
    expect(await host.start(TOKEN, "stored", "auto")).toBe("error");
    expect(sim.clients).toHaveLength(0);
    expect(host.getStatus()).toMatchObject({ phase: "error", reason: "policy", detail: why });
    // A sign-in the user makes, or the GitHub CLI's, doesn't get round it either.
    expect(await host.start(TOKEN, "github-cli")).toBe("error");
    host.networkChanged(true);
    await new Promise(r => setTimeout(r, 10));
    expect(sim.clients).toHaveLength(0);
  });

  it("answers a question with the reason, and the handle says so in a few words", async () => {
    sim.clients = [];
    const why = modelServiceRefusal(BROKEN)!;
    const { host, bubbles } = makeHost({ refuseConnect: () => why });
    await host.start(TOKEN, "stored");
    await host.ask("what's on my screen?");
    expect(sim.clients).toHaveLength(0);
    expect(bubbles.some(b => b.title === NOTICE_TITLE.policy && b.thought.includes(why))).toBe(true);
    expect(idleWord(host.getStatus())).toBe("Locked down");
  });

  it("connects as before once nothing refuses", async () => {
    sim.clients = [];
    let refused: string | null = "locked";
    const { host } = makeHost({ refuseConnect: () => refused });
    expect(await host.start(TOKEN, "stored")).toBe("error");
    refused = null;
    expect(await host.start(TOKEN, "stored")).not.toBe("error");
    expect(sim.clients.length).toBeGreaterThan(0);
    await host.stop();
  });
});
