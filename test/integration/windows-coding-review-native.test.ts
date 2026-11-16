/** Real NTFS file edits -> sealed review -> native artifact ownership. No command backend or product gate is enabled. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsCodingCopy, type WindowsCodingCopyInput } from "../../app/main/agent/windows-coding-copy";
import { WindowsScopedCodingFiles } from "../../app/main/agent/windows-scoped-coding-files";
import { WindowsCodingArtifactStore } from "../../app/main/agent/windows-coding-artifact-store";
import { CodingResultRegistry, type CodingResultRegistration } from "../../app/main/agent/coding-result-registry";
import { decodeCodingReviewExport, type CodingExportBinding, type CodingExportTree } from "../../app/main/agent/coding-result-export";
import { retireCodingPrivacyScanners } from "../../app/main/agent/coding-privacy-scanner";
import type { CodingArtifactSourceRef } from "../../app/main/agent/coding-artifact-store";
import * as native from "../../app/main/agent/windows-coding-native";

const A = "a".repeat(64), B = "b".repeat(64);
const ORIGINAL = "export const answer = 41;\n", PROPOSED = "export const answer = 42;\n";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function text(tree: CodingExportTree | undefined, name: string): string | undefined {
  const entry = tree?.entries.find(value => value.path === name); return entry?.kind === "file" ? entry.bytes.toString("utf8") : undefined;
}

describe.skipIf(process.platform !== "win32")("native Windows sealed file-only review", () => {
  let root: string, source: string, copiesBase: string, reviewsBase: string, destination: string, protectedRoot: string;
  let signal: AbortController, fileCurrent: boolean, reviewCurrent: boolean, owner: string | null, binding: CodingExportBinding;
  let reviewHook: (() => void) | undefined;
  let copies: WindowsCodingCopy[], brokers: WindowsScopedCodingFiles[], store: WindowsCodingArtifactStore, registry: CodingResultRegistry;
  let controllers: Map<WindowsCodingCopy, { close(): Promise<void> }>;
  let setupComplete: boolean;
  beforeEach(async () => {
    setupComplete = false;
    // Unknown native cleanup must remain outside vitest's best-effort recursive run-temp teardown.
    root = fs.mkdtempSync(path.join(path.dirname(os.tmpdir()), "ember-native-sealed-review-"));
    source = path.join(root, "source"); copiesBase = path.join(root, "copies"); reviewsBase = path.join(root, "reviews");
    destination = path.join(root, "destination"); protectedRoot = path.join(root, "protected");
    for (const directory of [source, copiesBase, reviewsBase, destination, protectedRoot]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(source, "app.ts"), ORIGINAL); fs.writeFileSync(path.join(protectedRoot, "auth.txt"), "protected-host-canary");
    signal = new AbortController(); fileCurrent = true; reviewCurrent = true; owner = A; reviewHook = undefined;
    binding = { owner: A, session: randomUUID(), snapshot: randomUUID() }; copies = []; brokers = []; controllers = new Map();
    store = await WindowsCodingArtifactStore.create({ privateBase: reviewsBase, protectedPaths: [protectedRoot] });
    registry = await CodingResultRegistry.create({ privateBase: reviewsBase, store, currentOwner: () => owner,
      projectExists: id => id === "project-one" });
    setupComplete = true;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const errors: unknown[] = [];
    if (!setupComplete) { console.info("Native sealed review setup failed; synthetic scratch retained without forced cleanup."); return; }
    for (const broker of brokers.reverse()) { try { await broker.close(); } catch (error) { errors.push(error); } }
    for (const copy of copies.reverse()) { try { await copy.close(); } catch (error) { errors.push(error); } }
    try { await registry.close(); } catch (error) { errors.push(error); }
    if (!errors.length) fs.rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Native sealed review cleanup was not verified; synthetic scratch retained.");
  });
  async function open(patch: Partial<WindowsCodingCopyInput> = {}) {
    let controllerClosed = false;
    const workspace = await WindowsCodingCopy.create({ source, privateBase: copiesBase, protectedPaths: [protectedRoot], signal: signal.signal,
      current: () => fileCurrent, review: { binding, store, current: () => { reviewHook?.(); return reviewCurrent && owner === A; }, controllerClosed: () => controllerClosed }, ...patch });
    copies.push(workspace);
    const broker = await WindowsScopedCodingFiles.create({ copy: workspace, signal: signal.signal }); brokers.push(broker);
    controllers.set(workspace, { close: async () => { await broker.close(); controllerClosed = true; } });
    return { workspace, broker };
  }
  async function seal(workspace: WindowsCodingCopy) { await controllers.get(workspace)!.close(); await workspace.stop(); }
  function registration(output: CodingResultRegistration["output"], sourceBoundary: CodingArtifactSourceRef | null): CodingResultRegistration {
    return { expectedOwner: A, projectId: "project-one", taskId: randomUUID(), title: "Edit the copied app", sourcePath: source,
      status: "done", checks: { ran: 0, passed: 0, failed: 0 }, current: () => reviewCurrent && owner === A, output, sourceBoundary };
  }

  it("preserves baseline/proposed/current bytes through native publication, explicit export and Forget", async () => {
    const { workspace, broker } = await open(), before = await broker.readText("app.ts");
    await broker.replaceText("app.ts", "41", "42", { expectedSha256: before.sha256 });
    await seal(workspace); fileCurrent = false;
    const producer = await workspace.exportReview(store), decoded = decodeCodingReviewExport(fs.readFileSync(path.join(producer.output.directory, "review.json")), binding);
    expect(text(decoded.baseline, "app.ts")).toBe(ORIGINAL); expect(text(decoded.proposed, "app.ts")).toBe(PROPOSED);
    expect(text(decoded.current, "app.ts")).toBe(ORIGINAL);
    expect(producer.output.review).toMatchObject({ purpose: "review-only", binding, patchComplete: true });
    expect(producer.output.review.textPatch).toContain("-export const answer = 41;\n+export const answer = 42;\n");
    expect(Object.keys(producer.output.artifact!)).toEqual([]); expect(workspace).not.toHaveProperty("run");
    await expect(broker.writeText("app.ts", "must not revive\n")).rejects.toMatchObject({ code: "cancelled" });
    await expect(workspace.files(async () => true)).rejects.toMatchObject({ code: "cancelled" });
    const output = producer.transfer(); expect(output).toBe(producer.output);
    const published = registry.put(registration(output, producer.sourceBoundary)); await workspace.close();
    const result = await published, detail = await registry.review(result.id);
    expect(detail).toMatchObject({ status: "done", files: 1, conflicts: 0, checks: { ran: 0, passed: 0, failed: 0 } });
    expect(detail).not.toHaveProperty("artifact"); expect(JSON.stringify(detail)).not.toContain("base64");
    expect(fs.readdirSync(copiesBase)).toEqual([]); expect(fs.readdirSync(output.directory)).toEqual(["changes.patch", "review.json"]);
    const exported = await registry.export(result.id, destination, () => true); expect(exported.ok).toBe(true);
    for (const name of ["review.json", "changes.patch"]) {
      expect(fs.readFileSync(path.join(exported.directory!, name))).toEqual(fs.readFileSync(path.join(output.directory, name)));
      expect(fs.statSync(path.join(exported.directory!, name), { bigint: true }).ino).not.toBe(fs.statSync(path.join(output.directory, name), { bigint: true }).ino);
    }
    await registry.forgetResult(result.id); expect(registry.state("project-one")).toEqual([]); expect(fs.readdirSync(reviewsBase)).toEqual([]);
    expect(fs.readdirSync(exported.directory!)).toEqual(["changes.patch", "review.json"]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
  });

  it("records copied additions, deletions and empty directories without changing the source", async () => {
    fs.writeFileSync(path.join(source, "remove.txt"), "remove only the private copy\n");
    const { workspace, broker } = await open();
    await broker.writeText("new.ts", "export const added = true;\n", { createOnly: true });
    await broker.delete("remove.txt"); await broker.mkdir("empty"); await seal(workspace);
    const producer = await workspace.exportReview(store), review = producer.output.review;
    expect(review.changes.map(change => [change.path, change.kind])).toEqual([["empty", "add"], ["new.ts", "add"], ["remove.txt", "delete"]]);
    expect(review.proposed.find(entry => entry.path === "empty")).toEqual({ path: "empty", kind: "directory" });
    expect(review.proposed.some(entry => entry.path === "remove.txt")).toBe(false);
    expect(fs.readdirSync(source).sort()).toEqual(["app.ts", "remove.txt"]); await producer.discard(); expect(store.size).toBe(0);
  });

  it("keeps source edits as conflicts and omits conflicting hunks from the text patch", async () => {
    const { workspace, broker } = await open(); await broker.writeText("app.ts", PROPOSED); await seal(workspace);
    const concurrent = "export const answer = 99;\n"; fs.writeFileSync(path.join(source, "app.ts"), concurrent);
    const producer = await workspace.exportReview(store), review = producer.output.review;
    const decoded = decodeCodingReviewExport(fs.readFileSync(path.join(producer.output.directory, "review.json")), binding);
    expect(text(decoded.baseline, "app.ts")).toBe(ORIGINAL); expect(text(decoded.proposed, "app.ts")).toBe(PROPOSED);
    expect(text(decoded.current, "app.ts")).toBe(concurrent); expect(review.patchComplete).toBe(false);
    expect(review.changes[0].conflicts).toContain("The current project differs from the baseline at this path.");
    expect(review.textPatch).toBe(""); expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(concurrent); await producer.discard();
  });

  it.each(["missing", "replacement"] as const)("keeps the original source identity unknown after a %s namespace", async kind => {
    const { workspace, broker } = await open(); await broker.writeText("app.ts", PROPOSED); await seal(workspace);
    const moved = source + "-original"; fs.renameSync(source, moved);
    if (kind === "replacement") { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "app.ts"), "replacement-must-not-be-captured\n"); }
    try {
      const producer = await workspace.exportReview(store), review = producer.output.review;
      expect(review.current).toBeNull(); expect(review.patchComplete).toBe(false); expect(review.textPatch).toBe("");
      expect(review.changes[0].conflicts).toContain("The original project was not captured; concurrent changes are unknown.");
      expect(JSON.stringify(review)).not.toContain("replacement-must-not-be-captured");
      expect(fs.readFileSync(path.join(moved, "app.ts"), "utf8")).toBe(ORIGINAL); await producer.discard();
    } finally {
      if (kind === "replacement") fs.rmSync(source, { recursive: true }); fs.renameSync(moved, source);
    }
  });

  it("refuses a rebound source between intake provenance and snapshot capture", async () => {
    const moved = source + "-intake-original", capture = store.sourceBoundary.bind(store); let replaced = false;
    vi.spyOn(store, "sourceBoundary").mockImplementation(async (...args) => {
      const receipt = await capture(...args);
      if (!replaced && args[2] === undefined) {
        replaced = true; fs.renameSync(source, moved); fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, "app.ts"), "replacement-must-not-become-the-baseline\n");
      }
      return receipt;
    });
    try {
      await expect(open()).rejects.toMatchObject({ code: "boundary" }); expect(replaced).toBe(true);
      expect(fs.readdirSync(copiesBase)).toEqual([]); expect(store.size).toBe(0);
      expect(fs.readFileSync(path.join(moved, "app.ts"), "utf8")).toBe(ORIGINAL);
      expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe("replacement-must-not-become-the-baseline\n");
    } finally { if (replaced) { fs.rmSync(source, { recursive: true }); fs.renameSync(moved, source); } }
  });

  it("waits for an admitted file lease before capturing a sealed review and revokes queued callbacks", async () => {
    const { workspace, broker } = await open(), entered = deferred<void>(), resume = deferred<void>(); let late = false, settled = false;
    const held = workspace.files(async () => { entered.resolve(); await resume.promise; }).catch(error => error); await entered.promise;
    const queued = broker.writeText("app.ts", "queued-must-not-commit\n").catch(error => error);
    await controllers.get(workspace)!.close();
    const stopped = workspace.stop(), exporting = workspace.exportReview(store); void exporting.then(() => { settled = true; }, () => undefined);
    await Promise.resolve(); expect(settled).toBe(false);
    resume.resolve(); await held; await stopped; expect(await queued).toMatchObject({ code: "cancelled" });
    const producer = await exporting;
    await expect(workspace.files(async () => { late = true; })).rejects.toMatchObject({ code: "cancelled" });
    expect(late).toBe(false); expect(producer.output.review.changes).toEqual([]); await producer.discard();
  });

  it("reclaims an untransferred producer on close and makes transfer a single ownership handoff", async () => {
    const first = await open(); await first.broker.writeText("app.ts", PROPOSED); await seal(first.workspace);
    const owned = await first.workspace.exportReview(store), directory = owned.output.directory;
    expect(fs.existsSync(directory)).toBe(true); await first.workspace.close(); expect(fs.existsSync(directory)).toBe(false); expect(store.size).toBe(0);
    const second = await open(); await seal(second.workspace); const transferring = await second.workspace.exportReview(store);
    const output = transferring.transfer(); expect(() => transferring.transfer()).toThrow(); await second.workspace.close();
    expect(fs.existsSync(output.directory)).toBe(true); await store.discard(output); expect(store.size).toBe(0);
  });

  it("rejects transfer when its current-authority callback synchronously closes the native owner", async () => {
    const { workspace } = await open(); await seal(workspace); const producer = await workspace.exportReview(store);
    let closing: Promise<void> | undefined;
    reviewHook = () => { reviewHook = undefined; closing = workspace.close(); };
    expect(() => producer.transfer()).toThrowError(expect.objectContaining({ code: "cancelled" }));
    expect(producer.owned).toBe(true); await closing; expect(producer.owned).toBe(false);
    expect(store.size).toBe(0); expect(fs.readdirSync(reviewsBase)).toEqual([]); expect(fs.readdirSync(copiesBase)).toEqual([]);
  });

  it("cannot export without an explicitly granted host review authority", async () => {
    const { workspace } = await open({ review: undefined }); await seal(workspace);
    await expect(workspace.exportReview(store)).rejects.toMatchObject({ code: "unavailable" }); expect(store.size).toBe(0);
  });

  it("requires host proof of awaited controller and file-broker teardown before post-Stop capture", async () => {
    const { workspace } = await open(); await workspace.stop();
    await expect(workspace.exportReview(store)).rejects.toMatchObject({ code: "boundary" });
    expect(store.size).toBe(0); expect(fs.readdirSync(reviewsBase)).toEqual([]); await controllers.get(workspace)!.close();
  });

  it("rejects a foreign artifact store without creating a producer in either native ledger", async () => {
    const { workspace } = await open(); await seal(workspace);
    const foreignBase = path.join(root, "foreign-reviews"); fs.mkdirSync(foreignBase);
    const foreign = await WindowsCodingArtifactStore.create({ privateBase: foreignBase, protectedPaths: [protectedRoot] });
    try {
      await expect(workspace.exportReview(foreign)).rejects.toMatchObject({ code: "boundary" });
      expect(store.size).toBe(0); expect(foreign.size).toBe(0); expect(fs.readdirSync(foreignBase)).toEqual([]);
    } finally { await foreign.close(); }
  });

  it("never revives a revoked account review authority after Stop", async () => {
    const { workspace } = await open(); await seal(workspace); owner = B;
    await expect(workspace.exportReview(store)).rejects.toMatchObject({ code: "cancelled" }); owner = A;
    await expect(workspace.exportReview(store)).rejects.toMatchObject({ code: "cancelled" }); expect(store.size).toBe(0);
  });

  it("rejects retired privacy authority after Stop without reviving file access", async () => {
    const { workspace, broker } = await open(); await seal(workspace); await retireCodingPrivacyScanners();
    await expect(workspace.exportReview(store)).rejects.toMatchObject({ code: "cancelled" });
    await expect(broker.readText("app.ts")).rejects.toMatchObject({ code: "cancelled" }); expect(store.size).toBe(0);
  });

  it("reclaims the exact fresh artifact when review authority retires during its first native write", async () => {
    await registry.close(); let armed = false, written = false;
    const load = native.loadWindowsCodingNative;
    vi.spyOn(native, "loadWindowsCodingNative").mockImplementation(() => {
      const api = load(), write = api.write;
      api.write = (...args) => { write.apply(api, args); if (armed) { written = true; reviewCurrent = false; } }; return api;
    });
    store = await WindowsCodingArtifactStore.create({ privateBase: reviewsBase, protectedPaths: [protectedRoot] });
    registry = await CodingResultRegistry.create({ privateBase: reviewsBase, store, currentOwner: () => owner, projectExists: () => true });
    const { workspace, broker } = await open(); await broker.writeText("app.ts", PROPOSED); await seal(workspace); armed = true;
    try { await expect(workspace.exportReview(store)).rejects.toMatchObject({ code: "cancelled" }); }
    finally { armed = false; }
    expect(written).toBe(true); expect(store.size).toBe(0); expect(fs.readdirSync(reviewsBase)).toEqual([]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("drains native artifact creation during close and reclaims the untransferred output before resolving", async () => {
    const { workspace, broker } = await open(); await broker.writeText("app.ts", PROPOSED); await seal(workspace);
    const entered = deferred<void>(), resume = deferred<void>(), write = store.write.bind(store); let closed = false;
    vi.spyOn(store, "write").mockImplementation(async (...args) => {
      const output = await write(...args); entered.resolve(); await resume.promise; return output;
    });
    const exporting = workspace.exportReview(store).catch(error => error); await entered.promise;
    expect(store.size).toBe(1); const closing = workspace.close(); void closing.then(() => { closed = true; }, () => undefined);
    await Promise.resolve(); expect(closed).toBe(false); resume.resolve();
    expect(await exporting).toMatchObject({ code: "cancelled" }); await closing;
    expect(closed).toBe(true); expect(store.size).toBe(0); expect(fs.readdirSync(reviewsBase)).toEqual([]); expect(fs.readdirSync(copiesBase)).toEqual([]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("scans the complete stopped proposal before creating any review artifact", async () => {
    const { workspace } = await open(); await seal(workspace);
    fs.writeFileSync(path.join(workspace.directory, "app.ts"), "safe first line\n" + "x".repeat(100_000) + "\n" + "ghp_" + "A".repeat(36));
    await expect(workspace.exportReview(store)).rejects.toMatchObject({ code: "secret" });
    expect(store.size).toBe(0); expect(fs.readdirSync(reviewsBase)).toEqual([]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("records only explicitly omitted source roots and refuses other oversize content", async () => {
    for (const name of [".git", "node_modules"]) { fs.mkdirSync(path.join(source, name)); fs.writeFileSync(path.join(source, name, "unread-secret.txt"), "ghp_" + "A".repeat(36)); }
    const { workspace, broker } = await open({ scope: { excludeRoots: [".git", "node_modules"] }, limits: { workspaceBytes: 1024, fileBytes: 1024 } });
    expect(workspace.excludedRoots).toEqual([".git", "node_modules"]); expect((await broker.list()).entries.map(entry => entry.path)).toEqual(["/work/app.ts"]);
    await seal(workspace); const producer = await workspace.exportReview(store), review = producer.output.review;
    expect(review.scope).toMatchObject({ version: 1, source: { excludedRoots: [".git", "node_modules"], omitted: [
      { path: ".git", kind: "directory" }, { path: "node_modules", kind: "directory" },
    ] }, dependencies: null });
    for (const tree of [review.baseline, review.proposed, review.current!]) expect(tree.map(entry => entry.path)).toEqual(["app.ts"]);
    expect(review.limitations.join(" ")).toContain("Excluded source roots: .git, node_modules."); await producer.discard();
    await workspace.close(); fs.writeFileSync(path.join(source, "large.ts"), "x".repeat(2048));
    await expect(open({ scope: { excludeRoots: [".git", "node_modules"] }, limits: { fileBytes: 1024 } })).rejects.toMatchObject({ code: "limit" });
    expect(fs.readdirSync(copiesBase)).toEqual([]); expect(fs.readFileSync(path.join(source, "large.ts"), "utf8")).toHaveLength(2048);
  });
});
