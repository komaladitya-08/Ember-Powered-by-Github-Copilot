/**
 * Better recall (app/main/memory/embed.ts, embed-client.ts, better-recall.ts; docs/MEMORY.md §2): the vector index
 * finds the nearest facts and keeps its file as memory.json is kept; the background indexing follows the graph, drops
 * what is forgotten and stops on the kill switch; the memory process is started only when needed and let go when idle;
 * and with no model, memory answers exactly as before. The model itself is faked here (its own test is the benchmark
 * in memory.test.ts, and scripts/memory/bench.mjs).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BetterRecall } from "../../app/main/memory/better-recall";
import { EmbedClient, MAX_FAILURES, type EmbedChild } from "../../app/main/memory/embed-client";
import { SemanticMemory, VectorIndex, documentText, vectorFile, type Embedder } from "../../app/main/memory/embed";
import type { EmbedIn, EmbedOut } from "../../app/main/memory/embed-process";
import { MemoryGraph, type GraphClock } from "../../app/main/memory/graph";
import { MemoryService } from "../../app/main/memory/service";
import { MEMORY_MODEL, MEMORY_MODEL_BYTES } from "../../app/voice/models";

const MODEL = "a".repeat(64);
const quiet = { info: () => undefined, warn: () => undefined };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-embed-"));
const unit = (v: number[]) => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };

function clock(): GraphClock {
  const n = { e: 0, f: 0 };
  return { now: () => new Date("2026-11-01T09:00:00Z"), id: p => `${p}${++n[p]}` };
}

/**
 * A model in miniature: each topic a dimension, so "manager" and "leads the team" land together, as the real model puts
 * them. `calls` records every text it was given.
 */
function fakeEmbedder(): Embedder & { calls: string[]; stopped: number } {
  const topics = [/manager|boss|leads|team/i, /browser|firefox/i, /dog|spaniel|puppy/i, /leeds|city|home/i];
  const e = {
    calls: [] as string[], stopped: 0,
    embed: async (texts: readonly string[]) => texts.map(t => { e.calls.push(t); return unit([...topics.map(r => (r.test(t) ? 1 : 0)), 0.05]); }),
    stop: () => { e.stopped++; },
  };
  return e;
}

afterEach(() => { vi.useRealTimers(); });

describe("the vector index", () => {
  it("finds the nearest facts first, at most k, and none below the floor", () => {
    const index = new VectorIndex(MODEL);
    index.set("f1", "h", unit([1, 0, 0]));
    index.set("f2", "h", unit([1, 1, 0]));
    index.set("f3", "h", unit([0, 0, 1]));
    expect([...index.search(unit([1, 0.1, 0]), 2, 0.2).keys()]).toEqual(["f1", "f2"]);
    expect([...index.search(unit([0, 0, 1]), 8, 0.9).keys()]).toEqual(["f3"]);
  });

  it("keeps its file to the user alone, close to what it held, and moves a broken one aside", () => {
    const dir = tmp();
    const file = vectorFile(dir);
    const index = new VectorIndex(MODEL);
    const v = unit(Array.from({ length: 384 }, (_, i) => Math.sin(i * 1.7)));
    index.set("f1", "0123456789abcdef", v);
    file.save(index);
    if (process.platform !== "win32") expect(fs.statSync(file.path).mode & 0o777).toBe(0o600);
    const back = file.load(MODEL);
    expect(back.has("f1", "0123456789abcdef")).toBe(true);
    // Stored as int8: the cosine with what was saved stays above 0.999.
    expect(back.search(v, 1, 0).get("f1")!).toBeGreaterThan(0.999);
    // Another model's vectors mean nothing to this one.
    expect(file.load("b".repeat(64)).size).toBe(0);
    fs.writeFileSync(file.path, "{ not json");
    let broken = false;
    expect(vectorFile(dir, () => { broken = true; }).load(MODEL).size).toBe(0);
    expect(broken).toBe(true);
    expect(fs.readFileSync(`${file.path}.broken`, "utf8")).toBe("{ not json");
    file.erase();
    expect(fs.existsSync(file.path) || fs.existsSync(`${file.path}.broken`)).toBe(false);
  });

  it("embeds a fact with the names it is about, but not the user's own", () => {
    const g = new MemoryGraph(undefined, clock());
    const r = g.add({ text: "Leads the platform team", about: [{ name: "Priya", kind: "person" }, { name: "User", kind: "person" }], source: "user" });
    expect(r.kind === "added" && documentText(g, r.fact)).toBe("Leads the platform team (Priya)");
  });
});

