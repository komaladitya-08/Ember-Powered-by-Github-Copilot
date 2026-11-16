/** Injectable ABI composition only. Synthetic streamed hashes are a crypto-boundary test seam, never runtime trust. */
import { afterEach, expect, it, vi } from "vitest";
import type * as Crypto from "node:crypto";

const hashing = vi.hoisted(() => ({ completed: [] as { marker: number; bytes: number; exact: boolean }[] }));
vi.mock("node:crypto", async original => {
  const actual = await original<typeof Crypto>();
  const fixed = new Map([
    [78, { bytes: 120219136, sha256: "d95bc2f8d456eb84306f54aa798c17ee21e5fd22591f943fc13c6adc8fd115db" }],
    [76, { bytes: 145485, sha256: "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4" }],
    [82, { bytes: 6035, sha256: "f50e4859309b72dde505b99cd4c8edd926f2c55dc4aa74f035712d0d5323c9ad" }],
  ]);
  const chunks = new Map([...fixed.keys()].map(marker => [marker, Buffer.alloc(65536, marker)]));
  return { ...actual, createHash(algorithm: string) {
    if (algorithm !== "sha256") return actual.createHash(algorithm);
    let marker: number | undefined, bytes = 0, exact = true, fallback: ReturnType<typeof actual.createHash> | undefined;
    const result = {
      update(data: string | Uint8Array, encoding?: BufferEncoding) {
        const b = typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        if (!bytes && b.length && fixed.has(b[0])) marker = b[0];
        if (marker === undefined) (fallback ??= actual.createHash(algorithm)).update(b);
        else exact &&= b.length <= 65536 && b.equals(chunks.get(marker)!.subarray(0, b.length));
        bytes += b.length; return result;
      },
      digest(encoding: "hex") {
        if (marker === undefined) return (fallback ??= actual.createHash(algorithm)).digest(encoding);
        hashing.completed.push({ marker, bytes, exact }); const pin = fixed.get(marker)!;
        return exact && bytes === pin.bytes ? pin.sha256 : "0".repeat(64);
      },
    };
    return result;
  } };
});

import { setupWindowsCommandTransfer } from "../fixtures/windows-command-transfer-fake";
import type { WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";
import path from "node:path/win32";

afterEach(() => {
  for (const name of ["node:module", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.restoreAllMocks(); vi.resetModules();
});

it("the fixed asset use composes with genuine canonical input, stopped snapshot and positive producer retirement", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake"), s = nodeAssetFake({ io: f.s }), owner = await s.prepare();
  const command = await f.create(); let launch: WindowsCommandOutputLaunchRef | undefined;
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["--preserve-symlinks", "--preserve-symlinks-main", "test.cjs"], f.s.options), () => undefined);
  f.s.state.ended = true; const done = await command.completeRootOnly(run, f.s.abort.signal), closed = await owner.finishOutput(done, run, launch!);
  const snapshot = await command.captureStoppedSnapshot(run, done, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toMatchObject({ outcome: "natural-exit", exitCode: 0, outputComplete: true });
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).not.toThrow(); await owner.close(); await f.close();
});

it("a later authenticated empty cancellation cannot revive an older real run's canonical snapshot authority", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake"), s = nodeAssetFake({ io: f.s }), owner = await s.prepare();
  const command = await f.create(); let launch: WindowsCommandOutputLaunchRef | undefined;
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["test.cjs"], f.s.options), () => undefined);
  f.s.state.ended = true; const done = await command.completeRootOnly(run, f.s.abort.signal), closed = await owner.finishOutput(done, run, launch!);
  f.s.state.ended = false; f.s.state.assigned = false; s.state.current = false;
  await expect(command.launchRootOnlyWithOutput(context => owner.createSuspended(context, ["new.cjs"], f.s.options), () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  expect(s.io.state.creates).toBe(1); const queries = f.nativeCalls.length, assetQueries = s.calls.length;
  await expect(command.captureStoppedSnapshot(run, done, closed)).rejects.toMatchObject({ code: "boundary" });
  expect(f.nativeCalls).toHaveLength(queries); expect(s.calls).toHaveLength(assetQueries);
  expect(s.fence.failure).toBeUndefined(); await command.close(); await owner.close(); await f.close();
});

