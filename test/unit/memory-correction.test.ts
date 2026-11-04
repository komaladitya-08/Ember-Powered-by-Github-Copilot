/** Explicit local memory corrections are exact, durable, private and preserve the source's existing authority. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticMemory, vectorFile } from "../../app/main/memory/embed";
import { FactSchema, SOURCES, type Source } from "../../app/main/memory/graph";
import { MemoryLearning } from "../../app/main/memory/learning";
import { MemoryService, type MemoryItem } from "../../app/main/memory/service";
import { memoryFile } from "../../app/main/memory/store";

const MODEL = "a".repeat(64), NOW = "2026-11-04T12:00:00.000Z";
const cleanup: (() => void)[] = [];
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-correct-"));
  const file = memoryFile(dir), vectors = vectorFile(dir), log = { info: vi.fn(), warn: vi.fn() }, onChange = vi.fn();
  const ids = { e: 0, f: 0 };
  const embed = vi.fn(async (texts: readonly string[]): Promise<Float32Array[]> => texts.map(() => new Float32Array([1, 0])));
  const semantic = new SemanticMemory({ dir, log, file: vectors, model: () => MODEL, embedder: { embed, stop: vi.fn() } });
  const memory = new MemoryService({ dir, file, log, semantic, onChange, clock: { now: () => new Date(NOW), id: p => `${p}${++ids[p]}` } });
  const fixture = { dir, file, vectors, log, onChange, semantic, memory, embed };
  cleanup.push(() => { memory.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return fixture;
}
async function seed(s: ReturnType<typeof setup>, source: Source = "conversation") {
  s.memory.learn({ text: "Prefers green tea", about: [{ name: "User", kind: "person" }], predicate: "tea", source });
  s.memory.flush(); await s.semantic.catchUp(); s.semantic.flush();
  s.onChange.mockClear(); s.log.info.mockClear(); s.log.warn.mockClear(); s.embed.mockClear();
  return s.memory.list()[0];
}
function learning(s: ReturnType<typeof setup>, inForce = () => true) {
  const forgot = vi.fn(), learned = vi.fn();
  const l = new MemoryLearning({ memory: s.memory, inForce, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined,
    idle: () => false, locked: () => false, say: () => false, onForgot: forgot, onLearned: learned, log: s.log });
  return { l, forgot, learned };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const stop of cleanup.splice(0)) stop();
  vi.clearAllTimers(); vi.useRealTimers();
});

describe("durable exact-record memory corrections", () => {
  it.each(SOURCES)("preserves %s provenance and authority and persists before announcing the correction", async source => {
    const s = setup(), expected = await seed(s, source), original = s.file.load().fact(expected.id)!;
    const seen: MemoryItem[][] = [];
    s.onChange.mockImplementation(() => { seen.push(new MemoryService({ dir: s.dir, log: s.log }).list()); });
    const corrected = s.memory.correct(expected, "  Prefers   black tea  ");
    expect(corrected).toEqual({ ...expected, text: "Prefers black tea", revision: 1, correctedAt: NOW });
    expect(s.memory.list()).toEqual([corrected]);
    expect(seen).toEqual([[corrected]]);
    expect(s.file.load().fact(expected.id)).toEqual({ ...original, text: corrected.text, revision: 1, correctedAt: NOW });
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual([corrected]);
    expect(JSON.stringify(s.log.info.mock.calls)).not.toContain("black tea");
  });

  it("keeps the live graph, persisted fact, vectors and learned output unchanged when saving fails, then supports retry", async () => {
    const s = setup(), expected = await seed(s), oldVectors = fs.readFileSync(s.vectors.path, "utf8");
    const changed = vi.spyOn(s.semantic, "changed"), save = vi.spyOn(s.file, "save").mockImplementation(() => { throw new Error("Disk full"); });
    expect(() => s.memory.correct(expected, "Prefers black tea")).toThrow("The original memory is unchanged");
    expect(s.memory.list()).toEqual([expected]);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual([expected]);
    expect(fs.readFileSync(s.vectors.path, "utf8")).toBe(oldVectors);
    expect(s.semantic.size).toBe(1);
    expect(changed).not.toHaveBeenCalled();
    expect(s.onChange).not.toHaveBeenCalled();
    expect(s.log.info).not.toHaveBeenCalledWith("memory.corrected", expect.anything());
    save.mockRestore();
    expect(s.memory.correct(expected, "Prefers black tea").text).toBe("Prefers black tea");
  });

  it("binds every shown identity field, including a monotonically increasing revision that prevents ABA overwrites", async () => {
    const s = setup(), expected = await seed(s), save = vi.spyOn(s.file, "save");
    for (const stale of [{ ...expected, id: "missing" }, { ...expected, text: "Different wording" }, { ...expected, source: "task" as const },
      { ...expected, at: "2026-01-01T00:00:00.000Z" }, { ...expected, revision: 1 }]) {
      expect(() => s.memory.correct(stale, "Prefers black tea")).toThrow("This memory changed");
    }
    expect(save).not.toHaveBeenCalled();
    const second = s.memory.correct(expected, "Prefers black tea");
    const third = s.memory.correct(second, expected.text);
    expect(third.revision).toBe(2);
    expect(third.text).toBe(expected.text);
    expect(() => s.memory.correct(expected, "A stale third change")).toThrow("This memory changed");
    expect(s.memory.list()).toEqual([third]);
  });

  it("refuses a closed record rather than rewriting history", async () => {
    const s = setup(), expected = await seed(s, "user");
    s.memory.learn({ text: "Prefers mint tea", about: [{ name: "User", kind: "person" }], predicate: "tea", single: true, source: "user" });
    s.memory.flush();
    const save = vi.spyOn(s.file, "save");
    expect(() => s.memory.correct(expected, "Prefers black tea")).toThrow("This memory changed");
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["", " ", "x".repeat(401), "My password is hunter2", "Card 4111 1111 1111 1111", "-----BEGIN OPENSSH PRIVATE KEY-----"])("refuses empty, overlong or secret corrections whole (%j)", async text => {
    const s = setup(), expected = await seed(s), save = vi.spyOn(s.file, "save");
    expect(() => s.memory.correct(expected, text)).toThrow();
    expect(s.memory.list()).toEqual([expected]);
    expect(save).not.toHaveBeenCalled(); expect(s.onChange).not.toHaveBeenCalled();
  });

  it("keeps legacy files and lists backwards compatible while validating optional correction metadata", async () => {
    const s = setup(), expected = await seed(s);
    expect(expected).not.toHaveProperty("revision"); expect(expected).not.toHaveProperty("correctedAt");
    const original = s.file.load().fact(expected.id)!;
    expect(FactSchema.parse(original)).toEqual(original);
    expect(FactSchema.safeParse({ ...original, revision: -1 }).success).toBe(false);
    expect(FactSchema.safeParse({ ...original, revision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it("retains correction revisions and provenance markers through consolidation replacements", async () => {
    const s = setup(), expected = await seed(s);
    s.memory.correct(expected, "Prefers black tea");
    const graph = s.file.load(), original = graph.fact(expected.id)!;
    graph.replaceFact({ ...original, uses: 4, revision: undefined, correctedAt: undefined });
    expect(graph.fact(expected.id)).toMatchObject({ uses: 4, revision: 1, correctedAt: NOW, source: expected.source });
    graph.replaceFact({ ...original, revision: 0 });
    expect(graph.fact(expected.id)?.revision).toBe(1);
  });

  it("acknowledges a durable correction even when derived indexing or a view notification fails", async () => {
    const s = setup(), expected = await seed(s);
    vi.spyOn(s.semantic, "changed").mockImplementation(() => { throw new Error("Index unavailable"); });
    s.onChange.mockImplementation(() => { throw new Error("Window closed"); });
    const corrected = s.memory.correct(expected, "Prefers black tea");
    expect(corrected.text).toBe("Prefers black tea");
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual([corrected]);
    expect(s.log.warn).toHaveBeenCalledWith("memory.correction_index_failed");
    expect(s.log.warn).toHaveBeenCalledWith("memory.correction_notify_failed");
    // Failed index preparation must remain lexical, rather than querying a still-old vector.
    const seeds = vi.spyOn(s.semantic, "seeds");
    expect(await s.memory.context("Black tea")).toContain("Prefers black tea");
    expect(seeds).not.toHaveBeenCalled();
  });
});

describe("correction invalidation", () => {
  it("drops a corrected fact's old vector immediately and re-embeds the new sentence", async () => {
    const s = setup(), expected = await seed(s);
    expect(s.semantic.size).toBe(1);
    s.memory.correct(expected, "Prefers black tea");
    expect(s.semantic.size).toBe(0);
    expect(await s.semantic.seeds("Green tea")).toBeUndefined();
    await s.semantic.catchUp();
    expect(s.embed.mock.calls.flatMap(([texts]) => texts)).toContain("Prefers black tea");
    expect(s.semantic.size).toBe(1);
  });

  it("never loads a persisted old-text vector into a corrected graph", async () => {
    const s = setup(), expected = await seed(s);
    s.memory.correct(expected, "Prefers black tea");
    const reopened = new SemanticMemory({ dir: s.dir, file: s.vectors, log: s.log, model: () => MODEL, embedder: { embed: s.embed, stop: vi.fn() } });
    reopened.changed(s.file.load());
    expect(reopened.size).toBe(0);
    expect(await reopened.seeds("Green tea")).toBeUndefined();
    reopened.stop();
  });

  it("binds a restarted service's lazy graph before searching persisted vectors", async () => {
    const s = setup(), expected = await seed(s);
    s.memory.correct(expected, "Prefers black tea");
    const embed = vi.fn(async (texts: readonly string[]): Promise<Float32Array[]> => texts.map(() => new Float32Array([1, 0])));
    const reopened = new SemanticMemory({ dir: s.dir, file: s.vectors, log: s.log, model: () => MODEL, embedder: { embed, stop: vi.fn() } });
    const memory = new MemoryService({ dir: s.dir, log: s.log, semantic: reopened });
    // The model may have warmed its old derived index before memory.json was loaded.
    expect(reopened.size).toBe(1);
    expect(memory.list()[0].text).toBe("Prefers black tea");
    expect(await memory.context("Black tea")).toContain("Prefers black tea");
    expect(reopened.size).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    memory.stop();
  });

  it("retires an embedding of a replaced graph before it can publish stale wording", async () => {
    const s = setup(), expected = await seed(s);
    s.memory.learn({ text: "Works on Atlas", about: [{ name: "User" }], source: "conversation" });
    s.semantic.forget(expected.id);
    let finish: (value: Float32Array[]) => void = () => undefined;
    s.embed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = s.semantic.catchUp();
    s.memory.correct(expected, "Prefers black tea");
    finish([new Float32Array([1, 0]), new Float32Array([1, 0])]);
    await pending;
    // Only the new graph may now populate the cleared corrected fact's vector.
    expect(s.semantic.size).toBe(0);
    await s.semantic.catchUp();
    expect(s.semantic.size).toBe(2);
  });

  it("prunes the old learned line/recent text only after success and invalidates recall already in flight", async () => {
    const s = setup(), { l, forgot, learned } = learning(s);
    l.introduce({ name: "Ram" }); s.memory.flush();
    const expected = s.memory.list()[0];
    let finish: (value: Map<string, number>) => void = () => undefined;
    vi.spyOn(s.semantic, "seeds").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = l.conductorMemory().forRequest("What should Ember call me?", true);
    l.correct(expected, "Likes to be called Ravi");
    finish(new Map([[expected.id, 1]]));
    expect(await pending).toBe("");
    expect(forgot).toHaveBeenCalledExactlyOnceWith(expected.id);
    expect(learned).not.toHaveBeenCalled();
    expect(l.intent("forget that", { own: true })).toBeNull();
    l.stopNow();
  });

  it("doesn't prune learned lines on failure and refuses a correction acquired before consent is withdrawn", async () => {
    const s = setup(); let on = true;
    const { l, forgot } = learning(s, () => on);
    l.introduce({ name: "Ram" }); s.memory.flush();
    const expected = s.memory.list()[0], save = vi.spyOn(s.file, "save").mockImplementation(() => { throw new Error("Disk full"); });
    expect(() => l.correct(expected, "Likes to be called Ravi")).toThrow();
    expect(forgot).not.toHaveBeenCalled();
    save.mockRestore(); on = false;
    expect(() => l.correct(expected, "Likes to be called Ravi")).toThrow("Turn on memory");
    expect(s.memory.list()).toEqual([expected]);
    on = true;
    expect(l.intent("forget that", { own: true })).toContain("Forgotten");
    l.stopNow();
  });

  it("doesn't report a committed correction as failed when the old learned-line notification fails", async () => {
    const s = setup(), expected = await seed(s), { l, forgot } = learning(s);
    forgot.mockImplementation(() => { throw new Error("Window closed"); });
    expect(l.correct(expected, "Prefers black tea").text).toBe("Prefers black tea");
    expect(s.log.warn).toHaveBeenCalledWith("memory.correction_notice_failed");
    l.stopNow();
  });

  it("aborts a refinement still describing the old sentence", async () => {
    vi.useRealTimers();
    const s = setup(), expected = await seed(s), { l } = learning(s);
    s.memory.learn({ text: "Works on Atlas", about: [{ name: "User" }], source: "user" });
    let finish: (value: string) => void = () => undefined, signal: AbortSignal | undefined;
    let started: () => void = () => undefined;
    const modelStarted = new Promise<void>(resolve => { started = resolve; });
    l.setModel(async (_system, _prompt, abort) => { signal = abort; started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = l.refine(); await modelStarted;
    l.correct(expected, "Prefers black tea");
    expect(signal?.aborted).toBe(true);
    finish(JSON.stringify({ summaries: [{ entity: "User", summary: "Prefers green tea and works on Atlas" }] }));
    expect(await pending).toBe(0);
    expect(s.memory.list().some(row => row.text.includes("green tea"))).toBe(false);
    l.stopNow();
  });

  it("prevents an extraction already reading old words from reintroducing the corrected sentence", async () => {
    const s = setup(), expected = await seed(s), { l } = learning(s);
    let finish: (value: string) => void = () => undefined, signal: AbortSignal | undefined;
    l.setModel(async (_system, _prompt, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); });
    l.conductorMemory().heard("I prefer green tea", "Tea is noted.", true);
    const pending = l.flush();
    expect(signal).toBeDefined();
    l.correct(expected, "Prefers black tea");
    expect(signal?.aborted).toBe(true);
    finish(JSON.stringify({ facts: [{ from: 1, fact: "Prefers green tea", confidence: 0.9, evidence: "I prefer green tea" }] }));
    expect(await pending).toBe(0);
    expect(s.memory.list().map(row => row.text)).toEqual(["Prefers black tea"]);
    l.stopNow();
  });
});