describe("Better recall's index, as memory changes", () => {
  function setup(o: { model?: () => string | null; waitMs?: number } = {}) {
    const dir = tmp();
    const embedder = fakeEmbedder();
    const semantic = new SemanticMemory({ dir, log: quiet, embedder, model: o.model ?? (() => MODEL), indexDelayMs: 10, ...(o.waitMs ? { waitMs: o.waitMs } : {}) });
    const memory = new MemoryService({ dir, log: quiet, clock: clock(), semantic });
    return { dir, embedder, semantic, memory, file: path.join(dir, "memory-vectors.json") };
  }
  const settle = async () => { await vi.advanceTimersByTimeAsync(2000); };

  it("embeds what is remembered in the background, and finds it by meaning", async () => {
    vi.useFakeTimers();
    const { memory, semantic, embedder, file } = setup();
    memory.remember("Priya leads the platform team", [{ name: "Priya", kind: "person" }], "Priya leads the platform team");
    memory.remember("Prefers Firefox", [{ name: "User" }], "I prefer Firefox");
    expect(embedder.calls).toEqual([]);
    await settle();
    expect(semantic.size).toBe(2);
    expect(fs.existsSync(file)).toBe(true);
    const block = await memory.context("Who is my boss?");
    expect(block).toMatch(/^<memory untrusted="true">\n- \[f1\] \(you told me, 2026-11-01\) Priya leads the platform team\n<\/memory>$/);
  });

  it("never embeds a refused fact", async () => {
    vi.useFakeTimers();
    const { memory, semantic, embedder } = setup();
    expect(memory.remember("My password is hunter2-Secret!", [{ name: "User" }], "my password is hunter2-Secret!")).toMatch(/^Not remembered/);
    await settle();
    expect(semantic.size).toBe(0);
    expect(embedder.calls).toEqual([]);
  });

  it("drops a forgotten fact's vector, and Forget everything deletes the file", async () => {
    vi.useFakeTimers();
    const { memory, semantic, file } = setup();
    memory.remember("Priya leads the platform team", [{ name: "Priya" }], "Priya leads the platform team");
    memory.remember("Walks the dog at 7am", [{ name: "User" }], "I walk the dog at 7am");
    await settle();
    expect(memory.forget("f1")).toBe(true);
    expect(semantic.size).toBe(1);
    await settle();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).rows.map((r: { id: string }) => r.id)).toEqual(["f2"]);
    memory.forgetAll();
    expect(fs.existsSync(file)).toBe(false);
    expect(semantic.size).toBe(0);
  });

  it("drops a forgotten fact's vector from the file also while the model isn't in use", async () => {
    vi.useFakeTimers();
    const dir = tmp();
    let model: string | null = MODEL;
    const semantic = new SemanticMemory({ dir, log: quiet, embedder: fakeEmbedder(), model: () => model, indexDelayMs: 10 });
    const memory = new MemoryService({ dir, log: quiet, clock: clock(), semantic });
    memory.remember("Priya leads the platform team", [{ name: "Priya" }], "Priya leads the platform team");
    memory.remember("Walks the dog at 7am", [{ name: "User" }], "I walk the dog at 7am");
    await settle();
    memory.stop();
    // Ember starts again with memory off (or the model gone), and the user forgets a fact in Settings.
    model = null;
    const later = new MemoryService({ dir, log: quiet, clock: clock(), semantic: new SemanticMemory({ dir, log: quiet, embedder: fakeEmbedder(), model: () => model }) });
    expect(later.forget("f1")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "memory-vectors.json"), "utf8")).rows.map((r: { id: string }) => r.id)).toEqual(["f2"]);
  });

  it("stops embedding on the kill switch, and keeps nothing it was working on", async () => {
    vi.useFakeTimers();
    const { memory, semantic, embedder } = setup();
    let release!: () => void;
    embedder.embed = vi.fn(() => new Promise<Float32Array[]>(resolve => { release = () => resolve([unit([1, 0, 0, 0, 0])]); }));
    memory.remember("Priya leads the platform team", [{ name: "Priya" }], "Priya leads the platform team");
    await settle();
    semantic.stop();
    expect(embedder.stopped).toBe(1);
    release();
    await settle();
    expect(semantic.size).toBe(0);
  });

  it("answers exactly as without Better recall while there is no model, and never starts it", async () => {
    vi.useFakeTimers();
    const off = setup({ model: () => null });
    const plain = new MemoryService({ dir: tmp(), log: quiet, clock: clock() });
    for (const m of [off.memory, plain]) {
      m.remember("Priya leads the platform team", [{ name: "Priya" }], "Priya leads the platform team");
      m.remember("Prefers Firefox", [{ name: "User" }], "I prefer Firefox");
    }
    await settle();
    expect(off.embedder.calls).toEqual([]);
    for (const q of ["Who is my boss?", "Which browser does Priya use?", "Firefox"]) expect(await off.memory.context(q)).toBe(await plain.context(q));
    expect(fs.existsSync(off.file)).toBe(false);
  });

  it("goes on without the model's match when it doesn't come in time", async () => {
    vi.useFakeTimers();
    const { memory, embedder } = setup({ waitMs: 100 });
    memory.remember("Priya leads the platform team", [{ name: "Priya" }], "Priya leads the platform team");
    await settle();
    embedder.embed = () => new Promise(() => undefined);
    const block = memory.context("Who is my boss?");
    await vi.advanceTimersByTimeAsync(150);
    expect(await block).toBe("");
  });
});

