/**
 * AgentHost with a targets runtime (§2.3, §2.6, §3.15), against a pretend Copilot SDK and a fake TargetsForAgent:
 * tasks are bound to a computer from the user's own words before anything is queued (a refusal goes straight back to
 * the conductor), each worker gets its target's hands, the window a task starts in comes only from a context read on
 * that same target, each request carries the trusted line, the prompt's caps are fixed when the conversation is created,
 * and the terminal the user asks for becomes Ember's command window where commands are on. Without a targets runtime
 * everything is as before.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { AgentHost, localTargetHands, type Hands, type HostOptions } from "../../app/main/agent/host";
import { LINUX_WORKER_SYSTEM, type TaskSpec, type Worker, type WorkerSystem } from "../../app/main/agent/worker";
import { emberSystemMessage } from "../../app/main/agent/persona";
import { SettingsStore } from "../../app/main/settings";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { KEYS, SHORTCUTS } from "../../app/shared/shortcuts";
import type { CommandService } from "../../app/main/commands/types";
import type { PromptCaps, TargetBinding, TargetHands, TargetsForAgent } from "../../app/main/targets/types";
import type { TargetId } from "../../app/shared/targets";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const TOKEN = "gho_" + "t".repeat(36); // not a real token
const conductorSession = () => sim.sessions.filter(s => s.sessionId.startsWith("ember-conductor-")).at(-1);

const LOCAL: TargetBinding = { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" };
const BUILD: TargetBinding = { id: "ssh:build-01", kind: "ssh", label: "build-01", login: "deploy", screenOs: "linux", shellOs: "linux", desktop: "text" };
const UBUNTU: TargetBinding = { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", screenOs: "win32", shellOs: "linux", desktop: "screen" };

/** Pretend hands: this screen's window is "Mail". */
const hands = (): Hands => ({
  perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
  confirmer: { waiting: false, cancelAll() {} } as never, flyTo() {}, currentWindow: () => ({ title: "Mail", pid: 3 }),
});

/** A command service whose commands are `state`. */
const commands = (binding: TargetBinding, state: "on" | "off" | "needs-consent" = "on") => ({
  binding, capability: () => ({ state, askEvery: null }), shells: () => ["bash"],
} as unknown as CommandService);

/**
 * A targets runtime that knows `bindings`: the user's words name a target by its label after "on"/"in" (a stand-in for
 * §2.3's resolver, which TG owns); the model's choice counts only when the words name it too.
 */
function fakeTargets(o: {
  bindings?: TargetBinding[]; active?: TargetId; caps?: () => PromptCaps; line?: () => string; refuse?: Record<string, string>;
  commandsOn?: Record<string, "on" | "off" | "needs-consent">; screens?: Record<string, string>;
} = {}) {
  const bindings = o.bindings ?? [LOCAL, BUILD];
  const binds: { userWords: string; choice?: string }[] = [];
  const handed: TargetId[] = [];
  const offers: [string, string][] = [];
  const named = (words: string) => bindings.filter(b => new RegExp(`\\b(on|in)\\s+${b.label.replace(/[()]/g, "\\$&")}`, "i").test(words));
  const t: TargetsForAgent = {
    active: o.active ?? "local",
    bind: q => {
      binds.push(q);
      const n = named(q.userWords);
      if (n.length > 1) return { ok: false, why: "Ember works on one computer per task. Ask the user which one." };
      if (n.length === 1) return { ok: true, binding: n[0] };
      if (q.choice) {
        const c = bindings.find(b => b.label.toLowerCase() === q.choice!.toLowerCase());
        if (!c || !q.userWords.toLowerCase().includes(c.label.toLowerCase())) return { ok: false, why: "The user didn't name that computer. Use the one they chose, or ask them." };
        return { ok: true, binding: c };
      }
      return { ok: true, binding: bindings.find(b => b.id === (o.active ?? "local"))! };
    },
    handsFor: id => {
      handed.push(id);
      if (o.refuse?.[id]) return { ok: false, why: o.refuse[id] };
      const binding = bindings.find(b => b.id === id)!;
      const remote = binding.kind === "ssh";
      const h: TargetHands = {
        ...hands(), binding, system: LINUX_WORKER_SYSTEM, commands: commands(binding, o.commandsOn?.[id] ?? "off"),
        grantKey: app => (remote ? `${id}:${app.toLowerCase()}` : app.toLowerCase()), leaseKey: key => (remote ? `${id}|${key}` : key),
        ...(remote ? { currentWindow: () => null, onAuthorized: () => undefined } : {}),
      };
      return { ok: true, hands: h };
    },
    describeTargets: () => "<computers>\n- This computer\n- build-01 (SSH, connected as deploy)\n</computers>",
    describeScreen: id => (id === "local" || id.startsWith("wsl:") ? null : Promise.resolve(o.screens?.[id] ?? `<screen of ${id}/>`)),
    offerConnect: (name, words) => { offers.push([name, words]); return "Shown a Connect button."; },
    activeLine: () => o.line?.() ?? "",
    caps: () => o.caps?.() ?? { commands: false, targets: false },
  };
  return { t, binds, handed, offers };
}

