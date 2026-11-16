import { describe, expect, it, vi } from "vitest";
import {
  bindWindowsCommandRootOnlyStopNative, createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped,
  WindowsCommandRootOnlyCleanupError, WINDOWS_COMMAND_ROOT_ONLY_STOP_FUNCTIONS,
  type WindowsCommandRootOnlyJobState, type WindowsCommandRootOnlyStopFence,
} from "../../app/main/agent/windows-command-stop";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";
import type { WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";

const PRIVATE = "PRIVATE path SID identity token secret";
const root = { process: 20n, thread: 21n, pid: 200 };
function harness(issuedRoot: WindowsSuspendedProcess = root, job = 10n) {
  const binding = {}, fence: WindowsCommandRootOnlyStopFence = { retained: [] }, events: string[] = [];
  let assigned = false, ended = false, now = 0;
  const api = {
    createJob: vi.fn(() => { events.push("createJob"); return job; }),
    assign: vi.fn(() => { events.push("assign"); assigned = true; }),
    resume: vi.fn(() => { events.push("resume"); }),
    terminateProcess: vi.fn(() => { events.push("terminateProcess"); ended = true; }),
    terminateJob: vi.fn(() => { events.push("terminateJob"); ended = true; }),
    close: vi.fn((value: bigint) => { events.push(`close:${value}`); }),
  };
  const native = {
    configure: vi.fn(() => { events.push("configure"); }),
    assertLimits: vi.fn(() => { events.push("limits"); }),
    state: vi.fn((): WindowsCommandRootOnlyJobState => ({ total: assigned ? 1 : 0, active: assigned && !ended ? 1 : 0, pids: assigned && !ended ? [issuedRoot.pid] : [] })),
    processId: vi.fn(() => issuedRoot.pid), threadProcessId: vi.fn(() => issuedRoot.pid), member: vi.fn(() => assigned),
    wait: vi.fn((_handle: bigint): 0 | 258 => ended ? 0 : 258),
    close: vi.fn((owner: bigint) => api.close(owner)),
  };
  const clock = vi.fn(() => now), create = vi.fn(() => { events.push("create"); return issuedRoot; });
  const attest = vi.fn((_root: Readonly<WindowsSuspendedProcess>) => { events.push("attest"); }), current = vi.fn(() => true);
  const owner = () => createWindowsCommandRootOnlyStopOwner(binding, api, native, clock, fence);
  return { binding, fence, events, api, native, clock, create, attest, current, owner, time(value: number) { now = value; }, end() { ended = true; } };
}
type H = ReturnType<typeof harness>;
const launch = (h: H, owner: ReturnType<H["owner"]>) => owner.launch(h.create, h.attest, h.current);
const cleanup = async (promise: Promise<unknown>) => { const error = await promise.catch(error => error as unknown); expect(error).toBeInstanceOf(WindowsCommandRootOnlyCleanupError); expect(error).toBeInstanceOf(WindowsCodingCleanupError); expect(String(error)).not.toContain(PRIVATE); return error; };

describe("root-only stopped-writer authority", () => {
  it("closes a never-launched empty job and issues only an exact-bound immutable root-only receipt", async () => {
    const h = harness(), owner = h.owner(), ref = await owner.stop();
    expect(ref).toEqual({ scope: "root-only" }); expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.keys(ref)).toEqual(["scope"]); expect(owner.scope).toBe("root-only");
    expect(() => requireWindowsCommandRootOnlyStopped(ref, h.binding)).not.toThrow();
    for (const forged of [{ ...ref }, Object.freeze({ scope: "root-only" }), null, true, 1]) expect(() => requireWindowsCommandRootOnlyStopped(forged, h.binding)).toThrow();
    expect(() => requireWindowsCommandRootOnlyStopped(ref, {})).toThrow();
    expect(() => requireWindowsCommandRootOnlyStopped({}, undefined as unknown as object)).toThrow();
    expect(() => requireWindowsCommandRootOnlyStopped(ref, null as unknown as object)).toThrow();
    expect(h.api.close.mock.calls).toEqual([[10n]]); expect(h.api.resume).not.toHaveBeenCalled();
  });
  it("configures limits before create, privately assigns/attests the exact root then resumes", async () => {
    const h = harness(), owner = h.owner(); await expect(launch(h, owner)).resolves.toBe(root.pid);
    expect(h.create.mock.calls).toEqual([[]]); expect(h.events.indexOf("configure")).toBeLessThan(h.events.indexOf("create"));
    expect(h.events.indexOf("assign")).toBeLessThan(h.events.indexOf("attest")); expect(h.events.indexOf("attest")).toBeLessThan(h.events.indexOf("resume"));
    expect(h.attest.mock.calls[0][0]).toEqual(root); expect(Object.isFrozen(h.attest.mock.calls[0][0])).toBe(true);
    const ref = await owner.stop(); requireWindowsCommandRootOnlyStopped(ref, h.binding);
    expect(h.api.close.mock.calls).toEqual([[root.thread], [root.process], [10n]]);
    expect(h.native.threadProcessId).toHaveBeenCalledWith(root.thread);
  });
  it("retires launch synchronously and memoizes exactly the same Stop promise", async () => {
    const h = harness(), owner = h.owner(); await launch(h, owner);
    const first = owner.stop(); expect(owner.stop()).toBe(first); await expect(launch(h, owner)).rejects.toThrow();
    await first; expect(owner.stop()).toBe(first); expect(h.api.close).toHaveBeenCalledTimes(3);
  });
  it("refuses duplicate launch without creating another process", async () => {
    const h = harness(), owner = h.owner(); await launch(h, owner); await expect(launch(h, owner)).rejects.toThrow(); expect(h.create).toHaveBeenCalledTimes(1); await owner.stop();
  });
  it("cannot reuse an inert receipt's binding to issue a new live owner", async () => {
    const h = harness(), owner = h.owner(), receipt = await owner.stop(); const created = h.api.createJob.mock.calls.length;
    expect(() => h.owner()).toThrow(); expect(h.api.createJob).toHaveBeenCalledTimes(created);
    requireWindowsCommandRootOnlyStopped(receipt, h.binding);
  });
  it.each([false, undefined, 1, "yes"])("pre-create current %s creates no process and preserves inert cleanup", async value => {
    const h = harness(), owner = h.owner(); h.current.mockReturnValue(value as boolean);
    await expect(launch(h, owner)).rejects.toThrow(); expect(h.create).not.toHaveBeenCalled();
    requireWindowsCommandRootOnlyStopped(await owner.stop(), h.binding); expect(h.fence.failure).toBeUndefined();
  });
  it("sanitizes pre-create callback errors without pretending creation happened", async () => {
    const h = harness(), owner = h.owner(); h.current.mockImplementation(() => { throw new Error(PRIVATE); });
    await expect(launch(h, owner)).rejects.not.toThrow(PRIVATE); expect(h.create).not.toHaveBeenCalled(); await owner.stop();
  });
  it.each([-1, 15001, NaN, Infinity, 1.5])("rejects invalid timeout %s before revoking or touching native owners", async timeout => {
    const h = harness(), owner = h.owner(); const before = h.events.slice(); await expect(owner.stop(timeout)).rejects.toThrow();
    expect(h.events).toEqual(before); await launch(h, owner); await owner.stop();
  });
  it("accepts an already-signalled root with an exact zero-time budget", async () => {
    const h = harness(), owner = h.owner(); await launch(h, owner); h.end(); await owner.stop(0); expect(h.api.terminateProcess).not.toHaveBeenCalled();
  });
  it("waits for the exact root/thread even when job accounting reaches zero first", async () => {
    const h = harness(), owner = h.owner(); await launch(h, owner);
    let pending = 2; h.native.wait.mockImplementation(() => pending-- > 0 ? 258 : 0);
    await owner.stop(); expect(h.native.wait.mock.calls.every(([value]) => value === root.process || value === root.thread)).toBe(true);
    expect(h.api.close).toHaveBeenCalledTimes(3);
  });
  it("waits for job zero even when the root has exited naturally", async () => {
    const h = harness(), owner = h.owner(); await launch(h, owner); h.end(); let remaining = 2;
    h.native.state.mockImplementation(() => remaining-- > 0 ? { total: 1, active: 1, pids: [root.pid] } : { total: 1, active: 0, pids: [] });
    await owner.stop(); expect(h.native.state.mock.calls.length).toBeGreaterThan(3); expect(h.api.close).toHaveBeenCalledTimes(3);
  });
  it.each(["create", "attest", "current", "assign", "resume"])("fences unknown %s completion, never returns a stopped receipt, and retains callbacks", async point => {
    const h = harness(), owner = h.owner();
    if (point === "create") h.create.mockImplementation(() => { throw new Error(PRIVATE); });
    if (point === "attest") h.attest.mockImplementation(() => { throw new Error(PRIVATE); });
    if (point === "current") h.current.mockReturnValueOnce(true).mockImplementation(() => { throw new Error(PRIVATE); });
    if (point === "assign") h.api.assign.mockImplementation(() => { throw new Error(PRIVATE); });
    if (point === "resume") h.api.resume.mockImplementation(() => { throw new Error(PRIVATE); });
    const error = await cleanup(launch(h, owner)); await expect(owner.stop()).rejects.toBe(error);
    expect(h.api.close).not.toHaveBeenCalled(); expect(h.fence.retained).toHaveLength(1);
    expect(h.api.terminateJob).toHaveBeenCalledTimes(1); if (point !== "create") expect(h.api.terminateProcess).toHaveBeenCalledTimes(1);
  });
  it("retains and stops a returned process before a later field getter throws", async () => {
    const h = harness(), owner = h.owner(); h.create.mockReturnValue({ process: root.process, get thread(): bigint { throw new Error(PRIVATE); }, pid: root.pid });
    await cleanup(launch(h, owner)); expect(h.api.terminateProcess).toHaveBeenCalledWith(root.process); expect(h.api.close).not.toHaveBeenCalled();
  });
  it.each([
    { process: 0n, thread: 21n, pid: 200 }, { process: 10n, thread: 21n, pid: 200 }, { process: 20n, thread: 10n, pid: 200 },
    { process: 20n, thread: 20n, pid: 200 }, { process: 20n, thread: 21n, pid: 0 }, { process: 20n, thread: 21n, pid: 0x100000000 },
  ])("rejects malformed/aliased returned root %# without resume", async value => {
    const h = harness(), owner = h.owner(); h.create.mockReturnValue(value); await cleanup(launch(h, owner)); expect(h.api.resume).not.toHaveBeenCalled(); expect(h.api.close).not.toHaveBeenCalled();
  });
  it.each(["processId", "threadProcessId", "member", "history", "foreignPid", "missingRoot"])("refuses exact binding mismatch %s before resume", async point => {
    const h = harness(), owner = h.owner();
    if (point === "processId") h.native.processId.mockReturnValue(201);
    if (point === "threadProcessId") h.native.threadProcessId.mockReturnValue(201);
    if (point === "member") h.native.member.mockReturnValueOnce(false).mockReturnValue(false);
    if (point === "history") h.native.state.mockReturnValue({ total: 2, active: 1, pids: [200] });
    if (point === "foreignPid") h.native.state.mockReturnValueOnce({ total: 0, active: 0, pids: [] }).mockReturnValue({ total: 1, active: 1, pids: [201] });
    if (point === "missingRoot") h.native.state.mockReturnValueOnce({ total: 0, active: 0, pids: [] }).mockReturnValue({ total: 1, active: 0, pids: [] });
    await cleanup(launch(h, owner)); expect(h.api.resume).not.toHaveBeenCalled();
  });
  it("a current revocation immediately before Resume prevents execution", async () => {
    const h = harness(), owner = h.owner(); h.current.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    await cleanup(launch(h, owner)); expect(h.api.resume).not.toHaveBeenCalled();
  });
  it("a callback's synchronous Stop revocation never resumes or queries already-closed handles", async () => {
    const h = harness(), owner = h.owner(); let stopped: Promise<unknown> | undefined;
    h.attest.mockImplementation(() => { stopped = owner.stop(); });
    await cleanup(launch(h, owner)); await cleanup(stopped!);
    expect(h.api.resume).not.toHaveBeenCalled(); expect(h.api.close).not.toHaveBeenCalled();
  });
  it("Stop requested inside the first current callback prevents even creation", async () => {
    const h = harness(), owner = h.owner(); let stopped: Promise<unknown> | undefined;
    h.current.mockImplementation(() => { stopped = owner.stop(); return true; });
    await expect(launch(h, owner)).rejects.toThrow(); await stopped;
    expect(h.create).not.toHaveBeenCalled(); expect(h.api.resume).not.toHaveBeenCalled();
  });
  it("the shared deadline includes the initial asynchronous deferral", async () => {
    const h = harness(), owner = h.owner(); const limits = h.native.assertLimits.mock.calls.length;
    const stopped = owner.stop(1); h.time(2); await cleanup(stopped);
    expect(h.native.assertLimits).toHaveBeenCalledTimes(limits); expect(h.api.close).not.toHaveBeenCalled();
  });
  it("a shared-fence failure retains every active owner and allows only non-disposing Stop of a distinct peer", async () => {
    const a = harness(), other = { process: 40n, thread: 41n, pid: 400 }, b = harness(other, 30n);
    const first = a.owner(), second = createWindowsCommandRootOnlyStopOwner(b.binding, b.api, b.native, b.clock, a.fence);
    await launch(a, first); await launch(b, second);
    a.native.wait.mockImplementation(() => { throw new Error(PRIVATE); });
    const error = await cleanup(first.stop()); expect(a.fence.retained).toHaveLength(2);
    const queries = b.native.state.mock.calls.length + b.native.wait.mock.calls.length + b.native.assertLimits.mock.calls.length;
    await expect(second.stop()).rejects.toBe(error);
    expect(b.api.terminateProcess).toHaveBeenCalledWith(other.process); expect(b.api.terminateJob).toHaveBeenCalledWith(30n);
    expect(b.native.state.mock.calls.length + b.native.wait.mock.calls.length + b.native.assertLimits.mock.calls.length).toBe(queries);
    expect(b.api.close).not.toHaveBeenCalled(); expect(a.fence.retained).toHaveLength(2);
    await expect(second.stop()).rejects.toBe(error); expect(b.api.terminateProcess).toHaveBeenCalledTimes(1); expect(b.api.terminateJob).toHaveBeenCalledTimes(1);
  });
  it.each(["initial-current", "create", "attest", "final-current"] as const)("a peer fence set inside %s permits no later native query or Resume", async point => {
    const a = harness(), b = harness({ process: 40n, thread: 41n, pid: 400 }, 30n);
    const first = a.owner(), peer = createWindowsCommandRootOnlyStopOwner(b.binding, b.api, b.native, b.clock, a.fence);
    await launch(b, peer);
    const queries = () => Object.entries(a.native).filter(([name]) => name !== "close").reduce((count, [, fn]) => count + fn.mock.calls.length, 0);
    let afterPoison = -1, calls = 0;
    const poison = () => { peer.retainStop(); afterPoison = queries(); };
    if (point === "initial-current") a.current.mockImplementation(() => { poison(); return true; });
    if (point === "create") a.create.mockImplementation(() => { poison(); return root; });
    if (point === "attest") a.attest.mockImplementation(() => { poison(); });
    if (point === "final-current") a.current.mockImplementation(() => { if (++calls === 3) poison(); return true; });
    await cleanup(launch(a, first));
    expect(afterPoison).toBeGreaterThanOrEqual(0); expect(queries()).toBe(afterPoison);
    expect(a.api.resume).not.toHaveBeenCalled(); expect(a.api.close).not.toHaveBeenCalled(); expect(a.fence.retained).toHaveLength(2);
    expect(a.api.terminateJob).toHaveBeenCalledTimes(1);
    if (point === "initial-current") expect(a.create).not.toHaveBeenCalled(); else expect(a.api.terminateProcess).toHaveBeenCalledTimes(1);
  });
  it("refuses a job acquisition aliasing a peer's held owner without disposing the peer", async () => {
    const a = harness(), first = a.owner(); await launch(a, first); const b = harness(root, root.thread);
    expect(() => createWindowsCommandRootOnlyStopOwner(b.binding, b.api, b.native, b.clock, a.fence)).toThrow(WindowsCommandRootOnlyCleanupError);
    expect(b.native.configure).not.toHaveBeenCalled(); expect(b.api.terminateJob).not.toHaveBeenCalled(); expect(b.api.close).not.toHaveBeenCalled();
    expect(a.fence.retained).toHaveLength(2); await cleanup(first.stop()); expect(a.api.close).not.toHaveBeenCalled();
  });
  it("refuses a creator returning a peer's process handle without terminating or closing that foreign handle", async () => {
    const a = harness(), first = a.owner(); await launch(a, first); const b = harness(root, 30n);
    const second = createWindowsCommandRootOnlyStopOwner(b.binding, b.api, b.native, b.clock, a.fence);
    await cleanup(launch(b, second)); expect(b.api.terminateProcess).not.toHaveBeenCalled(); expect(b.api.close).not.toHaveBeenCalled(); await cleanup(first.stop());
  });
  it("external file/ACL quarantine synchronously retains and non-disposingly stops every shared owner", async () => {
    const a = harness(), b = harness({ process: 40n, thread: 41n, pid: 400 }, 30n), first = a.owner();
    const second = createWindowsCommandRootOnlyStopOwner(b.binding, b.api, b.native, b.clock, a.fence);
    await launch(a, first); await launch(b, second);
    const queries = [a, b].map(h => h.native.state.mock.calls.length + h.native.wait.mock.calls.length + h.native.assertLimits.mock.calls.length);
    expect(first.retainStop()).toBeUndefined(); expect(a.fence.retained).toHaveLength(2);
    for (const [index, h] of [a, b].entries()) {
      expect(h.api.terminateProcess).toHaveBeenCalledTimes(1); expect(h.api.terminateJob).toHaveBeenCalledTimes(1);
      expect(h.native.state.mock.calls.length + h.native.wait.mock.calls.length + h.native.assertLimits.mock.calls.length).toBe(queries[index]);
      expect(h.api.close).not.toHaveBeenCalled();
    }
    await cleanup(first.stop()); await cleanup(second.stop()); second.retainStop();
    for (const h of [a, b]) { expect(h.api.terminateProcess).toHaveBeenCalledTimes(1); expect(h.api.terminateJob).toHaveBeenCalledTimes(1); expect(h.api.close).not.toHaveBeenCalled(); }
  });
  it("external quarantine never uses a handle after any close attempt became uncertain", async () => {
    const a = harness(), first = a.owner(); await launch(a, first); a.end(); a.api.close.mockImplementation(() => { throw new Error(PRIVATE); });
    await cleanup(first.stop()); const calls = a.events.slice(); first.retainStop(); expect(a.events).toEqual(calls);
  });
  it.each(["limits", "state", "wait", "terminateProcess", "terminateJob"])("Stop %s uncertainty retains every handle and never queries after the first failure", async point => {
    const h = harness(), owner = h.owner(); await launch(h, owner); const fail = () => { throw new Error(PRIVATE); };
    if (point === "limits") h.native.assertLimits.mockImplementation(fail);
    if (point === "state") h.native.state.mockImplementation(fail);
    if (point === "wait") h.native.wait.mockImplementation(fail);
    if (point === "terminateProcess") h.api.terminateProcess.mockImplementation(fail);
    if (point === "terminateJob") h.api.terminateJob.mockImplementation(fail);
    const error = await cleanup(owner.stop()); const calls = h.native.state.mock.calls.length + h.native.wait.mock.calls.length;
    await expect(owner.stop()).rejects.toBe(error); expect(h.native.state.mock.calls.length + h.native.wait.mock.calls.length).toBe(calls); expect(h.api.close).not.toHaveBeenCalled();
  });
  it.each(["timeout", "backward", "nonfinite", "late-final"])("one absolute monotonic budget refuses %s with no receipt/disposal", async mode => {
    const h = harness(), owner = h.owner(); await launch(h, owner);
    if (mode === "timeout") { h.native.wait.mockReturnValue(258); let time = 0; h.clock.mockImplementation(() => time++); }
    if (mode === "backward") h.clock.mockReturnValueOnce(5).mockReturnValue(4);
    if (mode === "nonfinite") h.clock.mockReturnValueOnce(0).mockReturnValue(NaN);
    if (mode === "late-final") h.native.state.mockImplementation(() => { h.time(2); return { total: 1, active: 0, pids: [] }; });
    await cleanup(owner.stop(1)); expect(h.api.close).not.toHaveBeenCalled();
  });
  it("refuses a nonzero final job recheck even after positive retained-handle signals", async () => {
    const h = harness(), owner = h.owner(); await launch(h, owner);
    h.native.state.mockReturnValueOnce({ total: 1, active: 0, pids: [] }).mockReturnValue({ total: 1, active: 1, pids: [root.pid] });
    await cleanup(owner.stop()); expect(h.api.close).not.toHaveBeenCalled();
  });
  it("refuses decreasing historical membership instead of trusting an apparently empty replacement job", async () => {
    const h = harness(), owner = h.owner(); await launch(h, owner);
    h.native.state.mockReturnValue({ total: 0, active: 0, pids: [] }); await cleanup(owner.stop()); expect(h.api.close).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])("first uncertain close at index %s fences without later closes or extra native Stop", async index => {
    const h = harness(), owner = h.owner(); await launch(h, owner); h.end(); let count = 0;
    h.api.close.mockImplementation(() => { if (count++ === index) throw new Error(PRIVATE); });
    const error = await cleanup(owner.stop()); expect(h.api.close).toHaveBeenCalledTimes(index + 1);
    expect(h.api.terminateProcess).not.toHaveBeenCalled(); const stops = h.api.terminateJob.mock.calls.length;
    await expect(owner.stop()).rejects.toBe(error); expect(h.api.terminateJob).toHaveBeenCalledTimes(stops); expect(h.api.close).toHaveBeenCalledTimes(index + 1);
    expect(() => h.owner()).toThrow(error as Error);
  });
  it("refuses non-void cleanup return rather than treating FALSE as success", async () => {
    const h = harness(), owner = h.owner(); h.api.close.mockImplementation(() => false as unknown as void);
    await cleanup(owner.stop()); expect(h.api.close).toHaveBeenCalledTimes(1);
  });
  it("unknown job creation cannot mint a vacuous inert proof", () => {
    const h = harness(); h.api.createJob.mockImplementation(() => { throw new Error(PRIVATE); });
    expect(() => h.owner()).toThrow(WindowsCommandRootOnlyCleanupError); expect(h.fence.retained).toHaveLength(1); expect(h.api.close).not.toHaveBeenCalled();
  });
});

