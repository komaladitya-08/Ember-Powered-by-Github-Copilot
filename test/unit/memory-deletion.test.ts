/** Deletion acknowledgements follow durable writes, never optimistic graph/index edits. Fake facts only. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService, UNDO_FORGET_MS } from "../../app/main/memory/service";
import { memoryFile } from "../../app/main/memory/store";
import { SemanticMemory, vectorFile } from "../../app/main/memory/embed";
import { MemoryLearning } from "../../app/main/memory/learning";
import type { Fact } from "../../app/main/memory/graph";
import { applyRefinement, recentFacts } from "../../app/main/memory/refine";
import { FORGET_THAT_MS, NOTHING_TO_FORGET, forgotReply } from "../../app/main/memory/questions";
import { memoryForgottenText } from "../../app/renderer/home/copy";

const dirs: string[] = [];
const failure = () => { throw Object.assign(new Error("read-only filesystem"), { code: "EROFS" }); };
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-delete-")); dirs.push(dir);
  const file = memoryFile(dir), vectors = vectorFile(dir);
  const log = { info: vi.fn(), warn: vi.fn() }, onChange = vi.fn();
  const semantic = new SemanticMemory({ dir, log, file: vectors, model: () => "a".repeat(64), embedder: { embed: async texts => texts.map(() => new Float32Array([1, 0])), stop: vi.fn() } });
  const memory = new MemoryService({ dir, log, file, semantic, onChange });
  return { dir, file, vectors, log, onChange, semantic, memory };
}
async function seed(s: ReturnType<typeof setup>) {
  s.memory.remember("Lives in Leeds", [{ name: "User" }], "Lives in Leeds", "lives_in");
  s.memory.flush(); await s.semantic.catchUp(); s.semantic.flush(); s.onChange.mockClear(); s.log.info.mockClear();
  return s.memory.list()[0].id;
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });

describe("durable memory deletion", () => {
  it.each(["facts", "vectors"])("retains visible facts and reports %s erase failure, then supports retry", async target => {
    vi.useFakeTimers(); const s = setup(); await seed(s);
    const original = s.memory.list();
    const spy = vi.spyOn(target === "facts" ? s.file : s.vectors, "erase").mockImplementation(failure);
    expect(() => s.memory.forgetAll()).toThrow(/couldn't finish deleting/);
    expect(s.memory.list()).toEqual(original);
    expect(s.onChange).not.toHaveBeenCalled();
    expect(s.log.info).not.toHaveBeenCalledWith("memory.forgot_all");
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual(original);
    spy.mockRestore(); s.memory.forgetAll(); s.memory.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.memory.list()).toEqual([]);
    expect(s.semantic.size).toBe(0);
    expect(fs.existsSync(s.file.path)).toBe(false);
    expect(fs.existsSync(s.vectors.path)).toBe(false);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual([]);
  });

  it.each(["facts", "vectors"])("does not acknowledge an individual deletion when the %s write fails", async target => {
    vi.useFakeTimers(); const s = setup(); const id = await seed(s);
    const original = s.memory.list();
    const spy = target === "facts" ? vi.spyOn(s.file, "save").mockImplementation(failure) : vi.spyOn(s.vectors, "erase").mockImplementation(failure);
    expect(() => s.memory.forget(id)).toThrow(/couldn't finish deleting/);
    expect(s.memory.list()).toEqual(original);
    expect(s.onChange).not.toHaveBeenCalled();
    expect(s.log.info.mock.calls.some(([event]) => event === "memory.forgot")).toBe(false);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual(original);
    spy.mockRestore(); expect(s.memory.forget(id)).toBe(true);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual([]);
    expect(s.semantic.size).toBe(0);
    expect(fs.existsSync(s.vectors.path)).toBe(false);
    s.memory.stop();
  });

  it("does not reopen superseded facts until the removal is durable", async () => {
    vi.useFakeTimers(); const s = setup(); await seed(s);
    s.memory.remember("Lives in York", [{ name: "User" }], "Lives in York", "lives_in"); s.memory.flush();
    const id = s.memory.list()[0].id;
    const spy = vi.spyOn(s.file, "save").mockImplementation(failure);
    expect(() => s.memory.forget(id)).toThrow();
    expect(s.memory.list().map(f => f.text)).toEqual(["Lives in York"]);
    spy.mockRestore(); s.memory.forget(id);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list().map(f => f.text)).toEqual(["Lives in Leeds"]);
    s.memory.stop();
  });

  it.each(["index", "view"])("acknowledges a durable individual deletion when its post-commit %s callback fails", async target => {
    vi.useFakeTimers(); const s = setup(), id = await seed(s);
    if (target === "index") vi.spyOn(s.semantic, "changed").mockImplementation(() => { throw new Error("detached index"); });
    else s.onChange.mockImplementation(() => { throw new Error("detached view"); });
    expect(s.memory.forget(id)).toBe(true);
    expect(s.memory.list()).toEqual([]);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual([]);
    expect(fs.existsSync(s.vectors.path)).toBe(false);
    expect(s.log.info).toHaveBeenCalledWith("memory.forgot", { count: 1, reopened: 0 });
    s.memory.stop();
  });

  it("acknowledges complete durable erasure when its view callback fails", async () => {
    vi.useFakeTimers(); const s = setup(); await seed(s);
    s.onChange.mockImplementation(() => { throw new Error("detached view"); });
    expect(() => s.memory.forgetAll()).not.toThrow();
    expect(s.memory.list()).toEqual([]);
    expect(fs.existsSync(s.file.path)).toBe(false);
    expect(fs.existsSync(s.vectors.path)).toBe(false);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual([]);
    s.memory.stop();
  });

  it.each(["one", "all"])("preserves the truthful %s deletion failure even when optional index recovery also fails", async scope => {
    vi.useFakeTimers(); const s = setup(), id = await seed(s), original = s.memory.list();
    vi.spyOn(s.semantic, "changed").mockImplementation(() => { throw new Error("detached index"); });
    const persist = scope === "one" ? vi.spyOn(s.file, "save").mockImplementation(failure) : vi.spyOn(s.file, "erase").mockImplementation(failure);
    expect(() => scope === "one" ? s.memory.forget(id) : s.memory.forgetAll()).toThrow(/couldn't finish deleting/);
    expect(s.memory.list()).toEqual(original);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list()).toEqual(original);
    expect(s.onChange).not.toHaveBeenCalled();
    persist.mockRestore(); s.memory.stop();
  });

  it("retires learned lines and recent facts after durable deletion even if their observers fail", () => {
    vi.useFakeTimers(); const s = setup();
    const forgot = vi.fn(() => { throw new Error("detached learned line"); });
    const forgotAll = vi.fn(() => { throw new Error("detached conversation"); });
    const l = new MemoryLearning({ memory: s.memory, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined,
      idle: () => false, locked: () => false, say: () => false, onForgot: forgot, onForgotAll: forgotAll, log: s.log });
    l.introduce({ name: "Ram" }); s.memory.flush();
    const id = s.memory.list()[0].id;
    expect(l.forget(id)).toBe(true);
    expect(forgot).toHaveBeenCalledWith(id, expect.objectContaining({ undo: expect.any(String) }));
    // Nothing kept lately: said so in code, never left to the model (memory-v1).
    expect(l.intent("forget that", { own: true })).toBe(NOTHING_TO_FORGET);
    l.introduce({ work: "Artist" }); s.memory.flush();
    const original = s.memory.list(), erase = vi.spyOn(s.file, "erase").mockImplementation(failure);
    expect(() => l.forgetAll()).toThrow(/couldn't finish deleting/);
    expect(forgotAll).not.toHaveBeenCalled();
    expect(s.memory.list()).toEqual(original);
    erase.mockRestore();
    expect(() => l.forgetAll()).not.toThrow();
    expect(forgotAll).toHaveBeenCalledOnce();
    expect(s.memory.list()).toEqual([]);
    // Nothing kept lately: said so in code, never left to the model (memory-v1).
    expect(l.intent("forget that", { own: true })).toBe(NOTHING_TO_FORGET);
    s.memory.stop();
  });

  it("does not silently skip unreadable vectors while the model is off", async () => {
    vi.useFakeTimers(); const s = setup(); const id = await seed(s); s.memory.stop();
    const off = new SemanticMemory({ dir: s.dir, log: s.log, model: () => null, embedder: { embed: vi.fn(), stop: vi.fn() } });
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === s.vectors.path) return failure();
      return read(...args);
    });
    expect(() => off.forget(id)).toThrow(/read-only/);
    off.stop();
  });

  it("a delayed embedding cannot restore a successfully deleted fact", async () => {
    vi.useFakeTimers(); const s = setup(); const id = await seed(s);
    s.memory.remember("Likes tea", [{ name: "User" }], "Likes tea");
    const pending = s.semantic.catchUp();
    s.memory.forget(id); await pending; await vi.advanceTimersByTimeAsync(5000); s.semantic.flush();
    expect(s.vectors.load("a".repeat(64)).ids()).not.toContain(id);
    s.memory.forgetAll(); await s.semantic.catchUp(); s.semantic.flush();
    expect(fs.existsSync(s.vectors.path)).toBe(false); s.memory.stop();
  });
});

describe("forgetting a fact forgets what Ember made from it (memory-3)", () => {
  /** Two of the user's facts, then one idle pass's summary and guess drawn from them both. */
  function refined() {
    const s = setup();
    s.memory.remember("Works at Globex on the billing team", [{ name: "User", kind: "person" }, { name: "Globex", kind: "organisation" }], "remember that I work at Globex on the billing team");
    s.memory.remember("Has a medical appointment every Tuesday", [{ name: "User", kind: "person" }], "remember that I have a medical appointment every Tuesday");
    let shown: Fact[] = [];
    s.memory.refine(g => { shown = recentFacts(g, null); return 0; });
    s.memory.refine(g => {
      const r = applyRefinement(g, {
        summaries: [{ entity: "User", summary: "Works at Globex on billing and has a medical appointment every Tuesday" }], contradictions: [],
        reflections: [{ fact: "Is usually busy on Tuesdays because of medical appointments", about: [{ name: "User", kind: "person" }], from: shown.map(f => f.id) }],
      }, shown);
      return r.summaries + r.reflections;
    });
    const id = (start: string) => s.memory.list().find(i => i.text.startsWith(start))!.id;
    return { ...s, id };
  }

  it("leaves none of a forgotten fact's summary or guess in the list or in what goes to Copilot", async () => {
    const s = refined();
    expect(s.memory.list().map(i => [i.text, i.kind ?? null])).toEqual(expect.arrayContaining([
      ["Works at Globex on billing and has a medical appointment every Tuesday", "summary"],
      ["Is usually busy on Tuesdays because of medical appointments", "guess"],
    ]));
    expect(s.memory.forget(s.id("Has a medical"))).toBe(true);
    expect(s.memory.list().map(i => i.text)).toEqual(["Works at Globex on the billing team"]);
    const sent = await s.memory.context("Am I free on Tuesday? Medical appointment?");
    expect(sent).not.toMatch(/Tuesday|medical/i);
    expect(new MemoryService({ dir: s.dir, log: s.log }).list().map(i => i.text)).toEqual(["Works at Globex on the billing team"]);
    s.memory.stop();
  });

  it("forgets what Ember made from a fact the user corrects, since it holds the old words", () => {
    const s = refined();
    const fact = s.memory.list().find(i => i.text.startsWith("Has a medical"))!;
    s.memory.correct(fact, "Has a dentist appointment every Tuesday");
    expect(s.memory.list().map(i => i.text).sort()).toEqual(["Has a dentist appointment every Tuesday", "Works at Globex on the billing team"]);
    s.memory.stop();
  });

  it("keeps the notes and their vectors when a correction that would forget them can't be saved (memory-3)", async () => {
    const s = refined();
    await s.semantic.catchUp();
    const before = s.memory.list(), vectors = s.semantic.size;
    const fact = before.find(i => i.text.startsWith("Has a medical"))!;
    const save = vi.spyOn(s.file, "save").mockImplementation(failure);
    expect(() => s.memory.correct(fact, "Has a dentist appointment every Tuesday")).toThrow(/couldn't save this correction/);
    save.mockRestore();
    expect(s.memory.list()).toEqual(before);
    await s.semantic.catchUp();
    expect(s.semantic.size).toBe(vectors);
    s.memory.stop();
  });

  it("also forgets an older summary of the same thing that has no record of what it came from", () => {
    const s = setup();
    s.memory.remember("Has a medical appointment every Tuesday", [{ name: "User", kind: "person" }], "remember that I have a medical appointment every Tuesday");
    s.memory.refine(g => g.add({ text: "Has a medical appointment every Tuesday and works late", about: [{ name: "User" }], predicate: "summary", single: true, source: "conversation", confidence: 0.5 }).kind === "added" ? 1 : 0);
    const fact = s.memory.list().find(i => i.text === "Has a medical appointment every Tuesday")!;
    expect(s.memory.forget(fact.id)).toBe(true);
    expect(s.memory.list()).toEqual([]);
    s.memory.stop();
  });

  it("says how many of Ember's own notes went with it", () => {
    const s = refined();
    expect(s.memory.forgetCounted(s.id("Has a medical"))).toEqual({ text: "Has a medical appointment every Tuesday", derived: 2, undo: expect.any(String) });
    expect(forgotReply("Has a medical appointment every Tuesday", 2)).toBe("Forgotten: “Has a medical appointment every Tuesday”, and 2 notes I made from it.");
    expect(forgotReply("Likes tea", 1)).toBe("Forgotten: “Likes tea”, and a note I made from it.");
    expect(forgotReply("Likes tea")).toBe("Forgotten: “Likes tea”.");
    s.memory.stop();
  });
});

