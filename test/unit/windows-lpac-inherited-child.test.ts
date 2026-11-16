/** Portable FFI and fixed-source contracts; actual inherited LPAC compatibility requires the separate Windows job. */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bindInheritedChildObserver, INHERITED_CHILD_FUNCTIONS, InheritedChildCleanupError,
  inheritedChildNumericFailure, inheritedChildCompilerFailure, inheritedChildVisualStudioRange, inheritedChildLifecycleDiagnostics,
  INHERITED_CHILD_VARIANTS, INHERITED_CHILD_UNCERTAIN_CLEANUP_EXIT, inheritedChildReadout, inheritedChildVariantDefine, inheritedChildSuppliedSdDiagnostic,
  type InheritedChildAdmission, type InheritedChildFence, type InheritedChildLifecyclePhase } from "../fixtures/windows-lpac-inherited-child";

describe("inherited-child closed setup diagnostics", () => {
  it("isolates every fixed creation selector without combining the security/console comparisons", () => {
    expect(INHERITED_CHILD_VARIANTS).toEqual(["explicit", "inherited", "aap-only", "aap-null-sa", "aap-detached", "aap-inherit-console"]);
    expect(inheritedChildVariantDefine("explicit")).toBe(""); expect(inheritedChildVariantDefine("inherited")).toBe("");
    expect(inheritedChildVariantDefine("aap-only")).toBe("/DEMBER_LPAC_CHILD_AAP_ONLY=1");
    expect(inheritedChildVariantDefine("aap-null-sa")).toBe("/DEMBER_LPAC_CHILD_AAP_ONLY=1 /DEMBER_LPAC_CHILD_NULL_SECURITY=1");
    expect(inheritedChildVariantDefine("aap-detached")).toBe("/DEMBER_LPAC_CHILD_AAP_ONLY=1 /DEMBER_LPAC_CHILD_DETACHED=1");
    expect(inheritedChildVariantDefine("aap-inherit-console")).toBe("/DEMBER_LPAC_CHILD_AAP_ONLY=1 /DEMBER_LPAC_CHILD_INHERIT_CONSOLE=1");
    for (const value of [null, {}, "aap-only /DPRIVATE=1", "other"]) expect(() => inheritedChildVariantDefine(value)).toThrow("fixed reviewed");
  });
  it("never publishes an explicit-supplied-DACL observation for the NULL-security or original-source paths", () => {
    expect(INHERITED_CHILD_VARIANTS.map(inheritedChildSuppliedSdDiagnostic)).toEqual([false, true, true, false, true, true]);
  });
  it.each([31, NaN, -1, 0x100000000])("fences terminal/unknown C cleanup before invoking any payload reader (%s)", code => {
    const read = vi.fn(() => "synthetic private payload");
    expect(INHERITED_CHILD_UNCERTAIN_CLEANUP_EXIT).toBe(31);
    expect(() => inheritedChildReadout(code, read)).toThrow(InheritedChildCleanupError); expect(read).not.toHaveBeenCalled();
  });
  it.each([0, 18, 30, 32])("keeps ordinary stopped C outcomes available for explicit assertions (%s)", code => {
    const read = vi.fn(() => 42); expect(inheritedChildReadout(code, read)).toBe(42); expect(read).toHaveBeenCalledOnce();
  });
  it("accepts only the two reviewed compiler image ranges", () => {
    expect(inheritedChildVisualStudioRange(undefined)).toBe("[17.0,18.0)");
    expect(inheritedChildVisualStudioRange("windows-2022")).toBe("[17.0,18.0)");
    expect(inheritedChildVisualStudioRange("windows-2025")).toBe("[18.0,19.0)");
    expect(() => inheritedChildVisualStudioRange("private image name")).toThrow("fixed reviewed");
  });
  it("emits only fixed numeric domains for known Node, Win32 and HRESULT errors", () => {
    expect(inheritedChildNumericFailure(Object.assign(new Error("C:\\private\\secret"), { code: "EACCES" }))).toEqual({ domain: 1, code: 1 });
    expect(inheritedChildNumericFailure(new Error("CreateFileW(directory) failed (Windows error 5)."))).toEqual({ domain: 2, code: 5 });
    expect(inheritedChildNumericFailure(new Error("CreateAppContainerProfile failed (HRESULT 2147942405); no profile is adopted."))).toEqual({ domain: 3, code: 2147942405 });
    expect(inheritedChildNumericFailure(new Error("GetAppContainerFolderPath failed (HRESULT 2147942402)."))).toEqual({ domain: 3, code: 2147942402 });
    expect(inheritedChildNumericFailure(new Error("GetTokenInformation(1) failed (Windows error 122)."))).toEqual({ domain: 2, code: 122 });
  });
  it.each([
    null, "private text", new Error("private path failed (Windows error 5)."),
    new Error("CreateDirectoryW failed (Windows error 4294967296)."), new Error("CreateDirectoryW failed (Windows error 0005)."),
    Object.assign(new Error("private environment"), { code: "private errno" }), new Error("CreateDirectoryW failed (Windows error 5). C:\\private"),
  ])("refuses unrecognized, out-of-range or text-bearing diagnostics without disclosure (%#)", error => {
    expect(inheritedChildNumericFailure(error)).toEqual({ domain: 0, code: 0 });
  });
  it("extracts only bounded fixed compiler error numbers from private output", () => {
    expect(inheritedChildCompilerFailure("C:\\private\\secret.c(4): error C2065: secret" )).toEqual({ domain: 4, code: 2065 });
    expect(inheritedChildCompilerFailure("LINK : fatal error LNK2019: secret" )).toEqual({ domain: 5, code: 2019 });
    expect(inheritedChildCompilerFailure("private error C12345: extra digit" )).toEqual({ domain: 0, code: 0 });
    expect(inheritedChildCompilerFailure("private non-compiler text" )).toEqual({ domain: 0, code: 0 });
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9] as const)("captures uncertain host phase %s without exposing error payloads", phase => {
    const diagnostics = inheritedChildLifecycleDiagnostics();
    const error = Object.assign(new Error("C:\\private\\payload", { cause: { token: "private" } }), { code: "EACCES" });
    diagnostics.capture(phase, 5, error);
    expect(diagnostics.observation()).toEqual({ phase, hostOperation: 5, domain: 1, code: 1 });
    expect(JSON.stringify(diagnostics.observation())).not.toMatch(/private|payload|token|cause/);
  });
  it("preserves the first uncertain failure without inspecting later errors or mutable receipt references", () => {
    const diagnostics = inheritedChildLifecycleDiagnostics(), inspected = vi.fn(() => { throw new Error("private getter"); });
    diagnostics.capture(3, 4, new Error("CloseHandle failed (Windows error 6)."));
    const later = new Error("private" ); Object.defineProperty(later, "code", { get: inspected });
    diagnostics.capture(9, 6, later);
    const copy = diagnostics.observation(); copy.code = 0;
    expect(diagnostics.observation()).toEqual({ phase: 3, hostOperation: 4, domain: 2, code: 6 });
    expect(inspected).not.toHaveBeenCalled();
  });
  it.each([[NaN, 5, 0, 5], [10, 5, 0, 5], [1, -1, 1, 0], [1, Infinity, 1, 0]])("closes invalid host lifecycle metadata to zero (%s, %s)", (phase, operation, expectedPhase, expectedOperation) => {
    const diagnostics = inheritedChildLifecycleDiagnostics();
    diagnostics.capture(phase as InheritedChildLifecyclePhase, operation, new Error("unclassified private native text"));
    expect(diagnostics.observation()).toEqual({ phase: expectedPhase, hostOperation: expectedOperation, domain: 0, code: 0 });
  });
});

