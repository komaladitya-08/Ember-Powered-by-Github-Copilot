// Runs the real Copilot runtime against the offline mock model server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { Conductor } from "../../app/main/agent/conductor";
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
});

function makeConductor(states: Partial<EmberState>[]) {
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  const conductor = new Conductor({
    client, settings,
    presenter: new Presenter(p => states.push(p)),
    log: createLogger({ dir: path.join(dir, "logs") }),
    stateFile: path.join(dir, "agent.json"),
    workDir: path.join(dir, "empty"),
    model: "mock-model",
    provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
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
    expect(last.tools.sort()).toEqual(["describe_screen", "set_appearance", "start_task"]);
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

  it("resumes the same conversation after a restart", async () => {
    const states: Partial<EmberState>[] = [];
    const first = makeConductor(states);
    await first.conductor.start();
    // Only a conversation with at least one turn is kept by the runtime.
    await first.conductor.ask("remember this");
    await idle(states, 0);
    const id = first.conductor.sessionId;
    await first.conductor.stop();
    const second = makeConductor([]);
    await second.conductor.start();
    expect(second.conductor.sessionId).toBe(id);
    await second.conductor.stop();
  }, 60000);
});
