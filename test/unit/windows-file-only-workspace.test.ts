/** Portable adapter ownership/lifecycle tests; native Windows suites prove the copy, ACL and artifact boundaries. */
import { beforeEach, expect, it, vi } from "vitest";
import { WindowsFileOnlyWorkspace, WindowsFileOnlyWorkspaceCleanupError, type WindowsFileOnlyWorkspaceInput } from "../../app/main/agent/windows-file-only-workspace";
import { ownWindowsCodingReview } from "../../app/main/agent/windows-coding-review";
import { createCodingReviewExport } from "../../app/main/agent/coding-result-export";
import { CodingArtifactCleanupError, CodingResultRegistryError, type CodingArtifactInput, type CodingArtifactRef, type CodingArtifactSourceRef } from "../../app/main/agent/coding-artifact-store";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";
import { CodingPrivacyCleanupError } from "../../app/main/agent/coding-privacy-scanner";
import type { WindowsCodingArtifactStore } from "../../app/main/agent/windows-coding-artifact-store";
import type { WindowsCodingCopyInput } from "../../app/main/agent/windows-coding-copy";

const mocks = vi.hoisted(() => ({ copyCreate: vi.fn(), brokerCreate: vi.fn() }));
vi.mock("../../app/main/agent/windows-coding-copy", () => ({ WindowsCodingCopy: { create: mocks.copyCreate } }));
vi.mock("../../app/main/agent/windows-scoped-coding-files", () => ({ WindowsScopedCodingFiles: { create: mocks.brokerCreate } }));

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { mocks.copyCreate.mockReset(); mocks.brokerCreate.mockReset(); });

function fixture() {
  const events: string[] = [], binding = { owner: "a".repeat(64), session: "11111111-1111-4111-8111-111111111111", snapshot: "22222222-2222-4222-8222-222222222222" };
  const tree = (value: string) => ({ binding, entries: [{ path: "app.ts", kind: "file" as const, bytes: Buffer.from(value), executable: false }] });
  const review = createCodingReviewExport({ binding, baseline: tree("before\n"), proposed: tree("after\n"), current: tree("before\n") }).review;
  const artifact = Object.freeze({}) as CodingArtifactRef, sourceBoundary = Object.freeze({}) as CodingArtifactSourceRef;
  const originalOutput = { directory: "C:\\reviews\\minted-review", artifact, review, cleanup: "retained" as const };
  const store = { discard: vi.fn(async (_input: CodingArtifactInput) => { events.push("discard"); }) };
  const producer = ownWindowsCodingReview(store, originalOutput, sourceBoundary, () => undefined);
  const transfer = vi.spyOn({ transfer: () => producer.transfer() }, "transfer");
  const minted = { ...producer, get owned() { return producer.owned; }, transfer };
  let producerCreated = false, closeWork: () => Promise<void> = async () => undefined, closing: Promise<void> | null = null;
  const copy = {
    excludedRoots: [".git", "node_modules"],
    files: vi.fn(async (operation: (root: string) => Promise<unknown>) => operation("C:\\copies\\private-copy")),
    stop: vi.fn(async () => { events.push("copy-stop"); }),
    exportReview: vi.fn(async (_store: WindowsCodingArtifactStore) => { events.push("export"); producerCreated = true; return minted; }),
    close: vi.fn(() => {
      if (!closing) closing = Promise.resolve().then(async () => {
        events.push("copy-close"); await closeWork(); if (producerCreated && producer.owned) await producer.discard(); events.push("copy-closed");
      });
      return closing;
    }),
  };
  const broker = {
    tag: "broker-receiver", close: vi.fn(async () => { events.push("broker-close"); }),
    async readText(_path: string) { return this.tag; },
  };
  const signal = new AbortController().signal;
  const input: WindowsFileOnlyWorkspaceInput = { source: "C:\\project", privateBase: "C:\\copies", protectedPaths: ["C:\\protected"], signal,
    current: () => true, scope: { excludeRoots: [".git", "node_modules"] }, reviewBase: "C:\\reviews",
    review: { binding, store: store as unknown as WindowsCodingArtifactStore, current: () => true } };
  mocks.copyCreate.mockResolvedValue(copy); mocks.brokerCreate.mockResolvedValue(broker);
  return { input, events, copy, broker, producer, minted, transfer, originalOutput, artifact, sourceBoundary, store, signal,
    create: () => WindowsFileOnlyWorkspace.create(input), closeWith: (work: () => Promise<void>) => { closeWork = work; },
    captured: () => mocks.copyCreate.mock.calls[0][0] as WindowsCodingCopyInput };
}

