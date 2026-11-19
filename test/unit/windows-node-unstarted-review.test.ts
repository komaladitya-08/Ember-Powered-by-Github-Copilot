/** Actual canonical/input/profile/native issuers over portable DLL models; no manufactured no-run reference. */
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsCommandTransfer as setup } from "../fixtures/windows-command-transfer-fake";

afterEach(() => {
  for (const name of ["node:module", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.restoreAllMocks(); vi.resetModules();
});

it("preserves old broker edits for review after genuine positive initialization cancellation without issuing a run", async () => {
  const f = await setup({ beforeCapture: async broker => { await broker.replaceText("app.ts", "41", "42"); } });
  f.host.packageCurrent = () => false;
  await expect(f.create()).rejects.toMatchObject({ code: "cancelled" });
  expect(() => f.producer.requireWindowsCommandUnstartedInput(f.input)).not.toThrow();
  await f.copy.stop(); await f.broker.close(); await f.copy.releaseUnstartedForReview();
  expect(f.copy.signal.aborted).toBe(true); expect(f.copy.contentRevision).toBe(1n);
  expect(() => f.producer.requireWindowsCommandUnstartedInput(f.input)).toThrow();
  await expect(f.create()).rejects.toMatchObject({ code: "boundary" });
  await expect(f.copy.files(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  const producer = await f.copy.exportReview(), review = producer.output.review;
  const before = review.baseline.find(row => row.path === "app.ts")!, after = review.proposed.find(row => row.path === "app.ts")!;
  expect(before.kind === "file" && Buffer.from(before.base64, "base64").toString()).toContain("41");
  expect(after.kind === "file" && Buffer.from(after.base64, "base64").toString()).toContain("42");
  expect(review.current).toEqual(review.baseline); await producer.discard(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it("requires permanent retirement and actual controller/broker closure, while a known preflight refusal remains retryable", async () => {
  const f = await setup(); f.host.packageCurrent = () => false; await expect(f.create()).rejects.toMatchObject({ code: "cancelled" });
  await expect(f.copy.releaseUnstartedForReview()).rejects.toMatchObject({ code: "boundary" });
  f.canonical.closeController(false); await f.copy.stop();
  await expect(f.copy.releaseUnstartedForReview()).rejects.toMatchObject({ code: "boundary" });
  f.canonical.closeController(true); await f.broker.close(); await f.copy.releaseUnstartedForReview();
  await expect(f.copy.releaseUnstartedForReview()).rejects.toMatchObject({ code: "boundary" });
  await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it("foreign/serialized input and receiver claims cannot release the genuine closed producer", async () => {
  const f = await setup(); f.host.packageCurrent = () => false; await expect(f.create()).rejects.toMatchObject({ code: "cancelled" });
  const count = f.nativeCalls.length;
  for (const input of [{}, { scope: "canonical-command-input", closed: true }, new Proxy({}, { get() { throw Error("PRIVATE trap"); } })]) {
    expect(() => f.producer.requireWindowsCommandUnstartedInput(input as never)).toThrow();
    expect(() => f.producer.releaseWindowsCommandUnstartedInput(input as never, {} as never)).toThrow();
  }
  expect(() => f.producer.releaseWindowsCommandUnstartedInput(f.input, {} as never)).toThrow();
  expect(() => f.producer.requireWindowsCommandUnstartedInput(f.input)).not.toThrow(); expect(f.nativeCalls).toHaveLength(count);
  await f.copy.stop(); await f.broker.close(); await f.copy.releaseUnstartedForReview(); await f.close();
});

it("a live native tree cannot release its input even after canonical Stop; positive exact producer close is still required", async () => {
  const f = await setup(), command = await f.create(); await f.copy.stop(); await f.broker.close();
  const queries = vi.spyOn(f.canonical.api, "info"), count = f.nativeCalls.length;
  await expect(f.copy.releaseUnstartedForReview()).rejects.toMatchObject({ code: "boundary" });
  expect(queries).not.toHaveBeenCalled(); expect(f.nativeCalls).toHaveLength(count);
  await command.close(); await f.copy.releaseUnstartedForReview(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it.each([false, true])("an owner that issued a genuine run cannot release old contents through no-run recovery (snapshot=%s)", async snapshot => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v);
  const detached = snapshot ? await v.command.captureStoppedSnapshot(v.run, done, closed) : undefined;
  if (!snapshot) await v.command.close();
  await f.copy.stop(); await f.broker.close();
  const queries = vi.spyOn(f.canonical.api, "info"), count = f.nativeCalls.length;
  await expect(f.copy.releaseUnstartedForReview()).rejects.toMatchObject({ code: "boundary" });
  expect(queries).not.toHaveBeenCalled(); expect(f.nativeCalls).toHaveLength(count);
  if (detached) {
    const adoption = f.copy.acceptStoppedCommand(detached); await f.copy.applyStoppedCommandForReview(adoption);
  }
  await f.close(); expect(f.canonical.handles.size).toBe(0);
});

it("unknown creator initialization retains the input and blocks all later canonical or producer native queries", async () => {
  const f = await setup(); f.s.source.control.fault = "create throw";
  await expect(f.create()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  await f.copy.stop(); await f.broker.close(); const queries = vi.spyOn(f.canonical.api, "info"), count = f.nativeCalls.length;
  await expect(f.copy.releaseUnstartedForReview()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  await expect(f.copy.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(queries).not.toHaveBeenCalled(); expect(f.nativeCalls).toHaveLength(count);
});


it("Stop after a resolved but unconsumed capture releases only old edited data for review and destroys the old input", async () => {
  const f = await setup({ beforeCapture: async broker => { await broker.replaceText("app.ts", "41", "43"); } });
  const original = f.copy.directory, signal = f.copy.signal;
  await f.copy.stop(); await f.broker.close();
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  await f.copy.releaseUnstartedForReview();
  expect(f.copy.directory).toBe(original); expect(f.copy.signal).toBe(signal); expect(signal.aborted).toBe(true); expect(f.copy.contentRevision).toBe(1n);
  const calls = f.nativeCalls.length;
  await expect(f.create()).rejects.toMatchObject({ code: "boundary" }); expect(f.nativeCalls).toHaveLength(calls);
  await expect(f.copy.files(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  const producer = await f.copy.exportReview(), review = producer.output.review;
  const before = review.baseline.find(row => row.path === "app.ts")!, after = review.proposed.find(row => row.path === "app.ts")!;
  expect(before.kind === "file" && Buffer.from(before.base64, "base64").toString()).toContain("41");
  expect(after.kind === "file" && Buffer.from(after.base64, "base64").toString()).toContain("43");
  expect(review.current).toEqual(review.baseline); await producer.discard(); await f.close(); expect(f.canonical.handles.size).toBe(0);
});
