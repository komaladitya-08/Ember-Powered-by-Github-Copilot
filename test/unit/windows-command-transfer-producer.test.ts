/** Actual canonical/native/Stop/output issuers over low-level portable models; no Windows execution claim. */
import path from "node:path/win32";
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsCommandTransfer as setup } from "../fixtures/windows-command-transfer-fake";
import type { WindowsCommandRootOnlyCompletedRef, WindowsCommandRootOnlyRunRef, WindowsCommandStoppedSnapshotRef } from "../../app/main/agent/windows-command-copy";
import type { WindowsCommandOutputClosedRef } from "../../app/main/agent/windows-command-output";
import type { WindowsCodingCommandInputRef, WindowsCodingCommandReceiverRef } from "../../app/main/agent/windows-coding-copy";

afterEach(() => {
  for (const name of ["node:module", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.restoreAllMocks(); vi.resetModules();
});


it("issues only after the exact run's real Stop, output close, privacy scan and positive native tree retirement", async () => {
  const f = await setup(), v = await f.launch(); f.s.state.code = 17;
  const { done, closed } = await f.finish(v), snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toEqual({ input: f.input, outcome: "natural-exit", exitCode: 17, outputComplete: true });
  expect(Object.keys(snapshot)).toEqual(["scope"]); expect(Object.isFrozen(snapshot)).toBe(true);
  expect(f.s.source.handles.size).toBe(0); expect([...f.s.handles.values()].every(row => row.closed)).toBe(true);
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).not.toThrow();
  await expect(v.command.launchRootOnly(() => ({ process: 1n, thread: 2n, pid: 3 }), () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  await f.close();
});
it("refuses forged, serialized and proxy refs before any native query", async () => {
  const f = await setup(), count = f.nativeCalls.length;
  for (const ref of [{}, { scope: "canonical-command-input" }, new Proxy({}, { get() { throw Error("PRIVATE trap"); } })]) {
    await expect(f.producer.WindowsRootOnlyCommandCopy.createFromInput(ref as WindowsCodingCommandInputRef, f.host)).rejects.toMatchObject({ code: "boundary" });
    expect(() => f.producer.requireWindowsCommandTransferIntake(ref)).toThrow();
    expect(() => f.producer.requireWindowsCommandInputProducerClosed(ref)).toThrow();
    expect(() => f.producer.readWindowsCommandStoppedSnapshot(ref as WindowsCommandStoppedSnapshotRef)).toThrow();
  }
  expect(f.nativeCalls).toHaveLength(count); await f.close();
});
it("rejects authority overrides and accessors without consuming the real input or invoking getters", async () => {
  const f = await setup(), getter = vi.fn(() => "PRIVATE"), count = f.nativeCalls.length;
  for (const options of [{ ...f.host, entries: [] }, { ...f.host, parent: "C:\\other" }, { ...f.host, current: () => true },
    { ...f.host, dependencies: {} }, Object.defineProperty({ ...f.host }, "packageSid", { get: getter })]) {
    await expect(f.producer.WindowsRootOnlyCommandCopy.createFromInput(f.input, options)).rejects.toMatchObject({ code: "boundary" });
  }
  expect(getter).not.toHaveBeenCalled(); expect(f.nativeCalls).toHaveLength(count);
  const command = await f.create(); await expect(f.create()).rejects.toMatchObject({ code: "boundary" });
  await command.close(); await f.close();
});
it("a consumed canonical input blocks canonical close until its exact genuine producer has closed", async () => {
  const f = await setup(), command = await f.create();
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  // Wrong-order canonical close is covered separately: its boundary rejection performs no native cleanup.
  await command.close(); expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).not.toThrow(); await f.close();
});
it("rejects fabricated or mismatched completion/output proofs without taking a native snapshot", async () => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v), count = f.nativeCalls.length;
  for (const [run, completion, output] of [[{} as WindowsCommandRootOnlyRunRef, done, closed], [v.run, {} as WindowsCommandRootOnlyCompletedRef, closed],
    [v.run, done, {} as WindowsCommandOutputClosedRef]] as const) {
    await expect(v.command.captureStoppedSnapshot(run, completion, output)).rejects.toMatchObject({ code: "boundary" });
  }
  expect(f.nativeCalls).toHaveLength(count);
  const snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot).outputComplete).toBe(true);
  await expect(v.command.captureStoppedSnapshot(v.run, done, closed)).rejects.toMatchObject({ code: "cancelled" }); await f.close();
});
it("foreign receiver rejection does not consume a genuine stopped snapshot", async () => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v), snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed);
  expect(() => f.producer.takeWindowsCommandStoppedSnapshot(snapshot, {} as WindowsCodingCommandReceiverRef)).toThrow();
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot).input).toBe(f.input); await f.close();
});
it("scans new full contents including secret text beyond the initial prefix before issuing any snapshot", async () => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v);
  const row = f.s.source.objects.get(path.join(f.s.source.root().name, "app.ts"))!;
  row.bytes = Buffer.from("safe text\n".repeat(30000) + "\n-----BEGIN PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----\n");
  await expect(v.command.captureStoppedSnapshot(v.run, done, closed)).rejects.toMatchObject({ code: "secret" });
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  await v.command.close(); await f.close();
});
it("captured publication revocation refuses metadata without exposing detached bytes", async () => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v), snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed);
  f.canonical.revoke(); expect(() => f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toThrow(); await f.close();
});

