/**
 * The TaskManager without a window system (design §2.6, critique integration-3): with a targets runtime and no hands,
 * AgentHost still makes its TaskManager, from `taskBase` (the audit log and the Confirmer main always has), and each task
 * takes the hands the targets runtime gives its target (on this computer without a screen: commands only), or ends at
 * once with the runtime's reason. With neither, there are no tasks, as before; with hands, the hands are used as before.
 * Against a pretend Copilot SDK (as host.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../app/main/logger";

/* eslint-disable @typescript-eslint/no-explicit-any -- a pretend SDK */
const sim = vi.hoisted(() => ({ sessions: [] as any[] }));

vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class FakeSession {
    listeners = new Set<(e: any) => void>();
    sent: string[] = [];
    rpc = { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: (this.config.tools ?? []).map((t: any) => ({ name: t.name })) }) } };
    constructor(public sessionId: string, public config: any) {}
    on(fn: (e: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type: string, data: Record<string, unknown> = {}) { for (const l of [...this.listeners]) l({ type, data }); }
    async send(m: { prompt: string }) { this.sent.push(m.prompt); this.emit("user.message", { content: m.prompt }); this.emit("assistant.turn_start", { turnId: "0" }); return "m"; }
    async abort() { /* nothing */ }
    async disconnect() { /* nothing */ }
    async setModel() { /* nothing */ }
  }
  class FakeClient {
    constructor(public opts: any) {}
    async start() { /* nothing */ }
    async stop() { return []; }
    async forceStop() { /* nothing */ }
    async getAuthStatus() { return { isAuthenticated: true, login: "octo" }; }
    async listModels() { return [{ id: "gpt-5-mini", name: "mini", capabilities: { supports: { vision: true } } }]; }
    async listSessions() { return []; }
    async deleteSession() { /* nothing */ }
    async ping() { return {}; }
    async createSession(cfg: any) { const s = new FakeSession(cfg.sessionId ?? "s", cfg); sim.sessions.push(s); return s; }
    async resumeSession(id: string, cfg: any) { const s = new FakeSession(id, cfg); sim.sessions.push(s); return s; }
  }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { AgentHost, type HostOptions } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import type { TargetHands, TargetsForAgent } from "../../app/main/targets/types";
import type { TaskManagerDeps } from "../../app/main/agent/tasks";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { TargetId } from "../../app/shared/targets";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const TOKEN = "gho_" + "t".repeat(36); // not a real token
const conductor = () => sim.sessions.filter(s => s.sessionId.startsWith("ember-conductor-")).at(-1);
const taskSessions = () => sim.sessions.filter(s => s.sessionId.startsWith("ember-task-"));
const tool = (session: any, name: string) => session.config.tools.find((t: any) => t.name === name);
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 5)); };

/** The audit log and Confirmer main hands AgentHost as its task base: what they were asked to do. */
function taskBase() {
  const written: Record<string, unknown>[] = [];
  let cancelled = 0;
  return {
    base: { audit: { write: (e: Record<string, unknown>) => written.push(e) } as never, confirmer: { waiting: false, settled: async () => undefined, cancelAll: () => { cancelled++; } } as never },
    written, cancelled: () => cancelled,
  };
}

/** Hands for this computer without a screen: commands only (what TG's runtime gives, §2.6), each part marked. */
const commandsOnly = (): TargetHands => ({
  perception: { name: "refusing perception" } as never, sidecar: { name: "refusing sidecar" } as never, policy: { name: "local policy" } as never,
  audit: { write() {} } as never, confirmer: { waiting: false, cancelAll() {} } as never, flyTo() {}, currentWindow: () => null,
  binding: { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "none", desktopWhy: "Ember can't use this computer's screen here." },
  system: undefined as never, commands: null, grantKey: a => a.toLowerCase(), leaseKey: k => `local|${k}`,
});

/** A targets runtime's view for the host that gives (or refuses) hands, noting each target it is asked about. */
function targets(give: (id: TargetId) => { ok: true; hands: TargetHands } | { ok: false; why: string }) {
  const asked: TargetId[] = [];
  const agent: TargetsForAgent = {
    active: "local",
    bind: () => ({ ok: true, binding: commandsOnly().binding }),
    handsFor: id => { asked.push(id); return give(id); },
    describeTargets: () => "<computers>\n- This computer: no desktop; commands\n</computers>",
    describeScreen: () => null,
    offerConnect: () => "",
    activeLine: () => "",
    caps: () => ({ commands: true, targets: false }),
  };
  return { agent, asked };
}

function makeHost(extra: Partial<HostOptions>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-taskbase-"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const cards: unknown[] = [];
  const host = new AgentHost({
    userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet,
    setState: p => { if (p.tasks) cards.push(p.tasks); }, onStatus: () => undefined, ...extra,
  });
  return { host, cards };
}

beforeEach(() => { sim.sessions = []; });

