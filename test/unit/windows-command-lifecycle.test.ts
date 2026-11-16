import { expect, it, vi } from "vitest";
import type { WindowsLpacApi, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import type { FreshWindowsCommandTree } from "../../app/main/agent/windows-command-copy-native";
import { WindowsRootOnlyCommandCopy, WindowsRootOnlyCommandCopyCleanupError, windowsCommandRootOnlyLaunchDirectory,
  requireWindowsCommandRootOnlyCompleted, type WindowsCommandRootOnlyLaunchContext, type WindowsCommandRootOnlyRunRef,
  type WindowsRootOnlyCommandCopyDependencies, type WindowsRootOnlyCommandCopyFence } from "../../app/main/agent/windows-command-copy";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyNaturalExit, WindowsCommandRootOnlyCleanupError,
  type WindowsCommandRootOnlyJobState, type WindowsCommandRootOnlyStopFence, type WindowsCommandRootOnlyStopOwner } from "../../app/main/agent/windows-command-stop";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const events: string[] = [], stopFence: WindowsCommandRootOnlyStopFence = { retained: [] }, fence: WindowsRootOnlyCommandCopyFence = { retained: [] };
  const state = { current: true, code: 0, fault: "", directory: "C:\\scratch\\fresh", onWait: undefined as (() => void) | undefined,
    onCode: undefined as (() => void) | undefined, revokeGate: undefined as ReturnType<typeof deferred> | undefined };
  let next = 10n, currentProcess: bigint | undefined, exitLoads = 0;
  const jobs = new Map<bigint, { total: number; process?: bigint }>(), roots = new Map<bigint, { pid: number; thread: bigint; exited: boolean }>();
  const api = {
    createJob() { const job = next++; jobs.set(job, { total: 0 }); events.push("job"); return job; },
    assign(job: bigint, process: bigint) { const value = jobs.get(job)!; value.total = 1; value.process = process; events.push("assign"); },
    resume() { events.push("resume"); },
    terminateProcess(process: bigint) { events.push("terminate-root"); roots.get(process)!.exited = true; },
    terminateJob(job: bigint) { events.push("terminate-job"); const process = jobs.get(job)!.process; if (process) roots.get(process)!.exited = true; },
  } as unknown as WindowsLpacApi;
  const native = {
    configure() { events.push("configure"); }, assertLimits() {},
    state(job: bigint): WindowsCommandRootOnlyJobState { const value = jobs.get(job)!, root = value.process ? roots.get(value.process) : undefined;
      return { total: value.total, active: root && !root.exited ? 1 : 0, pids: root && !root.exited ? [root.pid] : [] }; },
    processId(process: bigint) { return roots.get(process)!.pid; },
    threadProcessId(thread: bigint) { return [...roots.values()].find(root => root.thread === thread)!.pid; },
    member(process: bigint, job: bigint) { return jobs.get(job)!.process === process; },
    wait(handle: bigint): 0 | 258 { events.push(`wait:${handle}`); state.onWait?.(); if (state.fault === "wait") throw Error("private native text");
      const root = roots.get(handle) ?? [...roots.values()].find(root => root.thread === handle); return root?.exited ? 0 : 258; },
    close(handle: bigint) { events.push(`close:${handle}`); if (state.fault === "close") throw Error("private close text"); },
  };
  const exitNative = () => { exitLoads++; if (state.fault === "loader") throw Error("private loader text"); return {
    exitCode: vi.fn((process: bigint) => { events.push(`code:${process}`); state.onCode?.(); if (state.fault === "code") throw Error("private code text"); return state.code; }),
  }; };
  const tree: FreshWindowsCommandTree = {
    get directory() { return state.directory; }, async assertPrivate() { events.push("private"); },
    async grant() { events.push("grant"); }, async revoke() { events.push("revoke"); if (state.revokeGate) await state.revokeGate.promise;
      if (state.fault === "revoke") throw Error("private revoke text"); },
    async snapshot() { events.push("snapshot"); return []; }, async close() { events.push("tree-close"); },
  };
  let stopOwner: WindowsCommandRootOnlyStopOwner | undefined;
  const dependencies: WindowsRootOnlyCommandCopyDependencies = { api, fence, createTree: async () => tree,
    createStopOwner: binding => stopOwner = createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, stopFence, exitNative) };
  const input = { parent: "C:\\scratch", protectedPaths: ["C:\\protected"], entries: [], packageSid: "S-1-15-2-123-456",
    current: () => state.current, packageCurrent: () => true, reviewCurrent: () => true };
  const prepare = () => WindowsRootOnlyCommandCopy.create(input, dependencies);
  const create = (): WindowsSuspendedProcess => { const process = next++, thread = next++, pid = Number(next++);
    roots.set(process, { thread, pid, exited: false }); currentProcess = process; events.push("create"); return { process, thread, pid }; };
  const attest = () => { events.push("attest"); };
  return { events, state, fence, stopFence, native, api, prepare, create, attest, input, dependencies,
    end() { roots.get(currentProcess!)!.exited = true; }, root: () => currentProcess!, loads: () => exitLoads, stopOwner: () => stopOwner! };
}
type H = ReturnType<typeof setup>;
const launch = (s: H, owner: WindowsRootOnlyCommandCopy) => owner.launchRootOnlyWithContext(context => {
  expect(windowsCommandRootOnlyLaunchDirectory(context)).toBe(s.state.directory); return s.create();
}, s.attest);
async function failure(pending: Promise<unknown>) { const error = await pending.catch(error => error as unknown); expect(error).toBeInstanceOf(WindowsRootOnlyCommandCopyCleanupError); expect(String(error)).not.toContain("private "); return error; }