describe("Undo after Forget (memory-v2, memory-7)", () => {
  it("puts a forgotten fact back exactly, with what it had replaced closed again and its vector, for a short while", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-07T10:00:00Z") });
    const s = setup();
    s.memory.remember("Lives in Leeds", [{ name: "User" }], "I live in Leeds", "lives_in");
    s.memory.remember("Lives in York", [{ name: "User" }], "I live in York", "lives_in");
    s.memory.flush(); await s.semantic.catchUp();
    const before = s.file.load().toJSON();
    const york = s.memory.list().find(i => i.text === "Lives in York")!;
    const gone = s.memory.forgetCounted(york.id)!;
    expect(s.memory.list().map(i => i.text)).toEqual(["Lives in Leeds"]);
    expect(s.memory.restore(gone.undo)).toBe(true);
    expect(s.file.load().toJSON()).toEqual(before);
    expect(s.memory.list().map(i => i.text)).toEqual(["Lives in York"]);
    await s.semantic.catchUp();
    expect(s.semantic.size).toBe(2);
    // Once only, and not after UNDO_FORGET_MS or Forget everything.
    expect(s.memory.restore(gone.undo)).toBe(false);
    const again = s.memory.forgetCounted(york.id)!;
    vi.advanceTimersByTime(UNDO_FORGET_MS + 1);
    expect(s.memory.restore(again.undo)).toBe(false);
    const leeds = s.memory.forgetCounted(s.memory.list()[0].id)!;
    s.memory.forgetAll();
    expect(s.memory.restore(leeds.undo)).toBe(false);
    expect(s.memory.list()).toEqual([]);
    s.memory.stop();
  });

  it("puts back Ember's notes that went with the fact", () => {
    const s = setup();
    s.memory.remember("Has a medical appointment every Tuesday", [{ name: "User", kind: "person" }], "remember that I have a medical appointment every Tuesday");
    const fact = s.memory.list()[0];
    s.memory.refine(g => g.add({ text: "Is busy on Tuesdays", about: [{ name: "User" }], predicate: "reflection", source: "conversation", derivedFrom: [fact.id] }).kind === "added" ? 1 : 0);
    const before = s.memory.list();
    const gone = s.memory.forgetCounted(fact.id)!;
    expect(s.memory.list()).toEqual([]);
    expect(s.memory.restore(gone.undo)).toBe(true);
    expect(s.memory.list()).toEqual(before);
    s.memory.stop();
  });
});

