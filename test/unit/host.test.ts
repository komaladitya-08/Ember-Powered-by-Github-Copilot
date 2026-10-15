/**
 * AgentHost and Conductor against a pretend Copilot SDK: connecting, sign-in
 * trouble, a runtime that dies or hangs, Stop, sign-out and the task cards.
 * The real runtime is covered by the integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EmberState } from "../../app/shared/overlay";
import type { Logger } from "../../app/main/logger";

/* eslint-disable @typescript-eslint/no-explicit-any -- a pretend SDK */
const sim = vi.hoisted(() => ({
  clients: [] as any[],
  sessions: [] as any[],
  deleted: [] as string[],
  resumed: [] as string[],
  resumeFails: false,
  deleteHangs: false,
  auth: async (): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }> => ({ isAuthenticated: true, login: "octo" }),
  ping: async (): Promise<unknown> => ({}),
  stopHangs: false,
  createGate: null as Promise<void> | null,
  /** A prompt reached a session. */
  onSend: (_session: any, _prompt: string) => undefined as void,
}));

vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  const hang = () => new Promise<never>(() => undefined);
  class FakeSession {
    listeners = new Set<(e: any) => void>();
    sent: string[] = [];
    aborted = 0;
    rpc = { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: (this.config.tools ?? []).map((t: any) => ({ name: t.name })) }) } };
    constructor(public sessionId: string, public config: any) {}
    on(fn: (e: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type: string, data: Record<string, unknown> = {}) { for (const l of [...this.listeners]) l({ type, data }); }
    async send(m: { prompt: string }) { this.sent.push(m.prompt); sim.onSend(this, m.prompt); return "m"; }
    async abort() { this.aborted++; }
    async disconnect() { if (sim.stopHangs) await hang(); }
    async setModel() { /* nothing */ }
  }
  class FakeClient {
    stopped = false;
    forced = false;
    constructor(public opts: any) { sim.clients.push(this); }
    async start() { /* nothing */ }
    async stop() { if (sim.stopHangs) await hang(); this.stopped = true; return []; }
    async forceStop() { this.forced = true; }
    getAuthStatus() { return sim.auth(); }
    async listModels() { return [{ id: "gpt-5-mini", name: "mini", capabilities: { supports: { vision: true } } }]; }
    async listSessions() { return []; }
    async deleteSession(id: string) { if (sim.deleteHangs) await hang(); sim.deleted.push(id); }
    ping() { return sim.ping(); }
    async createSession(cfg: any) { await sim.createGate; const s = new FakeSession(cfg.sessionId ?? "s", cfg); sim.sessions.push(s); return s; }
    async resumeSession(id: string, cfg: any) { if (sim.resumeFails) throw new Error(`Session not found: ${id}`); sim.resumed.push(id); const s = new FakeSession(id, cfg); sim.sessions.push(s); return s; }
  }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { AgentHost, CUT_OFF, proxyFromChromium, type AgentStatus, type HostOptions } from "../../app/main/agent/host";
import { Conductor } from "../../app/main/agent/conductor";
import { Presenter } from "../../app/main/agent/presenter";
import { SettingsStore } from "../../app/main/settings";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const TOKEN = "gho_" + "t".repeat(36); // not a real token
const conductorSession = () => sim.sessions.filter(s => s.sessionId.startsWith("ember-conductor-")).at(-1);

