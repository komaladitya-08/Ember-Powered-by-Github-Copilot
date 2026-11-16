/** Portable FFI and fixed-source contracts; actual inherited LPAC compatibility requires the separate Windows job. */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bindInheritedChildObserver, INHERITED_CHILD_FUNCTIONS, InheritedChildCleanupError,
  type InheritedChildAdmission, type InheritedChildFence } from "../fixtures/windows-lpac-inherited-child";

const JOB = 10n, ROOT = 20n, CHILD = 30n, ROOT_PID = 400, CHILD_PID = 500;
const IMAGE = "C:\\private\\tools\\fixture.exe";
type Call = { name: string; args: unknown[] };
type Fault = "query-false" | "query-abi" | "query-throw" | "assigned" | "overflow" | "partial" | "pid-zero" | "pid-large" | "duplicate" |
  "open-null" | "open-zero" | "open-abi" | "open-invalid" | "open-root" | "open-job" | "open-throw" |
  "pid-mismatch" | "pid-throw" | "image-false" | "image-abi" | "image-empty" | "image-overflow" | "image-mismatch" | "image-throw" |
  "job-false" | "job-abi" | "job-no" | "job-output-abi" | "job-throw" | "close-false" | "close-abi" | "close-throw";
function setup(selectedFault?: Fault, lists: number[][] = [[ROOT_PID, CHILD_PID]]) {
  let fault = selectedFault, queries = 0, current = true;
  const calls: Call[] = [], buffers: Buffer[] = [], events: string[] = [];
  const fence: InheritedChildFence = { retained: [] };
  const invoke = (name: string, args: unknown[]): unknown => {
    calls.push({ name, args }); events.push(name);
    if (name === "QueryInformationJobObject") {
      const bytes = args[2] as Buffer; buffers.push(bytes);
      if (fault === "query-throw") throw new Error("private native query text");
      if (fault === "query-false") return 0;
      if (fault === "query-abi") return true;
      const found = lists[Math.min(queries++, lists.length - 1)];
      bytes.writeUInt32LE(fault === "assigned" ? found.length + 1 : fault === "overflow" ? 9 : fault === "partial" ? 3 : found.length, 0);
      bytes.writeUInt32LE(fault === "overflow" ? 9 : found.length, 4);
      for (let index = 0; index < Math.min(found.length, 8); index++) bytes.writeBigUInt64LE(
        fault === "pid-zero" ? 0n : fault === "pid-large" ? 0x100000000n : fault === "duplicate" ? 400n : BigInt(found[index]), 8 + index * 8);
      return 1;
    }
    if (name === "OpenProcess") {
      if (fault === "open-throw") throw new Error("unknown open completion");
      return fault === "open-null" ? null : fault === "open-zero" ? 0n : fault === "open-abi" ? 30 : fault === "open-invalid" ? 0xffffffffffffffffn :
        fault === "open-root" ? ROOT : fault === "open-job" ? JOB : CHILD;
    }
    if (name === "GetProcessId") {
      if (fault === "pid-throw") throw new Error("private native identity text");
      return fault === "pid-mismatch" ? CHILD_PID + 1 : CHILD_PID;
    }
    if (name === "QueryFullProcessImageNameW") {
      const bytes = args[2] as Buffer, size = args[3] as unknown[]; buffers.push(bytes);
      if (fault === "image-throw") throw new Error("private native path text");
      if (fault === "image-false") return 0;
      if (fault === "image-abi") return "success";
      const actual = fault === "image-mismatch" ? "C:\\other\\fixture.exe" : IMAGE.toUpperCase();
      Buffer.from(actual, "utf16le").copy(bytes); size[0] = fault === "image-empty" ? 0 : fault === "image-overflow" ? 32768 : actual.length;
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
    revoke() { current = false; }, repair() { fault = undefined; } };
}
function closed(f: ReturnType<typeof setup>): unknown[] { return f.calls.filter(call => call.name === "CloseHandle").map(call => call.args[0]); }

describe("inherited child native admission", () => {
  it("binds only six fixed kernel32 functions under the x64 ABI", () => {
    const f = setup(); expect(f.load).toHaveBeenCalledExactlyOnceWith("kernel32.dll");
    expect(INHERITED_CHILD_FUNCTIONS).toHaveLength(6);
    expect(() => bindInheritedChildObserver({ sizeof: () => 4 }, f.load, { retained: [] })).toThrow();
    expect(() => bindInheritedChildObserver({ sizeof: () => 8 }, () => ({ func: () => 1 }), { retained: [] })).toThrow();
  });
  it("bounds the complete job PID list to eight pointer-width entries and clears native buffers", () => {
    const f = setup(undefined, [[1, 2, 3, 4, 5, 6, 7, 8]]); expect(f.observer.members(JOB)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.calls[0].args).toEqual([JOB, 3, expect.any(Buffer), 72, null]);
    expect(f.buffers.every(bytes => bytes.every(value => value === 0))).toBe(true); expect(closed(f)).toEqual([]);
  });
  it.each(["query-false", "query-abi", "query-throw", "assigned", "overflow", "partial", "pid-zero", "pid-large", "duplicate"] as const)("refuses an incomplete or invalid native job list (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.members(JOB)).toThrow("fixed native admission");
    expect(f.buffers.every(bytes => bytes.every(value => value === 0))).toBe(true); expect(f.fence.failure).toBeUndefined();
    expect(f.grant).not.toHaveBeenCalled(); expect(closed(f)).toEqual([]);
  });
  it("waits without opening any process or granting when the job contains only its root", () => {
    const f = setup(undefined, [[ROOT_PID]]); expect(f.observer.admit(f.input)).toBeNull();
    expect(f.calls.map(call => call.name)).toEqual(["QueryInformationJobObject"]); expect(f.grant).not.toHaveBeenCalled();
  });
  it.each([{ found: [] }, { found: [CHILD_PID] }, { found: [ROOT_PID, CHILD_PID, 600] }])("refuses absent root or extra processes before opening a child ($found)", ({ found }) => {
    const f = setup(undefined, [found]); expect(() => f.observer.admit(f.input)).toThrow();
    expect(f.calls.every(call => call.name === "QueryInformationJobObject")).toBe(true); expect(f.grant).not.toHaveBeenCalled();
  });
  it("grants only after exact child PID, image, private job, synchronous token and final membership checks", () => {
    const f = setup(); expect(f.observer.admit(f.input)).toBe(CHILD_PID);
    expect(f.calls.find(call => call.name === "OpenProcess")?.args).toEqual([0x1000, 0, CHILD_PID]);
    expect(f.calls.find(call => call.name === "GetProcessId")?.args).toEqual([CHILD]);
    expect(f.calls.find(call => call.name === "QueryFullProcessImageNameW")?.args.slice(0, 2)).toEqual([CHILD, 0]);
    expect(f.calls.find(call => call.name === "IsProcessInJob")?.args.slice(0, 2)).toEqual([CHILD, JOB]);
    expect(f.verifyToken).toHaveBeenCalledExactlyOnceWith(CHILD); expect(f.grant).toHaveBeenCalledExactlyOnceWith(CHILD_PID);
    expect(f.events).toEqual(["current", "QueryInformationJobObject", "OpenProcess", "GetProcessId", "QueryFullProcessImageNameW", "IsProcessInJob",
      "verifyToken", "current", "QueryInformationJobObject", "grant", "CloseHandle"]);
    expect(closed(f)).toEqual([CHILD]); expect(f.fence.retained).toEqual([]);
    expect(f.buffers.every(bytes => bytes.every(value => value === 0))).toBe(true);
  });
  it.each(["open-null", "open-zero"] as const)("treats ordinary failed OpenProcess as refusal without a cleanup owner (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow("fixed native admission");
    expect(f.fence.failure).toBeUndefined(); expect(closed(f)).toEqual([]); expect(f.grant).not.toHaveBeenCalled();
    f.repair(); expect(f.observer.admit(f.input)).toBe(CHILD_PID);
  });
  it.each(["open-abi", "open-invalid", "open-root", "open-job", "open-throw"] as const)("retains unknown open ownership and never closes borrowed handles (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow(InheritedChildCleanupError);
    expect(closed(f)).toEqual([]); expect(f.fence.retained).toHaveLength(1); expect(f.grant).not.toHaveBeenCalled();
    const count = f.calls.length; f.repair(); expect(() => f.observer.members(JOB)).toThrow(f.fence.failure);
    expect(() => f.observer.admit(f.input)).toThrow(f.fence.failure); expect(f.calls).toHaveLength(count);
    expect(() => bindInheritedChildObserver({ sizeof: () => 8 }, f.load, f.fence)).toThrow(f.fence.failure);
  });
  it.each(["pid-mismatch", "pid-throw", "image-false", "image-abi", "image-empty", "image-overflow", "image-mismatch", "image-throw",
    "job-false", "job-abi", "job-no", "job-output-abi", "job-throw"] as const)("closes its known child once and refuses failed native identity/membership (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow("fixed native admission");
    expect(closed(f)).toEqual([CHILD]); expect(f.grant).not.toHaveBeenCalled(); expect(f.verifyToken).not.toHaveBeenCalled();
    expect(f.fence.failure).toBeUndefined(); expect(f.buffers.every(bytes => bytes.every(value => value === 0))).toBe(true);
  });
  it("refuses asynchronous token verification instead of acknowledging before its result", () => {
    const f = setup(); f.input.verifyToken = vi.fn(() => Promise.resolve());
    expect(() => f.observer.admit(f.input)).toThrow(); expect(f.grant).not.toHaveBeenCalled(); expect(closed(f)).toEqual([CHILD]);
  });
  it("does not grant after a synchronous token refusal or authority revocation during verification", () => {
    for (const revoke of [false, true]) {
      const f = setup(); f.input.verifyToken = () => { if (revoke) f.revoke(); else throw new Error("private token detail"); };
      expect(() => f.observer.admit(f.input)).toThrow("fixed native admission"); expect(f.grant).not.toHaveBeenCalled(); expect(closed(f)).toEqual([CHILD]);
    }
  });
  it.each([{ final: [ROOT_PID] }, { final: [ROOT_PID, CHILD_PID + 1] }, { final: [ROOT_PID, CHILD_PID, 600] }])("rechecks the complete original root/child job set before grant ($final)", ({ final }) => {
    const f = setup(undefined, [[ROOT_PID, CHILD_PID], final]); expect(() => f.observer.admit(f.input)).toThrow();
    expect(f.verifyToken).toHaveBeenCalledOnce(); expect(f.grant).not.toHaveBeenCalled(); expect(closed(f)).toEqual([CHILD]);
  });
  it("refuses a stale caller before querying the job", () => {
    const f = setup(); f.revoke(); expect(() => f.observer.admit(f.input)).toThrow();
    expect(f.calls).toEqual([]); expect(f.grant).not.toHaveBeenCalled();
  });
  it("closes a known child after synchronous or asynchronous grant contract failure", () => {
    const throws = setup(); throws.input.grant = () => { throw new Error("private acknowledgement path"); };
    expect(() => throws.observer.admit(throws.input)).toThrow("fixed native admission"); expect(closed(throws)).toEqual([CHILD]);
    const asynchronous = setup(); asynchronous.input.grant = () => Promise.resolve();
    expect(() => asynchronous.observer.admit(asynchronous.input)).toThrow(); expect(closed(asynchronous)).toEqual([CHILD]);
  });
  it.each(["close-false", "close-abi", "close-throw"] as const)("fences uncertain close after exactly one attempt and retains its owner (%s)", fault => {
    const f = setup(fault); expect(() => f.observer.admit(f.input)).toThrow(InheritedChildCleanupError);
    expect(closed(f)).toEqual([CHILD]); expect(f.grant).toHaveBeenCalledOnce(); expect(f.fence.retained).toHaveLength(1);
    const count = f.calls.length; f.repair(); expect(() => f.observer.admit(f.input)).toThrow(f.fence.failure);
    expect(f.calls).toHaveLength(count); expect(closed(f)).toEqual([CHILD]);
  });
  it("attempts known child cleanup even when an earlier token check already failed", () => {
    const f = setup("close-false"); f.input.verifyToken = () => { throw new Error("private token"); };
    expect(() => f.observer.admit(f.input)).toThrow(InheritedChildCleanupError); expect(closed(f)).toEqual([CHILD]); expect(f.grant).not.toHaveBeenCalled();
  });
  it.each(["current", "verifyToken", "grant"] as const)("retains typed cleanup uncertainty from the trusted %s callback", key => {
    const f = setup(), uncertain = new InheritedChildCleanupError();
    f.input[key] = () => { throw uncertain; };
    expect(() => f.observer.admit(f.input)).toThrow(InheritedChildCleanupError);
    expect(f.fence.retained).toHaveLength(1); expect(f.fence.failure).toBeInstanceOf(InheritedChildCleanupError);
    expect(closed(f)).toEqual(key === "current" ? [] : [CHILD]);
    const count = f.calls.length; expect(() => f.observer.admit(f.input)).toThrow(f.fence.failure); expect(f.calls).toHaveLength(count);
  });
  it("rejects invalid borrowed handle/PID/image contracts without acquiring any owner", () => {
    const f = setup();
    for (const altered of [{ job: 0n }, { rootProcess: JOB }, { rootPid: 0 }, { rootPid: 0x100000000 }, { image: "\\\\server\\share\\fixture.exe" }, { image: "C:\\private\nfixture.exe" }])
      expect(() => f.observer.admit({ ...f.input, ...altered })).toThrow();
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
    const spawn = inherited.slice(inherited.indexOf("static BOOL spawnInherited("), inherited.indexOf("static BOOL awaitInheritedChildAdmission("));
    expect(spawn).toContain("STARTUPINFOW startup;"); expect(spawn).toContain("startup.cb = sizeof(startup);");
    expect(spawn).toContain("CreateProcessW(selfPath, commandLine, &childAttributes, &childAttributes, FALSE,");
    expect(spawn).toContain("flags | CREATE_NO_WINDOW | CREATE_SUSPENDED,"); expect(spawn).toContain("NULL, NULL, &startup, process);");
    expect(spawn).not.toMatch(/STARTUPINFOEX|EXTENDED_STARTUPINFO|SECURITY_CAPABILITIES|UpdateProcThreadAttribute|SetTokenInformation|CREATE_BREAKAWAY_FROM_JOB/);
    const body = inherited.slice(inherited.indexOf(main)); expect(body).toContain("spawnInherited(CREATE_BREAKAWAY_FROM_JOB, &unexpected, &error)");
    expect(body).toContain("spawnInherited(0, &child, &error)");
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
