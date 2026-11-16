import { expect, it } from "vitest";
import { outputFake } from "../fixtures/windows-command-output-fake";
import { requireWindowsCommandOutputClosed, requireWindowsCommandOutputLaunch, WindowsCommandOutputCleanupError,
  type WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";
import { requireWindowsCommandRootOnlyCompleted, type WindowsCommandRootOnlyCompletedRef, type WindowsCommandRootOnlyRunRef } from "../../app/main/agent/windows-command-copy";
import { closeWindowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { const deadline = performance.now() + 4000; while (!check()) { if (performance.now() > deadline) throw Error("The bounded output condition was not observed."); await new Promise<void>(resolve => setTimeout(resolve, 5)); } }
async function rejected(work: () => unknown) { try { await work(); } catch (error) { expect(String(error)).not.toContain("PRIVATE"); return error; } throw Error("The fixed fault must refuse."); }
async function complete(s: ReturnType<typeof outputFake>, v: Awaited<ReturnType<ReturnType<typeof outputFake>["launch"]>>) {
  s.state.ended = true;
  const done = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(done, v.run);
  const facts = requireWindowsCommandOutputClosed(closed, v.ref, v.run);
  await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile); return { done, closed, facts };
}

it("uses only fresh owned standard handles and a fixed credential-free environment, then authenticates natural output closure", async () => {
  const s = outputFake(), original = Buffer.from(s.command), v = await s.launch();
  expect(s.state.flags).toBe(0x8040c); expect(s.state.inherited).toHaveLength(3); expect(new Set(s.state.inherited).size).toBe(3);
  expect(s.state.inherited.every(value => s.handles.get(value)!.closed && s.handles.get(value)!.flags === 0)).toBe(true);
  const directory = s.source.root().name;
  expect(s.state.environment).toBe(`PATH=\0SystemRoot=C:\\Windows\0TEMP=${directory}\0TMP=${directory}\0\0`);
  expect(s.command.equals(original)).toBe(true); expect(Object.keys(v.ref)).toEqual(["scope"]);
  expect(s.calls.filter(call => call.name === "ReadFile" && s.handles.get(call.args[0] as bigint)?.kind === "pipe").every(call => call.args[3] === null)).toBe(true);
  expect(s.events.indexOf("attest")).toBeLessThan(s.events.indexOf("resume"));
  s.enqueue(0, Buffer.from("out")); s.enqueue(1, Buffer.from("err"));
  const finished = await complete(s, v);
  expect(finished.facts).toEqual({ stdoutBytes: 3, stderrBytes: 3, reason: "none", complete: true });
  expect(s.output.map(value => [value.stream, value.bytes.toString()])).toEqual([["stdout", "out"], ["stderr", "err"]]);
  expect(Object.isFrozen(finished.closed)).toBe(true); expect(Object.isFrozen(finished.facts)).toBe(true);
  expect([...s.handles.values()].every(value => value.closed)).toBe(true); expect(s.source.handles.size).toBe(0);
  expect([...s.allocations.values()].every(value => value.freed && value.bytes.every(byte => byte === 0))).toBe(true);
});
it("CRT-style synchronous writes use synchronous child clients while host readers remain overlapped", async () => {
  const s = outputFake(); s.state.synchronousWrite = true; const v = await s.launch();
  expect(s.pipes.every(pipe => s.handles.get(pipe.writer!)!.creationFlags === 0)).toBe(true);
  expect(s.pipes.every(pipe => (s.handles.get(pipe.server)!.creationFlags & 0x40000000) !== 0)).toBe(true);
  const result = await complete(s, v); expect(result.facts.complete).toBe(true);
  expect(s.output.map(value => value.bytes.toString())).toEqual(["CRT synchronous write", "CRT synchronous write"]);
});
it("pending read/OVERLAPPED storage uses private stable allocations and is freed only after EOF/handle close", async () => {
  const s = outputFake(), v = await s.launch();
  const reads = s.calls.filter(call => call.name === "ReadFile" && s.handles.get(call.args[0] as bigint)?.kind === "pipe");
  expect(reads).toHaveLength(2);
  for (const call of reads) { expect(Buffer.isBuffer(call.args[1])).toBe(false); expect(s.allocations.has(call.args[1])).toBe(true);
    expect(Buffer.isBuffer(call.args[4])).toBe(false); expect(s.allocations.has(call.args[4])).toBe(true); expect(call.args[3]).toBeNull(); }
  expect([...s.allocations.values()].filter(value => !value.freed)).toHaveLength(4);
  s.state.holdEOF = true; s.state.ended = true; const done = await v.copy.completeRootOnly(v.run, v.io.signal), pending = v.io.closeOutputAfterStopped(done, v.run);
  await tick(); expect([...s.allocations.values()].filter(value => !value.freed)).toHaveLength(4);
  s.state.holdEOF = false; await pending; expect([...s.allocations.values()].every(value => value.freed)).toBe(true);
  expect(s.events.lastIndexOf("io-close")).toBeLessThan(s.events.lastIndexOf("free")); await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
});
it("synchronous cancellation during activation prevents Resume without waiting for a completion request", async () => {
  const s = outputFake(); let cancelled = false;
  s.state.onNative = (name, args) => { if (!cancelled && name === "ReadFile" && args[4] !== null) { cancelled = true; s.abort.abort(); } };
  await rejected(() => s.launch()); expect(cancelled).toBe(true); expect(s.events).not.toContain("resume");
  expect(s.events).toContain("stop-root"); expect(s.copyFence.retained.length).toBeGreaterThan(0); expect(s.fence.retained.length).toBeGreaterThan(0);
});
it("relevant FALSE statuses sample LastError before another native operation", async () => {
  const s = outputFake(), v = await s.launch();
  const failed = s.calls.filter(call => ["ConnectNamedPipe", "ReadFile", "GetOverlappedResult", "CancelIoEx", "InitializeProcThreadAttributeList"].includes(call.name) && call.result === 0);
  expect(failed.length).toBeGreaterThan(2);
  for (const call of failed) expect(s.trace[call.traceIndex + 1]).toBe("GetLastError");
  await complete(s, v);
});
it("distinguishes stderr/stdout and preserves nonzero natural exit without turning it into failure of cleanup", async () => {
  const s = outputFake(), v = await s.launch(); s.state.code = 17; s.enqueue(1, Buffer.from("known failing test"));
  const { done, facts } = await complete(s, v); expect(requireWindowsCommandRootOnlyCompleted(done, v.run)).toEqual({ outcome: "natural-exit", exitCode: 17 });
  expect(facts.complete).toBe(true); expect(facts.stderrBytes).toBe(18);
});
it("publishes no completed output reference before native EOF and every positive close", async () => {
  const s = outputFake(), v = await s.launch(); s.state.ended = true; s.state.holdEOF = true; const done = await v.copy.completeRootOnly(v.run, v.io.signal);
  let settled = false;
  const pending = v.io.closeOutputAfterStopped(done, v.run).then(value => { settled = true; return value; });
  await tick(); expect(settled).toBe(false); s.state.holdEOF = false;
  await pending; expect([...s.handles.values()].every(value => value.closed)).toBe(true); await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
});
it("does not infer EOF from a successful zero-byte overlapped operation", async () => {
  const s = outputFake(), v = await s.launch(); s.enqueue(0, Buffer.alloc(0));
  await until(() => s.calls.some(call => call.name === "GetOverlappedResult"));
  expect(s.state.ended).toBe(false); expect([...s.handles.values()].filter(value => !value.closed).length).toBeGreaterThan(0);
  await complete(s, v);
});
it("shared overflow aborts the exact run, never publishes excess bytes and still proves EOF/close", async () => {
  const s = outputFake(), v = await s.launch();
  for (let index = 0; index < 9; index++) { s.enqueue(0, Buffer.alloc(16 * 1024, 65)); s.enqueue(1, Buffer.alloc(16 * 1024, 66)); }
  await until(() => v.io.signal.aborted); expect(s.output.reduce((total, value) => total + value.bytes.length, 0)).toBeLessThanOrEqual(256 * 1024);
  await until(() => s.events.includes("stop-root") && s.events.includes("stop-job"));
  const done = await v.copy.completeRootOnly(v.run, v.io.signal), closed = await v.io.closeOutputAfterStopped(done, v.run);
  expect(requireWindowsCommandOutputClosed(closed, v.ref, v.run)).toMatchObject({ reason: "overflow", complete: false });
  expect(s.events).toContain("stop-root"); await v.copy.close(); closeWindowsCommandCreatorProfile(s.profile);
});
it("a live per-stream bound cannot exceed the same shared 256 KiB budget", async () => {
  const s = outputFake(), v = await s.launch(); for (let index = 0; index < 17; index++) s.enqueue(0, Buffer.alloc(16 * 1024));
  await until(() => v.io.signal.aborted); const result = await complete(s, v);
  expect(result.facts.stdoutBytes).toBe(256 * 1024); expect(result.facts.stderrBytes).toBe(0); expect(result.facts.reason).toBe("overflow");
});
it.each(["cancelled", "timeout", "delivery"] as const)("%s aborts the actual bound run before any complete receipt", async reason => {
  const s = outputFake(); if (reason === "timeout") s.state.timeout = 20;
  const v = await s.launch();
  if (reason === "cancelled") s.abort.abort(); if (reason === "delivery") { s.state.onOutput = () => { throw Error("PRIVATE delivery"); }; s.enqueue(0, Buffer.from("fixed")); }
  await until(() => v.io.signal.aborted); await until(() => s.events.includes("stop-root") && s.events.includes("stop-job"));
  const result = await complete(s, v);
  expect(result.facts).toMatchObject({ reason, complete: false }); expect(requireWindowsCommandRootOnlyCompleted(result.done, v.run).exitCode).toBeNull();
});
it("rejects callback-shaped Stop claims and foreign run/completion references without native access", async () => {
  const s = outputFake(), v = await s.launch(), before = s.calls.length;
  for (const fake of [() => undefined, { scope: "root-only-completed" }, new Proxy({}, { get() { throw Error("PRIVATE getter"); } })]) {
    await rejected(() => v.io.closeOutputAfterStopped(fake as WindowsCommandRootOnlyCompletedRef, v.run));
  }
  expect(s.calls).toHaveLength(before); const result = await complete(s, v);
  for (const fake of [{ ...result.closed }, { scope: "native-output-closed" }]) expect(() => requireWindowsCommandOutputClosed(fake, v.ref, v.run)).toThrow();
  expect(() => requireWindowsCommandOutputClosed(result.closed, {} as WindowsCommandOutputLaunchRef, v.run)).toThrow();
  expect(() => requireWindowsCommandOutputClosed(result.closed, v.ref, {} as WindowsCommandRootOnlyRunRef)).toThrow();
});
it("native returned-PI claims are opaque and cannot be structurally reconstructed", async () => {
  const s = outputFake(), v = await s.launch();
  expect(Object.keys(v.ref)).toEqual(["scope"]); expect(Object.isFrozen(v.ref)).toBe(true);
  for (const foreign of [{ ...v.ref }, { scope: "native-output-launch", root: { process: 50001n, thread: 50002n, pid: 50003 } },
    new Proxy({}, { get() { throw Error("PRIVATE getter"); } })]) expect(() => requireWindowsCommandOutputLaunch(foreign as WindowsCommandOutputLaunchRef)).toThrow();
  await complete(s, v);
});
it("a genuine output launch from another profile cannot be attached to this Copy", async () => {
  const a = outputFake(), b = outputFake(), copy = await b.prepare(), io = a.owner();
  await rejected(() => copy.launchRootOnlyWithOutput(context => io.createSuspended(context, "C:\\trusted\\node.exe", a.command), () => undefined));
  expect(b.events).not.toContain("resume"); expect(a.events).toContain("producer-terminate"); expect(a.fence.retained.length).toBeGreaterThan(0);
});
it.each(["returnedProcess", "returnedThread", "returnedPid"] as const)("a malformed actual %s cannot be resumed or issue output authority", async field => {
  const s = outputFake(); if (field === "returnedPid") s.state.returnedPid = 0; else s.state[field] = 0n;
  await rejected(() => s.launch()); expect(s.events).not.toContain("resume"); expect(s.fence.retained.length).toBeGreaterThan(0);
});
it("an unexpected actual native read count retains the full operation and blocks publication", async () => {
  const s = outputFake(), v = await s.launch(); s.enqueue(0, Buffer.alloc(16 * 1024 + 1, 65));
  await until(() => v.io.signal.aborted); const done = await v.copy.completeRootOnly(v.run, v.io.signal);
  await rejected(() => v.io.closeOutputAfterStopped(done, v.run)); expect(s.output).toHaveLength(0); expect(s.fence.retained.length).toBeGreaterThan(0);
});
it("an unused owner can retire without a process, a pipe or a false output receipt", () => {
  const s = outputFake(), io = s.owner(); io.closeUnused(); io.closeUnused(); expect(s.calls).toHaveLength(0);
  expect(() => requireWindowsCommandOutputClosed({}, {} as WindowsCommandOutputLaunchRef, {} as WindowsCommandRootOnlyRunRef)).toThrow();
});
it("a swallowed native reentry keeps the first failure and can never reach CreateProcess", async () => {
  const s = outputFake(), io = s.owner(), copy = await s.prepare(); let first: unknown;
  s.state.onNative = name => { if (name === "GetFileType" && first === undefined) { try { io.closeUnused(); } catch (error) { first = error; } } };
  const error = await rejected(() => copy.launchRootOnlyWithOutput(context => io.createSuspended(context, "C:\\trusted\\node.exe", s.command), () => undefined));
  expect(error).toBeDefined(); expect(first).toBeInstanceOf(WindowsCommandOutputCleanupError); expect(s.state.creates).toBe(0);
  const before = s.calls.length; expect(() => s.owner()).toThrow(); expect(s.calls).toHaveLength(before);
});
it("a swallowed reentry inside CreateProcess restores only known inheritance flags and never publishes its PI", async () => {
  const s = outputFake(), io = s.owner(), copy = await s.prepare(); let first: unknown;
  s.state.onNative = name => { if (name === "CreateProcessW") { try { io.closeUnused(); } catch (error) { first = error; } } };
  await rejected(() => copy.launchRootOnlyWithOutput(context => io.createSuspended(context, "C:\\trusted\\node.exe", s.command), () => undefined));
  expect(first).toBeInstanceOf(WindowsCommandOutputCleanupError); expect(s.state.inherited.every(value => s.handles.get(value)!.flags === 0)).toBe(true);
  expect(s.events).not.toContain("resume"); expect(s.fence.retained.length).toBeGreaterThan(0);
});
it("an inheritance enable failure restores earlier known flags before permanently retaining ownership", async () => {
  const s = outputFake(); let enables = 0;
  s.state.onNative = (name, args) => { if (name === "SetHandleInformation" && args[2] === 1 && ++enables === 2) throw Error("PRIVATE enable failure"); };
  await rejected(() => s.launch()); expect(s.state.creates).toBe(0); expect([...s.handles.values()].every(value => value.flags === 0)).toBe(true);
  expect(s.fence.retained.length).toBeGreaterThan(0);
});
it.each(["name", "pointer", "odd", "returned", "maximum"])("refuses malformed null-device %s before reading real input", async fault => {
  const s = outputFake(); s.state.afterNative = (name, args, result) => {
    if (name === "NtQueryObject") {
      const buffer = args[2] as Buffer;
      if (fault === "name") Buffer.from("\\Device\\Other", "utf16le").copy(buffer, 16);
      if (fault === "pointer") buffer.writeBigUInt64LE(1n, 8);
      if (fault === "odd") buffer.writeUInt16LE(1, 0);
      if (fault === "returned") (args[4] as Buffer).writeUInt32LE(4097);
      if (fault === "maximum") buffer.writeUInt16LE(4096, 2);
    } return result;
  };
  await rejected(() => s.launch()); expect(s.calls.some(call => call.name === "ReadFile")).toBe(false); expect(s.state.creates).toBe(0);
});
it("requires a proven zero-byte null-device read before the Root can inherit stdin", async () => {
  const s = outputFake(); s.state.afterNative = (name, args, result) => {
    if (name === "ReadFile" && args[4] === null) (args[3] as Buffer).writeUInt32LE(1); return result;
  };
  await rejected(() => s.launch()); expect(s.state.creates).toBe(0);
});
it.each([99, 15101, NaN])("an absent EOF cannot be certified by invalid drain clock %s", async now => {
  const s = outputFake(), v = await s.launch(); s.state.holdEOF = true; s.state.ended = true;
  const done = await v.copy.completeRootOnly(v.run, v.io.signal), pending = v.io.closeOutputAfterStopped(done, v.run);
  s.state.now = now; await rejected(() => pending); expect(s.fence.retained.length).toBeGreaterThan(0);
  expect([...s.handles.values()].some(value => !value.closed)).toBe(true);
});
it.each([false, 0, {}, Promise.resolve()])("a non-void delivery callback cannot certify complete output %#", async result => {
  const s = outputFake(), v = await s.launch(); s.state.deliveryReturn = result; s.enqueue(0, Buffer.from("fixed"));
  await until(() => v.io.signal.aborted); const finished = await complete(s, v); expect(finished.facts).toMatchObject({ reason: "delivery", complete: false });
});
it("a rejected asynchronous delivery is contained and cannot become complete output", async () => {
  const s = outputFake(), v = await s.launch(); s.state.deliveryFactory = () => Promise.reject(Error("PRIVATE asynchronous delivery"));
  s.enqueue(0, Buffer.from("fixed")); await until(() => v.io.signal.aborted);
  const finished = await complete(s, v); expect(finished.facts).toMatchObject({ reason: "delivery", complete: false });
});
it("a malformed transient completion count poisons output immediately rather than silently stopping its pump", async () => {
  const s = outputFake(), v = await s.launch();
  s.state.afterNative = (name, args, result) => { if (name === "GetOverlappedResult") structuredClone((args[2] as Buffer).buffer, { transfer: [(args[2] as Buffer).buffer] }); return result; };
  await until(() => v.io.signal.aborted); const done = await v.copy.completeRootOnly(v.run, v.io.signal);
  await rejected(() => v.io.closeOutputAfterStopped(done, v.run)); expect(s.fence.retained.length).toBeGreaterThan(0);
});
it.each(["alloc", "encode", "decode", "free"])("unknown stable-memory %s retains allocations and never retries disposal", async fault => {
  const s = outputFake();
  if (fault === "alloc" || fault === "encode") { s.state.memoryFault = fault; await rejected(() => s.launch()); }
  else {
    const v = await s.launch(); s.state.memoryFault = fault;
    if (fault === "decode") { s.enqueue(0, Buffer.from("fixed")); await until(() => v.io.signal.aborted); }
    else s.state.ended = true;
    const done = await v.copy.completeRootOnly(v.run, v.io.signal); await rejected(() => v.io.closeOutputAfterStopped(done, v.run));
  }
  const events = [...s.events]; s.state.memoryFault = ""; s.fence.failure = undefined;
  expect(() => s.owner()).toThrow(WindowsCommandOutputCleanupError); expect(s.events).toEqual(events); expect(s.fence.retained.length).toBeGreaterThan(0);
});
it.each(["void *", "uint32_t", "int", "size_t"])("refuses mismatched %s ABI before a DLL load", bad => {
  const s = outputFake(); s.state.abi = bad; expect(() => s.owner()).toThrow(WindowsCommandOutputCleanupError); expect(s.loader).not.toHaveBeenCalled();
});
it.each(["CreateNamedPipeW", "CreateEventW", "CreateFileW", "ConnectNamedPipe", "GetFileType", "GetHandleInformation", "InitializeProcThreadAttributeList",
  "UpdateProcThreadAttribute", "GetWindowsDirectoryW", "CreateProcessW", "DeleteProcThreadAttributeList", "LocalFree", "NtQueryObject"])("first %s creation uncertainty retains all owners and blocks retry", async name => {
  const s = outputFake(); s.state.fault = name; await rejected(() => s.launch());
  expect(s.fence.retained.length).toBeGreaterThan(0); const before = s.calls.length; s.state.fault = ""; s.fence.failure = undefined;
  expect(() => s.owner()).toThrow(WindowsCommandOutputCleanupError); expect(s.calls).toHaveLength(before);
});
it.each(["ReadFile", "GetOverlappedResult", "CloseHandle", "CancelIoEx"])("unknown %s completion cannot issue an output receipt or release buffers", async name => {
  const s = outputFake(), v = await s.launch();
  if (name === "ReadFile" || name === "GetOverlappedResult") {
    s.state.fault = name; if (name === "ReadFile") s.enqueue(0, Buffer.from("next operation"));
    await until(() => v.io.signal.aborted); const done = await v.copy.completeRootOnly(v.run, v.io.signal);
    await rejected(() => v.io.closeOutputAfterStopped(done, v.run));
  } else {
    if (name === "CancelIoEx") s.state.holdEOF = true;
    s.abort.abort(); const done = await v.copy.completeRootOnly(v.run, v.io.signal); s.state.fault = name;
    await rejected(() => v.io.closeOutputAfterStopped(done, v.run));
  }
  expect(s.fence.retained.length).toBeGreaterThan(0); const before = s.calls.length; s.state.fault = ""; s.fence.failure = undefined;
  expect(() => s.owner()).toThrow(WindowsCommandOutputCleanupError); expect(s.calls).toHaveLength(before);
});
