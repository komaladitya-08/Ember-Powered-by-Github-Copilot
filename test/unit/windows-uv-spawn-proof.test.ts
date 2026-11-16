/** Real main/fixture/Stop/decoder/disposal, with synthetic native and filesystem boundaries only. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const state = vi.hoisted(() => ({
  files: new Map<string, Buffer>(), descriptors: new Map<number, string>(), events: [] as string[], buffers: [] as Buffer[], jobs: new Map<bigint, bigint>(),
  nextHandle: 100n, nextFd: 10, observers: 0, statePath: "", hostExited: false, lpacExited: true, useful: false, fault: "", reportChecks: 0,
  asset: Buffer.from("MZfixed-uv-spawn"), cleanup: () => new Error("synthetic cleanup not bound"),
}));
vi.mock("node:path", async original => { const actual = await original<typeof import("node:path")>(); return { ...actual, default: actual.win32 }; });
vi.mock("node:fs", () => {
  const stat = (file: string) => {
    const bytes = state.files.get(file); if (!bytes) throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
    if (file.endsWith("-uv-spawn-report.bin")) state.events.push("report-stat");
    return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: bytes.length, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1 };
  };
  return { default: { constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 }, realpathSync: { native: (file: string) => file }, lstatSync: stat,
    openSync(file: string) { stat(file); const fd = state.nextFd++; state.descriptors.set(fd, file); if (file.endsWith("lpac-uv-spawn-report.bin")) state.events.push("lpac-report-open"); return fd; },
    fstatSync: (fd: number) => stat(state.descriptors.get(fd)!),
    readSync(fd: number, target: Buffer, offset: number, length: number, position: number) {
      const file = state.descriptors.get(fd)!; if (file.endsWith("lpac-uv-spawn-report.bin")) { state.events.push("lpac-report-read"); state.buffers.push(target); }
      return state.files.get(file)!.copy(target, offset, position, position + length);
    },
    closeSync(fd: number) { const file = state.descriptors.get(fd)!; if (file.endsWith("lpac-uv-spawn-report.bin")) { state.events.push("lpac-report-fs-close"); if (state.fault === "read-close") throw new Error("private path"); } state.descriptors.delete(fd); },
  } };
});
vi.mock("../../scripts/experimental/build-windows-uv-spawn-probe.mjs", async () => {
  const { createHash } = await import("node:crypto");
  return { buildPin: { issuer: "fixed-test-only-issuer", maximumExecutableBytes: 16 * 1024 * 1024, maximumReceiptBytes: 32768 }, windowsUvSpawnImageFingerprint() {},
    parseWindowsUvSpawnBuildReceipt: () => ({ assets: { probe: { name: "uv-spawn-probe.exe", bytes: state.asset.length, sha256: createHash("sha256").update(state.asset).digest("hex") } } }) };
});
vi.mock("../fixtures/windows-libuv-host-identity", async original => {
  const actual = await original<typeof import("../fixtures/windows-libuv-host-identity")>();
  return { ...actual, loadWindowsLibuvHostIdentity: () => ({ inspect: (process: bigint) => ({ sameUser: state.fault !== "foreign-host" || process !== 20n, parent: { appContainer: 0, integrityRid: 12288, hasRestrictingSids: false }, host: { appContainer: 0, integrityRid: 12288, hasRestrictingSids: false } }) }) };
});
function report(role: 0 | 1, useful: boolean) {
  const words = Array<number>(64).fill(0);
  [0x53565545, 1, role, 1, 6, 31, 0, 7, useful ? 0 : -4048, 1, Number(useful), Number(useful), 0, 0, 1, 7, Number(useful), Number(useful), useful ? 12 : 0, useful ? 14 : 0].forEach((value, index) => { words[index] = value; });
  words[25] = 13; words[26] = 5; words[27] = Number(useful);
  [[3, 3, 1, 9], [3, 3, 1, 10], [3, 0, 0, 11], [3, 3, 1, 12], [1, Number(useful), Number(useful), 13]].forEach((row, index) => words.splice(32 + index * 4, 4, ...row));
  if (!useful) { words[28] = 1; words[29] = 5; words[30] = -4048; words[31] = 13; }
  for (let index = 52; index < 58; index += 2) { words[index] = 1 - role; words[index + 1] = role ? 5 : 0; }
  const bytes = Buffer.alloc(256); words.forEach((value, index) => bytes.writeUInt32LE(value >>> 0, index * 4)); return bytes;
}
vi.mock("../fixtures/windows-uv-spawn-native", () => ({
  loadWindowsUvSpawnChecks: () => ({ image() { state.events.push("image-check"); }, pin(file: string, maximum: number) {
    if (file.endsWith("lpac-uv-spawn-report.bin")) { state.events.push("report-writer-pin"); expect(maximum).toBe(256); if (state.fault === "pin-acquire") throw new Error("private native uncertainty"); }
    if (!state.files.has(file)) throw new Error("synthetic pin missing");
    return { file, bytes: state.files.get(file)!.length, unchanged() {
      if (file.endsWith("lpac-uv-spawn-report.bin")) { state.events.push("report-pin-stable"); state.reportChecks++; if (state.fault === "pin-after-read" && state.reportChecks === 1 || state.fault === "late-pin" && state.reportChecks === 2) throw state.cleanup(); }
    }, close() { state.events.push(file.endsWith("lpac-uv-spawn-report.bin") ? "report-pin-close" : "asset-pin-close"); } };
  } }),
  loadWindowsUvSpawnJob: () => ({ setTwo() { state.events.push("outer-job-two"); } }),
  loadWindowsUvSpawnIo: (_directory: string, _profile: unknown, _api: unknown, role: string) => ({
    createHost: () => ({ process: 20n, thread: 21n, pid: 22 }), createLpac: () => ({ process: 40n, thread: 41n, pid: 42 }),
    readAfterStopped(stopped: () => void) { stopped(); state.events.push(`${role}-output-stop`); return Buffer.alloc(0); }, close() { state.events.push(`${role}-io-close`); },
  }),
  loadWindowsUvSpawnObserver: () => {
    const role = state.observers++ === 0 ? "host" : "lpac";
    let binding: { current(): boolean; verifyToken(process: bigint): void; grant(pid: number): void } | undefined, stopped = false;
    return { bind(value: typeof binding) { binding = value; state.events.push(`${role}-bind`); },
      admit() { if (role === "lpac" && !state.useful) return null; expect(binding!.current()).toBe(true); binding!.verifyToken(role === "host" ? 30n : 50n); binding!.grant(77);
        state.events.push(`${role}-ACK`); state.files.set(`${state.statePath}\\${role}-uv-spawn-report.bin`, report(role === "host" ? 0 : 1, true));
        if (role === "host") state.hostExited = true; else state.lpacExited = true; return 77; },
      waitStoppedBefore() { state.events.push(`${role}-child-stop`); if (role === "lpac" && state.fault === "child-stop") throw state.cleanup(); stopped = true; },
      requireStopped() { if (!stopped) throw state.cleanup(); state.events.push(`${role}-require-stop`); },
      closeStopped() { expect(stopped).toBe(true); state.events.push(`${role}-child-close`); },
    };
  },
}));
beforeEach(() => {
  vi.resetModules(); state.files.clear(); state.descriptors.clear(); state.jobs.clear(); state.events.length = 0; state.buffers.length = 0;
  state.nextHandle = 100n; state.nextFd = 10; state.observers = 0; state.statePath = ""; state.hostExited = false; state.lpacExited = true; state.useful = false; state.fault = ""; state.reportChecks = 0;
  state.files.set("C:\\Build\\build-receipt.json", Buffer.from("{}")); state.files.set("C:\\Build\\uv-spawn-probe.exe", Buffer.from(state.asset));
});
afterEach(() => vi.useRealTimers());
async function subject() {
  const proof = await import("../fixtures/windows-uv-spawn-proof"), ownership = await import("../fixtures/windows-uv-spawn-ownership"); state.cleanup = () => new ownership.WindowsUvSpawnCleanupError();
  const api = { volumeFileSystem: () => "NTFS", windowsDirectory: () => "C:\\Windows", ownerSid: () => "S-1-5-21-123", profileLocalAppDataBase: () => "C:\\Profile",
    createProfile: (name: string) => ({ name, sid: 55n, sidText: "S-1-15-2-123" }), deleteProfile() { state.events.push("profile-delete"); if (state.fault === "cleanup") throw new Error("private path"); },
    createDirectory(file: string) { if (file.endsWith("\\state")) { state.statePath = file; const bytes = report(1, false); if (state.fault === "malformed") bytes.writeUInt32LE(0, 0); state.files.set(`${file}\\lpac-uv-spawn-report.bin`, bytes); } },
    writeNewFile(file: string, bytes: Buffer) { if (state.files.has(file)) throw new Error("synthetic duplicate"); state.files.set(file, Buffer.from(bytes)); }, pinDirectory: () => state.nextHandle++, createJob: () => state.nextHandle++,
    assign(job: bigint, process: bigint) { state.jobs.set(process, job); }, resume() {}, verifyToken() {}, close() { state.events.push("native-close"); },
    exited(process: bigint) { if (process === 20n) return state.hostExited; if (state.fault === "root-query") throw state.cleanup(); if (state.lpacExited) state.events.push("lpac-natural-exit"); return state.lpacExited; },
    jobState(job: bigint) { if (state.jobs.get(40n) === job) state.events.push("lpac-job-zero"); return { active: 0, listed: 0 }; },
    exitCode(process: bigint) { if (process === 40n) { state.events.push("lpac-exit0"); if (state.fault === "nonzero") return 101; } return 0; },
    terminateJob() { state.events.push("non-disposing-job-stop"); }, terminateProcess() { state.hostExited = true; state.lpacExited = true; },
  } as unknown as WindowsLpacApi;
  return { ownership, proof, run: () => proof.runWindowsUvSpawnProbe({ parent: "C:\\Native", buildRoot: "C:\\Build", commit: "b".repeat(40) }, api) };
}

it("actual main publishes only a stopped closed refusal after the ordinary useful route and complete cleanup", async () => {
  const value = await subject(), result = await value.run(); state.events.push("published");
  expect(result.host.report.useful).toBe(true); expect(result.lpac).toMatchObject({ exitCode: 0, jobStopped: true, admitted: false, report: { useful: false, spawnResult: -4048, ledger: { translation: { input: 5, result: -4048 } } } });
  const at = (event: string) => { const index = state.events.indexOf(event); expect(index, event).toBeGreaterThanOrEqual(0); return index; };
  expect(at("host-ACK")).toBeLessThan(at("lpac-bind")); expect(at("lpac-natural-exit")).toBeLessThan(at("lpac-job-zero"));
  expect(at("lpac-job-zero")).toBeLessThan(at("lpac-child-stop")); expect(at("lpac-child-stop")).toBeLessThan(at("report-writer-pin"));
  expect(at("report-writer-pin")).toBeLessThan(at("lpac-report-open")); expect(at("lpac-report-fs-close")).toBeLessThan(at("profile-delete"));
  expect(at("profile-delete")).toBeLessThan(at("report-pin-close")); expect(at("report-pin-close")).toBeLessThan(at("published"));
  expect(state.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true); expect(state.descriptors.size).toBe(0);
});
it("requires actual observer ACK before reporting the LPAC useful-child success", async () => {
  state.useful = true; state.lpacExited = false; const value = await subject(), result = await value.run();
  expect(result.lpac).toMatchObject({ admitted: true, report: { useful: true, stdinBytes: 12, stdoutBytes: 14 } }); expect(state.events).toContain("lpac-ACK");
});
it("rejects malformed numeric content while retaining known cleanup authority", async () => {
  state.fault = "malformed"; const value = await subject(); await expect(value.run()).rejects.not.toBeInstanceOf(value.ownership.WindowsUvSpawnCleanupError);
  expect(state.events).toContain("profile-delete"); expect(state.events).toContain("report-pin-close");
});
it.each(["pin-acquire", "pin-after-read", "late-pin", "read-close", "child-stop", "root-query", "nonzero", "cleanup"])("suppresses readout and fences all later probes after %s uncertainty", async fault => {
  if (fault === "root-query") vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  state.fault = fault; const value = await subject(); let published = false;
  const refused = expect(value.run().then(result => { published = true; return result; })).rejects.toBeInstanceOf(value.ownership.WindowsUvSpawnCleanupError);
  if (fault === "root-query") await vi.advanceTimersByTimeAsync(15_010); await refused;
  expect(published).toBe(false); expect(state.events).not.toContain("report-pin-close"); const before = state.events.length;
  await expect(value.run()).rejects.toBeInstanceOf(value.ownership.WindowsUvSpawnCleanupError); expect(state.events).toHaveLength(before);
  if (fault !== "cleanup") expect(state.events).not.toContain("profile-delete");
  if (["child-stop", "root-query", "nonzero"].includes(fault)) expect(state.events).not.toContain("lpac-report-open");
  if (["read-close", "pin-after-read"].includes(fault)) expect(state.buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
});
it("never launches LPAC when the host fails its ordinary-context useful prerequisite", async () => {
  state.fault = "foreign-host"; const value = await subject(); await expect(value.run()).rejects.toThrow("host-report"); expect(state.events).not.toContain("lpac-bind");
});
