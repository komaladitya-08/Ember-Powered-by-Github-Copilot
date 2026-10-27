/**
 * AgentHost and Conductor against a pretend Copilot SDK: connecting, sign-in
 * trouble, a runtime that dies or hangs, Stop, sign-out and the task cards.
 * The real runtime is covered by the integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IDLE_BUBBLE, type BubbleState, type EmberState } from "../../app/shared/overlay";
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
  /** A request being sent waits for this (a hung runtime never answers it). */
  sendGate: null as Promise<void> | null,
  /** A prompt reached a session. */
  onSend: (_session: any, _prompt: string) => undefined as void,
  /** A turn is running: a request sent now waits (its turn starts at session.nextTurn()). */
  holdTurns: false,
  /** The runtime takes this request (send returns) but never begins its turn. */
  stall: (_session: any, _prompt: string) => false as boolean,
  /** An abort ends the turn under way as the real runtime's does (abort, then session.idle); off: it ends nothing. */
  abortEnds: false,
  /** What client.listModels() answers (Copilot Free answers none). */
  models: null as any[] | null,
  /** Task sessions left in the runtime's store by an earlier run. */
  taskSessions: [] as string[],
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
    /** Requests the runtime holds until the running turn ends. */
    waiting: string[] = [];
    // Like the runtime: a request's turn starts with its message (at once when nothing runs).
    async send(m: { prompt: string }) {
      this.sent.push(m.prompt); sim.onSend(this, m.prompt); if (sim.sendGate) await sim.sendGate;
      this.emit("pending_messages.modified");
      if (sim.stall(this, m.prompt)) return "m";
      if (sim.holdTurns) this.waiting.push(m.prompt); else this.begin(m.prompt);
      return "m";
    }
    begin(prompt: string) { this.emit("user.message", { content: prompt }); this.emit("assistant.turn_start", { turnId: "0" }); }
    nextTurn() { const p = this.waiting.shift(); if (p !== undefined) this.begin(p); }
    // Stop ends the turn, and the runtime drops the requests waiting behind it.
    async abort() {
      this.aborted++; this.waiting = [];
      if (sim.abortEnds) { await Promise.resolve(); this.emit("abort", { reason: "user initiated" }); this.emit("session.idle", { aborted: true }); }
    }
    disconnected = false;
    async disconnect() { this.disconnected = true; if (sim.stopHangs) await hang(); }
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
    async listModels() { return sim.models ?? [{ id: "gpt-5-mini", name: "mini", capabilities: { supports: { vision: true } } }]; }
    async listSessions() { return sim.taskSessions.map(sessionId => ({ sessionId })); }
    async deleteSession(id: string) { sim.deleted.push(id); if (sim.deleteHangs) await hang(); }
    ping() { return sim.ping(); }
    async createSession(cfg: any) { await sim.createGate; const s = new FakeSession(cfg.sessionId ?? "s", cfg); sim.sessions.push(s); return s; }
    async resumeSession(id: string, cfg: any) { if (sim.resumeFails) throw new Error(`Session not found: ${id}`); sim.resumed.push(id); const s = new FakeSession(id, cfg); sim.sessions.push(s); return s; }
  }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { AgentHost, CUT_OFF, idleWord, proxyFromChromium, startErrorReason, type AgentStatus, type HostOptions } from "../../app/main/agent/host";
