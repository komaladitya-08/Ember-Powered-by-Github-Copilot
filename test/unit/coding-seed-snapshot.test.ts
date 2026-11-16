import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import sync from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCodingSeedSnapshot, prepareCodingContinuation, CodingSeedCleanupError } from "../../app/main/agent/coding-seed-snapshot";
import type { CodingExportBinding, CodingExportEntry, CodingExportTree } from "../../app/main/agent/coding-result-export";
import type { CodingProjectManifest } from "../../app/main/agent/coding-project-scope";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const binding = (): CodingExportBinding => ({ owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() });
const old = binding();
const file = (path: string, value: string | Buffer, executable = false): CodingExportEntry => ({ path, kind: "file", bytes: typeof value === "string" ? Buffer.from(value) : value, executable });
const tree = (...entries: CodingExportEntry[]): CodingExportTree => ({ binding: old, entries });
const scope: CodingProjectManifest = { version: 1, source: { excludedRoots: [".git", "node_modules"], omitted: [], byteLimit: 10 * 1024 * 1024 }, dependencies: null };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ember-seed-test-")); roots.push(root);
  const base = path.join(root, "copies"); await fs.mkdir(base, { mode: 0o700 }); return { root, base };
}

describe("host-only continuation capture", () => {
  it("retains the original baseline, clones every byte and rebinds both trees to the new session", () => {
    const fresh = binding(), baseline = tree(file("a", "original")), proposed = tree(file("a", "changed"));
    const captured = prepareCodingContinuation({ baseline, proposed, current: () => true }, fresh, []);
    expect(captured.baseline).toEqual({ binding: fresh, entries: [file("a", "original")] });
    expect(captured.proposed).toEqual({ binding: fresh, entries: [file("a", "changed")] });
    for (const entry of [...baseline.entries, ...proposed.entries]) if (entry.kind === "file") entry.bytes.fill(0);
    expect(captured.baseline.entries).toEqual([file("a", "original")]); expect(captured.proposed.entries).toEqual([file("a", "changed")]);
    expect(captured.baseline.binding).not.toBe(fresh); expect(captured.proposed.binding).not.toBe(fresh);
  });
  it.each(["owner", "session", "snapshot"] as const)("refuses a mismatched proposed %s binding", key => {
    const proposed = { ...tree(file("a", "changed")), binding: { ...old, [key]: key === "owner" ? "b".repeat(64) : randomUUID() } };
    expect(() => prepareCodingContinuation({ baseline: tree(), proposed, current: () => true }, binding(), [])).toThrow();
  });
  it("refuses a different fresh owner and a source scope change", () => {
    const seed = { baseline: tree(file("a", "before")), proposed: tree(file("a", "after")), scope, current: () => true };
    expect(() => prepareCodingContinuation(seed, { ...binding(), owner: "b".repeat(64) }, scope.source.excludedRoots)).toThrow("owner or source scope");
    expect(() => prepareCodingContinuation(seed, binding(), [])).toThrow("owner or source scope");
    expect(() => prepareCodingContinuation({ ...seed, scope: undefined }, binding(), scope.source.excludedRoots)).toThrow("owner or source scope");
    expect(prepareCodingContinuation(seed, binding(), ["node_modules", ".git"]).proposed.entries).toEqual([file("a", "after")]);
  });
  it("refuses an excluded root, aliases, missing parents, shared bytes and oversized files", () => {
    const bad = [tree({ path: ".git", kind: "directory" }), tree(file("a", "one"), file("A", "two")), tree(file("missing/a", "value")),
      tree(file("a", Buffer.from(new SharedArrayBuffer(1)))), tree(file("a", Buffer.alloc(4 * 1024 * 1024 + 1)))];
    for (const proposed of bad) expect(() => prepareCodingContinuation({ baseline: tree(), proposed, scope, current: () => true }, binding(), scope.source.excludedRoots)).toThrow();
    expect(() => prepareCodingContinuation({ baseline: tree({ path: "node_modules", kind: "directory" }), proposed: tree(), scope, current: () => true }, binding(), scope.source.excludedRoots)).toThrow("excluded source root");
  });
  it("respects a smaller declared source byte bound and an aborted privacy intake", () => {
    const seed = { baseline: tree(), proposed: tree(file("a", "123456")), scope: { ...scope, source: { ...scope.source, byteLimit: 5 } }, current: () => true };
    expect(() => prepareCodingContinuation(seed, binding(), scope.source.excludedRoots)).toThrow("too large");
    const controller = new AbortController(), reason = new Error("retired intake"); controller.abort(reason);
    expect(() => prepareCodingContinuation({ baseline: tree(), proposed: tree(), current: () => true }, binding(), [], controller.signal)).toThrow(reason);
  });
});