it.each(["created", "assigned"] as const)("a shared task cancelled after the PI is %s stops without execution and keeps genuine cancelled snapshot authority", async point => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal }), owner = await s.prepare(), command = await f.create();
  const assetQueries = s.calls.length; let launch: WindowsCommandOutputLaunchRef | undefined, aborted = false;
  const abort = () => { if (!aborted) { aborted = true; f.canonical.signal.abort(); } };
  if (point === "created") f.s.state.onNative = name => { if (name === "CreateProcessW") abort(); };
  else {
    const push = f.s.events.push.bind(f.s.events);
    f.s.events.push = (...events: string[]) => { const count = push(...events); if (events.includes("assign")) abort(); return count; };
  }
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["test.cjs"], f.s.options), () => undefined);
  expect(aborted).toBe(true); expect(f.copy.signal.aborted).toBe(true); expect(f.s.state.creates).toBe(1); expect(f.s.events).not.toContain("resume");
  expect(f.s.events.includes("assign")).toBe(point === "assigned");
  expect(f.s.events).toContain("TerminateProcess"); expect(f.s.events).toContain("TerminateJobObject"); expect(f.s.events.filter(event => event === "root-close")).toHaveLength(3);
  expect(f.s.source.calls.some(call => call.name === "OpenProcessToken" && call.args[0] === f.s.state.returnedProcess)).toBe(false);
  expect(s.calls).toHaveLength(assetQueries); expect(s.fence.failure).toBeUndefined(); expect(f.s.output).toEqual([]);
  const completed = await command.completeRootOnly(run, f.copy.signal), closed = await owner.finishOutput(completed, run, launch!);
  const snapshot = await command.captureStoppedSnapshot(run, completed, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toMatchObject({ outcome: "cancelled", exitCode: null, outputComplete: false });
  const adoption = f.copy.acceptStoppedCommand(snapshot); await f.copy.applyStoppedCommandForReview(adoption);
  await owner.close(); await f.close();
});

it("an already-aborted returned PI drains both streams and settles every IRP before native event/buffer disposal", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal }), owner = await s.prepare(), command = await f.create();
  const streamMemory = new Set<unknown>(), streamHandles = new Set<bigint>(), eof = new Set<bigint>(); let launch: WindowsCommandOutputLaunchRef | undefined;
  f.s.state.holdEOF = true;
  f.s.state.onNative = (name, args) => {
    if (name === "CreateProcessW") {
      for (const memory of [...f.s.allocations.keys()].slice(0, 4)) streamMemory.add(memory);
      for (const pipe of f.s.pipes) streamHandles.add(pipe.server);
      for (const [raw, owned] of f.s.handles) if (owned.kind === "event") streamHandles.add(raw);
      f.canonical.signal.abort();
    }
    if (name === "CloseHandle" && streamHandles.has(args[0] as bigint)) { expect(eof.size).toBe(2); expect(f.s.pipes.every(pipe => !pipe.pending)).toBe(true); }
  };
  f.s.state.afterNative = (name, args, result) => {
    if (["ReadFile", "GetOverlappedResult"].includes(name) && result === 0 && f.s.state.error === 109 && f.s.pipes.some(pipe => pipe.server === args[0])) eof.add(args[0] as bigint);
    return result;
  };
  const free = f.s.native.free;
  f.s.native.free = ref => { if (streamMemory.has(ref)) { expect(eof.size).toBe(2); expect(f.s.pipes.every(pipe => !pipe.pending)).toBe(true); } return free(ref); };
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["test.cjs"], f.s.options), () => undefined);
  expect(f.s.events).not.toContain("assign"); expect(f.s.events).not.toContain("resume"); expect(f.s.output).toEqual([]);
  for (const pipe of f.s.pipes) expect(f.s.calls.some(call => call.name === "ReadFile" && call.args[0] === pipe.server)).toBe(true);
  const completed = await command.completeRootOnly(run, f.copy.signal), pending = owner.finishOutput(completed, run, launch!);
  let closed = false; void pending.then(() => { closed = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  expect(closed).toBe(false); expect(eof.size).toBe(0);
  for (const memory of streamMemory) expect(f.s.allocations.get(memory)?.freed).toBe(false);
  f.s.state.holdEOF = false; const output = await pending;
  expect(eof.size).toBe(2); expect(f.s.pipes.every(pipe => !pipe.pending)).toBe(true); expect(f.s.output).toEqual([]);
  const snapshot = await command.captureStoppedSnapshot(run, completed, output); expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot).outputComplete).toBe(false);
  await owner.close(); await f.close();
});