function makeHost(extra: Partial<HostOptions> = {}) {
  const dir = extra.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  let screen: Partial<EmberState> = {};
  const patches: Partial<EmberState>[] = [];
  const statuses: AgentStatus[] = [];
  const host = new AgentHost({
    userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet,
    setState: p => { screen = { ...screen, ...p }; patches.push(p); },
    onStatus: s => statuses.push(s), ...extra,
  });
  return { host, dir, patches, statuses, screen: () => screen, agentJson: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8")); } catch { return null; } } };
}

/** Pretend hands: tasks run (their workers talk to the pretend SDK) but never touch a screen. */
const hands = () => ({
  perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
  confirmer: { waiting: false, cancelAll() {} } as never, flyTo() {}, currentWindow: () => null,
});

beforeEach(() => {
  sim.clients = []; sim.sessions = []; sim.deleted = []; sim.resumed = []; sim.deleteHangs = false; sim.resumeFails = false;
  sim.auth = async () => ({ isAuthenticated: true, login: "octo" });
  sim.ping = async () => ({});
  sim.stopHangs = false;
  sim.createGate = null;
  sim.onSend = () => undefined;
});
afterEach(() => { vi.useRealTimers(); });

describe("connecting and signing in", () => {
  it("start() resolves to how it ended", async () => {
    const { host } = makeHost();
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    sim.auth = async () => ({ isAuthenticated: false });
    expect(await host.start(TOKEN, "stored")).toBe("error");
    expect(await host.start(null)).toBe("signed-out");
    expect(host.getStatus().detail).toBe("Not connected to Copilot: sign in with GitHub below.");
  });

  it("GitHub out of reach (VPN not up, proxy, captive portal): a network message and a retry, not the token's fault", async () => {
    vi.useFakeTimers();
    sim.auth = async () => ({ isAuthenticated: false });
    const { host } = makeHost({ reachable: async () => false, isOnline: () => true });
    expect(await host.start(TOKEN, "environment")).toBe("error");
    expect(host.getStatus().detail).toMatch(/can't reach GitHub/);
    expect(sim.clients).toHaveLength(1);
    // The network comes back: the retry connects on its own.
    sim.auth = async () => ({ isAuthenticated: true, login: "octo" });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sim.clients).toHaveLength(2);
    expect(host.getStatus().phase).toBe("ready");
    await host.stop();
  });

  it("GitHub answers but Copilot refuses: two more tries, then the sign-in is blamed (and no retry loop)", async () => {
    vi.useFakeTimers();
    sim.auth = async () => ({ isAuthenticated: false });
    const { host } = makeHost({ reachable: async () => true });
    const done = host.start(TOKEN, "github-cli");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBe("error");
    expect(sim.clients).toHaveLength(3);
    expect(sim.clients.slice(0, 2).every(c => c.stopped)).toBe(true);
    expect(host.getStatus().detail).toMatch(/didn't accept the GitHub sign-in Ember found \(the GitHub CLI sign-in\)/);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sim.clients).toHaveLength(3);
  });

  it("a moment's hiccup: the second try connects", async () => {
    vi.useFakeTimers();
    let n = 0;
    sim.auth = async () => ({ isAuthenticated: ++n > 1, login: "octo" });
    const { host } = makeHost({ reachable: async () => true });
    const done = host.start(TOKEN, "stored");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await done).toBe("ready");
    expect(host.getStatus().detail).toBe("Signed in as octo.");
    await host.stop();
  });
});

describe("sign-out", () => {
  it("forgets the conversation even when Copilot isn't connected, and the GitHub CLI isn't used again until the user signs in", async () => {
    const { host, dir, agentJson } = makeHost();
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ conductorSessionId: "ember-conductor-old" }));
    // Signed out from the error state: no conductor to ask.
    await host.forgetConversation();
    expect(agentJson()).toEqual({ forget: ["ember-conductor-old"], signedOut: true });

    // Ember's own start at the next launch finds the CLI sign-in but doesn't use it.
    expect(await host.start(TOKEN, "github-cli", "auto")).toBe("signed-out");
    expect(sim.clients).toHaveLength(0);

    // The user signs in: a fresh conversation, and the old one is deleted from the runtime's store.
    expect(await host.start(TOKEN, "github-cli")).toBe("ready");
    expect(sim.deleted).toContain("ember-conductor-old");
    expect(conductorSession().sessionId).not.toBe("ember-conductor-old");
    expect(agentJson().signedOut).toBeUndefined();
    expect(agentJson().forget).toBeUndefined();
    await host.stop();
  });

  it("a stored sign-in (made by the user) is used at launch even after an earlier sign-out", async () => {
    const { host } = makeHost();
    await host.forgetConversation();
    expect(await host.start(TOKEN, "stored", "auto")).toBe("ready");
    await host.stop();
  });
});

