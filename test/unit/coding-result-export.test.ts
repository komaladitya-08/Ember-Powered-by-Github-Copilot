import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCodingReviewExport, type CodingExportEntry, type CodingExportInput, type CodingExportTree } from "../../app/main/agent/coding-result-export";

const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() };
const file = (name: string, value: string | Buffer, executable = false): CodingExportEntry => ({ path: name, kind: "file", bytes: Buffer.isBuffer(value) ? value : Buffer.from(value), executable });
const dir = (name: string): CodingExportEntry => ({ path: name, kind: "directory" });
const tree = (...entries: CodingExportEntry[]): CodingExportTree => ({ binding, entries });
const review = (baseline: CodingExportTree, proposed: CodingExportTree, current = baseline, extra: Partial<CodingExportInput> = {}) => createCodingReviewExport({ binding, baseline, proposed, current, ...extra });

describe("portable isolated-result review formatting", () => {
  it("records text additions, edits, deletions, empty files and directory changes without dropping anything", () => {
    const baseline = tree(file("edited.txt", "old\n"), file("removed.txt", "remove\n"), dir("old-empty"));
    const proposed = tree(file("edited.txt", "new\n"), file("added.txt", "hello\n"), file("empty.txt", ""), dir("new-empty"));
    const result = review(baseline, proposed);
    expect(result.review.changes.map(c => [c.path, c.kind])).toEqual([
      ["added.txt", "add"], ["edited.txt", "modify"], ["empty.txt", "add"], ["new-empty", "add"], ["old-empty", "delete"], ["removed.txt", "delete"],
    ]);
    expect(result.review.changes.find(c => c.path === "old-empty")?.patchUnsupported).not.toEqual([]);
    expect(result.review.patchComplete).toBe(false);
    expect(result.review.textPatch).toContain("deleted file mode 100644");
    expect(result.review.textPatch).toContain("-old\n+new\n");
    expect(JSON.parse(result.json)).toEqual(result.review);
    expect(result.review.purpose).toBe("review-only");
  });

  it("keeps baseline, current and proposed bytes for conflicting edits and unrelated current files", () => {
    const original = tree(file("file.txt", "baseline"));
    const changed = tree(file("file.txt", "proposal"));
    const current = tree(file("file.txt", "user's own edit"), file("new-user-file", "keep my new work"));
    const result = review(original, changed, current).review;
    expect(result.changes[0].conflicts).not.toEqual([]);
    expect(result.textPatch).toBe("");
    for (const [captured, text] of [[result.baseline, "baseline"], [result.proposed, "proposal"], [result.current!, "user's own edit"]] as const) {
      const entry = captured.find(e => e.path === "file.txt")!;
      expect(entry.kind).toBe("file");
      if (entry.kind === "file") expect(Buffer.from(entry.base64, "base64").toString()).toBe(text);
    }
    expect(result.current?.find(e => e.path === "new-user-file")).toMatchObject({ base64: Buffer.from("keep my new work").toString("base64") });
    expect(original.entries[0]).toMatchObject({ bytes: Buffer.from("baseline") });
  });

  it("represents binary, executable-bit and file-to-directory changes explicitly", () => {
    const result = review(tree(file("binary", Buffer.from([0, 255])), file("run.sh", "echo hi\n"), file("replaced", "file")),
      tree(file("binary", Buffer.from([0, 254])), file("run.sh", "echo hi\n", true), dir("replaced"), dir("replaced/empty"))).review;
    expect(result.changes.find(c => c.path === "binary")?.patchUnsupported).toEqual(expect.arrayContaining([expect.stringContaining("Binary")]));
    expect(result.changes.find(c => c.path === "run.sh")?.kind).toBe("metadata");
    expect(result.textPatch).toContain("old mode 100644\nnew mode 100755");
    expect(result.changes.find(c => c.path === "replaced")?.kind).toBe("type-change");
    expect(result.limitations.join(" ")).toContain("ACLs");
    expect(result.proposed.find(e => e.path === "binary")).toMatchObject({ base64: "AP4=" });
  });

  it("flags changed directory contents and parents while preserving the complete current tree", () => {
    const baseline = tree(dir("folder"), file("folder/a", "old"));
    const proposed = tree();
    const current = tree(dir("folder"), file("folder/a", "old"), file("folder/new", "concurrent addition"));
    expect(review(baseline, proposed, current).review.changes.find(c => c.path === "folder")?.conflicts.join(" ")).toContain("current changes");
    const missingParent = tree(file("folder", "replaced by user"));
    expect(review(baseline, tree(dir("folder"), file("folder/a", "new")), missingParent).review.changes[0].conflicts.join(" ")).toContain("parent directory");
  });

  it("never presents a text patch as complete without a current source capture", () => {
    const result = createCodingReviewExport({ binding, baseline: tree(file("a", "before")), proposed: tree(file("a", "after")) }).review;
    expect(result.patchComplete).toBe(false);
    expect(result.textPatch).toBe("");
    expect(result.changes[0].conflicts.join(" ")).toContain("not captured");
  });

  it("validates every entry including unchanged files and rejects names that alias or escape on another platform", () => {
    const empty = tree();
    for (const name of ["../escape", "/absolute", "a\\b", "C:stream", "a//b", "a/../b", "a.", "a ", "NUL.txt", "com1", "COM¹.txt", "com²", "COM³", "LPT¹.log", "lpt²", "LPT³", "a\nname", "a\u202ename", "e\u0301", "\ud800", "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b"]) {
      expect(() => review(empty, tree(file(name, "data"))), name).toThrow();
    }
    for (const bad of [tree(file("a", "x"), file("A", "y")), tree(file("ß", "x"), file("ss", "y")), tree(file("a", "x"), file("a/b", "y")), tree(file("missing/b", "x"))]) {
      expect(() => review(bad, bad)).toThrow();
    }
    expect(() => review(tree(file("File", "old")), tree(file("file", "new")))).toThrow("Cross-tree case-aliased");
    for (const kind of ["symlink", "hardlink", "socket", "fifo", "mount"]) {
      const bad = tree({ path: "bad", kind, bytes: Buffer.from("x"), executable: false } as unknown as CodingExportEntry);
      expect(() => review(bad, bad)).toThrow("Unsupported");
    }
    const unsupportedMetadata = tree({ ...file("a", "x"), nlink: 2 } as unknown as CodingExportEntry);
    expect(() => review(unsupportedMetadata, unsupportedMetadata)).toThrow("Unsupported");
  });

  it("keeps representable Unicode and spaced filenames in JSON and explicitly omits their patch", () => {
    const result = review(tree(), tree(file("my résumé.txt", "hello"))).review;
    expect(result.proposed[0].path).toBe("my résumé.txt");
    expect(result.changes[0].patchUnsupported.join(" ")).toContain("filename");
    expect(result.patchComplete).toBe(false);
  });

  it("enforces byte, file, entry, depth, output and owner bounds and cancellation", () => {
    const baseline = tree(file("a", "1234"));
    for (const limits of [{ bytes: 3 }, { fileBytes: 3 }, { entries: 1 }, { depth: 1 }, { outputBytes: 5 }]) {
      expect(() => review(baseline, tree(dir("d"), file("d/b", "1234")), baseline, { limits })).toThrow();
    }
    for (const key of ["owner", "session", "snapshot"] as const) {
      expect(() => review(baseline, { ...baseline, binding: { ...binding, [key]: key === "owner" ? "b".repeat(64) : randomUUID() } })).toThrow("another account");
    }
    expect(() => review(baseline, baseline, baseline, { limits: { bytes: Number.MAX_SAFE_INTEGER } })).toThrow("limits");
    const stop = new AbortController(); stop.abort();
    expect(() => review(baseline, baseline, baseline, { signal: stop.signal })).toThrow();
    const shared = Buffer.from(new SharedArrayBuffer(4));
    expect(() => review(tree(file("shared", shared)), tree())).toThrow("Shared mutable");
  });

  it("produces a patch git can check and apply in a disposable copy, including missing final newlines", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-export-patch-"));
    try {
      const baseline = tree(file("edited", "old"), file("removed", "gone\n"), file("untouched", "keep\n"));
      const proposed = tree(file("edited", "new\nsecond"), file("added", "hello\n"), file("empty", ""), file("untouched", "keep\n"));
      const result = review(baseline, proposed).review;
      expect(result.patchComplete).toBe(true);
      for (const entry of baseline.entries) if (entry.kind === "file") fs.writeFileSync(path.join(root, entry.path), entry.bytes);
      const patchFile = path.join(root, "review.patch");
      fs.writeFileSync(patchFile, result.textPatch);
      const check = spawnSync("git", ["apply", "--check", patchFile], { cwd: root, encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
      const applied = spawnSync("git", ["apply", patchFile], { cwd: root, encoding: "utf8" });
      expect(applied.status, applied.stderr).toBe(0);
      expect(fs.readFileSync(path.join(root, "edited"), "utf8")).toBe("new\nsecond");
      expect(fs.readFileSync(path.join(root, "added"), "utf8")).toBe("hello\n");
      expect(fs.existsSync(path.join(root, "removed"))).toBe(false);
      expect(fs.statSync(path.join(root, "empty")).size).toBe(0);
      expect(fs.readFileSync(path.join(root, "untouched"), "utf8")).toBe("keep\n");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
