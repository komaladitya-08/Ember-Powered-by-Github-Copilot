/** Portable FFI ownership contracts. No source-Node, Windows API, child process or native module is executed. */
import { describe, expect, it, vi } from "vitest";
import { WindowsNodeHostCleanupError } from "../fixtures/windows-node-lpac-startup";
import { bindWindowsNodeSourceChildObserver, WINDOWS_NODE_SOURCE_CHILD_FUNCTIONS, WindowsNodeSourceChildObserverCleanupError,
  type WindowsNodeSourceChildObserverFence, type WindowsNodeSourceChildObserverInput } from "../fixtures/windows-node-source-child-observer";

const JOB = 10n, ROOT = 20n, CHILD = 30n, AUX = 40n, ROOT_PID = 400, CHILD_PID = 500, AUX_PID = 600;
const IMAGE = "C:\\private\\source-node\\node.exe";
type Call = { name: string; args: unknown[] };
type Fault = "query-false" | "query-abi" | "query-throw" | "assigned" | "overflow" | "duplicate" | "pid-zero" | "pid-large" |
  "open-null" | "open-zero" | "open-abi" | "open-invalid" | "open-root" | "open-job" | "open-alias" | "open-throw" |
  "pid-mismatch" | "pid-false" | "pid-throw" | "image-false" | "image-abi" | "image-empty" | "image-overflow" | "image-length-abi" | "image-control" | "image-throw" |
  "image-other-node" | "image-console" | "image-extended" | "duplicate-candidate" | "job-false" | "job-abi" | "job-no" | "job-output-abi" | "job-throw" |
  "wait-failed" | "wait-abi" | "wait-throw" | "close-false" | "close-abi" | "close-throw" | "close-second-false" | "active-after-stop";
