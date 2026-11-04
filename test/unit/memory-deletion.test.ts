/** Deletion acknowledgements follow durable writes, never optimistic graph/index edits. Fake facts only. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../../app/main/memory/service";
import { memoryFile } from "../../app/main/memory/store";
import { SemanticMemory, vectorFile } from "../../app/main/memory/embed";
import { MemoryLearning } from "../../app/main/memory/learning";

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
    expect(forgot).toHaveBeenCalledWith(id);
    expect(l.intent("forget that", { own: true })).toBeNull();
    l.introduce({ work: "Artist" }); s.memory.flush();
    const original = s.memory.list(), erase = vi.spyOn(s.file, "erase").mockImplementation(failure);
    expect(() => l.forgetAll()).toThrow(/couldn't finish deleting/);
    expect(forgotAll).not.toHaveBeenCalled();
    expect(s.memory.list()).toEqual(original);
    erase.mockRestore();
    expect(() => l.forgetAll()).not.toThrow();
    expect(forgotAll).toHaveBeenCalledOnce();
    expect(s.memory.list()).toEqual([]);
    expect(l.intent("forget that", { own: true })).toBeNull();
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