describe("Ember's memory process, from main", () => {
  /** A fake process: answers each request with one-dimensional vectors, after loading. */
  function fakeChild(o: { failLoad?: boolean } = {}) {
    const sent: EmbedIn[] = [];
    let onMessage: (m: EmbedOut) => void = () => undefined;
    let onExit: (code: number | null) => void = () => undefined;
    const child: EmbedChild & { killed: boolean } = {
      killed: false,
      postMessage: m => {
        sent.push(m);
        queueMicrotask(() => {
          if (m.type === "init") onMessage(o.failLoad ? { type: "error", message: "bad model" } : { type: "ready", loadMs: 5 });
          else onMessage({ id: m.id, vectors: m.texts.map(() => Float32Array.of(1)) });
        });
      },
      onMessage: fn => { onMessage = fn; },
      onExit: fn => { onExit = fn; },
      kill: () => { child.killed = true; },
    };
    return { child, sent, exit: (code: number) => onExit(code) };
  }

  it("starts only when a vector is asked for, loads the model there, and lets it go when idle", async () => {
    vi.useFakeTimers();
    const children: ReturnType<typeof fakeChild>[] = [];
    const client = new EmbedClient({ spawn: () => { const c = fakeChild(); children.push(c); return c.child; }, paths: () => ({ model: "m.onnx", vocab: "v.txt" }), log: quiet, idleMs: 1000 });
    expect(children).toHaveLength(0);
    expect(await client.embed(["a", "b"])).toHaveLength(2);
    expect(children[0].sent[0]).toEqual({ type: "init", model: "m.onnx", vocab: "v.txt" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(children[0].child.killed).toBe(true);
    await client.embed(["c"]);
    expect(children).toHaveLength(2);
  });

  it("ends at once on a stop, failing what was in flight", async () => {
    const c = fakeChild();
    c.child.postMessage = m => { c.sent.push(m); };
    const client = new EmbedClient({ spawn: () => c.child, paths: () => ({ model: "m", vocab: "v" }), log: quiet });
    const pending = client.embed(["a"]);
    client.stop();
    await expect(pending).rejects.toThrow("stopped");
    expect(c.child.killed).toBe(true);
  });

  it("starts nothing without the model, and gives up after repeated failures", async () => {
    let spawned = 0;
    const none = new EmbedClient({ spawn: () => { spawned++; return fakeChild().child; }, paths: () => null, log: quiet });
    await expect(none.embed(["a"])).rejects.toThrow(/isn't available/);
    expect(spawned).toBe(0);
    const failing = new EmbedClient({ spawn: () => { spawned++; return fakeChild({ failLoad: true }).child; }, paths: () => ({ model: "m", vocab: "v" }), log: quiet });
    for (let i = 0; i < MAX_FAILURES; i++) await expect(failing.embed(["a"])).rejects.toThrow(/didn't load/);
    await expect(failing.embed(["a"])).rejects.toThrow(/isn't available/);
    expect(spawned).toBe(MAX_FAILURES);
  });
});

describe("Better recall's download", () => {
  function setup(memoryOn: boolean) {
    const dir = tmp();
    const statuses: string[] = [];
    let downloads = 0;
    const r = new BetterRecall({
      dir, modelsRoot: path.join(dir, "models"), log: quiet, memoryOn: () => memoryOn,
      fork: () => { throw new Error("not in this test"); },
      // Not the pinned bytes: the checksum refuses them.
      download: async (_url, dest) => { downloads++; fs.writeFileSync(dest, "not the model"); },
      onStatus: s => statuses.push(s.state),
    });
    return { r, statuses, downloads: () => downloads, dir };
  }

  it("is pinned by SHA-256, one model file and its vocabulary, about 23 MB", () => {
    expect(MEMORY_MODEL.map(m => m.target)).toEqual(["all-MiniLM-L6-v2-int8.onnx", "all-MiniLM-L6-v2-vocab.txt"]);
    for (const m of MEMORY_MODEL) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/Xenova\/all-MiniLM-L6-v2\/resolve\/[0-9a-f]{40}\//);
    }
    expect(Math.round(MEMORY_MODEL_BYTES / 1e6)).toBe(23);
  });

  it("fetches nothing while memory is off", async () => {
    const { r, downloads } = setup(false);
    expect(r.status().state).toBe("off");
    await expect(r.download()).rejects.toThrow(/memory/);
    expect(downloads()).toBe(0);
  });

  it("uses nothing that fails its checksum, and says so plainly", async () => {
    const { r, statuses, dir } = setup(true);
    expect(r.status()).toEqual({ state: "absent", bytes: MEMORY_MODEL_BYTES });
    await r.download();
    expect(statuses).toContain("downloading");
    expect(r.status()).toEqual({ state: "absent", bytes: MEMORY_MODEL_BYTES, failed: "The download didn't match what Ember expects, so it wasn't used." });
    expect(fs.readdirSync(path.join(dir, "models"))).toEqual([]);
    expect(r.ready).toBe(false);
  });
});