it.each(["added", "removed", "replaced", "data", "security", "streams", "root-written", "root-changed"] as const)("a %s prepared-tree member refuses early cancellation before any ACL is revoked", async change => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal }), owner = await s.prepare(), command = await f.create(); let mutations: number | undefined;
  f.s.state.onNative = name => { if (name !== "CreateProcessW") return;
    mutations = f.s.source.sets(); const root = f.s.source.root(), file = f.s.source.objects.get(path.join(root.name, "app.ts"))!;
    if (change === "added") f.s.source.add(path.join(root.name, "surprise.txt"), "file", Buffer.from("new"), { ...file.security, inherited: true });
    if (change === "removed") { file.removed = true; file.links = 0; file.deletePending = true; }
    if (change === "replaced") f.s.source.add(file.name, "file", Buffer.from(file.bytes), file.security);
    if (change === "data") { file.bytes = Buffer.concat([file.bytes, Buffer.from("changed")]); file.written++; file.changed++; }
    if (change === "security") file.security.extra = true;
    if (change === "streams") file.streams = true;
    if (change === "root-written") root.written++;
    if (change === "root-changed") root.changed++;
    f.canonical.signal.abort();
  };
  await expect(command.launchRootOnlyWithOutput(context => owner.createSuspended(context, ["test.cjs"], f.s.options), () => undefined)).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  expect(mutations).toBeDefined(); expect(f.s.source.sets()).toBe(mutations); expect(f.s.events).not.toContain("resume"); expect(f.s.events).not.toContain("assign");
  expect(f.s.events).toContain("TerminateProcess"); expect(f.s.events).toContain("TerminateJobObject");
  const queries = f.nativeCalls.length; await expect(command.close()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" }); expect(f.nativeCalls).toHaveLength(queries);
});

it("an older completed generation stays stale after a later shared-signal returned cancellation", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal }), owner = await s.prepare(), command = await f.create(); let first: WindowsCommandOutputLaunchRef | undefined;
  const original = await command.launchRootOnlyWithOutput(context => first = owner.createSuspended(context, ["first.cjs"], f.s.options), () => undefined);
  f.s.state.ended = true; const originalDone = await command.completeRootOnly(original, f.copy.signal), originalClosed = await owner.finishOutput(originalDone, original, first!);
  f.s.state.ended = false; f.s.state.assigned = false;
  f.s.state.onNative = name => { if (name === "CreateProcessW") f.canonical.signal.abort(); };
  let second: WindowsCommandOutputLaunchRef | undefined;
  const run = await command.launchRootOnlyWithOutput(context => second = owner.createSuspended(context, ["second.cjs"], f.s.options), () => undefined);
  const queries = f.nativeCalls.length;
  await expect(command.captureStoppedSnapshot(original, originalDone, originalClosed)).rejects.toMatchObject({ code: "boundary" });
  expect(f.nativeCalls).toHaveLength(queries); expect(f.s.events.filter(event => event === "assign")).toHaveLength(1); expect(f.s.events.filter(event => event === "resume")).toHaveLength(1);
  const completed = await command.completeRootOnly(run, f.copy.signal), closed = await owner.finishOutput(completed, run, second!), snapshot = await command.captureStoppedSnapshot(run, completed, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toMatchObject({ outcome: "cancelled", exitCode: null, outputComplete: false }); await owner.close(); await f.close();
});

it("a genuine cleanup exception from shared asset admission cannot authorise early Stop/revoke recovery", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const { WindowsCodingCleanupError } = await import("../../app/main/agent/windows-coding-native"), failure = new WindowsCodingCleanupError(); let unsafe = false, mutations: number | undefined;
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal, current: () => { if (unsafe) throw failure; return true; } }), owner = await s.prepare(), command = await f.create();
  f.s.state.onNative = name => { if (name === "CreateProcessW") { mutations = f.s.source.sets(); unsafe = true; } };
  await expect(command.launchRootOnlyWithOutput(context => owner.createSuspended(context, ["test.cjs"], f.s.options), () => undefined)).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  expect(mutations).toBeDefined(); expect(f.s.source.sets()).toBe(mutations); expect(f.s.events).not.toContain("assign"); expect(f.s.events).not.toContain("resume"); expect(f.s.events).not.toContain("root-close");
  expect(f.s.events).toContain("TerminateProcess"); expect(f.s.events).toContain("TerminateJobObject"); expect(s.fence.failure).toBeDefined();
  const queries = f.nativeCalls.length; await expect(command.close()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" }); expect(f.nativeCalls).toHaveLength(queries);
});

