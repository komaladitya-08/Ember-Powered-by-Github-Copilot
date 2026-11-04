/**
 * The fixes from the review of 2026-11-04: memory that can't be reached is never saved over, a hung model call lets go of
 * Project, the command reviewer's session is checked for tools, the action limit is Ember's and not each task's, Tailscale
 * is known to the classifier, the handle's face rests, and a question doesn't hash every fact again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Rig } from "@ember/characters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copilotOneShot, ONE_SHOT_MS, PROJECT_SHOT_MS, SESSION_START_MS } from "../../app/main/agent/one-shot";
import { copilotReviewer } from "../../app/main/agent/reviewer";
import { classifyCommand } from "../../app/main/commands/classify";
import type { Logger } from "../../app/main/logger";
import { SemanticMemory, VectorIndex } from "../../app/main/memory/embed";
import { MemoryGraph } from "../../app/main/memory/graph";
import { memoryFile } from "../../app/main/memory/store";
import { PolicyEngine } from "../../app/main/policy/policy";
import { mayRest } from "../../app/renderer/handle/rest";
import { contextOf } from "../fixtures/commands/corpus";

const log = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;

describe("the memory file", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-memory-reach-")); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  const kept = () => {
    const graph = new MemoryGraph();
    graph.add({ text: "Likes green tea", about: [{ name: "User" }], source: "user" });
    return graph;
  };
  const locked = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

  it("is never replaced while it is there but out of reach, and the next start finds it whole", () => {
    memoryFile(dir).save(kept());
    const before = fs.readFileSync(path.join(dir, "memory.json"), "utf8");
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((f: fs.PathOrFileDescriptor, o: never) => {
      if (String(f).endsWith("memory.json")) throw locked();
      return read(f, o);
    }) as typeof fs.readFileSync);
    const onBroken = vi.fn();
    const file = memoryFile(dir, onBroken);
    expect(file.load().size.facts).toBe(0);
    expect(onBroken).toHaveBeenCalledOnce();
    spy.mockRestore();
    expect(() => file.save(new MemoryGraph())).toThrow("left as it is");
    expect(fs.readFileSync(path.join(dir, "memory.json"), "utf8")).toBe(before);
    expect(memoryFile(dir).load().size.facts).toBe(1);
  });

  it("waits out a lock that comes free in moments", () => {
    memoryFile(dir).save(kept());
    const read = fs.readFileSync;
    let tries = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((f: fs.PathOrFileDescriptor, o: never) => {
      if (String(f).endsWith("memory.json") && ++tries === 1) throw locked();
      return read(f, o);
    }) as typeof fs.readFileSync);
    const onBroken = vi.fn();
    expect(memoryFile(dir, onBroken).load().size.facts).toBe(1);
    expect(onBroken).not.toHaveBeenCalled();
  });

  it("still starts empty and saves when there is no file yet", () => {
    const file = memoryFile(dir);
    expect(file.load().size.facts).toBe(0);
    file.save(kept());
    expect(memoryFile(dir).load().size.facts).toBe(1);
  });
});

describe("a one-shot model call", () => {
  afterEach(() => { vi.useRealTimers(); });
  const session = () => ({
    rpc: { tools: { initializeAndValidate: vi.fn().mockResolvedValue(undefined), getCurrentMetadata: vi.fn().mockResolvedValue({ tools: [] }) } },
    sendAndWait: vi.fn().mockResolvedValue({ data: { content: "Done." } }),
    abort: vi.fn().mockResolvedValue(undefined),
  });
  const call = (client: unknown, purpose?: "project") =>
    copilotOneShot({ client: client as never, model: "m", workDir: os.tmpdir(), log, ...(purpose ? { purpose } : {}) });

  it("gives up when making the session hangs, so Project's controls come back (review 2026-11-04)", async () => {
    vi.useFakeTimers();
    const client = { createSession: vi.fn(() => new Promise(() => undefined)), deleteSession: vi.fn().mockResolvedValue(undefined) };
    const answer = call(client, "project")("system", "prompt", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(SESSION_START_MS);
    expect(await answer).toBeNull();
  });

  it("lets Cancel end a hung start at once, and deletes a session that arrives late", async () => {
    let arrive: (s: unknown) => void = () => undefined;
    const client = { createSession: vi.fn(() => new Promise(done => { arrive = done; })), deleteSession: vi.fn().mockResolvedValue(undefined) };
    const stop = new AbortController();
    const answer = call(client, "project")("system", "prompt", stop.signal);
    await Promise.resolve();
    stop.abort();
    expect(await answer).toBeNull();
    client.deleteSession.mockClear();
    arrive(session());
    await vi.waitFor(() => expect(client.deleteSession).toHaveBeenCalledOnce());
  });

  it("gives a project request longer than a memory call", async () => {
    const s = session();
    const client = { createSession: vi.fn().mockResolvedValue(s), deleteSession: vi.fn().mockResolvedValue(undefined) };
    await call(client, "project")("system", "prompt", new AbortController().signal);
    expect(s.sendAndWait.mock.calls[0][1]).toBe(PROJECT_SHOT_MS);
    await call(client)("system", "prompt", new AbortController().signal);
    expect(s.sendAndWait.mock.calls[1][1]).toBe(ONE_SHOT_MS);
  });
});

describe("the command reviewer's session", () => {
  it("asks nothing of a session that offers a tool (fail closed)", async () => {
    const session = {
      rpc: { tools: { initializeAndValidate: vi.fn().mockResolvedValue(undefined), getCurrentMetadata: vi.fn().mockResolvedValue({ tools: [{ name: "shell" }] }) } },
      sendAndWait: vi.fn(), abort: vi.fn(),
    };
    const client = { createSession: vi.fn().mockResolvedValue(session), deleteSession: vi.fn().mockResolvedValue(undefined) };
    const review = copilotReviewer({ client: client as never, model: "m", workDir: os.tmpdir(), log });
    expect(await review({} as never, new AbortController().signal)).toBeNull();
    expect(session.sendAndWait).not.toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledOnce();
  });
});

describe("the action limit", () => {
  it("counts every task together, so two tasks can't double it", () => {
    const engine = new PolicyEngine({ neverLook: () => [], grants: () => ({ gedit: "act" }), rateLimit: 3, now: () => 1000 });
    const act = (taskId: string) => engine.decide({ taskId, kind: "click", app: "gedit", window: "Notes", target: "Save" } as never);
    const verdicts = ["a", "b", "a", "b"].map(t => act(t));
    expect(verdicts[3]).toMatchObject({ verdict: "deny" });
    expect(verdicts[2].verdict).not.toBe("deny");
  });
});

describe("Tailscale commands", () => {
  const classes = (cmd: string) => classifyCommand(cmd, "bash", contextOf("linux")).findings.map(f => f.cls);

  it("treats opening this computer to the internet as publishing", () => {
    expect(classes("tailscale funnel 8080")).toContain("publish");
    expect(classes("tailscale serve 3000")).toContain("publish");
    expect(classes("tailscale file cp notes.txt laptop:")).toContain("publish");
  });
  it("treats changing the connection as a system change", () => {
    expect(classes("tailscale up")).toContain("system");
    expect(classes("tailscale logout")).toContain("system");
  });
  it("leaves what only prints alone", () => {
    for (const cmd of ["tailscale status", "tailscale ip", "tailscale version", "tailscale funnel status"]) expect(classes(cmd)).toEqual([]);
  });
});

describe("the handle's face", () => {
  it("rests once it has dozed off and settled, and not while it talks", () => {
    const rig = new Rig();
    rig.sleepAfter = 1;
    for (let i = 0; i < 60 * 8; i++) rig.update(1 / 60);
    expect(mayRest(rig.asleep, rig.settled, false)).toBe(true);
    expect(mayRest(rig.asleep, rig.settled, true)).toBe(false);
    rig.wake();
    expect(mayRest(rig.asleep, rig.settled, false)).toBe(false);
  });
});

describe("a question to memory", () => {
  it("doesn't hash the facts again unless they changed, and an edit still does (review 2026-11-04)", async () => {
    const file = { path: "", load: () => new VectorIndex("model"), save: () => undefined, drop() { /* nothing kept */ }, erase() { /* nothing kept */ } };
    const embed = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])));
    const semantic = new SemanticMemory({ dir: "", log, model: () => "model", embedder: { embed, stop: () => undefined } as never, file, indexDelayMs: 0 });
    const graph = new MemoryGraph();
    graph.add({ text: "Likes green tea", about: [{ name: "User" }], source: "user" });
    semantic.changed(graph);
    await semantic.catchUp();
    await new Promise(done => setTimeout(done, 5));
    const facts = vi.spyOn(graph, "fact");
    const all = vi.spyOn(graph, "allFacts");
    semantic.changed(graph, false);
    await new Promise(done => setTimeout(done, 5));
    expect(facts).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    semantic.changed(graph);
    expect(facts).toHaveBeenCalled();
    semantic.stop();
  });
});
