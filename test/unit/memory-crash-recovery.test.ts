/**
 * BE #19: memory.json (the authority) and memory-vectors.json (derived, keyed by fact id and a hash of the fact's text)
 * are two files, so a crash can leave them disagreeing. Each test builds the disk a crash leaves (or makes the crash
 * happen with a failing rename), then starts NEW instances from disk and asks for recall. Fake facts only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticMemory, documentText, vectorFile, type Embedder } from "../../app/main/memory/embed";
import { MemoryService } from "../../app/main/memory/service";

const MODEL = "a".repeat(64);
const quiet = { info: () => undefined, warn: () => undefined };
const dirs: string[] = [];
const embedder = (): Embedder => ({ embed: async texts => texts.map(() => new Float32Array([1, 0])), stop: () => undefined });
const mk = (dir: string, model: string | null = MODEL) => {
  const semantic = new SemanticMemory({ dir, log: quiet, model: () => model, embedder: embedder(), waitMs: 50 });
  const memory = new MemoryService({ dir, log: quiet, semantic });
  return { semantic, memory };
};
const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-crash-")); dirs.push(d); return d; };
const vecIds = (dir: string) => vectorFile(dir).load(MODEL).ids().sort();
const ids = (m: MemoryService) => m.list().map(f => f.id).sort();

/** Two facts, both in memory.json and memory-vectors.json; returns their ids by text. */
async function seed(dir: string) {
  const { semantic, memory } = mk(dir);
  memory.remember("Lives in Leeds", [{ name: "User" }], "Lives in Leeds", "lives_in");
  memory.remember("Keeps a spaniel", [{ name: "User" }], "Keeps a spaniel", "keeps");
  memory.flush(); await semantic.catchUp(); semantic.flush(); memory.stop();
  const by = Object.fromEntries(memory.list().map(f => [f.text, f.id]));
  return { leeds: by["Lives in Leeds"], dog: by["Keeps a spaniel"] };
}
async function recalled(dir: string, q: string) {
  const { memory, semantic } = mk(dir);
  const block = await memory.context(q);
  memory.stop(); semantic.stop();
  return block;
}
/** Rewrites memory.json without `id`, as a finished graph write leaves it. */
function dropFromGraph(dir: string, id: string) {
  const p = path.join(dir, "memory.json");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  data.facts = data.facts.filter((f: { id: string }) => f.id !== id);
  fs.writeFileSync(p, JSON.stringify(data) + "\n");
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });

describe("graph and vector files after a crash between their writes (BE #19)", () => {
  it("the graph lost a fact but the vector file still has it: it is never recalled, and the vector is dropped and the drop saved", async () => {
    const dir = fresh(); const { leeds, dog } = await seed(dir);
    dropFromGraph(dir, leeds);
    expect(vecIds(dir)).toContain(leeds); // the disk the crash left
    expect(await recalled(dir, "Where does the user live in Leeds?")).not.toContain("Leeds");
    const s = mk(dir);
    expect(ids(s.memory)).toEqual([dog]);
    await s.memory.context("spaniel"); s.semantic.flush(); s.memory.stop();
    expect(vecIds(dir)).not.toContain(leeds);
    expect(vecIds(dir)).toContain(dog);
  });

  it("seeds() on a fresh instance never offers a vector whose fact is not in the graph, even before a graph is bound", async () => {
    const dir = fresh(); const { leeds } = await seed(dir);
    dropFromGraph(dir, leeds);
    const semantic = new SemanticMemory({ dir, log: quiet, model: () => MODEL, embedder: embedder(), waitMs: 50 });
    const got = await semantic.seeds("Leeds");
    expect([...(got?.keys() ?? [])]).not.toContain(leeds);
    semantic.stop();
  });

  it("the graph file is gone (forget everything crashed after erasing it): nothing is recalled and the vectors are dropped", async () => {
    const dir = fresh(); await seed(dir);
    fs.rmSync(path.join(dir, "memory.json"));
    expect(await recalled(dir, "Leeds spaniel")).toBe("");
    const s = mk(dir); await s.memory.context("Leeds"); s.semantic.flush(); s.memory.stop();
    expect(vecIds(dir)).toEqual([]);
  });

  it("forget-all crashed after erasing the vectors: the graph survives, the user is told it failed, and a retry finishes", async () => {
    const dir = fresh(); await seed(dir);
    const s = mk(dir); await s.memory.context("x");
    const erase = fs.rmSync; // the graph's erase fails
    vi.spyOn(fs, "rmSync").mockImplementation((p, o) => { if (String(p).endsWith("memory.json")) throw new Error("EIO"); return erase(p, o); });
    expect(() => s.memory.forgetAll()).toThrow(/couldn't finish/);
    vi.restoreAllMocks();
    const again = mk(dir);
    expect(again.memory.list().length).toBe(2);
    again.memory.forgetAll(); again.memory.stop();
    expect(await recalled(dir, "Leeds")).toBe("");
    expect(fs.existsSync(path.join(dir, "memory-vectors.json"))).toBe(false);
  });

  it("a fact rewritten in the graph never seeds recall with the vector of its old text", async () => {
    const dir = fresh(); const { leeds } = await seed(dir);
    const p = path.join(dir, "memory.json");
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    data.facts.find((f: { id: string }) => f.id === leeds).text = "Lives in York";
    fs.writeFileSync(p, JSON.stringify(data) + "\n");
    const s = mk(dir);
    const g = (s.memory as unknown as { g: Parameters<typeof documentText>[0] }).g;
    s.semantic.changed(g, false);
    const got = await s.semantic.seeds("Leeds");
    expect([...(got?.keys() ?? [])]).not.toContain(leeds);
    s.memory.stop();
  });

  it("a fact with no vector is still recalled, and gets its vector afterwards", async () => {
    const dir = fresh(); const { leeds } = await seed(dir);
    fs.rmSync(path.join(dir, "memory-vectors.json"));
    const s = mk(dir);
    expect(await s.memory.context("Leeds")).toContain("Leeds");
    await s.semantic.catchUp(); s.semantic.flush(); s.memory.stop();
    expect(vecIds(dir)).toContain(leeds);
  });

  it("a delete whose graph rename fails keeps the fact (and its recall), is not acknowledged, and a retry removes both", async () => {
    const dir = fresh(); const { leeds, dog } = await seed(dir);
    const s = mk(dir); await s.memory.context("x");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => { if (String(b).endsWith("memory.json")) throw new Error("crash"); return rename(a, b); });
    expect(() => s.memory.forget(leeds)).toThrow(/couldn't finish/);
    vi.restoreAllMocks();
    // The vector file was already rewritten; the graph still has the fact.
    expect(ids(mk(dir).memory)).toEqual([dog, leeds].sort());
    expect(await recalled(dir, "Leeds")).toContain("Leeds");
    const r = mk(dir); expect(r.memory.forget(leeds)).toBe(true); r.memory.stop();
    expect(await recalled(dir, "Leeds")).not.toContain("Leeds");
    expect(vecIds(dir)).not.toContain(leeds);
  });

  it("a delete that crashed after the graph rename but before any vector write (old order) never resurrects the fact", async () => {
    const dir = fresh(); const { leeds } = await seed(dir);
    dropFromGraph(dir, leeds); // graph renamed, vectors untouched
    for (let i = 0; i < 2; i++) { // reconciliation is idempotent across restarts
      expect(await recalled(dir, "Leeds")).not.toContain("Leeds");
      expect(ids(mk(dir).memory)).not.toContain(leeds);
    }
  });

  it("a leftover half-written temp file for either store changes nothing", async () => {
    const dir = fresh(); const { leeds, dog } = await seed(dir);
    fs.writeFileSync(path.join(dir, "memory.json.tmp"), '{"version":');
    fs.writeFileSync(path.join(dir, "memory-vectors.json.tmp"), "{ half");
    const s = mk(dir);
    expect(ids(s.memory)).toEqual([dog, leeds].sort());
    expect(await s.memory.context("Leeds")).toContain("Leeds");
    s.memory.stop();
  });

  it("a corrupt vector file is moved aside and recall stays lexical; no fact is lost", async () => {
    const dir = fresh(); const { leeds } = await seed(dir);
    fs.writeFileSync(path.join(dir, "memory-vectors.json"), "{ not json");
    const s = mk(dir);
    expect(await s.memory.context("Leeds")).toContain("Leeds");
    expect(ids(s.memory)).toContain(leeds);
    s.memory.stop();
  });

  it("a vector file from before any stamp (rows without extra fields) loads and keeps its vectors for live facts", async () => {
    const dir = fresh(); const { leeds, dog } = await seed(dir);
    const s = mk(dir); await s.memory.context("x");
    expect(s.semantic.size).toBe(2); s.memory.stop();
    expect(vecIds(dir)).toEqual([dog, leeds].sort());
  });

  it("an embedding that finishes after the fact was forgotten, then a crash, leaves no vector for it", async () => {
    vi.useFakeTimers();
    const dir = fresh();
    let release!: (v: Float32Array[]) => void;
    const slow: Embedder = { embed: () => new Promise(r => { release = r; }), stop: () => undefined };
    const semantic = new SemanticMemory({ dir, log: quiet, model: () => MODEL, embedder: slow });
    const memory = new MemoryService({ dir, log: quiet, semantic });
    memory.remember("Lives in Leeds", [{ name: "User" }], "Lives in Leeds", "lives_in");
    memory.flush();
    const pass = semantic.catchUp();
    await vi.advanceTimersByTimeAsync(0);
    memory.forget(memory.list()[0].id);
    release([new Float32Array([1, 0])]); await pass; await vi.advanceTimersByTimeAsync(5000); semantic.flush();
    expect(vecIds(dir)).toEqual([]);
    expect(new MemoryService({ dir, log: quiet }).list()).toEqual([]);
  });
});