describe("the conversation lasts one run of Ember", () => {
  it("a reconnect resumes it, quitting deletes it, and one a crashed run left behind is deleted rather than resumed", async () => {
    const { host, dir, agentJson } = makeHost();
    await host.start(TOKEN, "stored");
    const first = conductorSession().sessionId;
    expect(agentJson().conductorSessionId).toBe(first);
    // Reconnecting within the run (the runtime restarted, Check again): the same conversation.
    await host.start(TOKEN, "stored");
    expect(sim.resumed).toEqual([first]);
    expect(conductorSession().sessionId).toBe(first);
    // Quit: deleted, and nothing saved.
    await host.stop();
    expect(sim.deleted).toEqual([first]);
    expect(agentJson()).toBeNull();

    // A run that crashed left its conversation's id behind: the next run deletes it and starts fresh.
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ conductorSessionId: "ember-conductor-crashed" }));
    const next = makeHost({ userData: dir });
    await next.host.start(TOKEN, "stored");
    expect(sim.resumed).toEqual([first]);
    expect(sim.deleted).toContain("ember-conductor-crashed");
    expect(conductorSession().sessionId).not.toBe("ember-conductor-crashed");
    await next.host.stop();
  });

  it("quitting while the runtime doesn't answer waits about two seconds, and the next start deletes it", async () => {
    vi.useFakeTimers();
    const { host, dir, agentJson } = makeHost();
    await host.start(TOKEN, "stored");
    const id = conductorSession().sessionId;
    sim.deleteHangs = true;
    let stopped = false;
    void host.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(2100);
    expect(agentJson()).toEqual({ forget: [id] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stopped).toBe(true);
    sim.deleteHangs = false;
    const next = makeHost({ userData: dir });
    await next.host.start(TOKEN, "stored");
    expect(sim.deleted).toContain(id);
    expect(sim.resumed).toEqual([]);
    await next.host.stop();
  });
});

describe("asking", () => {
  it("a question asked while the session is still opening waits for it instead of being dropped", async () => {
    let open!: () => void;
    sim.createGate = new Promise<void>(r => { open = r; });
    const { host } = makeHost();
    const started = host.start(TOKEN, "stored");
    while (!host.conductor) await new Promise(r => setTimeout(r, 5));
    const asked = host.ask("hello while starting");
    setTimeout(open, 50);
    await asked;
    await started;
    expect(conductorSession().sent.join("\n")).toContain("hello while starting");
    await host.stop();
  });

  it("Stop drops a request still waiting for the brain, also one main held while reading the screen", async () => {
    let open!: () => void;
    sim.createGate = new Promise<void>(r => { open = r; });
    const { host } = makeHost();
    const started = host.start(TOKEN, "stored");
    const asked = host.ask("CALLTOOL:set_appearance");
    await new Promise(r => setTimeout(r, 20));
    const epoch = host.stopEpoch;
    await host.abortAll();
    open();
    await asked;
    await started;
    expect(conductorSession().sent).toEqual([]);
    // main took the epoch before its 1.5 s screen read; Stop came meanwhile.
    await host.ask("change my wallpaper", null, epoch);
    expect(conductorSession().sent).toEqual([]);
    await host.ask("now this one");
    expect(conductorSession().sent).toHaveLength(1);
    await host.stop();
  });

  it("not connected: a notice instead of an error", async () => {
    const { host, screen } = makeHost();
    await host.start(null);
    await host.ask("hi");
    expect(screen().bubble).toMatchObject({ visible: true, title: "I need Copilot first" });
  });
});