function setup(clock: () => number = () => 100, lastError: unknown = 5) {
  let fault: Fault | undefined, lists: number[][] = [[ROOT_PID]], queries = 0, stopped = false, current = true, closeCount = 0;
  let stoppedList: number[] = [];
  const dead = new Set<number>(), forceAlive = new Set<number>(), releaseOnWait = new Set<number>(), images = new Map<number, string>();
  let afterWait: (() => void) | undefined;
  const calls: Call[] = [], buffers: Buffer[] = [], events: string[] = [];
  const fence: WindowsNodeSourceChildObserverFence = { retained: [] };
  const handleFor = (id: number) => id === CHILD_PID ? CHILD : id === AUX_PID ? AUX : BigInt(id + 10_000);
  const idFor = (value: unknown) => value === ROOT ? ROOT_PID : value === CHILD ? CHILD_PID : value === AUX ? AUX_PID : Number(value) - 10_000;
  const invoke = (name: string, args: unknown[]): unknown => {
    calls.push({ name, args }); events.push(name);
    if (name === "GetLastError") { if (lastError instanceof Error) throw lastError; return lastError; }
    if (name === "QueryInformationJobObject") {
      const bytes = args[2] as Buffer; buffers.push(bytes);
      if (fault === "query-false") return 0; if (fault === "query-abi") return true; if (fault === "query-throw") throw new Error("private native job error");
      if (args[1] === 1) { bytes.writeUInt32LE(fault === "active-after-stop" ? 1 : stopped ? 0 : 1, 40); return 1; }
      const found = stopped ? stoppedList : lists[Math.min(queries++, lists.length - 1)];
      bytes.writeUInt32LE(fault === "assigned" ? found.length + 1 : fault === "overflow" ? 9 : found.length, 0);
      bytes.writeUInt32LE(fault === "overflow" ? 9 : found.length, 4);
      for (let index = 0; index < Math.min(found.length, 8); index++) bytes.writeBigUInt64LE(fault === "duplicate" ? BigInt(ROOT_PID) :
        fault === "pid-zero" ? 0n : fault === "pid-large" ? 0x100000000n : BigInt(found[index]), 8 + index * 8);
      return 1;
    }
    if (name === "OpenProcess") {
      if (fault === "open-throw") throw new Error("private unknown OpenProcess completion");
      return fault === "open-null" ? null : fault === "open-zero" ? 0n : fault === "open-abi" ? 30 : fault === "open-invalid" ? 0xffffffffffffffffn :
        fault === "open-root" ? ROOT : fault === "open-job" ? JOB : fault === "open-alias" ? CHILD : handleFor(args[2] as number);
    }
    if (name === "WaitForSingleObject") {
      if (fault === "wait-failed") return 0xffffffff; if (fault === "wait-abi") return true; if (fault === "wait-throw") throw new Error("private wait failure");
      const id = idFor(args[0]);
      if ((args[1] as number) > 0) { if (releaseOnWait.has(id)) forceAlive.delete(id); afterWait?.(); }
      if (forceAlive.has(id)) return 258;
      return stopped || dead.has(id) ? 0 : 258;
    }
    if (name === "GetProcessId") {
      if (args[0] !== ROOT) {
        if (fault === "pid-mismatch") return 123; if (fault === "pid-false") return 0; if (fault === "pid-throw") throw new Error("private process identity");
      }
      return idFor(args[0]);
    }
    if (name === "QueryFullProcessImageNameW") {
      const bytes = args[2] as Buffer, length = args[3] as unknown[]; buffers.push(bytes);
      const child = args[0] !== ROOT;
      if (child && fault === "image-false") return 0; if (child && fault === "image-abi") return true; if (child && fault === "image-throw") throw new Error("C:\\private\\native image error");
      const image = child && fault === "image-other-node" ? "C:\\other\\node.exe" : child && fault === "image-console" ? "C:\\Windows\\System32\\conhost.exe" :
        child && fault === "image-extended" ? "\\\\?\\" + IMAGE : child && fault === "image-control" ? "C:\\private\0node.exe" :
        images.get(idFor(args[0])) ?? (args[0] === ROOT || args[0] === CHILD || fault === "duplicate-candidate" ? IMAGE.toUpperCase() : "C:\\Windows\\System32\\conhost.exe");
      Buffer.from(image, "utf16le").copy(bytes);
      length[0] = child && fault === "image-empty" ? 0 : child && fault === "image-overflow" ? 32768 : child && fault === "image-length-abi" ? true : image.length;
      return 1;
    }
    if (name === "IsProcessInJob") {
      if (args[0] !== ROOT) {
        if (fault === "job-throw") throw new Error("private membership error");
        if (fault === "job-false") return 0; if (fault === "job-abi") return true;
      }
      (args[2] as unknown[])[0] = args[1] !== JOB || (args[0] !== ROOT && fault === "job-no") ? 0 : args[0] !== ROOT && fault === "job-output-abi" ? true : 1;
      return 1;
    }
    if (name === "CloseHandle") {
      closeCount++;
      if (fault === "close-throw") throw new Error("private unknown close completion");
      return fault === "close-false" || (fault === "close-second-false" && closeCount === 2) ? 0 : fault === "close-abi" ? true : 1;
    }
    throw new Error("No other native operation is permitted in this mock.");
  };
  const load = vi.fn((_name: string) => ({ func: vi.fn((prototype: string) => {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => invoke(name, args);
  }) }));
  const observer = bindWindowsNodeSourceChildObserver({ sizeof: () => 8 }, load, fence, clock);
  const verifyToken = vi.fn((_child: bigint) => { events.push("verifyToken"); });
  const grant = vi.fn((_pid: number) => { events.push("grant"); });
  const input: WindowsNodeSourceChildObserverInput = { job: JOB, rootProcess: ROOT, rootPid: ROOT_PID, image: IMAGE,
    current: vi.fn(() => { events.push("current"); return current; }), verifyToken, grant };
  return { observer, input, load, fence, calls, buffers, events, verifyToken, grant,
    fault(value: Fault) { fault = value; }, repair() { fault = undefined; }, revoke() { current = false; },
    lists(value: number[][]) { lists = value; queries = 0; }, image(id: number, value: string) { images.set(id, value); },
    dead(id: number) { dead.add(id); }, keepAlive(id: number) { forceAlive.add(id); }, signalDuringWait(id: number) { releaseOnWait.add(id); },
    afterWait(action: () => void) { afterWait = action; }, stop() { stopped = true; },
    stoppedList(value: number[]) { stoppedList = value; },
    bind() { observer.bind(input); }, finish() { stopped = true; observer.waitStoppedBefore(1_000); observer.closeStopped(); },
  };
}
type Fixture = ReturnType<typeof setup>;
const closed = (f: Fixture) => f.calls.filter(call => call.name === "CloseHandle").map(call => call.args[0]);
const openCalls = (f: Fixture) => f.calls.filter(call => call.name === "OpenProcess");
function withChild(clock?: () => number, lastError?: unknown) {
  const f = setup(clock, lastError); f.bind(); f.lists([[ROOT_PID, CHILD_PID, AUX_PID]]); return f;
}
function noFurtherQueries(f: Fixture) {
  const count = f.calls.length; f.repair();
  for (const call of [() => f.observer.admit(), () => f.observer.bind(f.input), () => f.observer.requireStopped(), () => f.observer.waitStoppedBefore(1_000), () => f.observer.closeStopped()])
    expect(call).toThrow(WindowsNodeSourceChildObserverCleanupError);
  expect(f.calls).toHaveLength(count);
}

