/** New facts are acknowledged only after their graph write; a failed replacement preserves the durable fact. */
import { describe, expect, it, vi } from "vitest";
import { MemoryGraph } from "../../app/main/memory/graph";
import type { SemanticMemory } from "../../app/main/memory/embed";
import { MemoryLearning } from "../../app/main/memory/learning";
import { MemoryService } from "../../app/main/memory/service";
import type { MemoryFile } from "../../app/main/memory/store";

function service(once = false) {
  let graph = new MemoryGraph();
  let fails = true;
  const save = vi.fn((next: MemoryGraph) => { if (fails) { if (once) fails = false; throw new Error("ENOSPC"); } graph = new MemoryGraph(structuredClone(next.toJSON())); });
  const file: MemoryFile = { path: "/unused/memory.json", load: () => graph, save, erase: () => undefined };
  const changed = vi.fn();
  const semantic = { changed, flush() {}, stop() {} } as unknown as SemanticMemory;
  const memory = new MemoryService({ dir: "/unused", file, semantic, log: { info() {}, warn() {} } });
  return { memory, save, changed, allow: () => { fails = false; }, fail: () => { fails = true; }, stored: () => graph.allFacts(true).map(f => f.text) };
}

describe("durable memory acknowledgement", () => {
  it("refuses the first remember when its write fails, with nothing new kept (memory-r2)", () => {
    const s = service();
    expect(s.memory.remember("Lives in Leeds", [], "I live in Leeds")).toMatch(/^Not remembered:.*couldn't be saved/);
    expect(s.save).toHaveBeenCalledOnce();
    expect(s.memory.trouble).toBe("unsaved");
    expect(s.memory.list()).toEqual([]);
    expect(s.stored()).toEqual([]);
    s.memory.stop();
  });

  it("reports no learnt fact until saved, then recovers without an old warning (memory-r2)", () => {
    const s = service();
    const fact = { text: "Prefers tea", about: [{ name: "User" }], source: "user" as const };
    expect(s.memory.learn(fact)).toMatchObject({ kind: "refused" });
    expect(s.memory.list()).toEqual([]);
    s.allow();
    expect(s.memory.learn(fact)).toMatchObject({ kind: "added" });
    expect(s.memory.trouble).toBeNull();
    expect(s.stored()).toEqual(["Prefers tea"]);
    s.memory.stop();
  });

  it("keeps the old preference and its index when a replacement cannot be saved (memory-r2)", () => {
    const s = service();
    s.allow();
    s.memory.remember("Prefers tea", [], "I prefer tea", "drink");
    s.changed.mockClear();
    s.fail();
    expect(s.memory.remember("Prefers coffee", [], "I prefer coffee", "drink")).toMatch(/^Not remembered:/);
    expect(s.memory.list().map(f => f.text)).toEqual(["Prefers tea"]);
    expect(s.stored()).toEqual(["Prefers tea"]);
    expect(s.changed).not.toHaveBeenCalled();
    s.memory.stop();
  });

  it("doesn't announce a learnt fact or promise to remember an interview answer after a failed write (memory-r2)", () => {
    const s = service();
    const learned = vi.fn();
    const learning = new MemoryLearning({ memory: s.memory, inForce: () => true, questionsOn: () => true,
      askedAt: () => null, setAskedAt() {}, idle: () => true, locked: () => false, say: () => true,
      onLearned: learned, log: { info() {}, warn() {} } });
    const answer = learning.conductorMemory().remember("Lives in Leeds", [], "I live in Leeds");
    expect(answer).toMatch(/^Not remembered:/);
    expect(learned).not.toHaveBeenCalled();
    learning.intent("get to know me", { own: true });
    expect(learning.intent("Call me Ram", { own: true })).toMatch(/couldn't save/);
    expect(learned).not.toHaveBeenCalled();
    expect(s.memory.list()).toEqual([]);
    learning.stopNow(); s.memory.stop();
  });


  it("stops a multi-fact answer at its first failed write even when the next write would work (memory-w7-1)", () => {
    const s = service(true);
    const learned = vi.fn();
    const learning = new MemoryLearning({ memory: s.memory, inForce: () => true, questionsOn: () => true,
      askedAt: () => null, setAskedAt() {}, idle: () => true, locked: () => false, say: () => true,
      onLearned: learned, log: { info() {}, warn() {} } });
    learning.intent("get to know me", { own: true });
    for (let i = 0; i < 3; i++) learning.intent("skip", { own: true });
    expect(learning.intent("short answers and spoken aloud", { own: true })).toMatch(/couldn't save/);
    expect(s.save).toHaveBeenCalledOnce();
    expect(s.memory.list()).toEqual([]);
    expect(learned).not.toHaveBeenCalled();
    expect(learning.intent("UTC", { own: true })).toBeNull();
    learning.stopNow(); s.memory.stop();
  });

});