it("a normally returned trusted attester's shared abort obtains genuine uncaptured cancelled cleanup", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal }), owner = await s.prepare(), command = await f.create(); let launch: WindowsCommandOutputLaunchRef | undefined, calls = 0;
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["test.cjs"], f.s.options), () => { calls++; f.canonical.signal.abort(); });
  expect(calls).toBe(1); expect(f.s.events).toContain("assign"); expect(f.s.events).not.toContain("resume"); expect(f.s.events.filter(event => event === "root-close")).toHaveLength(3);
  expect(f.s.source.calls.some(call => call.name === "OpenProcessToken" && call.args[0] === f.s.state.returnedProcess)).toBe(false); expect(s.fence.failure).toBeUndefined();
  const completed = await command.completeRootOnly(run, f.copy.signal), closed = await owner.finishOutput(completed, run, launch!), snapshot = await command.captureStoppedSnapshot(run, completed, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toMatchObject({ outcome: "cancelled", exitCode: null, outputComplete: false }); await owner.close(); await f.close();
});

it.each(["scoped", "cleanup"] as const)("an aborting trusted attester's %s exception stays terminal without ACL revocation", async kind => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform"), { WindowsCodingCleanupError } = await import("../../app/main/agent/windows-coding-native");
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal }), owner = await s.prepare(), command = await f.create(); let mutations: number | undefined;
  const failure = kind === "scoped" ? new ScopedCodingFileError("cancelled") : new WindowsCodingCleanupError();
  await expect(command.launchRootOnlyWithOutput(context => owner.createSuspended(context, ["test.cjs"], f.s.options), () => {
    mutations = f.s.source.sets(); f.canonical.signal.abort(); throw failure;
  })).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" });
  expect(mutations).toBeDefined(); expect(f.s.source.sets()).toBe(mutations); expect(f.s.events).toContain("assign"); expect(f.s.events).not.toContain("resume"); expect(f.s.events).not.toContain("root-close");
  expect(f.s.events).toContain("TerminateProcess"); expect(f.s.events).toContain("TerminateJobObject");
  expect(f.s.source.calls.some(call => call.name === "OpenProcessToken" && call.args[0] === f.s.state.returnedProcess)).toBe(false);
  const queries = f.nativeCalls.length; await expect(command.close()).rejects.toMatchObject({ name: "WindowsRootOnlyCommandCopyCleanupError" }); expect(f.nativeCalls).toHaveLength(queries);
});

it("shared loss at the first capture-entry current gate cleans up before consuming a creator witness", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake");
  const s = nodeAssetFake({ io: f.s, signal: f.copy.signal }), owner = await s.prepare(), command = await f.create();
  let armed = false, currentCalls = 0, attesterCalls = 0, launch: WindowsCommandOutputLaunchRef | undefined;
  f.canonical.onCurrent(() => {
    if (armed && ++currentCalls === 2) { f.canonical.signal.abort(); return false; }
    return true;
  });
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["test.cjs"], f.s.options), () => { attesterCalls++; armed = true; });
  // The first call admits verified's postcheck; the second is Copy's initial capture callback gate.
  expect(attesterCalls).toBe(1); expect(currentCalls).toBe(2); expect(f.copy.signal.aborted).toBe(true); expect(f.s.events).toContain("assign"); expect(f.s.events).not.toContain("resume");
  expect(f.s.source.calls.some(call => call.name === "OpenProcessToken" && call.args[0] === f.s.state.returnedProcess)).toBe(false);
  expect(f.s.events.filter(event => event === "root-close")).toHaveLength(3); expect(s.fence.failure).toBeUndefined();
  const completed = await command.completeRootOnly(run, f.copy.signal), closed = await owner.finishOutput(completed, run, launch!), snapshot = await command.captureStoppedSnapshot(run, completed, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toMatchObject({ outcome: "cancelled", exitCode: null, outputComplete: false }); await owner.close(); await f.close();
});