describe("fixed source-Node retained child observer", () => {
  it("loads only the eight fixed query/synchronization/close functions on the injected Win64 seam", () => {
    const f = setup(); expect(f.load).toHaveBeenCalledExactlyOnceWith("kernel32.dll"); expect(WINDOWS_NODE_SOURCE_CHILD_FUNCTIONS).toHaveLength(8);
    expect(WINDOWS_NODE_SOURCE_CHILD_FUNCTIONS.join(" ")).not.toMatch(/CreateProcess|ResumeThread|TerminateProcess|TerminateJob|SetToken|SetSecurity/);
    expect(() => bindWindowsNodeSourceChildObserver({ sizeof: () => 4 }, f.load, { retained: [] })).toThrow("fixed source-Node");
    expect(() => bindWindowsNodeSourceChildObserver({ sizeof: () => 8 }, () => ({ func: () => 1 }), { retained: [] })).toThrow("fixed source-Node");
  });
  it("classifies terminal ownership uncertainty as the existing unsafe host-cleanup class", () => {
    expect(new WindowsNodeSourceChildObserverCleanupError()).toBeInstanceOf(WindowsNodeHostCleanupError);
  });
  it("requires a mandatory exact root bind before observation or Stop proof", () => {
    const f = setup(); expect(() => f.observer.admit()).toThrow("fixed source-Node"); expect(f.calls).toEqual([]);
    f.bind(); expect(f.verifyToken).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); expect(openCalls(f)).toEqual([]);
    expect(f.calls.some(call => call.name === "GetProcessId" && call.args[0] === ROOT)).toBe(true);
    expect(f.calls.some(call => call.name === "IsProcessInJob" && call.args[0] === ROOT && call.args[1] === JOB)).toBe(true);
    const count = f.calls.length; expect(() => f.observer.bind(f.input)).toThrow("fixed source-Node"); expect(f.calls).toHaveLength(count); f.finish();
    const unbound = setup(); expect(() => unbound.observer.requireStopped()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(unbound.calls).toEqual([]);
  });
  it("captures exact binding callbacks and image values rather than retaining a mutable input object", () => {
    const f = withChild(), replacement = vi.fn(() => { throw new Error("private replacement"); });
    f.input.image = "C:\\other\\node.exe"; f.input.grant = replacement; f.input.current = () => false;
    expect(f.observer.admit()).toBe(CHILD_PID); expect(f.grant).toHaveBeenCalledExactlyOnceWith(CHILD_PID); expect(replacement).not.toHaveBeenCalled(); f.finish();
  });
  it.each(["image", "pid", "job", "exited", "current", "missing-root"] as const)("requires the borrowed root's exact live identity and private-job membership before bind succeeds (%s)", changed => {
    const f = setup();
    if (changed === "image") f.image(ROOT_PID, "C:\\other\\node.exe");
    if (changed === "pid") f.input.rootPid = 123;
    if (changed === "job") f.input.job = 11n;
    if (changed === "exited") f.stop();
    if (changed === "current") f.revoke();
    if (changed === "missing-root") f.lists([[AUX_PID]]);
    expect(() => f.bind()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(f.grant).not.toHaveBeenCalled(); expect(f.verifyToken).not.toHaveBeenCalled();
    expect(openCalls(f)).toEqual([]); noFurtherQueries(f);
  });
  it("gives a fixed ACK only to the unique exact already-running Node child after token verification and stable full job snapshots", () => {
    const f = withChild(); expect(f.observer.admit()).toBe(CHILD_PID);
    expect(openCalls(f).map(call => call.args)).toEqual([[0x101000, 0, CHILD_PID], [0x101000, 0, AUX_PID]]);
    expect(f.verifyToken).toHaveBeenCalledExactlyOnceWith(CHILD); expect(f.grant).toHaveBeenCalledExactlyOnceWith(CHILD_PID);
    const tokenAt = f.events.indexOf("verifyToken"), grantAt = f.events.indexOf("grant");
    expect(grantAt).toBeGreaterThan(tokenAt); expect(f.events.slice(tokenAt + 1, grantAt).filter(name => name === "QueryInformationJobObject").length).toBeGreaterThanOrEqual(2);
    expect(() => f.observer.admit()).toThrow("fixed source-Node"); expect(f.grant).toHaveBeenCalledOnce(); f.finish();
    expect(closed(f)).toEqual([CHILD, AUX]); expect(closed(f)).not.toContain(ROOT); expect(closed(f)).not.toContain(JOB);
  });
  it("retains current auxiliary members even while waiting for the expected child", () => {
    const f = setup(); f.lists([[ROOT_PID, AUX_PID]]); f.bind(); expect(openCalls(f)).toHaveLength(1);
    expect(f.observer.admit()).toBeNull(); expect(f.verifyToken).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); f.finish(); expect(closed(f)).toEqual([AUX]);
  });
  it.each(["image-other-node", "image-console", "image-extended"] as const)("never trusts a basename or an image spelling alias (%s)", fault => {
    const f = withChild(); f.fault(fault); expect(f.observer.admit()).toBeNull(); expect(f.grant).not.toHaveBeenCalled(); expect(f.verifyToken).not.toHaveBeenCalled(); f.finish();
  });
  it("retains newly observed members and retries only a known-changing snapshot before any ACK", () => {
    const f = setup(); f.bind(); f.lists([[ROOT_PID, CHILD_PID], [ROOT_PID, CHILD_PID, AUX_PID]]);
    expect(f.observer.admit()).toBeNull(); expect(openCalls(f).map(call => call.args[2])).toEqual([CHILD_PID, AUX_PID]); expect(f.grant).not.toHaveBeenCalled();
    expect(f.observer.admit()).toBe(CHILD_PID); expect(openCalls(f)).toHaveLength(2); f.finish();
  });
  it("retains a member appearing in the last snapshot and gives no ACK until two full snapshots agree", () => {
    const f = setup(); f.bind(); f.lists([[ROOT_PID, CHILD_PID], [ROOT_PID, CHILD_PID], [ROOT_PID, CHILD_PID, AUX_PID]]);
    expect(f.observer.admit()).toBeNull(); expect(openCalls(f)).toHaveLength(2); expect(f.grant).not.toHaveBeenCalled();
    expect(f.observer.admit()).toBe(CHILD_PID); f.finish();
  });
  it("refuses multiple exact-image candidates and retains all acquired writers", () => {
    const f = withChild(); f.fault("duplicate-candidate"); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(openCalls(f)).toHaveLength(2); expect(f.verifyToken).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); expect(closed(f)).toEqual([]); noFurtherQueries(f);
  });
  it("refuses a live retained member disappearing from the private job", () => {
    const f = setup(); f.bind(); f.lists([[ROOT_PID, AUX_PID]]); expect(f.observer.admit()).toBeNull();
    f.lists([[ROOT_PID, CHILD_PID]]); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(f.grant).not.toHaveBeenCalled(); noFurtherQueries(f);
  });
  it("keeps an exited missing auxiliary owned while observing a fresh child", () => {
    const f = setup(); f.bind(); f.lists([[ROOT_PID, AUX_PID]]); expect(f.observer.admit()).toBeNull(); f.dead(AUX_PID);
    f.lists([[ROOT_PID, CHILD_PID]]); expect(f.observer.admit()).toBe(CHILD_PID); f.finish(); expect(closed(f)).toEqual([AUX, CHILD]);
  });
  it("never reopens or replaces a signalled process object when its numeric PID appears again", () => {
    const f = setup(); f.bind(); f.lists([[ROOT_PID, AUX_PID]]); expect(f.observer.admit()).toBeNull(); f.dead(AUX_PID);
    expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(openCalls(f)).toHaveLength(1); noFurtherQueries(f);
  });
  it("bounds lifetime ownership to seven non-root process objects even after some exit", () => {
    const ids = [600, 601, 602, 603, 604, 605, 606], f = setup(); f.bind(); f.lists([[ROOT_PID, ...ids]]); expect(f.observer.admit()).toBeNull();
    for (const id of ids) f.dead(id); f.lists([[ROOT_PID, CHILD_PID]]);
    expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(openCalls(f)).toHaveLength(7); expect(f.grant).not.toHaveBeenCalled(); noFurtherQueries(f);
  });
  it.each(["query-false", "query-abi", "query-throw", "assigned", "overflow", "duplicate", "pid-zero", "pid-large"] as const)("refuses partial or malformed private-job lists (%s)", fault => {
    const f = withChild(); f.fault(fault); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(openCalls(f)).toEqual([]); noFurtherQueries(f);
  });
  it.each(["open-null", "open-zero", "open-abi", "open-invalid", "open-root", "open-job", "open-throw"] as const)("never closes a borrowed or unknown handle returned by process acquisition (%s)", fault => {
    const f = withChild(); f.fault(fault); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(closed(f)).toEqual([]); expect(f.grant).not.toHaveBeenCalled(); expect(f.fence.retained).toHaveLength(1); noFurtherQueries(f);
  });
  it("fences two numeric members aliasing the same native handle without duplicating close authority", () => {
    const f = withChild(); f.fault("open-alias"); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(openCalls(f)).toHaveLength(2); expect(closed(f)).toEqual([]); noFurtherQueries(f);
  });
  it.each(["pid-mismatch", "pid-false", "pid-throw", "image-false", "image-abi", "image-empty", "image-overflow", "image-length-abi", "image-control", "image-throw", "job-false", "job-abi", "job-no", "job-output-abi", "job-throw"] as const)("retains a known acquired owner before every fallible identity query (%s)", fault => {
    const f = withChild(); f.fault(fault); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(openCalls(f)).toHaveLength(1); expect(f.observer.observation().tracked).toBe(1); expect(closed(f)).toEqual([]); noFurtherQueries(f);
  });
  it.each(["current", "verifyToken", "grant"] as const)("fences a trusted synchronous callback failure without returning its private error (%s)", callback => {
    const f = withChild(); const method = callback === "current" ? f.input.current : callback === "verifyToken" ? f.verifyToken : f.grant;
    vi.mocked(method).mockImplementation(() => { throw new Error("C:\\private\\callback secret", { cause: "private" }); });
    let caught: unknown; try { f.observer.admit(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(WindowsNodeHostCleanupError); expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toMatch(/callback|secret|C:\\/); expect(JSON.stringify(f.observer.observation())).not.toMatch(/private|secret|node|pid/i); noFurtherQueries(f);
  });
  it.each(["current", "verifyToken", "grant"] as const)("refuses asynchronous callback shapes without retrying their side effects (%s)", callback => {
    const f = withChild(); const method = callback === "current" ? f.input.current : callback === "verifyToken" ? f.verifyToken : f.grant;
    vi.mocked(method).mockImplementation(() => Promise.resolve() as never);
    expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    if (callback !== "grant") expect(f.grant).not.toHaveBeenCalled(); noFurtherQueries(f);
  });
  it("refuses lost currency and a changed candidate image after token verification", () => {
    for (const change of ["current", "image"] as const) {
      const f = withChild(); f.verifyToken.mockImplementation(() => { if (change === "current") f.revoke(); else f.image(CHILD_PID, "C:\\other\\node.exe"); });
      expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(f.grant).not.toHaveBeenCalled(); noFurtherQueries(f);
    }
  });
  it.each(["query-false", "open-null", "pid-false", "image-false", "job-false", "wait-failed"] as const)("captures only immediate numeric Win32 failure facts (%s)", fault => {
    const f = withChild(); f.fault(fault); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(f.calls.at(-1)?.name).toBe("GetLastError"); expect(f.observer.observation()).toMatchObject({ domain: 2, code: 5 }); noFurtherQueries(f);
  });
  it.each([NaN, -1, 0x100000000, true, "private", new Error("private native TLS error")])("keeps malformed native error metadata unclassified (%#)", value => {
    const f = withChild(undefined, value); f.fault("query-false"); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(f.observer.observation()).toMatchObject({ domain: 0, code: 0 }); noFurtherQueries(f);
  });
  it("returns detached finite numeric observations and wipes every native query buffer", () => {
    const f = withChild(); f.observer.admit(); const copy = f.observer.observation(); copy.code = 123;
    expect(f.observer.observation().code).toBe(0); expect(Object.keys(copy)).toEqual(["operation", "domain", "code", "tracked", "candidates"]);
    expect(Object.values(f.observer.observation()).every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
    expect(f.buffers.every(buffer => buffer.every(value => value === 0))).toBe(true); f.finish();
  });
  it("blocks a new observer factory from reusing the same uncertain owner fence", () => {
    const f = withChild(); f.fault("open-throw"); expect(() => f.observer.admit()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    const calls = f.load.mock.calls.length; expect(() => bindWindowsNodeSourceChildObserver({ sizeof: () => 8 }, f.load, f.fence)).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(f.load).toHaveBeenCalledTimes(calls);
  });
  it.each([{ job: 0n }, { rootProcess: JOB }, { rootPid: 0 }, { rootPid: 0x100000000 }, { image: "\\\\server\\private\\node.exe" },
    { image: "C:\\private\\..\\node.exe" }, { image: "C:\\private\\node.exe:stream" }, { image: "C:\\private\nnode.exe" }])("refuses invalid borrowed contracts before any native query (%#)", changed => {
    const f = setup(); expect(() => f.observer.bind({ ...f.input, ...changed })).toThrow("fixed source-Node"); expect(f.calls).toEqual([]);
  });
  it("sanitizes an unexpected binding getter before taking any native authority", () => {
    const f = setup(); Object.defineProperty(f.input, "image", { get() { throw new Error("private binding getter"); } });
    expect(() => f.observer.bind(f.input)).toThrow("fixed source-Node"); expect(f.calls).toEqual([]);
  });
});

describe("source-Node whole-job and retained-handle Stop", () => {
  it("waits for asynchronous retained-member rundown after exact job zero, then repeats the complete proof", () => {
    const f = withChild(); f.observer.admit(); f.stop(); f.keepAlive(AUX_PID); f.signalDuringWait(AUX_PID); const start = f.calls.length;
    f.observer.waitStoppedBefore(1_000);
    const calls = f.calls.slice(start), waits = calls.filter(call => call.name === "WaitForSingleObject");
    expect(calls.slice(0, 2).map(call => [call.name, call.args[1]])).toEqual([["QueryInformationJobObject", 1], ["QueryInformationJobObject", 3]]);
    expect(waits.map(call => call.args)).toEqual([[ROOT, 900], [CHILD, 900], [AUX, 900], [ROOT, 0], [CHILD, 0], [AUX, 0]]);
    expect(calls.some(call => call.name === "OpenProcess")).toBe(false); f.observer.closeStopped(); expect(closed(f)).toEqual([CHILD, AUX]);
    const count = f.calls.length; f.observer.closeStopped(); expect(f.calls).toHaveLength(count);
  });
  it("consumes one decreasing absolute deadline and never creates a new per-handle budget", () => {
    const times = [100, 110, 120, 400, 410, 900, 910, 920], f = withChild(() => times.shift() ?? 920); f.observer.admit(); f.stop(); const start = f.calls.length;
    f.observer.waitStoppedBefore(1_000); expect(f.calls.slice(start).filter(call => call.name === "WaitForSingleObject").slice(0, 3).map(call => call.args[1])).toEqual([890, 600, 100]);
    f.observer.closeStopped();
  });
  it("accepts exactly zero remaining time only for already-signalled process objects", () => {
    const f = withChild(); f.observer.admit(); f.stop(); const start = f.calls.length; f.observer.waitStoppedBefore(100);
    expect(f.calls.slice(start).filter(call => call.name === "WaitForSingleObject").every(call => call.args[1] === 0)).toBe(true); f.observer.closeStopped();
  });
  it.each([ROOT_PID, CHILD_PID, AUX_PID])("retains and fences a nonsignalled handle even when job accounting and PID lists are zero (%s)", id => {
    const f = withChild(); f.observer.admit(); f.stop(); f.keepAlive(id);
    expect(() => f.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(closed(f)).toEqual([]); noFurtherQueries(f);
  });
  it.each(["wait-failed", "wait-abi", "wait-throw"] as const)("performs no further owner query after uncertain bounded wait (%s)", fault => {
    const f = withChild(); f.observer.admit(); f.stop(); f.fault(fault); const start = f.calls.length;
    expect(() => f.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError);
    const calls = f.calls.slice(start), waited = calls.findIndex(call => call.name === "WaitForSingleObject");
    expect(calls.slice(waited + 1).map(call => call.name)).toEqual(fault === "wait-failed" ? ["GetLastError"] : []); expect(closed(f)).toEqual([]); noFurtherQueries(f);
  });
  it("requires both initial and final job zero in addition to every handle's successful wait", () => {
    const first = withChild(); first.observer.admit(); first.stop(); first.fault("active-after-stop"); const start = first.calls.length;
    expect(() => first.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(first.calls.slice(start).some(call => call.name === "WaitForSingleObject")).toBe(false); noFurtherQueries(first);
    const last = withChild(); last.observer.admit(); last.stop(); last.afterWait(() => last.fault("active-after-stop"));
    expect(() => last.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError); noFurtherQueries(last);
  });
  it("requires complete listed zero even when native active accounting is already zero", () => {
    const f = withChild(); f.observer.admit(); f.stop(); f.stoppedList([AUX_PID]); const start = f.calls.length;
    expect(() => f.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(f.calls.slice(start).some(call => call.name === "WaitForSingleObject")).toBe(false); noFurtherQueries(f);
    const last = withChild(); last.observer.admit(); last.stop(); last.afterWait(() => last.stoppedList([AUX_PID]));
    expect(() => last.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError); noFurtherQueries(last);
  });
  it.each([NaN, Infinity, -1, 99, 15_101])("refuses invalid, expired or extended deadlines before any native query (%s)", deadline => {
    const f = withChild(); f.observer.admit(); f.stop(); const start = f.calls.length;
    expect(() => f.observer.waitStoppedBefore(deadline)).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(f.calls).toHaveLength(start); noFurtherQueries(f);
  });
  it.each([NaN, 99, 1_001])("rejects late or invalid last-wait completion before another owner query (%s)", last => {
    const times = [100, 100, 100, 100, last], f = setup(() => times.shift() ?? last); f.bind(); f.lists([[ROOT_PID, CHILD_PID]]); f.observer.admit(); f.stop(); const start = f.calls.length;
    expect(() => f.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError);
    const calls = f.calls.slice(start), lastWait = calls.findLastIndex(call => call.name === "WaitForSingleObject"); expect(calls.slice(lastWait + 1)).toEqual([]); noFurtherQueries(f);
  });
  it("rejects a final complete proof observed after the shared deadline", () => {
    const times = [100, 100, 100, 100, 100, 1_001], f = setup(() => times.shift() ?? 1_001); f.bind(); f.lists([[ROOT_PID, CHILD_PID]]); f.observer.admit(); f.stop();
    expect(() => f.observer.waitStoppedBefore(1_000)).toThrow(WindowsNodeSourceChildObserverCleanupError); noFurtherQueries(f);
  });
  it.each(["close-false", "close-abi", "close-throw"] as const)("stops at the first uncertain close and retains both owners without a later close or retry (%s)", fault => {
    const f = withChild(); f.observer.admit(); f.stop(); f.fault(fault);
    expect(() => f.observer.closeStopped()).toThrow(WindowsNodeSourceChildObserverCleanupError); expect(closed(f)).toEqual([CHILD]);
    expect(f.observer.observation().tracked).toBe(2); noFurtherQueries(f); expect(closed(f)).toEqual([CHILD]);
  });
  it("never repeats an earlier successful close or attempts a remaining owner after a later close becomes uncertain", () => {
    const f = setup(); f.bind(); f.lists([[ROOT_PID, CHILD_PID, AUX_PID, 601]]); expect(f.observer.admit()).toBe(CHILD_PID);
    f.stop(); f.fault("close-second-false"); expect(() => f.observer.closeStopped()).toThrow(WindowsNodeSourceChildObserverCleanupError);
    expect(closed(f)).toEqual([CHILD, AUX]); expect(f.observer.observation().tracked).toBe(3); noFurtherQueries(f); expect(closed(f)).toEqual([CHILD, AUX]);
  });
});
