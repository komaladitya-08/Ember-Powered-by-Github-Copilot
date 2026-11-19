/** Portable producer ownership checks; real NTFS capture, ACLs and artifacts run in the Windows integration lane. */
import { expect, it } from "vitest";
import { CodingArtifactCleanupError, CodingResultRegistryError, type CodingArtifactInput, type CodingArtifactRef, type CodingArtifactSourceRef } from "../../app/main/agent/coding-artifact-store";
import { createCodingReviewExport } from "../../app/main/agent/coding-result-export";
import { ownWindowsCodingReview, type WindowsCodingReviewProducer } from "../../app/main/agent/windows-coding-review";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const binding = { owner: "a".repeat(64), session: "11111111-1111-4111-8111-111111111111", snapshot: "22222222-2222-4222-8222-222222222222" };
  const tree = (text: string) => ({ binding, entries: [{ path: "app.ts", kind: "file" as const, bytes: Buffer.from(text), executable: false }] });
  const review = createCodingReviewExport({ binding, baseline: tree("before\n"), proposed: tree("after\n"), current: tree("before\n") }).review;
  const artifact = Object.freeze({}) as CodingArtifactRef, sourceBoundary = Object.freeze({}) as CodingArtifactSourceRef;
  const output = { directory: "C:\\private\\fresh-review", artifact, review, cleanup: "complete" as const };
  const discarded: CodingArtifactInput[] = [];
  let runDiscard = async (_input: CodingArtifactInput): Promise<void> => undefined;
  const store = { discard: async (input: CodingArtifactInput) => { discarded.push(input); await runDiscard(input); } };
  let current = true;
  const producer = ownWindowsCodingReview(store, output, sourceBoundary, () => {
    if (!current) throw new CodingResultRegistryError("stale");
  });
  return { producer, output, artifact, sourceBoundary, discarded,
    revoke: () => { current = false; }, discardWith: (work: typeof runDiscard) => { runDiscard = work; } };
}

it("transfers the exact minted review once without retaining cleanup authority over the host's publication", async () => {
  const f = fixture();
  expect(Object.isFrozen(f.producer)).toBe(true);
  expect(f.producer.sourceBoundary).toBe(f.sourceBoundary);
  expect(f.producer.owned).toBe(true);
  const output = f.producer.transfer();
  expect(output).toBe(f.producer.output);
  expect(output.artifact).toBe(f.artifact);
  expect(output.review.binding).toEqual(f.output.review.binding);
  expect(f.producer.owned).toBe(false);
  expect(() => f.producer.transfer()).toThrowError(expect.objectContaining({ code: "invalid" }));
  try { await f.producer.discard(); } catch (error) { expect(error).toMatchObject({ code: "invalid" }); }
  expect(f.discarded).toEqual([]);
});

it("holds the exact unclaimed capability until disposal settles and prevents a simultaneous transfer", async () => {
  const f = fixture(), gate = deferred();
  f.discardWith(() => gate.promise);
  const first = f.producer.discard(), second = f.producer.discard();
  expect(f.producer.owned).toBe(true);
  expect(() => f.producer.transfer()).toThrowError(expect.objectContaining({ code: "invalid" }));
  await Promise.resolve();
  expect(f.discarded).toHaveLength(1);
  expect(f.discarded[0].directory).toBe(f.output.directory);
  expect(f.discarded[0].artifact).toBe(f.artifact);
  gate.resolve();
  await Promise.all([first, second]);
  expect(f.producer.owned).toBe(false);
  await f.producer.discard();
  expect(f.discarded).toHaveLength(1);
});

it("retains failed exact cleanup ownership so a known disposal failure can be retried", async () => {
  const f = fixture();
  f.discardWith(async () => { throw new CodingResultRegistryError("cleanup"); });
  await expect(f.producer.discard()).rejects.toMatchObject({ code: "cleanup" });
  expect(f.producer.owned).toBe(true);
  expect(() => f.producer.transfer()).toThrowError(expect.objectContaining({ code: "invalid" }));
  f.discardWith(async () => undefined);
  await f.producer.discard();
  expect(f.producer.owned).toBe(false);
  expect(f.discarded).toHaveLength(2);
  expect(f.discarded.every(input => input.directory === f.output.directory && input.artifact === f.artifact)).toBe(true);
});

it("rejects a stale owner before handoff while allowing exact private cleanup without that owner", async () => {
  const f = fixture(); f.revoke();
  expect(() => f.producer.transfer()).toThrowError(expect.objectContaining({ code: "stale" }));
  expect(f.producer.owned).toBe(true);
  expect(f.discarded).toEqual([]);
  await f.producer.discard();
  expect(f.producer.owned).toBe(false);
  expect(f.discarded).toHaveLength(1);
  expect(f.discarded[0].artifact).toBe(f.artifact);
});

it("keeps unknown cleanup terminal instead of retrying a native completion whose ownership is uncertain", async () => {
  const f = fixture(), terminal = new CodingArtifactCleanupError();
  f.discardWith(async () => { throw terminal; });
  await expect(f.producer.discard()).rejects.toBe(terminal);
  f.discardWith(async () => undefined);
  await expect(f.producer.discard()).rejects.toBe(terminal);
  expect(f.producer.owned).toBe(true);
  expect(() => f.producer.transfer()).toThrowError(expect.objectContaining({ code: "invalid" }));
  expect(f.discarded).toHaveLength(1);
});

it("does not transfer when a host-current callback synchronously starts disposal", async () => {
  const f = fixture(), discarded: CodingArtifactInput[] = [];
  let pending: Promise<void> | undefined;
  const producer: WindowsCodingReviewProducer = ownWindowsCodingReview({ discard: async input => { discarded.push(input); } }, f.output, f.sourceBoundary,
    () => { pending = producer.discard(); });
  expect(() => producer.transfer()).toThrowError(expect.objectContaining({ code: "invalid" }));
  await pending;
  expect(producer.owned).toBe(false);
  expect(discarded).toEqual([{ directory: f.output.directory, artifact: f.artifact }]);
});

it("cannot transfer a discarded review or gain cleanup authority from its directory spelling", async () => {
  const f = fixture(); await f.producer.discard();
  expect(() => f.producer.transfer()).toThrowError(expect.objectContaining({ code: "invalid" }));
  expect(f.discarded).toHaveLength(1);
  expect(f.discarded[0]).toEqual({ directory: f.output.directory, artifact: f.artifact });
  expect(f.producer.output.review.changes.map(change => change.path)).toEqual(["app.ts"]);
});