describe("a runtime that dies or hangs", () => {
  it("a hung runtime is noticed, the cut-off answer says so, and reconnecting doesn't wait on it", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost({ healthMs: 1000 });
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    await host.ask("hello?");
    expect(screen().bubble?.title).toBe("Thinking…");
    // SIGSTOP: nothing answers any more.
    sim.ping = () => new Promise(() => undefined);
    sim.stopHangs = true;
    await vi.advanceTimersByTimeAsync(3500);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: expect.stringMatching(/Copilot stopped unexpectedly. I'm reconnecting/) });
    sim.ping = async () => ({});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sim.clients[0].forced).toBe(true);
    expect(sim.clients).toHaveLength(2);
    expect(host.getStatus().phase).toBe("ready");
    sim.stopHangs = false;
    await host.stop();
  });

  it("offline retries don't count as crashes: one crash after them still reconnects", async () => {
    vi.useFakeTimers();
    let reach = false;
    sim.auth = async () => ({ isAuthenticated: reach, login: "octo" });
    const { host, statuses } = makeHost({ reachable: async () => reach, healthMs: 1000 });
    await host.start(TOKEN, "stored");
    for (const wait of [15_000, 30_000, 60_000, 120_000]) await vi.advanceTimersByTimeAsync(wait + 100);
    expect(sim.clients).toHaveLength(5);
    reach = true;
    await vi.advanceTimersByTimeAsync(240_100);
    expect(host.getStatus().phase).toBe("ready");
    let once = true;
    sim.ping = async () => { if (once) { once = false; throw new Error("Connection is disposed."); } return {}; };
    await vi.advanceTimersByTimeAsync(1500);
    expect(statuses.map(s => s.detail)).toContain("Copilot stopped unexpectedly. Reconnecting…");
    expect(statuses.map(s => s.detail)).not.toContain("Copilot keeps stopping. Press Check again to retry, or restart Ember.");
    expect(host.getStatus().phase).toBe("ready");
    await host.stop();
  });

  it("five crashes in ten minutes: Ember stops trying", async () => {
    vi.useFakeTimers();
    sim.ping = async () => { throw new Error("Connection is disposed."); };
    const { host } = makeHost({ healthMs: 1000 });
    await host.start(TOKEN, "stored");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.getStatus().detail).toMatch(/keeps stopping/);
    const n = sim.clients.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sim.clients).toHaveLength(n);
  });
});

describe("tasks and Stop", () => {
  it("a restart takes the old task cards off the screen for good", async () => {
    vi.useFakeTimers();
    sim.onSend = (s, prompt) => { if (s.sessionId.startsWith("ember-task-") && prompt.startsWith("Task:")) setTimeout(() => s.emit("session.error", { message: "boom" }), 10); };
    const { host, screen } = makeHost({ hands: hands() });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("do something that fails");
    await vi.advanceTimersByTimeAsync(200);
    expect(host.tasks!.get(t.id)?.status).toBe("failed");
    expect(screen().tasks?.map(c => c.status)).toEqual(["failed"]);
    await host.start(TOKEN, "stored");
    expect(screen().tasks).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen().tasks).toEqual([]);
    await host.stop();
  });

  it("the kill switch's message stays: neither the stopped task nor the conversation replaces it", async () => {
    vi.useFakeTimers();
    const { host, patches } = makeHost({ hands: hands() });
    await host.start(TOKEN, "stored");
    host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(50);
    await host.ask("and what time is it?");
    await host.abortAll();
    // main writes its own "Stopped" bubble right after (kill switch).
    const n = patches.length;
    conductorSession().emit("session.idle", { aborted: true });
    for (const s of sim.sessions.filter(x => x.sessionId.startsWith("ember-task-"))) {
      s.emit("tool.execution_complete", { success: false });
      s.emit("session.idle", { aborted: true });
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.tasks!.list()[0].status).toBe("cancelled");
    expect(patches.slice(n).filter(p => p.bubble || p.emotion)).toEqual([]);
    expect(host.getTranscript().at(-1)?.text).toBe("tidy my desktop: stopped.");
    // The next request speaks again.
    await host.ask("hello again");
    expect(patches.at(-1)?.bubble?.title).toBe("Thinking…");
    await host.stop();
  });

  it("main's own bubble (\"Listening…\") isn't hidden by the conversation's leftover timer", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost();
    const presenter = (host as unknown as { presenter: Presenter }).presenter;
    presenter.userPrompt("what time is it");
    presenter.event({ type: "assistant.message_delta", data: { deltaContent: "It is three o'clock." } });
    presenter.event({ type: "assistant.message", data: { content: "It is three o'clock." } });
    presenter.event({ type: "session.idle", data: {} });
    await vi.advanceTimersByTimeAsync(5000);
    host.claimBubble();
    const listening = { visible: true, mood: "listening" as const, title: "Listening…", thought: "…", step: null, streaming: true, actions: [] };
    (host as unknown as { o: HostOptions }).o.setState({ emotion: "listening", bubble: listening });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen().bubble?.title).toBe("Listening…");
  });
});