const JOB = 10n, ROOT = 20n, CHILD = 30n, AUX = 40n, ROOT_PID = 400, CHILD_PID = 500, AUX_PID = 600;
const IMAGE = "C:\\private\\tools\\fixture.exe";
type Call = { name: string; args: unknown[] };
type Fault = "query-false" | "query-abi" | "query-throw" | "assigned" | "overflow" | "partial" | "pid-zero" | "pid-large" | "duplicate" |
  "open-null" | "open-zero" | "open-abi" | "open-invalid" | "open-root" | "open-job" | "open-throw" | "open-alias" |
  "pid-mismatch" | "pid-throw" | "image-false" | "image-abi" | "image-empty" | "image-overflow" | "image-mismatch" | "image-throw" |
  "image-extended" | "image-console" | "image-native" | "image-short" | "image-length-abi" | "duplicate-candidate" |
  "job-false" | "job-abi" | "job-no" | "job-output-abi" | "job-throw" | "close-false" | "close-abi" | "close-throw" |
  "wait-failed" | "wait-abi" | "wait-throw" | "active-after-stop";
function setup(selectedFault?: Fault, initial: number[][] = [[ROOT_PID, CHILD_PID]], lastError: unknown = 5) {
  let fault = selectedFault, lists = initial, queries = 0, current = true, stopped = false, rootExited = false;
  const dead = new Set<number>(), forceAlive = new Set<number>(), images = new Map<number, string>();
  const calls: Call[] = [], buffers: Buffer[] = [], events: string[] = [];
  const fence: InheritedChildFence = { retained: [] };
  const processHandle = (id: number) => id === CHILD_PID ? CHILD : id === AUX_PID ? AUX : BigInt(id + 10_000);
  const processId = (handle: unknown) => handle === CHILD ? CHILD_PID : handle === AUX ? AUX_PID : Number(handle) - 10_000;
  const invoke = (name: string, args: unknown[]): unknown => {
    calls.push({ name, args }); events.push(name);
    if (name === "GetLastError") { if (lastError instanceof Error) throw lastError; return lastError; }
    if (name === "QueryInformationJobObject") {
      const bytes = args[2] as Buffer; buffers.push(bytes);
      if (fault === "query-throw") throw new Error("private native query text");
      if (fault === "query-false") return 0; if (fault === "query-abi") return true;
      if (args[1] === 1) { bytes.writeUInt32LE(fault === "active-after-stop" ? 1 : stopped ? 0 : 2, 40); return 1; }
      const found = stopped ? [] : lists[Math.min(queries++, lists.length - 1)];
      bytes.writeUInt32LE(fault === "assigned" ? found.length + 1 : fault === "overflow" ? 9 : fault === "partial" ? 3 : found.length, 0);
      bytes.writeUInt32LE(fault === "overflow" ? 9 : found.length, 4);
      for (let index = 0; index < Math.min(found.length, 8); index++) bytes.writeBigUInt64LE(
        fault === "pid-zero" ? 0n : fault === "pid-large" ? 0x100000000n : fault === "duplicate" ? 400n : BigInt(found[index]), 8 + index * 8);
      return 1;
    }
    if (name === "OpenProcess") {
      if (fault === "open-throw") throw new Error("unknown open completion");
      return fault === "open-null" ? null : fault === "open-zero" ? 0n : fault === "open-abi" ? 30 : fault === "open-invalid" ? 0xffffffffffffffffn :
        fault === "open-root" ? ROOT : fault === "open-job" ? JOB : fault === "open-alias" ? CHILD : processHandle(args[2] as number);
    }
    if (name === "WaitForSingleObject") {
      if (fault === "wait-throw") throw new Error("private wait text");
      if (fault === "wait-failed") return 0xffffffff; if (fault === "wait-abi") return true;
      if (forceAlive.has(args[0] === ROOT ? ROOT_PID : processId(args[0]))) return 258;
      return stopped || (args[0] === ROOT ? rootExited : dead.has(processId(args[0]))) ? 0 : 258;
    }
    if (name === "GetProcessId") {
      if (fault === "pid-throw") throw new Error("private native identity text");
      return fault === "pid-mismatch" ? 123 : processId(args[0]);
    }
    if (name === "QueryFullProcessImageNameW") {
      const bytes = args[2] as Buffer, size = args[3] as unknown[]; buffers.push(bytes);
      if (fault === "image-throw") throw new Error("private native path text");
      if (fault === "image-false") return 0; if (fault === "image-abi") return "success";
      const actual = fault === "image-mismatch" ? "C:\\other\\fixture.exe" : fault === "image-extended" ? "\\\\?\\" + IMAGE :
        fault === "image-console" ? "C:\\Windows\\System32\\conhost.exe" : fault === "image-native" ? "\\Device\\HarddiskVolume3\\private\\tools\\fixture.exe" :
        fault === "image-short" ? "C:\\PRIVAT~1\\tools\\fixture.exe" : images.get(processId(args[0])) ??
        (fault === "duplicate-candidate" || args[0] === CHILD ? IMAGE.toUpperCase() : "C:\\Windows\\System32\\conhost.exe");
      Buffer.from(actual, "utf16le").copy(bytes); size[0] = fault === "image-empty" ? 0 : fault === "image-overflow" ? 32768 : fault === "image-length-abi" ? true : actual.length;
      return 1;
    }
    if (name === "IsProcessInJob") {
      if (fault === "job-throw") throw new Error("private job text");
      (args[2] as unknown[])[0] = fault === "job-no" ? 0 : fault === "job-output-abi" ? true : 1;
      return fault === "job-false" ? 0 : fault === "job-abi" ? true : 1;
    }
    if (name === "CloseHandle") {
      if (fault === "close-throw") throw new Error("unknown close completion");
      return fault === "close-false" ? 0 : fault === "close-abi" ? true : 1;
    }
    throw new Error("No other native operation is admitted by this mock.");
  };
  const load = vi.fn((_name: string) => ({ func: vi.fn((prototype: string) => {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => invoke(name, args);
  }) }));
  const observer = bindInheritedChildObserver({ sizeof: () => 8 }, load, fence);
  const verifyToken = vi.fn((_process: bigint) => { events.push("verifyToken"); });
  const grant = vi.fn((_pid: number) => { events.push("grant"); });
  const input: InheritedChildAdmission = { job: JOB, rootProcess: ROOT, rootPid: ROOT_PID, image: IMAGE,
    current: vi.fn(() => { events.push("current"); return current; }), verifyToken, grant };
  return { observer, input, verifyToken, grant, load, fence, calls, buffers, events,
    revoke() { current = false; }, repair() { fault = undefined; }, fault(value: Fault) { fault = value; },
    lists(value: number[][]) { lists = value; queries = 0; }, dead(id: number) { dead.add(id); },
    keepAlive(id: number) { forceAlive.add(id); }, releaseAlive(id: number) { forceAlive.delete(id); },
    image(id: number, value: string) { images.set(id, value); },
    rootExit(value: number[] = [CHILD_PID, AUX_PID]) { rootExited = true; lists = [value]; queries = 0; },
    stop() { stopped = true; rootExited = true; },
    finish() { fault = undefined; stopped = true; rootExited = true; observer.requireStopped(); observer.closeStopped(); },
  };
}
const closed = (f: ReturnType<typeof setup>) => f.calls.filter(call => call.name === "CloseHandle").map(call => call.args[0]);