it("keeps the old launch/Stop path free of exit queries and launch context", async () => {
  const s = setup(), owner = await s.prepare(), creator = vi.fn(s.create); await owner.launchRootOnly(creator, s.attest);
  expect(creator.mock.calls).toEqual([[]]); await owner.stop(); expect(s.loads()).toBe(0);
  expect(s.events.some(event => event.startsWith("code:"))).toBe(false); await owner.close();
});
it("bounds launch-directory access to the synchronous trusted create callback", async () => {
  const s = setup(), owner = await s.prepare(); let held: WindowsCommandRootOnlyLaunchContext | undefined;
  const ref = await owner.launchRootOnlyWithContext(context => {
    held = context; expect(Object.keys(context)).toEqual(["scope"]); expect(Object.isFrozen(context)).toBe(true);
    expect(windowsCommandRootOnlyLaunchDirectory(context)).toBe("C:\\scratch\\fresh"); return s.create();
  }, () => { expect(() => windowsCommandRootOnlyLaunchDirectory(held)).toThrow(); });
  expect(Object.keys(ref)).toEqual(["scope"]); expect(() => windowsCommandRootOnlyLaunchDirectory(held)).toThrow();
  for (const foreign of [{ ...held }, new Proxy({}, { get() { throw Error("private getter"); } }), null]) expect(() => windowsCommandRootOnlyLaunchDirectory(foreign)).toThrow();
  await owner.stop(); await owner.close();
});
it("a caught live-context authority loss retires the launch even when the predicate later returns true", async () => {
  const s = setup(), owner = await s.prepare();
  await failure(owner.launchRootOnlyWithContext(context => {
    s.state.current = false; expect(() => windowsCommandRootOnlyLaunchDirectory(context)).toThrow();
    s.state.current = true; expect(() => windowsCommandRootOnlyLaunchDirectory(context)).toThrow(); return s.create();
  }, s.attest));
  expect(s.events).toContain("create"); expect(s.events).not.toContain("assign"); expect(s.events).not.toContain("resume");
  expect(s.events).toContain("terminate-root"); expect(s.events.some(event => event.startsWith("close:"))).toBe(false);
  expect(s.fence.retained.length).toBeGreaterThan(0); expect(s.stopFence.retained.length).toBeGreaterThan(0);
});
it("expired context access cannot retire a newer live generation", async () => {
  const s = setup(), owner = await s.prepare(); let context: WindowsCommandRootOnlyLaunchContext | undefined;
  await owner.launchRootOnlyWithContext(value => { context = value; return s.create(); }, s.attest); await owner.files(async () => undefined);
  const ref = await launch(s, owner), count = s.events.length;
  expect(() => windowsCommandRootOnlyLaunchDirectory(context)).toThrow(); expect(s.events).toHaveLength(count);
  s.end(); const completed = await owner.completeRootOnly(ref, new AbortController().signal);
  expect(requireWindowsCommandRootOnlyCompleted(completed, ref).outcome).toBe("natural-exit"); await owner.close();
});
it.each(["relative", "\\\\server\\share", "C:\\bad\nname", "C:\\" + "a".repeat(4097)])("refuses malformed launch directory %# before creating a process", async directory => {
  const s = setup(), owner = await s.prepare(); s.state.directory = directory;
  await failure(launch(s, owner)); expect(s.events).not.toContain("create"); expect(s.events).not.toContain("resume");
});
it.each([0, 1, 259, 0xffffffff])("records exact unsigned natural exit %i only after genuine Stop and revoke", async code => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner); s.state.code = code; s.end();
  const completed = await owner.completeRootOnly(ref, new AbortController().signal), facts = requireWindowsCommandRootOnlyCompleted(completed, ref);
  expect(facts).toEqual({ outcome: "natural-exit", exitCode: code }); expect(Object.isFrozen(facts)).toBe(true); expect(Object.isFrozen(completed)).toBe(true);
  expect(Object.keys(completed)).toEqual(["scope"]); expect(s.events).not.toContain("terminate-root");
  expect(s.events.indexOf(`code:${s.root()}`)).toBeLessThan(s.events.findIndex(event => event.startsWith("close:")));
  expect(s.events.findLastIndex(event => event.startsWith("close:"))).toBeLessThan(s.events.indexOf("revoke"));
  expect(() => requireWindowsCommandRootOnlyCompleted({ ...completed }, ref)).toThrow(); expect(() => requireWindowsCommandRootOnlyCompleted(completed, {} as WindowsCommandRootOnlyRunRef)).toThrow();
  await owner.close();
});
it("does not publish completion while revocation is pending", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner); s.end(); s.state.revokeGate = deferred();
  let settled = false; const pending = owner.completeRootOnly(ref, new AbortController().signal).then(value => { settled = true; return value; });
  await tick(); expect(s.events).toContain("revoke"); expect(settled).toBe(false); s.state.revokeGate.resolve(); await pending; await owner.close();
});
it("Stop completes promptly while a natural observation is pending and never invents exit zero", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner);
  const pending = owner.completeRootOnly(ref, new AbortController().signal); await tick(); expect(s.loads()).toBe(0);
  await owner.stop(); const completed = await pending;
  expect(requireWindowsCommandRootOnlyCompleted(completed, ref)).toEqual({ outcome: "cancelled", exitCode: null });
  expect(s.events).toContain("terminate-root"); expect(s.loads()).toBe(0); await owner.close();
});
it("uses a bounded poll delay and wakes Stop without advancing that delay", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const s = setup(), owner = await s.prepare(), ref = await launch(s, owner);
    const pending = owner.completeRootOnly(ref, new AbortController().signal); await tick();
    const waits = s.events.filter(event => event.startsWith("wait:")).length;
    expect(vi.getTimerCount()).toBe(1); await tick(); expect(s.events.filter(event => event.startsWith("wait:"))).toHaveLength(waits);
    await owner.stop(); const completed = await pending;
    expect(requireWindowsCommandRootOnlyCompleted(completed, ref).outcome).toBe("cancelled"); expect(vi.getTimerCount()).toBe(0); await owner.close();
  } finally { vi.useRealTimers(); }
});
it("close does not wait behind an observer and preserves only cancelled stopped facts", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner);
  const pending = owner.completeRootOnly(ref, new AbortController().signal); await tick(); await owner.close();
  const completed = await pending; expect(requireWindowsCommandRootOnlyCompleted(completed, ref)).toEqual({ outcome: "cancelled", exitCode: null });
  expect(s.events).toContain("tree-close"); expect(s.loads()).toBe(0);
});
it("abort during revocation cannot turn an earlier natural exit into accepted success", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner), controller = new AbortController(); s.end(); s.state.revokeGate = deferred();
  const pending = owner.completeRootOnly(ref, controller.signal); await tick(); expect(s.events).toContain("revoke"); controller.abort(); s.state.revokeGate.resolve();
  const completed = await pending; expect(requireWindowsCommandRootOnlyCompleted(completed, ref)).toEqual({ outcome: "cancelled", exitCode: null }); await owner.close();
});
it("an already aborted completion starts no exit observation and still proves Stop and revoke", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner), controller = new AbortController(); controller.abort();
  const completed = await owner.completeRootOnly(ref, controller.signal);
  expect(requireWindowsCommandRootOnlyCompleted(completed, ref)).toEqual({ outcome: "cancelled", exitCode: null });
  expect(s.loads()).toBe(0); expect(s.events).toContain("revoke"); await owner.close();
});
it("abort during the exact exit-code query suppresses the natural receipt", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner), controller = new AbortController(); s.end();
  s.state.onCode = () => controller.abort(); const completed = await owner.completeRootOnly(ref, controller.signal);
  expect(requireWindowsCommandRootOnlyCompleted(completed, ref)).toEqual({ outcome: "cancelled", exitCode: null }); await owner.close();
});
it("Stop during Wait prevents the subsequent lazy loader and exit query", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner); s.end(); let once = false;
  s.state.onWait = () => { if (!once) { once = true; void owner.stop(); } };
  const completed = await owner.completeRootOnly(ref, new AbortController().signal);
  expect(requireWindowsCommandRootOnlyCompleted(completed, ref).outcome).toBe("cancelled"); expect(s.loads()).toBe(0); await owner.close();
});
it("ordinary file quiescence reports termination, never a natural exit inferred from Stop", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner); await owner.files(async () => undefined);
  const completed = await owner.completeRootOnly(ref, new AbortController().signal);
  expect(requireWindowsCommandRootOnlyCompleted(completed, ref)).toEqual({ outcome: "terminated", exitCode: null }); expect(s.loads()).toBe(0); await owner.close();
});
it("an old generation's aborted completion cannot stop its newer live generation", async () => {
  const s = setup(), owner = await s.prepare(), older = await launch(s, owner); await owner.files(async () => undefined);
  const newer = await launch(s, owner), stops = s.events.filter(event => event === "terminate-root").length, controller = new AbortController(); controller.abort();
  const completed = await owner.completeRootOnly(older, controller.signal);
  expect(requireWindowsCommandRootOnlyCompleted(completed, older).outcome).toBe("cancelled");
  expect(s.events.filter(event => event === "terminate-root")).toHaveLength(stops);
  expect(() => requireWindowsCommandRootOnlyCompleted(completed, newer)).toThrow(); await owner.stop(); await owner.close();
});
it("completion cannot reenter the exclusive file callback and deadlock its queue", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner);
  await owner.files(async () => { await expect(owner.completeRootOnly(ref, new AbortController().signal)).rejects.toThrow("boundary"); });
  expect(s.fence.retained).toHaveLength(0); await owner.close();
});
it("foreign and other-copy run references cause no native calls or boundary poisoning", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner), other = await s.prepare(), count = s.events.length;
  for (const foreign of [{ ...ref }, new Proxy({}, { get() { throw Error("private getter"); } }), null]) await expect(owner.completeRootOnly(foreign as WindowsCommandRootOnlyRunRef, new AbortController().signal)).rejects.toThrow("boundary");
  await expect(other.completeRootOnly(ref, new AbortController().signal)).rejects.toThrow("boundary"); expect(s.events).toHaveLength(count); expect(s.fence.retained).toHaveLength(0);
  await owner.stop(); await owner.close(); await other.close();
});
it.each(["wait", "loader", "code", "close", "revoke"])("retains first %s failure and suppresses later queries, closes and receipts", async fault => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner); s.end(); s.state.fault = fault;
  const pending = owner.completeRootOnly(ref, new AbortController().signal), error = await failure(pending);
  const count = s.events.length; s.state.fault = ""; delete s.fence.failure;
  expect(await failure(owner.stop())).toBe(error); expect(await failure(owner.close())).toBe(error); expect(s.events).toHaveLength(count);
  await expect(owner.completeRootOnly(ref, new AbortController().signal)).rejects.toBe(error); expect(s.fence.retained.length).toBeGreaterThan(0);
  expect(() => requireWindowsCommandRootOnlyCompleted(error, ref)).toThrow(); await expect(s.prepare()).rejects.toBe(error);
});
it("a completed generation cannot conceal a later shared boundary failure", async () => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner); s.end();
  await owner.completeRootOnly(ref, new AbortController().signal); const next = await launch(s, owner); s.end(); s.state.fault = "code";
  const error = await failure(owner.completeRootOnly(next, new AbortController().signal)), count = s.events.length;
  await expect(owner.completeRootOnly(ref, new AbortController().signal)).rejects.toBe(error); expect(s.events).toHaveLength(count);
});
it.each([NaN, -1, 0x100000000, "0", null])("an invalid held-root exit value %# cannot issue a completion", async code => {
  const s = setup(), owner = await s.prepare(), ref = await launch(s, owner); s.end(); s.state.code = code as number;
  await failure(owner.completeRootOnly(ref, new AbortController().signal)); expect(s.events).not.toContain("revoke");
});
it("the standalone observer preserves the exact held handle and rejects forged natural refs", async () => {
  const s = setup(), owner = await s.prepare(); await launch(s, owner); s.end();
  const ref = await s.stopOwner().observeNaturalExit!(new AbortController().signal);
  expect(ref).toMatchObject({ scope: "root-only-natural-exit" }); expect(s.events.filter(event => event.startsWith("code:"))).toEqual([`code:${s.root()}`]);
  for (const foreign of [{ ...ref }, new Proxy({}, { get() { throw Error("private getter"); } }), null]) expect(() => requireWindowsCommandRootOnlyNaturalExit(foreign, {})).toThrow();
  expect(s.loads()).toBe(1); await owner.stop(); await owner.close();
});
it("a direct observer failure remains terminal after clearing the public Stop fence field", async () => {
  const s = setup(), owner = await s.prepare(); await launch(s, owner); s.end(); s.state.fault = "code";
  const observed = s.stopOwner().observeNaturalExit!(new AbortController().signal), error = await observed.catch(error => error as unknown);
  expect(error).toBeInstanceOf(WindowsCommandRootOnlyCleanupError); const count = s.events.length; delete s.stopFence.failure;
  await expect(s.stopOwner().observeNaturalExit!(new AbortController().signal)).rejects.toBe(error); expect(s.events).toHaveLength(count);
  await failure(owner.stop());
});
