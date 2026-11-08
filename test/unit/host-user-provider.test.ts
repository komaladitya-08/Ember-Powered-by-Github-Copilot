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
const sim = vi.hoisted(() => ({ clients: [] as any[], sessions: [] as any[], listeners: [] as ((e: any) => void)[], refuse: null as null | { errorType: string; statusCode?: number; message: string }, pingFails: false }));
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
    ping() { return sim.pingFails ? Promise.reject(new Error("Connection is disposed.")) : Promise.resolve({}); }
    async createSession(cfg: any) {
      sim.sessions.push(cfg);
      const own: ((e: any) => void)[] = [];
      // A project request: the service's refusal as the SDK passes it (the event, then its words alone).
      const sendAndWait = async () => {
        if (!sim.refuse) return { data: { content: "An answer." } };
        for (const fn of own) fn({ type: "session.error", data: sim.refuse });
        throw new Error(sim.refuse.message);
      };
      return { sessionId: cfg.sessionId ?? `s${sim.sessions.length}`, sendAndWait, abort: async () => undefined, on: (fn: (e: any) => void) => { own.push(fn); sim.listeners.push(fn); return () => undefined; }, rpc: { tools: { initializeAndValidate: async () => ({}), getCurrentMetadata: async () => ({ tools: [] }) } }, disconnect: async () => undefined }; }
    async resumeSession(id: string) { throw new Error(`Session not found: ${id}`); }
  }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { AgentHost, CUT_OFF, NOTICE_TITLE, USER_PROVIDER_NO_MODEL, idleWord, noticeTitle, reconnectWords, runtimeWords, stillConnectingTitle } from "../../app/main/agent/host";
import { GAVE_UP, LOST_GAVE_UP, LOST_RECONNECTED, LOST_RECONNECTING, lostWords, problemTitle } from "../../app/main/agent/presenter";
import type { BubbleState, EmberState } from "../../app/shared/overlay";
import { SettingsStore } from "../../app/main/settings";
import { providerDown, type ActiveProvider, type TestResult } from "../../app/main/provider";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const TOKEN = "gho_" + "t".repeat(36); // not a real token
const KEY = "sk-" + "k".repeat(40); // not a real key
const OWN: ActiveProvider = { kind: "user", config: { type: "openai", baseUrl: "https://models.example.com/v1", apiKey: KEY }, models: { conductor: "gpt-4.1", worker: null } };

function makeHost(provider: () => ActiveProvider | null, probeProvider?: () => Promise<TestResult>, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-own-"));
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const statuses: string[] = [];
  const host = new AgentHost({ userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, setState: () => undefined, onStatus: s => statuses.push(JSON.stringify(s)), provider, ...(probeProvider ? { probeProvider } : {}), ...extra });
  return { host, statuses };
}

const until = async (cond: () => boolean, ms = 5000) => { for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms;) await new Promise(r => setTimeout(r, 10)); return cond(); };
/** A model server on this computer (Ollama's address shape), with no key. */
const LOCAL: ActiveProvider = { kind: "user", config: { type: "openai", baseUrl: "http://127.0.0.1:18109/v1" }, models: { conductor: "llama3.2:3b", worker: null } };
const REFUSED: TestResult = { ok: false, why: "Ember can't reach 127.0.0.1:18109. Check the address and the network.", cause: "refused" };