describe("Forget of what holds now (memory-12)", () => {
  const learning = (s: ReturnType<typeof setup>, now: () => number) => new MemoryLearning({ memory: s.memory, inForce: () => true, questionsOn: () => false, askedAt: () => null,
    setAskedAt: () => undefined, idle: () => false, locked: () => false, say: () => false, log: s.log, now });
  const texts = (s: ReturnType<typeof setup>) => s.memory.list().map(i => i.text);

  it("forgets only that when the user forgets their current employer, never bringing the old one back as current", () => {
    let now = Date.parse("2026-11-07T10:00:00Z");
    const s = setup(), l = learning(s, () => now);
    s.memory.remember("Works at Globex", [{ name: "User" }], "I work at Globex", "works_at");
    s.memory.remember("Works at Initech", [{ name: "User" }], "I work at Initech", "works_at");
    now += 60_000;
    const initech = s.memory.list()[0].id;
    expect(texts(s)).toEqual(["Works at Initech"]);
    // Home's Forget (and forget_memory) of a fact Ember didn't keep just now.
    const gone = l.forgetCounted(initech)!;
    expect(gone.back).toBeUndefined();
    expect(texts(s)).toEqual([]);
    // Globex is still what used to be true.
    expect(s.memory.recall("Globex", 6, true).map(r => [r.fact.text, !!r.fact.invalidAt])).toEqual([["Works at Globex", true]]);
    // Undo puts back exactly what went.
    expect(l.restore(gone.undo)).toBe(true);
    expect(texts(s)).toEqual(["Works at Initech"]);
    s.memory.stop();
  });

  it("puts the old value back, and says so, when it undoes what Ember kept just now", () => {
    let now = Date.parse("2026-11-07T10:00:00Z");
    const s = setup(), l = learning(s, () => now);
    s.memory.remember("Works at Globex", [{ name: "User" }], "I work at Globex", "works_at");
    // Ember keeps the new value in this conversation ("Ember learned" with Undo, or "forget that" just after).
    const tools = l.conductorMemory();
    tools.remember("Works at Initech", [{ name: "User" }], "I work at Initech now", "works_at");
    expect(texts(s)).toEqual(["Works at Initech"]);
    now += 60_000;
    expect(l.intent("forget that", { own: true })).toBe("Forgotten: “Works at Initech”. I remember “Works at Globex” again.");
    expect(texts(s)).toEqual(["Works at Globex"]);
    // The same through the list's Forget soon after; but not once it is no longer just now.
    tools.remember("Works at Initech", [{ name: "User" }], "I work at Initech now", "works_at");
    const soon = l.forgetCounted(s.memory.list()[0].id)!;
    expect(soon.back).toEqual(["Works at Globex"]);
    expect(memoryForgottenText(soon.text, soon.derived, soon.back)).toBe("Forgotten: “Works at Initech”. Ember remembers “Works at Globex” again.");
    tools.remember("Works at Initech", [{ name: "User" }], "I work at Initech now", "works_at");
    now += FORGET_THAT_MS + 1;
    expect(l.forgetCounted(s.memory.list()[0].id)!.back).toBeUndefined();
    expect(texts(s)).toEqual([]);
    expect(forgotReply("Works at Initech", 0, [])).toBe("Forgotten: “Works at Initech”.");
    expect(memoryForgottenText("Works at Initech", 1, ["Works at Globex", "Works at Hooli"])).toBe("Forgotten: “Works at Initech”, and a note Ember made from it. Ember remembers “Works at Globex” and “Works at Hooli” again.");
    s.memory.stop();
  });
});