it("offers copied files and review without a command, Node or process-launch capability", async () => {
  const f = fixture(), workspace = await f.create();
  expect(workspace.executionRoot).toBe("/work"); expect(workspace.excludedRoots).toEqual([".git", "node_modules"]);
  for (const name of ["run", "nodeAvailable", "shells", "spawn", "exec", "facts"]) expect(workspace).not.toHaveProperty(name);
  expect(await workspace.files(async root => root + "\\app.ts")).toBe("C:\\copies\\private-copy\\app.ts");
  expect(f.copy.files).toHaveBeenCalledOnce(); expect(f.captured().review?.controllerClosed()).toBe(false);
  expect(f.captured().review?.store).toBe(f.input.review.store); expect(f.captured().review?.binding).toEqual(f.input.review.binding);
  expect(f.captured().review?.binding).not.toBe(f.input.review.binding); await workspace.close();
});

it("refuses missing review authority or destination before allocating a native copy", async () => {
  const f = fixture();
  for (const invalid of [{ ...f.input, review: undefined }, { ...f.input, reviewBase: "" }]) {
    await expect(WindowsFileOnlyWorkspace.create(invalid as unknown as WindowsFileOnlyWorkspaceInput)).rejects.toMatchObject({ code: "unavailable" });
  }
  expect(mocks.copyCreate).not.toHaveBeenCalled();
});

it("refuses export before sealing and refuses a different review destination", async () => {
  const f = fixture(), workspace = await f.create();
  expect(() => workspace.sourceBoundary).toThrowError(expect.objectContaining({ code: "invalid" }));
  await expect(workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "boundary" });
  await workspace.sealForReview(); await expect(workspace.exportReview("C:\\other-reviews")).rejects.toMatchObject({ code: "boundary" });
  expect(f.copy.exportReview).not.toHaveBeenCalled(); await workspace.close();
});

it("seals only after the shared broker close receipt and actual copy stop both settle", async () => {
  const f = fixture(), brokerClosed = deferred(), stopped = deferred(), workspace = await f.create();
  f.broker.close.mockImplementation(async () => { f.events.push("broker-close"); await brokerClosed.promise; f.events.push("broker-closed"); });
  f.copy.stop.mockImplementation(async () => { f.events.push("copy-stop"); await stopped.promise; f.events.push("copy-stopped"); });
  const broker = await workspace.filesBroker(f.signal), sealing = workspace.sealForReview();
  expect(workspace.sealForReview()).toBe(sealing); const workerClose = broker.close();
  await turn(); expect(f.captured().review?.controllerClosed()).toBe(false); expect(f.copy.stop).not.toHaveBeenCalled();
  brokerClosed.resolve(); await workerClose; await turn(); expect(f.copy.stop).toHaveBeenCalledOnce();
  expect(f.captured().review?.controllerClosed()).toBe(false); stopped.resolve(); await sealing;
  expect(f.captured().review?.controllerClosed()).toBe(true); expect(f.broker.close).toHaveBeenCalledOnce();
  expect(f.events).toEqual(["broker-close", "broker-closed", "copy-stop", "copy-stopped"]); await workspace.close();
});

it("admits only one file broker, preserves its receiver, and shares one close receipt", async () => {
  const f = fixture(), workspace = await f.create(), broker = await workspace.filesBroker(f.signal);
  expect(await broker.readText("app.ts")).toBe("broker-receiver");
  expect(mocks.brokerCreate).toHaveBeenCalledWith({ copy: f.copy, signal: f.signal, workspace });
  await expect(workspace.filesBroker(f.signal)).rejects.toMatchObject({ code: "cancelled" });
  const first = broker.close(), second = broker.close(); expect(second).toBe(first); await first;
  expect(f.broker.close).toHaveBeenCalledOnce(); await workspace.sealForReview(); await workspace.close(); expect(f.broker.close).toHaveBeenCalledOnce();
});

it.each(["seal", "close"] as const)("closes a late-opening broker before refusing its delivery during %s", async operation => {
  const f = fixture(), opening = deferred<typeof f.broker>(), closingBroker = deferred(), workspace = await f.create();
  mocks.brokerCreate.mockReturnValue(opening.promise); f.broker.close.mockImplementation(() => closingBroker.promise);
  const delivered = workspace.filesBroker(f.signal).catch(error => error); await turn();
  const finishing = operation === "seal" ? workspace.sealForReview() : workspace.close();
  let finished = false; void finishing.then(() => { finished = true; }); opening.resolve(f.broker); await turn();
  expect(f.broker.close).toHaveBeenCalledOnce(); expect(finished).toBe(false); expect(f.copy.stop).not.toHaveBeenCalled();
  closingBroker.resolve(); expect(await delivered).toMatchObject({ code: "cancelled" }); await finishing;
  if (operation === "seal") { expect(f.copy.stop).toHaveBeenCalledOnce(); await workspace.close(); }
  expect(f.broker.close).toHaveBeenCalledOnce();
});

