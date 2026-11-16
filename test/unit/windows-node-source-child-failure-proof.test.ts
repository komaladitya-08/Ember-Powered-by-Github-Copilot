/** Actual main/fixture/Stop/read/disposal ordering with synthetic Win32/fs boundaries; no native or PE runs. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const state = vi.hoisted(() => ({
  files: new Map<string, Buffer>(), descriptors: new Map<number, string>(), events: [] as string[], readBuffers: [] as Buffer[],
  processJobs: new Map<bigint, bigint>(), nextHandle: 100n, nextFd: 10, observers: 0, statePath: "", hostExited: false, lpacExited: true,
  mode: "spawn" as "spawn" | "test", exitCode: 1, fault: "", failurePinChecks: 0, failurePinClosed: false,
  asset: Buffer.from("MZfixed-source-node"), bootstrap: Buffer.from("MZfixed-bootstrap"), cleanup: () => new Error("unbound synthetic cleanup"),
}));
vi.mock("node:path", async original => { const actual = await original<typeof import("node:path")>(); return { ...actual, default: actual.win32 }; });
vi.mock("node:fs", () => {
  const missing = () => Object.assign(new Error("fixed synthetic missing file"), { code: "ENOENT" });
  const stat = (file: string) => {
    if (file.endsWith("-failure.bin")) state.events.push("failure-stat");
    const bytes = state.files.get(file); if (!bytes) throw missing();
    return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: bytes.length, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1 };
  };
  return { default: { constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 }, realpathSync: { native: (file: string) => file }, lstatSync: stat,
    openSync(file: string) { if (!state.files.has(file)) throw missing(); if (file.endsWith("-failure.bin")) state.events.push("failure-open"); const fd = state.nextFd++; state.descriptors.set(fd, file); return fd; },
    fstatSync: (fd: number) => stat(state.descriptors.get(fd)!),
    readSync(fd: number, target: Buffer, offset: number, length: number, position: number) {
      const file = state.descriptors.get(fd)!; if (file.endsWith("-failure.bin")) { state.events.push("failure-read"); state.readBuffers.push(target); }
      return state.files.get(file)!.copy(target, offset, position, position + length);
    },
    closeSync(fd: number) {
      const file = state.descriptors.get(fd)!;
      if (file.endsWith("-failure.bin")) { state.events.push("failure-read-close"); if (state.fault === "read-close") throw new Error("private close uncertainty"); }
      state.descriptors.delete(fd);
    },
  } };
});
vi.mock("../../scripts/experimental/build-windows-node-source.mjs", async () => {
  const { createHash } = await import("node:crypto");
  const fingerprint = (name: string, bytes: Buffer) => ({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return { parseWindowsNodeSourceBuildReceipt: () => ({ assets: { node: fingerprint("source-node.exe", state.asset), bootstrap: fingerprint("bootstrap.exe", state.bootstrap) } }) };
});
vi.mock("../fixtures/windows-node-lpac-proof", async original => {
  const actual = await original<typeof import("../fixtures/windows-node-lpac-proof")>();
  return { ...actual, nativeChecks: () => ({ image() { state.events.push("image-verified"); }, pin(file: string, maximum: number) {
    if (file.endsWith("-failure.bin")) {
      state.events.push("failure-pin-excludes-writers"); expect(maximum).toBe(48);
      if (state.fault === "pin-acquire") throw new Error("private pin uncertainty");
    }
    if (!state.files.has(file)) throw new Error("fixed synthetic pin missing");
    return { file, bytes: state.files.get(file)!.length,
      unchanged() {
        if (!file.endsWith("-failure.bin")) return;
        state.events.push("failure-pin-unchanged"); state.failurePinChecks++;
        if (state.fault === "pin-after-read" && state.failurePinChecks === 1 || state.fault === "late-pin" && state.failurePinChecks === 3) throw state.cleanup();
      }, close() { if (file.endsWith("-failure.bin")) { state.failurePinClosed = true; state.events.push("failure-pin-close"); } },
    };
  } }) };
});
vi.mock("../fixtures/windows-libuv-host-identity", async original => {
  const actual = await original<typeof import("../fixtures/windows-libuv-host-identity")>();
  return { ...actual, loadWindowsLibuvHostIdentity: () => ({ inspect: () => ({ sameUser: true,
    parent: { hasRestrictingSids: false, integrityRid: 12288, appContainer: 0 }, host: { hasRestrictingSids: false, integrityRid: 12288, appContainer: 0 } }) }) };
});
function goodReport(role: number) {
  const bytes = Buffer.alloc(64), words = [0x43534e45, 1, role, state.mode === "spawn" ? 1 : 2, 4, 1, 31, state.mode === "spawn" ? 12 : 0, state.mode === "spawn" ? 14 : 0, 0, 1, 1, 1, 1, 22023005, 0];
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
}
vi.mock("../fixtures/windows-node-source-child-observer", () => ({ loadWindowsNodeSourceChildObserver: () => {
  const role = state.observers++ === 0 ? "host" : "lpac"; let binding: { current(): boolean; verifyToken(process: bigint): void; grant(pid: number): void } | undefined, stopped = false;
  return { bind(value: typeof binding) { binding = value; state.events.push(`${role}-observer-bound`); },
    admit() {
      if (role === "lpac" && state.exitCode !== 0) return null;
      expect(binding?.current()).toBe(true); binding!.verifyToken(role === "host" ? 30n : 50n); binding!.grant(77);
      state.events.push(`${role}-child-admitted`);
      state.files.set(`${state.statePath}\\${role}-source-child-${state.mode === "spawn" ? 1 : 2}-report.bin`, goodReport(role === "host" ? 0 : 1));
      if (role === "host") state.hostExited = true; else state.lpacExited = true; return 77;
    },
    waitStoppedBefore() {
      state.events.push(`${role}-observer-stop`); if (role === "lpac" && state.fault === "observer-stop") throw state.cleanup(); stopped = true;
    },
    requireStopped() { state.events.push(`${role}-observer-require-stop`); if (!stopped || role === "lpac" && state.fault === "reader-stop") throw state.cleanup(); },
    closeStopped() { expect(stopped).toBe(true); state.events.push(`${role}-observer-close`); },
  };
} }));
const passingTap = "TAP version 13\n# Subtest: fixed source Node local test\nok 1 - fixed source Node local test\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 2\n";
vi.mock("../fixtures/windows-node-source-child-io", async original => {
  const actual = await original<typeof import("../fixtures/windows-node-source-child-io")>();
  return { ...actual, loadWindowsNodeSourceChildIo: (_directory: string, _profile: unknown, _api: unknown, role: "host" | "lpac") => ({
    createHost: () => ({ process: 20n, thread: 21n, pid: 22 }), createLpac: () => ({ process: 40n, thread: 41n, pid: 42 }),
    readAfterStopped(stopped: () => void) { stopped(); state.events.push(`${role}-output-writer-exclusion`); stopped(); return state.mode === "test" && (role === "host" || state.exitCode === 0) ? Buffer.from(passingTap) : Buffer.alloc(0); },
    close() { state.events.push(`${role}-io-close`); },
  }) };
});
beforeEach(() => {
  vi.resetModules(); state.files.clear(); state.descriptors.clear(); state.events.length = 0; state.readBuffers.length = 0; state.processJobs.clear();
  state.nextHandle = 100n; state.nextFd = 10; state.observers = 0; state.statePath = ""; state.hostExited = false; state.lpacExited = true;
  state.mode = "spawn"; state.exitCode = 1; state.fault = ""; state.failurePinChecks = 0; state.failurePinClosed = false;
  state.files.set("C:\\Build\\build-receipt.json", Buffer.from("{}")); state.files.set("C:\\Build\\source-node.exe", Buffer.from(state.asset)); state.files.set("C:\\Build\\bootstrap.exe", Buffer.from(state.bootstrap));
});
afterEach(() => vi.useRealTimers());
function failureFrame() {
  const bytes = Buffer.alloc(48), words = [0x46434e45, 1, 1, state.mode === "spawn" ? 1 : 2, state.mode === "spawn" ? 2 : 10, 1, 1, 0, 22023005, 0, 0, 0];
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); bytes.writeInt32LE(-4092, 28); return bytes;
}
async function subject() {
  const proof = await import("../fixtures/windows-node-source-child-proof"); state.cleanup = () => new proof.WindowsNodeSourceChildProbeCleanupError();
  const api = { volumeFileSystem: () => "NTFS", windowsDirectory: () => "C:\\Windows", ownerSid: () => "S-1-5-21-123",
    profileLocalAppDataBase: () => "C:\\Profile", createProfile: (name: string) => ({ name, sid: 55n, sidText: "S-1-15-2-123" }),
    deleteProfile() { state.events.push("profile-delete"); if (state.fault === "cleanup") throw new Error("private profile uncertainty"); },
    createDirectory(file: string) {
      if (file.endsWith("\\state")) {
        state.statePath = file;
        if (state.fault !== "missing") { const bytes = failureFrame(); if (state.fault === "malformed") bytes.writeUInt32LE(0, 0); state.files.set(`${file}\\lpac-source-child-${state.mode === "spawn" ? 1 : 2}-failure.bin`, bytes); }
      }
    },
    writeNewFile(file: string, bytes: Buffer) { if (state.files.has(file)) throw new Error("fixed duplicate file"); state.files.set(file, Buffer.from(bytes)); },
    pinDirectory: () => state.nextHandle++, createJob: () => state.nextHandle++, assign(job: bigint, process: bigint) { state.processJobs.set(process, job); },
    resume() {}, verifyToken() {}, close(value: bigint) { state.events.push(`owned-close-${value}`); },
    exited(process: bigint) {
      if (process === 20n) return state.hostExited;
      if (state.fault === "root-observation") throw state.cleanup();
      if (state.lpacExited) state.events.push("lpac-root-exited"); return state.lpacExited;
    },
    jobState(job: bigint) { if (state.processJobs.get(40n) === job) state.events.push("lpac-job-zero"); return { active: 0, listed: 0 }; },
    exitCode(process: bigint) { if (process === 40n) { state.events.push("lpac-exit-code"); return state.exitCode; } return 0; },
    terminateJob(job: bigint) { if (state.processJobs.get(40n) === job) state.events.push("lpac-job-stop"); }, terminateProcess() {},
  } as unknown as WindowsLpacApi;
  return { proof, run: () => proof.runWindowsSourceNodeChildProbe({ parent: "C:\\Native", buildRoot: "C:\\Build", buildCommit: "b".repeat(40), runCommit: "c".repeat(40), mode: state.mode }, api) };
}
it.each(["spawn", "test"] as const)("actual main reads a failed %s frame only after natural root/job/observer stop and excludes writers before opening", async mode => {
  state.mode = mode; const value = await subject(), result = await value.run(); state.events.push("published");
  expect(result.lpac.exitCode).toBe(1); expect(result.lpac.report).toBeNull(); expect(result.lpac.testOutput.accepted).toBe(false);
  expect(result.lpac.failure).toEqual({ schema: 1, role: 1, mode, operation: mode === "spawn" ? 2 : 10, code: 1, errno: -4092 });
  expect(Object.isFrozen(result.lpac.failure)).toBe(true);
  const index = (name: string) => { const found = state.events.indexOf(name); expect(found, name).toBeGreaterThanOrEqual(0); return found; };
  expect(index("lpac-root-exited")).toBeLessThan(index("lpac-job-zero"));
  expect(index("lpac-job-zero")).toBeLessThan(index("lpac-observer-stop"));
  expect(index("lpac-observer-stop")).toBeLessThan(index("failure-stat"));
  expect(index("lpac-observer-require-stop")).toBeLessThan(index("failure-stat"));
  expect(index("lpac-output-writer-exclusion")).toBeLessThan(index("failure-open"));
  expect(index("failure-pin-excludes-writers")).toBeLessThan(index("failure-open"));
  expect(index("failure-read-close")).toBeLessThan(index("profile-delete"));
  expect(index("profile-delete")).toBeLessThan(index("failure-pin-close")); expect(index("failure-pin-close")).toBeLessThan(index("published"));
  expect(state.readBuffers.length).toBeGreaterThan(0); expect(state.readBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true); expect(state.descriptors.size).toBe(0);
});
it.each(["missing", "malformed"])("actual main treats %s content as no diagnosis while preserving failed compatibility and known disposal", async fault => {
  state.fault = fault; const value = await subject(), result = await value.run();
  expect(result.lpac).toMatchObject({ exitCode: 1, report: null, failure: null, testOutput: { accepted: false } });
  expect(state.events).toContain("profile-delete"); expect(state.descriptors.size).toBe(0);
  if (fault === "missing") expect(state.events).not.toContain("failure-open");
});
it("actual main leaves successful LPAC admission/report unchanged and never even inspects the diagnostic path", async () => {
  state.exitCode = 0; state.lpacExited = false; const value = await subject(), result = await value.run();
  expect(result.lpac).toMatchObject({ exitCode: 0, report: { complete: true }, testOutput: { accepted: true } });
  expect(Object.hasOwn(result.lpac, "failure")).toBe(false); expect(state.events).not.toContain("failure-stat"); expect(state.events).not.toContain("failure-open");
});
it.each(["pin-acquire", "pin-after-read", "late-pin", "read-close", "observer-stop", "reader-stop", "root-observation", "cleanup"])("actual main suppresses failure publication and fences future owners after %s uncertainty", async fault => {
  if (fault === "root-observation") vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  state.fault = fault; const value = await subject(); let published = false;
  const refused = expect(value.run().then(result => { published = true; return result; })).rejects.toBeInstanceOf(value.proof.WindowsNodeSourceChildProbeCleanupError);
  if (fault === "root-observation") await vi.advanceTimersByTimeAsync(15_010);
  await refused;
  expect(published).toBe(false); const before = state.events.length;
  await expect(value.run()).rejects.toBeInstanceOf(value.proof.WindowsNodeSourceChildProbeCleanupError); expect(state.events).toHaveLength(before);
  if (fault !== "cleanup") expect(state.events).not.toContain("profile-delete");
  expect(state.failurePinClosed).toBe(false);
  if (["observer-stop", "reader-stop", "root-observation"].includes(fault)) expect(state.events).not.toContain("failure-open");
  if (fault === "late-pin" || fault === "cleanup") expect(state.events).toContain("failure-read-close");
  if (fault === "pin-after-read" || fault === "read-close") expect(state.readBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
});
