import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ spawn: vi.fn(), parse: vi.fn(), read: vi.fn(), image: vi.fn(), object: vi.fn(), snapshot: vi.fn(), environment: vi.fn(), exists: vi.fn(), mkdir: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocked.spawn }));
vi.mock("../../scripts/experimental/build-windows-uv-observer-abi.mjs", () => ({ parseWindowsUvObserverAbiBuildReceipt: mocked.parse }));
vi.mock("../../scripts/experimental/build-windows-uv-spawn-probe.mjs", () => ({ buildPin: { maximumReceiptBytes: 32768, pythonExecutable: "C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe" }, windowsUvSpawnBuildEnvironment: mocked.environment }));
vi.mock("../../scripts/experimental/windows-uv-observer-abi-image.mjs", () => ({ inspectWindowsUvObserverAbiImage: mocked.image, inspectWindowsUvObserverAbiObject: mocked.object }));
vi.mock("../../scripts/experimental/windows-uv-observer-abi-files.mjs", async original => ({ ...await original<object>(), ordinaryAbiWindowsPath: (value: string) => value, readWindowsUvObserverAbiFile: mocked.read, windowsUvObserverAbiFileFingerprint: mocked.snapshot }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, existsSync: mocked.exists, mkdirSync: mocked.mkdir, writeFileSync: mocked.write, rmSync: mocked.remove } };
});
// @ts-expect-error -- actual fixed ordinary-host runner with native/process seams replaced; no Windows invocation
import { runWindowsUvObserverAbi as run, classifyWindowsUvObserverAbiProcess as classify, classifyWindowsUvObserverAbiRunFailure as failure } from "../../scripts/experimental/run-windows-uv-observer-abi.mjs";
const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const commit = "b".repeat(40), buildRoot = "D:\\fixed", env = { SystemRoot: "C:\\Windows", PATH: "trusted" };
const fingerprint = { bytes: 4, sha256: "a".repeat(64) };
const image = { bytes: 1024, sha256: "c".repeat(64), importModules: 1, namedImports: 3, forbiddenImports: 0, ordinalImports: 0, delayImports: 0 };
const receipt = { commit, observerObject: fingerprint, assets: { control: { name: "observer-abi-control.exe", ...image }, license: { name: "LICENSE", ...fingerprint } } };
let order: string[];
function frame() {
  const values = [0x31494241, 1, 1, 0, 96, 96, 96, 96, 127, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < 6; index++) values.push(index + 1, 16, 16, 32, 32, 32, 32, 8);
  const bytes = Buffer.alloc(256); values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes;
}
beforeEach(() => {
  Object.values(mocked).forEach(mock => mock.mockReset()); order = [];
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  vi.stubEnv("EMBER_UV_OBSERVER_ABI_CONTROL", "1"); vi.stubEnv("GITHUB_SHA", commit);
  mocked.exists.mockReturnValue(false); mocked.environment.mockReturnValue(env); mocked.parse.mockReturnValue(receipt);
  mocked.read.mockImplementation((file: string) => { order.push(`read:${path.basename(file)}`); return Buffer.from("fixed"); });
  mocked.image.mockImplementation(() => { order.push("image"); return image; }); mocked.object.mockImplementation(() => { order.push("object"); return fingerprint; });
  mocked.snapshot.mockReturnValue(fingerprint);
  mocked.spawn.mockImplementation(() => { order.push("spawn"); return { status: 0, signal: null, stdout: frame(), stderr: Buffer.alloc(0) }; });
  mocked.write.mockImplementation(() => { order.push("publish"); });
});
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const invoke = () => run({ buildRoot, expectedCommit: commit });
function refused() {
  try { invoke(); } catch (error) { return failure(error); }
  throw new Error("The fixed runner fault fixture unexpectedly passed.");
}