it("does not invent a broker cleanup failure when creation failed without minting authority", async () => {
  const f = fixture(), workspace = await f.create(); mocks.brokerCreate.mockRejectedValue(new ScopedCodingFileError("unavailable"));
  await expect(workspace.filesBroker(f.signal)).rejects.toMatchObject({ code: "unavailable" });
  await workspace.sealForReview(); expect(f.captured().review?.controllerClosed()).toBe(true); await workspace.close();
  expect(f.broker.close).not.toHaveBeenCalled();
});

it.each(["opening", "broker-close", "copy-stop"] as const)("caches typed cleanup uncertainty when %s cannot be verified", async failure => {
  const f = fixture(), workspace = await f.create(), problem = new WindowsCodingCleanupError();
  if (failure === "opening") {
    mocks.brokerCreate.mockRejectedValue(problem); await expect(workspace.filesBroker(f.signal)).rejects.toBe(problem);
  } else {
    await workspace.filesBroker(f.signal);
    if (failure === "broker-close") f.broker.close.mockRejectedValue(problem); else f.copy.stop.mockRejectedValue(problem);
  }
  const sealing = workspace.sealForReview(), error = await sealing.catch(value => value);
  expect(error).toBeInstanceOf(WindowsFileOnlyWorkspaceCleanupError); const retry = workspace.sealForReview(); expect(retry).not.toBe(sealing);
  await expect(retry).rejects.toBe(error); await expect(workspace.exportReview(f.input.reviewBase)).rejects.toBe(error);
  expect(f.captured().review?.controllerClosed()).toBe(false); expect(f.copy.exportReview).not.toHaveBeenCalled();
  const closing = workspace.close(); expect(workspace.close()).toBe(closing); await expect(closing).rejects.toBe(error);
});

it("transfers the exact producer into its ledger before awaiting copy cleanup and returns complete only afterwards", async () => {
  const f = fixture(), closed = deferred(), workspace = await f.create(); f.closeWith(() => closed.promise); await workspace.sealForReview();
  const exporting = workspace.exportReview(f.input.reviewBase); expect(workspace.exportReview(f.input.reviewBase)).toBe(exporting);
  let settled = false; void exporting.then(() => { settled = true; }); await turn();
  expect(f.transfer).toHaveBeenCalledOnce(); expect(f.producer.owned).toBe(false); expect(f.copy.close).toHaveBeenCalledOnce();
  expect(workspace.sourceBoundary).toBe(f.sourceBoundary); expect(f.store.discard).not.toHaveBeenCalled(); expect(settled).toBe(false);
  closed.resolve(); const output = await exporting;
  expect(output).toMatchObject({ artifact: f.artifact, directory: f.originalOutput.directory, cleanup: "complete" });
  expect(output.review).toBe(f.originalOutput.review); expect(Object.isFrozen(output)).toBe(true);
  const sourceBoundary = workspace.sourceBoundary; workspace.transferReview(output); expect(sourceBoundary).toBe(f.sourceBoundary);
  expect(() => workspace.sourceBoundary).toThrowError(expect.objectContaining({ code: "invalid" }));
  await expect(workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "boundary" });
  await workspace.close(); expect(f.store.discard).not.toHaveBeenCalled();
});

it("requires exact result identity and consumes transfer only once", async () => {
  const f = fixture(), workspace = await f.create(); await workspace.sealForReview(); const output = await workspace.exportReview(f.input.reviewBase);
  expect(() => workspace.transferReview({ ...output })).toThrowError(expect.objectContaining({ code: "invalid" }));
  expect(workspace.sourceBoundary).toBe(f.sourceBoundary); workspace.transferReview(output);
  expect(() => workspace.transferReview(output)).toThrowError(expect.objectContaining({ code: "invalid" }));
  await workspace.close(); expect(f.store.discard).not.toHaveBeenCalled();
});

it("discards only its exact untransferred artifact on close and drops public access to its source receipt", async () => {
  const f = fixture(), workspace = await f.create(); await workspace.sealForReview(); const output = await workspace.exportReview(f.input.reviewBase);
  const closing = workspace.close(); expect(workspace.close()).toBe(closing); await closing;
  expect(f.store.discard).toHaveBeenCalledExactlyOnceWith(output); expect(() => workspace.sourceBoundary).toThrowError(expect.objectContaining({ code: "invalid" }));
  expect(() => workspace.transferReview(output)).toThrowError(expect.objectContaining({ code: "invalid" }));
  await expect(workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "boundary" });
});

