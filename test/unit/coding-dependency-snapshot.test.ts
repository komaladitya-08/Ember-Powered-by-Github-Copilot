/** Real descriptor traversal and link materialisation; no dependency code is executed during copying. */
import fs from "node:fs/promises";
import { appendFileSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodingDependencySnapshot } from "../../app/main/agent/coding-dependency-snapshot";
import { CodingPrivacyScanner, CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ember-dependency-copy-")); roots.push(root);
  const source = path.join(root, "node_modules"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private");
  for (const folder of [source, baseDir, privateDir]) await fs.mkdir(folder, { mode: 0o700 });
  const input = { source: { path: source, current: () => true }, baseDir, protectedPaths: [privateDir] };
  return { root, source, baseDir, privateDir, input };
}
describe.skipIf(process.platform !== "linux")("read-only dependency snapshot primitive", () => {
  it("copies real bytes to independent inodes and materialises in-root file/directory links with receipts", async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.source, "pkg")); await fs.writeFile(path.join(f.source, "pkg", "main.js"), "module.exports = 42;\n");
    await fs.symlink("pkg/main.js", path.join(f.source, "entry.js")); await fs.symlink("pkg", path.join(f.source, "alias"));
    const result = await createCodingDependencySnapshot(f.input);
    try {
      expect((await fs.lstat(path.join(result.directory, "entry.js"))).isFile()).toBe(true);
      expect((await fs.lstat(path.join(result.directory, "alias"))).isDirectory()).toBe(true);
      expect((await fs.stat(path.join(result.directory, "pkg", "main.js"))).ino).not.toBe((await fs.stat(path.join(f.source, "pkg", "main.js"))).ino);
      expect(result.manifest).toMatchObject({ access: "copied-read-only", mount: "/work/node_modules", files: 3,
        materializedLinks: [{ path: "alias", target: "pkg" }, { path: "entry.js", target: "pkg/main.js" }] });
      await fs.writeFile(path.join(f.source, "pkg", "main.js"), "source changed");
      expect(await fs.readFile(path.join(result.directory, "pkg", "main.js"), "utf8")).toBe("module.exports = 42;\n");
    } finally { await result.dispose(); await result.dispose(); }
    expect(await fs.readdir(f.baseDir)).toEqual([]);
  });
  it("refuses external and cyclic links, hardlinks and secret text without retaining a partial tree", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.privateDir, "ordinary.js"), "module.exports = 1;");
    await fs.symlink(path.join(f.privateDir, "ordinary.js"), path.join(f.source, "escape.js"));
    await expect(createCodingDependencySnapshot(f.input)).rejects.toThrow("escaping"); await fs.unlink(path.join(f.source, "escape.js"));
    await fs.mkdir(path.join(f.source, "pkg")); await fs.symlink("..", path.join(f.source, "pkg", "cycle"));
    await expect(createCodingDependencySnapshot(f.input)).rejects.toThrow("cyclic"); await fs.unlink(path.join(f.source, "pkg", "cycle"));
    await fs.writeFile(path.join(f.source, "one.js"), "ordinary"); await fs.link(path.join(f.source, "one.js"), path.join(f.source, "two.js"));
    await expect(createCodingDependencySnapshot(f.input)).rejects.toThrow("hardlinked"); await fs.unlink(path.join(f.source, "two.js"));
    await fs.writeFile(path.join(f.source, "one.js"), "the password is hunter2");
    await expect(createCodingDependencySnapshot(f.input)).rejects.toThrow("secret"); expect(await fs.readdir(f.baseDir)).toEqual([]);
  });
  it("enforces bounded copies and source/private-root grants", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.source, "a.js"), "abcdef");
    await expect(createCodingDependencySnapshot({ ...f.input, limits: { bytes: 5 } })).rejects.toThrow("oversized");
    await expect(createCodingDependencySnapshot({ ...f.input, source: { path: f.source, current: () => false } })).rejects.toThrow("current");
    await expect(createCodingDependencySnapshot({ ...f.input, source: { path: f.baseDir, current: () => true } })).rejects.toThrow("outside");
    const nestedBase = path.join(f.source, "private-copies"); await fs.mkdir(nestedBase, { mode: 0o700 });
    await expect(createCodingDependencySnapshot({ ...f.input, baseDir: nestedBase })).rejects.toThrow("outside");
    expect(await fs.readdir(nestedBase)).toEqual([]);
    await expect(createCodingDependencySnapshot({ ...f.input, source: { path: f.privateDir, current: () => true } })).rejects.toThrow("protected");
    expect(await fs.readdir(f.baseDir)).toEqual([]);
  });
  it("never sizes an allocation/read from a file which grows after its accepted stat", async () => {
    const f = await fixture(), file = path.join(f.source, "growing.js"); await fs.writeFile(file, "abcd");
    const sample = await fs.open(file, "r");
    const methods = Object.getPrototypeOf(sample) as { read(this: fs.FileHandle, buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }> };
    const original = methods.read; await sample.close();
    let grew = false; const reads: number[] = [];
    vi.spyOn(methods, "read").mockImplementation(function (this: fs.FileHandle, buffer, offset, length, position) {
      if (readlinkSync(`/proc/self/fd/${this.fd}`) === file) {
        if (!grew) { appendFileSync(file, Buffer.alloc(9 * 1024 * 1024)); grew = true; }
        reads.push(length);
      }
      return original.call(this, buffer, offset, length, position);
    });
    await expect(createCodingDependencySnapshot(f.input)).rejects.toThrow("changed");
    expect(reads).toEqual([4, 1]); expect(await fs.readdir(f.baseDir)).toEqual([]);
  });
  it("preserves an unknown privacy-worker exit even when private-copy filesystem cleanup also fails", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.source, "ordinary.js"), "module.exports = 1;\n");
    const close = CodingPrivacyScanner.prototype.close, remove = fs.rm;
    vi.spyOn(CodingPrivacyScanner.prototype, "close").mockImplementation(async function (this: CodingPrivacyScanner) {
      await close.call(this); throw new CodingPrivacyCleanupError();
    });
    vi.spyOn(fs, "rm").mockImplementation((target, options) => String(target).includes("ember-coding-dependencies-") ?
      Promise.reject(new Error("Synthetic filesystem cleanup failure")) : remove(target, options));
    await expect(createCodingDependencySnapshot(f.input)).rejects.toBeInstanceOf(CodingPrivacyCleanupError);
  });
});