describe("bounded inherited-child member owner", () => {
  it("binds only eight fixed query/synchronization/close functions under x64", () => {
    const f = setup(); expect(f.load).toHaveBeenCalledExactlyOnceWith("kernel32.dll"); expect(INHERITED_CHILD_FUNCTIONS).toHaveLength(8);
    expect(() => bindInheritedChildObserver({ sizeof: () => 4 }, f.load)).toThrow();
    expect(() => bindInheritedChildObserver({ sizeof: () => 8 }, () => ({ func: () => 1 }))).toThrow();
  });
  it("bounds complete process lists to eight pointer-width entries and clears buffers", () => {
    const f = setup(undefined, [[1, 2, 3, 4, 5, 6, 7, 8]]); expect(f.observer.members(JOB)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.calls[0].args).toEqual([JOB, 3, expect.any(Buffer), 72, null]); expect(f.buffers.every(b => b.every(v => v === 0))).toBe(true);
  });
  it.each(["query-false", "query-abi", "query-throw", "assigned", "overflow", "partial", "pid-zero", "pid-large", "duplicate"] as const)("refuses incomplete or invalid native process lists (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow(); expect(f.grant).not.toHaveBeenCalled();
    expect(closed(f)).toEqual([]); f.finish(); expect(closed(f)).toEqual([]);
  });
  it("waits with only root and never opens or grants an auxiliary as the intended child", () => {
    const f = setup(undefined, [[ROOT_PID]]); expect(f.observer.admit(f.input)).toBeNull();
    f.lists([[ROOT_PID, AUX_PID]]); expect(f.observer.admit(f.input)).toBeNull();
    expect(f.verifyToken).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); expect(closed(f)).toEqual([]);
    f.finish(); expect(closed(f)).toEqual([AUX]);
  });
  it("selects one exact-image candidate across contained auxiliaries and retains every handle through Stop", () => {
    const f = setup(undefined, [[ROOT_PID, AUX_PID, CHILD_PID]]); expect(f.observer.admit(f.input)).toBe(CHILD_PID);
    expect(f.verifyToken).toHaveBeenCalledExactlyOnceWith(CHILD); expect(f.grant).toHaveBeenCalledExactlyOnceWith(CHILD_PID);
    expect(f.calls.filter(c => c.name === "OpenProcess").map(c => c.args)).toEqual([[0x101000, 0, AUX_PID], [0x101000, 0, CHILD_PID]]);
    expect(f.calls.filter(c => c.name === "IsProcessInJob").every(c => c.args[1] === JOB)).toBe(true);
    expect(f.events.indexOf("verifyToken")).toBeLessThan(f.events.indexOf("grant")); expect(closed(f)).toEqual([]);
    expect(() => f.observer.requireStopped()).toThrow(); expect(() => f.observer.closeStopped()).toThrow(); expect(closed(f)).toEqual([]);
    f.finish(); expect(closed(f)).toEqual([AUX, CHILD]); f.observer.closeStopped(); expect(closed(f)).toEqual([AUX, CHILD]);
    expect(f.buffers.every(b => b.every(v => v === 0))).toBe(true);
  });
  it("retains a console helper observed before the candidate and reuses its owned handle on later polls", () => {
    const f = setup(undefined, [[ROOT_PID, AUX_PID]]); expect(f.observer.admit(f.input)).toBeNull();
    f.lists([[ROOT_PID, AUX_PID, CHILD_PID]]); expect(f.observer.admit(f.input)).toBe(CHILD_PID);
    expect(f.calls.filter(c => c.name === "OpenProcess")).toHaveLength(2); f.finish(); expect(closed(f)).toEqual([AUX, CHILD]);
  });
  it.each([{ found: [] }, { found: [CHILD_PID] }])("requires the exact root in every admission snapshot (%j)", ({ found }) => {
    const f = setup(undefined, [found]); expect(() => f.observer.admit(f.input)).toThrow(); expect(f.grant).not.toHaveBeenCalled();
  });
  it("refuses multiple expected-image candidates even when an auxiliary has a trusted-looking basename", () => {
    const f = setup("duplicate-candidate", [[ROOT_PID, CHILD_PID, AUX_PID]]); expect(() => f.observer.admit(f.input)).toThrow();
    expect(f.verifyToken).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); f.finish(); expect(closed(f)).toEqual([CHILD, AUX]);
  });
  it("rechecks candidates after token verification instead of accepting a new duplicate image", () => {
    const f = setup(undefined, [[ROOT_PID, CHILD_PID, AUX_PID]]); f.input.verifyToken = () => f.image(AUX_PID, IMAGE);
    expect(() => f.observer.admit(f.input)).toThrow(); expect(f.grant).not.toHaveBeenCalled(); f.finish();
  });
  it("waits for stable complete membership, accounts for a newly arrived helper, then grants once", () => {
    const f = setup(undefined, [[ROOT_PID, CHILD_PID], [ROOT_PID, CHILD_PID, AUX_PID]]);
    expect(f.observer.admit(f.input)).toBeNull(); expect(f.grant).not.toHaveBeenCalled();
    expect(f.observer.admit(f.input)).toBe(CHILD_PID); expect(f.grant).toHaveBeenCalledOnce(); f.finish();
  });
  it("rejects a previously observed live member missing from the owned job instead of losing its stop obligation", () => {
    const f = setup(undefined, [[ROOT_PID, AUX_PID]]); expect(f.observer.admit(f.input)).toBeNull();
    f.lists([[ROOT_PID, CHILD_PID]]); expect(() => f.observer.admit(f.input)).toThrow(); expect(f.grant).not.toHaveBeenCalled(); f.finish();
  });
  it("permits an exited helper to leave the snapshot but refuses reuse of its signalled object for a listed PID", () => {
    const f = setup(undefined, [[ROOT_PID, AUX_PID]]); expect(f.observer.admit(f.input)).toBeNull(); f.dead(AUX_PID);
    f.lists([[ROOT_PID, CHILD_PID]]); expect(f.observer.admit(f.input)).toBe(CHILD_PID); f.finish();
    const g = setup(undefined, [[ROOT_PID, AUX_PID]]); expect(g.observer.admit(g.input)).toBeNull(); g.dead(AUX_PID);
    g.lists([[ROOT_PID, AUX_PID, CHILD_PID]]); expect(() => g.observer.admit(g.input)).toThrow(); expect(g.grant).not.toHaveBeenCalled(); g.finish();
  });
  it.each(["open-null", "open-zero"] as const)("captures ordinary OpenProcess refusal without inventing an owner (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow(); expect(f.observer.observation()).toMatchObject({ operation: 7, domain: 2, code: 5 });
    expect(f.fence.retained).toEqual([]); f.finish(); expect(closed(f)).toEqual([]);
  });
  it.each(["open-abi", "open-invalid", "open-root", "open-job", "open-throw"] as const)("retains unknown acquisition and never closes borrowed handles (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow(InheritedChildCleanupError); expect(closed(f)).toEqual([]);
    expect(f.fence.retained).toHaveLength(1); const count = f.calls.length; f.stop(); f.repair();
    expect(() => f.observer.closeStopped()).toThrow(InheritedChildCleanupError); expect(() => f.observer.members(JOB)).toThrow(); expect(f.calls).toHaveLength(count);
  });
  it("rejects a new process handle that aliases another retained member", () => {
    const f = setup("open-alias", [[ROOT_PID, CHILD_PID, AUX_PID]]); expect(() => f.observer.admit(f.input)).toThrow(InheritedChildCleanupError);
    expect(f.grant).not.toHaveBeenCalled(); expect(closed(f)).toEqual([]); expect(f.fence.retained).toHaveLength(1);
  });
  it.each(["pid-mismatch", "pid-throw", "image-false", "image-abi", "image-empty", "image-overflow", "image-length-abi", "image-throw", "job-false", "job-abi", "job-no", "job-output-abi", "job-throw", "wait-failed", "wait-abi", "wait-throw"] as const)("keeps a known process owned after query refusal and closes it only after verified Stop (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow(); expect(closed(f)).toEqual([]); expect(f.grant).not.toHaveBeenCalled();
    f.finish(); expect(closed(f)).toEqual([CHILD]); expect(f.fence.retained).toEqual([]);
  });
  it.each(["image-mismatch", "image-extended", "image-console", "image-native", "image-short"] as const)("never gives candidate authority to a mismatched image (%s)", fault => {
    const f = setup(fault); expect(f.observer.admit(f.input)).toBeNull(); expect(f.verifyToken).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled();
    expect(f.observer.observation().image?.exact).toBe(false); expect(JSON.stringify(f.observer.observation())).not.toMatch(/private|Harddisk|System32|conhost|fixture|C:/i); f.finish();
  });
  it.each([true, -1, 0x100000000, NaN, new Error("private TLS error text")])("keeps unknown native error metadata unclassified (%#)", value => {
    const f = setup("query-false", undefined, value); expect(() => f.observer.admit(f.input)).toThrow();
    expect(f.observer.observation()).toMatchObject({ operation: 3, domain: 0, code: 0 });
  });
  it("does not grant on stale, failed or asynchronous trusted callbacks", () => {
    for (const key of ["current", "verifyToken", "grant"] as const) {
      const f = setup(); f.input[key] = (() => Promise.resolve()) as never; // Deliberately violate the synchronous callback contract.
      expect(() => f.observer.admit(f.input)).toThrow(); if (key !== "grant") expect(f.grant).not.toHaveBeenCalled(); f.finish();
    }
    const f = setup(); f.revoke(); expect(() => f.observer.admit(f.input)).toThrow(); expect(f.calls).toEqual([]);
  });
  it.each(["current", "verifyToken", "grant"] as const)("retains typed cleanup uncertainty from %s without closing known live handles", key => {
    const f = setup(); f.input[key] = () => { throw new InheritedChildCleanupError(); };
    expect(() => f.observer.admit(f.input)).toThrow(InheritedChildCleanupError); expect(f.fence.retained).toHaveLength(1); expect(closed(f)).toEqual([]);
  });
  it("binds one exact root/job/image tuple and cannot grant twice or adopt another owner's job", () => {
    const f = setup(); expect(f.observer.admit(f.input)).toBe(CHILD_PID);
    expect(() => f.observer.admit(f.input)).toThrow(); expect(() => f.observer.members(11n)).toThrow(); expect(f.grant).toHaveBeenCalledOnce(); f.finish();
    const g = setup(undefined, [[ROOT_PID]]); expect(g.observer.admit(g.input)).toBeNull();
    expect(() => g.observer.admit({ ...g.input, job: 11n })).toThrow(); g.finish();
  });
  it("requires the admitted child to outlive root, includes new auxiliaries and independently witnesses every retained handle stopped", () => {
    const f = setup(); expect(f.observer.admit(f.input)).toBe(CHILD_PID); f.rootExit(); expect(f.observer.observeDescendants()).toBe(true);
    expect(f.calls.filter(c => c.name === "OpenProcess")).toHaveLength(2); expect(() => f.observer.requireStopped()).toThrow(); expect(closed(f)).toEqual([]);
    f.finish(); expect(closed(f)).toEqual([CHILD, AUX]);
    const waits = f.calls.filter(c => c.name === "WaitForSingleObject"); expect(waits.every(c => c.args[1] === 0)).toBe(true);
    expect(waits.some(c => c.args[0] === ROOT)).toBe(true); expect(waits.some(c => c.args[0] === AUX)).toBe(true);
  });
  it("does not infer complete Stop from empty process lists when native active accounting is nonzero", () => {
    const f = setup(); expect(f.observer.admit(f.input)).toBe(CHILD_PID); f.stop(); f.fault("active-after-stop");
    expect(() => f.observer.closeStopped()).toThrow(); expect(closed(f)).toEqual([]); f.finish();
  });
  it("refuses the intended-child survival proof when it exits while a contained auxiliary remains alive", () => {
    const f = setup(); expect(f.observer.admit(f.input)).toBe(CHILD_PID); f.rootExit();
    expect(f.observer.observeDescendants()).toBe(true);
    f.dead(CHILD_PID); f.lists([[AUX_PID]]);
    expect(f.observer.observeDescendants()).toBe(false); expect(() => f.observer.requireStopped()).toThrow(); expect(closed(f)).toEqual([]);
    f.finish(); expect(closed(f)).toEqual([CHILD, AUX]);
  });
  it.each([ROOT_PID, CHILD_PID, AUX_PID])("requires each retained process object signalled even when native job accounting is empty (%s)", id => {
    const f = setup(undefined, [[ROOT_PID, CHILD_PID, AUX_PID]]); expect(f.observer.admit(f.input)).toBe(CHILD_PID);
    f.stop(); f.keepAlive(id); expect(() => f.observer.requireStopped()).toThrow(); expect(() => f.observer.closeStopped()).toThrow(); expect(closed(f)).toEqual([]);
    f.releaseAlive(id); f.finish(); expect(closed(f)).toEqual([CHILD, AUX]);
  });
  it("bounds retained members across their whole lifetime, including exited auxiliaries", () => {
    const ids = [600, 601, 602, 603, 604, 605, 606], f = setup(undefined, [[ROOT_PID, ...ids]]);
    expect(f.observer.admit(f.input)).toBeNull(); for (const id of ids) f.dead(id);
    f.lists([[ROOT_PID, CHILD_PID]]); expect(() => f.observer.admit(f.input)).toThrow(); expect(f.grant).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.name === "OpenProcess")).toHaveLength(7); f.finish(); expect(closed(f)).toHaveLength(7);
  });
  it("refuses lost authority or changed expected image after the token witness", () => {
    for (const change of ["currency", "image"] as const) {
      const f = setup(); f.input.verifyToken = () => { if (change === "currency") f.revoke(); else f.image(CHILD_PID, "C:\\other\\fixture.exe"); };
      expect(() => f.observer.admit(f.input)).toThrow(); expect(f.grant).not.toHaveBeenCalled(); f.finish();
    }
  });
  it.each([
    { fault: "query-false", native: "QueryInformationJobObject" }, { fault: "open-null", native: "OpenProcess" },
    { fault: "image-false", native: "QueryFullProcessImageNameW" }, { fault: "job-false", native: "IsProcessInJob" }, { fault: "wait-failed", native: "WaitForSingleObject" },
  ] as const)("captures explicit failure metadata immediately before cleanup or another native query ($fault)", ({ fault, native }) => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow(); const index = f.calls.findIndex(c => c.name === "GetLastError");
    expect(index).toBeGreaterThan(0); expect(f.calls[index - 1].name).toBe(native); expect(f.observer.observation()).toMatchObject({ domain: 2, code: 5 }); f.finish();
  });
  it.each(["close-false", "close-abi", "close-throw"] as const)("attempts each known stopped handle once and fences unknown cleanup permanently (%s)", fault => {
    const f = setup(undefined, [[ROOT_PID, CHILD_PID, AUX_PID]]); expect(f.observer.admit(f.input)).toBe(CHILD_PID); f.stop(); f.fault(fault);
    expect(() => f.observer.closeStopped()).toThrow(InheritedChildCleanupError); expect(closed(f)).toEqual([CHILD, AUX]); expect(f.fence.retained).toHaveLength(1);
    f.repair(); expect(() => f.observer.closeStopped()).toThrow(InheritedChildCleanupError); expect(closed(f)).toEqual([CHILD, AUX]);
  });
  it("rejects invalid borrowed contracts before native acquisition", () => {
    const f = setup();
    for (const changed of [{ job: 0n }, { rootProcess: JOB }, { rootPid: 0 }, { rootPid: 0x100000000 }, { image: "\\\\server\\share\\fixture.exe" }, { image: "C:\\private\nfixture.exe" }])
      expect(() => f.observer.admit({ ...f.input, ...changed })).toThrow();
    expect(f.calls).toEqual([]); expect(f.grant).not.toHaveBeenCalled();
  });
});