describe("AgentHost's TaskManager without a window system (§2.6, critique integration-3)", () => {
  it("starts a task through the TaskManager with targets and no hands, on the hands the targets runtime gives", async () => {
    const t = targets(() => ({ ok: true, hands: commandsOnly() }));
    const base = taskBase();
    const { host, cards } = makeHost({ targets: t.agent, taskBase: base.base });
    await host.start(TOKEN, "stored");
    expect(host.tasks).not.toBeNull();
    const said = await tool(conductor(), "start_task").handler({ goal: "run the tests in ~/project" }, {});
    expect(said).toMatch(/^Task \S+ started: "run the tests in ~\/project"/);
    await until(() => taskSessions()[0]?.sent.length > 0);
    // The worker runs: its session was made, and it was asked to do the goal.
    expect(taskSessions()).toHaveLength(1);
    expect(taskSessions()[0].sent.join("\n")).toContain("run the tests in ~/project");
    expect(t.asked).toEqual(["local"]);
    // The task base's audit log has its request; the window it started in is none (no screen).
    expect(base.written).toContainEqual(expect.objectContaining({ event: "task", phase: "asked", goal: "run the tests in ~/project", window: undefined }));
    expect(host.tasks!.list()).toEqual([expect.objectContaining({ status: "running", title: "run the tests in ~/project" })]);
    expect(cards.length).toBeGreaterThan(0);
    // It finishes as any task does.
    await tool(taskSessions()[0], "finish_task").handler({ success: true, summary: "All 12 tests passed." }, {});
    taskSessions()[0].emit("session.idle", {});
    await until(() => host.tasks!.list()[0]?.status !== "running");
    expect(host.tasks!.list()[0]).toMatchObject({ status: "done", result: { success: true, summary: "All 12 tests passed." } });
    expect(base.written).toContainEqual(expect.objectContaining({ event: "task", phase: "done" }));
    await host.stop();
  });

  it("ends a task the targets runtime refuses at once, with its words, and makes no session for it", async () => {
    const why = "Ember can't use this computer's screen here, and commands aren't available yet.";
    const t = targets(() => ({ ok: false, why }));
    const base = taskBase();
    const { host } = makeHost({ targets: t.agent, taskBase: base.base });
    await host.start(TOKEN, "stored");
    await tool(conductor(), "start_task").handler({ goal: "tidy my desktop" }, {});
    await until(() => host.tasks!.list()[0]?.status === "failed");
    expect(host.tasks!.list()[0]).toMatchObject({ status: "failed", result: { success: false, summary: why } });
    expect(taskSessions()).toEqual([]);
    expect(base.written).toContainEqual(expect.objectContaining({ event: "task", phase: "failed", summary: why }));
    await host.stop();
  });

  it("cancels the task base's questions on Stop, as the hands' were", async () => {
    const base = taskBase();
    const { host } = makeHost({ targets: targets(() => ({ ok: true, hands: commandsOnly() })).agent, taskBase: base.base });
    await host.start(TOKEN, "stored");
    const before = base.cancelled();
    await host.abortAll();
    expect(base.cancelled()).toBe(before + 1);
    await host.stop();
  });

  it("has no tasks without hands and without targets, as before", async () => {
    const { host } = makeHost({});
    await host.start(TOKEN, "stored");
    expect(host.tasks).toBeNull();
    expect(await tool(conductor(), "start_task").handler({ goal: "tidy my desktop" }, {})).toMatch(/cannot operate applications in this session \(no desktop access\)/);
    expect(tool(conductor(), "list_tasks")).toBeUndefined();
    await host.stop();
  });

  it("uses the hands, not the targets runtime, when the screen has them (today's tasks)", async () => {
    const t = targets(() => ({ ok: false, why: "never asked" }));
    const hands = {
      perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
      confirmer: { waiting: false, settled: async () => undefined, cancelAll() {} } as never, flyTo() {}, currentWindow: () => ({ pid: 42, title: "notes.txt", app: "gedit" }),
    };
    const { host } = makeHost({ hands, targets: t.agent, taskBase: taskBase().base });
    await host.start(TOKEN, "stored");
    await tool(conductor(), "start_task").handler({ goal: "save my document" }, {});
    await until(() => taskSessions()[0]?.sent.length > 0);
    expect(taskSessions()).toHaveLength(1);
    expect(t.asked).toEqual([]);
    expect(taskSessions()[0].sent.join("\n")).toContain("notes.txt");
    await host.stop();
  });

  it("never runs a task bound to another computer on this screen's hands: the targets runtime decides, or it is refused", async () => {
    const hands = {
      perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
      confirmer: { waiting: false, settled: async () => undefined, cancelAll() {} } as never, flyTo() {}, currentWindow: () => null,
    };
    const spec: TaskSpec = { id: "9-abc", goal: "list the files", target: {}, mode: "do", targetId: "ssh:build-01" };
    // The TaskManager's own makeWorker (AG's start_task is what will bind targets; until then, only a spec can).
    const makeWorker = (host: AgentHost) => (host.tasks as unknown as { d: TaskManagerDeps }).d.makeWorker;
    const t = targets(id => ({ ok: false, why: `${id} isn't connected.` }));
    const withTargets = makeHost({ hands, targets: t.agent, taskBase: taskBase().base });
    await withTargets.host.start(TOKEN, "stored");
    await expect(makeWorker(withTargets.host)(spec, () => undefined).run(new AbortController().signal)).resolves.toEqual({ success: false, summary: "ssh:build-01 isn't connected." });
    expect(t.asked).toEqual(["ssh:build-01"]);
    await withTargets.host.stop();
    const handsOnly = makeHost({ hands });
    await handsOnly.host.start(TOKEN, "stored");
    await expect(makeWorker(handsOnly.host)(spec, () => undefined).run(new AbortController().signal)).resolves.toMatchObject({ success: false });
    expect(taskSessions()).toEqual([]);
    await handsOnly.host.stop();
  });
});