describe("Conductor: Stop", () => {
  async function conductor() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-conductor-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const started: string[] = [];
    const { CopilotClient } = await import("@github/copilot-sdk");
    const c = new Conductor({
      client: new CopilotClient({}), settings, presenter: new Presenter(() => undefined), log: quiet,
      stateFile: path.join(dir, "agent.json"), workDir: path.join(dir, "w"), model: "m",
      startTask: g => { started.push(g); return "started"; },
    });
    await c.start();
    const session = conductorSession();
    const startTask = (goal: string) => session.config.tools.find((t: { name: string }) => t.name === "start_task").handler({ goal }, {});
    return { c, session, started, startTask };
  }

  it("Stop with nothing running doesn't refuse the next task", async () => {
    const { c, started, startTask } = await conductor();
    await c.abort();
    expect(await startTask("turn on night light")).toBe("started");
    expect(started).toEqual(["turn on night light"]);
  });

  it("Stop during a turn refuses a task already on its way, until the turn ends or the user asks again", async () => {
    const { c, session, startTask } = await conductor();
    await c.ask("tidy up");
    await c.abort();
    expect(await startTask("tidy up")).toMatch(/just stopped everything/);
    session.emit("session.idle", { aborted: true });
    expect(await startTask("tidy up")).toBe("started");
    await c.ask("tidy up again");
    await c.abort();
    await c.ask("no, do it");
    expect(await startTask("tidy up")).toBe("started");
  });
});

