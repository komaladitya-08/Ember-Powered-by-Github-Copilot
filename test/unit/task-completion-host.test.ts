/** The real Host/TaskManager publishes one read-only combined result after long parallel work, without new intake. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../app/main/logger";

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK is the single mocked module boundary, as in host.test.ts */
const sim = vi.hoisted(() => ({ sessions: [] as any[], login: "first", summary: null as null | Promise<{ data: { content: string } }> }));
vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class Session {
    listeners = new Set<(e: any) => void>();
    prompt = "";
    rpc = { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: this.config.tools.map((tool: any) => ({ name: tool.name })) }) } };
    constructor(public sessionId: string, public config: any) {}
    on(fn: (e: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type: string, data: Record<string, unknown> = {}) { for (const fn of this.listeners) fn({ type, data }); }
    async send({ prompt }: { prompt: string }) { this.prompt = prompt; this.emit("user.message", { content: prompt }); this.emit("assistant.turn_start", { turnId: "turn" }); return "message"; }
    async sendAndWait({ prompt }: { prompt: string }) { this.prompt = prompt; return sim.summary ?? { data: { content: "The first page is unchanged; the second has a different title." } }; }
    async abort() { this.emit("abort", { reason: "user initiated" }); this.emit("session.idle", { aborted: true }); }
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
import { CONSENT_VERSION } from "../../app/shared/consent";
import { modeCardVersion } from "../../app/shared/approvals";
import type { ActiveProvider } from "../../app/main/provider";
import { Confirmer } from "../../app/main/agent/confirm";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const cleanups: (() => Promise<void>)[] = [];
const token = "gho_" + "x".repeat(36);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const summaryCalls = () => sim.sessions.filter(session => session.sessionId.startsWith("ember-coordination-"));
beforeEach(() => { sim.sessions = []; sim.login = "first"; sim.summary = null; });
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(extra: Partial<HostOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-completion-host-")), settings = new SettingsStore(path.join(dir, "settings.json")); settings.load();
  settings.update({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } });
  const completed = vi.fn(), answered = vi.fn(), own = vi.fn();
  const host = new AgentHost({ userData: dir, settings, runtimePath: "/offline/copilot-runtime", log: quiet, setState() {}, onStatus() {},
    onAnswer: answered, onOwnRequest: own, onTaskCompletion: completed,
    hands: { perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
      confirmer: { waiting: false, cancelAll() {} } as never, flyTo() {}, currentWindow: () => null }, ...extra });
  expect(await host.start(token, "stored"), JSON.stringify(host.getStatus())).toBe("ready");
  const options = { hold: false, cleanupKnown: true };
  const workers: { spec: TaskSpec; outcome: ReturnType<typeof deferred<WorkerResult>>; disposal: ReturnType<typeof deferred<void>>; disposing: boolean; disposed: boolean }[] = [];
  (host.tasks as any).d.makeWorker = (spec: TaskSpec) => {
    const hold = options.hold, known = options.cleanupKnown;
    const worker = { spec, outcome: deferred<WorkerResult>(), disposal: deferred<void>(), disposing: false, disposed: false }; workers.push(worker);
    return { sessionId: null, handoffSafe: () => true, cleanupComplete: () => known && worker.disposed, steer: async () => true,
      run: (signal: AbortSignal) => { const stop = () => worker.outcome.resolve({ success: false, stopped: true, summary: "Stopped." }); if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); return worker.outcome.promise; },
      dispose: async () => { worker.disposing = true; if (hold) await worker.disposal.promise; worker.disposed = true; } };
  };
  cleanups.push(async () => { for (const worker of workers) { worker.outcome.resolve({ success: false, stopped: true, summary: "Fixture shutdown." }); worker.disposal.resolve(); } await host.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = sim.sessions.findLast(s => s.sessionId.startsWith("ember-conductor-"));
  const tool = (name: string, args: unknown = {}) => session.config.tools.find((candidate: any) => candidate.name === name).handler(args, {});
  const begin = async () => {
    const project = host.projectSessionsAction({ action: "create", name: "Page comparison" }).selectedProjectId!;
    await host.ask("Inspect both project pages independently and compare their titles");
    await tool("start_task", { goal: "Read the first project page title", sessionName: "First page" });
    await tool("start_task", { goal: "Read the second project page title", sessionName: "Second page" });
    await vi.waitFor(() => expect(workers).toHaveLength(2)); return project;
  };
  const end = () => { session.emit("assistant.message", { content: "Both page checks are running." }); session.emit("session.idle"); };
  const finish = () => { workers[0].outcome.resolve({ success: true, summary: "The first page is unchanged." }); workers[1].outcome.resolve({ success: true, summary: "The second page has a new title." }); };
  const readBubbles = () => {
    const runtime = host as unknown as { outcomes: Map<string, { clear(): void }>; presenter: { clear(): void } };
    for (const presenter of runtime.outcomes.values()) presenter.clear();
    runtime.presenter.clear();
  };
  return { host, settings, workers, options, session, tool, begin, end, finish, readBubbles, completed, answered, own };
}

it("automatically combines two results beyond the unchanged20s join after both actual disposals, with no new user entry", async () => {
  const s = await setup(); s.options.hold = true; await s.begin();
  vi.useFakeTimers();
  const waiting = s.tool("wait_for_tasks", { ids: s.workers.map(worker => worker.spec.id) });
  await vi.advanceTimersByTimeAsync(20_001); expect(await waiting).toContain('"reason":"timeout"'); vi.useRealTimers();
  s.end(); s.finish(); await vi.waitFor(() => expect(s.workers.every(worker => worker.disposing)).toBe(true));
  expect(summaryCalls()).toEqual([]); s.workers[0].disposal.resolve(); await Promise.resolve(); expect(summaryCalls()).toEqual([]);
  s.workers[1].disposal.resolve(); await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
  expect(summaryCalls()).toHaveLength(1); expect(summaryCalls()[0].config.tools).toEqual([]);
  expect(s.host.getTranscript().filter(entry => entry.who === "you")).toHaveLength(1);
  expect(s.host.getTranscript().filter(entry => entry.who === "ember" && entry.text.includes("The first page is unchanged;"))).toHaveLength(1);
  expect(s.own).toHaveBeenCalledTimes(1); expect(s.answered).toHaveBeenCalledTimes(1); expect(s.workers).toHaveLength(2);
  expect(s.host.tasks!.takeReports().map(task => task.id)).toEqual(s.workers.map(worker => worker.spec.id));
});

it("defers synthesis while the original foreground answer is still active", async () => {
  const s = await setup(); await s.begin(); s.finish(); await vi.waitFor(() => expect(s.workers.every(worker => worker.disposed)).toBe(true));
  expect(summaryCalls()).toEqual([]); s.end(); await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
});

it("does not repeat all outcomes already joined by the original conductor", async () => {
  const s = await setup(); await s.begin(); const waiting = s.tool("wait_for_tasks", { ids: s.workers.map(worker => worker.spec.id) });
  s.finish(); expect(await waiting).toContain('"reason":"settled"'); s.end(); await Promise.resolve();
  expect(summaryCalls()).toEqual([]); expect(s.completed).not.toHaveBeenCalled();
});

it("keeps the foreground answer's reading time while adding the combined result to history", async () => {
  const thoughts: string[] = [];
  const s = await setup({ setState: patch => { if (patch.bubble) thoughts.push(patch.bubble.thought); } });
  await s.begin(); s.end(); s.finish(); await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
  expect(thoughts.at(-1)).not.toContain("The first page is unchanged;");
  expect(s.host.getTranscript().some(entry => entry.who === "ember" && entry.text.includes("The first page is unchanged;"))).toBe(true);
  s.readBubbles();
  expect(thoughts.at(-1)).toContain("The first page is unchanged;");
  expect(s.completed).toHaveBeenCalledTimes(1);
});

it("publishes unknown cleanup as unconfirmed and never starts dependent work", async () => {
  const s = await setup(); s.options.cleanupKnown = false; await s.begin(); s.end(); s.finish();
  await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1)); expect(s.completed.mock.calls[0][0]).toMatch(/^Some task cleanup could not be confirmed\./);
  expect(summaryCalls()[0].prompt).toContain('"cleanup":"unknown"'); expect(s.workers).toHaveLength(2);
});

