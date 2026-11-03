/** Deletion acknowledgements follow durable writes, never optimistic graph/index edits. Fake facts only. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../../app/main/memory/service";
import { memoryFile } from "../../app/main/memory/store";
import { SemanticMemory, vectorFile } from "../../app/main/memory/embed";

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