import { AdminPolicySchema } from "../../app/main/admin";
import { Conductor } from "../../app/main/agent/conductor";
import { Presenter, expandedBubble } from "../../app/main/agent/presenter";
import { Confirmer } from "../../app/main/agent/confirm";
import { PolicyEngine, type Agreement } from "../../app/main/policy/policy";
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
  sim.clients = []; sim.sessions = []; sim.deleted = []; sim.resumed = []; sim.deleteHangs = false; sim.resumeFails = false; sim.taskSessions = [];
  sim.auth = async () => ({ isAuthenticated: true, login: "octo" });
  sim.ping = async () => ({});
  sim.stopHangs = false;
  sim.createGate = null;
  sim.sendGate = null;
  sim.onSend = () => undefined;
  sim.holdTurns = false;
  sim.stall = () => false;
  sim.abortEnds = false;
  sim.models = null;
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

  it("says why when the system's keyring refused Ember's saved sign-in, instead of a bare “not connected” (review #241)", async () => {
    let why: string | null = "macOS didn't let Ember read its saved sign-in from your login keychain.";
    const { host } = makeHost({ signedOutWhy: () => why });
    expect(await host.start(null)).toBe("signed-out");
    expect(host.getStatus().detail).toBe("macOS didn't let Ember read its saved sign-in from your login keychain.");
    why = null;
    expect(await host.start(null)).toBe("signed-out");
    expect(host.getStatus().detail).toBe("Not connected to Copilot: sign in with GitHub below.");
  });

  it("connecting doesn't wait for stale task sessions to be deleted", async () => {
    sim.taskSessions = ["ember-task-old"];
    sim.deleteHangs = true;
    const { host } = makeHost();
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    await vi.waitFor(() => expect(sim.deleted).toContain("ember-task-old"));
    sim.deleteHangs = false;
    await host.stop();
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

describe("live test (Copilot Free): an account that lists no models", () => {
  const admin = (models: Record<string, unknown> = {}) => () => AdminPolicySchema.parse({ models });

  it("works on Copilot's default model, says so, and its tasks' sessions name no model either", async () => {
    sim.models = [];
    const { host } = makeHost({ hands: hands() });
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    expect(host.getStatus()).toMatchObject({ phase: "ready", defaultModel: true, conductorModel: null, workerModel: null, models: [] });
    expect(host.getStatus().detail).toBe("Signed in as octo. Using Copilot's default model: this account doesn't list models to choose from.");
    expect(conductorSession().config.model).toBeUndefined();
    const t = host.tasks!.start("tidy my desktop");
    await vi.waitFor(() => expect(sim.sessions.find(s => s.sessionId === `ember-task-${t.id}`)).toBeDefined());
    const work = sim.sessions.find(s => s.sessionId === `ember-task-${t.id}`);
    expect(work.config.model).toBeUndefined();
    expect(host.tasks!.get(t.id)?.status).toBe("running");
    await host.stop();
  });

  it("an administrator's allowed list or pinned model keeps it closed: the default may be one they didn't allow", async () => {
    sim.models = [];
    const allowed = makeHost({ admin: admin({ allowed: ["gpt-5"] }) });
    expect(await allowed.host.start(TOKEN, "stored")).toBe("error");
    expect(allowed.host.getStatus()).toMatchObject({ reason: "models", detail: "None of the models your administrator allows are available to this account." });
    expect(sim.sessions).toHaveLength(0);
    const pinned = makeHost({ admin: admin({ worker: "gpt-5" }) });
    expect(await pinned.host.start(TOKEN, "stored")).toBe("error");
    expect(pinned.host.getStatus()).toMatchObject({ reason: "models", detail: expect.stringMatching(/^Copilot lists no models for this account, and your administrator chose/) });
    // And asked meanwhile, the bubble names that, not the network.
    await pinned.host.ask("what can you do?");
    expect(pinned.screen().bubble).toMatchObject({ title: "No Copilot model I can use" });
  });

  it("every model listed turned off, and no administrator: says so, and blames no administrator (review: host-main)", async () => {
    sim.models = [
      { id: "gpt-5-mini", name: "mini", policy: { state: "disabled" } },
      { id: "claude-sonnet-4.5", name: "Sonnet", policy: { state: "unconfigured" } },
    ];
    for (const made of [makeHost(), makeHost({ admin: admin() })]) {
      expect(await made.host.start(TOKEN, "stored")).toBe("error");
      expect(made.host.getStatus()).toMatchObject({ reason: "models", detail: "None of the models Copilot lists are enabled for this account. Turn one on in your Copilot settings on GitHub." });
      expect(made.host.getStatus().detail).not.toMatch(/administrator/);
    }
    expect(sim.sessions).toHaveLength(0);
  });

  it("a list with models still picks from it (the default is never used then)", async () => {
    const { host } = makeHost();
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    expect(host.getStatus()).toMatchObject({ conductorModel: "gpt-5-mini", defaultModel: false });
    expect(conductorSession().config.model).toBe("gpt-5-mini");
    await host.stop();
  });
});

describe("live test: what Ember says when it can't take a request", () => {
  it("names the real cause (a refused sign-in isn't 'can't reach'), and the Conversation section keeps the request and why", async () => {
    sim.auth = async () => ({ isAuthenticated: false });
    const { host, screen } = makeHost();
    expect(await host.start(TOKEN, "stored")).toBe("error");
    expect(host.getStatus().reason).toBe("sign-in");
    await host.ask("what can you do?");
    expect(screen().bubble).toMatchObject({ title: "Copilot didn't accept the sign-in", thought: expect.stringMatching(/didn't accept the GitHub sign-in/) });
    expect(host.getTranscript().map(e => [e.who, e.text.slice(0, 40)])).toEqual([
      ["you", "what can you do?"],
      ["problem", "Copilot didn't accept the sign-in: Copil"],
    ]);
    // Not taken as an answer to read out.
    expect(host.lastAnswer()).toBeNull();
  });

  it("an error in a turn is kept in the conversation too", async () => {
    const { host } = makeHost();
    await host.start(TOKEN, "stored");
    await host.ask("hello");
    conductorSession().emit("session.error", { message: "HTTP 429 rate limited", errorType: "rate_limit" });
    expect(host.getTranscript().at(-1)).toMatchObject({ who: "problem", text: "Copilot's usage limit was reached for now. Try again a bit later." });
    await host.stop();
  });

  describe("one failure is one line in the conversation, in the words the bubble ends on (review: host-main)", () => {
    const NO_ANSWER = "Copilot didn't answer. Ask me again in a moment.";

    it("a send that fails (the conductor says so, then the reconnect does): one line; the next request's failure gets its own", async () => {
      vi.useFakeTimers();
      const { host, screen } = makeHost();
      await host.start(TOKEN, "stored");
      sim.onSend = () => { throw new Error("Connection is disposed."); };
      await host.ask("hello?");
      expect(host.getTranscript().map(e => e.who)).toEqual(["you", "problem"]);
      expect(host.getTranscript().at(-1)!.text).toBe(screen().bubble?.thought);
      await vi.advanceTimersByTimeAsync(5000);
      await host.ask("again?");
      expect(host.getTranscript().map(e => e.who)).toEqual(["you", "problem", "you", "problem"]);
      sim.onSend = () => undefined;
      const done = host.stop(); await vi.advanceTimersByTimeAsync(15_000); await done;
    });

    it("two requests sent together that both fail: a line each", async () => {
      const { host } = makeHost();
      await host.start(TOKEN, "stored");
      sim.holdTurns = true;
      const session = conductorSession();
      await host.ask("first?");
      session.nextTurn();
      await host.ask("second?");
      for (let i = 0; i < 2; i++) {
        session.emit("session.error", { message: "Rate limit exceeded", errorType: "rate_limit" });
        session.emit("session.idle", {});
        session.nextTurn();
      }
      expect(host.getTranscript().map(e => e.who)).toEqual(["you", "you", "problem", "problem"]);
      await host.stop();
    });

    it("a silent turn the abort doesn't end (said at the end, and again at the reconnect): one line", async () => {
      vi.useFakeTimers();
      const { host } = makeHost({ turnSilentMs: 5000 });
      await host.start(TOKEN, "stored");
      await host.ask("what time is it?");
      await vi.advanceTimersByTimeAsync(5500);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(sim.clients).toHaveLength(2);
      expect(host.getTranscript().map(e => [e.who, e.text])).toEqual([["you", "what time is it?"], ["problem", NO_ANSWER]]);
      const done = host.stop(); await vi.advanceTimersByTimeAsync(15_000); await done;
    });
  });

  it("start errors are sorted by cause, and the handle says it in a few words", () => {
    expect(startErrorReason(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("network");
    expect(startErrorReason(new Error("whatever"), { online: false })).toBe("network");
    expect(startErrorReason(new Error("not authenticated"))).toBe("sign-in");
    expect(startErrorReason(new Error("HTTP 403 no copilot access"))).toBe("no-access");
    expect(startErrorReason(new Error("Failed to load models: access denied by Copilot policy"))).toBe("no-access");
    expect(startErrorReason(new Error("None of the models your administrator allows are available to this account."))).toBe("models");
    expect(startErrorReason(new Error("spawn ENOENT"))).toBe("runtime");
    expect(startErrorReason(new Error("something odd"))).toBe("other");
    expect(idleWord({ phase: "ready" })).toBe("Ready");
    expect(idleWord({ phase: "signed-out" })).toBe("Not connected");
    expect(idleWord({ phase: "error", reason: "network" })).toBe("Offline");
    expect(idleWord({ phase: "error", reason: "models" })).toBe("No model");
    expect(idleWord({ phase: "error", reason: "sign-in" })).toBe("Sign-in refused");
    expect(idleWord({ phase: "error", reason: "other" })).toBe("Copilot problem");
    expect(idleWord({ phase: "error", reason: "not-answering", waitingForTasks: true })).toBe("Waiting for tasks");
  });

  it("the reason goes once Ember is connected again", async () => {
    sim.auth = async () => ({ isAuthenticated: false });
    const { host } = makeHost();
    await host.start(TOKEN, "stored");
    expect(host.getStatus().reason).toBe("sign-in");
    sim.auth = async () => ({ isAuthenticated: true, login: "octo" });
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    expect(host.getStatus().reason).toBeUndefined();
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
    for (const wait of [15_000, 30_000, 60_000, 60_000]) await vi.advanceTimersByTimeAsync(wait + 100);
    expect(sim.clients).toHaveLength(5);
    reach = true;
    await vi.advanceTimersByTimeAsync(60_100);
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
    // Its note on the card and bubble; its model streams on meanwhile (thinking it never shows: it keeps the turn alive).
    const work = (text: string) => {
      for (const p of (host as any).taskPresenters.values()) (p as Presenter).progress(text);
      for (const s of taskSessions()) s.emit("assistant.reasoning_delta", { deltaContent: text });
    };
    work("first look ");
    expect(screen().bubble?.title).toBe("tidy my desktop");
    host.claimBubble();
    setStateOf(host)({ emotion: "listening", bubble: listening });
    work("still looking ");
    expect(screen().bubble?.title).toBe("Listening…");
    host.releaseBubble(screen().bubble!);
    expect(screen().bubble).toMatchObject({ title: "tidy my desktop", thought: "still looking " });
    // main forgets to give it back: after 30 s the work shows again anyway.
    host.claimBubble();
    setStateOf(host)({ emotion: "listening", bubble: listening });
    work("more ");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(screen().bubble?.title).toBe("Listening…");
    // (The task still hears from Copilot: 30 s of silence would title its bubble "Still waiting for Copilot…".)
    work("and more ");
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

describe("review round 4", () => {
  const presenterOf = (host: AgentHost) => (host as unknown as { presenter: Presenter }).presenter;
  const taskSessions = () => sim.sessions.filter(x => x.sessionId.startsWith("ember-task-"));
  const tool = (session: any, name: string) => session.config.tools.find((t: any) => t.name === name);
  const shown = (patches: Partial<EmberState>[]) => patches.filter(p => p.bubble).map(p => p.bubble!.visible ? `${p.bubble!.title}: ${p.bubble!.thought}` : "(hidden)");
  /** A question with buttons that the test puts up and answers, as the confirmer does. */
  function question() {
    let up = false;
    const waiters: (() => void)[] = [];
    return {
      confirmer: { get waiting() { return up; }, settled: () => (up ? new Promise<void>(r => waiters.push(r)) : Promise.resolve()), cancelAll() {} },
      ask() { up = true; },
      answer() { up = false; for (const w of waiters.splice(0)) w(); },
    };
  }
  /** The user asks for a task; the conversation starts it and says "On it…" while the task's question is up. */
  async function onItBehindQuestion(seenFirst = false) {
    vi.useFakeTimers();
    const q = question();
    const made = makeHost({ hands: { ...hands(), confirmer: q.confirmer as never } });
    await made.host.start(TOKEN, "stored");
    await made.host.ask("save my document");
    const talk = conductorSession();
    await tool(talk, "start_task").handler({ goal: "save my document" });
    await vi.advanceTimersByTimeAsync(50);
    const say = () => {
      const onIt = "On it: saving your document…";
      talk.emit("assistant.message_delta", { deltaContent: onIt });
      talk.emit("assistant.message", { content: onIt });
      talk.emit("session.idle", {});
    };
    if (seenFirst) say();
    q.ask(); // the worker's "May I?" (main shows it)
    if (seenFirst) for (const p of (made.host as any).taskPresenters.values()) (p as Presenter).progress("Asking first. ");
    else say();
    return { ...made, q, task: taskSessions()[0] };
  }
  async function finish(task: any, summary: string) {
    await tool(task, "finish_task").handler({ success: true, summary });
    task.emit("session.idle", { aborted: true });
    await vi.advanceTimersByTimeAsync(100);
  }

  it("an “On it…” kept off screen by the task's question isn't shown after the answer; the task's own result is", async () => {
    const { host, patches, q, task } = await onItBehindQuestion();
    const n = patches.length;
    q.answer(); // "Allow"; main shows "Thanks! Carrying on." for a moment
    await vi.advanceTimersByTimeAsync(300);
    await finish(task, "Saved as report.odt.");
    await vi.advanceTimersByTimeAsync(2000);
    expect(shown(patches.slice(n))).toEqual(["save my document: Saved as report.odt."]);
    await host.stop();
  });

  it("the same when the task ends a while after the answer (a slower model): its work, then its result, never the stale “On it…”", async () => {
    const { host, patches, q, task } = await onItBehindQuestion();
    const n = patches.length;
    q.answer(); // "Not now"
    await vi.advanceTimersByTimeAsync(3000);
    for (const p of (host as any).taskPresenters.values()) (p as Presenter).progress("The user said no. ");
    await finish(task, "You said not now, so I left it.");
    await vi.advanceTimersByTimeAsync(1000);
    const after = shown(patches.slice(n));
    expect(after.some(s => s.includes("On it"))).toBe(false);
    expect(after.at(-1)).toBe("save my document: You said not now, so I left it.");
    await host.stop();
  });

  it("an “On it…” already read before the question doesn't come back after the answer either", async () => {
    const { host, patches, q, task } = await onItBehindQuestion(true);
    const n = patches.length;
    q.answer(); // "Not now"
    await vi.advanceTimersByTimeAsync(3000);
    await finish(task, "You said not now, so I left it.");
    await vi.advanceTimersByTimeAsync(1000);
    const after = shown(patches.slice(n));
    expect(after.some(s => s.includes("On it"))).toBe(false);
    expect(after.at(-1)).toBe("save my document: You said not now, so I left it.");
    await host.stop();
  });

  it("closing a failed card drops its result still waiting behind an answer", async () => {
    vi.useFakeTimers();
    const { host, patches } = makeHost({ hands: hands() });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("turn on night light");
    await vi.advanceTimersByTimeAsync(50);
    const p = presenterOf(host);
    p.userPrompt("what time is it?");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Three o'clock." } });
    p.event({ type: "assistant.message", data: { content: "Three o'clock." } });
    p.event({ type: "session.idle", data: {} });
    await tool(taskSessions()[0], "finish_task").handler({ success: false, summary: "The switch wasn't there." });
    taskSessions()[0].emit("session.idle", {});
    await vi.advanceTimersByTimeAsync(100);
    expect(host.tasks!.get(t.id)?.status).toBe("failed");
    host.tasks!.dismiss(t.id);
    const n = patches.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shown(patches.slice(n))).toEqual(["(hidden)"]);
    await host.stop();
  });

  it("offline: the wait between tries stays within a minute, and asking (or the network coming back) tries at once", async () => {
    vi.useFakeTimers();
    let reach = false;
    sim.auth = async () => ({ isAuthenticated: reach, login: "octo" });
    const { host, screen } = makeHost({ reachable: async () => reach });
    await host.start(TOKEN, "stored");
    for (const wait of [15_000, 30_000, 60_000, 60_000, 60_000]) await vi.advanceTimersByTimeAsync(wait + 100);
    expect(sim.clients).toHaveLength(6);
    // The VPN is up: asking connects now and the question goes out.
    reach = true;
    const asked = host.ask("what time is it?");
    await vi.advanceTimersByTimeAsync(100);
    await asked;
    expect(sim.clients).toHaveLength(7);
    expect(host.getStatus().phase).toBe("ready");
    expect(conductorSession().sent.at(-1)).toContain("what time is it?");
    expect(screen().bubble?.title).toBe("Thinking…");
    await host.stop();
    // Main hears the network is back: a waiting retry runs now.
    reach = false;
    const other = makeHost({ reachable: async () => reach });
    await other.host.start(TOKEN, "stored");
    const n = sim.clients.length;
    reach = true;
    other.host.networkChanged(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(sim.clients).toHaveLength(n);
    other.host.networkChanged(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(sim.clients).toHaveLength(n + 1);
    expect(other.host.getStatus().phase).toBe("ready");
    await other.host.stop();
  });

  it("the organisation's endpoint: one the system reaches directly bypasses GitHub's proxy; one with its own proxy uses that", async () => {
    const saved = { ...process.env };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) delete process.env[k];
    try {
      const provider = { type: "openai" as const, baseUrl: "https://llm.corp.example.com/v1", apiKey: "k" };
      const asked: string[] = [];
      const direct = makeHost({ provider, resolveProxy: async url => { asked.push(url); return url.includes("corp.example.com") ? "DIRECT" : "PROXY proxy.corp:3128"; } });
      await direct.host.start(null);
      expect(asked).toEqual(["https://api.github.com/", "https://llm.corp.example.com/v1"]);
      expect(sim.clients.at(-1).opts.env).toMatchObject({ HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "127.0.0.1,localhost,llm.corp.example.com", no_proxy: "127.0.0.1,localhost,llm.corp.example.com" });
      await direct.host.stop();
      const own = makeHost({ provider, resolveProxy: async url => (url.includes("corp.example.com") ? "PROXY llm-proxy.corp:8080" : "PROXY proxy.corp:3128") });
      await own.host.start(null);
      expect(sim.clients.at(-1).opts.env).toMatchObject({ HTTPS_PROXY: "http://llm-proxy.corp:8080", NO_PROXY: "127.0.0.1,localhost" });
      await own.host.stop();
      const none = makeHost({ provider, resolveProxy: async () => "DIRECT" });
      await none.host.start(null);
      expect(sim.clients.at(-1).opts.env.HTTPS_PROXY).toBeUndefined();
      await none.host.stop();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("a question sent while the runtime hung, rejected once that connection was replaced, adds no second error", async () => {
    vi.useFakeTimers();
    const { host, patches } = makeHost({ healthMs: 1000 });
    await host.start(TOKEN, "stored");
    let reject!: (e: Error) => void;
    sim.sendGate = new Promise<void>((_r, j) => { reject = j; });
    sim.ping = () => new Promise(() => undefined);
    const asked = host.ask("are you there?");
    await vi.advanceTimersByTimeAsync(3500);
    sim.ping = async () => ({});
    sim.sendGate = null;
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.getStatus().phase).toBe("ready");
    const n = patches.length;
    reject(new Error("Pending response rejected since connection got disposed"));
    await asked;
    await vi.advanceTimersByTimeAsync(100);
    expect(shown(patches.slice(n))).toEqual([]);
    expect(shown(patches).filter(s => s.startsWith("Something went wrong"))).toEqual(["Something went wrong: Copilot stopped unexpectedly. I'm reconnecting; ask me again in a moment."]);
    await host.stop();
  });
});

describe("review round 5", () => {
  it("a task started or changed in a turn carries what the user said in it, whatever goal or instruction the conductor wrote", async () => {
    const { host } = makeHost({ hands: hands() });
    await host.start(TOKEN, "stored");
    const specs: { goal: string; userWords?: string }[] = [];
    const steered: [string, string | undefined][] = [];
    const d = (host.tasks as any).d;
    const make = d.makeWorker;
    d.makeWorker = (spec: { goal: string; userWords?: string }, progress: unknown) => {
      specs.push(spec);
      const w = make(spec, progress);
      w.steer = async (text: string, words?: string) => { steered.push([text, words]); return true; };
      return w;
    };
    const tool = (name: string) => conductorSession().config.tools.find((t: { name: string }) => t.name === name).handler;
    // The conductor read the screen, which told it to start a task the user never asked for.
    await host.ask("what's on my screen?");
    await tool("start_task")({ goal: "delete all the files in Downloads" }, {});
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0]).toMatchObject({ goal: "delete all the files in Downloads", userWords: "what's on my screen?" });
    await host.ask("ok, carry on");
    const id = host.tasks!.list()[0].id;
    await tool("steer_task")({ id, instruction: "also empty the trash" }, {});
    expect(steered).toEqual([["also empty the trash", "ok, carry on"]]);
    sim.sessions.find(s => s.sessionId.startsWith("ember-task-"))?.emit("session.error", { message: "done" });
    await host.stop();
  });
});

describe("review round 5: the bubble main covers, a reply behind a question, another account", () => {
  const setStateOf = (host: AgentHost) => (host as unknown as { o: HostOptions }).o.setState;
  const presenterOf = (host: AgentHost) => (host as unknown as { presenter: Presenter }).presenter;
  const taskSessions = () => sim.sessions.filter(x => x.sessionId.startsWith("ember-task-"));
  const tool = (session: any, name: string) => session.config.tools.find((t: any) => t.name === name);
  const shown = (patches: Partial<EmberState>[]) => patches.filter(p => p.bubble).map(p => p.bubble!.visible ? `${p.bubble!.title}: ${p.bubble!.thought}` : "(hidden)");
  const listening = { visible: true, mood: "listening" as const, title: "Listening…", thought: "", step: null, streaming: true, actions: [] };
  const RESULT = "turn on night light: Night light is on.";
  /** A task's result on screen: it goes 6.9 s after it showed. */
  async function resultUp() {
    vi.useFakeTimers();
    const made = makeHost({ hands: hands() });
    await made.host.start(TOKEN, "stored");
    made.host.tasks!.start("turn on night light");
    await vi.advanceTimersByTimeAsync(50);
    const task = taskSessions().at(-1);
    await tool(task, "finish_task").handler({ success: true, summary: "Night light is on." });
    task.emit("session.idle", { aborted: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(shown([made.screen()])).toEqual([RESULT]);
    return made;
  }
  async function stop(host: AgentHost) {
    const stopped = host.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
  }
  /** "Hey Ember": main's "Listening…" covers the bubble. Returns what it covered. */
  function wake(host: AgentHost, screen: () => Partial<EmberState>) {
    const before = { emotion: screen().emotion, bubble: screen().bubble! };
    host.claimBubble();
    setStateOf(host)({ emotion: "listening", bubble: listening });
    return before;
  }

  it("a wake that was another word, just as a task's result was due to go: the result is put back and goes after its reading time", async () => {
    const { host, screen } = await resultUp();
    await vi.advanceTimersByTimeAsync(6300); // half a second left
    const before = wake(host, screen);
    await vi.advanceTimersByTimeAsync(900);
    // "Amber": main puts back what was showing and gives the bubble back.
    host.claimBubble();
    setStateOf(host)(before);
    expect(host.releaseBubble(screen().bubble!)).toBe(true);
    await vi.advanceTimersByTimeAsync(6800);
    expect(shown([screen()])).toEqual([RESULT]);
    await vi.advanceTimersByTimeAsync(200);
    expect(screen().bubble?.visible).toBe(false);
    await stop(host);
  });

  it("the result main covered doesn't come back once main cleared the bubble, nor after the user asked something else", async () => {
    // Nobody spoke after "Hey Ember": main clears the bubble.
    let { host, screen, patches } = await resultUp();
    wake(host, screen);
    await vi.advanceTimersByTimeAsync(8000);
    host.claimBubble();
    setStateOf(host)({ emotion: "neutral", bubble: { ...listening, visible: false } });
    expect(host.releaseBubble(screen().bubble!)).toBe(false);
    let n = patches.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shown(patches.slice(n))).toEqual([]);
    await stop(host);

    // "Hey Ember, what time is it?": the answer, then nothing (not the old result).
    ({ host, screen, patches } = await resultUp());
    wake(host, screen);
    await vi.advanceTimersByTimeAsync(2000);
    n = patches.length;
    await host.ask("what time is it?");
    const talk = conductorSession();
    talk.emit("assistant.message_delta", { deltaContent: "Three o'clock." });
    talk.emit("assistant.message", { content: "Three o'clock." });
    talk.emit("session.idle", {});
    await vi.advanceTimersByTimeAsync(60_000);
    const after = shown(patches.slice(n));
    expect(after.some(s => s.includes("Night light"))).toBe(false);
    expect(after.at(-2)).toMatch(/: Three o'clock\.$/);
    expect(after.at(-1)).toBe("(hidden)");
    await stop(host);
  });

  it("a guide step waiting for the user's click comes back after “Listening…”, also when nobody spoke or the user asked something else", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost();
    const step = "Click Save in the toolbar.";
    const guide = (host as unknown as { taskPresenter(id: string, goal: string): Presenter }).taskPresenter("t1", "save my document");
    guide.taskStarted();
    guide.guide(step, "Step 1");
    guide.event({ type: "tool.execution_start", data: { toolName: "wait_for_click" } });
    expect(screen().bubble?.thought).toBe(step);
    wake(host, screen);
    await vi.advanceTimersByTimeAsync(8000);
    host.claimBubble();
    setStateOf(host)({ emotion: "neutral", bubble: { ...listening, visible: false } });
    expect(host.releaseBubble(screen().bubble!)).toBe(true);
    expect(screen().bubble?.thought).toBe(step);
    // "Hey Ember, what does Save do?": the answer, then the step again.
    wake(host, screen);
    const p = presenterOf(host);
    p.userPrompt("what does Save do?");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "It keeps your changes." } });
    p.event({ type: "assistant.message", data: { content: "It keeps your changes." } });
    p.event({ type: "session.idle", data: {} });
    expect(screen().bubble?.thought).toBe("It keeps your changes.");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen().bubble?.thought).toBe(step);
  });

  it("main's own bubble put back after a wake is nobody else's (main hides it); a put-back answer is the conversation's", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost();
    const greeting = { visible: true, mood: "idle" as const, title: "Hi, I'm Ember!", thought: "I'll stay by your cursor.", step: null, streaming: false, actions: [] };
    setStateOf(host)({ emotion: "happy", bubble: greeting });
    let before = wake(host, screen);
    host.claimBubble();
    setStateOf(host)(before);
    expect(host.releaseBubble(screen().bubble!)).toBe(false);

    const p = presenterOf(host);
    p.userPrompt("a question");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Paris." } });
    p.event({ type: "assistant.message", data: { content: "Paris." } });
    p.event({ type: "session.idle", data: {} });
    before = wake(host, screen);
    host.claimBubble();
    setStateOf(host)(before);
    expect(host.releaseBubble(screen().bubble!)).toBe(true);
  });

  it("a reply that answered something else too, kept off screen by the task's question, still shows once after it", async () => {
    vi.useFakeTimers();
    let up = false;
    const waiters: (() => void)[] = [];
    const confirmer = { get waiting() { return up; }, settled: () => (up ? new Promise<void>(r => waiters.push(r)) : Promise.resolve()), cancelAll() {} };
    const { host, patches } = makeHost({ hands: { ...hands(), confirmer: confirmer as never } });
    await host.start(TOKEN, "stored");
    await host.ask("turn on night light, and what's the capital of Australia?");
    const talk = conductorSession();
    await tool(talk, "start_task").handler({ goal: "turn on night light" });
    await vi.advanceTimersByTimeAsync(50);
    up = true; // the task's "May I?" comes up mid-turn
    const reply = "Turning on the night light now. And to your other question: the capital of Australia is Canberra, not Sydney.";
    talk.emit("assistant.message_delta", { deltaContent: reply });
    talk.emit("assistant.message", { content: reply });
    talk.emit("session.idle", {});
    const n = patches.length;
    up = false; // "Allow"
    for (const w of waiters.splice(0)) w();
    await vi.advanceTimersByTimeAsync(300);
    const task = taskSessions()[0];
    await tool(task, "finish_task").handler({ success: true, summary: "Night light is on." });
    task.emit("session.idle", { aborted: true });
    await vi.advanceTimersByTimeAsync(30_000);
    const after = shown(patches.slice(n));
    expect(after.filter(s => s.includes("Canberra"))).toHaveLength(1);
    expect(after).toContain(RESULT);
    expect(after.at(-1)).toBe("(hidden)");
    await stop(host);
  });

  it("signed in as another account from the error state: the first account's conversation is deleted, not resumed", async () => {
    const transcripts: unknown[][] = [];
    // (Main clears the ask box's history then, as at sign-out.)
    let accountChanged = 0;
    const { host } = makeHost({ onTranscript: e => transcripts.push(e), onAccountChanged: () => accountChanged++ });
    await host.start(TOKEN, "stored");
    const first = conductorSession().sessionId;
    await host.ask("what's on my calendar?");
    expect(host.getTranscript()).toHaveLength(1);
    // Copilot refuses the sign-in (Check again later): the error state, the conversation kept for a reconnect.
    sim.auth = async () => ({ isAuthenticated: false });
    expect(await host.start(TOKEN, "stored")).toBe("error");
    expect(accountChanged).toBe(0);
    // "Sign in" with another GitHub account.
    sim.auth = async () => ({ isAuthenticated: true, login: "hubot" });
    const other = "gho_" + "u".repeat(36); // not a real token
    expect(await host.start(other, "stored")).toBe("ready");
    expect(sim.resumed).toEqual([]);
    expect(sim.deleted).toContain(first);
    const second = conductorSession().sessionId;
    expect(second).not.toBe(first);
    expect(host.getTranscript()).toEqual([]);
    expect(transcripts.at(-1)).toEqual([]);
    expect(accountChanged).toBe(1);
    // The same account reconnecting resumes its own conversation.
    expect(await host.start(other, "stored")).toBe("ready");
    expect(sim.resumed).toEqual([second]);
    expect(accountChanged).toBe(1);
    await host.stop();
  });
});

describe("review round 6: a request sent while the conversation is busy waits for its own turn", () => {
  /** The host with tasks whose specs (and the words each change of plan carried) are recorded; their workers never run. */
  async function withTasks(extra: Partial<HostOptions> = {}) {
    const made = makeHost({ hands: hands(), ...extra });
    await made.host.start(TOKEN, "stored");
    const specs: { goal: string; userWords?: string; agreed?: Agreement[]; screen?: string; target?: { title: string }; mode?: string }[] = [];
    const steered: [string, string | undefined, string | undefined][] = [];
    /** What Ember's questions each change of plan carried as agreed to (AC11-1). */
    const steeredAgreed: (Agreement[] | undefined)[] = [];
    /** Tasks with these goals finish at once, saying this. */
    const results = new Map<string, string>();
    const d = (made.host.tasks as any).d;
    d.makeWorker = (spec: (typeof specs)[number]) => {
      specs.push(spec);
      const said = results.get(spec.goal);
      return {
        run: (signal: AbortSignal) => said !== undefined ? Promise.resolve({ success: true, summary: said }) : new Promise(r => signal.addEventListener("abort", () => r({ success: false, summary: "Stopped." }))),
        steer: async (text: string, words?: string, screen?: string, agreed?: Agreement[]) => { steered.push([text, words, screen]); steeredAgreed.push(agreed); return true; },
        dispose: async () => undefined,
      };
    };
    const session = conductorSession();
    const tool = (name: string) => (args: Record<string, unknown> = {}) => session.config.tools.find((t: { name: string }) => t.name === name).handler(args, {});
    return { ...made, specs, steered, steeredAgreed, results, session, tool };
  }
  const mail = { target: { pid: 1, title: "Mail" }, text: "<screen>Mail: Inbox (3)</screen>" };
  const terminal = { target: { pid: 2, title: "Terminal" }, text: "<screen>Terminal</screen>" };

  it("the first turn's task carries its own request's window, words and screen text, not those of a request asked meanwhile", async () => {
    let shown = "<screen>Mail: Write: Weekly report</screen>";
    const { host, specs, steered, session, tool } = await withTasks({ describeScreen: async () => shown });
    sim.holdTurns = true;
    await host.ask("send the weekly report email to Dana", mail);
    session.nextTurn();
    // Turn 1 is still thinking when the user asks something else, somewhere else: the runtime holds it.
    await host.ask("what time is it?", terminal);
    await tool("describe_screen")();
    await tool("start_task")({ goal: "send the weekly report email to Dana" });
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0]).toMatchObject({ goal: "send the weekly report email to Dana", userWords: "send the weekly report email to Dana", target: { title: "Mail" } });
    expect(specs[0].screen).toBe("<screen>Mail: Inbox (3)</screen>\n<screen>Mail: Write: Weekly report</screen>");
    // Turn 2 (the question asked meanwhile) starts: what it does is its own request's.
    session.nextTurn();
    shown = "<screen>Terminal: ~</screen>";
    await tool("describe_screen")();
    await tool("steer_task")({ id: host.tasks!.list()[0].id, instruction: "send it at 5" });
    expect(steered).toEqual([["send it at 5", "what time is it?", "<screen>Terminal</screen>\n<screen>Terminal: ~</screen>"]]);
    await tool("show_me")({ goal: "how to read the clock" });
    await vi.waitFor(() => expect(specs).toHaveLength(2));
    expect(specs[1]).toMatchObject({ mode: "guide", target: { title: "Terminal" } });
    await host.stop();
  });

  it("a task keeps the terminal the user named instead of doing it in another app", async () => {
    const { host, specs, session, tool } = await withTasks();
    sim.holdTurns = true;
    await host.ask("open the terminal and create a file called notes.txt", mail);
    session.nextTurn();
    // The conductor rewrote the method away: Ember refuses rather than opening a file manager.
    expect(await tool("start_task")({ goal: "Create notes.txt in the Files app" })).toMatch(/terminal.*another app/is);
    expect(specs).toHaveLength(0);
    // A goal that keeps the user's method goes ahead; the worker refuses to act in the terminal itself.
    expect(await tool("start_task")({ goal: "Open the terminal and create notes.txt" })).toMatch(/started/);
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0].userWords).toBe("open the terminal and create a file called notes.txt");
    await host.stop();
  });

  it("mentioning the terminal's text size isn't a request to use the terminal", async () => {
    const { host, specs, session, tool } = await withTasks();
    sim.holdTurns = true;
    await host.ask("make my terminal text bigger", mail);
    session.nextTurn();
    expect(await tool("start_task")({ goal: "Make the text a bit bigger" })).toMatch(/started/);
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    await host.stop();
  });

  describe("the terminal guard lets the user answer how else, and holds only to a terminal they asked for (review: host-main)", () => {
    const REFUSED = /terminal.*another app/is;

    it("the user's answer to Ember's “how else?” after a refusal goes ahead; a clarifying answer before one still holds to the terminal", async () => {
      const { host, specs, session, tool } = await withTasks();
      const say = (text: string) => { session.emit("assistant.message_delta", { deltaContent: text }); session.emit("assistant.message", { content: text }); session.emit("session.idle", {}); };
      await host.ask("open the terminal and make a folder", mail);
      say("What should it be called?");
      // Only answering Ember's question: the terminal the user named still holds, also tried again in another app.
      await host.ask("Projects", mail);
      expect(await tool("start_task")({ goal: "Create a folder called Projects in the Files app" })).toMatch(REFUSED);
      expect(await tool("start_task")({ goal: "Create a folder called Projects in Nautilus" })).toMatch(REFUSED);
      say("I can't use the terminal. Do you want me to do it another way, like in Files?");
      // The user's answer to that: not held to the terminal again (and the task still hears the whole request).
      await host.ask("yes, use Files instead", mail);
      expect(await tool("start_task")({ goal: "Create a folder called Projects in the Files app" })).toMatch(/started/);
      await vi.waitFor(() => expect(specs).toHaveLength(1));
      expect(specs[0].userWords).toBe("open the terminal and make a folder.\nProjects.\nyes, use Files instead");
      // A plain "yes" to "Shall I do it in Files?" too.
      await host.ask("open the terminal and create notes.txt", mail);
      expect(await tool("start_task")({ goal: "Create notes.txt in the Files app" })).toMatch(REFUSED);
      say("I can't use the terminal. Shall I create it in Files instead?");
      await host.ask("yes", mail);
      expect(await tool("start_task")({ goal: "Create notes.txt in the Files app" })).toMatch(/started/);
      // The same terminal request asked again later is the user's own words: held again.
      await host.ask("open the terminal and create notes.txt", mail);
      expect(await tool("start_task")({ goal: "Create notes.txt in the Files app" })).toMatch(REFUSED);
      await host.stop();
    });

    it("the same terminal request asked again, then a clarifying answer: held again (an earlier refusal doesn't release it)", async () => {
      const { host, session, tool } = await withTasks();
      const say = (text: string) => { session.emit("assistant.message_delta", { deltaContent: text }); session.emit("assistant.message", { content: text }); session.emit("session.idle", {}); };
      await host.ask("use the terminal to make a folder called Projects", mail);
      expect(await tool("start_task")({ goal: "Create a folder called Projects in Files" })).toMatch(REFUSED);
      say("I can't use the terminal. Want me to guide you instead?");
      await host.ask("no thanks", mail);
      say("Okay.");
      await host.ask("use the terminal to make a folder called Projects", mail);
      say("Where should it go?");
      await host.ask("Documents", mail);
      expect(await tool("start_task")({ goal: "Create a folder called Projects in Documents with Files" })).toMatch(REFUSED);
      await host.stop();
    });

    it("“not in the terminal” isn't a request to use it", async () => {
      const { host, tool } = await withTasks();
      await host.ask("rename notes.txt to old.txt in Files, not in the terminal", mail);
      expect(await tool("start_task")({ goal: "Rename notes.txt to old.txt in Files" })).toMatch(/started/);
      await host.ask("make the folder in Files without opening a terminal", mail);
      expect(await tool("start_task")({ goal: "Make the folder in Files" })).toMatch(/started/);
      await host.stop();
    });

    it("GNOME Shell's extensions, the terminal's font and an app named “console” aren't the terminal; the terminal still is, however it's said", async () => {
      const { host, tool } = await withTasks();
      for (const [words, goal] of [
        ["open GNOME Shell Extensions and turn off Dash to Dock", "Disable Dash to Dock in Extensions"],
        ["open Settings and change the terminal font", "Change the monospace font in Settings"],
        ["start the Xbox console companion", "Open the Xbox Companion app"],
        ["use the Extensions app to turn off a shell extension", "Turn off Dash to Dock in the Extensions app"],
      ]) {
        await host.ask(words, mail);
        expect(await tool("start_task")({ goal }), words).toMatch(/started/);
      }
      for (const [words, goal] of [
        ["open up a new terminal and list my files", "List my files in the Files app"],
        ["open GNOME Terminal and check the free disk space", "Check the free disk space in Disk Usage Analyzer"],
        ["run ls from the shell", "List the files in the Files app"],
        ["type it into the terminal: mkdir Projects", "Create a folder called Projects in the Files app"],
        ["do it on the command line", "Create a folder in the Files app"],
        ["open the Linux terminal and list my files", "List my files in the Files app"],
        ["run this in a new terminal: ls ~", "List my files in the Files app"],
        ["open a bash shell and list files", "List my files in the Files app"],
        ["Use the terminal, not the console, to list my files", "List my files in the Files app"],
        ["run it in the terminal and don't use the shell history", "List my files in the Files app"],
      ]) {
        await host.ask(words, mail);
        expect(await tool("start_task")({ goal }), words).toMatch(REFUSED);
      }
      await host.stop();
    });
  });

  it("Stop drops the requests waiting behind the turn; a message the user didn't send takes no request's context; a restart starts clean", async () => {
    const { host, specs, session, tool } = await withTasks();
    sim.holdTurns = true;
    await host.ask("archive these mails", mail);
    session.nextTurn();
    await host.ask("delete the Downloads folder", terminal);
    await host.abortAll();
    expect(session.waiting).toEqual([]);
    // Asked again after Stop (the same words, elsewhere): this request's context, not the dropped one's.
    await host.ask("delete the Downloads folder", { target: { pid: 3, title: "Files" }, text: "<screen>Files</screen>" });
    session.nextTurn();
    await tool("start_task")({ goal: "delete the Downloads folder" });
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0]).toMatchObject({ userWords: "delete the Downloads folder", target: { title: "Files" }, screen: "<screen>Files</screen>" });
    // A request waits; a turn starts that none of the user's requests began (nothing Ember sent): it carries none of their words.
    await host.ask("rename it to Old", mail);
    session.emit("user.message", { content: "<system_notification>Background work finished.</system_notification>" });
    await tool("start_task")({ goal: "empty the trash" });
    await vi.waitFor(() => expect(specs).toHaveLength(2));
    expect(specs[1].userWords).toBeUndefined();
    expect(specs[1].target).toEqual({});
    // The waiting request still gets its own turn's context. (The two tasks so far stop: two run at a time.)
    for (const t of host.tasks!.list()) host.tasks!.cancel(t.id);
    session.nextTurn();
    await tool("start_task")({ goal: "rename the Downloads folder to Old" });
    await vi.waitFor(() => expect(specs).toHaveLength(3));
    expect(specs[2]).toMatchObject({ userWords: "rename it to Old", target: { title: "Mail" } });
    // However many wait, only so many are kept; a restart drops them all, and the turn that ran.
    for (let i = 0; i < 30; i++) await host.ask(`question ${i}`);
    expect((host as any).queued.length).toBeLessThanOrEqual(20);
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    expect((host as any).queued).toEqual([]);
    expect((host as any).turn).toBeNull();
    await host.stop();
  });

  it("a task started by the user's answer to Ember's question carries the request it answers too; a request of its own doesn't (W10-2)", async () => {
    const { host, specs, session, tool } = await withTasks();
    const say = (text: string) => { session.emit("assistant.message_delta", { deltaContent: text }); session.emit("assistant.message", { content: text }); session.emit("session.idle", {}); };
    await host.ask("delete the old drafts in Mail", mail);
    say("Which account: work or home?");
    await host.ask("yes please, the work one", mail);
    await tool("start_task")({ goal: "delete the old drafts in the work account" });
    await vi.waitFor(() => expect(specs).toHaveLength(1));
    expect(specs[0].userWords).toBe("delete the old drafts in Mail.\nyes please, the work one");
    // A few words that only answer, with no question before them ("Ana Lopez", "both of them").
    await host.ask("send the report to Ana", mail);
    say("I found two people called Ana.");
    await host.ask("Ana Lopez", mail);
    await tool("start_task")({ goal: "send the report to Ana Lopez" });
    await vi.waitFor(() => expect(specs).toHaveLength(2));
    expect(specs[1].userWords).toBe("send the report to Ana.\nAna Lopez");
    for (const t of host.tasks!.list()) host.tasks!.cancel(t.id);
    // A request of its own after a question, or one that names an action (and anything risky), carries only its own words.
    await host.ask("delete the old drafts in Mail", mail);
    say("Anything else?");
    await host.ask("yes, empty the trash too", mail);
    await tool("start_task")({ goal: "empty the trash" });
    await vi.waitFor(() => expect(specs).toHaveLength(3));
    expect(specs[2].userWords).toBe("yes, empty the trash too");
    await host.ask("archive the newsletters", mail);
    say("Done.");
    await host.ask("Rename it", mail);
    await tool("start_task")({ goal: "rename the folder" });
    await vi.waitFor(() => expect(specs).toHaveLength(4));
    expect(specs[3].userWords).toBe("Rename it");
    await host.stop();
  });

  describe("an answer or a yes to Ember's question carries that question as agreed to (review round 11, AC11-1)", () => {
    async function talk() {
      const made = await withTasks();
      const { host, specs, session, tool } = made;
      const say = (text: string) => { session.emit("assistant.message_delta", { deltaContent: text }); session.emit("assistant.message", { content: text }); session.emit("session.idle", {}); };
      /** The spec of the task started now; the tasks so far stop (two run at a time). */
      const started = async (goal: string) => {
        const n = specs.length;
        await tool("start_task")({ goal });
        await vi.waitFor(() => expect(specs).toHaveLength(n + 1));
        for (const t of host.tasks!.list()) host.tasks!.cancel(t.id);
        return specs[n];
      };
      /** Asks these in turn, Ember answering each (but the last) with the line after it. */
      const convo = async (...lines: string[]) => {
        for (let i = 0; i < lines.length; i += 2) {
          await host.ask(lines[i], mail);
          if (i + 1 < lines.length) say(lines[i + 1]);
        }
      };
      return { ...made, say, started, convo };
    }
    const SHALL_I = "I can delete the 12 installers there older than a month. Shall I?";
    const engine = new PolicyEngine({ neverLook: () => [], grants: () => ({ nautilus: "act", thunderbird: "act" }) });
    const judge = (spec: { userWords?: string; agreed?: Agreement[] }, app: string, name: string) =>
      engine.decide({ taskId: "x", kind: "click", app, window: "W", element: { role: "push button", name }, goal: spec.userWords, agreed: spec.agreed });

    it("a yes to Ember's offer: the step it offered is asked, saying so, not flagged as unasked", async () => {
      const { host, convo, started } = await talk();
      await convo("Clean up my Downloads folder", SHALL_I, "sure, go ahead");
      const spec = await started("delete the old installers in Downloads");
      expect(spec).toMatchObject({ userWords: "Clean up my Downloads folder.\nsure, go ahead", agreed: [{ asked: SHALL_I, answer: "sure, go ahead" }] });
      const d = judge(spec, "nautilus", "Delete");
      expect(d).toMatchObject({ verdict: "confirm", agreed: true });
      expect(d.aligned).toBeUndefined();
      expect(d.prompt).toMatch(/You said “sure, go ahead” when I asked about this\.$/);
      // Without the question it was flagged (W10-2 carried only the user's own words).
      expect(judge({ userWords: spec.userWords }, "nautilus", "Delete").aligned).toBe(false);
      await host.stop();
    });

    it("a task's result asking: the reply right after it agrees to it, not one later; a question with a sentence after it is one", async () => {
      const { host, results, convo, started } = await talk();
      results.set("draft the lunch email to Ana", "Drafted the email to Ana about lunch. Want me to send it?");
      await convo("Write an email to Ana about lunch");
      await started("draft the lunch email to Ana");
      await vi.waitFor(() => expect(host.getTranscript().at(-1)?.who).toBe("task"));
      await convo("yes");
      const yes = await started("send the lunch email to Ana");
      expect(yes).toMatchObject({ userWords: "yes", agreed: [{ asked: "Drafted the email to Ana about lunch. Want me to send it?", answer: "yes" }] });
      expect(judge(yes, "thunderbird", "Send")).toMatchObject({ verdict: "confirm", agreed: true });
      // The title the conversation wrote isn't what the task asked.
      expect(yes.agreed![0].asked).not.toMatch(/lunch email to Ana:/);
      results.set("draft the memo", "Drafted the memo. Want me to send it?");
      await convo("Draft the memo");
      await started("draft the memo");
      await vi.waitFor(() => expect(host.getTranscript().at(-1)?.who).toBe("task"));
      await convo("is it raining?", "No, it's sunny. Anything else?", "ok");
      const later = await started("send the memo");
      expect(later.agreed).toEqual([{ asked: "No, it's sunny. Anything else?", answer: "ok" }]);
      expect(judge(later, "thunderbird", "Send").aligned).toBe(false);
      // (c) A question followed by a sentence still asks: the request it answers comes with the answer.
      await convo("Email the report to the team", "Sure. Which report: the Q3 summary or the forecast? I can also attach both.", "the forecast");
      const report = await started("email the forecast to the team");
      expect(report.userWords).toBe("Email the report to the team.\nthe forecast");
      expect(judge(report, "thunderbird", "Send").aligned).toBeUndefined();
      await host.stop();
    });

    it("a no, something else, thanks or a new request carries none of Ember's words; nor a question over ten minutes old", async () => {
      const { host, convo, started } = await talk();
      for (const reply of ["no", "No thanks", "not now", "something else", "Open Firefox", "later", "delete my mail instead"]) {
        await convo("Clean up my Downloads folder", SHALL_I, reply);
        const spec = await started("delete the old installers");
        expect(spec.agreed, reply).toBeUndefined();
        expect(judge(spec, "nautilus", "Delete").agreed, reply).toBeUndefined();
      }
      // Ember's words that ask nothing.
      await convo("Clean up my Downloads folder", "I can delete the 12 installers there older than a month.", "ok");
      expect((await started("delete the old installers")).agreed).toBeUndefined();
      // A question answered over ten minutes later.
      await convo("Clean up my Downloads folder", SHALL_I);
      const log = (host as any).transcript as { t: string }[];
      log.at(-1)!.t = new Date(Date.now() - 11 * 60_000).toISOString();
      await convo("yes");
      expect((await started("delete the old installers")).agreed).toBeUndefined();
      await host.stop();
    });

    it("(a) a change of plan takes the request the answer answers, and the question agreed to", async () => {
      const { host, steered, steeredAgreed, convo, tool, specs } = await talk();
      await convo("Tidy my inbox");
      await tool("start_task")({ goal: "tidy the inbox" });
      await vi.waitFor(() => expect(specs).toHaveLength(1));
      await convo("Also delete the old drafts", "Which account, work or home?", "work");
      await tool("steer_task")({ id: host.tasks!.list()[0].id, instruction: "also delete the old drafts in the work account" });
      expect(steered.at(-1)!.slice(0, 2)).toEqual(["also delete the old drafts in the work account", "Also delete the old drafts.\nwork"]);
      expect(steeredAgreed.at(-1)).toEqual([{ asked: "Which account, work or home?", answer: "work" }]);
      await convo("Should I tidy the archive too?", "I can empty the archive folder too. Want me to?", "yes please");
      await tool("steer_task")({ id: host.tasks!.list()[0].id, instruction: "empty the archive folder too" });
      expect(steeredAgreed.at(-1)).toEqual([{ asked: "I can empty the archive folder too. Want me to?", answer: "yes please" }]);
      await host.stop();
    });
  });
});

describe("review round 6: a task's bubbles say whose they are", () => {
  it("its work and its question name the task (the corner card pairs them with its row and Stop), titled as its card is", async () => {
    const bubbles: BubbleState[] = [];
    const confirmer = new Confirmer(p => { if (p.bubble) bubbles.push(p.bubble); }, { armMs: 0, gapMs: 0 });
    const policy = { decide: () => ({ verdict: "confirm", tier: "confirm", reason: "test", prompt: "Turn on Night Light?", needsGrant: false, remember: false }) };
    const { host } = makeHost({ hands: { ...hands(), confirmer, policy } as never });
    await host.start(TOKEN, "stored");
    await host.ask("turn on night light");
    const talk = conductorSession();
    await talk.config.tools.find((t: any) => t.name === "start_task").handler({ goal: "turn on  the\nnight light" });
    const taskSession = () => sim.sessions.find(s => s.sessionId.startsWith("ember-task-"));
    await vi.waitFor(() => expect(taskSession()?.sent).toHaveLength(1));
    const card = host.tasks!.list()[0];
    expect(card.title).toBe("turn on the night light");
    taskSession().emit("assistant.reasoning_delta", { deltaContent: "Looking for the setting." });
    const presenter = (host as any).taskPresenters.get(card.id) as Presenter;
    expect(presenter.bubble).toMatchObject({ visible: true, title: card.title, task: card.id });
    const asked = taskSession().config.tools.find((t: any) => t.name === "change_setting").handler({ setting: "night_light", value: "on" });
    await vi.waitFor(() => expect(bubbles.at(-1)?.title).toBe("May I?"));
    expect(bubbles.at(-1)!.task).toBe(card.id);
    confirmer.answerKey("deny");
    expect(bubbles.at(-1)).toMatchObject({ thought: "Okay, I won't.", task: card.id });
    await asked;
    await host.stop();
  });
});

describe("review round 7: a request the runtime takes but never begins", () => {
  const NOT_ANSWERING = "Copilot isn't answering. I'm reconnecting; ask me again in a moment.";
  const TASK_NOT_ANSWERING = "Copilot isn't answering, so I stopped this task. You can ask me again in a moment.";
  /** Quits with tasks still running (their turns wind down on timers). */
  const stopAll = async (host: AgentHost) => { const done = host.stop(); await vi.advanceTimersByTimeAsync(15_000); await done; };

  it("no turn begins though the health check passes: Ember says so, reconnects, drops the request and resumes the conversation", async () => {
    vi.useFakeTimers();
    const { host, screen, statuses } = makeHost({ healthMs: 5000, inotifyUsedUp: () => false });
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    const first = conductorSession();
    sim.stall = () => true;
    await host.ask("what time is it?", { target: { pid: 1, title: "Mail" }, text: "<screen>Mail</screen>" });
    expect((host as any).queued).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(screen().bubble).toMatchObject({ mood: "thinking", title: "Thinking…" });
    expect(sim.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: NOT_ANSWERING });
    expect(statuses.map(s => s.detail)).toContain("Copilot isn't answering. Reconnecting…");
    // The stuck request never runs: it is no request's context any more.
    expect((host as any).queued).toEqual([]);
    sim.stall = () => false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(sim.clients).toHaveLength(2);
    expect(first.disconnected).toBe(true);
    expect(host.getStatus().phase).toBe("ready");
    expect(sim.resumed).toEqual([first.sessionId]);
    // The error stays to be read; asking again works on the new connection.
    expect(screen().bubble).toMatchObject({ mood: "error", thought: NOT_ANSWERING });
    await host.ask("what time is it?");
    expect(conductorSession()).not.toBe(first);
    expect(conductorSession().sent.at(-1)).toMatch(/what time is it\?$/);
    expect((host as any).turn).toMatchObject({ words: "what time is it?", target: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sim.clients).toHaveLength(2);
    await host.stop();
  });

  it("a slow model isn't cut: its turn began at 19 s and its first word comes a minute later", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost();
    await host.start(TOKEN, "stored");
    const talk = conductorSession();
    sim.stall = () => true;
    await host.ask("summarise my week");
    await vi.advanceTimersByTimeAsync(19_000);
    talk.begin("summarise my week");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen().bubble).toMatchObject({ mood: "thinking" });
    talk.emit("assistant.message_delta", { deltaContent: "A quiet week." });
    talk.emit("assistant.message", { content: "A quiet week." });
    talk.emit("assistant.turn_end", {});
    talk.emit("session.idle", {});
    expect(screen().bubble).toMatchObject({ thought: "A quiet week." });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sim.clients).toHaveLength(1);
    expect(host.getStatus().phase).toBe("ready");
    await host.stop();
  });

  it("a request asked during a long turn waits for it; one the runtime then never begins is noticed", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost({ inotifyUsedUp: () => false });
    await host.start(TOKEN, "stored");
    const talk = conductorSession();
    await host.ask("read my screen");
    sim.holdTurns = true;
    await host.ask("and what time is it?");
    // The first turn runs long (a slow tool, a slow model): the one waiting behind it isn't owed a turn yet.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sim.clients).toHaveLength(1);
    talk.emit("assistant.turn_end", {});
    talk.nextTurn();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sim.clients).toHaveLength(1);
    // A third waits behind the second; the second ends and the runtime never begins the third.
    await host.ask("thanks");
    talk.emit("assistant.turn_end", {});
    talk.emit("session.idle", {});
    await vi.advanceTimersByTimeAsync(19_000);
    expect(sim.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: NOT_ANSWERING });
    expect(sim.clients).toHaveLength(2);
    await host.stop();
  });

  it("out of inotify instances (the runtime can't begin a turn then): Ember says so, in the bubble and in settings", async () => {
    vi.useFakeTimers();
    const { host, screen, statuses } = makeHost({ inotifyUsedUp: () => true });
    await host.start(TOKEN, "stored");
    sim.stall = () => true;
    await host.ask("what time is it?");
    await vi.advanceTimersByTimeAsync(20_500);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: "Copilot can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again." });
    expect(statuses.map(x => x.detail)).toContainEqual(expect.stringMatching(/fs\.inotify\.max_user_instances\) is used up/));
    await vi.advanceTimersByTimeAsync(3000);
    expect(sim.clients).toHaveLength(2);
    await host.stop();
  });

  // Linux only: inotify and /proc are Linux's (and the fake /proc needs process.getuid, which Windows lacks).
  it.skipIf(process.platform !== "linux")("this user's inotify instances are counted in /proc against the system's limit", async () => {
    const { inotifyUsedUp } = await import("../../app/main/agent/host");
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), "ember-proc-"));
    fs.mkdirSync(path.join(proc, "sys/fs/inotify"), { recursive: true });
    fs.writeFileSync(path.join(proc, "sys/fs/inotify/max_user_instances"), "3\n");
    const fds = (pid: string, ...links: string[]) => { fs.mkdirSync(path.join(proc, pid, "fd"), { recursive: true }); links.forEach((l, i) => fs.symlinkSync(l, path.join(proc, pid, "fd", String(i)))); };
    fds("10", "anon_inode:inotify", "/dev/null", "socket:[1]");
    fds("11", "anon_inode:inotify");
    fds("self");
    const uid = process.getuid!();
    expect(inotifyUsedUp(proc, uid)).toBe(false);
    fds("12", "anon_inode:[eventfd]", "anon_inode:inotify");
    expect(inotifyUsedUp(proc, uid)).toBe(true);
    // Another user's processes don't count against this user's limit.
    expect(inotifyUsedUp(proc, uid + 1)).toBe(false);
    // No limit to read: nothing is blamed on it.
    fs.rmSync(path.join(proc, "sys"), { recursive: true });
    expect(inotifyUsedUp(proc, uid)).toBe(false);
    fs.rmSync(proc, { recursive: true, force: true });
  });

  it("Stop drops the request waiting for its turn: nothing is owed, nothing reconnects", async () => {
    vi.useFakeTimers();
    const { host, statuses } = makeHost();
    await host.start(TOKEN, "stored");
    sim.stall = () => true;
    await host.ask("what time is it?");
    await vi.advanceTimersByTimeAsync(5000);
    await host.abortAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sim.clients).toHaveLength(1);
    expect(statuses.map(s => s.detail)).not.toContain("Copilot isn't answering. Reconnecting…");
    await host.stop();
  });

  it("a task whose turn never begins fails plainly and lets go of its session; the other task and the conversation go on", async () => {
    vi.useFakeTimers();
    sim.stall = (s, prompt) => s.sessionId.startsWith("ember-task-") && prompt.includes("the stuck one");
    const { host } = makeHost({ hands: hands(), inotifyUsedUp: () => false });
    await host.start(TOKEN, "stored");
    const stuck = host.tasks!.start("the stuck one");
    const fine = host.tasks!.start("the fine one");
    await vi.advanceTimersByTimeAsync(19_000);
    expect(host.tasks!.get(stuck.id)?.status).toBe("running");
    // 20 s, then the aborted turn's grace.
    await vi.advanceTimersByTimeAsync(4000);
    expect(host.tasks!.get(stuck.id)).toMatchObject({ status: "failed", result: { success: false, summary: TASK_NOT_ANSWERING } });
    const session = sim.sessions.find(s => s.sessionId === `ember-task-${stuck.id}`);
    expect(session.aborted).toBeGreaterThan(0);
    expect(session.disconnected).toBe(true);
    expect(host.getTranscript().at(-1)?.text).toBe(`the stuck one: failed. ${TASK_NOT_ANSWERING}`);
    expect(host.tasks!.get(fine.id)?.status).toBe("running");
    expect(sim.clients).toHaveLength(1);
    expect(host.getStatus().phase).toBe("ready");
    await stopAll(host);
  });

  it("a task whose turn begins late (just inside the limit, which the host sets) keeps going", async () => {
    vi.useFakeTimers();
    sim.stall = s => s.sessionId.startsWith("ember-task-");
    const { host } = makeHost({ hands: hands(), turnStartMs: 5000 });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(4500);
    const session = sim.sessions.find(s => s.sessionId === `ember-task-${t.id}`);
    session.begin("Task: tidy my desktop");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.tasks!.get(t.id)?.status).toBe("running");
    expect(session.aborted).toBe(0);
    await stopAll(host);
  });
});

