/** Project labels never replace a request's authority or reroute work after intake. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../app/main/logger";

/* eslint-disable @typescript-eslint/no-explicit-any -- an offline SDK boundary, as in host.test.ts */
const sim = vi.hoisted(() => ({ sessions: [] as any[], holdTurns: false, login: "first" }));
vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class Session {
    listeners = new Set<(e: any) => void>();
    waiting: string[] = [];
    rpc = { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: this.config.tools.map((t: any) => ({ name: t.name })) }) } };
    constructor(public sessionId: string, public config: any) {}
    on(fn: (e: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type: string, data: Record<string, unknown> = {}) { for (const fn of this.listeners) fn({ type, data }); }
    async send({ prompt }: { prompt: string }) {
      this.emit("pending_messages.modified");
      if (sim.holdTurns) this.waiting.push(prompt); else this.begin(prompt);
      return "message";
    }
    begin(prompt: string) { this.emit("user.message", { content: prompt }); this.emit("assistant.turn_start", { turnId: "turn" }); }
    nextTurn() { const prompt = this.waiting.shift(); if (prompt) this.begin(prompt); }
    async abort() { this.waiting = []; this.emit("abort", { reason: "user initiated" }); this.emit("session.idle", { aborted: true }); }
    async disconnect() {}
    async setModel() {}
  }
  class Client {
    async start() {}
    async stop() { return []; }
    async forceStop() {}
    async ping() { return {}; }
    async getAuthStatus() { return { isAuthenticated: true, login: sim.login }; }
    async listModels() { return [{ id: "gpt-5-mini", name: "Mini", capabilities: { supports: { vision: true } } }]; }
    async listSessions() { return []; }
    async deleteSession() {}
    async createSession(config: any) { const session = new Session(config.sessionId, config); sim.sessions.push(session); return session; }
    async resumeSession(id: string, config: any) { const session = new Session(id, config); sim.sessions.push(session); return session; }
  }
  return { ...real, CopilotClient: Client, RuntimeConnection: { forStdio: () => ({}) } };
});

import { AgentHost, type HostOptions } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import type { TaskSpec, WorkerResult } from "../../app/main/agent/worker";
import type { ActiveProvider } from "../../app/main/provider";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const token = "gho_" + "x".repeat(36);
const hosts: AgentHost[] = [];
beforeEach(() => { sim.sessions = []; sim.holdTurns = false; sim.login = "first"; });
afterEach(async () => { for (const host of hosts.splice(0)) await host.stop(); });
async function setup(extra: Partial<HostOptions> = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-host-"));
  const settings = new SettingsStore(path.join(userData, "settings.json"));
  settings.load();
  const host = new AgentHost({
    userData, settings, runtimePath: "/offline/copilot-runtime", log: quiet, setState() {}, onStatus() {},
    hands: {
      perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
      confirmer: { waiting: false, cancelAll() {} } as never, flyTo() {}, currentWindow: () => null,
    }, ...extra,
  });
  hosts.push(host);
  expect(await host.start(token, "stored"), JSON.stringify(host.getStatus())).toBe("ready");
  const specs: TaskSpec[] = [];
  const finish = new Map<string, (result: WorkerResult) => void>();
  (host.tasks as any).d.makeWorker = (spec: TaskSpec) => {
    specs.push(spec);
    return {
      run: (signal: AbortSignal) => new Promise<WorkerResult>(resolve => {
        finish.set(spec.id, resolve);
        signal.addEventListener("abort", () => resolve({ success: false, summary: "Stopped." }));
      }),
      steer: async () => true, dispose: async () => undefined, sessionId: null,
    };
  };
  const session = sim.sessions.findLast(s => s.sessionId.startsWith("ember-conductor-"));
  const tool = (name: string, args: unknown = {}) => session.config.tools.find((t: any) => t.name === name).handler(args, {});
  const create = (name: string) => host.projectSessionsAction({ action: "create", name }).selectedProjectId!;
  return { host, specs, finish, session, tool, create };
}