describe("AgentHost with the user's own model provider", () => {
  it("sends no GitHub sign-in to the runtime and gives the sessions the provider's config and models", async () => {
    sim.clients = []; sim.sessions = [];
    const { host } = makeHost(() => OWN);
    expect(await host.start(TOKEN, "stored")).toBe("ready");
    expect(sim.clients[0].opts.gitHubToken).toBeUndefined();
    expect(sim.sessions[0].provider).toEqual(OWN.config);
    expect(sim.sessions[0].model).toBe("gpt-4.1");
    // A host elsewhere isn't asked at the start (integrations-1): "Using", never "Connected", until a request reaches it (integrations-r3).
    expect(host.getStatus()).toMatchObject({ phase: "ready", detail: "Using models.example.com.", service: { kind: "user", host: "models.example.com" }, conductorModel: "gpt-4.1", workerModel: "gpt-4.1" });
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

  it("says a host elsewhere with no API key saved is in use without one, never that it is connected (integrations-r3)", async () => {
    sim.clients = []; sim.sessions = [];
    const { host } = makeHost(() => ({ ...OWN, config: { type: "openai", baseUrl: "https://api.openai.com/v1" } }));
    expect(await host.start(null)).toBe("ready");
    expect(host.getStatus().detail).toBe("Using api.openai.com, with no API key saved. If it needs one, save it under Model provider.");
  });

  it("says to enter a model when none is named", async () => {
    sim.clients = []; sim.sessions = [];
    const { host } = makeHost(() => ({ ...OWN, models: { conductor: null, worker: null } }));
    expect(await host.start(null)).toBe("error");
    expect(host.getStatus()).toMatchObject({ reason: "models", detail: USER_PROVIDER_NO_MODEL });
  });

  it("names the provider, never Copilot, in the status and the bubble when it can't connect (integrations-3)", async () => {
    sim.clients = []; sim.sessions = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-host-own-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const bubbles: BubbleState[] = [];
    const host = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, onStatus: () => undefined,
      setState: (p: Partial<EmberState>) => { if (p.bubble) bubbles.push(p.bubble); }, provider: () => ({ ...OWN, models: { conductor: null, worker: null } }),
    });
    expect(await host.start(null)).toBe("error");
    // The failed start keeps the service it tried, so Home and first run explain it as the provider's.
    expect(host.getStatus()).toMatchObject({ phase: "error", reason: "models", service: { kind: "user", host: "models.example.com" } });
    await host.ask("what can you do?");
    expect(bubbles.some(b => b.title === "No model set for your provider")).toBe(true);
    expect(bubbles.some(b => /Copilot/.test(b.title ?? ""))).toBe(false);
    // Every reason has words for a provider that never say Copilot; Copilot's own stay as they were.
    for (const reason of ["sign-in", "network", "no-access", "models", "runtime", "not-answering", "other"] as const) {
      expect(noticeTitle(reason, "user"), reason).not.toMatch(/Copilot/);
      expect(noticeTitle(reason, "admin"), reason).not.toMatch(/Copilot/);
      expect(noticeTitle(reason), reason).toBe(NOTICE_TITLE[reason]);
    }
    expect(stillConnectingTitle("user")).toBe("I'm still connecting to your model provider");
    expect(stillConnectingTitle()).toBe("I'm still connecting to Copilot");
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

  it("asked with no GitHub sign-in while my own provider's note waits, points to agreeing to it, never to Copilot (integrations-r3-1)", async () => {
    sim.clients = []; sim.sessions = [];
    let waiting: string | null = "127.0.0.1:18308";
    const states: EmberState[] = [];
    const { host } = makeHost(() => null, undefined, { providerWaiting: () => waiting, setState: (s: EmberState) => states.push(structuredClone(s)) });
    expect(await host.start(null)).toBe("signed-out");
    await host.ask("What time is it?");
    expect(states.at(-1)?.bubble).toMatchObject({ visible: true, title: "Your provider needs your OK", thought: "Agree to use 127.0.0.1:18308 in settings, or turn off “Use my own model provider”, then ask me again.", mood: "attention", actions: [{ id: "ui:settings", label: "Open settings" }] });
    expect(host.getTranscript().at(-1)).toMatchObject({ who: "problem", text: "Your provider needs your OK: Agree to use 127.0.0.1:18308 in settings, or turn off “Use my own model provider”, then ask me again." });
    // With no note waiting, signing in is the way on, as before.
    waiting = null;
    await host.ask("What time is it?");
    expect(states.at(-1)?.bubble).toMatchObject({ title: NOTICE_TITLE["signed-out"], thought: "Connect your GitHub account in settings, then ask me again." });
  });

  it("says the model server on this computer isn't running instead of Connected, and connects once it answers (integrations-1)", async () => {
    sim.clients = []; sim.sessions = [];
    let answer: TestResult = REFUSED;
    let probes = 0;
    const { host } = makeHost(() => LOCAL, async () => { probes++; return answer; });
    expect(await host.start(null)).toBe("error");
    expect(host.getStatus()).toMatchObject({
      phase: "error", reason: "network", service: { kind: "user", host: "127.0.0.1:18109" },
      detail: "Ember can't reach the model server on this computer (127.0.0.1:18109). Start it, and Ember will connect in a moment.",
    });
    expect(idleWord(host.getStatus())).toBe("Can't connect");
    // Nothing else was started for a server that isn't there (each retry is the one GET, not a runtime).
    expect(sim.clients).toHaveLength(0);
    expect(probes).toBe(1);
    // The server is started: the next try (here the network's change; else the 15 s retry) connects.
    answer = { ok: true, host: "127.0.0.1:18109", models: 1 };
    host.networkChanged(true);
    expect(await until(() => host.getStatus().phase === "ready")).toBe(true);
    expect(host.getStatus().detail).toBe("Connected to 127.0.0.1:18109.");
    await host.stop();
  });

  it("keeps its status still while a model server on this computer stays off, rather than saying Connecting… at every retry (integrations-c1-2)", async () => {
    vi.useFakeTimers();
    try {
      sim.clients = []; sim.sessions = [];
      let answer: TestResult = REFUSED;
      let probes = 0;
      const { host, statuses } = makeHost(() => LOCAL, async () => { probes++; return answer; });
      expect(await host.start(null)).toBe("error");
      const after = statuses.length;
      // Three background tries (15 s, 30 s, a minute): each asks the server, and says nothing while it doesn't answer.
      for (const wait of [15_000, 30_000, 60_000]) await vi.advanceTimersByTimeAsync(wait + 100);
      expect(probes).toBe(4);
      expect(statuses.slice(after)).toEqual([]);
      expect(host.getStatus().phase).toBe("error");
      expect(sim.clients).toHaveLength(0);
      // Started: the next try connects, saying so.
      answer = { ok: true, host: "127.0.0.1:18109", models: 1 };
      await vi.advanceTimersByTimeAsync(60_100);
      expect(host.getStatus()).toMatchObject({ phase: "ready", detail: "Connected to 127.0.0.1:18109." });
      expect(statuses.slice(after).map(s => JSON.parse(s).phase)).toContain("starting");
      await host.stop();
    } finally { vi.useRealTimers(); }
  });

  it("names the model service that isn't answering as it reconnects, never Copilot when it isn't (integrations-v1)", () => {
    // Copilot's words are as they were.
    expect(reconnectWords(false)).toEqual({
      notAnswering: "Copilot isn't answering. I'm reconnecting; ask me again in a moment.",
      notAnsweringAfterTasks: "Copilot isn't answering. I'll reconnect when the tasks that are running finish; ask me again then.",
      notAnsweringDetail: "Copilot isn't answering. Reconnecting…",
      noAnswerDetail: "Copilot didn't answer in time. Reconnecting…",
      notAnsweringNow: "Copilot isn't answering.",
    });
    expect(reconnectWords("user")).toEqual({
      notAnswering: "Your model provider isn't answering. I'm reconnecting; ask me again in a moment.",
      notAnsweringAfterTasks: "Your model provider isn't answering. I'll reconnect when the tasks that are running finish; ask me again then.",
      notAnsweringDetail: "Your model provider isn't answering. Reconnecting…",
      noAnswerDetail: "Your model provider didn't answer in time. Reconnecting…",
      notAnsweringNow: "Your model provider isn't answering.",
    });
    expect(reconnectWords(true).noAnswerDetail).toBe("The model service didn't answer in time. Reconnecting…");
  });

  it("names Ember's model connection, never Copilot, when the runtime stops or runs out of file watchers under a provider (integrations-v1)", () => {
    // Copilot's words are as they were.
    expect(runtimeWords(false)).toEqual({
      stopped: "Copilot stopped unexpectedly. Reconnecting…",
      keepsStopping: "Copilot keeps stopping. Press Check again to retry, or restart Ember.",
      cutOff: CUT_OFF, cutOffStalled: "Copilot didn't answer; the task didn't finish.",
      noWatchers: "Copilot can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again.",
      noWatchersWhy: "Copilot isn't answering: the system's limit on file watchers (fs.inotify.max_user_instances) is used up. Close some apps, or ask IT to raise the limit.",
    });
    expect(lostWords(false)).toEqual({ reconnecting: LOST_RECONNECTING, reconnected: LOST_RECONNECTED, gaveUp: LOST_GAVE_UP, gaveUpBubble: GAVE_UP });
    expect(runtimeWords("user")).toEqual({
      stopped: "Ember's model connection stopped unexpectedly. Reconnecting…",
      keepsStopping: "Ember's model connection keeps stopping. Press Check again to retry, or restart Ember.",
      cutOff: "Ember's model connection stopped unexpectedly; the task didn't finish.",
      cutOffStalled: "Your model provider didn't answer; the task didn't finish.",
      noWatchers: "I can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again.",
      noWatchersWhy: "Ember's model connection isn't answering: the system's limit on file watchers (fs.inotify.max_user_instances) is used up. Close some apps, or ask IT to raise the limit.",
    });
    expect(runtimeWords(true).cutOffStalled).toBe("The model service didn't answer; the task didn't finish.");
    for (const service of ["user", true] as const) {
      expect(lostWords(service)).toEqual({
        reconnecting: "My model connection stopped unexpectedly. I'm reconnecting; ask me again in a moment.",
        reconnected: "My model connection stopped unexpectedly. I'm connected again: send it again.",
        gaveUp: "My model connection stopped unexpectedly and keeps stopping, so I've stopped reconnecting. Press Check again in Models & connections to try once more, or restart me.",
        gaveUpBubble: "My model connection keeps stopping, so I've stopped reconnecting. Open settings to try again, or restart me.",
      });
      const words = [...Object.values(runtimeWords(service)), ...Object.values(lostWords(service))];
      for (const w of words) expect(w, w).not.toMatch(/Copilot/);
      // The bubble's title names it too.
      expect(problemTitle(lostWords(service).reconnecting, service)).toBe("My model connection stopped");
      expect(problemTitle(runtimeWords(service).noWatchers, service)).toBe("I can't work right now");
    }
    expect(problemTitle(LOST_RECONNECTING)).toBe("Copilot stopped");
  });

  it("says Ember's model connection stopped, never Copilot, when the runtime dies under my own provider (integrations-v1)", async () => {
    sim.clients = []; sim.sessions = []; sim.listeners = [];
    const { host, statuses } = makeHost(() => OWN, undefined, { healthMs: 40 });
    try {
      expect(await host.start(null)).toBe("ready");
      sim.pingFails = true;
      expect(await until(() => statuses.some(s => JSON.parse(s).detail === "Ember's model connection stopped unexpectedly. Reconnecting…"), 3000)).toBe(true);
      expect(statuses.join("\n")).not.toContain("Copilot stopped");
    } finally {
      sim.pingFails = false;
      await host.stop();
    }
  });

  it("tells memory it waits for the own provider, never for a GitHub account, when the provider can't connect (integrations-r5)", async () => {
    sim.clients = []; sim.sessions = [];
    const why: string[] = [];
    const memory = {
      verifyAccount: (id: number | null, reason?: string) => { why.push(id === null ? `verify:${reason}` : "verify:id"); },
      pauseAccount: (reason?: string) => { why.push(`pause:${reason ?? "checking"}`); },
    };
    // The model server on this computer isn't running: nothing says "Checking your GitHub account…".
    const down = makeHost(() => LOCAL, async () => REFUSED, { memory });
    expect(await down.host.start(null)).toBe("error");
    expect(why.length).toBeGreaterThan(0);
    expect(why.every(w => w.endsWith(":own-provider"))).toBe(true);
    await down.host.stop();
    // No model named: never "Ember couldn't check your GitHub account… It comes back when Ember reconnects."
    why.length = 0;
    const noModel = makeHost(() => ({ ...OWN, models: { conductor: null, worker: null } }), undefined, { memory });
    expect(await noModel.host.start(null)).toBe("error");
    expect(why.filter(w => !w.endsWith(":own-provider"))).toEqual([]);
    expect(why.at(-1)).toBe("pause:own-provider");
    await noModel.host.stop();
  });

  it("leaves Ready when a turn on its provider fails and nothing answers there, and never probes a remote host at the start (integrations-1)", async () => {
    sim.clients = []; sim.sessions = []; sim.listeners = [];
    let answer: TestResult = { ok: true, host: "models.example.com", models: 3 };
    let probes = 0;
    const { host } = makeHost(() => OWN, async () => { probes++; return answer; });
    expect(await host.start(null)).toBe("ready");
    // A remote host's test goes through other proxy settings than the runtime's: it never vetoes a connect.
    expect(probes).toBe(0);
    // A turn that failed with an answer (a status code) says it itself: nothing is asked.
    for (const fn of sim.listeners) fn({ type: "session.error", data: { errorType: "query", statusCode: 400, message: "Bad request" } });
    await new Promise(r => setTimeout(r, 20));
    expect(probes).toBe(0);
    answer = { ok: false, why: "Ember can't reach models.example.com. Check the address and the network.", cause: "unreachable" };
    for (const fn of sim.listeners) fn({ type: "session.error", data: { errorType: "query", message: "fetch failed" } });
    expect(await until(() => host.getStatus().phase === "error")).toBe(true);
    expect(probes).toBe(1);
    expect(host.getStatus()).toMatchObject({ reason: "network", detail: "Ember can't reach models.example.com. Check the address and the network: Ember will try again in a moment." });
    await host.stop();
  });

  it("words what nothing answering at the provider means, and lets an answer through (integrations-1)", () => {
    expect(providerDown(REFUSED, "127.0.0.1:18109", true)).toBe("Ember can't reach the model server on this computer (127.0.0.1:18109). Start it, and Ember will connect in a moment.");
    expect(providerDown({ ok: false, why: "localhost:11434 didn't answer within 10 seconds.", cause: "timeout" }, "localhost:11434", true)).toBe("localhost:11434 didn't answer within 10 seconds. Ember will try again in a moment.");
    expect(providerDown({ ok: false, why: "x", cause: "refused" }, "models.example.com", false)).toBe("Ember can't reach models.example.com. Check the address and the network: Ember will try again in a moment.");
    // Something is there: the key, the model list or a certificate is the request's to explain.
    expect(providerDown({ ok: false, why: "models.example.com didn't accept the API key. Check it, or replace it." }, "models.example.com", false)).toBeNull();
    expect(providerDown({ ok: true, host: "127.0.0.1:18109", models: null }, "127.0.0.1:18109", true)).toBeNull();
    // Copilot's own words stay as they were.
    expect(idleWord({ phase: "error", reason: "network" })).toBe("Offline");
    expect(idleWord({ phase: "error", reason: "network", service: { kind: "admin", host: "x" } })).toBe("Offline");
  });

  it("leaves Ready when a project request on its provider fails and nothing answers there, as a turn does (integrations-r2-5)", async () => {
    sim.clients = []; sim.sessions = []; sim.listeners = [];
    let answer: TestResult = { ok: true, host: "127.0.0.1:18109", models: 1 };
    let probes = 0;
    const { host } = makeHost(() => LOCAL, async () => { probes++; return answer; });
    expect(await host.start(null)).toBe("ready");
    probes = 0;
    try {
      // The service answered (a status code): its refusal says why, and nothing is asked.
      sim.refuse = { errorType: "rate_limit", statusCode: 429, message: "Rate limit reached" };
      await expect(host.runProject("Review this.", new AbortController())).rejects.toThrow("The model service's usage limit was reached for now. Try again a bit later.");
      await new Promise(r => setTimeout(r, 20));
      expect(probes).toBe(0);
      expect(host.getStatus().phase).toBe("ready");
      // Nothing answered: the server is asked, and Models & connections, the handle and the hero leave Ready for why.
      answer = REFUSED;
      sim.refuse = { errorType: "query", message: "Failed native model HTTP request: error sending request for url (http://127.0.0.1:18109/v1/chat/completions): client error (Connect): tcp connect error: Connection refused (os error 111)" };
      await expect(host.runProject("Review this.", new AbortController())).rejects.toThrow("I can't reach the model server on this computer. Is it running? Start it, then ask again.");
      expect(await until(() => host.getStatus().phase === "error", 2000)).toBe(true);
      expect(probes).toBe(1);
      expect(host.getStatus()).toMatchObject({ reason: "network", detail: "Ember can't reach the model server on this computer (127.0.0.1:18109). Start it, and Ember will connect in a moment." });
    } finally {
      sim.refuse = null;
      await host.stop();
    }
  });

  it("says why the provider refused a project request instead of \"Try again\" (integrations-5)", async () => {
    sim.clients = []; sim.sessions = [];
    const { host } = makeHost(() => OWN);
    expect(await host.start(null)).toBe("ready");
    expect(await host.runProject("Review this.", new AbortController())).toBe("An answer.");
    sim.refuse = { errorType: "authentication", statusCode: 401, message: "Incorrect API key provided" };
    try {
      await expect(host.runProject("Review this.", new AbortController())).rejects.toThrow(/^Your model service refused the request\. Check its API key in Ember's settings/);
      sim.refuse = { errorType: "rate_limit", statusCode: 429, message: "Rate limit reached" };
      await expect(host.runProject("Review this.", new AbortController())).rejects.toThrow("The model service's usage limit was reached for now. Try again a bit later.");
    } finally {
      sim.refuse = null;
      await host.stop();
    }
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