describe("what used to be true, in Settings › Memory (memory-c7-2)", () => {
  async function moved() {
    const s = setup();
    s.memory.remember("Lives at 12 Mill Lane, Leeds", [{ name: "User" }], "I live at 12 Mill Lane, Leeds", "lives_at");
    s.memory.remember("Lives at 4 Abbey Road, York", [{ name: "User" }], "I live at 4 Abbey Road, York now", "lives_at");
    s.memory.flush(); await s.semantic.catchUp();
    const onDisk = () => (JSON.parse(fs.readFileSync(path.join(s.dir, "memory.json"), "utf8")) as { facts: Fact[] }).facts.map(f => f.text);
    return { s, onDisk };
  }

  it("lists a replaced fact after what holds now, saying since when it is no longer true, so it can be reviewed (memory-c7-2)", async () => {
    const { s } = await moved();
    expect(s.memory.list().map(r => r.text)).toEqual(["Lives at 4 Abbey Road, York"]);
    const review = s.memory.review();
    expect(review.map(r => [r.text, typeof r.until])).toEqual([["Lives at 4 Abbey Road, York", "undefined"], ["Lives at 12 Mill Lane, Leeds", "string"]]);
    expect(Number.isNaN(Date.parse(review[1].until!))).toBe(false);
  });

  it("forgets a replaced fact from the list and from memory.json, leaves what holds now alone, and Undo puts it back as history (memory-c7-2)", async () => {
    const { s, onDisk } = await moved();
    const old = s.memory.review()[1];
    const gone = s.memory.forgetCounted(old.id, false)!;
    expect(gone.text).toBe("Lives at 12 Mill Lane, Leeds");
    expect(gone.back).toBeUndefined();
    expect(onDisk()).toEqual(["Lives at 4 Abbey Road, York"]);
    expect(s.memory.review().map(r => r.text)).toEqual(["Lives at 4 Abbey Road, York"]);
    expect(s.memory.recall("where did I live in Leeds", 8, true).map(r => r.fact.text)).not.toContain("Lives at 12 Mill Lane, Leeds");
    expect(s.memory.restore(gone.undo)).toBe(true);
    expect(s.memory.review().map(r => [r.text, !!r.until])).toEqual([["Lives at 4 Abbey Road, York", false], ["Lives at 12 Mill Lane, Leeds", true]]);
  });

  it("still lists the old value once the current one is forgotten, and gives forget_memory its words so the user can ask for it to go (memory-c7-2)", async () => {
    const { s, onDisk } = await moved();
    s.memory.forgetCounted(s.memory.list()[0].id, false);
    expect(s.memory.list()).toEqual([]);
    const review = s.memory.review();
    expect(review.map(r => r.text)).toEqual(["Lives at 12 Mill Lane, Leeds"]);
    expect(s.memory.factText(review[0].id)).toBe("Lives at 12 Mill Lane, Leeds");
    expect(s.memory.forget(review[0].id, false)).toBe(true);
    expect(onDisk()).toEqual([]);
  });

  /** A fact of the user's and `n` wordings of Ember's summary of it, each closing the one before, as a sleep-time pass adds them. */
  function reworded(n: number) {
    const s = setup();
    s.memory.remember("Works on Atlas", [{ name: "User" }], "I work on Atlas");
    const from = s.memory.list()[0].id;
    for (let i = 1; i <= n; i++) {
      s.memory.refine(g => g.add({ text: `Summary v${i}: works on Atlas`, about: [{ name: "User" }], predicate: "summary", single: true, source: "conversation", confidence: 0.6, derivedFrom: [from] }).kind === "added" ? 1 : 0);
    }
    s.memory.flush();
    const onDisk = () => (JSON.parse(fs.readFileSync(path.join(s.dir, "memory.json"), "utf8")) as { facts: Fact[] }).facts.map(f => f.text);
    return { s, from, onDisk };
  }

  it("lists one summary per subject however often Ember rewords it: an earlier wording is not “No longer true” (memory-x7-4)", () => {
    const { s, onDisk } = reworded(6);
    expect(s.memory.review().map(r => [r.text, !!r.until])).toEqual([["Summary v6: works on Atlas", false], ["Works on Atlas", false]]);
    expect(onDisk()).toHaveLength(7);
  });

  it("forgets a summary's earlier wordings with it from Settings, so none is left unseen, and Undo puts them back (memory-x7-4)", () => {
    const { s, onDisk } = reworded(3);
    const gone = s.memory.forgetCounted(s.memory.review()[0].id, false)!;
    expect([gone.text, gone.derived]).toEqual(["Summary v3: works on Atlas", 0]);
    expect(onDisk()).toEqual(["Works on Atlas"]);
    expect(s.memory.review().map(r => r.text)).toEqual(["Works on Atlas"]);
    expect(s.memory.restore(gone.undo)).toBe(true);
    expect(onDisk()).toHaveLength(4);
    expect(s.memory.review().map(r => r.text)).toEqual(["Summary v3: works on Atlas", "Works on Atlas"]);
  });

  it("counts only the notes that were listed when the fact they came from is forgotten, and removes every wording (memory-x7-4)", () => {
    const { s, from, onDisk } = reworded(4);
    expect(s.memory.forgetCounted(from, false)!.derived).toBe(1);
    expect(onDisk()).toEqual([]);
  });

  it("refuses a correction of what is no longer true (memory-c7-2)", async () => {
    const { s } = await moved();
    expect(() => s.memory.correct(s.memory.review()[1], "Lives at 14 Mill Lane, Leeds")).toThrow("This memory changed");
  });
});