describe("review round 3", () => {
  const presenterOf = (host: AgentHost) => (host as unknown as { presenter: Presenter }).presenter;
  const setStateOf = (host: AgentHost) => (host as unknown as { o: HostOptions }).o.setState;
  const listening = { visible: true, mood: "listening" as const, title: "Listening…", thought: "", step: null, streaming: true, actions: [] };
  const taskSessions = () => sim.sessions.filter(x => x.sessionId.startsWith("ember-task-"));
  function answer(host: AgentHost, text: string) {
    const p = presenterOf(host);
    p.userPrompt("a question");
    p.event({ type: "assistant.message_delta", data: { deltaContent: text } });
    p.event({ type: "assistant.message", data: { content: text } });
    p.event({ type: "session.idle", data: {} });
  }

  it("main gives the bubble back: an answer it put back goes after its reading time; one it cleared doesn't come back", async () => {
    vi.useFakeTimers();
    const { host, screen, patches } = makeHost();
    answer(host, "Paris.");
    const shown = screen().bubble!;
    // "Hey Ember", but it was another word: main puts the answer back.
    host.claimBubble();
    setStateOf(host)({ emotion: "listening", bubble: listening });
    await vi.advanceTimersByTimeAsync(3000);
    setStateOf(host)({ emotion: "neutral", bubble: shown });
    host.releaseBubble(shown);
    await vi.advanceTimersByTimeAsync(6000 + 6 * 50 - 100);
    expect(screen().bubble?.thought).toBe("Paris.");
    await vi.advanceTimersByTimeAsync(200);
    expect(screen().bubble?.visible).toBe(false);
    // Nobody spoke after "Hey Ember": main cleared the bubble, and the answer stays gone.
    answer(host, "Berlin.");
    host.claimBubble();
    setStateOf(host)({ emotion: "neutral", bubble: { ...listening, visible: false } });
    host.releaseBubble(screen().bubble!);
    const n = patches.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(patches.slice(n)).toEqual([]);
  });

  it("while main holds the bubble a task's work doesn't replace it; given back (or after 30 s), the work shows again", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost({ hands: hands() });
    await host.start(TOKEN, "stored");
    host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(50);
    const work = (text: string) => { for (const s of taskSessions()) s.emit("assistant.reasoning_delta", { deltaContent: text }); };
    work("first look ");
    expect(screen().bubble?.title).toBe("tidy my desktop");
    host.claimBubble();
    setStateOf(host)({ emotion: "listening", bubble: listening });
    work("still looking ");
    expect(screen().bubble?.title).toBe("Listening…");
    host.releaseBubble(screen().bubble!);
    expect(screen().bubble).toMatchObject({ title: "tidy my desktop", thought: "first look still looking " });
    // main forgets to give it back: after 30 s the work shows again anyway.
    host.claimBubble();
    setStateOf(host)({ emotion: "listening", bubble: listening });
    work("more ");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(screen().bubble?.title).toBe("Listening…");
    await vi.advanceTimersByTimeAsync(1100);
    expect(screen().bubble?.title).toBe("tidy my desktop");
    const stopped = host.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
  });

  it("a runtime that dies under a task: the task fails (the user stopped nothing), its bubble says so and goes, and the next conductor hears it", async () => {
    vi.useFakeTimers();
    const finished: { status: string; text: string }[] = [];
    const { host, screen } = makeHost({ hands: hands(), healthMs: 1000, onTaskFinished: t => finished.push(t) });
    await host.start(TOKEN, "stored");
    host.tasks!.start("turn on night light");
    await vi.advanceTimersByTimeAsync(50);
    let once = true;
    sim.ping = async () => { if (once) { once = false; throw new Error("Connection is disposed."); } return {}; };
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.getStatus().phase).toBe("ready");
    expect(finished).toEqual([expect.objectContaining({ status: "failed", text: `turn on night light: failed. ${CUT_OFF}` })]);
    expect(screen().bubble).toMatchObject({ visible: true, mood: "error", title: "turn on night light", thought: CUT_OFF });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(screen().bubble?.visible).toBe(false);
    await host.ask("is it on?");
    expect(conductorSession().sent.at(-1)).toContain(`Task "turn on night light" failed: ${CUT_OFF}`);
    await host.ask("and now?");
    expect(conductorSession().sent.at(-1)).not.toContain("task_results");
    await host.stop();
  });

  it("a task the user stopped ends calmly: no sad face, no lasting card, no failure", async () => {
    vi.useFakeTimers();
    const finished: { status: string }[] = [];
    const { host, screen } = makeHost({ hands: hands(), onTaskFinished: t => finished.push(t) });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("turn on night light");
    await vi.advanceTimersByTimeAsync(50);
    host.tasks!.cancel(t.id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(screen()).toMatchObject({ emotion: "neutral", bubble: { visible: true, mood: "idle", title: "turn on night light" } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(screen().tasks).toEqual([]);
    expect(screen().bubble?.visible).toBe(false);
    await host.stop();
  });

  it("after the kill switch, and while quitting, stopped tasks aren't announced one by one", async () => {
    vi.useFakeTimers();
    const finished: string[] = [];
    const { host } = makeHost({ hands: hands(), onTaskFinished: t => finished.push(t.text) });
    await host.start(TOKEN, "stored");
    host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(50);
    await host.abortAll();
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.getTranscript().at(-1)?.text).toBe("tidy my desktop: stopped.");
    host.tasks!.start("turn on night light");
    await vi.advanceTimersByTimeAsync(50);
    const stopped = host.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    expect(host.getTranscript().at(-1)?.text).toBe("turn on night light: stopped.");
    expect(finished).toEqual([]);
  });

  it("a retry left over from a start that a newer one replaced doesn't restart the working connection", async () => {
    vi.useFakeTimers();
    sim.auth = async () => ({ isAuthenticated: false });
    const { host } = makeHost({ reachable: async () => false });
    sim.stopHangs = true;
    const first = host.start(TOKEN, "stored");
    await vi.advanceTimersByTimeAsync(100);
    // The failed start is still stopping its runtime when the user signs in again.
    sim.auth = async () => ({ isAuthenticated: true, login: "octo" });
    const second = host.start(TOKEN, "stored");
    sim.stopHangs = false;
    await vi.advanceTimersByTimeAsync(6000);
    expect(await first).toBe("ready");
    expect(await second).toBe("ready");
    const n = sim.clients.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sim.clients).toHaveLength(n);
    await host.stop();
  });

  it("a conversation that can't be resumed is deleted, not left behind", async () => {
    const { host, agentJson } = makeHost();
    await host.start(TOKEN, "stored");
    const first = conductorSession().sessionId;
    sim.resumeFails = true;
    await host.start(TOKEN, "stored");
    const second = conductorSession().sessionId;
    expect(second).not.toBe(first);
    expect(sim.deleted).toEqual([first]);
    expect(agentJson()).toEqual({ conductorSessionId: second });
    await host.stop();
  });

  it("the system proxy (GNOME settings, PAC) reaches the runtime, which reads only HTTPS_PROXY", async () => {
    expect(proxyFromChromium("PROXY proxy.corp:3128; DIRECT")).toEqual({ url: "http://proxy.corp:3128" });
    expect(proxyFromChromium("HTTPS secure.corp:443")).toEqual({ url: "https://secure.corp:443" });
    expect(proxyFromChromium("DIRECT")).toEqual({ url: null });
    expect(proxyFromChromium("")).toEqual({ url: null });
    expect(proxyFromChromium("SOCKS5 socks.corp:1080")).toEqual({ url: null, socks: "socks5://socks.corp:1080" });

    const saved = { ...process.env };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete process.env[k];
    try {
      vi.useFakeTimers();
      const asked: string[] = [];
      const { host } = makeHost({ resolveProxy: async url => { asked.push(url); return "PROXY proxy.corp:3128; DIRECT"; } });
      await host.start(TOKEN, "stored");
      expect(asked).toEqual(["https://api.github.com/"]);
      expect(sim.clients[0].opts.env).toMatchObject({ HTTPS_PROXY: "http://proxy.corp:3128", https_proxy: "http://proxy.corp:3128", no_proxy: expect.stringContaining("localhost") });
      // GitHub answers through the proxy but Copilot refuses: the error names the proxy.
      sim.auth = async () => ({ isAuthenticated: false });
      const failed = makeHost({ resolveProxy: async () => "PROXY proxy.corp:3128", reachable: async () => true });
      const done = failed.host.start(TOKEN, "stored");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await done).toBe("error");
      expect(failed.host.getStatus().detail).toMatch(/system proxy \(http:\/\/proxy\.corp:3128\)/);
      await host.stop();
    } finally {
      Object.assign(process.env, saved);
    }
    // A proxy in the environment wins: the system isn't asked.
    process.env.HTTPS_PROXY = saved.HTTPS_PROXY ?? "http://env.proxy:8080";
    try {
      const asked: string[] = [];
      const { host } = makeHost({ resolveProxy: async url => { asked.push(url); return "PROXY other:1"; } });
      await host.start(TOKEN, "stored");
      expect(asked).toEqual([]);
      await host.stop();
    } finally {
      if (saved.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
    }
  });
});