it("moves edits, deletion and an empty directory into the same canonical copy and existing broker without changing source or baseline", async () => {
  const f = await setup(), signal = f.copy.signal, directory = f.copy.directory, v = await f.launch();
  const root = f.s.source.root().name, changed = f.s.source.objects.get(path.join(root, "app.ts"))!;
  changed.bytes = Buffer.from("export const answer = 42;\n"); changed.written++;
  const removed = f.s.source.objects.get(path.join(root, "unchanged.bin"))!;
  removed.removed = true; removed.links = 0; removed.deletePending = true;
  f.s.source.add(path.join(root, "empty"), "directory", Buffer.alloc(0), { owner: f.s.source.control.tokenOwner,
    aclOwner: "S-1-5-21-1-2-3-1001", package: f.host.packageSid, inherited: true, low: true });
  const { done, closed } = await f.finish(v), snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed);
  // Redundant native-owner cleanup cannot revoke a detached, separately authorized publication.
  await v.command.close();
  const adoption = f.copy.acceptStoppedCommand(snapshot);
  expect(() => f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toThrow();
  await f.copy.applyStoppedCommand(adoption);
  expect(f.copy.signal).toBe(signal); expect(f.copy.signal.aborted).toBe(false); expect(f.copy.directory).not.toBe(directory);
  expect(f.copy.contentRevision).toBe(1n);
  expect((await f.broker.readText("app.ts")).text).toBe("export const answer = 42;\n");
  expect((await f.broker.list()).entries).toEqual(expect.arrayContaining([{ path: "/work/empty", kind: "directory" }]));
  await expect(f.broker.readText("unchanged.bin")).rejects.toMatchObject({ code: "missing" });
  expect(f.canonical.nodes.get(f.canonical.location("C:\\project\\app.ts").toLowerCase())!.bytes.toString()).toBe("export const answer = 41;\n");
  await f.broker.close(); await f.copy.stop();
  const review = (await f.copy.exportReview()).transfer();
  expect(review.review.binding).toEqual(f.canonical.binding);
  expect(review.review.scope?.source.excludedRoots).toEqual([]);
  expect(review.review.baseline.find(entry => entry.path === "unchanged.bin")).toBeDefined();
  expect(review.review.proposed.find(entry => entry.path === "unchanged.bin")).toBeUndefined();
  expect(review.review.proposed.find(entry => entry.path === "empty")).toMatchObject({ kind: "directory" });
  await f.close();
});
it("task cancellation stops the actual producer immediately and permits only separate cancelled review adoption", async () => {
  const f = await setup(), signal = f.copy.signal, v = await f.launch();
  f.canonical.signal.abort();
  expect(signal.aborted).toBe(true);
  await expect(v.command.launchRootOnly(() => ({ process: 1n, thread: 2n, pid: 3 }), () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  const { done, closed } = await f.finish(v), snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toMatchObject({ outcome: "cancelled", outputComplete: false });
  const adoption = f.copy.acceptStoppedCommand(snapshot);
  await expect(f.copy.applyStoppedCommand(adoption)).rejects.toMatchObject({ code: "cancelled" });
  await f.copy.applyStoppedCommandForReview(adoption);
  expect(f.copy.signal).toBe(signal); expect(signal.aborted).toBe(true);
  await expect(f.broker.readText("app.ts")).rejects.toMatchObject({ code: "cancelled" });
  expect((await f.copy.exportReview()).transfer().review.proposed).toHaveLength(2); await f.close();
});
it("unknown native tree close retains the input owner and blocks every later native query", async () => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v);
  f.s.source.control.fault = "close throw";
  await expect(v.command.captureStoppedSnapshot(v.run, done, closed)).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  const count = f.nativeCalls.length; f.s.source.control.fault = "";
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  await expect(v.command.close()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  expect(f.nativeCalls).toHaveLength(count);
});
it("an older genuine run cannot retire or capture a newer generation", async () => {
  const f = await setup(), v = await f.launch(), first = await f.finish(v);
  f.s.state.ended = false; f.s.state.assigned = false;
  const io = f.s.owner();
  const run = await v.command.launchRootOnlyWithOutput(context => io.createSuspended(context, "C:\\trusted\\node.exe", f.s.command), () => undefined);
  const queried = f.s.calls.filter(call => call.name === "GetAppContainerFolderPath").map(call => (call.args[1] as unknown[])[0]);
  const freed = f.s.calls.filter(call => call.name === "CoTaskMemFree").map(call => call.args[0]);
  expect(queried).toHaveLength(2); expect(new Set(queried).size).toBe(2); expect(freed).toEqual(queried);
  expect(f.s.state.profileFrees).toBe(1);
  const count = f.nativeCalls.length, outputCalls = f.s.calls.length;
  await expect(v.command.captureStoppedSnapshot(v.run, first.done, first.closed)).rejects.toMatchObject({ code: "boundary" });
  expect(f.nativeCalls).toHaveLength(count); expect(f.s.calls).toHaveLength(outputCalls); expect(f.s.state.ended).toBe(false);
  f.s.state.ended = true;
  const done = await v.command.completeRootOnly(run, io.signal), closed = await io.closeOutputAfterStopped(done, run);
  const snapshot = await v.command.captureStoppedSnapshot(run, done, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot).outcome).toBe("natural-exit"); await f.close();
});
it("scans credential-named empty directories as well as file contents", async () => {
  const f = await setup(), v = await f.launch();
  f.s.source.add(path.join(f.s.source.root().name, ".aws"), "directory", Buffer.alloc(0), { owner: f.s.source.control.tokenOwner,
    aclOwner: "S-1-5-21-1-2-3-1001", package: f.host.packageSid, inherited: true, low: true });
  const { done, closed } = await f.finish(v);
  await expect(v.command.captureStoppedSnapshot(v.run, done, closed)).rejects.toMatchObject({ code: "secret" });
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  await v.command.close(); await f.close();
});
it("unknown privacy-scanner close issues no snapshot and permanently retains the producer", async () => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v);
  const privacy = await import("../../app/main/agent/coding-privacy-scanner"), original = privacy.CodingPrivacyScanner.prototype.close;
  const close = vi.spyOn(privacy.CodingPrivacyScanner.prototype, "close").mockImplementation(async function (this: import("../../app/main/agent/coding-privacy-scanner").CodingPrivacyScanner) {
    await original.call(this); throw new privacy.CodingPrivacyCleanupError();
  });
  await expect(v.command.captureStoppedSnapshot(v.run, done, closed)).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  expect(close).toHaveBeenCalledTimes(1);
  const count = f.nativeCalls.length; vi.restoreAllMocks();
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  await expect(v.command.close()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" }); expect(f.nativeCalls).toHaveLength(count);
});

