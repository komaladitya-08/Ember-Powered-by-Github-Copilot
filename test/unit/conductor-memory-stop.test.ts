/**
 * A Stop while the conductor waits for what memory has on a request (Better recall can take up to its wait) drops the
 * request: nothing is sent after the user stopped, whether the Stop came from the conductor's abort or from the kill
 * switch, whose memory part ends the model process and so lets the wait end at once (review of PR #141).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../app/main/logger";

vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class FakeClient { constructor() { throw new Error("no Copilot client in this test"); } }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { conductorTools, Conductor, ConnectionLost, NO_ANSWER, type ConductorMemory } from "../../app/main/agent/conductor";
import { Reminders } from "../../app/main/agent/reminders";
import { KillSwitch } from "../../app/main/agent/killswitch";
import { SemanticMemory, type Embedder } from "../../app/main/memory/embed";
import { MemoryService } from "../../app/main/memory/service";
import type { SettingsStore } from "../../app/main/settings";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const settings = { get: () => ({}) } as unknown as SettingsStore;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-ask-stop-"));

function conductor(memory: ConductorMemory, returned: string[][] = []) {
  const sent: string[] = [];
  const c = new Conductor({
    client: {} as never, settings, presenter: { userPrompt() {} } as never, log: quiet, stateFile: path.join(tmp(), "agent.json"),
    workDir: "/tmp", model: "m", memory, takeReports: () => ["a task finished"], returnReports: r => { returned.push(r); },
  });
  (c as unknown as { session: unknown }).session = { send: async (m: { prompt: string }) => { sent.push(m.prompt); }, abort: async () => undefined };
  return { c, sent };
}

describe("a Stop while the request waits for memory", () => {
  it("sends nothing after the conductor is stopped, and keeps the finished tasks' results for the next request", async () => {
    let release!: (v: string) => void;
    const memory: ConductorMemory = { remember: () => "", forget: () => false, context: () => new Promise<string>(r => { release = r; }) };
    const returned: string[][] = [];
    const { c, sent } = conductor(memory, returned);
    const asked = c.ask("open Mail and send the draft");
    await Promise.resolve();
    await c.abort();
    release("<memory untrusted=\"true\">\n- [f1] Works at Initech\n</memory>");
    await asked;
    expect(sent).toEqual([]);
    expect(returned).toEqual([["a task finished"]]);
  });

  it("drops the request just the same when memory answers through forRequest, the path that learns gaps (merge of PR #142)", async () => {
    let release!: (v: string) => void;
    const memory: ConductorMemory = {
      remember: () => "", forget: () => false, context: () => "",
      forRequest: () => new Promise<string>(r => { release = r; }),
    };
    const { c, sent } = conductor(memory);
    const asked = c.ask("open Mail and send the draft");
    await Promise.resolve();
    await c.abort();
    release("<memory untrusted=\"true\">\n- [f1] Works at Initech\n</memory>");
    await asked;
    expect(sent).toEqual([]);
  });

  it("sends nothing after the kill switch, whose memory part ends the wait at once", async () => {
    // The real memory path: the model's process never answers until the kill switch's memory part stops it.
    const embedder: Embedder & { stopped: (() => void)[] } = {
      stopped: [],
      embed: () => new Promise((_resolve, reject) => { embedder.stopped.push(() => reject(new Error("stopped"))); }),
      stop: () => { for (const f of embedder.stopped.splice(0)) f(); },
    };
    const dir = tmp();
    const semantic = new SemanticMemory({ dir, log: quiet, embedder, model: () => "a".repeat(64), indexDelayMs: 60_000, waitMs: 60_000 });
    const store = new MemoryService({ dir, log: quiet, semantic });
    store.remember("Works at Initech", [{ name: "User" }], "I work at Initech");
    // An index with the fact in it, so the question waits for its vector.
    (semantic as unknown as { current(): { set(id: string, h: string, v: Float32Array): void } }).current().set("f-any", "0000000000000000", Float32Array.of(1));
    const { c, sent } = conductor({ remember: () => "", forget: () => false, context: q => store.context(q) });
    const kill = new KillSwitch(() => [{ name: "memory", stop: () => semantic.stop() }, { name: "agent", stop: () => c.abort() }], quiet);
    const asked = c.ask("open Mail and send the draft");
    await Promise.resolve();
    await kill.pull("hotkey");
    await asked;
    expect(sent).toEqual([]);
  });

  it("asks the user to ask again when the connection was replaced during the wait, and sends nothing (re-review of PR #141)", async () => {
    let release!: (v: string) => void;
    const memory: ConductorMemory = { remember: () => "", forget: () => false, context: () => new Promise<string>(r => { release = r; }) };
    const failed: string[] = [];
    const sent: string[] = [];
    const c = new Conductor({
      client: {} as never, settings, presenter: { userPrompt() {}, fail: (m: string) => { failed.push(m); } } as never, log: quiet,
      stateFile: path.join(tmp(), "agent.json"), workDir: "/tmp", model: "m", memory,
    });
    const session = { send: async (m: { prompt: string }) => { sent.push(m.prompt); }, abort: async () => undefined };
    (c as unknown as { session: unknown }).session = session;
    const asked = c.ask("open Mail");
    await Promise.resolve();
    (c as unknown as { session: unknown }).session = { ...session };
    release("");
    await expect(asked).rejects.toBeInstanceOf(ConnectionLost);
    expect(sent).toEqual([]);
    expect(failed).toEqual([NO_ANSWER]);
  });

  it("drops both queued recalls on Stop and lets a fresh request pass the old wait (ORCH-2)", async () => {
    const releases: ((text: string) => void)[] = [];
    const { c, sent } = conductor({ remember: () => "", forget: () => false,
      context: () => new Promise<string>(resolve => releases.push(resolve)),
    });
    const a = c.ask("old first");
    const b = c.ask("old second");
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    await c.abort();
    const fresh = c.ask("new request");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]("");
    await fresh;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/new request$/);
    releases[0]("");
    await Promise.all([a, b]);
    expect(sent).toHaveLength(1);
  });

  it("recalls queued requests only at dispatch, after consent changes while an earlier send waits", async () => {
    let consent = true;
    const seen: string[] = [];
    const { c, sent } = conductor({ remember: () => "", forget: () => false, context: text => {
      seen.push(text);
      return consent ? "<memory untrusted=\"true\">private fact</memory>" : "";
    } });
    let release!: () => void;
    const sending = new Promise<void>(resolve => { release = resolve; });
    (c as unknown as { session: unknown }).session = { send: async (m: { prompt: string }) => {
      sent.push(m.prompt);
      if (sent.length === 1) await sending;
    } };
    const a = c.ask("first request");
    const b = c.ask("second request");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(seen).toEqual(["first request"]);
    consent = false;
    release();
    await Promise.all([a, b]);
    expect(seen).toEqual(["first request", "second request"]);
    expect(sent[1]).not.toContain("private fact");
  });

  it("does not consume waiting authority or claim ownership for an unmatched message (ORCH-2)", async () => {
    const { c, sent } = conductor({ remember: () => "", forget: () => false, context: () => "" });
    await c.ask("request", undefined, undefined, false);
    const internal = c as unknown as { turnBegan(content: string): void; said: string; saidOwn: boolean };
    internal.turnBegan("a different request");
    expect(internal.said).toBe("");
    expect(internal.saidOwn).toBe(false);
    internal.turnBegan(sent[0]);
    expect(internal.said).toBe("request");
    expect(internal.saidOwn).toBe(false);
  });

  it("keeps ownership in FIFO order for identical prompts (ORCH-2)", async () => {
    const { c, sent } = conductor({ remember: () => "", forget: () => false, context: () => "" });
    await c.ask("same request", undefined, undefined, false);
    await c.ask("same request", undefined, undefined, true);
    expect(sent[0]).toBe(sent[1]);
    const internal = c as unknown as { turnBegan(content: string): void; saidOwn: boolean };
    internal.turnBegan(sent[0]);
    expect(internal.saidOwn).toBe(false);
    internal.turnBegan(sent[1]);
    expect(internal.saidOwn).toBe(true);
  });

  it("still sends a request nobody stopped", async () => {
    const { c, sent } = conductor({ remember: () => "", forget: () => false, context: async () => "" });
    await c.ask("what's the weather");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/what's the weather$/);
  });
});

describe("memory provenance for unchecked speech", () => {
  it("uses each queued turn's ownership, even when the words repeat, preserving saved routine steps", async () => {
    const store = new MemoryService({ dir: tmp(), log: quiet });
    const { c, sent } = conductor(store);
    const state = c as unknown as {
      turnBegan(text: string): void;
      routineWords: string[];
      memoryTools: { store: ConductorMemory; said(): string };
    };
    const words = "I prefer short answers";
    for (const own of [false, true, false]) await c.ask(words, undefined, undefined, own);
    for (const [i, own] of [false, true, false].entries()) {
      state.turnBegan(sent[i]);
      const memory = state.memoryTools;
      expect(memory.said()).toBe(own ? words : "");
      memory.store.remember("Prefers short answers", [], memory.said());
      expect(store.list()[0].source).toBe(own ? "user" : "conversation");
      store.forgetAll();
    }
    state.routineWords = ["I work on Ember"];
    expect(state.memoryTools.said()).toBe("I work on Ember");
  });
});


describe("request correlation with current-turn reminder authority", () => {
  it("keeps unchecked, unmatched and saved routine words from cancelling reminders, but accepts the owner's request", async () => {
    const { c, sent } = conductor({ remember: () => "", forget: () => false, context: () => "" });
    const reminders = new Reminders({ onDue() {} });
    const state = c as unknown as {
      deps: { reminders: Reminders };
      turnBegan(text: string): void;
      routineWords: string[];
      reminderTools: { store: Reminders; said(): string; own(): string };
    };
    state.deps.reminders = reminders;
    const words = "cancel the reminder to call Priya";
    reminders.add("call Priya", Date.now() + 60_000, "remind me in a minute to call Priya");
    const tools = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, undefined, state.reminderTools);
    const cancel = tools.find(t => t.name === "cancel_reminder")!;
    const id = reminders.list()[0].id;
    const run = () => cancel.handler!({ id }, {} as never);
    await c.ask(words, undefined, undefined, false);
    state.turnBegan(sent.at(-1)!);
    expect(await run()).toMatch(/Not cancelled/);
    state.turnBegan("unmatched runtime notification");
    state.routineWords = [words];
    expect(await run()).toMatch(/Not cancelled/);
    expect(reminders.list()).toHaveLength(1);
    await c.ask(words);
    state.turnBegan(sent.at(-1)!);
    expect(await run()).toMatch(/^Cancelled/);
    expect(reminders.list()).toHaveLength(0);
    reminders.clear();
  });
});
