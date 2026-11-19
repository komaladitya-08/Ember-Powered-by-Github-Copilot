import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { CodingResultRegistry, CodingArtifactCleanupError, CodingResultRegistryError, type CodingResultRegistration } from "../../app/main/agent/coding-result-registry";
import { createCodingReviewExport } from "../../app/main/agent/coding-result-export";
import type { CodingArtifactStore, CodingArtifactRef, CodingArtifactReceipt, CodingArtifactInput, CodingArtifactFiles, CodingArtifactSourceRef, CodingArtifactName } from "../../app/main/agent/coding-artifact-store";

const A = "a".repeat(64), B = "b".repeat(64);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Structural policy double only; native filesystem authority is covered by both platform suites. */
class ContractStore implements CodingArtifactStore {
  records = new Map<CodingArtifactRef, { receipt: CodingArtifactReceipt; claimed: boolean }>();
  removed: CodingArtifactRef[] = [];
  claimWait?: () => Promise<void>;
  verifyWait?: () => Promise<void>;
  terminal = false;
  sourceAvailable = true;
  sourceFailure?: CodingResultRegistryError;
  get size() { return this.records.size; }
  validSourcePath(value: string) { return typeof value === "string" && value === "C:\\source"; }
  async write(files: CodingArtifactFiles, check: () => void) {
    check(); const artifact = Object.freeze({}) as CodingArtifactRef, directory = `C:\\private\\${randomUUID()}`;
    const receipt: CodingArtifactReceipt = Object.freeze({ ref: artifact, directory, bytes: files["review.json"].length + files["changes.patch"].length,
      files: Object.freeze({ "review.json": { bytes: files["review.json"].length, sha256: digest(files["review.json"]) },
        "changes.patch": { bytes: files["changes.patch"].length, sha256: digest(files["changes.patch"]) } }) });
    this.records.set(artifact, { receipt, claimed: false }); return { directory, artifact };
  }
  async claim(input: CodingArtifactInput, check: () => void) {
    const record = input.artifact && this.records.get(input.artifact);
    if (!record || record.claimed || record.receipt.directory !== input.directory) throw new CodingResultRegistryError("invalid");
    record.claimed = true; check(); await this.claimWait?.(); check(); return record.receipt;
  }
  async verify(receipt: CodingArtifactReceipt, check: () => void) {
    check(); await this.verifyWait?.(); check();
    if (this.terminal) throw new CodingArtifactCleanupError();
    if (this.records.get(receipt.ref)?.receipt !== receipt) throw new CodingResultRegistryError("artifact");
  }
  async read(receipt: CodingArtifactReceipt, _name: CodingArtifactName, _maximumBytes: number, check: () => void): Promise<Buffer> {
    await this.verify(receipt, check); throw new CodingResultRegistryError("unsupported");
  }
  async sameSource(original: CodingArtifactSourceRef | null, fresh: CodingArtifactSourceRef | null, check: () => void) {
    check(); return !!original && original === fresh;
  }
  async sourceBoundary(_source: string, check: () => void, expected?: CodingArtifactSourceRef) {
    check(); if (this.sourceFailure) throw this.sourceFailure;
    return expected ?? (this.sourceAvailable ? Object.freeze({}) as CodingArtifactSourceRef : null);
  }
  async export(receipt: CodingArtifactReceipt, source: CodingArtifactSourceRef | null, _destination: string, check: () => void) {
    await this.verify(receipt, check); check(); return source ? { ok: true, message: "Exported", directory: "C:\\export\\fresh" } : { ok: false, message: "Choose another destination." };
  }
  async discard(input: CodingArtifactInput) { if (!input.artifact || !this.records.has(input.artifact)) throw new CodingResultRegistryError("invalid"); this.records.delete(input.artifact); }
  async cleanup(retained: ReadonlySet<CodingArtifactRef>) {
    if (this.terminal) throw new CodingArtifactCleanupError();
    for (const [ref, record] of this.records) if (record.claimed && !retained.has(ref)) { this.records.delete(ref); this.removed.push(ref); }
  }
  async close() { if (this.terminal) throw new CodingArtifactCleanupError(); this.records.clear(); }
}

async function input(store: ContractStore, patch: Partial<CodingResultRegistration> = {}): Promise<CodingResultRegistration> {
  const binding = { owner: A, session: randomUUID(), snapshot: randomUUID() }, baseline = { binding, entries: [] };
  const review = createCodingReviewExport({ binding, baseline, proposed: { binding, entries: [{ path: "app.ts", kind: "file", executable: false, bytes: Buffer.from("answer\n") }] } }).review;
  const artifact = await store.write({ "review.json": Buffer.from(JSON.stringify(review, null, 2)), "changes.patch": Buffer.from(review.textPatch) }, () => undefined);
  return { expectedOwner: A, projectId: "one", taskId: randomUUID(), title: "Scoped result", sourcePath: "C:\\source", status: "done",
    checks: { ran: 1, passed: 1, failed: 0 }, current: () => true, output: { ...artifact, review, cleanup: "complete" }, ...patch };
}
function registry(store: ContractStore, owner: () => string | null = () => A) {
  return CodingResultRegistry.create({ privateBase: "C:\\private", currentOwner: owner, projectExists: id => id === "one" || id === "two", store });
}