it("binds project membership at request intake while preserving the user's exact words", async () => {
  const { host, specs, session, tool, create } = await setup();
  const first = create("Research");
  sim.holdTurns = true;
  await host.ask("Open the browser and compare the project pages");
  const second = create("Personal");
  session.nextTurn();
  expect(await tool("start_task", { goal: "Compare the two pages", sessionName: "Compare sources" })).toMatch(/started/);
  await vi.waitFor(() => expect(specs).toHaveLength(1));
  expect(specs[0].userWords).toBe("Open the browser and compare the project pages");
  expect(specs[0].goal).toBe("Compare the two pages");
  const state = host.projectSessionsState();
  expect(state.selectedProjectId).toBe(second);
  expect(state.projects.find(p => p.id === first)?.sessions).toMatchObject([{ taskId: specs[0].id, title: "Compare sources", kind: "desktop", status: "running" }]);
  expect(state.projects.find(p => p.id === second)?.sessions).toEqual([]);
});

it("refuses to start after a queued request's project was closed rather than silently attaching elsewhere", async () => {
  const { host, specs, session, tool, create } = await setup();
  const first = create("Research");
  sim.holdTurns = true;
  await host.ask("Open the browser");
  host.projectSessionsAction({ action: "forget", id: first });
  create("Personal");
  session.nextTurn();
  expect(await tool("start_task", { goal: "Open the browser" })).toMatch(/project.*closed/i);
  expect(specs).toEqual([]);
});

it("lets the conductor create and select a project for its own request and retains observed terminal outcomes", async () => {
  const { host, specs, finish, tool } = await setup();
  await host.ask("Create a project for checking the website and open its home page");
  expect(await tool("create_project", { name: "Website check", goal: "Inspect the home page" })).toMatch(/created and selected/);
  expect(await tool("start_task", { goal: "Open the home page", sessionName: "Inspect page" })).toMatch(/started/);
  await vi.waitFor(() => expect(specs).toHaveLength(1));
  const task = specs[0];
  expect(() => host.projectSessionsAction({ action: "forget", id: host.projectSessionsState().selectedProjectId })).toThrow(/Stop or finish/);
  finish.get(task.id)!({ success: true, summary: "Opened the requested home page." });
  await vi.waitFor(() => expect(host.projectSessionsState().projects[0].sessions[0]).toMatchObject({ status: "done", summary: "Opened the requested home page." }));
  host.tasks!.dismiss(task.id);
  expect(await tool("list_projects")).toMatch(/untrusted="true"/);
  expect(host.projectSessionsState().projects[0].sessions[0].summary).toBe("Opened the requested home page.");
  await tool("select_project", { id: null });
  expect(host.projectSessionsState().selectedProjectId).toBeNull();
});

it("keeps coding gated and creates no fake project session while desktop delegation remains usable", async () => {
  const { host, specs, tool, create } = await setup({ codingWorkspace: () => ({ path: os.tmpdir(), current: () => true }) });
  create("App work");
  await host.ask("Fix the app code and open its window");
  expect(await tool("start_coding", { goal: "Fix the app code" })).toMatch(/temporarily unavailable/);
  expect(await tool("start_mixed", { first: "coding", firstGoal: "Fix the app code", secondGoal: "Open its window" })).toMatch(/temporarily unavailable/);
  expect(host.projectSessionsState().projects[0].sessions).toEqual([]);
  expect(specs).toEqual([]);
  expect(await tool("start_task", { goal: "Open the app window", sessionName: "Open app" })).toMatch(/started/);
  await vi.waitFor(() => expect(specs).toHaveLength(1));
  expect(host.projectSessionsState().projects[0].sessions[0].kind).toBe("desktop");
});

it("removes project metadata on sign-out before another account can inspect it", async () => {
  const { host, create } = await setup();
  create("Private account work");
  await host.forgetConversation();
  expect(host.projectSessionsState()).toEqual({ projects: [], selectedProjectId: null });
});

it("clears the project book when the model service changes", async () => {
  let provider: ActiveProvider = { kind: "user", config: { type: "openai", baseUrl: "http://localhost:8001", apiKey: "fake-key-1" }, models: { conductor: "gpt-5-mini", worker: "gpt-5-mini" } };
  const { host, create } = await setup({ provider: () => provider });
  create("Provider one work");
  provider = { ...provider, config: { ...provider.config, baseUrl: "http://localhost:8002" } };
  expect(await host.start(token, "stored")).toBe("ready");
  expect(host.projectSessionsState()).toEqual({ projects: [], selectedProjectId: null });
});