it.each([true, false])("preserves exactly one artifact owner across pending export and close (resource transfer: %s)", async transfer => {
  const f = fixture(), closed = deferred(), workspace = await f.create(); f.closeWith(() => closed.promise); await workspace.sealForReview();
  const exporting = workspace.exportReview(f.input.reviewBase), ledger: CodingArtifactInput[] = [];
  // The resources owner installs this synchronous receipt handoff before close attaches its drain continuation.
  const publication = exporting.then(output => { if (transfer) { ledger.push({ directory: output.directory, artifact: output.artifact }); workspace.transferReview(output); } return output; });
  await turn(); const closing = workspace.close(); closed.resolve(); const output = await publication; await closing;
  expect(f.transfer).toHaveBeenCalledOnce(); expect(f.producer.owned).toBe(false);
  if (transfer) { expect(ledger).toEqual([{ directory: output.directory, artifact: output.artifact }]); expect(f.store.discard).not.toHaveBeenCalled(); }
  else { expect(ledger).toEqual([]); expect(f.store.discard).toHaveBeenCalledExactlyOnceWith(output); }
  expect(() => workspace.sourceBoundary).toThrowError(expect.objectContaining({ code: "invalid" }));
});

it.each([() => new WindowsCodingCleanupError(), () => new CodingPrivacyCleanupError(), () => new CodingArtifactCleanupError()])(
  "retains the transferred producer while unknown copy cleanup is cached as a typed terminal failure", async problem => {
    const f = fixture(), workspace = await f.create(), failure = problem(); f.closeWith(async () => { throw failure; }); await workspace.sealForReview();
    const exporting = workspace.exportReview(f.input.reviewBase), error = await exporting.catch(value => value);
    expect(error).toBeInstanceOf(WindowsFileOnlyWorkspaceCleanupError); expect(f.transfer).toHaveBeenCalledOnce(); expect(f.producer.owned).toBe(false);
    expect(workspace.sourceBoundary).toBe(f.sourceBoundary); expect(f.store.discard).not.toHaveBeenCalled();
    await expect(workspace.exportReview(f.input.reviewBase)).rejects.toBe(error);
    const closing = workspace.close(); expect(workspace.close()).toBe(closing); await expect(closing).rejects.toBe(error);
    expect(f.store.discard).toHaveBeenCalledExactlyOnceWith(f.producer.output);
    expect(() => workspace.transferReview(f.producer.output)).toThrow(error);
  });

it("retains the exact output when artifact discard is uncertain and never retries a cached close", async () => {
  const f = fixture(), workspace = await f.create(); await workspace.sealForReview(); const output = await workspace.exportReview(f.input.reviewBase);
  f.store.discard.mockRejectedValue(new CodingArtifactCleanupError());
  const closing = workspace.close(), error = await closing.catch(value => value);
  expect(error).toBeInstanceOf(WindowsFileOnlyWorkspaceCleanupError); expect(workspace.close()).toBe(closing);
  await expect(workspace.close()).rejects.toBe(error); expect(f.store.discard).toHaveBeenCalledExactlyOnceWith(output);
  expect(workspace.sourceBoundary).toBe(f.sourceBoundary); expect(() => workspace.transferReview(output)).toThrow(error);
});

it("does not transfer a result once close has begun its exact artifact disposal", async () => {
  const f = fixture(), entered = deferred(), disposed = deferred(), workspace = await f.create(); await workspace.sealForReview();
  const output = await workspace.exportReview(f.input.reviewBase);
  f.store.discard.mockImplementation(async () => { entered.resolve(); await disposed.promise; });
  const closing = workspace.close(); await entered.promise;
  try { expect(() => workspace.transferReview(output)).toThrowError(expect.objectContaining({ code: "invalid" })); }
  finally { disposed.resolve(); await closing; }
  expect(f.store.discard).toHaveBeenCalledExactlyOnceWith(output);
  expect(() => workspace.sourceBoundary).toThrowError(expect.objectContaining({ code: "invalid" }));
});

it("lets ordinary export refusals preserve their public error while closing only the copy", async () => {
  const f = fixture(), workspace = await f.create(), refusal = new ScopedCodingFileError("secret"); await workspace.sealForReview();
  f.copy.exportReview.mockRejectedValue(refusal); await expect(workspace.exportReview(f.input.reviewBase)).rejects.toBe(refusal);
  expect(f.transfer).not.toHaveBeenCalled(); await workspace.close(); expect(f.store.discard).not.toHaveBeenCalled();
});

it("rejects a failed producer handoff without discarding authority it never acquired", async () => {
  const f = fixture(), workspace = await f.create(); await workspace.sealForReview();
  f.transfer.mockImplementation(() => { throw new CodingResultRegistryError("stale"); });
  await expect(workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "stale" });
  expect(() => workspace.sourceBoundary).toThrowError(expect.objectContaining({ code: "invalid" }));
  await workspace.close(); expect(f.store.discard).toHaveBeenCalledExactlyOnceWith({ directory: f.originalOutput.directory, artifact: f.artifact });
});