/** Each host's own temporary folder, removed after the file's tests. */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function makeHost(extra: Partial<HostOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-targets-"));
  dirs.push(dir);
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const finished: { title: string; status: string; summary: string; text: string }[] = [];
  const host = new AgentHost({
    userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, setState: () => undefined, onStatus: () => undefined,
    onTaskFinished: t => finished.push(t), ...extra,
  });
  return { host, settings, finished };
}

/** A started host whose task specs are recorded (workers never run); `real` builds the host's own worker for a spec. */
async function started(extra: Partial<HostOptions> = {}) {
  const made = makeHost(extra);
  await made.host.start(TOKEN, "stored");
  const d = (made.host.tasks as any).d;
  const real = d.makeWorker as (spec: TaskSpec, progress: (t: string) => void) => Worker;
  const specs: TaskSpec[] = [];
  const results = new Map<string, string>();
  d.makeWorker = (spec: TaskSpec) => {
    specs.push(spec);
    const said = results.get(spec.goal);
    return {
      run: (signal: AbortSignal) => said !== undefined ? Promise.resolve({ success: true, summary: said }) : new Promise(r => signal.addEventListener("abort", () => r({ success: false, summary: "Stopped." }))),
      steer: async () => true, dispose: async () => undefined, sessionId: null,
    };
  };
  const session = conductorSession();
  const tool = (name: string) => (args: Record<string, unknown> = {}) => session.config.tools.find((t: { name: string }) => t.name === name).handler(args, {}) as Promise<string>;
  return { ...made, specs, results, session, tool, real };
}

beforeEach(() => { sim.sessions = []; });

describe("binding a task before it is queued (§2.3, §2.6)", () => {
  it("binds with the user's own words and the model's choice, and the task keeps its computer", async () => {
    const { t, binds, handed } = fakeTargets();
    const { host, specs, tool } = await started({ hands: hands(), targets: t });
    await host.ask("on build-01, check the disk space");
    const r = await tool("start_task")({ goal: "check the disk space" });
    expect(r).toMatch(/^Task \S+ started on build-01: "check the disk space"/);
    expect(binds.at(-1)).toEqual({ userWords: "on build-01, check the disk space" });
    expect(handed).toEqual(["ssh:build-01"]);
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0]).toMatchObject({ targetId: "ssh:build-01", userWords: "on build-01, check the disk space" });
    expect(host.tasks!.list()[0]).toMatchObject({ targetId: "ssh:build-01", where: "on build-01" });
    await host.stop();
  });

  it("refuses before queueing: two computers named, a computer the user didn't name, or one that can't take it", async () => {
    const { t } = fakeTargets({ caps: () => ({ commands: false, targets: true }), refuse: { "ssh:build-01": "build-01 isn't connected. Connect it from Ember's menu first." } });
    const { host, specs, tool } = await started({ hands: hands(), targets: t });
    await host.ask("copy the logs on build-01 in This computer");
    expect(await tool("start_task")({ goal: "copy the logs" })).toBe("Ember works on one computer per task. Ask the user which one.");
    await host.ask("tidy my downloads");
    expect(await tool("start_task")({ goal: "tidy the downloads", target: "build-01" })).toBe("The user didn't name that computer. Use the one they chose, or ask them.");
    await host.ask("on build-01, tidy the downloads");
    expect(await tool("start_task")({ goal: "tidy the downloads" })).toBe("build-01 isn't connected. Connect it from Ember's menu first.");
    expect(host.tasks!.list()).toEqual([]);
    expect(specs).toEqual([]);
    await host.stop();
  });

  it("a task the user's words don't place goes to the computer Ember is set to", async () => {
    const { t } = fakeTargets({ active: "ssh:build-01" });
    const { host, specs, tool } = await started({ hands: hands(), targets: t });
    await host.ask("check the disk space");
    await tool("start_task")({ goal: "check the disk space" });
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0].targetId).toBe("ssh:build-01");
    await host.stop();
  });
});