it("waits behind an actual approval question and wakes from its existing settlement without interrupting it", async () => {
  const confirmer = new Confirmer(() => undefined, { armMs: 0, gapMs: 0 });
  const s = await setup({ hands: { perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
    confirmer, flyTo() {}, currentWindow: () => null } });
  await s.begin(); const late = deferred<{ data: { content: string } }>(); sim.summary = late.promise;
  s.end(); s.finish(); await vi.waitFor(() => expect(summaryCalls()).toHaveLength(1));
  const question = confirmer.ask({ title: "Existing task", prompt: "An existing question stays up.", options: [{ id: "deny", label: "Not now" }] });
  late.resolve({ data: { content: "The combined observed result." } }); await new Promise(resolve => setTimeout(resolve, 10));
  expect(confirmer.waiting).toBe(true); expect(s.completed).not.toHaveBeenCalled();
  confirmer.cancelAll(); await question; await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
  expect(s.host.getTranscript().filter(entry => entry.who === "you")).toHaveLength(1);
});

it("does not append or speak a retired completion when Stop is pulled by the presentation boundary", async () => {
  let stops = 0; const thoughts: string[] = [];
  const s = await setup({ setState: patch => { if (patch.bubble) thoughts.push(patch.bubble.thought); if (patch.bubble?.thought?.startsWith("Retired completion result")) { stops++; void s.host.abortAll(); } } });
  await s.begin(); const late = deferred<{ data: { content: string } }>(); sim.summary = late.promise;
  s.end(); s.finish(); await vi.waitFor(() => expect(summaryCalls()).toHaveLength(1));
  s.readBubbles(); // Existing answer/result bubbles have been read, so this notice can actually reach the display.
  await vi.waitFor(() => expect(summaryCalls()[0].prompt).toContain("<accepted_work"));
  late.resolve({ data: { content: "Retired completion result must not be appended after Stop." } });
  await vi.waitFor(() => expect(stops, JSON.stringify({ thoughts, spoken: s.completed.mock.calls })).toBe(1));
  expect(s.completed).not.toHaveBeenCalled();
  expect(s.host.getTranscript().some(entry => entry.text.includes("Retired completion result"))).toBe(false);
});