it("executes only the verified fixed image once and publishes object-bound proof after natural exit and postchecks", () => {
  const result = invoke(); expect(result).toMatchObject({ scope: "ordinary-host-only", compileCommit: commit, runCommit: commit, observerObject: fingerprint, report: { cases: 96, checks: 127 } });
  expect(mocked.spawn).toHaveBeenCalledExactlyOnceWith(path.join(buildRoot, "observer-abi-control.exe"), [], expect.objectContaining({ env, encoding: "buffer", timeout: 15000, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
  expect(order.indexOf("spawn")).toBeGreaterThan(order.indexOf("object")); expect(order.indexOf("publish")).toBe(order.length - 1);
  expect(order.filter(value => value === "image")).toHaveLength(2); expect(order.filter(value => value === "object")).toHaveLength(2);
  expect(mocked.write).toHaveBeenCalledExactlyOnceWith(path.join(buildRoot, "abi-result.json"), expect.any(String), { flag: "wx" });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.runtimeRecipe)).toBe(true); expect(mocked.remove).not.toHaveBeenCalled();
});

it.each([
  { status: 7, signal: null }, { status: null, signal: "SIGTERM" }, { status: 0, signal: null, error: { code: "EIO" } },
  { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }, { status: -1, signal: null },
])("never acquires streams or publishes after nonzero, signal, contradictory or unknown process results", fields => {
  let reads = 0;
  const raw = Object.defineProperties({ ...fields }, { stdout: { get() { reads++; throw new Error("private"); } }, stderr: { get() { reads++; throw new Error("private"); } } });
  mocked.spawn.mockReturnValue(raw);
  const result = refused(); expect(result.stage).toBe(5); expect(reads).toBe(0); expect(mocked.write).not.toHaveBeenCalled(); expect(mocked.remove).not.toHaveBeenCalled();
});

it.each(["receipt", "image", "object", "license"])("refuses before launch when initial %s identity is not established", field => {
  if (field === "receipt") mocked.parse.mockImplementation(() => { throw new Error("private"); });
  if (field === "image") mocked.image.mockReturnValue({ ...image, forbiddenImports: 1 });
  if (field === "object") mocked.object.mockReturnValue({ ...fingerprint, sha256: "f".repeat(64) });
  if (field === "license") mocked.snapshot.mockReturnValue({ ...fingerprint, sha256: "f".repeat(64) });
  refused(); expect(mocked.spawn).not.toHaveBeenCalled(); expect(mocked.write).not.toHaveBeenCalled(); expect(mocked.remove).not.toHaveBeenCalled();
});

it.each(["short", "malformed", "stderr", "image-change", "object-change", "receipt-change", "publish"])("suppresses proof and retains staging after %s failure", mode => {
  if (mode === "short") mocked.spawn.mockReturnValue({ status: 0, signal: null, stdout: Buffer.alloc(255), stderr: Buffer.alloc(0) });
  if (mode === "malformed") mocked.spawn.mockReturnValue({ status: 0, signal: null, stdout: Buffer.alloc(256), stderr: Buffer.alloc(0) });
  if (mode === "stderr") mocked.spawn.mockReturnValue({ status: 0, signal: null, stdout: frame(), stderr: Buffer.from("private") });
  if (mode === "image-change") mocked.image.mockReturnValueOnce(image).mockReturnValue({ ...image, sha256: "f".repeat(64) });
  if (mode === "object-change") mocked.object.mockReturnValueOnce(fingerprint).mockReturnValue({ ...fingerprint, sha256: "f".repeat(64) });
  if (mode === "receipt-change") mocked.read.mockImplementation((file: string) => Buffer.from(file.endsWith("abi-build-receipt.json") && mocked.spawn.mock.calls.length ? "changed" : "fixed"));
  if (mode === "publish") mocked.write.mockImplementation(() => { throw new Error("private"); });
  const result = refused(); expect(result.status).toBe("failed"); expect(JSON.stringify(result)).not.toContain("private");
  if (mode !== "publish") expect(mocked.write).not.toHaveBeenCalled(); expect(mocked.remove).not.toHaveBeenCalled();
});

it("keeps owned process classification numeric and never reads caught or forged error properties", () => {
  let reads = 0; const hostile = new Proxy({}, { get() { reads++; throw new Error("private"); } });
  mocked.spawn.mockImplementation(() => { throw hostile; }); expect(refused()).toMatchObject({ stage: 5, process: { outcome: 0 } }); expect(reads).toBe(0);
  expect(failure(hostile)).toEqual({ schema: 1, status: "failed", stage: 0 }); expect(reads).toBe(0);
  expect(classify({ status: 0, signal: null, error: false }).outcome).toBe(4);
  expect(classify({ status: 0xffffffff, signal: null })).toMatchObject({ outcome: 2, status: 0xffffffff });
});

it("fails missing requirements and preexisting runtime directories instead of retrying a control", () => {
  vi.stubEnv("EMBER_UV_OBSERVER_ABI_CONTROL", ""); expect(refused().stage).toBe(1); expect(mocked.spawn).not.toHaveBeenCalled();
  vi.stubEnv("EMBER_UV_OBSERVER_ABI_CONTROL", "1"); mocked.exists.mockReturnValue(true); expect(refused().stage).toBe(4); expect(mocked.spawn).not.toHaveBeenCalled();
});

it("invalid CLI arguments emit only fixed metadata without executing Windows code", () => {
  const script = new URL("../../scripts/experimental/run-windows-uv-observer-abi.mjs", import.meta.url);
  const result = native.spawnSync(process.execPath, [fileURLToPath(script), "--private-invalid"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
  expect(result.status === 1 && result.stdout.length === 0, "The refused CLI must exit without control output.").toBe(true);
  expect(result.stderr === '{"schema":1,"status":"failed","stage":0}\n', "The refused CLI must emit only its fixed metadata.").toBe(true);
  expect(fs.existsSync).toBe(mocked.exists);
});