it("legacy raw-entry owners cannot issue adoptable snapshots even with genuine Stop and output closure", async () => {
  const f = await setup(), v = await f.s.launch(); f.s.state.ended = true;
  const done = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(done, v.run), count = f.s.source.calls.length;
  await expect(v.copy.captureStoppedSnapshot(v.run, done, closed)).rejects.toMatchObject({ code: "boundary" });
  expect(f.s.source.calls).toHaveLength(count); await v.copy.close(); await f.close();
});
it("settles a consumed input positively when initialization cancels before any native tree is created", async () => {
  const f = await setup(), count = f.nativeCalls.length;
  f.host.packageCurrent = () => { f.canonical.signal.abort(); return true; };
  await expect(f.create()).rejects.toMatchObject({ code: "cancelled" });
  expect(f.nativeCalls).toHaveLength(count);
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).not.toThrow(); await f.close();
});
it("unknown native tree initialization never fabricates a closed producer receipt", async () => {
  const f = await setup(); f.s.source.control.fault = "create throw";
  await expect(f.create()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  const count = f.nativeCalls.length; f.s.source.control.fault = "";
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  await expect(f.create()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" }); expect(f.nativeCalls).toHaveLength(count);
});
it("canonical cleanup erases an unclaimed snapshot after publication revocation", async () => {
  const f = await setup(), v = await f.launch(), payload = Buffer.from("fixed detached disposal payload\n".repeat(73));
  const changed = f.s.source.objects.get(path.join(f.s.source.root().name, "app.ts"))!;
  changed.bytes = payload; changed.written++;
  const { done, closed } = await f.finish(v), samples: Buffer[] = [], allocate = Buffer.alloc;
  const allocation = vi.spyOn(Buffer, "alloc").mockImplementation((size, fill, encoding) => {
    const bytes = allocate(size, fill, encoding); if (size === payload.length) samples.push(bytes); return bytes;
  });
  const snapshot = await v.command.captureStoppedSnapshot(v.run, done, closed); allocation.mockRestore();
  const detached = samples.filter(bytes => bytes.equals(payload)); expect(detached.length).toBeGreaterThan(0);
  expect(() => f.producer.discardWindowsCommandInputSnapshot(f.input, {} as WindowsCodingCommandReceiverRef)).toThrow();
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot).input).toBe(f.input);
  expect(detached.every(bytes => bytes.equals(payload))).toBe(true);
  f.canonical.revoke(); await f.close();
  expect(detached.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  expect(() => f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toThrow(expect.objectContaining({ code: "boundary" }));
});

it.each(["preexisting", "inside-publication-callback"])("privacy uncertainty %s poisons before native snapshot or scanner admission", async mode => {
  const f = await setup(), v = await f.launch(), { done, closed } = await f.finish(v);
  const privacy = await import("../../app/main/agent/coding-privacy-scanner"), original = privacy.assertCodingPrivacyScope;
  let checks = 0;
  vi.spyOn(privacy, "assertCodingPrivacyScope").mockImplementation(scope => {
    if (mode === "inside-publication-callback" && ++checks === 1) return original(scope);
    throw new privacy.CodingPrivacyCleanupError();
  });
  const scanner = vi.spyOn(privacy, "CodingPrivacyScanner"), count = f.nativeCalls.length;
  await expect(v.command.captureStoppedSnapshot(v.run, done, closed)).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  expect(scanner).not.toHaveBeenCalled(); expect(f.nativeCalls).toHaveLength(count); vi.restoreAllMocks();
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).toThrow();
  await expect(v.command.close()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" }); expect(f.nativeCalls).toHaveLength(count);
});