it.each(["approval", "model-setting"] as const)("does not revive pending synthesis when %s changes back in the same event turn", async kind => {
  const s = await setup(); await s.begin(); const late = deferred<{ data: { content: string } }>(); sim.summary = late.promise;
  s.end(); s.finish(); await vi.waitFor(() => expect(summaryCalls()).toHaveLength(1));
  if (kind === "approval") {
    const before = structuredClone(s.settings.get().approvals);
    s.settings.update({ approvals: { ...before, consent: { ...before.consent, interactive: { version: modeCardVersion("interactive"), at: new Date().toISOString() } } } });
    s.settings.update({ approvals: before });
  } else {
    const before = structuredClone(s.settings.get().models);
    s.settings.update({ models: { ...before, conductor: "different-model" } }); s.settings.update({ models: before });
  }
  late.resolve({ data: { content: "PRIVATE_REVIVED_RESULT" } }); await new Promise(resolve => setTimeout(resolve, 10));
  expect(s.completed).not.toHaveBeenCalled(); expect(s.host.getTranscript().some(entry => entry.text.includes("PRIVATE_REVIVED_RESULT"))).toBe(false);
});

for (const why of ["new-intake", "stop", "forget", "mode", "model", "provider", "project", "account"] as const) {
  it(`drops a late model response after ${why}`, async () => {
    let provider: ActiveProvider | null = null;
    const s = await setup({ provider: () => provider }); await s.begin();
    const late = deferred<{ data: { content: string } }>(); sim.summary = late.promise; s.end(); s.finish(); await vi.waitFor(() => expect(summaryCalls()).toHaveLength(1));
    if (why === "new-intake") await s.host.ask("What time is it?");
    else if (why === "stop") await s.host.abortAll();
    else if (why === "forget") s.host.forgetProjectSessions();
    else if (why === "mode") s.settings.update({ approvals: { mode: "autopilot", consent: { ...s.settings.get().approvals.consent,
      autopilot: { version: modeCardVersion("autopilot"), at: new Date().toISOString() } } } });
    else if (why === "model") await s.host.setModels({ conductor: "gpt-5-mini" });
    else if (why === "provider") { provider = { kind: "user", config: { type: "openai", baseUrl: "http://127.0.0.1:19999/v1", apiKey: "replacement" }, models: { conductor: "other", worker: null } }; s.host.providerChanged(); }
    else if (why === "account") { sim.login = "replacement-account"; await s.host.start(token, "stored"); }
    else s.host.projectSessionsAction({ action: "forget", id: s.host.projectSessionsState().selectedProjectId });
    late.resolve({ data: { content: "PRIVATE_LATE_COMBINED_RESULT" } }); await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.completed).not.toHaveBeenCalled(); expect(s.host.getTranscript().some(entry => entry.text.includes("PRIVATE_LATE_COMBINED_RESULT"))).toBe(false); expect(s.workers).toHaveLength(2);
  });
}

