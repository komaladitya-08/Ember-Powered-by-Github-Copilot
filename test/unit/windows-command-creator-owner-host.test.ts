import type { Stats } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyCompletion, type WindowsCommandRootOnlyStopFence } from "../../app/main/agent/windows-command-stop";
import { bindWindowsCommandCreatorOwnerHost, bindWindowsCommandCreatorOwnerHostNative, windowsCommandCreatorOwnerHostFailure,
  WindowsCommandCreatorOwnerHostCleanupError, WINDOWS_COMMAND_CREATOR_OWNER_HOST_FUNCTIONS,
  type WindowsCommandCreatorOwnerHostDependencies, type WindowsCommandCreatorOwnerHostFence, type WindowsCommandCreatorOwnerHostBundle } from "../fixtures/windows-command-creator-owner-host";
import { WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC } from "../fixtures/windows-command-creator-owner-report";

const PRIVATE = "PRIVATE host path SID process token stderr detail";
const PROGRAM = "D:\\repo\\.build\\creator-owner-proof.exe", MODULE = "D:\\repo\\.build\\creator-owner.cjs", PARENT = "D:\\tmp";
type Fault = "partial" | "alias" | "false" | "throw-create" | "token-close" | "token-user" | "app-container" | "original-container" | "token-size" | "token-query" | "image" | "pid" | "stop" | "stop-close" | "report-close" | "fixture-close" | "report" | "exit" | "hang" | "completion";
function fullReport() {
  const bytes = Buffer.alloc(128); const values: Record<number, number> = { 0: WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC, 1: 2, 2: 4, 3: 1, 4: 19, 16: 3, 17: 15, 18: 15, 19: 15, 24: 15, 25: 3 };
  for (const [index, value] of Object.entries(values)) bytes.writeUInt32LE(value, Number(index) * 4); return bytes;
}
function harness(fault?: Fault) {
  const fence: WindowsCommandCreatorOwnerHostFence = { retained: [] }, stopFence: WindowsCommandRootOnlyStopFence = { retained: [] };
  const events: string[] = [], calls: { name: string; args: unknown[] }[] = [], tokenProcesses = new Map<bigint, unknown>(), addresses = new WeakMap<Buffer, bigint>();
  let nextAddress = 0x1000000n, nextToken = 100n, assigned = false, ended = false, closed = false, rootResumed = false, proofUnsafe = false, clock = 0;
  const address = (bytes: Buffer) => { let value = addresses.get(bytes); if (value === undefined) { value = nextAddress; nextAddress += 0x10000n; addresses.set(bytes, value); } return value; };
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    GetCurrentProcess: () => -1n,
    OpenProcessToken(process, access, output) { expect(access).toBe(8); const token = nextToken++; tokenProcesses.set(token, process); (output as unknown[])[0] = token; return 1; },
    GetTokenInformation(token, kind, target, _maximum, returned) {
      if (fault === "token-query") throw new Error(PRIVATE);
      const bytes = target as Buffer, result = returned as unknown[], root = tokenProcesses.get(token as bigint) === 20n;
      if (kind === 29) { bytes.writeUInt32LE(fault === "app-container" && root || fault === "original-container" && !root ? 1 : 0); result[0] = 4; return 1; }
      expect(kind).toBe(1); bytes.writeBigUInt64LE(address(bytes) + 16n); bytes[16] = 1; bytes[17] = 2; bytes[23] = 5;
      bytes.writeUInt32LE(21, 24); bytes.writeUInt32LE(fault === "token-user" && root ? 8 : 7, 28); result[0] = fault === "token-size" ? 15 : 32; return 1;
    },
    CloseHandle(owner) {
      events.push(`close:${owner as bigint}`);
      if (fault === "token-close" && owner === 100n || fault === "stop-close" && owner === 21n) return 0;
      tokenProcesses.delete(owner as bigint); if (owner === 10n) closed = true; return 1;
    },
    CreateJobObjectW: () => 10n,
    AssignProcessToJobObject() { events.push("assign"); assigned = true; return 1; },
    ResumeThread() { events.push("resume"); rootResumed = true; ended = fault !== "hang"; return 1; },
    TerminateProcess() { events.push("terminate-process"); ended = true; return 1; },
    TerminateJobObject() { events.push("terminate-job"); ended = true; return 1; },
    CreateProcessW(_program, _command, _ps, _ts, _inherit, _flags, _env, _directory, _startup, output) {
      events.push("create"); const bytes = output as Buffer; bytes.writeBigUInt64LE(20n); bytes.writeBigUInt64LE(fault === "partial" ? 0n : fault === "alias" ? 20n : 21n, 8); bytes.writeUInt32LE(200, 16);
      if (fault === "throw-create") throw new Error(PRIVATE); return fault === "false" ? 0 : 1;
    },
    GetProcessId: () => fault === "pid" ? 201 : 200,
    QueryFullProcessImageNameW(_process, _flags, bytes, count) { const image = fault === "image" ? "D:\\wrong\\image.exe" : PROGRAM; (bytes as Buffer).write(image, "utf16le"); (count as unknown[])[0] = image.length; return 1; },
    WaitForSingleObject: () => ended ? 0 : 258,
    GetExitCodeProcess(_process, output) { (output as unknown[])[0] = fault === "exit" ? 201 : 0; return 1; },
  };
  const native = bindWindowsCommandCreatorOwnerHostNative({ sizeof: () => 8, address } as Parameters<typeof bindWindowsCommandCreatorOwnerHostNative>[0], () => ({
    func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => { calls.push({ name, args }); return functions[name](...args); }; },
  }), fence);
  return completeHarness();

  function completeHarness() {
    const created: { file: string; security: string }[] = [], removed: string[] = [], pinned: bigint[] = [];
    const fixtureApi = {
      ownerSid: () => "S-1-5-21-7", windowsDirectory: () => "C:\\Windows", volumeFileSystem: () => "NTFS",
      createDirectory(file: string, security: string) { events.push("directory"); created.push({ file, security }); },
      writeNewFile(_file: string, _bytes: Buffer, security: string) { expect(security).toContain(";;;ME)"); },
      pinDirectory() { const value = BigInt(1000 + pinned.length); pinned.push(value); return value; },
    };
    const files = {
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }) as unknown as Stats,
      existsSync: () => false, realpathSync: { native: (file: string) => file },
      rmSync(file: string) { events.push("rm"); removed.push(file); },
    } as unknown as NonNullable<WindowsCommandCreatorOwnerHostDependencies["files"]>;
    const proofNative = {
      get unsafe() { return proofUnsafe; },
      guard<T>(operation: () => T): T { if (proofUnsafe) throw new Error(PRIVATE); try { return operation(); } catch { proofUnsafe = true; throw new Error(PRIVATE); } },
      pin(_file: string, maximum: number) {
        events.push("pin-report"); if (!closed || maximum !== 128) throw new Error(PRIVATE);
        return { bytes: 128, unchanged() {}, read() { events.push("read-report"); const bytes = fullReport(); if (fault === "report") bytes[0] = 0; return bytes; }, close() { events.push("report-close"); if (fault === "report-close") { proofUnsafe = true; throw new Error(PRIVATE); } } };
      },
      close(owner: bigint) { events.push(`fixture-close:${owner}`); if (fault === "fixture-close") { proofUnsafe = true; throw new Error(PRIVATE); } },
    };
    const stopNative = {
      configure() { events.push("configure-active-one"); }, assertLimits() {},
      state() { if (fault === "stop" && rootResumed) throw new Error(PRIVATE); return { total: assigned ? 1 : 0, active: assigned && !ended ? 1 : 0, pids: assigned && !ended ? [200] : [] }; },
      processId: () => 200, threadProcessId: () => 200, member: () => assigned,
      wait: (): 0 | 258 => ended ? 0 : 258,
      close(owner: bigint) { if (functions.CloseHandle(owner) !== 1) throw new Error(PRIVATE); },
    };
    const loaded: WindowsCommandCreatorOwnerHostBundle = {
      createWindowsCommandRootOnlyStopOwner(binding: object, api: Parameters<typeof createWindowsCommandRootOnlyStopOwner>[1]) { return createWindowsCommandRootOnlyStopOwner(binding, api, stopNative, () => clock, stopFence); },
      requireWindowsCommandRootOnlyCompletion(ref: unknown, binding: object) { events.push("completed-receipt"); const value = requireWindowsCommandRootOnlyCompletion(ref, binding); return fault === "completion" ? Object.freeze({ rootPresent: 0 as const }) : value; },
      loadWindowsCommandCopyProofNative: () => proofNative as unknown as ReturnType<WindowsCommandCreatorOwnerHostBundle["loadWindowsCommandCopyProofNative"]>,
    };
    const dependencies: WindowsCommandCreatorOwnerHostDependencies = { api: fixtureApi, native, files, fence, now: () => clock, pause: async () => { clock += 10_001; }, managedTemporary: () => "D:\\managed" };
    const observe = bindWindowsCommandCreatorOwnerHost(dependencies);
    const verifyBuild = () => { events.push("verify-build"); };
    const input = () => observe({ executable: PROGRAM, module: MODULE }, loaded as unknown as Parameters<typeof observe>[1], verifyBuild, PARENT);
    return { native, fence, stopFence, events, calls, functions, created, removed, pinned, files, loaded, dependencies, observe, input, verifyBuild };
  }
}