describe.skipIf(process.platform !== "linux")("fresh fd-relative continuation snapshot", () => {
  it("materializes binary, executable files and empty directories into separate ordinary inodes", async () => {
    const { root, base } = await fixture();
    const source = tree(file("binary", Buffer.from([0, 255, 7])), { path: "empty", kind: "directory" }, { path: "src", kind: "directory" }, file("src/run.sh", "echo okay\n", true));
    const a = await createCodingSeedSnapshot(source, base, [], () => undefined), b = await createCodingSeedSnapshot(source, base, [], () => undefined);
    try {
      expect(await fs.readFile(path.join(a.directory, "binary"))).toEqual(Buffer.from([0, 255, 7]));
      expect(await fs.readdir(path.join(a.directory, "empty"))).toEqual([]);
      expect((await fs.stat(path.join(a.directory, "src/run.sh"))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(a.directory, "binary"))).ino).not.toBe((await fs.stat(path.join(b.directory, "binary"))).ino);
      const outside = path.join(root, "outside"); await fs.writeFile(outside, "keep");
      await fs.writeFile(path.join(a.directory, "added"), "new command output"); await fs.symlink(outside, path.join(a.directory, "link"));
      await a.dispose(); await a.dispose(); expect(await fs.readFile(outside, "utf8")).toBe("keep");
      await expect(fs.stat(a.directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await a.dispose(); await b.dispose(); }
    expect(await fs.readdir(base)).toEqual([]);
  });
  it("cleans an allocated copy when admission is revoked before the first file write", async () => {
    const { base } = await fixture(); let revoked = false;
    await expect(createCodingSeedSnapshot(tree(file("a", "value")), base, [], () => {
      if (sync.readdirSync(base).some(name => sync.existsSync(path.join(base, name, "a")))) revoked = true;
      if (revoked) throw new Error("retired intake");
    })).rejects.toThrow("retired intake");
    expect(revoked).toBe(true); expect(await fs.readdir(base)).toEqual([]);
  });
  it("cleans a freshly created file after a failed write instead of requiring its old content hash", async () => {
    const { base } = await fixture(), original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (typeof args[1] === "number" && (args[1] & sync.constants.O_CREAT)) {
        const write = handle.writeFile.bind(handle); vi.spyOn(handle, "writeFile").mockImplementationOnce(async (...values) => { await write(...values); throw new Error("known write failure"); });
      }
      return handle;
    });
    await expect(createCodingSeedSnapshot(tree(file("a", "value")), base, [], () => undefined)).rejects.toThrow("known write failure");
    expect(await fs.readdir(base)).toEqual([]);
  });
  it("retains both a moved original root and an unrelated replacement after a namespace swap", async () => {
    const { root, base } = await fixture(); let replaced = false;
    await expect(createCodingSeedSnapshot(tree(file("a", "value")), base, [], () => {
      const name = sync.readdirSync(base)[0];
      if (!replaced && name) { replaced = true; sync.renameSync(path.join(base, name), path.join(root, "moved")); sync.mkdirSync(path.join(base, name)); sync.writeFileSync(path.join(base, name, "keep"), "unrelated"); }
    })).rejects.toBeInstanceOf(CodingSeedCleanupError);
    expect(await fs.readFile(path.join(base, (await fs.readdir(base))[0], "keep"), "utf8")).toBe("unrelated");
    expect((await fs.stat(path.join(root, "moved"))).isDirectory()).toBe(true);
  });
  it("retains data and reports terminal cleanup uncertainty after an unverified close", async () => {
    const { base } = await fixture(), original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (typeof args[1] === "number" && (args[1] & sync.constants.O_CREAT)) {
        const close = handle.close.bind(handle); vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); throw new Error("unknown close receipt"); });
      }
      return handle;
    });
    await expect(createCodingSeedSnapshot(tree(file("a", "value")), base, [], () => undefined)).rejects.toBeInstanceOf(CodingSeedCleanupError);
    expect(await fs.readdir(base)).toHaveLength(1);
  });
  it("refuses a private base whose permissions change during materialization", async () => {
    const { base } = await fixture(); let widened = false;
    await expect(createCodingSeedSnapshot(tree(file("a", "value")), base, [], () => {
      if (!widened && sync.readdirSync(base).length) { widened = true; sync.chmodSync(base, 0o755); }
    })).rejects.toBeInstanceOf(CodingSeedCleanupError);
    expect(await fs.readdir(base)).toHaveLength(1); await fs.chmod(base, 0o700);
  });
});
