// Runs the real Copilot runtime against the offline mock model server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { Conductor } from "../../app/main/agent/conductor";
import { AgentHost } from "../../app/main/agent/host";
import { Presenter } from "../../app/main/agent/presenter";
import { locateRuntime } from "../../app/main/agent/runtime";
import { SettingsStore } from "../../app/main/settings";
import { createLogger } from "../../app/main/logger";
import type { EmberState } from "../../app/shared/overlay";

let mock: { baseUrl: string; requests: { tools: string[]; messages: { role: string; content: unknown }[] }[]; close(): Promise<void> };
let dir: string;
let client: CopilotClient;

beforeAll(async () => {
  mock = await startMockLlm({ delayMs: 5 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-conductor-"));
  const runtime = locateRuntime({ appPath: process.cwd() });
  expect(runtime.exists).toBe(true);
  client = new CopilotClient({
    mode: "empty", baseDirectory: path.join(dir, "copilot"), useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: runtime.path }),
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  await client.start();
}, 60000);

afterAll(async () => {
  await client?.stop();
  await mock?.close();
  // The runtime's store holds the conversations' text: nothing is left behind in /tmp.
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function makeConductor(states: Partial<EmberState>[], describeScreen?: () => Promise<string>, o: {
  resume?: string | null; turnStartMs?: number; turnSlowMs?: number; turnSilentMs?: number; onStuck?: (why: string) => void; baseUrl?: string;
} = {}) {
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const conductor = new Conductor({
    client, settings,
    presenter: new Presenter(p => states.push(p)),
    log: createLogger({ dir: path.join(dir, "logs") }),
    stateFile: path.join(dir, "agent.json"),
    workDir: path.join(dir, "empty"),
    model: "mock-model",
    provider: { type: "openai", baseUrl: o.baseUrl ?? mock.baseUrl, apiKey: "test" },
    describeScreen,
    resume: o.resume,
    turnStartMs: o.turnStartMs,
    turnSlowMs: o.turnSlowMs,
    turnSilentMs: o.turnSilentMs,
    onStuck: o.onStuck,
  });
  return { conductor, settings };
}

const idle = (states: Partial<EmberState>[], from: number) => new Promise<void>((resolve, reject) => {
  const t0 = Date.now();
  const id = setInterval(() => {
    if (states.slice(from).some(s => s.bubble && s.bubble.streaming === false && s.talking === false)) { clearInterval(id); resolve(); }
    else if (Date.now() - t0 > 30000) { clearInterval(id); reject(new Error("no idle")); }
  }, 50);
});

describe("conductor on the real Copilot runtime", () => {
  it("offers the model only Ember's own tools", async () => {
    const states: Partial<EmberState>[] = [];
    const { conductor } = makeConductor(states);
    await conductor.start();
    await conductor.ask("hello Ember");
    await idle(states, 0);
    const last = mock.requests[mock.requests.length - 1];
    expect(last.tools.sort()).toEqual(["describe_screen", "set_appearance", "show_me", "start_task"]);
    await conductor.stop();
  }, 60000);

  it("streams thinking, then the answer, into Ember's bubble", async () => {
    const states: Partial<EmberState>[] = [];
    const { conductor } = makeConductor(states);
    await conductor.start();
    await conductor.ask("what can you do");
    await idle(states, 0);
    expect(states[0].emotion).toBe("thinking");
    expect(states.some(s => s.bubble?.mood === "thinking" && s.bubble.thought.includes("Let me think"))).toBe(true);
    const answer = states.filter(s => s.bubble?.title === "Ember" && s.talking).pop();
    expect(answer?.bubble?.thought).toContain("You said");
    expect(states.some(s => s.talking === true)).toBe(true);
    await conductor.stop();
  }, 60000);

  it("changes Ember's look when the model calls set_appearance", async () => {
    const states: Partial<EmberState>[] = [];
    const { conductor, settings } = makeConductor(states);
    await conductor.start();
    await conductor.ask('CALLTOOL:set_appearance{"character":"glint","size":80}');
    await idle(states, 0);
    expect(settings.get()).toMatchObject({ character: "glint", size: 80 });
    expect(states.some(s => s.emotion === "focused" && s.bubble?.step === "Changing how I look")).toBe(true);
    await conductor.stop();
  }, 60000);

  it("gives the model the screen text when it calls describe_screen", async () => {
    const states: Partial<EmberState>[] = [];
    const screen = '<screen source="accessibility" app="gedit" window="notes.txt" untrusted="true">\n[1] push button "Save"\n</screen>';
    const { conductor } = makeConductor(states, async () => screen);
    await conductor.start();
    const before = mock.requests.length;
    await conductor.ask("CALLTOOL:describe_screen{}");
    await idle(states, 0);
    const toolResults = mock.requests.slice(before).flatMap(r => r.messages).filter(m => m.role === "tool");
    expect(toolResults.some(m => String(m.content).includes('push button "Save"'))).toBe(true);
    expect(states.some(s => s.bubble?.step === "Looking at your screen")).toBe(true);
    await conductor.stop();
  }, 60000);

  it("forgets the conversation on sign-out, so the next start is fresh", async () => {
    const first = makeConductor([]);
    await first.conductor.start();
    const id = first.conductor.sessionId!;
    await first.conductor.forget();
    expect(fs.existsSync(path.join(dir, "agent.json"))).toBe(false);
    const ids = (await client.listSessions()).map(s => s.sessionId);
    expect(ids).not.toContain(id);
    const second = makeConductor([]);
    await second.conductor.start();
    expect(second.conductor.sessionId).not.toBe(id);
    await second.conductor.stop();
  }, 60000);

  it("resumes the conversation on a reconnect within the run, and starts a new one (deleting the old) after a restart", async () => {
    const states: Partial<EmberState>[] = [];
    const first = makeConductor(states);
    await first.conductor.start();
    await first.conductor.ask("remember the word pineapple");
    await idle(states, 0);
    const id = first.conductor.sessionId!;
    await first.conductor.stop();
    // A reconnect within the same run of Ember resumes it.
    const again = makeConductor([], undefined, { resume: id });
    await again.conductor.start();
    expect(again.conductor.sessionId).toBe(id);
    // Ember went away without deleting it (a crash): the next run deletes it, never resumes it.
    await again.conductor.stop();
    const later: Partial<EmberState>[] = [];
    const second = makeConductor(later);
    await second.conductor.start();
    expect(second.conductor.sessionId).not.toBe(id);
    expect((await client.listSessions()).map(s => s.sessionId)).not.toContain(id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8")).conductorSessionId).toBe(second.conductor.sessionId);
    // The model doesn't see the earlier exchange.
    const before = mock.requests.length;
    await second.conductor.ask("what word did I ask you to remember?");
    await idle(later, 0);
    const seen = mock.requests.slice(before).flatMap(r => r.messages).map(m => JSON.stringify(m.content));
    expect(seen.join("\n")).toContain("what word did I ask you to remember?");
    expect(seen.join("\n")).not.toContain("pineapple");
    await second.conductor.stop();
  }, 60000);

  it("a model that takes the request and never answers (a dead connection, a stalled proxy): Ember says it's still waiting, then ends the turn (review round 8)", async () => {
    let asked = 0, closed = 0;
    const stalled = http.createServer(async (q, r) => {
      for await (const chunk of q) void chunk;
      if (q.url?.endsWith("/models")) { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] })); return; }
      asked++;
      r.on("close", () => { closed++; });
    });
    await new Promise<void>(r => stalled.listen(0, "127.0.0.1", () => r()));
    const states: Partial<EmberState>[] = [];
    const why: string[] = [];
    const { conductor } = makeConductor(states, undefined, {
      baseUrl: `http://127.0.0.1:${(stalled.address() as net.AddressInfo).port}/v1`, turnSlowMs: 1500, turnSilentMs: 5000, onStuck: w => { why.push(w); },
    });
    try {
      await conductor.start();
      await conductor.ask("what time is it in Tokyo");
      for (let i = 0; i < 300 && !why.length; i++) await new Promise(r => setTimeout(r, 50));
      expect(why).toEqual(["silent"]);
      expect(asked).toBe(1);
      expect(states.some(s => s.bubble?.title === "Still waiting for Copilot…" && s.bubble.mood === "thinking")).toBe(true);
      // The turn was ended: the runtime let go of the request it was waiting on.
      for (let i = 0; i < 100 && !closed; i++) await new Promise(r => setTimeout(r, 50));
      expect(closed).toBe(1);
    } finally {
      await conductor.stop();
      stalled.closeAllConnections();
      stalled.close();
    }
  }, 60000);
});

describe("the conversation lasts one run of Ember (host on the real runtime)", () => {
  it("is kept across a reconnect, deleted when Ember quits, and new after the next start", async () => {
    const userData = fs.mkdtempSync(path.join(dir, "host-"));
    const settings = new SettingsStore(path.join(userData, "settings.json"));
    settings.load();
    const states: Partial<EmberState>[] = [];
    const host = new AgentHost({
      userData, runtimePath: locateRuntime({ appPath: process.cwd() }).path, settings,
      log: createLogger({ dir: path.join(userData, "logs") }),
      setState: p => states.push(p), onStatus: () => undefined,
      provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
    });
    // The sessions in the host's store (read while the host's own runtime is stopped).
    const stored = async () => {
      const store = new CopilotClient({
        mode: "empty", baseDirectory: path.join(userData, "copilot"), useLoggedInUser: false,
        connection: RuntimeConnection.forStdio({ path: locateRuntime({ appPath: process.cwd() }).path }),
        env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
      });
      await store.start();
      try { return (await store.listSessions()).map(s => s.sessionId); } finally { await store.stop(); }
    };
    try {
      expect(await host.start(null)).toBe("ready");
      await host.ask("remember the word pineapple");
      await idle(states, 0);
      const id = host.conductor!.sessionId!;
      // A reconnect within the run (the runtime restarted, the network came back) resumes it.
      expect(await host.start(null)).toBe("ready");
      expect(host.conductor!.sessionId).toBe(id);
      // Quitting deletes it.
      await host.stop();
      expect(await stored()).not.toContain(id);
      // The next start is a new conversation: the model doesn't see the earlier exchange.
      expect(await host.start(null)).toBe("ready");
      expect(host.conductor!.sessionId).not.toBe(id);
      const from = states.length, before = mock.requests.length;
      await host.ask("what word did I ask you to remember?");
      await idle(states, from);
      const seen = mock.requests.slice(before).flatMap(r => r.messages).map(m => JSON.stringify(m.content)).join("\n");
      expect(seen).toContain("what word did I ask you to remember?");
      expect(seen).not.toContain("pineapple");
    } finally {
      await host.stop();
    }
  }, 90000);

  it("a turn whose model request never answers is ended and Copilot reconnected; the conversation goes on and the next ask is answered (review round 8)", async () => {
    // The model's endpoint, which stops answering (and holds what it was asked) while `stall` is set.
    let stall = false;
    const relay = http.createServer((q, r) => {
      if (stall && !q.url?.endsWith("/models")) return;
      const up = http.request(`${mock.baseUrl.replace(/\/v1$/, "")}${q.url}`, { method: q.method, headers: q.headers }, res => { r.writeHead(res.statusCode ?? 502, res.headers); res.pipe(r); });
      up.on("error", () => r.destroy());
      q.pipe(up);
    });
    await new Promise<void>(r => relay.listen(0, "127.0.0.1", () => r()));
    const userData = fs.mkdtempSync(path.join(dir, "stall-"));
    const settings = new SettingsStore(path.join(userData, "settings.json"));
    settings.load();
    const states: Partial<EmberState>[] = [];
    const host = new AgentHost({
      userData, runtimePath: locateRuntime({ appPath: process.cwd() }).path, settings,
      log: createLogger({ dir: path.join(userData, "logs") }),
      setState: p => states.push(p), onStatus: () => undefined,
      provider: { type: "openai", baseUrl: `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}/v1`, apiKey: "test" },
      turnSlowMs: 1000, turnSilentMs: 4000,
    });
    const until = async (cond: () => boolean, ms = 20000) => { for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms;) await new Promise(r => setTimeout(r, 50)); return cond(); };
    try {
      expect(await host.start(null)).toBe("ready");
      await host.ask("remember the word pineapple");
      await idle(states, 0);
      const id = host.conductor!.sessionId!;
      stall = true;
      const from = states.length;
      await host.ask("what time is it in Tokyo");
      expect(await until(() => states.slice(from).some(s => s.bubble?.title === "Still waiting for Copilot…"))).toBe(true);
      expect(await until(() => states.slice(from).some(s => s.bubble?.thought === "Copilot didn't answer. Ask me again in a moment."))).toBe(true);
      stall = false;
      expect(await until(() => host.getStatus().phase === "ready" && host.conductor?.sessionId === id)).toBe(true);
      const again = states.length, before = mock.requests.length;
      await host.ask("what word did I ask you to remember?");
      await idle(states, again);
      expect(states.slice(again).some(s => s.bubble?.title === "Cinder" && /You said/.test(s.bubble.thought))).toBe(true);
      // The same conversation: the model sees the earlier exchange.
      expect(mock.requests.slice(before).flatMap(r => r.messages).map(m => JSON.stringify(m.content)).join("\n")).toContain("pineapple");
    } finally {
      await host.stop();
      relay.closeAllConnections();
      relay.close();
    }
  }, 90000);
});