describe("review round 8: a turn that began and then hears nothing from Copilot", () => {
  const STILL = "Still waiting for Copilot…";
  const NO_ANSWER = "Copilot didn't answer. Ask me again in a moment.";
  const NO_WATCHERS = "Copilot can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again.";
  const TASK_NO_ANSWER = "Copilot didn't answer, so I stopped this task. You can ask me again in a moment.";
  const TASK_NO_WATCHERS = "Copilot can't work right now: this computer has run out of file watchers, so I stopped this task. Close a few apps, then ask me again.";
  const stopAll = async (host: AgentHost) => { const done = host.stop(); await vi.advanceTimersByTimeAsync(15_000); await done; };

  it("a model request that never answers: still waiting at 30 s, then the turn is ended and Ember says so; a runtime the abort doesn't end it on is reconnected, and what waited behind it goes", async () => {
    vi.useFakeTimers();
    const { host, screen, statuses } = makeHost({ healthMs: 5000 });
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    const first = conductorSession();
    // Its turn begins (user.message, assistant.turn_start), and then the model never answers.
    await host.ask("what time is it in Tokyo");
    sim.holdTurns = true;
    await host.ask("are you there?");
    expect((host as any).queued).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(screen().bubble).toMatchObject({ mood: "thinking", title: "Thinking…", thought: "“are you there?”" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(screen().bubble).toMatchObject({ mood: "thinking", title: STILL, thought: "“are you there?”", streaming: true });
    // Heard from again: the note goes, and the waits start over.
    first.emit("assistant.reasoning_delta", { deltaContent: "Tokyo is" });
    expect(screen().bubble).toMatchObject({ mood: "thinking", title: "Thinking…" });
    await vi.advanceTimersByTimeAsync(179_000);
    expect(screen().bubble).toMatchObject({ title: STILL });
    expect(sim.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: NO_ANSWER });
    expect(first.aborted).toBeGreaterThan(0);
    expect((host as any).queued).toEqual([]);
    // The abort didn't end the turn (no session.idle): after a short grace, Copilot is reconnected.
    await vi.advanceTimersByTimeAsync(8000);
    expect(sim.clients).toHaveLength(1);
    expect(host.getStatus().phase).toBe("ready");
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses.map(s => s.detail)).toContain("Copilot didn't answer in time. Reconnecting…");
    sim.holdTurns = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(sim.clients).toHaveLength(2);
    expect(first.disconnected).toBe(true);
    expect(host.getStatus().phase).toBe("ready");
    expect(sim.resumed).toEqual([first.sessionId]);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: NO_ANSWER });
    await host.ask("what time is it in Tokyo");
    expect(conductorSession()).not.toBe(first);
    expect(conductorSession().sent.at(-1)).toMatch(/what time is it in Tokyo$/);
    await host.stop();
  });

  it("a long look at the screen (a tool under way) isn't silence, and neither is a slow answer that streams", async () => {
    vi.useFakeTimers();
    const { host, patches } = makeHost();
    await host.start(TOKEN, "stored");
    const talk = conductorSession();
    await host.ask("what's on my screen");
    talk.emit("tool.execution_start", { toolCallId: "c1", toolName: "describe_screen" });
    await vi.advanceTimersByTimeAsync(400_000);
    talk.emit("tool.execution_complete", { toolCallId: "c1", success: true });
    for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(25_000); talk.emit("assistant.reasoning_delta", { deltaContent: "hmm " }); }
    talk.emit("assistant.message_delta", { deltaContent: "A spreadsheet." });
    talk.emit("assistant.message", { content: "A spreadsheet." });
    talk.emit("assistant.turn_end", {});
    talk.emit("session.idle", {});
    await vi.advanceTimersByTimeAsync(600_000);
    expect(patches.some(p => p.bubble?.title === STILL)).toBe(false);
    expect(talk.aborted).toBe(0);
    expect(sim.clients).toHaveLength(1);
    expect(host.getStatus().phase).toBe("ready");
    await host.stop();
  });

  it("Stop while it's still waiting stops it as always: nothing is given up on or reconnected later", async () => {
    vi.useFakeTimers();
    const { host, screen, statuses } = makeHost();
    await host.start(TOKEN, "stored");
    await host.ask("what time is it in Tokyo");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(screen().bubble).toMatchObject({ title: STILL });
    await host.abortAll();
    expect(conductorSession().aborted).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sim.clients).toHaveLength(1);
    expect(statuses.map(s => s.detail)).not.toContain("Copilot didn't answer in time. Reconnecting…");
    await host.stop();
  });

  it("turns that never begin with the file watchers used up aren't crashes: Ember keeps reconnecting, and once they're free the next ask works (AC8-2)", async () => {
    vi.useFakeTimers();
    let full = true;
    const { host, screen, statuses } = makeHost({ inotifyUsedUp: () => full });
    await host.start(TOKEN, "stored");
    sim.stall = () => true;
    for (let i = 0; i < 7; i++) {
      await host.ask(`what time is it? (${i})`);
      await vi.advanceTimersByTimeAsync(20_500);
      expect(screen().bubble).toMatchObject({ mood: "error", thought: NO_WATCHERS });
      await vi.advanceTimersByTimeAsync(3000);
      expect(host.getStatus().phase).toBe("ready");
    }
    expect(sim.clients).toHaveLength(8);
    expect(statuses.map(s => s.detail)).not.toContain("Copilot keeps stopping. Press Check again to retry, or restart Ember.");
    full = false;
    sim.stall = () => false;
    await host.ask("what time is it?");
    expect(conductorSession().sent.at(-1)).toMatch(/what time is it\?$/);
    expect(screen().bubble).toMatchObject({ mood: "thinking" });
    await host.stop();
  });

  it("a turn nobody asked for that goes silent and doesn't end when aborted (it could come back on its own after each reconnect) still counts towards giving up", async () => {
    vi.useFakeTimers();
    const { host, statuses } = makeHost({ turnSilentMs: 5000 });
    await host.start(TOKEN, "stored");
    for (let i = 0; i < 6; i++) {
      conductorSession().begin("(nothing the user asked)");
      await vi.advanceTimersByTimeAsync(5500);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(sim.clients).toHaveLength(6);
    expect(statuses.at(-1)?.detail).toBe("Copilot keeps stopping. Press Check again to retry, or restart Ember.");
    await host.stop();
  });

  it("silent turns of the user's own requests that don't end when aborted aren't crashes either (AC8-2)", async () => {
    vi.useFakeTimers();
    const { host, screen, statuses } = makeHost({ turnSilentMs: 5000 });
    await host.start(TOKEN, "stored");
    for (let i = 0; i < 7; i++) {
      await host.ask(`what time is it? (${i})`);
      await vi.advanceTimersByTimeAsync(5500);
      expect(screen().bubble).toMatchObject({ mood: "error", thought: NO_ANSWER });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(host.getStatus().phase).toBe("ready");
    }
    expect(sim.clients).toHaveLength(8);
    expect(statuses.map(s => s.detail)).not.toContain("Copilot keeps stopping. Press Check again to retry, or restart Ember.");
    await host.stop();
  });

  it("the abort ends the silent turn (as the runtime's does): Ember says Copilot didn't answer, nothing reconnects, and the conversation goes on (AC9-2)", async () => {
    vi.useFakeTimers();
    sim.abortEnds = true;
    const { host, screen, statuses } = makeHost();
    await host.start(TOKEN, "stored");
    const talk = conductorSession();
    await host.ask("what time is it in Tokyo");
    sim.holdTurns = true;
    await host.ask("are you there?");
    await vi.advanceTimersByTimeAsync(180_500);
    expect(talk.aborted).toBe(1);
    // The aborted turn's own end ("Stopped") doesn't replace what Ember said; what waited behind it went with it.
    expect(screen().bubble).toMatchObject({ mood: "error", thought: NO_ANSWER });
    expect((host as any).queued).toEqual([]);
    expect(talk.waiting).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sim.clients).toHaveLength(1);
    expect(host.getStatus().phase).toBe("ready");
    expect(statuses.map(s => s.phase)).not.toContain("error");
    // The user asks again: same session, and its turn shows as always.
    sim.holdTurns = false;
    await host.ask("what time is it in Tokyo?");
    expect(conductorSession()).toBe(talk);
    expect(talk.sent.at(-1)).toMatch(/what time is it in Tokyo\?$/);
    talk.emit("assistant.message_delta", { deltaContent: "It's noon." });
    talk.emit("assistant.message", { content: "It's noon." });
    talk.emit("assistant.turn_end", {});
    talk.emit("session.idle", {});
    expect(screen().bubble).toMatchObject({ mood: "idle", thought: "It's noon.", streaming: false });
    // Its turns are watched again: the next one that goes silent is noticed too.
    await host.ask("and in Paris?");
    await vi.advanceTimersByTimeAsync(180_500);
    expect(talk.aborted).toBe(2);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: NO_ANSWER });
    expect(sim.clients).toHaveLength(1);
    await host.stop();
  });

  it("a question asked while the silent turn is being ended waits for it, then goes on the same session, or on the new one if Copilot is reconnected", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost();
    await host.start(TOKEN, "stored");
    const talk = conductorSession();
    await host.ask("what time is it in Tokyo");
    await vi.advanceTimersByTimeAsync(180_500);
    expect(talk.aborted).toBe(1);
    // The runtime takes a moment to end it.
    const asked = host.ask("are you there?");
    expect(screen().bubble).toMatchObject({ mood: "thinking", thought: "“are you there?”" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(talk.sent.at(-1)).toMatch(/what time is it in Tokyo$/);
    talk.emit("abort", {});
    talk.emit("session.idle", { aborted: true });
    await asked;
    expect(talk.sent.at(-1)).toMatch(/are you there\?$/);
    expect(screen().bubble).toMatchObject({ mood: "thinking", thought: "“are you there?”" });
    expect(sim.clients).toHaveLength(1);
    // It goes silent too, and this time the runtime doesn't end it: the question asked meanwhile goes to the new connection.
    await vi.advanceTimersByTimeAsync(180_500);
    expect(talk.aborted).toBe(2);
    const later = host.ask("hello?");
    await vi.advanceTimersByTimeAsync(13_000);
    await later;
    expect(sim.clients).toHaveLength(2);
    expect(talk.sent.at(-1)).toMatch(/are you there\?$/);
    expect(conductorSession()).not.toBe(talk);
    expect(conductorSession().sent.at(-1)).toMatch(/hello\?$/);
    await host.stop();
  });

  it("a busy task survives a silent conversation turn, and the next ask is answered on the same runtime (AC9-2, PR9-1)", async () => {
    vi.useFakeTimers();
    sim.abortEnds = true;
    const finished: { status: string; text: string }[] = [];
    const { host, screen, statuses } = makeHost({ hands: hands(), onTaskFinished: t => finished.push(t) });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("tidy the desktop slowly");
    await vi.advanceTimersByTimeAsync(100);
    const work = sim.sessions.find(s => s.sessionId === `ember-task-${t.id}`);
    const talk = conductorSession();
    await host.ask("what time is it in Tokyo");
    // The task's model answers every 3 s; the conversation's never does.
    for (let i = 0; i < 70; i++) { await vi.advanceTimersByTimeAsync(3000); work.emit("tool.execution_start", { toolCallId: `c${i}`, toolName: "report_progress" }); work.emit("tool.execution_complete", { toolCallId: `c${i}`, success: true }); }
    expect(talk.aborted).toBe(1);
    expect(work.aborted).toBe(0);
    expect(host.tasks!.get(t.id)).toMatchObject({ status: "running" });
    expect(finished).toEqual([]);
    expect(sim.clients).toHaveLength(1);
    expect(statuses.map(s => s.phase)).not.toContain("error");
    // The next ask goes out on the same runtime and session, hears of no task that failed, and is answered.
    await host.ask("how's the tidying going?");
    expect(conductorSession()).toBe(talk);
    expect(talk.sent.at(-1)).toMatch(/how's the tidying going\?$/);
    expect(talk.sent.at(-1)).not.toContain("task_results");
    talk.emit("assistant.message_delta", { deltaContent: "Still tidying." });
    talk.emit("assistant.message", { content: "Still tidying." });
    talk.emit("assistant.turn_end", {});
    talk.emit("session.idle", {});
    expect(screen().bubble).toMatchObject({ mood: "idle", thought: "Still tidying.", streaming: false });
    expect(host.tasks!.get(t.id)?.status).toBe("running");
    expect(sim.clients).toHaveLength(1);
    await stopAll(host);
  });

  it("a runtime that doesn't end the silent turn while a task is at work: the task isn't cut off, and Copilot is reconnected once it's done (AC9-2)", async () => {
    vi.useFakeTimers();
    const finished: { status: string; text: string }[] = [];
    const { host, screen } = makeHost({ hands: hands(), onTaskFinished: t => finished.push(t) });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(100);
    const work = sim.sessions.find(s => s.sessionId === `ember-task-${t.id}`);
    await host.ask("what time is it in Tokyo");
    // The conversation's turn goes silent and the abort doesn't end it; the task's model answers every few seconds.
    for (let i = 0; i < 60; i++) { await vi.advanceTimersByTimeAsync(5000); work.emit("assistant.reasoning_delta", { deltaContent: `step ${i} ` }); }
    expect(sim.clients).toHaveLength(1);
    expect(host.tasks!.get(t.id)).toMatchObject({ status: "running" });
    // (Settings offers no sign-in then, and says reconnecting now stops the tasks: UI10-2.)
    expect(host.getStatus()).toMatchObject({ phase: "error", detail: "Copilot isn't answering. Reconnecting when the tasks running are done…", waitingForTasks: true });
    // Asked meanwhile, Ember says so (the conversation can't answer now).
    await host.ask("are you there?");
    // (Copilot is reachable: the title names what is wrong, not "I can't reach Copilot".)
    expect(screen().bubble).toMatchObject({ title: "Copilot isn't answering", thought: "Copilot isn't answering. Reconnecting when the tasks running are done…" });
    expect(conductorSession().sent.at(-1)).toMatch(/Tokyo$/);
    // The task ends (here the user stops it): Copilot is reconnected now, and the next ask goes out.
    host.tasks!.cancel(t.id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(sim.clients).toHaveLength(2);
    expect(host.getStatus()).toMatchObject({ phase: "ready", waitingForTasks: false });
    // Its notice saying it can't reach Copilot goes with it, not the rest of its 12 s (MN11-2).
    expect(screen().bubble?.title).not.toBe("Copilot isn't answering");
    await host.ask("how's the tidying going?");
    expect(conductorSession().sent.at(-1)).toMatch(/how's the tidying going\?$/);
    expect(conductorSession().sent.at(-1)).not.toContain(CUT_OFF);
    await stopAll(host);
  });

  it("a conversation turn that never begins while a task is at work: the same, and a task that goes silent too ends by its own watch, then Copilot is reconnected", async () => {
    vi.useFakeTimers();
    sim.stall = s => s.sessionId.startsWith("ember-conductor-");
    const finished: { status: string; text: string }[] = [];
    const { host, screen } = makeHost({ hands: hands(), onTaskFinished: t => finished.push(t), inotifyUsedUp: () => false });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(100);
    const work = sim.sessions.find(s => s.sessionId === `ember-task-${t.id}`);
    await host.ask("what time is it in Tokyo");
    work.emit("assistant.reasoning_delta", { deltaContent: "looking " });
    await vi.advanceTimersByTimeAsync(20_500);
    expect(screen().bubble).toMatchObject({ mood: "error", thought: "Copilot isn't answering. I'll reconnect when the tasks running are done; ask me again then." });
    expect(sim.clients).toHaveLength(1);
    expect(host.tasks!.get(t.id)?.status).toBe("running");
    // The task's model goes quiet as well: its own watch ends it, and then Copilot is reconnected.
    await vi.advanceTimersByTimeAsync(165_000);
    expect(finished).toEqual([expect.objectContaining({ status: "failed", text: `tidy my desktop: failed. ${TASK_NO_ANSWER}` })]);
    sim.stall = () => false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sim.clients).toHaveLength(2);
    expect(host.getStatus().phase).toBe("ready");
    await stopAll(host);
  });
  it("a task's turn that began and then hears nothing: its card says so at 30 s, and it fails plainly at the long limit; the rest goes on", async () => {
    vi.useFakeTimers();
    const { host, screen } = makeHost({ hands: hands() });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(host.tasks!.get(t.id)).toMatchObject({ status: "running", detail: STILL });
    // The task's bubble (the corner card's bold line without a compositor) says it too (UI9-2).
    expect(screen().bubble).toMatchObject({ title: STILL });
    const session = sim.sessions.find(s => s.sessionId === `ember-task-${t.id}`);
    session.emit("assistant.reasoning_delta", { deltaContent: "First, " });
    expect(host.tasks!.get(t.id)?.detail).toBe("Working…");
    expect(screen().bubble?.title).not.toBe(STILL);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(host.tasks!.get(t.id)?.status).toBe("running");
    // The long limit, then the aborted turn's grace.
    await vi.advanceTimersByTimeAsync(4000);
    expect(host.tasks!.get(t.id)).toMatchObject({ status: "failed", result: { success: false, summary: TASK_NO_ANSWER } });
    expect(session.aborted).toBeGreaterThan(0);
    expect(sim.clients).toHaveLength(1);
    expect(host.getStatus().phase).toBe("ready");
    await stopAll(host);
  });

  it("a task whose turn never begins with the file watchers used up names them (AC8-1)", async () => {
    vi.useFakeTimers();
    sim.stall = s => s.sessionId.startsWith("ember-task-");
    const { host } = makeHost({ hands: hands(), inotifyUsedUp: () => true });
    await host.start(TOKEN, "stored");
    const t = host.tasks!.start("tidy my desktop");
    await vi.advanceTimersByTimeAsync(23_000);
    expect(host.tasks!.get(t.id)).toMatchObject({ status: "failed", result: { success: false, summary: TASK_NO_WATCHERS } });
    expect(sim.clients).toHaveLength(1);
    expect(host.getStatus().phase).toBe("ready");
    await stopAll(host);
  });
});

describe("live retest: a guide is promised only where Ember can point", () => {
  const showMe = () => conductorSession().config.tools.find((t: any) => t.name === "show_me").handler({ goal: "change the font" }, {});
  const ctx = { target: { title: "notes.txt - Mousepad", pid: 7 }, text: "<context>…</context>" };

  it("a window Ember can't read: no guide starts, and the model is told to explain in words", async () => {
    const { host } = makeHost({ hands: { ...hands(), perception: { read: async () => { throw new Error("no accessibility"); } } } as never });
    await host.start(TOKEN, "stored");
    await host.ask("show me how to change the font", ctx);
    const said = await showMe();
    expect(said).toMatch(/^Ember can't guide here: Ember can't read that window/);
    expect(said).toMatch(/Don't tell the user to follow Ember's pointer/);
    expect(host.tasks!.list()).toEqual([]);
    await host.stop();
  });

  it("a window it can read: the guide starts", async () => {
    const window = { app: "mousepad", pid: 7, name: "notes.txt - Mousepad", role: "frame", active: true, bounds: null };
    const { host } = makeHost({ hands: { ...hands(), perception: { read: async () => ({ window, nodes: [], blocked: false, busy: false }) } } as never });
    await host.start(TOKEN, "stored");
    await host.ask("show me how to change the font", ctx);
    expect(await showMe()).toMatch(/^Guide .* started/);
    expect(host.tasks!.list()).toHaveLength(1);
    await host.stop();
  });

  it("Stop, or a restart, while the window is being read: the guide doesn't start after it (review: host-main)", async () => {
    const window = { app: "mousepad", pid: 7, name: "notes.txt - Mousepad", role: "frame", active: true, bounds: null };
    let open = () => {};
    const read = () => new Promise(r => { open = () => r({ window, nodes: [], blocked: false, busy: false }); });
    const { host } = makeHost({ hands: { ...hands(), perception: { read } } as never });
    await host.start(TOKEN, "stored");
    await host.ask("show me how to change the font", ctx);
    const stopped = showMe();
    await host.abortAll();
    open();
    expect(await stopped).toMatch(/stopped everything/);
    expect(host.tasks!.list()).toEqual([]);
    // Reconnected (or signed out) meanwhile: the old connection's manager starts nothing either.
    await host.ask("show me how to change the font", ctx);
    const old = host.tasks!;
    const restarted = showMe();
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    open();
    expect(await restarted).toMatch(/stopped everything/);
    expect(old.list()).toEqual([]);
    expect(host.tasks!.list()).toEqual([]);
    await host.stop();
  });
});

describe("live retest: 'Read all' stays open until it's closed", () => {
  it("a pinned claim isn't given back after 30 s", async () => {
    vi.useFakeTimers();
    const { host } = makeHost();
    await host.start(TOKEN, "stored");
    host.claimBubble({ pin: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect((host as any).owner.holder).toBe((host as any).mainBubble);
    host.releaseBubble(null);
    expect((host as any).owner.holder).not.toBe((host as any).mainBubble);
    // An ordinary claim still ends by itself.
    host.claimBubble();
    await vi.advanceTimersByTimeAsync(31_000);
    expect((host as any).owner.holder).not.toBe((host as any).mainBubble);
    const done = host.stop(); await vi.advanceTimersByTimeAsync(15_000); await done;
  });

  describe("the expanded answer gone without its Close button ends the pin (review: host-main)", () => {
    const long = "A long answer. ".repeat(60);
    /** An answer read in full ("Read all", as main's expandAnswer does), with a guide at work behind it. */
    function expanded(extra: Partial<HostOptions> = {}) {
      vi.useFakeTimers();
      const made = makeHost(extra);
      const { host } = made;
      const p = (host as unknown as { presenter: Presenter }).presenter;
      p.userPrompt("explain");
      p.event({ type: "assistant.message_delta", data: { deltaContent: long } });
      p.event({ type: "assistant.message", data: { content: long } });
      p.event({ type: "session.idle", data: {} });
      const guide = (host as unknown as { taskPresenter(id: string, goal: string): Presenter }).taskPresenter("t1", "save my document");
      guide.taskStarted();
      host.claimBubble({ pin: true });
      (host as unknown as { o: HostOptions }).o.setState({ talking: false, bubble: expandedBubble(made.screen().bubble!, long) });
      return { ...made, guide };
    }

    it("“Open in settings” (main clears it and gives the pin back): the guide's step and outcome show", async () => {
      const { host, screen, guide } = expanded();
      (host as unknown as { o: HostOptions }).o.setState({ emotion: "neutral", talking: false, bubble: IDLE_BUBBLE });
      host.releasePin(screen().bubble!);
      expect((host as any).owner.holder).not.toBe((host as any).mainBubble);
      await vi.advanceTimersByTimeAsync(60_000);
      guide.guide("Click Save in the toolbar.", "Step 1");
      expect(screen().bubble).toMatchObject({ visible: true, thought: "Click Save in the toolbar." });
      // Only a pinned hold: “Listening…” keeps its own time.
      host.claimBubble();
      host.releasePin(screen().bubble!);
      expect((host as any).owner.holder).toBe((host as any).mainBubble);
    });

    it("a task's question replaced it: the question stays, and what waited shows after its answer", async () => {
      // The question writes the screen as main's does; main gives the pin back when it comes up (questionChanged).
      let made: ReturnType<typeof expanded> | null = null;
      const confirmer = new Confirmer(patch => (made!.host as unknown as { o: HostOptions }).o.setState(patch),
        { armMs: 0, gapMs: 0, onChange: q => { if (q) made!.host.releasePin(made!.screen().bubble!); } });
      made = expanded({ hands: { ...hands(), confirmer } as never });
      const { host, screen, guide } = made;
      const asked = confirmer.ask({ title: "save my document", prompt: "May I save it?", options: [{ id: "allow", label: "Allow", primary: true }, { id: "deny", label: "Not now" }], task: "t1" });
      expect(screen().bubble?.thought).toMatch(/May I save it\?/);
      // The guide finishes meanwhile: it waits behind the question.
      guide.outcome({ title: "save my document", text: "Saved.", emotion: "proud", gesture: "thumbsUp", mood: "done" });
      expect(screen().bubble?.thought).toMatch(/May I save it\?/);
      confirmer.answerKey("primary");
      expect(await asked).toBe("allow");
      expect(screen().bubble?.thought).toBe("Thanks! Carrying on.");
      await vi.advanceTimersByTimeAsync(5000);
      expect(screen().bubble).toMatchObject({ visible: true, thought: "Saved." });
      expect((host as any).owner.holder).not.toBe((host as any).mainBubble);
    });
  });
});
