import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodingResultRegistry } from "../../app/main/agent/coding-result-registry";
import { LinuxCodingArtifactStore } from "../../app/main/agent/linux-coding-artifact-store";
import { CodingArtifactCleanupError } from "../../app/main/agent/coding-artifact-store";
import { clearCodingContinuation, type CodingContinuationRef } from "../../app/main/agent/coding-continuation";
import { createCodingReviewExport, type CodingExportTree, type CodingReviewExport } from "../../app/main/agent/coding-result-export";

const A = "a".repeat(64), B = "b".repeat(64), P = "project-one";
const native = it.skipIf(process.platform !== "linux");
let root: string, base: string, source: string, owner: string | null, store: LinuxCodingArtifactStore, registry: CodingResultRegistry;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ember-continuation-registry-"));
  base = path.join(root, "reviews"); source = path.join(root, "source");
  await fs.mkdir(base, { mode: 0o700 }); await fs.mkdir(source, { mode: 0o700 });
  owner = A; store = await LinuxCodingArtifactStore.create(base);
  registry = await CodingResultRegistry.create({ privateBase: base, store, currentOwner: () => owner, projectExists: id => id === P });
});
afterEach(async () => {
  vi.restoreAllMocks(); await registry?.close().catch(() => undefined);
  if (root) await fs.rm(root, { recursive: true, force: true });
});
function review(): CodingReviewExport {
  const binding = { owner: A, session: randomUUID(), snapshot: randomUUID() };
  const tree = (bytes: Buffer): CodingExportTree => ({ binding, entries: [{ path: "empty", kind: "directory" },
    { path: "app.cjs", kind: "file", bytes, executable: true }, { path: "image.bin", kind: "file", bytes: Buffer.from([0, 255, 1]), executable: false }] });
  return createCodingReviewExport({ binding, baseline: tree(Buffer.from("original\n")), proposed: tree(Buffer.from("first edit\n")) }).review;
}
async function publish(document = review(), noSource = false) {
  const sourceBoundary = noSource ? null : await store.sourceBoundary(source, () => {});
  const output = await store.write({ "review.json": Buffer.from(JSON.stringify(document, null, 2)), "changes.patch": Buffer.from(document.textPatch) }, () => {});
  return registry.put({ expectedOwner: A, projectId: P, taskId: randomUUID(), title: "First edit", sourcePath: source, sourceBoundary,
    current: () => true, status: "done", checks: { ran: 1, passed: 1, failed: 0 }, output: { ...output, review: document, cleanup: "complete" } });
}
async function selected() {
  const result = await publish(), ref = registry.captureContinuation(result.id, P);
  expect(ref).not.toBeNull(); return { result, ref: ref! };
}
async function fresh() { return store.sourceBoundary(source, () => {}); }

native("loads independent complete trees with the original baseline and binding, never preview or IPC bytes", async () => {
  const { result, ref } = await selected();
  const input = await registry.loadContinuation(ref, P, await fresh(), () => true);
  expect(input.baseline.entries.find(entry => entry.path === "app.cjs")).toMatchObject({ bytes: Buffer.from("original\n"), executable: true });
  expect(input.proposed.entries.find(entry => entry.path === "app.cjs")).toMatchObject({ bytes: Buffer.from("first edit\n"), executable: true });
  expect(input.proposed.entries.find(entry => entry.path === "image.bin")).toMatchObject({ bytes: Buffer.from([0, 255, 1]) });
  expect(input.proposed.entries.find(entry => entry.path === "empty")).toEqual({ path: "empty", kind: "directory" });
  clearCodingContinuation(input);
  const again = await registry.loadContinuation(ref, P, await fresh(), () => true);
  expect(again.proposed.entries.find(entry => entry.kind === "file" && entry.path === "app.cjs")).toMatchObject({ bytes: Buffer.from("first edit\n") });
  expect(await registry.review(result.id)).not.toBeNull();
  expect(JSON.stringify(result)).not.toContain("base64"); expect(Object.keys(ref)).toEqual([]);
  clearCodingContinuation(again);
});