describe("the window a task starts in (§2.6, G14)", () => {
  const terminal = { target: { pid: 2, title: "Terminal" }, text: "<screen>Terminal</screen>" };

  it("only a context read on the task's own target; never another computer's window, nor this screen's for a remote task", async () => {
    const { t } = fakeTargets();
    const { host, specs, tool, results } = await started({ hands: hands(), targets: t });
    for (const g of ["check the disk", "check the logs", "tidy up", "check the mail", "check the calendar", "check the weather"]) results.set(g, "Done.");
    await host.ask("on build-01, check the disk", terminal);
    await tool("start_task")({ goal: "check the disk" });
    await host.ask("on build-01, check the logs", { target: { title: "Logs" }, text: "<screen>Logs</screen>", targetId: "ssh:build-01" } as never);
    await tool("start_task")({ goal: "check the logs" });
    await host.ask("on build-01, tidy up");
    await tool("start_task")({ goal: "tidy up" });
    await host.ask("check the mail", terminal);
    await tool("start_task")({ goal: "check the mail" });
    await host.ask("check the calendar", { target: { title: "Logs" }, text: "<screen>Logs</screen>", targetId: "ssh:build-01" } as never);
    await tool("start_task")({ goal: "check the calendar" });
    await host.ask("check the weather");
    await tool("start_task")({ goal: "check the weather" });
    await vi.waitFor(() => expect(specs).toHaveLength(6));
    expect(specs.map(s => s.target)).toEqual([{}, { title: "Logs" }, {}, { pid: 2, title: "Terminal" }, {}, { title: "Mail", pid: 3 }]);
    await host.stop();
  });
});

describe("each worker gets its target's hands (§2.6)", () => {
  it("builds the worker from handsFor: binding, commands, grant and lease keys, vision by desktop, the where badge", async () => {
    const { t, handed } = fakeTargets({ commandsOn: { "ssh:build-01": "on" } });
    const { host, real } = await started({ hands: hands(), targets: t, emberPids: () => [1, 2] });
    const w = real({ id: "9-x", goal: "check the disk", target: {}, targetId: "ssh:build-01" }, () => undefined);
    const d = (w as any).d;
    expect(handed).toEqual(["ssh:build-01"]);
    expect(d.target).toEqual(BUILD);
    expect(d.commands.binding).toEqual(BUILD);
    expect(d.grantKey("Gedit")).toBe("ssh:build-01:gedit");
    expect(d.vision).toBe(false);
    expect(d.emberPids()).toEqual([1, 2]);
    expect(typeof d.onAuthorized).toBe("function");
    const leased: string[] = [];
    (host.tasks as any).lease = async (key: string) => { leased.push(key); return () => undefined; };
    await d.lease("notes.txt", "9-x");
    expect(leased).toEqual(["ssh:build-01|notes.txt"]);
    expect((d.presenter as any).where).toBe("on build-01");
    // A local task's worker gets this computer's hands from the runtime, with no badge.
    const local = (real({ id: "9-y", goal: "x", target: {} }, () => undefined) as any).d;
    expect(local.target).toEqual(LOCAL);
    expect(local.vision).toBe(true);
    expect((local.presenter as any).where).toBeUndefined();
    await host.stop();
  });

  it("a target that can't take the task when it runs ends it at once with why, and no session is made", async () => {
    const { t } = fakeTargets({ refuse: { "ssh:build-01": "build-01 isn't connected. Connect it from Ember's menu first." } });
    const { host, real } = await started({ hands: hands(), targets: t });
    const before = sim.sessions.length;
    const w = real({ id: "9-z", goal: "x", target: {}, targetId: "ssh:build-01" }, () => undefined);
    await expect(w.run(new AbortController().signal)).resolves.toEqual({ success: false, summary: "build-01 isn't connected. Connect it from Ember's menu first." });
    expect(w.sessionId).toBeNull();
    expect(sim.sessions.length).toBe(before);
    await host.stop();
  });

  it("without a targets runtime, workers get this computer's hands as before", async () => {
    const { host, real } = await started({ hands: hands() });
    const d = (real({ id: "9-a", goal: "x", target: {} }, () => undefined) as any).d;
    expect(d.target).toEqual(LOCAL);
    expect(d.commands).toBeNull();
    expect(d.grantKey("Gedit")).toBe("gedit");
    expect(d).not.toHaveProperty("emberPids");
    expect(localTargetHands(hands(), LINUX_WORKER_SYSTEM)).toMatchObject({ binding: LOCAL, commands: null });
    // A task bound to another computer never runs on this screen's hands (fail closed), and no session is made.
    const before = sim.sessions.length;
    const away = real({ id: "9-b", goal: "x", target: {}, targetId: "ssh:build-01" }, () => undefined);
    await expect(away.run(new AbortController().signal)).resolves.toEqual({ success: false, summary: "Ember can't work on that computer here." });
    expect(sim.sessions.length).toBe(before);
    await host.stop();
  });

  it("a task on another computer says where when it is spoken or notified", async () => {
    const { t } = fakeTargets();
    const { host, results, tool, finished } = await started({ hands: hands(), targets: t });
    results.set("check the disk", "40 GB free.");
    results.set("check the mail", "3 new.");
    await host.ask("on build-01, check the disk");
    await tool("start_task")({ goal: "check the disk" });
    await host.ask("check the mail");
    await tool("start_task")({ goal: "check the mail" });
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(finished.map(f => f.text).sort()).toEqual(["On build-01: check the disk: done. 40 GB free.", "check the mail: done. 3 new."]);
    await host.stop();
  });
});