for (const independent of [false, true]) {
  it(`includes accepted dependent sessions after the initial turn${independent ? " alongside independent work" : " for a lone bounded plan"}`, async () => {
    const s = await setup(); s.options.hold = true;
    s.host.projectSessionsAction({ action: "create", name: "Accepted page plan" });
    await s.host.ask("Inspect the project page, then verify its changed title" + (independent ? " and independently inspect another page" : ""));
    const steps = [{ name: "Inspect planned page", goal: "Inspect the project page in the browser" },
      { name: "Verify planned title", goal: "Verify the changed title in the browser" }];
    expect(await s.tool("start_sequence", { steps })).toMatch(/started|queued/);
    if (independent) await s.tool("start_task", { goal: "Inspect another independent page", sessionName: "Independent page" });
    const heads = independent ? 2 : 1;
    await vi.waitFor(() => expect(s.workers).toHaveLength(heads)); s.end();
    s.workers[0].outcome.resolve({ success: true, summary: "The planned page was inspected." });
    if (independent) s.workers[1].outcome.resolve({ success: true, summary: "The independent page was inspected." });
    await vi.waitFor(() => expect(s.workers.slice(0, heads).every(worker => worker.disposing)).toBe(true));
    expect(summaryCalls()).toEqual([]);
    for (const worker of s.workers.slice(0, heads)) worker.disposal.resolve();
    await vi.waitFor(() => expect(s.workers).toHaveLength(heads + 1));
    await new Promise(resolve => setImmediate(resolve));
    expect(summaryCalls()).toEqual([]);
    const tail = s.workers[heads];
    tail.outcome.resolve({ success: true, summary: "The final planned title was verified." });
    await vi.waitFor(() => expect(tail.disposing).toBe(true)); expect(summaryCalls()).toEqual([]);
    tail.disposal.resolve(); await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
    expect(summaryCalls()).toHaveLength(1); expect(summaryCalls()[0].config.tools).toEqual([]);
    expect(summaryCalls()[0].prompt).toContain("The planned page was inspected.");
    expect(summaryCalls()[0].prompt).toContain("The final planned title was verified.");
    if (independent) expect(summaryCalls()[0].prompt).toContain("The independent page was inspected.");
    expect(s.host.getTranscript().filter(entry => entry.who === "you")).toHaveLength(1);
    expect(s.own).toHaveBeenCalledTimes(1); expect(s.workers).toHaveLength(heads + 1);
  });
}

it.each(["failed", "cancelled"] as const)("reports an unstarted desktop tail after its head is %s and cleaned up", async status => {
  const s = await setup(); s.options.hold = true;
  s.host.projectSessionsAction({ action: "create", name: "Accepted page plan" });
  await s.host.ask("Inspect the project page, then verify its changed title");
  const steps = [{ name: "Inspect planned page", goal: "Inspect the project page in the browser" },
    { name: "Verify planned title", goal: "Verify the changed title in the browser" }];
  expect(await s.tool("start_sequence", { steps })).toMatch(/started|queued/);
  await vi.waitFor(() => expect(s.workers).toHaveLength(1)); s.end();
  const head = s.workers[0];
  if (status === "cancelled") s.host.tasks?.cancel(head.spec.id);
  else head.outcome.resolve({ success: false, summary: "The planned page could not be inspected." });
  await vi.waitFor(() => expect(head.disposing).toBe(true));
  expect(summaryCalls()).toEqual([]);
  head.disposal.resolve();
  await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
  expect(s.workers).toHaveLength(1);
  expect(summaryCalls()).toHaveLength(1);
  const { tasks } = JSON.parse(summaryCalls()[0].prompt.match(/<accepted_work untrusted="true">(.*)<\/accepted_work>/u)?.[1] ?? "");
  expect(tasks).toMatchObject([{ title: "Inspect planned page", status, cleanup: "complete" },
    { title: "Verify planned title", status: "cancelled", cleanup: "complete", summary: "This planned session did not start." }]);
});