native("rejects forged, foreign and cross-project references without reading artifacts", async () => {
  const { ref } = await selected(), read = vi.spyOn(store, "read"), sourceRef = await fresh();
  await expect(registry.loadContinuation(Object.freeze({}) as CodingContinuationRef, P, sourceRef, () => true)).rejects.toMatchObject({ code: "stale" });
  await expect(registry.loadContinuation(ref, "other-project", sourceRef, () => true)).rejects.toMatchObject({ code: "stale" });
  const otherBase = path.join(root, "other"); await fs.mkdir(otherBase, { mode: 0o700 });
  const other = await CodingResultRegistry.create({ privateBase: otherBase, currentOwner: () => A, projectExists: () => true });
  try { await expect(other.loadContinuation(ref, P, sourceRef, () => true)).rejects.toMatchObject({ code: "stale" }); }
  finally { await other.close(); }
  expect(read).not.toHaveBeenCalled();
});

native("invalidates a captured selection across observed owner ABA", async () => {
  const { ref } = await selected(); owner = B; expect(registry.state(P)).toEqual([]); owner = A;
  expect(registry.continuationCurrent(ref, P)).toBe(false);
  await expect(registry.loadContinuation(ref, P, await fresh(), () => true)).rejects.toMatchObject({ code: "stale" });
});

native("invalidates selections on project retirement even when the same project id is reused", async () => {
  const { ref } = await selected(); await registry.forgetProject(P);
  expect(registry.continuationCurrent(ref, P)).toBe(false);
  await expect(registry.loadContinuation(ref, P, await fresh(), () => true)).rejects.toMatchObject({ code: "stale" });
});

native("refuses a rebound source before reading any previous project bytes", async () => {
  const { ref } = await selected(), read = vi.spyOn(store, "read");
  await fs.rename(source, path.join(root, "moved-original")); await fs.mkdir(source, { mode: 0o700 });
  await expect(registry.loadContinuation(ref, P, await fresh(), () => true)).rejects.toMatchObject({ code: "destination" });
  expect(read).not.toHaveBeenCalled();
});

native("does not mint execution context when the original source receipt is unavailable", async () => {
  const result = await publish(review(), true);
  expect(await registry.review(result.id)).not.toBeNull(); expect(registry.captureContinuation(result.id, P)).toBeNull();
});

native("Forget revokes a read in flight and zeroes its returned buffer before cleanup completes", async () => {
  const { result, ref } = await selected();
  let entered!: () => void, release!: () => void, observed: Buffer | undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const read = store.read.bind(store);
  vi.spyOn(store, "read").mockImplementation(async (...args) => { observed = await read(...args); entered(); await barrier; return observed; });
  const pending = registry.loadContinuation(ref, P, await fresh(), () => true);
  const refused = expect(pending).rejects.toMatchObject({ code: "stale" });
  await ready; const forgetting = registry.forgetResult(result.id);
  expect(registry.continuationCurrent(ref, P)).toBe(false); release(); await refused; await forgetting;
  expect(observed?.length).toBeGreaterThan(0); expect(observed?.every(byte => byte === 0)).toBe(true);
});

native("a task revocation after physical read refuses admission and zeroes the decoded source buffer", async () => {
  const { ref } = await selected(); let active = true, observed: Buffer | undefined;
  const read = store.read.bind(store);
  vi.spyOn(store, "read").mockImplementation(async (...args) => { observed = await read(...args); active = false; return observed; });
  await expect(registry.loadContinuation(ref, P, await fresh(), () => active)).rejects.toMatchObject({ code: "stale" });
  expect(observed?.every(byte => byte === 0)).toBe(true);
});

native("rejects a contradictory complete review even when trusted publication metadata and physical hashes agree", async () => {
  const document = review(), file = document.proposed.find(entry => entry.kind === "file");
  if (!file || file.kind !== "file") throw new Error("Missing fixture file");
  file.sha256 = "0".repeat(64);
  const result = await publish(document), ref = registry.captureContinuation(result.id, P)!;
  await expect(registry.loadContinuation(ref, P, await fresh(), () => true)).rejects.toMatchObject({ code: "artifact" });
});

native("preserves typed terminal storage cleanup failures instead of returning seed data", async () => {
  const { ref } = await selected();
  vi.spyOn(store, "read").mockRejectedValue(new CodingArtifactCleanupError());
  await expect(registry.loadContinuation(ref, P, await fresh(), () => true)).rejects.toBeInstanceOf(CodingArtifactCleanupError);
});