describe("the conversation's caps and trusted line (§2.6, §3.15)", () => {
  it("with nothing on, the conversation is today's: prompt, tools and requests", async () => {
    const plain = await started({ hands: hands() });
    const today = { system: plain.session.config.systemMessage, tools: plain.session.config.tools.map((x: any) => [x.name, x.description]) };
    await plain.host.ask("hello", { target: { title: "Mail" }, text: "<context>Mail</context>" });
    const sentToday = plain.session.sent[0];
    await plain.host.stop();
    const { t } = fakeTargets();
    const withTargets = await started({ hands: hands(), targets: t });
    expect(withTargets.session.config.systemMessage).toEqual(today.system);
    expect(withTargets.session.config.tools.map((x: any) => [x.name, x.description])).toEqual(today.tools);
    await withTargets.host.ask("hello", { target: { title: "Mail" }, text: "<context>Mail</context>" });
    expect(withTargets.session.sent[0]).toBe(sentToday);
    await withTargets.host.stop();
  });

  it("caps are read when the conversation is created; a later change rides the trusted line", async () => {
    let caps: PromptCaps = { commands: false, targets: true };
    const { t } = fakeTargets({ caps: () => caps, line: () => "(Ember is set to work on build-01, connected as deploy: commands only. Commands: on for build-01.)" });
    const { host, session, tool } = await started({ hands: hands(), targets: t });
    expect(session.config.systemMessage).toEqual(emberSystemMessage(PLATFORM_WORDS.linux, { commands: false, targets: true }));
    expect(session.config.tools.map((x: any) => x.name)).toEqual(expect.arrayContaining(["list_computers", "offer_connect"]));
    caps = { commands: true, targets: true };
    await host.ask("what can you do?", { target: { title: "Mail" }, text: "<context>Mail</context>" });
    expect(session.sent[0]).toBe("(Ember is set to work on build-01, connected as deploy: commands only. Commands: on for build-01.) (Since this conversation began, the user turned on commands: tasks can now run commands in Ember's command window.)\n\n<context>Mail</context>\n\nwhat can you do?");
    // The prompt stays as created.
    expect(conductorSession()).toBe(session);
    expect(await tool("list_computers")()).toBe("<computers>\n- This computer\n- build-01 (SSH, connected as deploy)\n</computers>");
    await host.stop();
  });

  it("offer_connect passes the user's own words; the model never connects", async () => {
    const { t, offers } = fakeTargets({ caps: () => ({ commands: false, targets: true }) });
    const { host, tool } = await started({ hands: hands(), targets: t });
    await host.ask("connect to build-01 please");
    expect(await tool("offer_connect")({ name: "build-01" })).toBe("Shown a Connect button.");
    expect(offers).toEqual([["build-01", "connect to build-01 please"]]);
    await host.stop();
  });
});

