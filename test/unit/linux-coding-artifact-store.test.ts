import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LinuxCodingArtifactStore } from "../../app/main/agent/linux-coding-artifact-store";
import { CodingArtifactCleanupError, CodingResultRegistryError, type CodingArtifactRef } from "../../app/main/agent/coding-artifact-store";
import { CodingResultRegistry, type CodingResultRegistration } from "../../app/main/agent/coding-result-registry";
import { createCodingReviewExport } from "../../app/main/agent/coding-result-export";

const files = () => ({ "changes.patch": Buffer.from("captured patch\n"), "review.json": Buffer.from('{"purpose":"review-only"}\n') });
const check = () => undefined;
describe.skipIf(process.platform !== "linux")("Linux review artifact ownership", () => {
  let root: string, base: string, source: string, destination: string, store: LinuxCodingArtifactStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ember-linux-artifacts-"));
    base = path.join(root, "reviews"); source = path.join(root, "source"); destination = path.join(root, "destination");
    for (const directory of [base, source, destination]) await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(source, "source.txt"), "untouched\n", { mode: 0o600 });
    store = await LinuxCodingArtifactStore.create(base);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await store.close().catch(() => undefined); await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves unclaimed producers, consumes one claim, and cleans only unretained claimed artifacts", async () => {
    const input = await store.write(files(), check);
    expect(store.size).toBe(1); await store.cleanup(new Set()); expect(await fs.readdir(base)).toHaveLength(1);
    const receipt = await store.claim(input, check);
    expect(receipt.files["changes.patch"].bytes).toBe(files()["changes.patch"].length);
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.files)).toBe(true);
    await expect(store.claim(input, check)).rejects.toMatchObject({ code: "invalid" });
    await expect(store.verify({ ...receipt }, check)).rejects.toMatchObject({ code: "artifact" });
    await store.cleanup(new Set([receipt.ref])); await store.verify(receipt, check);
    await store.cleanup(new Set()); expect(store.size).toBe(0); expect(await fs.readdir(base)).toEqual([]);
    await expect(store.verify(receipt, check)).rejects.toMatchObject({ code: "artifact" });
  });

  it("does not consume a producer for a forged or cross-store claim", async () => {
    const input = await store.write(files(), check), otherBase = path.join(root, "other");
    await fs.mkdir(otherBase, { mode: 0o700 }); const other = await LinuxCodingArtifactStore.create(otherBase);
    try {
      await expect(other.claim(input, check)).rejects.toMatchObject({ code: "invalid" });
      await expect(store.claim({ ...input, artifact: Object.freeze({}) as CodingArtifactRef }, check)).rejects.toMatchObject({ code: "invalid" });
      await store.cleanup(new Set()); const receipt = await store.claim(input, check); await store.verify(receipt, check);
    } finally { await other.close(); }
  });

  it("captures claim fields once before transfer and ignores arbitrary enumerable getters", async () => {
    const input = await store.write(files(), check); let directories = 0, references = 0;
    const supplied = { get directory() { directories++; return input.directory; }, get artifact() { references++; return input.artifact; },
      get unexpected() { throw new Error("unrelated field must not run"); } };
    const receipt = await store.claim(supplied, check); expect(directories).toBe(1); expect(references).toBe(1);
    await store.verify(receipt, check); await store.cleanup(new Set()); expect(store.size).toBe(0);
  });

  it("keeps producer ownership when a required claim field throws before transfer", async () => {
    const input = await store.write(files(), check), supplied = { get directory(): string { throw new Error("intake unavailable"); }, artifact: input.artifact };
    await expect(store.claim(supplied, check)).rejects.toMatchObject({ code: "artifact" });
    await store.cleanup(new Set()); expect(store.size).toBe(1);
    const receipt = await store.claim(input, check); await store.verify(receipt, check);
    await store.cleanup(new Set()); expect(store.size).toBe(0);
  });

  it("bounds queued producer bytes and count before copying, then releases rejected reservations", async () => {
    const large = { "changes.patch": Buffer.alloc(33 * 1024 * 1024), "review.json": Buffer.alloc(0) };
    const stale = () => { throw new CodingResultRegistryError("stale"); };
    const first = store.write(large, stale), excess = store.write(large, check);
    await expect(excess).rejects.toMatchObject({ code: "limit" }); await expect(first).rejects.toMatchObject({ code: "stale" });
    const empty = { "changes.patch": Buffer.alloc(0), "review.json": Buffer.alloc(0) };
    const pending = Array.from({ length: 64 }, () => store.write(empty, stale));
    await expect(store.write(empty, check)).rejects.toMatchObject({ code: "limit" });
    expect((await Promise.allSettled(pending)).every(result => result.status === "rejected")).toBe(true);
    const input = await store.write(files(), check); await store.discard(input); expect(store.size).toBe(0);
  });

  it("validates, budgets and copies the same two getter-provided Buffer references", async () => {
    const provided = files(); let reads = 0;
    const input = await store.write({ get "changes.patch"() { return ++reads === 1 ? provided["changes.patch"] : Buffer.from("changed getter\n"); },
      "review.json": provided["review.json"] }, check);
    expect(reads).toBe(1); expect(await fs.readFile(path.join(input.directory, "changes.patch"))).toEqual(provided["changes.patch"]);
    const receipt = await store.claim(input, check); await store.verify(receipt, check);
  });

  it("rechecks closure after input getters before reserving or copying their buffers", async () => {
    const provided = files(), copying = vi.spyOn(Buffer, "from"); let closing: Promise<void> | undefined;
    await expect(store.write({ get "changes.patch"() { closing = store.close(); return provided["changes.patch"]; },
      "review.json": provided["review.json"] }, check)).rejects.toMatchObject({ code: "stale" });
    expect(copying.mock.calls.some(args => args[0] === provided["changes.patch"] || args[0] === provided["review.json"])).toBe(false);
    copying.mockRestore(); expect(closing).toBeDefined(); await closing; expect(store.size).toBe(0);
  });

  it("transfers a valid producer before failed verification so cleanup retains the original identity", async () => {
    const input = await store.write(files(), check), artifact = path.join(input.directory, "changes.patch");
    await fs.writeFile(artifact, "changed after capture\n");
    await expect(store.claim(input, check)).rejects.toMatchObject({ code: "artifact" });
    await expect(store.claim(input, check)).rejects.toMatchObject({ code: "invalid" });
    await expect(store.cleanup(new Set())).rejects.toMatchObject({ code: "cleanup" });
    expect(await fs.readFile(artifact, "utf8")).toBe("changed after capture\n");
  });

  it("cleans a cancelled write using only the newly created exact files", async () => {
    let calls = 0;
    await expect(store.write(files(), () => { if (++calls === 5) throw new CodingResultRegistryError("stale"); })).rejects.toMatchObject({ code: "stale" });
    expect(await fs.readdir(base)).toEqual([]); expect(store.size).toBe(0);
    expect(await fs.readFile(path.join(source, "source.txt"), "utf8")).toBe("untouched\n");
  });

  it("revokes an active producer write on close and drains its newly created directory", async () => {
    const mkdir = fs.mkdir.bind(fs); let closing: Promise<void> | undefined;
    vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await mkdir(...args);
      if (!closing && /\/ember-coding-review-[0-9a-f-]{36}$/.test(String(args[0]))) closing = store.close();
      return result;
    }) as typeof fs.mkdir);
    await expect(store.write(files(), check)).rejects.toMatchObject({ code: "stale" });
    expect(closing).toBeDefined(); await closing; expect(await fs.readdir(base)).toEqual([]);
    await expect(store.write(files(), check)).rejects.toMatchObject({ code: "stale" });
  });

  it("keeps successful explicit exports when private producer and claimed artifacts close", async () => {
    const input = await store.write(files(), check), receipt = await store.claim(input, check);
    const boundary = await store.sourceBoundary(source, check);
    const exported = await store.export(receipt, boundary, destination, check);
    expect(exported.ok).toBe(true); expect(exported.directory).toBeDefined();
    for (const name of ["changes.patch", "review.json"] as const) expect(await fs.readFile(path.join(exported.directory!, name))).toEqual(files()[name]);
    await store.write(files(), check); await store.close();
    expect(await fs.readdir(base)).toEqual([]); expect(await fs.readdir(exported.directory!)).toEqual(["changes.patch", "review.json"]);
    expect(await fs.readFile(path.join(source, "source.txt"), "utf8")).toBe("untouched\n");
  });

  it("rejects source/private exports and source capabilities minted by another store", async () => {
    const input = await store.write(files(), check), receipt = await store.claim(input, check);
    const boundary = await store.sourceBoundary(source, check), otherBase = path.join(root, "other");
    await fs.mkdir(otherBase, { mode: 0o700 }); const other = await LinuxCodingArtifactStore.create(otherBase);
    try {
      const otherBoundary = await other.sourceBoundary(source, check);
      expect((await store.export(receipt, otherBoundary, destination, check)).ok).toBe(false);
      expect((await store.export(receipt, boundary, source, check)).ok).toBe(false);
      expect((await store.export(receipt, boundary, base, check)).ok).toBe(false);
      expect(await fs.readdir(destination)).toEqual([]);
    } finally { await other.close(); }
  });

  it("keeps the intake source identity when its path is rebound before shared registry publication", async () => {
    const intake = await store.sourceBoundary(source, check), moved = path.join(root, "moved-original");
    await fs.rename(source, moved); await fs.mkdir(source, { mode: 0o700 });
    await fs.writeFile(path.join(source, "replacement.txt"), "replacement canary\n", { mode: 0o600 });
    const host = await CodingResultRegistry.create({ privateBase: base, currentOwner: () => "a".repeat(64), projectExists: () => true, store });
    try {
      const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() }, tree = { binding, entries: [] };
      const { review, json } = createCodingReviewExport({ binding, baseline: tree, proposed: tree, current: tree });
      const output = await store.write({ "review.json": Buffer.from(json), "changes.patch": Buffer.from(review.textPatch) }, check);
      const result = await host.put({ expectedOwner: binding.owner, projectId: "one", taskId: randomUUID(), title: "Intake identity",
        sourcePath: source, sourceBoundary: intake, current: () => true, status: "done", checks: { ran: 0, passed: 0, failed: 0 },
        output: { ...output, review, cleanup: "complete" } });
      expect(await host.review(result.id)).not.toBeNull();
      expect((await host.export(result.id, moved, () => true)).ok).toBe(false);
      expect((await host.export(result.id, destination, () => true)).ok).toBe(false);
      expect(await fs.readdir(destination)).toEqual([]); expect(await fs.readdir(moved)).toEqual(["source.txt"]);
      expect(await fs.readFile(path.join(moved, "source.txt"), "utf8")).toBe("untouched\n");
      expect(await fs.readFile(path.join(source, "replacement.txt"), "utf8")).toBe("replacement canary\n");
    } finally { await host.close(); }
  });

  it("withholds export for an explicit null intake receipt without recapturing the current source", async () => {
    expect(await store.sourceBoundary(source, check, null)).toBeNull();
    const sourceBoundary = vi.spyOn(store, "sourceBoundary"), host = await CodingResultRegistry.create({
      privateBase: base, currentOwner: () => "a".repeat(64), projectExists: () => true, store,
    });
    try {
      const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() }, tree = { binding, entries: [] };
      const { review, json } = createCodingReviewExport({ binding, baseline: tree, proposed: tree });
      const output = await store.write({ "review.json": Buffer.from(json), "changes.patch": Buffer.from(review.textPatch) }, check);
      const input: CodingResultRegistration = { expectedOwner: binding.owner, projectId: "one", taskId: randomUUID(), title: "No source authority",
        sourcePath: source, sourceBoundary: null, current: () => true, status: "stopped", checks: { ran: 0, passed: 0, failed: 0 },
        output: { ...output, review, cleanup: "complete" } };
      const result = await host.put(input); expect(await host.review(result.id)).not.toBeNull();
      expect(sourceBoundary).not.toHaveBeenCalled(); expect((await host.export(result.id, destination, () => true)).ok).toBe(false);
      expect(await fs.readdir(destination)).toEqual([]);
    } finally { await host.close(); }
  });

  it("retains exact cleanup receipts after a partial unlink and permits a safe retry", async () => {
    const input = await store.write(files(), check); await store.claim(input, check);
    const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("synthetic failure"));
    await expect(store.cleanup(new Set())).rejects.toMatchObject({ code: "cleanup" }); expect(store.size).toBe(1);
    unlink.mockRestore(); await store.cleanup(new Set()); expect(store.size).toBe(0); expect(await fs.readdir(base)).toEqual([]);
  });

  it("retains one terminal close failure and still closes other known resources", async () => {
    const input = await store.write(files(), check), receipt = await store.claim(input, check), realOpen = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const file = await realOpen(...args);
      if (!injected && String(args[0]).endsWith("/changes.patch")) {
        injected = true; const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw new Error("completion unavailable"); });
      }
      return file;
    }) as typeof fs.open);
    const failure = await store.verify(receipt, check).catch(error => error);
    expect(injected).toBe(true); expect(failure).toBeInstanceOf(CodingArtifactCleanupError);
    await expect(store.cleanup(new Set())).rejects.toBe(failure);
    vi.restoreAllMocks(); await expect(store.close()).rejects.toBe(failure); expect(await fs.readdir(base)).toEqual([]);
    await expect(store.close()).rejects.toBe(failure);
  });
});