describe("separate fixed inherited-child C fixture", () => {
  const original = fs.readFileSync(new URL("../fixtures/experimental-windows-lpac.c", import.meta.url), "utf8");
  const inherited = fs.readFileSync(new URL("../fixtures/experimental-windows-lpac-inherited.c", import.meta.url), "utf8");
  const main = "void __cdecl mainCRTStartup(void)\n";
  const gate = "    if (!awaitInheritedChildAdmission(child.dwProcessId, &error)) { recordFailure(29, error); endUnexpectedChild(&child); ExitProcess(29); }\n";
  it("preserves every original main assertion and operation except the two named spawn calls and explicit admission gate", () => {
    expect(inherited).toContain('#define mainCRTStartup explicitAttributesControlMain\n#include "experimental-windows-lpac.c"\n#undef mainCRTStartup');
    const body = inherited.slice(inherited.indexOf(main));
    expect(body.match(/spawnInherited\(/g)).toHaveLength(2); expect(body.split(gate)).toHaveLength(2);
    expect(body.replace(gate, "").replaceAll("spawnInherited(", "spawnChild(")).toBe(original.slice(original.indexOf(main)));
    expect(body.indexOf("confinedChild(child.hProcess)")).toBeLessThan(body.indexOf("awaitInheritedChildAdmission(child.dwProcessId"));
    expect(body.indexOf("awaitInheritedChildAdmission(child.dwProcessId")).toBeLessThan(body.indexOf("ResumeThread(child.hThread)"));
  });
  it("uses plain inherited-token creation without capabilities, policy overrides or inherited handles", () => {
    const wrapper = inherited.slice(inherited.indexOf("static BOOL spawnInherited("), inherited.indexOf("static BOOL awaitInheritedChildAdmission("));
    const spawn = wrapper.slice(wrapper.indexOf("#else\n"), wrapper.lastIndexOf("#endif"));
    expect(spawn).toContain("STARTUPINFOW startup;"); expect(spawn).toContain("startup.cb = sizeof(startup);");
    expect(spawn).toContain("CreateProcessW(selfPath, commandLine, &childAttributes, &childAttributes, FALSE,");
    expect(spawn).toContain("flags | CREATE_NO_WINDOW | CREATE_SUSPENDED,"); expect(spawn).toContain("NULL, NULL, &startup, process);");
    expect(spawn).not.toMatch(/STARTUPINFOEX|EXTENDED_STARTUPINFO|SECURITY_CAPABILITIES|UpdateProcThreadAttribute|SetTokenInformation|CREATE_BREAKAWAY_FROM_JOB/);
    const body = inherited.slice(inherited.indexOf(main)); expect(body).toContain("spawnInherited(CREATE_BREAKAWAY_FROM_JOB, &unexpected, &error)");
    expect(body).toContain("spawnInherited(0, &child, &error)");
  });
  it("adds exactly one AAP opt-out attribute in its separate fixed branch while preserving token/flags/security", () => {
    const wrapper = inherited.slice(inherited.indexOf("static BOOL spawnInherited("), inherited.indexOf("static BOOL awaitInheritedChildAdmission("));
    const policy = wrapper.slice(wrapper.indexOf("#if EMBER_LPAC_CHILD_AAP_ONLY"), wrapper.indexOf("#else\n"));
    expect(inherited).toContain("#define EMBER_LPAC_CHILD_AAP_ONLY 0");
    expect(inherited).toContain("#if EMBER_LPAC_CHILD_AAP_ONLY != 0 && EMBER_LPAC_CHILD_AAP_ONLY != 1");
    expect(policy).toContain("STARTUPINFOEXW startup;"); expect(policy).toContain("DWORD policy = 1;");
    expect(policy.match(/UpdateProcThreadAttribute\(/g)).toHaveLength(1);
    expect(policy).toContain("InitializeProcThreadAttributeList(NULL, 1, 0, &bytes)");
    expect(policy).toContain("InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)");
    expect(policy).toContain("UpdateProcThreadAttribute(startup.lpAttributeList, 0, (DWORD_PTR)0x2000f,");
    expect(policy).toContain("&policy, sizeof(policy), NULL, NULL)");
    expect(policy).toContain("SECURITY_ATTRIBUTES *processSecurity = &childAttributes, *threadSecurity = &childAttributes;");
    expect(policy).toContain("DWORD childConsoleFlags = CREATE_NO_WINDOW;");
    expect(policy).toContain("CreateProcessW(selfPath, commandLine, processSecurity, threadSecurity, FALSE,");
    expect(policy).toContain("flags | childConsoleFlags | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,");
    expect(policy).toContain("NULL, NULL, &startup.StartupInfo, process)");
    expect(policy).not.toMatch(/SECURITY_CAPABILITIES|AppContainerSid|SetTokenInformation|CreateRestrictedToken|CHILD_PROCESS_OVERRIDE|SetSecurity/);
    expect(policy.match(/if \(LocalFree\(startup\.lpAttributeList\) != NULL\)/g)).toHaveLength(3);
  });
  it("changes only the selected object-security or child-console input in its mutually exclusive variants", () => {
    const wrapper = inherited.slice(inherited.indexOf("static BOOL spawnInherited("), inherited.indexOf("static BOOL awaitInheritedChildAdmission("));
    const policy = wrapper.slice(wrapper.indexOf("#if EMBER_LPAC_CHILD_AAP_ONLY"), wrapper.indexOf("#else\n"));
    const nullSecurity = policy.slice(policy.indexOf("#if EMBER_LPAC_CHILD_NULL_SECURITY"), policy.indexOf("#endif"));
    expect(nullSecurity).toBe("#if EMBER_LPAC_CHILD_NULL_SECURITY\n    processSecurity = NULL;\n    threadSecurity = NULL;\n");
    const detached = policy.slice(policy.indexOf("#if EMBER_LPAC_CHILD_DETACHED"), policy.indexOf("#endif", policy.indexOf("#if EMBER_LPAC_CHILD_DETACHED")));
    expect(detached).toBe("#if EMBER_LPAC_CHILD_DETACHED\n    childConsoleFlags = DETACHED_PROCESS;\n");
    expect(inherited).toContain("#if EMBER_LPAC_CHILD_NULL_SECURITY && EMBER_LPAC_CHILD_DETACHED");
    expect(inherited).toContain("#if (EMBER_LPAC_CHILD_NULL_SECURITY || EMBER_LPAC_CHILD_DETACHED) && !EMBER_LPAC_CHILD_AAP_ONLY");
    expect(policy).toContain("#if !EMBER_LPAC_CHILD_NULL_SECURITY\n    if (!created && flags == 0) writeChildSdAccessDiagnostic();\n#endif");
    expect(policy).not.toMatch(/CREATE_NEW_CONSOLE|CREATE_NEW_PROCESS_GROUP|SetTokenInformation|SetSecurityInfo/);
  });
  it("drops only the child console modifier for its independent inherited-console comparison", () => {
    const wrapper = inherited.slice(inherited.indexOf("static BOOL spawnInherited("), inherited.indexOf("static BOOL awaitInheritedChildAdmission("));
    const policy = wrapper.slice(wrapper.indexOf("#if EMBER_LPAC_CHILD_AAP_ONLY"), wrapper.indexOf("#else\n"));
    const selection = policy.slice(policy.indexOf("#if EMBER_LPAC_CHILD_INHERIT_CONSOLE"), policy.indexOf("#endif", policy.indexOf("#if EMBER_LPAC_CHILD_INHERIT_CONSOLE")));
    expect(selection).toBe("#if EMBER_LPAC_CHILD_INHERIT_CONSOLE\n    childConsoleFlags = 0;\n");
    expect(inherited).toContain("#if EMBER_LPAC_CHILD_INHERIT_CONSOLE && !EMBER_LPAC_CHILD_AAP_ONLY");
    expect(inherited).toContain("#if EMBER_LPAC_CHILD_INHERIT_CONSOLE && (EMBER_LPAC_CHILD_NULL_SECURITY || EMBER_LPAC_CHILD_DETACHED)");
    expect(policy).toContain("flags | childConsoleFlags | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,");
    expect(policy).toContain("NULL, NULL, &startup.StartupInfo, process)");
    expect(policy).not.toContain("CREATE_UNICODE_ENVIRONMENT"); // NULL child environment; the root's Unicode flag is separate and unchanged.
  });
  it("never returns a born child as a FALSE/expected-denial after attribute cleanup failure", () => {
    const wrapper = inherited.slice(inherited.indexOf("static BOOL spawnInherited("), inherited.indexOf("static BOOL awaitInheritedChildAdmission("));
    const policy = wrapper.slice(wrapper.indexOf("#if EMBER_LPAC_CHILD_AAP_ONLY"), wrapper.indexOf("#else\n"));
    const postCreate = policy.slice(policy.indexOf("created = CreateProcessW("));
    expect(postCreate).toContain("if (created) {");
    expect(postCreate).toContain("if (!stopAapCreatedChild(process, &stopped)) aapCreationRefusal(31, stopped);");
    expect(postCreate).toContain("aapCreationRefusal(30, failure);"); expect(postCreate).toContain("aapCreationRefusal(32, failure);");
    expect(postCreate).not.toContain("return FALSE"); expect(postCreate).toContain("return created;");
    const shutdown = inherited.slice(inherited.indexOf("static BOOL stopAapCreatedChild("), inherited.indexOf("static __declspec(noreturn) void aapCreationRefusal("));
    expect(shutdown).toContain("TerminateProcess(process->hProcess, 125)"); expect(shutdown).toContain("WaitForSingleObject(process->hProcess, 5000)");
    expect(shutdown).toContain("if (waited != WAIT_OBJECT_0)"); expect(shutdown).toContain("if (!CloseHandle(process->hThread))");
    expect(shutdown).toContain("if (!CloseHandle(process->hProcess))"); expect(shutdown).toContain("return failure == 0;");
    expect(inherited).toContain("static __declspec(noreturn) void aapCreationRefusal(DWORD stage, DWORD error)");
    expect(inherited).toContain("ExitProcess(stage);");
  });
  it("accepts only a bounded fresh ordinary exact-PID acknowledgement with EOF and checked close", () => {
    const admission = inherited.slice(inherited.indexOf("static BOOL awaitInheritedChildAdmission("), inherited.indexOf(main));
    expect(admission).toContain('pathFor(statePath, L"\\\\child-admit.bin")'); expect(admission).toContain("GetTickCount64() - started >= 10000");
    expect(admission).toContain("FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT"); expect(admission).toContain("GetFileType(file) != FILE_TYPE_DISK");
    expect(admission).toContain("before.nNumberOfLinks != 1"); expect(admission).toContain("before.nFileSizeLow != sizeof(admission)");
    expect(admission).toContain("admission[0] != 0x43495045u || admission[1] != childPid"); expect(admission).toContain("if (count != 0) goto closeAdmission;");
    expect(admission).toContain("if (!CloseHandle(file))"); expect(admission).not.toMatch(/WriteFile|SetSecurity|SetTokenInformation|ResumeThread/);
  });
});
