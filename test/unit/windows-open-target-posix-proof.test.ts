/** Real Stop receipts plus synthetic closed native returns; no Windows call or native execution. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyCompletion,
  type WindowsCommandRootOnlyStopNative } from "../../app/main/agent/windows-command-stop";
import { bindWindowsOpenTargetPosixProof, WindowsOpenTargetPosixObservationError } from "../fixtures/windows-open-target-posix-proof";
import { verifyWindowsOpenTargetPosixRun } from "../fixtures/windows-open-target-posix-run";

const parent = "C:\\runner", asset = { executable: "C:\\build\\open-target.exe", module: "C:\\build\\open-target.cjs" };
function setup(bSuccess: 0 | 1 = 0) {
  const calls: string[] = [], bytes = Buffer.alloc(160), control = { exit: 0, rootPresent: true, stopped: false, closed: false, unsafe: false, fail: "", bytes, checks: 0, clock: 0, pauseAdvance: 0, pendingExits: 0, queryAdvance: 0, exitAdvance: 0, environment: "" };
  [0x50544f57, 2, 1, 3, 3, 3, 3, 3, bSuccess ? 3 : 1, 0, bSuccess ? 0 : 5, 3, 3, 22, 3, 3].forEach((v, i) => bytes.writeUInt32LE(v, i * 4));
  [24, 32].forEach((word, index) => { bytes.writeUInt32LE(1, word * 4); bytes.writeUInt32LE(index + 10, word * 4 + 8); bytes.writeBigUInt64LE(5n, word * 4 + 12); });
  let active = 0, total = 0, release: (() => void) | undefined, held: Promise<void> | undefined, root: { process: bigint; thread: bigint; pid: number } | undefined;
  const event = (name: string) => { calls.push(name); if (control.fail === name) throw new Error("private unreachable failure"); };
  const api = { createJob() { event("job"); return 500n; }, assign() { event("assign"); active = 1; total = 1; }, resume() { event("resume"); }, terminateJob() { event("terminate-job"); active = 0; }, terminateProcess() { event("terminate-process"); active = 0; } };
  const stopNative: WindowsCommandRootOnlyStopNative = { configure() { event("limits"); }, assertLimits() { event("limits-read"); },
    state() { event("state"); return { total, active, pids: active ? [77] : [] }; }, processId: () => 77, threadProcessId: () => 77,
    member: () => active > 0, wait() { event("wait"); return 0; }, close() { event("stop-close"); } };
  const fixture = { directory: parent + "\\fresh", report: parent + "\\fresh\\report.bin",
    readReport(receipt: unknown) { native.host.retire(); event("report"); expect(control.stopped).toBe(true); expect(receipt).toBe(stopReceipt); return bytes; },
    verifyAndClose(receipt: unknown, observed: 0 | 1, privateReport: Buffer) { event("fixture-close"); expect(receipt).toBe(stopReceipt); expect(observed).toBe(bSuccess); expect(privateReport).toBe(bytes); control.closed = true; return Object.freeze({ equalInitialState: 1 as const, aNeverPinned: 1 as const, bHeldThroughStop: 1 as const, privateCleanup: 1 as const, newSourceIdentityMatched: 1 as const, oldIdentityVerified: 1 as const, oldSecurityVerified: 1 as const, oldStreamsVerified: 1 as const, oldLinks: bSuccess ? 0 as const : 1 as const, oldDeletePending: bSuccess ? 1 as const : 0 as const, legacyDetached: bSuccess }); } };
  const proof = { get unsafe() { return control.unsafe; },
    pin(name: string) { event("pin:" + (name.endsWith("exe") ? "image" : "module")); const kind = name.endsWith("exe") ? "image" : "module"; return { bytes: 4, read: () => Buffer.alloc(4), unchanged() { event("unchanged:" + kind); }, close() { event("pin-close:" + kind); } }; },
    image() { event("image"); }, close() {}, deleteProfile() {}, guard<T>(operation: () => T) { return operation(); } };
  const native = { guard<T>(operation: () => T) { return operation(); }, host: { api,
    original() { event("original"); }, create(_program: string, _command: Buffer, _cwd: string, environment: Buffer) { event("create-process"); control.environment = environment.toString("utf16le"); return root = { process: 100n, thread: 101n, pid: 77 }; },
    verify(selected: unknown) { event("host-verify"); expect(selected).toEqual(root); }, exited() { event("exited"); control.clock += control.queryAdvance; return control.pendingExits-- <= 0; }, exitCode() { event("exit"); control.clock += control.exitAdvance; return control.exit; },
    retire() { event("host-retire"); expect(control.stopped).toBe(true); }, stage() {} },
    create() { event("fixture"); return fixture; } };
  const profile = {}, loaded: Record<string, unknown> = {
    loadWindowsOpenTargetPosixNative() { event("load-native"); return native; }, WindowsOpenTargetPosixCleanupError: class extends Error {},
    createWindowsCommandRootOnlyStopOwner(binding: object) {
      const actual = createWindowsCommandRootOnlyStopOwner(binding, api, stopNative, () => 10, { retained: [] });
      return { ...actual, async stop() { event("stop-request"); if (held) await held; event("stop-finish"); if (control.fail === "stop-receipt") return {}; const result = await actual.stop(); control.stopped = true; stopReceipt = result; return result; } };
    },
    requireWindowsCommandRootOnlyPreparing() {}, requireWindowsCommandRootOnlyCompletion(receipt: unknown, binding: object) {
      const value = requireWindowsCommandRootOnlyCompletion(receipt, binding); return control.rootPresent ? value : { rootPresent: 0 };
    }, WindowsCommandRootOnlyCleanupError: class extends Error {}, windowsCommandRootOnlyFailure() {},
    createFreshWindowsCommandCreatorProfile() { event("profile"); return profile; }, windowsCommandCreatorProfile() {},
    closeWindowsCommandCreatorProfile(value: object) { event("profile-close"); expect(value).toBe(profile); expect(control.closed).toBe(true); }, WindowsCommandCreatorProfileCleanupError: class extends Error {},
    loadWindowsCommandCopyProofNative() { event("load-proof"); return proof; }, WindowsCommandCopyProofCleanupError: class extends Error {},
  };
  let stopReceipt: unknown;
  const load = () => { event("load"); return loaded as unknown as ReturnType<Parameters<typeof bindWindowsOpenTargetPosixProof>[0]["load"]>; };
  const files = { lstatSync() { return { isDirectory: () => true, isSymbolicLink: () => false }; }, realpathSync: Object.assign((value: string) => value, { native: (value: string) => value }), existsSync() { return !control.closed; } } as unknown as NonNullable<Parameters<typeof bindWindowsOpenTargetPosixProof>[0]["files"]>;
  const observe = bindWindowsOpenTargetPosixProof({ load, files, managedTemporary: () => "C:\\managed", windowsDirectory: () => "C:\\Windows", now: () => control.clock,
    async pause() { event("pause"); control.clock += control.pauseAdvance; } });
  const verify = () => { event("verify"); control.checks++; };
  return { observe, calls, control, loaded, run: () => observe(asset, verify, parent), holdStop() { held = new Promise<void>(resolve => { release = resolve; }); }, release() { release!(); } };
}
it.each([0, 1] as const)("publishes a stopped observation for B success=%i with a genuine bound completion", async b => {
  const v = setup(b), result = await v.run(); expect(result).toMatchObject({ scope: 1, parameterEquivalent: 1, ordinaryHost: 1, rootOnlyStop: 1, aNeverPinned: 1, bHeldThroughStop: 1, privateCleanup: 1, report: { a: { success: 1, error: 0 }, b: { success: b, error: b ? 0 : 5 } } });
  expect(v.calls.indexOf("verify")).toBeLessThan(v.calls.indexOf("load")); expect(v.calls.indexOf("host-verify")).toBeLessThan(v.calls.indexOf("resume"));
  expect(v.calls.indexOf("stop-finish")).toBeLessThan(v.calls.indexOf("report")); expect(v.calls.indexOf("fixture-close")).toBeLessThan(v.calls.indexOf("profile-close")); expect(v.control.bytes.every(x => x === 0)).toBe(true);
});
it("does not read, close B or publish while the actual Stop promise remains pending", async () => {
  const v = setup(); v.holdStop(); const work = v.run(); for (let i = 0; i < 20 && !v.calls.includes("stop-request"); i++) await Promise.resolve();
  expect(v.calls).toContain("stop-request"); expect(v.calls).not.toContain("report"); expect(v.calls).not.toContain("fixture-close"); v.release(); await work;
});
it("passes exactly the sorted fixed Unicode environment to the actual host-create boundary", async () => {
  vi.stubEnv("GH_TOKEN", "fixed-untrusted-ambient");
  try {
    const v = setup(); await v.run(); expect(v.control.environment.split("\0")).toEqual(["PATH=C:\\Windows\\System32", "SystemRoot=C:\\Windows", "TEMP=C:\\runner\\fresh", "TMP=C:\\runner\\fresh", "WINDIR=C:\\Windows", "", ""]);
    expect(v.control.environment).not.toContain("GH_TOKEN"); expect(v.control.environment).not.toContain("fixed-untrusted-ambient");
  } finally { vi.unstubAllEnvs(); }
});
it.each(["original", "job", "limits", "profile", "fixture", "create-process", "host-verify", "image", "resume", "exited", "exit", "stop-request", "stop-finish", "stop-receipt", "host-retire", "report", "fixture-close", "profile-close", "pin-close:image"])("retains the whole graph after %s uncertainty", async failure => {
  const v = setup(); v.control.fail = failure; await expect(v.run()).rejects.toBeInstanceOf(WindowsOpenTargetPosixObservationError);
  const after = [...v.calls]; await expect(v.run()).rejects.toBeInstanceOf(WindowsOpenTargetPosixObservationError); expect(v.calls).toEqual(after);
  if (!["fixture-close", "profile-close", "pin-close:image"].includes(failure)) expect(v.calls).not.toContain("profile-close");
  if (["stop-request", "stop-finish", "stop-receipt"].includes(failure)) expect(v.calls).not.toContain("report");
  if (failure === "pin-close:image") expect(v.calls).not.toContain("pin-close:module");
});
it.each([1, 212, 0xffffffff])("refuses natural exit %i before Stop/report reads", async exit => {
  const v = setup(); v.control.exit = exit; await expect(v.run()).rejects.toMatchObject({ phase: 4 }); expect(v.calls).not.toContain("report"); expect(v.calls).not.toContain("fixture-close");
});
it("refuses a genuine rootless completion without inspecting the report", async () => {
  const v = setup(); v.control.rootPresent = false; await expect(v.run()).rejects.toMatchObject({ phase: 5 }); expect(v.calls).not.toContain("report");
});
it.each([0, 4, 8, 12, 32, 36, 44, 60])("retains a malformed private report at byte %i with B/profile", async offset => {
  const v = setup(); v.control.bytes[offset] ^= 128; await expect(v.run()).rejects.toMatchObject({ phase: 6 }); expect(v.control.bytes.some(x => x !== 0)).toBe(true); expect(v.calls).not.toContain("fixture-close"); expect(v.calls).not.toContain("profile-close");
});
it("does not enter Native for a malformed or managed scratch parent", async () => {
  for (const directory of ["relative", "C:\\runner\\..\\other", "C:\\managed\\nested", "C:\\"]) {
    const v = setup(); await expect(v.observe(asset, () => {}, directory)).rejects.toBeInstanceOf(WindowsOpenTargetPosixObservationError); expect(v.calls).not.toContain("load-native");
  }
});
it("does not execute a structurally incomplete emitted module", async () => {
  const v = setup(); delete v.loaded.requireWindowsCommandRootOnlyCompletion; await expect(v.run()).rejects.toMatchObject({ phase: 1 }); expect(v.calls).not.toContain("load-proof");
});
it("requires synchronous build attestation before loading the emitted code", async () => {
  const v = setup(); await expect(v.observe(asset, async () => {}, parent)).rejects.toMatchObject({ phase: 1 }); expect(v.calls).not.toContain("load");
});
it.each([{ name: "true", value: true }, { name: "false", value: false }, { name: "object", value: {} }])("refuses $name as build attestation without loading code", async ({ value }) => {
  const v = setup(); await expect(v.observe(asset, () => value, parent)).rejects.toMatchObject({ phase: 1 }); expect(v.calls).not.toContain("load");
});
it("does not inspect a foreign attestation value's getters or error text", async () => {
  const v = setup(); let inspected = false;
  const value = new Proxy({}, { get() { inspected = true; throw new Error("unreachable private value"); } });
  await expect(v.observe(asset, () => value, parent)).rejects.toMatchObject({ phase: 1 }); expect(inspected).toBe(false); expect(v.calls).not.toContain("load");
});
it.each([2, 3, 4, 5, 6])("refuses an async build attestation at existing checkpoint %i", async checkpoint => {
  const v = setup(); let count = 0;
  await expect(v.observe(asset, () => { if (++count === checkpoint) return Promise.resolve(); }, parent)).rejects.toBeInstanceOf(WindowsOpenTargetPosixObservationError);
  if (checkpoint <= 4) expect(v.calls).not.toContain("resume");
  if (checkpoint <= 5) expect(v.calls).not.toContain("report");
  expect(v.calls).not.toContain("fixture-close"); expect(v.calls).not.toContain("profile-close");
});
it("does not issue another exit query after an awaited pause passes the deadline", async () => {
  const v = setup(); v.control.pendingExits = 1; v.control.pauseAdvance = 15_001; await expect(v.run()).rejects.toMatchObject({ phase: 4 });
  expect(v.calls.filter(value => value === "exited")).toHaveLength(1); expect(v.calls).not.toContain("exit"); expect(v.calls).not.toContain("report");
});
it.each(["queryAdvance", "exitAdvance"] as const)("rejects positive completion observed after the deadline during %s", async field => {
  const v = setup(); v.control[field] = 15_001; await expect(v.run()).rejects.toMatchObject({ phase: 4 }); expect(v.calls).not.toContain("report");
});
it.each([NaN, Infinity, -1])("rejects an invalid initial clock %s without an exit query", async clock => {
  const v = setup(); v.control.clock = clock; await expect(v.run()).rejects.toMatchObject({ phase: 4 }); expect(v.calls).not.toContain("exited");
});
it("rejects a backwards clock after pause without another Native query", async () => {
  const v = setup(); v.control.clock = 10; v.control.pendingExits = 1; v.control.pauseAdvance = -1; await expect(v.run()).rejects.toMatchObject({ phase: 4 });
  expect(v.calls.filter(value => value === "exited")).toHaveLength(1); expect(v.calls).not.toContain("report");
});

const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
it.each(["windows-2022", "windows-2025"])("binds every exact public runtime input for %s", image => {
  const value = verifyWindowsOpenTargetPosixRun(repository, { image, commit: "a".repeat(40) });
  expect(value).toMatchObject({ schema: 2, issuer: "ember-ordinary-host-open-target-posix-run-v1", compiledIssuer: "ember-ordinary-host-open-target-posix-build-v1",
    sourceBaseline: "0a86cfb1682075fa1683ce335f51e053290195e8", rootCreateFlags: 0x40c, targetAccess: 0x1e0080, targetShare: 7, targetOptions: 0x200060, reportBytes: 160 });
  expect(value.sourceManifestSha256).toMatch(/^[0-9a-f]{64}$/); expect(Object.isFrozen(value)).toBe(true);
});
it.each([null, 0, "", "A".repeat(40), "a".repeat(39), "a".repeat(41), {}])("rejects malformed compile identity %s before opening source", commit => {
  const open = vi.spyOn(fs, "openSync");
  try { expect(() => verifyWindowsOpenTargetPosixRun(repository, { image: "windows-2022", commit })).toThrow("fixed public run identity"); expect(open).not.toHaveBeenCalled(); }
  finally { open.mockRestore(); }
});
it("does not coerce a foreign compile identity", () => {
  let called = false; const commit = { toString() { called = true; throw new Error("unreachable private data"); } };
  expect(() => verifyWindowsOpenTargetPosixRun(repository, { image: "windows-2022", commit })).toThrow(); expect(called).toBe(false);
});
it.each([null, 0, "", "windows-latest", "windows-2022\n", {}])("rejects an unsupported image %s before opening source", image => {
  const open = vi.spyOn(fs, "openSync");
  try { expect(() => verifyWindowsOpenTargetPosixRun(repository, { image, commit: "a".repeat(40) })).toThrow(); expect(open).not.toHaveBeenCalled(); }
  finally { open.mockRestore(); }
});
it("rejects mismatched held source bytes and closes the same issued descriptor once", () => {
  const original = fs.readSync, close = vi.spyOn(fs, "closeSync");
  const read = vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const count = original(fd, buffer, offset, length, position); if (count) buffer[offset] ^= 1; return count;
  }) as typeof fs.readSync);
  try { expect(() => verifyWindowsOpenTargetPosixRun(repository, { image: "windows-2022", commit: "a".repeat(40) })).toThrow(); expect(close).toHaveBeenCalledTimes(1); }
  finally { read.mockRestore(); close.mockRestore(); }
});
it("permanently refuses later source admission after an uncertain one-attempt close", async () => {
  vi.resetModules(); const isolated = await import("../fixtures/windows-open-target-posix-run"), original = fs.closeSync;
  const close = vi.spyOn(fs, "closeSync").mockImplementation(fd => { original(fd); throw new Error("private close uncertainty"); });
  try { expect(() => isolated.verifyWindowsOpenTargetPosixRun(repository, { image: "windows-2022", commit: "a".repeat(40) })).toThrow(); expect(close).toHaveBeenCalledTimes(1); }
  finally { close.mockRestore(); }
  const open = vi.spyOn(fs, "openSync");
  try { expect(() => isolated.verifyWindowsOpenTargetPosixRun(repository, { image: "windows-2022", commit: "a".repeat(40) })).toThrow(); expect(open).not.toHaveBeenCalled(); }
  finally { open.mockRestore(); }
});
