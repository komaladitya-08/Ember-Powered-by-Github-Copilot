/** Real NTFS artifact storage. These tests confer no command/runtime or production-adapter approval. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CodingResultRegistry, CodingResultRegistryError, type CodingResultRegistration } from "../../app/main/agent/coding-result-registry";
import { createCodingReviewExport, type CodingExportTree, type CodingReviewExport } from "../../app/main/agent/coding-result-export";
import { WindowsCodingArtifactStore } from "../../app/main/agent/windows-coding-artifact-store";
import { type CodingArtifactRef, type CodingArtifactReceipt } from "../../app/main/agent/coding-artifact-store";
import * as native from "../../app/main/agent/windows-coding-native";

const A = "a".repeat(64), B = "b".repeat(64), ORIGINAL = "export const answer = 41;\n";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function rendered(text = "export const answer = 42;\n"): CodingReviewExport {
  const binding = { owner: A, session: randomUUID(), snapshot: randomUUID() };
  const tree = (value: string): CodingExportTree => ({ binding, entries: [{ path: "app.ts", kind: "file", bytes: Buffer.from(value), executable: false }] });
  return createCodingReviewExport({ binding, baseline: tree(ORIGINAL), proposed: tree(text), current: tree(ORIGINAL) }).review;
}
const bytes = (review: CodingReviewExport) => ({ "review.json": Buffer.from(JSON.stringify(review, null, 2)), "changes.patch": Buffer.from(review.textPatch) });

describe.skipIf(process.platform !== "win32")("native Windows private review artifacts", () => {
  let root: string, base: string, source: string, destination: string, protectedRoot: string;
  let owner: string | null, current: boolean, project: boolean, registry: CodingResultRegistry, store: WindowsCodingArtifactStore;
  let additionalStores: WindowsCodingArtifactStore[], expectedRetention: boolean, setupComplete: boolean;
  beforeEach(async () => {
    setupComplete = false;
    // Retained hostile scratch must remain outside vitest's best-effort recursive run-temp teardown.
    root = fs.mkdtempSync(path.join(path.dirname(os.tmpdir()), "ember-native-artifacts-"));
    base = path.join(root, "reviews"); source = path.join(root, "source"); destination = path.join(root, "destination"); protectedRoot = path.join(root, "protected");
    for (const directory of [base, source, destination, protectedRoot]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(source, "app.ts"), ORIGINAL); fs.writeFileSync(path.join(protectedRoot, "auth.txt"), "protected-host-canary");
    owner = A; current = true; project = true; additionalStores = []; expectedRetention = false;
    store = await WindowsCodingArtifactStore.create({ privateBase: base, protectedPaths: [protectedRoot] });
    registry = await CodingResultRegistry.create({ privateBase: base, store, currentOwner: () => owner,
      projectExists: id => project && ["project-one", "project-two"].includes(id) });
    setupComplete = true;
  });
  afterEach(async () => {
    vi.restoreAllMocks(); const errors: unknown[] = [];
    if (!setupComplete) { console.info("Native artifact setup failed; synthetic scratch retained without forced cleanup."); return; }
    try { await registry?.close(); } catch (error) { errors.push(error); }
    for (const other of additionalStores.reverse()) { try { await other.close(); } catch (error) { errors.push(error); } }
    if (expectedRetention) {
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors) expect(error).toMatchObject({ code: "cleanup" });
      expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
      expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
      console.info("Native artifact hostile fixture retained after expected exact-cleanup refusal; unrelated canaries verified.");
      return;
    }
    if (!errors.length && root) fs.rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Native artifact cleanup was not verified; synthetic scratch retained.");
  });
  async function registration(review = rendered(), patch: Partial<CodingResultRegistration> = {}): Promise<CodingResultRegistration> {
    const output = await store.write(bytes(review), () => { if (!current) throw new CodingResultRegistryError("stale"); });
    return { expectedOwner: A, projectId: "project-one", taskId: randomUUID(), title: "Fix copied app", sourcePath: source,
      status: "done", checks: { ran: 1, passed: 1, failed: 0 }, current: () => current,
      output: { ...output, review, cleanup: "complete" }, ...patch };
  }
  function onNativeWrite(hook: () => void): void {
    const load = native.loadWindowsCodingNative;
    vi.spyOn(native, "loadWindowsCodingNative").mockImplementation(() => {
      const api = load(), write = api.write;
      api.write = (...args) => { write.apply(api, args); hook(); }; return api;
    });
  }
  async function replaceStoreWithWriteHook(hook: () => void): Promise<void> {
    await registry.close(); onNativeWrite(hook);
    store = await WindowsCodingArtifactStore.create({ privateBase: base, protectedPaths: [protectedRoot] });
    registry = await CodingResultRegistry.create({ privateBase: base, store, currentOwner: () => owner,
      projectExists: id => project && ["project-one", "project-two"].includes(id) });
  }

  it("publishes a common review, exports exact fresh files, and forgets private data while completed user copies survive", async () => {
    const input = await registration(), result = await registry.put(input), detail = await registry.review(result.id);
    expect(detail).toMatchObject({ sourcePath: source, files: 1, status: "done", checks: { ran: 1, passed: 1, failed: 0 } });
    expect(detail?.textPatch).toContain("+export const answer = 42;");
    expect(JSON.stringify(detail)).not.toContain("base64"); expect(detail).not.toHaveProperty("artifact");
    fs.writeFileSync(path.join(destination, "review.json"), "keep-existing");
    const exported = await registry.export(result.id, destination, () => true);
    expect(exported.ok).toBe(true); expect(path.dirname(exported.directory!)).toBe(destination);
    expect(fs.readdirSync(exported.directory!)).toEqual(["changes.patch", "review.json"]);
    for (const name of ["review.json", "changes.patch"]) {
      expect(fs.readFileSync(path.join(exported.directory!, name))).toEqual(fs.readFileSync(path.join(input.output.directory, name)));
      const exportedFile = fs.statSync(path.join(exported.directory!, name), { bigint: true }), privateFile = fs.statSync(path.join(input.output.directory, name), { bigint: true });
      expect(exportedFile.ino).not.toBe(privateFile.ino); expect(exportedFile.nlink).toBe(1n);
    }
    expect(fs.statSync(exported.directory!, { bigint: true }).ino).not.toBe(fs.statSync(input.output.directory, { bigint: true }).ino);
    expect(fs.readFileSync(path.join(destination, "review.json"), "utf8")).toBe("keep-existing");
    await registry.forgetResult(result.id);
    expect(registry.state("project-one")).toEqual([]); expect(fs.readdirSync(base)).toEqual([]);
    expect(fs.readdirSync(exported.directory!)).toEqual(["changes.patch", "review.json"]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
  });

  it("requires an exact store-minted producer token and consumes it only once without exposing native authority", async () => {
    const input = await registration(), forged = Object.freeze({}) as CodingArtifactRef;
    await expect(store.claim({ ...input.output, artifact: forged }, () => undefined)).rejects.toMatchObject({ code: "invalid" });
    await expect(store.claim({ ...input.output, directory: source }, () => undefined)).rejects.toMatchObject({ code: "invalid" });
    await expect(store.discard({ ...input.output, directory: source })).rejects.toMatchObject({ code: "invalid" });
    const otherBase = path.join(root, "other-reviews"); fs.mkdirSync(otherBase);
    const other = await WindowsCodingArtifactStore.create({ privateBase: otherBase, protectedPaths: [protectedRoot] }); additionalStores.push(other);
    await expect(other.claim(input.output, () => undefined)).rejects.toMatchObject({ code: "invalid" });
    const result = await registry.put(input);
    await expect(registry.put(input)).rejects.toMatchObject({ code: "invalid" });
    expect(await registry.review(result.id)).not.toBeNull();
    expect(Object.keys(input.output.artifact!)).toEqual([]); expect(JSON.stringify(result)).not.toContain("artifact");
  });

  it("never adopts or derives cleanup rights from an existing Windows directory string", async () => {
    const input = await registration(), legacy = path.join(base, "legacy-review"); fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "review.json"), "untrusted-existing-review"); fs.writeFileSync(path.join(legacy, "changes.patch"), "keep-existing-patch");
    await expect(registry.put({ ...input, output: { directory: legacy, review: input.output.review, cleanup: "complete" } })).rejects.toMatchObject({ code: "invalid" });
    await expect(registry.discard(legacy)).rejects.toMatchObject({ code: "invalid" });
    await expect(registry.discard(source)).rejects.toMatchObject({ code: "invalid" });
    expect(fs.readFileSync(path.join(legacy, "review.json"), "utf8")).toBe("untrusted-existing-review");
    expect(fs.readFileSync(path.join(legacy, "changes.patch"), "utf8")).toBe("keep-existing-patch");
    await store.discard(input.output); fs.rmSync(legacy, { recursive: true });
  });

  it("retains unclaimed producer ownership during unrelated registry cleanup and closes it explicitly", async () => {
    const input = await registration(); await registry.reset();
    expect(fs.readdirSync(input.output.directory)).toEqual(["changes.patch", "review.json"]);
    expect(store.size).toBe(1); await store.discard(input.output);
    expect(store.size).toBe(0); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("compares actual file hashes with common host metadata before publication and reclaims the refused owned artifact", async () => {
    const input = await registration(); input.output.review = rendered("different host metadata\n");
    await expect(registry.put(input)).rejects.toMatchObject({ code: "artifact" });
    expect(registry.state("project-one")).toEqual([]); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("supports inert stopped results while preserving common partial status, conflicts, and check counts", async () => {
    const review = rendered(); review.changes[0].conflicts = ["The source differs from its baseline."]; review.patchComplete = false;
    const input = await registration(review, { status: "stopped", checks: { ran: 3, passed: 1, failed: 1 } }); input.output.cleanup = "retained";
    const result = await registry.put(input);
    expect(result).toMatchObject({ status: "stopped", conflicts: 1, checks: { ran: 3, passed: 1, failed: 1 } });
    expect(result.message).toContain("Partial coding result"); expect(result.message).toContain("retained");
    expect((await registry.review(result.id))?.changes[0].conflicts).toHaveLength(1);
  });

  it("reclaims a valid owned producer when its intake capability became stale", async () => {
    const input = await registration(); current = false;
    await expect(registry.put(input)).rejects.toMatchObject({ code: "stale" });
    expect(fs.readdirSync(base)).toEqual([]); expect(registry.state("project-one")).toEqual([]);
  });

  it("does not revive pending publication after reset and an owner A to B to A transition", async () => {
    const input = await registration(), entered = deferred<void>(), resume = deferred<void>(), claim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementation(async (...args) => { const receipt = await claim(...args); entered.resolve(); await resume.promise; args[1](); return receipt; });
    const publishing = registry.put(input).catch(error => error); await entered.promise;
    owner = B; const resetting = registry.reset(); owner = A; resume.resolve();
    expect(await publishing).toMatchObject({ code: "stale" }); await resetting;
    expect(registry.state("project-one")).toEqual([]); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("forgets one pending project without deleting another project's producer or publication", async () => {
    const first = await registration(), second = await registration(rendered("other project\n"), { projectId: "project-two" });
    const entered = deferred<void>(), resume = deferred<void>(), claim = store.claim.bind(store); let held = false;
    vi.spyOn(store, "claim").mockImplementation(async (...args) => {
      const receipt = await claim(...args); if (!held) { held = true; entered.resolve(); await resume.promise; args[1](); } return receipt;
    });
    const a = registry.put(first).catch(error => error); await entered.promise;
    const b = registry.put(second), forgetting = registry.forgetProject("project-one"); resume.resolve();
    expect(await a).toMatchObject({ code: "stale" }); const result = await b; await forgetting;
    expect(registry.state("project-one")).toEqual([]); expect(registry.state("project-two")).toEqual([result]);
    expect(await registry.review(result.id)).not.toBeNull(); expect(fs.readdirSync(base)).toHaveLength(1);
  });

  it("cancels production after its first native write and removes only the exact partial fresh root", async () => {
    let written = false, allowed = true;
    await replaceStoreWithWriteHook(() => { written = true; allowed = false; });
    await expect(store.write(bytes(rendered()), () => { if (!allowed) throw new CodingResultRegistryError("stale"); })).rejects.toMatchObject({ code: "stale" });
    expect(written).toBe(true); expect(store.size).toBe(0); expect(fs.readdirSync(base)).toEqual([]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("cancels explicit export after its first native write and leaves the private review available", async () => {
    let exporting = false, written = false, allowed = true;
    await replaceStoreWithWriteHook(() => { if (exporting) { written = true; allowed = false; } });
    const result = await registry.put(await registration()); exporting = true;
    expect((await registry.export(result.id, destination, () => allowed)).ok).toBe(false);
    expect(written).toBe(true); expect(fs.readdirSync(destination)).toEqual([]);
    expect(await registry.review(result.id)).not.toBeNull(); expect(store.size).toBe(1);
  });

  it("revokes a result during the export's first write before publication of its user directory", async () => {
    let exporting = false, forgotten: Promise<void> | undefined, id = "";
    await replaceStoreWithWriteHook(() => { if (exporting && !forgotten) forgotten = registry.forgetResult(id); });
    const result = await registry.put(await registration()); id = result.id; exporting = true;
    expect((await registry.export(id, destination, () => true)).ok).toBe(false); expect(forgotten).toBeDefined(); await forgotten;
    expect(fs.readdirSync(destination)).toEqual([]); expect(fs.readdirSync(base)).toEqual([]); expect(await registry.review(id)).toBeNull();
  });

  it("rejects source, private and protected destination aliases, including genuine junctions", async () => {
    const result = await registry.put(await registration());
    fs.mkdirSync(path.join(source, "nested"));
    const sourceAlias = path.join(root, "source-alias"), protectedAlias = path.join(root, "protected-alias");
    fs.symlinkSync(source, sourceAlias, "junction"); fs.symlinkSync(protectedRoot, protectedAlias, "junction");
    for (const target of [source, path.join(source, "nested"), base, protectedRoot, sourceAlias, protectedAlias, "relative"]) {
      expect((await registry.export(result.id, target, () => true)).ok).toBe(false);
    }
    expect(fs.readdirSync(destination)).toEqual([]); expect(fs.readdirSync(base)).toHaveLength(1);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
  });

  it("keeps a preview when the source disappeared before publication but refuses export without a source receipt", async () => {
    const input = await registration(), moved = source + "-moved"; fs.renameSync(source, moved);
    try {
      const result = await registry.put(input); expect(await registry.review(result.id)).not.toBeNull();
      expect((await registry.export(result.id, destination, () => true)).ok).toBe(false); expect(fs.readdirSync(destination)).toEqual([]);
    } finally { fs.renameSync(moved, source); }
  });

  it("never recaptures a rebound source path over its original intake boundary capability", async () => {
    const sourceBoundary = await store.sourceBoundary(source, () => undefined), moved = source + "-original";
    expect(sourceBoundary).not.toBeNull(); fs.renameSync(source, moved); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "replacement.txt"), "keep source B");
    try {
      const result = await registry.put(await registration(rendered(), { sourceBoundary }));
      expect(await registry.review(result.id)).not.toBeNull();
      for (const target of [moved, destination]) expect((await registry.export(result.id, target, () => true)).ok).toBe(false);
      expect(fs.readFileSync(path.join(moved, "app.ts"), "utf8")).toBe(ORIGINAL);
      expect(fs.readFileSync(path.join(source, "replacement.txt"), "utf8")).toBe("keep source B");
      expect(fs.readdirSync(destination)).toEqual([]);
    } finally { fs.rmSync(source, { recursive: true }); fs.renameSync(moved, source); }
  });

  it("does not replace an explicitly unknown intake source boundary with a later successful path capture", async () => {
    const result = await registry.put(await registration(rendered(), { sourceBoundary: null }));
    expect(await registry.review(result.id)).not.toBeNull();
    expect((await registry.export(result.id, destination, () => true)).ok).toBe(false);
    expect(fs.readdirSync(destination)).toEqual([]); expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("rejects a foreign intake source token and reclaims only its refused private artifact", async () => {
    const otherBase = path.join(root, "foreign-boundary-reviews"); fs.mkdirSync(otherBase);
    const other = await WindowsCodingArtifactStore.create({ privateBase: otherBase, protectedPaths: [protectedRoot] }); additionalStores.push(other);
    const sourceBoundary = await other.sourceBoundary(source, () => undefined); expect(sourceBoundary).not.toBeNull();
    await expect(registry.put(await registration(rendered(), { sourceBoundary }))).rejects.toMatchObject({ code: "invalid" });
    expect(registry.state("project-one")).toEqual([]); expect(fs.readdirSync(base)).toEqual([]); expect(fs.readdirSync(destination)).toEqual([]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
  });

  it("rejects a replaced source identity after publication while preserving the private preview", async () => {
    const result = await registry.put(await registration()), moved = source + "-moved"; fs.renameSync(source, moved); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "replacement.txt"), "keep replacement source");
    try {
      expect((await registry.export(result.id, destination, () => true)).ok).toBe(false); expect(await registry.review(result.id)).not.toBeNull();
      expect(fs.readFileSync(path.join(source, "replacement.txt"), "utf8")).toBe("keep replacement source");
    } finally { fs.rmSync(source, { recursive: true }); fs.renameSync(moved, source); }
  });

  it("refuses writable external handles while retaining exact private read pins", async () => {
    const input = await registration(), result = await registry.put(input), target = path.join(input.output.directory, "review.json");
    expect(() => fs.openSync(target, "r+")).toThrow();
    const ordinary = path.join(destination, "ordinary.txt"); fs.writeFileSync(ordinary, "positive control"); const handle = fs.openSync(ordinary, "r+"); fs.closeSync(handle);
    expect(await registry.review(result.id)).not.toBeNull();
  });

  it("accepts a protected ordinary-file receipt without reading its body into an artifact", async () => {
    const otherBase = path.join(root, "file-protected-reviews"); fs.mkdirSync(otherBase);
    const other = await WindowsCodingArtifactStore.create({ privateBase: otherBase, protectedPaths: [path.join(protectedRoot, "auth.txt")] });
    additionalStores.push(other); const value = rendered(), output = await other.write(bytes(value), () => undefined);
    const receipt = await other.claim(output, () => undefined); await other.verify(receipt, () => undefined);
    expect(fs.readFileSync(path.join(output.directory, "review.json"), "utf8")).not.toContain("protected-host-canary");
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
    await other.cleanup(new Set());
  });

  it("refuses extra unknown objects during claim, retains them, and retries exact cleanup after the actor removes only its own object", async () => {
    const input = await registration(), unknown = path.join(input.output.directory, "unknown.txt"); fs.writeFileSync(unknown, "keep unknown actor data");
    await expect(registry.put(input)).rejects.toMatchObject({ code: "artifact" });
    await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" });
    expect(fs.readFileSync(unknown, "utf8")).toBe("keep unknown actor data");
    fs.unlinkSync(unknown); await registry.reset(); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("refuses root namespace replacement, leaves the replacement untouched, and cleans only after the original namespace is restored", async () => {
    const input = await registration(), result = await registry.put(input), moved = path.join(base, "moved-review");
    fs.renameSync(input.output.directory, moved); fs.mkdirSync(input.output.directory); fs.writeFileSync(path.join(input.output.directory, "canary.txt"), "keep replacement");
    try {
      expect(await registry.review(result.id)).toBeNull(); await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" });
      expect(fs.readFileSync(path.join(input.output.directory, "canary.txt"), "utf8")).toBe("keep replacement");
    } finally { fs.rmSync(input.output.directory, { recursive: true }); fs.renameSync(moved, input.output.directory); }
    await registry.reset(); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("withholds a widened root ACL and retries cleanup only after the synthetic grant is restored", async () => {
    const input = await registration(), result = await registry.put(input), icacls = path.join(process.env.SystemRoot!, "System32", "icacls.exe");
    execFileSync(icacls, [input.output.directory, "/grant", "*S-1-1-0:(RX)"], { timeout: 10_000, windowsHide: true });
    try { expect(await registry.review(result.id)).toBeNull(); await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" }); }
    finally { execFileSync(icacls, [input.output.directory, "/remove:g", "*S-1-1-0"], { timeout: 10_000, windowsHide: true }); }
    await registry.reset(); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("refuses a genuine hardlinked artifact and retains its unverified cleanup receipt and outside alias", async () => {
    const input = await registration(), outside = path.join(root, "outside-review-link.json");
    fs.linkSync(path.join(input.output.directory, "review.json"), outside); expectedRetention = true;
    await expect(registry.put(input)).rejects.toMatchObject({ code: "artifact" });
    await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" });
    expect(fs.statSync(outside).nlink).toBe(2); expect(fs.readFileSync(outside, "utf8")).toContain("review-only");
    expect(fs.readdirSync(input.output.directory)).toEqual(["changes.patch", "review.json"]);
  });

  it("rejects forged receipt objects even when they copy every public field of a valid claimed receipt", async () => {
    const input = await registration(), receipt = await store.claim(input.output, () => undefined);
    await expect(store.verify({ ...receipt } as CodingArtifactReceipt, () => undefined)).rejects.toMatchObject({ code: "invalid" });
    await store.verify(receipt, () => undefined); await store.cleanup(new Set()); expect(fs.readdirSync(base)).toEqual([]);
  });
});