describe("shared coding registry across structural artifact stores", () => {
  it("keeps schemas and bounded previews shared while native authority stays host-only", async () => {
    const store = new ContractStore(), host = await registry(store), value = await input(store), result = await host.put(value);
    const detail = await host.review(result.id);
    expect(detail).toMatchObject({ sourcePath: "C:\\source", files: 1, changes: [{ path: "app.ts", kind: "add" }] });
    for (const object of [host.state("one"), detail]) {
      expect(JSON.stringify(object)).not.toContain("artifact"); expect(JSON.stringify(object)).not.toContain("C:\\\\private");
      expect(JSON.stringify(object)).not.toContain("base64");
    }
    await host.close(); expect(store.size).toBe(0);
  });

  it("retains one common 32-result bound and reclaims the refused claimed artifact", async () => {
    const store = new ContractStore(), host = await registry(store);
    for (let i = 0; i < 32; i++) await host.put(await input(store));
    const refused = await input(store);
    await expect(host.put(refused)).rejects.toMatchObject({ code: "limit" });
    expect(host.state("one")).toHaveLength(32); expect(store.records.has(refused.output.artifact!)).toBe(false);
    await host.close();
  });

  it("latches owner/reset ABA while a store claim is awaiting without reviving its output", async () => {
    let owner = A; const store = new ContractStore(), host = await registry(store, () => owner), value = await input(store);
    const entered = deferred(), resume = deferred(); store.claimWait = async () => { entered.resolve(); await resume.promise; };
    const publishing = host.put(value).catch(error => error); await entered.promise;
    owner = B; const reset = host.reset(); owner = A; resume.resolve();
    expect(await publishing).toMatchObject({ code: "stale" }); await reset;
    expect(host.state("one")).toEqual([]); expect(store.size).toBe(0); await host.close();
  });

  it("forgets one pending project while preserving another project's publication", async () => {
    const store = new ContractStore(), host = await registry(store), first = await input(store), second = await input(store, { projectId: "two" });
    const entered = deferred(), resume = deferred(); let once = true;
    store.claimWait = async () => { if (once) { once = false; entered.resolve(); await resume.promise; } };
    const pending = host.put(first).catch(error => error); await entered.promise;
    const independent = host.put(second), forgetting = host.forgetProject("one"); resume.resolve();
    expect(await pending).toMatchObject({ code: "stale" }); const result = await independent; await forgetting;
    expect(host.state("one")).toEqual([]); expect(host.state("two")).toEqual([result]); expect(store.size).toBe(1); await host.close();
  });

  it("revokes late review by exact record identity without removing another result", async () => {
    const store = new ContractStore(), host = await registry(store), a = await host.put(await input(store)), b = await host.put(await input(store));
    const entered = deferred(), resume = deferred(); store.verifyWait = async () => { entered.resolve(); await resume.promise; };
    const reading = host.review(a.id); await entered.promise; const forgetting = host.forgetResult(a.id); resume.resolve();
    expect(await reading).toBeNull(); await forgetting; store.verifyWait = undefined;
    expect(host.state("one")).toEqual([b]); expect(await host.review(b.id)).not.toBeNull(); await host.close();
  });

  it("keeps a preview with an unavailable source boundary while withholding explicit export", async () => {
    const store = new ContractStore(); store.sourceAvailable = false; const host = await registry(store), result = await host.put(await input(store));
    expect(await host.review(result.id)).not.toBeNull(); expect((await host.export(result.id, "C:\\export", () => true)).ok).toBe(false); await host.close();
  });

  it("rejects an invalid explicit intake handoff while reclaiming its claimed artifact", async () => {
    const store = new ContractStore(), host = await registry(store), value = await input(store, { sourceBoundary: Object.freeze({}) as CodingArtifactSourceRef });
    store.sourceFailure = new CodingResultRegistryError("invalid");
    await expect(host.put(value)).rejects.toMatchObject({ code: "invalid" });
    expect(host.state("one")).toEqual([]); expect(store.size).toBe(0); await host.close();
  });

  it("preserves terminal storage cleanup uncertainty through review, reset and close", async () => {
    const store = new ContractStore(), host = await registry(store), result = await host.put(await input(store)); store.terminal = true;
    await expect(host.review(result.id)).rejects.toBeInstanceOf(CodingArtifactCleanupError);
    await expect(host.reset()).rejects.toBeInstanceOf(CodingArtifactCleanupError);
    await expect(host.close()).rejects.toBeInstanceOf(CodingArtifactCleanupError); expect(store.size).toBe(1);
  });

  it("keeps an unclaimed producer owned by its producer until explicit discard", async () => {
    const store = new ContractStore(), host = await registry(store), value = await input(store);
    await host.reset(); expect(store.size).toBe(1);
    await host.discard(value.output); expect(store.size).toBe(0); await host.close();
  });
});