/** This machine's first non-loopback IPv4 address (an "internal host" the proxy settings can exempt). */
const lanIp = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === "IPv4" && !a.internal)?.address;

describe("the organisation's endpoint behind the system's proxy settings (host on the real runtime)", () => {
  it.skipIf(!lanIp)("an endpoint the system reaches directly is reached directly, though GitHub goes through a proxy", async () => {
    // GitHub's proxy refuses everything: an answer can only come straight from the endpoint.
    const through: string[] = [];
    const proxy = http.createServer((q, r) => { through.push(String(q.url)); r.writeHead(403); r.end(); });
    proxy.on("connect", (q, sock) => { through.push(String(q.url)); sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
    await new Promise<void>(r => proxy.listen(0, "127.0.0.1", () => r()));
    // The mock model, on this machine's LAN address.
    const lan = net.createServer(c => { const u = net.connect(Number(new URL(mock.baseUrl).port), "127.0.0.1"); c.pipe(u).pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); });
    await new Promise<void>(r => lan.listen(0, lanIp, () => r()));
    const endpoint = `http://${lanIp}:${(lan.address() as net.AddressInfo).port}/v1`;
    const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    const userData = fs.mkdtempSync(path.join(dir, "byok-"));
    const settings = new SettingsStore(path.join(userData, "settings.json"));
    settings.load();
    const states: Partial<EmberState>[] = [];
    const host = new AgentHost({
      userData, runtimePath: locateRuntime({ appPath: process.cwd() }).path, settings,
      log: createLogger({ dir: path.join(userData, "logs") }),
      setState: p => states.push(p), onStatus: () => undefined,
      provider: { type: "openai", baseUrl: endpoint, apiKey: "test" },
      // GNOME: a proxy for the internet, the internal endpoint among its exceptions.
      resolveProxy: async url => (url.startsWith(endpoint) ? "DIRECT" : `PROXY 127.0.0.1:${(proxy.address() as net.AddressInfo).port}`),
    });
    try {
      expect(await host.start(null)).toBe("ready");
      await host.ask("hello?");
      await idle(states, 0);
      expect(states.filter(s => s.bubble).at(-1)?.bubble).toMatchObject({ mood: "idle", title: "Cinder", streaming: false });
      expect(through).toEqual([]);
    } finally {
      await host.stop();
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      proxy.close();
      lan.close();
    }
  }, 90000);
  it("requests asked one after another (each waits for the turn before) are never taken for a turn that didn't begin, nor is Stop", async () => {
    const states: Partial<EmberState>[] = [];
    let stuck = 0;
    const { conductor } = makeConductor(states, undefined, { turnStartMs: 1000, onStuck: () => { stuck++; } });
    await conductor.start();
    const before = mock.requests.length;
    await conductor.ask("first question");
    await conductor.ask("second question");
    await conductor.ask("third question");
    const asked = () => mock.requests.slice(before).map(r => JSON.stringify(r.messages.at(-1)?.content ?? ""));
    for (let i = 0; i < 300 && !asked().some(m => m.includes("third question")); i++) await new Promise(r => setTimeout(r, 50));
    expect(asked().filter(m => /(first|second|third) question/.test(m))).toHaveLength(3);
    await conductor.ask("fourth question");
    await conductor.ask("fifth question");
    await conductor.abort();
    await new Promise(r => setTimeout(r, 2500));
    expect(stuck).toBe(0);
    expect(states.some(s => s.bubble?.mood === "error")).toBe(false);
    await conductor.stop();
  }, 60000);
});