describe("show_me and describe_screen by target (§2.6)", () => {
  it("show_me is refused when the task's computer isn't this screen", async () => {
    const { t } = fakeTargets();
    const { host, tool } = await started({ hands: hands(), targets: t });
    await host.ask("on build-01, show me how to open the settings");
    expect(await tool("show_me")({ goal: "open the settings" })).toBe("Ember can't point at things on another computer's screen. Explain the steps in words instead.");
    await host.stop();
  });

  it("a guide on this screen never starts in a window read on another computer (G14)", async () => {
    const { t } = fakeTargets({ active: "ssh:build-01" });
    const { host, tool, specs } = await started({ hands: hands(), targets: t });
    await host.ask("show me how to open the settings on this computer", { target: { title: "Settings", pid: 3 }, text: "<screen>Settings</screen>", targetId: "ssh:build-01" } as never);
    await tool("show_me")({ goal: "open the settings" });
    await host.ask("show me how to open the mail on this computer", { target: { title: "Mail", pid: 3 }, text: "<screen>Mail</screen>" });
    await tool("show_me")({ goal: "open the mail" });
    await vi.waitFor(() => expect(specs).toHaveLength(2));
    expect(specs.map(s => [s.mode, s.target])).toEqual([["guide", {}], ["guide", { title: "Mail", pid: 3 }]]);
    await host.stop();
  });

  it("describe_screen reads the named computer's screen through its agent, this screen through main", async () => {
    const { t } = fakeTargets({ caps: () => ({ commands: false, targets: true }), screens: { "ssh:build-01": "<screen>build-01: Terminal</screen>" } });
    const { host, tool } = await started({ hands: hands(), targets: t, describeScreen: async () => "<screen>Mail</screen>" });
    await host.ask("what's open on build-01?");
    expect(await tool("describe_screen")()).toBe("<screen>build-01: Terminal</screen>");
    await host.ask("what's on my screen?");
    expect(await tool("describe_screen")()).toBe("<screen>Mail</screen>");
    expect(await tool("describe_screen")({ target: "build-01" })).toBe("The user didn't name that computer. Use the one they chose, or ask them.");
    await host.stop();
  });
});

describe("the terminal the user asks for (§3.15)", () => {
  const REFUSED = /^The user asked to use the terminal\. Ember doesn't act in terminals/;

  it("becomes Ember's command window where the task's computer has commands; refused as today where it doesn't", async () => {
    const off = fakeTargets();
    const a = await started({ hands: hands(), targets: off.t });
    await a.host.ask("open the terminal and run make");
    expect(await a.tool("start_task")({ goal: "run make" })).toMatch(REFUSED);
    await a.host.stop();
    for (const state of ["on", "needs-consent"] as const) {
      const on = fakeTargets({ commandsOn: { local: state } });
      const b = await started({ hands: hands(), targets: on.t });
      await b.host.ask("open the terminal and run make");
      expect(await b.tool("start_task")({ goal: "run make" }), state).toMatch(/^Task \S+ started: "run make"/);
      await b.host.stop();
    }
  });

  it("on Windows with WSL on, \"in WSL\" names a place, not a terminal; without WSL it is today's terminal word", async () => {
    const WIN: WorkerSystem = { ...LINUX_WORKER_SYSTEM, os: "win32", keys: KEYS.win32, words: PLATFORM_WORDS.win32, shortcuts: SHORTCUTS.win32 };
    const { t } = fakeTargets({ bindings: [{ ...LOCAL, screenOs: "win32", shellOs: "win32" }, UBUNTU] });
    const wslOff = await started({ hands: hands(), targets: t, system: WIN });
    await wslOff.host.ask("open gedit in WSL");
    expect(await wslOff.tool("start_task")({ goal: "open gedit" })).toMatch(REFUSED);
    await wslOff.host.stop();
    const wslOn = await started({ hands: hands(), targets: t, system: WIN });
    wslOn.settings.update({ targets: { ...wslOn.settings.get().targets, wsl: { on: true, consent: { version: 1, at: "2026-10-22T00:00:00Z" } } } });
    await wslOn.host.ask("open gedit in WSL");
    expect(await wslOn.tool("start_task")({ goal: "open gedit" })).toMatch(/started/);
    await wslOn.host.ask("open the WSL terminal and list my files");
    expect(await wslOn.tool("start_task")({ goal: "list my files" })).toMatch(REFUSED);
    await wslOn.host.stop();
  });
});