async function refused(promise: Promise<unknown>, stage?: number) {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(WindowsCommandCreatorOwnerHostCleanupError);
  const facts = windowsCommandCreatorOwnerHostFailure(error); expect(facts).toBeDefined(); expect(Object.isFrozen(facts)).toBe(true);
  if (stage !== undefined) expect(facts?.stage).toBe(stage);
  expect(Object.keys(facts!).sort()).toEqual(["code", "domain", "operation", "predicate", "stage"]);
  expect(Object.values(facts!).every(value => typeof value === "number" && Number.isInteger(value) && value >= 0)).toBe(true);
  expect(JSON.stringify(error).includes(PRIVATE)).toBe(false); return facts!;
}

describe("fixed ordinary-host creator ACL control", () => {
  it("uses the exact suspended detached ordinary root, original token identity and genuine closed Stop before reading", async () => {
    const h = harness(), retire = h.native.retire; h.native.retire = () => { h.events.push("retire-native"); retire(); };
    await expect(h.input()).resolves.toEqual({ aclHostPositive: 4 });
    const spawn = h.calls.find(call => call.name === "CreateProcessW")!;
    expect(spawn.args[0]).toBe(PROGRAM); expect(spawn.args[2]).toBeNull(); expect(spawn.args[3]).toBeNull(); expect(spawn.args[4]).toBe(0); expect(spawn.args[5]).toBe(0x40c);
    const startup = spawn.args[8] as Buffer; expect(startup.length).toBe(104); expect(startup.readUInt32LE(0)).toBe(104); expect(startup.subarray(4).some(Boolean)).toBe(false);
    const command = (spawn.args[1] as Buffer).toString("utf16le"); expect(command.includes('"acl-host"')).toBe(true);
    expect(h.events.indexOf("configure-active-one")).toBeLessThan(h.events.indexOf("create"));
    expect(h.events.indexOf("close:101")).toBeLessThan(h.events.indexOf("resume"));
    expect(h.events.indexOf("close:10")).toBeLessThan(h.events.indexOf("completed-receipt"));
    expect(h.events.indexOf("completed-receipt")).toBeLessThan(h.events.indexOf("pin-report"));
    expect(h.events.indexOf("completed-receipt")).toBeLessThan(h.events.indexOf("retire-native"));
    expect(h.events.indexOf("retire-native")).toBeLessThan(h.events.indexOf("pin-report"));
    expect(h.events.indexOf("report-close")).toBeLessThan(h.events.indexOf("rm")); expect(h.removed).toHaveLength(1);
    expect(h.created).toHaveLength(3); expect(h.created.every(item => !item.security.includes("S-1-15-") && !item.security.includes(";;;LW)") && item.security.includes(";;;ME)"))).toBe(true);
    expect(h.fence.retained).toHaveLength(0); expect(h.stopFence.retained).toHaveLength(0);
  });
  it.each(["partial", "alias", "false", "throw-create"] as const)("retains %s process creation without assignment, resume, report or removal", async fault => {
    const h = harness(fault); await refused(h.input(), 4);
    expect(h.events).not.toContain("assign"); expect(h.events).not.toContain("resume"); expect(h.events).not.toContain("pin-report"); expect(h.removed).toHaveLength(0); expect(h.fence.retained.length).toBeGreaterThan(0);
    const before = h.calls.length; await refused(h.input()); expect(h.calls).toHaveLength(before);
    expect(h.events.filter(event => event === "terminate-process")).toHaveLength(fault === "partial" ? 1 : 0);
  });
  it.each(["token-user", "app-container", "image", "pid"] as const)("refuses suspended root %s before Resume", async fault => {
    const h = harness(fault); await refused(h.input(), 5); expect(h.events).not.toContain("resume"); expect(h.events).not.toContain("pin-report"); expect(h.removed).toHaveLength(0);
  });
  it.each(["token-close", "original-container", "token-size", "token-query"] as const)("retains original token %s and never creates a process", async fault => {
    const h = harness(fault); await refused(h.input(), 2); expect(h.events).not.toContain("create"); expect(h.events).not.toContain("pin-report"); expect(h.removed).toHaveLength(0);
    const queries = h.calls.filter(call => /Get|Open|Wait/.test(call.name)).length;
    expect(() => h.native.original()).toThrow(WindowsCommandCreatorOwnerHostCleanupError);
    expect(h.calls.filter(call => /Get|Open|Wait/.test(call.name))).toHaveLength(queries);
  });
  it.each(["stop", "stop-close", "completion"] as const)("does not acquire a report or remove scratch after %s ownership failure", async fault => {
    const h = harness(fault); await refused(h.input(), 7); expect(h.events).not.toContain("pin-report"); expect(h.events).not.toContain("read-report"); expect(h.removed).toHaveLength(0);
  });
  it.each(["report-close", "fixture-close"] as const)("does not retry %s or remove scratch after an uncertain close", async fault => {
    const h = harness(fault); await refused(h.input()); expect(h.removed).toHaveLength(0);
    const before = [...h.events]; await refused(h.input()); expect(h.events).toEqual(before);
  });
  it("does not read a failure report after a validated nonzero natural exit", async () => {
    const h = harness("exit"), facts = await refused(h.input(), 6); expect(facts).toMatchObject({ domain: 2, code: 201 }); expect(h.events).not.toContain("pin-report"); expect(h.removed).toHaveLength(0);
  });
  it("retains timed-out work and requests only non-disposing Stop without reading or deleting", async () => {
    const h = harness("hang"); await refused(h.input(), 6); expect(h.events).toContain("terminate-job"); expect(h.events).not.toContain("pin-report"); expect(h.removed).toHaveLength(0);
  });
  it("refuses a malformed stopped report without returning positive controls or removing the private graph", async () => {
    const h = harness("report"); await refused(h.input(), 8); expect(h.events).toContain("read-report"); expect(h.removed).toHaveLength(0);
  });
  it.each(["D:\\repo", "D:\\repo\\.build", "D:\\tmp\\..\\other"])("rejects overlapping or noncanonical scratch %s before native acquisition", async scratch => {
    const h = harness(); await refused(h.observe({ executable: PROGRAM, module: MODULE }, h.loaded as unknown as Parameters<typeof h.observe>[1], h.verifyBuild, scratch), 1);
    expect(h.calls).toHaveLength(0); expect(h.created).toHaveLength(0); expect(h.removed).toHaveLength(0);
  });
  it("does not inspect foreign proxy or copied diagnostic facts", () => {
    const foreign = new Proxy({}, { get() { throw new Error(PRIVATE); }, ownKeys() { throw new Error(PRIVATE); } });
    expect(windowsCommandCreatorOwnerHostFailure(foreign)).toBeUndefined(); expect(windowsCommandCreatorOwnerHostFailure({ stage: 7, code: 5 })).toBeUndefined();
  });
  it("canonicalises managed temporary storage and refuses equal, descendant or ancestor scratch before native acquisition", async () => {
    for (const [managed, scratch] of [[PARENT, PARENT], [PARENT + "\\managed-child", PARENT], [PARENT, PARENT + "\\scratch-child"], ["D:\\managed", PARENT]]) {
      const h = harness(); h.dependencies.managedTemporary = () => managed;
      if (managed === "D:\\managed") h.files.realpathSync.native = ((file: string) => file === managed ? PARENT + "\\aliased-managed" : file) as typeof h.files.realpathSync.native;
      const observe = bindWindowsCommandCreatorOwnerHost(h.dependencies);
      await refused(observe({ executable: PROGRAM, module: MODULE }, h.loaded, h.verifyBuild, scratch), 1);
      expect(h.calls).toHaveLength(0); expect(h.created).toHaveLength(0);
    }
  });
  it("permanently retires process, thread and job authority after genuine completion before any report read", async () => {
    const h = harness(); await h.input(); const count = h.calls.length;
    for (const action of [() => h.native.api.terminateProcess(20n), () => h.native.api.terminateJob(10n), () => h.native.api.resume(21n), () => h.native.exited(20n), () => h.native.api.createJob()]) expect(action).toThrow(WindowsCommandCreatorOwnerHostCleanupError);
    expect(h.calls).toHaveLength(count);
  });
  it("retains the proof-native ledger when report acquisition throws before returning a pin", async () => {
    const h = harness(); const proof = h.loaded.loadWindowsCommandCopyProofNative(); proof.pin = () => { throw new Error(PRIVATE); };
    await refused(h.input(), 8);
    const graph = h.fence.retained.find(value => typeof value === "object" && value !== null && "proofNative" in value) as { proofNative?: unknown };
    expect(graph.proofNative).toBe(proof); expect(h.removed).toHaveLength(0);
  });
  it("does not revive a failed binder, runner or new binder when the public failure field is cleared", async () => {
    const h = harness("token-close"); await refused(h.input()); const count = h.calls.length; h.fence.failure = undefined;
    expect(() => h.native.original()).toThrow(WindowsCommandCreatorOwnerHostCleanupError);
    await refused(h.input());
    expect(() => bindWindowsCommandCreatorOwnerHostNative({ sizeof: () => 8 } as unknown as Parameters<typeof bindWindowsCommandCreatorOwnerHostNative>[0], () => { throw new Error(PRIVATE); }, h.fence)).toThrow(WindowsCommandCreatorOwnerHostCleanupError);
    expect(h.calls).toHaveLength(count);
  });
  it("rechecks the private barrier after a native callback clears the public field", async () => {
    const h = harness(), query = h.functions.GetTokenInformation;
    h.functions.GetTokenInformation = (...args) => { const returned = query(...args); try { h.native.stage(99 as never); } catch { /* Inject the private terminal barrier. */ } h.fence.failure = undefined; return returned; };
    await refused(h.input(), 2); expect(h.calls.filter(call => call.name === "GetTokenInformation")).toHaveLength(1); expect(h.events).not.toContain("create"); expect(h.removed).toHaveLength(0);
  });
  it("rechecks the private barrier after a trusted verification callback clears the public field", async () => {
    const h = harness();
    await refused(h.observe({ executable: PROGRAM, module: MODULE }, h.loaded, () => { try { h.native.stage(99 as never); } catch { /* Inject the private terminal barrier. */ } h.fence.failure = undefined; }, PARENT), 10);
    expect(h.calls).toHaveLength(0); expect(h.created).toHaveLength(0);
  });
  it("binds only the fixed API catalogue and never asks for an error-query, inherited handle list or process attribute", () => {
    const prototypes = Object.values(WINDOWS_COMMAND_CREATOR_OWNER_HOST_FUNCTIONS).flat().join("\n");
    expect(prototypes.includes("GetLastError")).toBe(false); expect(prototypes.includes("ProcThreadAttribute")).toBe(false); expect(prototypes.includes("OpenProcess(")).toBe(false);
  });
});
