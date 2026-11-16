/** Real new proof/lifecycle with synthetic Win32 and file handles. No PE or native API executes. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), descriptors: new Map<number, string>(), events: [] as string[], readBuffers: [] as Buffer[],
  nextHandle: 100n, nextFd: 10, statePath: "", toolsPath: "", outputBuffers: [] as Buffer[], fault: "", exit: 0, cleanup: () => new Error("unbound cleanup"),
  asset: Buffer.from("MZfixed-source-node"), bootstrap: Buffer.from("MZfixed-bootstrap"), receipt: Buffer.from("{}") }));
vi.mock("node:path", async original => { const actual = await original<typeof import("node:path")>(); return { ...actual, default: actual.win32 }; });
vi.mock("node:fs", () => {
  const stat = (file: string) => {
    const bytes = state.files.get(file); if (!bytes) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
    return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: bytes.length, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1 };
  };
  return { default: { constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 }, realpathSync: { native: (file: string) => file }, lstatSync: stat,
    existsSync: (file: string) => state.files.has(file),
    openSync(file: string) { stat(file); if (file.endsWith("-report.bin")) state.events.push("report-open"); const fd = state.nextFd++; state.descriptors.set(fd, file); return fd; },
    fstatSync: (fd: number) => stat(state.descriptors.get(fd)!),
    readSync(fd: number, target: Buffer, offset: number, length: number, position: number) {
      const file = state.descriptors.get(fd)!;
      if (file.endsWith("-report.bin")) { state.events.push("report-read"); state.readBuffers.push(target); }
      return state.files.get(file)!.copy(target, offset, position, position + length);
    },
    closeSync(fd: number) {
      if (state.descriptors.get(fd)?.endsWith("-report.bin")) { state.events.push("report-read-close"); if (state.fault === "read-close") throw new Error("private read close"); }
      state.descriptors.delete(fd);
    },
    rmSync(root: string) { state.events.push("scratch-remove"); if (state.fault === "scratch") throw new Error("private cleanup"); for (const file of [...state.files.keys()]) if (file.startsWith(root + "\\")) state.files.delete(file); },
  } };
});
vi.mock("../../scripts/experimental/windows-node-cng-artifact-pin.json", async () => {
  const { createHash } = await import("node:crypto");
  const pin = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return { default: { compileCommit: "b".repeat(40), verifiedFiles: { "source-node.exe": pin(state.asset), "bootstrap.exe": pin(state.bootstrap), "build-receipt.json": pin(state.receipt) } } };
});
vi.mock("../../scripts/experimental/build-windows-node-source.mjs", async () => {
  const { createHash } = await import("node:crypto");
  const item = (name: string, bytes: Buffer) => ({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return { parseWindowsNodeSourceBuildReceipt: () => ({ assets: {
    node: item("source-node.exe", state.fault === "coherent-image" ? Buffer.from("MZforged-source-node") : state.asset), bootstrap: item("bootstrap.exe", state.bootstrap) } }) };
});
vi.mock("../fixtures/windows-node-lpac-proof", async original => {
  const actual = await original<typeof import("../fixtures/windows-node-lpac-proof")>();
  return { ...actual, nativeChecks: () => ({ image() { state.events.push("image"); }, pin(file: string) {
    if (file.endsWith("-report.bin")) { state.events.push("report-writer-pin"); if (state.fault === "pin") throw new Error("private pin"); }
    if (!state.files.has(file)) throw new Error("synthetic pin missing");
    return { bytes: state.files.get(file)!.length, unchanged() { if (file.endsWith("-report.bin")) { state.events.push("report-pin-check"); if (state.fault === "pin-check") throw new Error("private generic pin uncertainty"); } },
      close() { state.events.push("pin-close"); if (state.fault === "pin-close") throw new Error("private pin close"); } };
  } }) };
});
vi.mock("../fixtures/windows-libuv-host-identity", async original => {
  const actual = await original<typeof import("../fixtures/windows-libuv-host-identity")>();
  return { ...actual, loadWindowsLibuvHostIdentity: () => ({ inspect: () => ({ sameUser: state.fault !== "host-identity",
    parent: { hasRestrictingSids: false, integrityRid: 12288, appContainer: 0 }, host: { hasRestrictingSids: false, integrityRid: 12288, appContainer: 0 } }) }) };
});
function report(role: number) {
  const failed = role === 1 && state.fault === "loader-failure";
  const bytes = Buffer.alloc(96), words = [0x4c534e45,1,role,5,1,failed?0:1,22023005,7,failed?1:7,failed?6:0,1,0,21,failed?2:1,failed?1:0,failed?0:1,failed?2:1,failed?1:0,failed?0:42,5,0,0,0,0];
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
}
vi.mock("../fixtures/windows-node-lpac-startup", async original => {
  const actual = await original<typeof import("../fixtures/windows-node-lpac-startup")>();
  return { ...actual, runWindowsNodeHostStartup: async (spec: { unchanged(): void; program: string; command: Buffer; cwd: string; environment: Buffer },
    _api: unknown, native: { create(...args: unknown[]): { process: bigint }; verify(value: unknown, file: string): void }) => {
    spec.unchanged(); const created = native.create(spec.program, spec.command, spec.cwd, spec.environment); native.verify(created, spec.program);
    state.events.push("host-stopped"); state.files.set(state.statePath + "\\host-cng-loader-report.bin", report(0)); return { exitCode: 0, jobStopped: true };
  } };
});
vi.mock("../fixtures/windows-node-lpac-io", async original => {
  const actual = await original<typeof import("../fixtures/windows-node-lpac-io")>();
  return { ...actual, loadWindowsNodeIo: () => ({
    createHost(_program: string, command: Buffer) { state.events.push("host-create"); expect(command.toString("utf16le")).toContain('"--eval"'); return { process: 20n, thread: 21n, pid: 22 }; },
    createLpac(_profile: unknown, _program: string, command: Buffer) {
      state.events.push("lpac-create"); expect(command.toString("utf16le")).toContain('"--eval"');
      state.files.set(state.statePath + "\\lpac-cng-loader-report.bin", state.fault === "report" ? Buffer.alloc(96) : report(1)); return { process: 40n, thread: 41n, pid: 42 };
    },
    acceptHostControl() { state.events.push("host-io-accepted"); },
    readAfterStopped(stopped: () => void) {
      stopped(); state.events.push("output-writer-exclusion"); stopped();
      const bytes = Buffer.alloc(0);
      state.outputBuffers.push(bytes); return bytes;
    },
    close() { state.events.push("io-close"); if (state.fault === "io-close") throw state.cleanup(); },
  }) };
});
beforeEach(() => {
  vi.resetModules(); state.files.clear(); state.descriptors.clear(); state.events.length = 0; state.readBuffers.length = 0;
  state.nextHandle = 100n; state.nextFd = 10; state.statePath = ""; state.toolsPath = ""; state.outputBuffers.length = 0; state.fault = ""; state.exit = 0;
  state.files.set("C:\\Build\\build-receipt.json", Buffer.from(state.receipt)); state.files.set("C:\\Build\\source-node.exe", Buffer.from(state.asset)); state.files.set("C:\\Build\\bootstrap.exe", Buffer.from(state.bootstrap));
});
afterEach(() => vi.useRealTimers());
async function subject() {
  const proof = await import("../fixtures/windows-node-cng-loader-proof"); state.cleanup = () => new proof.WindowsNodeCngLoaderCleanupError();
  const api = { volumeFileSystem: () => "NTFS", windowsDirectory: () => "C:\\Windows", ownerSid: () => "S-1-5-21-123", profileLocalAppDataBase: () => "C:\\Profile",
    createProfile: (name: string) => ({ name, sid: 55n, sidText: "S-1-15-2-123" }),
    deleteProfile() { state.events.push("profile-delete"); if (state.fault === "profile") throw new Error("private profile"); },
    createDirectory(file: string) { if (file.endsWith("\\state")) state.statePath = file; if (file.endsWith("\\tools")) state.toolsPath = file; },
    writeNewFile(file: string, bytes: Buffer) { if (state.files.has(file)) throw new Error("duplicate"); state.files.set(file, Buffer.from(bytes)); },
    pinDirectory: () => state.nextHandle++, createJob: () => state.nextHandle++, assign() {}, resume() {}, verifyToken() { state.events.push("token"); },
    close() { state.events.push("owner-close"); }, exited() { state.events.push("root-exited"); return true; },
    jobState() { state.events.push("job-zero"); if (state.fault === "job") throw state.cleanup(); return { active: 0, listed: 0 }; },
    exitCode: () => state.exit, terminateJob() { state.events.push("stop-job"); }, terminateProcess() {},
  } as unknown as WindowsLpacApi;
  return { proof, run: (commit = "b".repeat(40)) => proof.runWindowsNodeCngLoaderProbe({ parent: "C:\\Native", buildRoot: "C:\\Build", buildCommit: commit, runCommit: "c".repeat(40) }, api) };
}

it("runs host before LPAC, pins stopped reports, clears read buffers and publishes only after all cleanup", async () => {
  const value = await subject(), result = await value.run(); state.events.push("published");
  expect(result.issuer).toBe("ember-experimental-source-node-cng-loader"); expect(result.cleanupComplete).toBe(true);
  expect(result.host.report).toMatchObject({ role: 0, complete: true, successful: true }); expect(result.lpac.report).toMatchObject({ role: 1, complete: true, successful: true });
  const index = (name: string) => { const value = state.events.indexOf(name); expect(value, name).toBeGreaterThanOrEqual(0); return value; };
  expect(index("host-stopped")).toBeLessThan(index("lpac-create")); expect(index("host-io-accepted")).toBeLessThan(index("lpac-create"));
  expect(index("report-writer-pin")).toBeLessThan(index("report-open")); expect(index("report-read-close")).toBeLessThan(index("profile-delete"));
  expect(index("profile-delete")).toBeLessThan(index("pin-close")); expect(index("pin-close")).toBeLessThan(index("scratch-remove"));
  expect(index("scratch-remove")).toBeLessThan(index("published")); expect(state.descriptors.size).toBe(0);
  expect(new Set(state.readBuffers).size).toBe(2); expect(state.readBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
});
it("does not reinterpret a naturally failed root as a passing loader test", async () => {
  state.exit = 1; const value = await subject(), result = await value.run(); expect(result.lpac.exitCode).toBe(1); expect(result.cleanupComplete).toBe(true);
});
it("publishes closed failed loader operations after known cleanup without treating them as compatibility", async () => {
  state.exit = 1; state.fault = "loader-failure"; const value = await subject(), result = await value.run();
  expect(result.lpac.exitCode).toBe(1); expect(result.lpac.report).toMatchObject({ complete: true, successful: false,
    operations: [{operation:1,status:1,code:0,value:21},{operation:2,status:2,code:1,value:0},{operation:3,status:2,code:1,value:0}] });
  expect(result.cleanupComplete).toBe(true); expect(JSON.stringify(result.lpac)).not.toMatch(/message|path|stack|TAP|Native/);
});
it.each(["receipt", "image", "coherent-image"])("refuses immutable-artifact %s forgery before launching a root", async fault => {
  const value = await subject(); state.fault = fault;
  if (fault === "receipt") state.files.set("C:\\Build\\build-receipt.json", Buffer.from('{"forged":1}'));
  else state.files.set("C:\\Build\\source-node.exe", Buffer.from("MZforged-source-node"));
  await expect(value.run()).rejects.toThrow("fixed source Node loader probe failed"); expect(state.events).not.toContain("host-create"); expect(state.events).not.toContain("lpac-create");
});
it("refuses an arbitrary compile identity before acquiring native ownership", async () => {
  const value = await subject(); await expect(value.run("a".repeat(40))).rejects.toThrow("exact existing CNG build"); expect(state.events).toHaveLength(0);
});
it.each(["pin", "pin-check", "read-close", "job", "io-close", "profile", "pin-close", "scratch"])("suppresses publication and fences later work after %s uncertainty", async fault => {
  const value = await subject(); state.fault = fault; let published = false;
  if (fault === "job") vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  const refused = expect(value.run().then(result => { published = true; return result; })).rejects.toBeInstanceOf(value.proof.WindowsNodeCngLoaderCleanupError);
  if (fault === "job") await vi.advanceTimersByTimeAsync(30_100);
  await refused;
  expect(published).toBe(false); const count = state.events.length; await expect(value.run()).rejects.toBeInstanceOf(value.proof.WindowsNodeCngLoaderCleanupError); expect(state.events).toHaveLength(count);
  if (fault !== "scratch") expect(state.events).not.toContain("scratch-remove");
  if (fault === "pin-check" || fault === "read-close") {
    expect(state.readBuffers.length).toBeGreaterThan(0); expect(state.readBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  }
});