it.each(["sequence", "independent", "foreground", "dismissed"] as const)("keeps an exact settled outcome through default card expiry (%s)", async scenario => {
  const s = await setup(); s.options.hold = true;
  s.host.projectSessionsAction({ action: "create", name: "Long page plan" });
  const independent = scenario === "independent";
  await s.host.ask("Inspect the project page, then verify its changed title" + (independent ? " and independently inspect another page" : ""));
  const steps = [{ name: "Inspect planned page", goal: "Inspect the project page in the browser" },
    { name: "Verify planned title", goal: "Verify the changed title in the browser" }];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  expect(await s.tool("start_sequence", { steps })).toMatch(/started|queued/);
  if (independent) await s.tool("start_task", { goal: "Inspect another independent page", sessionName: "Independent page" });
  const heads = independent ? 2 : 1;
  await vi.waitFor(() => expect(s.workers).toHaveLength(heads));
  if (scenario !== "foreground") s.end();
  const early = s.workers.slice(0, heads);
  early.forEach((worker, index) => {
    worker.outcome.resolve({ success: true, summary: index ? "The independent page was inspected." : "The planned page was inspected." });
    worker.disposal.resolve();
  });
  await vi.waitFor(() => expect(s.workers).toHaveLength(heads + 1));
  if (scenario === "dismissed") s.host.tasks?.dismiss(early[0].spec.id);
  else await vi.advanceTimersByTimeAsync(15_001);
  expect(early.every(worker => s.host.tasks?.get(worker.spec.id) === undefined)).toBe(true);
  if (scenario === "foreground") s.end();
  expect(summaryCalls()).toEqual([]);
  const tail = s.workers[heads];
  tail.outcome.resolve({ success: true, summary: "The final planned title was verified." });
  await vi.waitFor(() => expect(tail.disposing).toBe(true));
  expect(summaryCalls()).toEqual([]);
  tail.disposal.resolve();
  if (scenario === "dismissed") {
    await vi.waitFor(() => expect(tail.disposed).toBe(true));
    expect(summaryCalls()).toEqual([]); expect(s.completed).not.toHaveBeenCalled();
    return;
  }
  await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
  expect(summaryCalls()).toHaveLength(1);
  expect(summaryCalls()[0].config.tools).toEqual([]);
  expect(summaryCalls()[0].prompt).toContain("The planned page was inspected.");
  expect(summaryCalls()[0].prompt).toContain("The final planned title was verified.");
  if (independent) expect(summaryCalls()[0].prompt).toContain("The independent page was inspected.");
});

it.each(["settled", "pending"] as const)("handles an independent card that expires before accepting the plan (%s cleanup)", async cleanup => {
  const s = await setup(); s.options.hold = true;
  s.host.projectSessionsAction({ action: "create", name: "Long page plan" });
  await s.host.ask("Inspect the other page independently, and inspect the project page then verify its title");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await s.tool("start_task", { goal: "Inspect another independent page", sessionName: "Independent page" });
  await vi.waitFor(() => expect(s.workers).toHaveLength(1));
  const independent = s.workers[0];
  independent.outcome.resolve({ success: true, summary: "The independent page was inspected first." });
  await vi.waitFor(() => expect(independent.disposing).toBe(true));
  if (cleanup === "settled") {
    independent.disposal.resolve();
    await vi.waitFor(() => expect(independent.disposed).toBe(true));
  }
  await vi.advanceTimersByTimeAsync(15_001);
  expect(s.host.tasks?.get(independent.spec.id)).toBeUndefined();
  independent.disposal.resolve();
  const steps = [{ name: "Inspect planned page", goal: "Inspect the project page in the browser" },
    { name: "Verify planned title", goal: "Verify the changed title in the browser" }];
  expect(await s.tool("start_sequence", { steps })).toMatch(/started|queued/);
  s.end();
  await vi.waitFor(() => expect(s.workers).toHaveLength(2));
  const head = s.workers[1];
  head.outcome.resolve({ success: true, summary: "The planned page was inspected." }); head.disposal.resolve();
  await vi.waitFor(() => expect(s.workers).toHaveLength(3));
  const tail = s.workers[2];
  tail.outcome.resolve({ success: true, summary: "The final planned title was verified." }); tail.disposal.resolve();
  await vi.waitFor(() => expect(tail.disposed).toBe(true));
  if (cleanup === "pending") {
    expect(summaryCalls()).toEqual([]); expect(s.completed).not.toHaveBeenCalled();
    return;
  }
  await vi.waitFor(() => expect(s.completed).toHaveBeenCalledTimes(1));
  expect(summaryCalls()).toHaveLength(1);
  expect(summaryCalls()[0].prompt).toContain("The independent page was inspected first.");
  expect(summaryCalls()[0].prompt).toContain("The final planned title was verified.");
});