it("clears project goals when credentials change at the same provider address", async () => {
  let provider: ActiveProvider = { kind: "user", config: { type: "openai", baseUrl: "http://localhost:8001", apiKey: "fake-key-1" }, models: { conductor: "gpt-5-mini", worker: "gpt-5-mini" }, keyId: "first" };
  const { host, create } = await setup({ provider: () => provider });
  create("First account's project");
  provider = { ...provider, config: { ...provider.config, apiKey: "fake-key-2" }, keyId: "second" };
  expect(await host.start(token, "stored")).toBe("ready");
  expect(host.projectSessionsState()).toEqual({ projects: [], selectedProjectId: null });
});

it("clears the project board when a different GitHub account signs in", async () => {
  const { host, create } = await setup();
  create("First account's project");
  sim.login = "second";
  expect(await host.start(token, "stored")).toBe("ready");
  expect(host.projectSessionsState()).toEqual({ projects: [], selectedProjectId: null });
});

for (const change of ["provider", "account"] as const) {
  it(`fences every retained project callback after a ${change} change, even when SDK shutdown cannot revoke it`, async () => {
    let provider: ActiveProvider = { kind: "user", config: { type: "openai", baseUrl: "http://localhost:8001", apiKey: "fake-key-1" }, models: { conductor: "gpt-5-mini", worker: "gpt-5-mini" } };
    const { host, tool: oldTool, create } = await setup(change === "provider" ? { provider: () => provider } : {});
    await host.ask("Create and inspect the first account's projects");
    // Keep both the registered SDK handlers and the host callbacks: a stopped SDK must not be the only fence.
    const oldHostCallbacks = (host as any).conductor.deps.projects;
    create("Old account board");
    if (change === "provider") {
      provider = { ...provider, config: { ...provider.config, apiKey: "fake-key-2" } };
      // A changed provider can wait for running work before reconnecting: same gen and ready are insufficient.
      const pending = host.projectSessionsState();
      expect(oldHostCallbacks.list()).toMatch(/no longer current/);
      expect(oldHostCallbacks.create("Pending switch injection")).toMatch(/no longer current/);
      expect(oldHostCallbacks.select(null)).toMatch(/no longer current/);
      expect(host.projectSessionsState()).toEqual(pending);
    } else sim.login = "second";
    expect(await host.start(token, "stored")).toBe("ready");
    const selected = create("New account private project");
    const other = create("New account other project");
    host.projectSessionsAction({ action: "select", id: selected });
    await host.ask("Inspect my new private project");
    const before = host.projectSessionsState();
    expect(await oldTool("list_projects")).toMatch(/no longer current/);
    expect(oldHostCallbacks.list()).toMatch(/no longer current/);
    expect(oldHostCallbacks.create("Injected project", "Injected goal")).toMatch(/no longer current/);
    expect(oldHostCallbacks.select(other)).toMatch(/no longer current/);
    await oldTool("create_project", { name: "Stale SDK project" });
    await oldTool("select_project", { id: other });
    expect(host.projectSessionsState()).toEqual(before);
    const freshSession = sim.sessions.findLast(s => s.sessionId.startsWith("ember-conductor-"));
    const freshList = await freshSession.config.tools.find((t: any) => t.name === "list_projects").handler({}, {});
    expect(freshList).toContain("New account private project");
    expect(freshList).not.toContain("Old account board");
  });
}

it("invalidates project reads and mutations immediately on Stop while an SDK abort is still pending", async () => {
  const { host, tool, session, create } = await setup();
  const first = create("Visible project"), other = create("Other project");
  host.projectSessionsAction({ action: "select", id: first });
  await host.ask("Inspect the visible project's sessions");
  const callbacks = (host as any).conductor.deps.projects;
  let release!: () => void;
  const originalAbort = session.abort.bind(session);
  session.abort = () => new Promise<void>(resolve => { release = resolve; });
  const before = host.projectSessionsState();
  const stopped = host.stopAnswer();
  expect(callbacks.list()).toMatch(/no longer current/);
  expect(callbacks.create("Late project")).toMatch(/no longer current/);
  expect(callbacks.select(other)).toMatch(/no longer current/);
  expect(await tool("list_projects")).toMatch(/no longer current/);
  expect(host.projectSessionsState()).toEqual(before);
  release();
  await stopped;
  session.abort = originalAbort;
  session.emit("session.idle", { aborted: true });
  await host.ask("Inspect the visible project again");
  expect(await tool("list_projects")).toContain("Visible project");
});