function ffi() {
  let limits = Buffer.alloc(144); const dlls: string[] = [], prototypes: string[] = [];
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    SetInformationJobObject: vi.fn((_job: unknown, kind: unknown, value: unknown, length: unknown) => { expect(kind).toBe(9); expect(length).toBe(144); limits = Buffer.from(value as Buffer); return 1; }),
    QueryInformationJobObject: vi.fn((_job: unknown, kind: unknown, value: unknown) => {
      const bytes = value as Buffer;
      if (kind === 9) limits.copy(bytes);
      if (kind === 1) { bytes.writeUInt32LE(1, 36); bytes.writeUInt32LE(1, 40); }
      if (kind === 3) { bytes.writeUInt32LE(1, 0); bytes.writeUInt32LE(1, 4); bytes.writeBigUInt64LE(200n, 8); }
      return 1;
    }),
    GetProcessId: vi.fn(() => 200), GetProcessIdOfThread: vi.fn(() => 200),
    IsProcessInJob: vi.fn((_process: unknown, _job: unknown, inside: unknown) => { (inside as unknown[])[0] = 1; return 1; }),
    WaitForSingleObject: vi.fn(() => 0),
    CloseHandle: vi.fn(() => 1),
  };
  const koffi = { sizeof: vi.fn(() => 8) }, load = vi.fn((name: string) => { dlls.push(name); return { func(prototype: string) { prototypes.push(prototype); return functions[/\b(\w+)\s*\(/.exec(prototype)![1]]; } }; });
  const bind = () => bindWindowsCommandRootOnlyStopNative(koffi, load);
  return { functions, koffi, load, bind, dlls, prototypes, limits: () => limits };
}
describe("root-only Win64 FFI contracts", () => {
  it("binds fixed synchronous APIs only and configures exact one-root/no-breakaway limits", () => {
    const f = ffi(), native = f.bind(); native.configure(10n);
    expect(f.dlls).toEqual(["kernel32.dll"]); expect(f.prototypes).toEqual(WINDOWS_COMMAND_ROOT_ONLY_STOP_FUNCTIONS);
    expect(f.limits().readUInt32LE(16)).toBe(0x2008); expect(f.limits().readUInt32LE(40)).toBe(1);
    const rest = Buffer.from(f.limits()); rest.writeUInt32LE(0, 16); rest.writeUInt32LE(0, 40); expect(rest.equals(Buffer.alloc(144))).toBe(true);
  });
  it.each([4, 0, 16])("refuses pointer width %s before DLL loading", width => { const f = ffi(); f.koffi.sizeof.mockReturnValue(width); expect(f.bind).toThrow(); expect(f.load).not.toHaveBeenCalled(); });
  it("refuses a missing FFI function", () => { const f = ffi(); delete f.functions.GetProcessId; expect(f.bind).toThrow(); });
  it("ignores dynamic IO and peak memory counters but never memory limits", () => {
    const f = ffi(), native = f.bind(); native.configure(10n); f.limits().writeBigUInt64LE(9n, 64); f.limits().writeBigUInt64LE(8n, 128); native.assertLimits(10n);
    f.limits().writeBigUInt64LE(1n, 112); expect(() => native.assertLimits(10n)).toThrow();
  });
  it.each([[16, 0x2000], [16, 0x2808], [16, 0x3008], [40, 0], [40, 2], [56, 1]])("refuses altered limit field %s/%s", (offset, value) => {
    const f = ffi(), native = f.bind(); native.configure(10n); f.limits().writeUInt32LE(value, offset); expect(() => native.assertLimits(10n)).toThrow();
  });
  it.each([false, undefined, 0, "1", NaN])("refuses non-BOOL or FALSE SetInformation result %s", result => {
    const f = ffi(); f.functions.SetInformationJobObject = () => result; expect(() => f.bind().configure(10n)).toThrow();
  });
  it("reads exact bounded job accounting and one PID with no PID reopening API", () => {
    const f = ffi(), native = f.bind(); expect(native.state(10n)).toEqual({ total: 1, active: 1, pids: [200] });
    expect(f.prototypes.some(value => value.includes("OpenProcess"))).toBe(false);
    expect(native.processId(20n)).toBe(200); expect(native.threadProcessId(21n)).toBe(200); expect(native.member(20n, 10n)).toBe(true);
  });
  it.each(["history", "partial", "foreignWidth", "zeroPid", "activeMismatch", "terminatedOverflow"])("refuses incomplete/bad job metadata %s", mode => {
    const f = ffi(), original = f.functions.QueryInformationJobObject;
    f.functions.QueryInformationJobObject = (...args) => {
      original(...args); const kind = args[1], bytes = args[2] as Buffer;
      if (mode === "history" && kind === 1) bytes.writeUInt32LE(2, 36);
      if (mode === "partial" && kind === 3) bytes.writeUInt32LE(2, 0);
      if (mode === "foreignWidth" && kind === 3) bytes.writeBigUInt64LE(0x100000000n, 8);
      if (mode === "zeroPid" && kind === 3) bytes.writeBigUInt64LE(0n, 8);
      if (mode === "activeMismatch" && kind === 1) bytes.writeUInt32LE(0, 40);
      if (mode === "terminatedOverflow" && kind === 1) bytes.writeUInt32LE(2, 44);
      return 1;
    };
    expect(() => f.bind().state(10n)).toThrow();
  });
  it.each([0xffffffff, 1, undefined, false, NaN])("refuses unknown wait %s without any error-text query", result => {
    const f = ffi(); f.functions.WaitForSingleObject = () => result; expect(() => f.bind().wait(20n)).toThrow();
    expect(f.prototypes.some(value => value.includes("GetLastError"))).toBe(false);
  });
  it.each([0, 258] as const)("accepts exactly wait %s and always requests zero blocking time", status => {
    const f = ffi(), calls: unknown[][] = []; f.functions.WaitForSingleObject = (...args) => { calls.push(args); return status; };
    expect(f.bind().wait(20n)).toBe(status); expect(calls).toEqual([[20n, 0]]);
  });
  it.each([0, -1, 1.1, "200", undefined])("refuses malformed held process/thread PID %s", value => {
    const f = ffi(); f.functions.GetProcessId = () => value; f.functions.GetProcessIdOfThread = () => value;
    const native = f.bind(); expect(() => native.processId(20n)).toThrow(); expect(() => native.threadProcessId(21n)).toThrow();
  });
  it.each([2, -1, true, undefined])("refuses unexpected IsProcessInJob output %s", value => {
    const f = ffi(); f.functions.IsProcessInJob = (_process, _job, inside) => { (inside as unknown[])[0] = value; return 1; };
    expect(() => f.bind().member(20n, 10n)).toThrow();
  });
  it("sanitizes thrown FFI data in the owning lifecycle and retains its argument owner", async () => {
    const h = harness(), f = ffi(); f.functions.SetInformationJobObject = () => { throw new Error(PRIVATE); };
    expect(() => createWindowsCommandRootOnlyStopOwner(h.binding, h.api, f.bind(), h.clock, h.fence)).toThrow(WindowsCommandRootOnlyCleanupError);
    expect(String(h.fence.failure)).not.toContain(PRIVATE); expect(h.fence.retained).toHaveLength(1); expect(h.api.close).not.toHaveBeenCalled();
  });
  it.each([false, undefined, 0, "1", NaN, 0x80000000])("refuses unknown/false close ABI %s", result => {
    const f = ffi(); f.functions.CloseHandle = () => result; expect(() => f.bind().close(20n)).toThrow();
  });
  it.each([1, -1])("accepts only a validated nonzero native BOOL close %s", result => {
    const f = ffi(), calls: unknown[][] = []; f.functions.CloseHandle = (...args) => { calls.push(args); return result; };
    expect(f.bind().close(20n)).toBeUndefined(); expect(calls).toEqual([[20n]]);
  });
});
