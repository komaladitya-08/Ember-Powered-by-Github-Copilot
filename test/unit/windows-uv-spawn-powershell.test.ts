import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- fixed trusted-host process capture and closed own-data classifier, outside the application TypeScript build
import { captureWindowsUvSpawnPowerShell, acceptedPowerShellStdout, powerShellProcessDiagnostic, classifyOwnedPowerShellResult } from "../../scripts/experimental/windows-uv-spawn-powershell.mjs";
// @ts-expect-error -- opaque capture observations are snapshotted by the existing privately branded diagnostic factory
import { createUvSpawnBuildDiagnostic } from "../../scripts/experimental/windows-uv-spawn-build-diagnostic.mjs";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
const nativeChild = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const directories: string[] = [];
const temp = () => { const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-uv-powershell-unit-")); directories.push(directory); return directory; };
afterEach(() => { spawn.mockReset(); vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const unknown = { schema: 1, outcome: 0, status: null, signal: 255, errorPresence: 2, errorCode: 0 };
const result = (fields: object = {}) => ({ status: 0, signal: null, stdout: " public fixture \n", ...fields });
const environment = () => Object.fromEntries(["SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP"].filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]!]));
const realNode = (program: string, options: { timeout?: number; maxBuffer?: number } = {}) => nativeChild.spawnSync(process.execPath, ["-e", program], {
  env: environment(), cwd: temp(), encoding: "utf8", timeout: 5000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options,
});

it("makes exactly one attempt with every original option, preserving argument references and success trimming", () => {
  const program = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args = ["-NoLogo", "fixed public fixture"], env = { SystemRoot: "C:\\Windows" }, cwd = "D:\\fresh";
  spawn.mockReturnValue(result()); const token = captureWindowsUvSpawnPowerShell(program, args, env, cwd);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(program, args, { env, cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  expect(spawn.mock.calls[0][1]).toBe(args); expect(spawn.mock.calls[0][2].env).toBe(env);
  expect(acceptedPowerShellStdout(token)).toBe("public fixture");
  expect(powerShellProcessDiagnostic(token)).toEqual({ schema: 1, outcome: 1, status: 0, signal: 0, errorPresence: 0, errorCode: 0 });
  expect(Object.isFrozen(token)).toBe(true); expect(Reflect.ownKeys(token).length).toBe(0); expect(JSON.stringify(token)).toBe("{}");
  expect((token as { stdout?: unknown }).stdout).toBeUndefined();
});

it("returns the same private trimmed success output from an actual Node fixture with the fixed production options", () => {
  spawn.mockImplementation(nativeChild.spawnSync);
  const token = captureWindowsUvSpawnPowerShell(process.execPath, ["-e", "process.stdout.write('  public fixture\\n')"], environment(), temp());
  expect(powerShellProcessDiagnostic(token).outcome).toBe(1); expect(acceptedPowerShellStdout(token)).toBe("public fixture"); expect(spawn).toHaveBeenCalledTimes(1);
});

it("classifies actual nonzero, absent executable, timeout and buffer-limit process faults without inspecting logs", () => {
  expect(classifyOwnedPowerShellResult(realNode("process.exit(23)"))).toEqual({ schema: 1, outcome: 2, status: 23, signal: 0, errorPresence: 0, errorCode: 0 });
  const missing = nativeChild.spawnSync(path.join(temp(), "absent-public-tool.exe"), [], { env: environment(), cwd: temp(), encoding: "utf8", timeout: 1000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  expect(classifyOwnedPowerShellResult(missing)).toMatchObject({ outcome: 4, errorPresence: 1, errorCode: 1 });
  expect(classifyOwnedPowerShellResult(realNode("setInterval(() => {}, 1000)", { timeout: 150 }))).toMatchObject({ outcome: 4, errorPresence: 1, errorCode: 3 });
  expect(classifyOwnedPowerShellResult(realNode("process.stdout.write('x'.repeat(1024 * 1024))"))).toMatchObject({ outcome: 4, errorPresence: 1, errorCode: 4 });
});

it("classifies an actual terminated Node fixture as a refused process outcome", () => {
  const diagnostic = classifyOwnedPowerShellResult(realNode("process.kill(process.pid, 'SIGTERM')"));
  if (process.platform === "win32") expect(diagnostic.outcome === 2 || diagnostic.outcome === 3).toBe(true);
  else expect(diagnostic).toMatchObject({ outcome: 3, status: null, signal: 1, errorPresence: 0 });
});

it.each(["ENOENT", "EACCES", "ETIMEDOUT", "ENOBUFS", "E2BIG", "ENOMEM", "EINVAL", "EPERM", "ENOEXEC", "EIO", "EMFILE", "ENFILE", "ENOTDIR", "EISDIR", "EBADF", "ENOTSUP"])("projects only the fixed own-data error-code ID for %s", code => {
  const values = ["ENOENT", "EACCES", "ETIMEDOUT", "ENOBUFS", "E2BIG", "ENOMEM", "EINVAL", "EPERM", "ENOEXEC", "EIO", "EMFILE", "ENFILE", "ENOTDIR", "EISDIR", "EBADF", "ENOTSUP"];
  expect(classifyOwnedPowerShellResult(result({ status: null, error: { code } }))).toEqual({ schema: 1, outcome: 4, status: null, signal: 0, errorPresence: 1, errorCode: values.indexOf(code) + 1 });
});

it.each([new Error("private"), null, false, 0, "private", {}, () => undefined])("refuses status zero with any defined extra error", error => {
  const raw = result({ error }); spawn.mockReturnValue(raw); const token = captureWindowsUvSpawnPowerShell("fixed", [], {}, "fixed");
  expect(powerShellProcessDiagnostic(token)).toMatchObject({ outcome: 4, status: 0, errorPresence: 1 });
  expect(() => acceptedPowerShellStdout(token)).toThrow("fixed PowerShell capture was refused"); expect(spawn).toHaveBeenCalledTimes(1);
});

it("accepts missing or own-data undefined error, but keeps unknown codes, nonzero exits and signals refused", () => {
  expect(classifyOwnedPowerShellResult(result({ error: undefined })).outcome).toBe(1);
  expect(classifyOwnedPowerShellResult(result({ error: { code: "private-unknown-code" } }))).toMatchObject({ outcome: 4, errorCode: 0 });
  expect(classifyOwnedPowerShellResult(result({ signal: "SIGTERM" }))).toMatchObject({ outcome: 3, signal: 1 });
  expect(classifyOwnedPowerShellResult(result({ status: 0xffffffff }))).toMatchObject({ outcome: 2, status: 0xffffffff });
  for (const raw of [result({ status: -1 }), result({ status: 0x100000000 }), result({ status: 0.5 }), result({ status: NaN }), result({ status: null }),
    result({ signal: "private-signal" }), result({ signal: undefined }), result({ stdout: null }), { signal: null, stdout: "fixture" }, Object.create({ status: 0, signal: null, stdout: "fixture" })]) {
    expect(classifyOwnedPowerShellResult(raw)).toEqual(unknown);
  }
});

it("never invokes property getters or reads stderr, output or stdout on a refused result", () => {
  let touched = 0; const trap = () => { touched++; throw new Error("private getter"); };
  for (const key of ["status", "signal", "error", "stdout"]) {
    const raw = Object.defineProperty(result(), key, { get: trap }); expect(classifyOwnedPowerShellResult(raw)).toEqual(unknown);
  }
  const error = Object.defineProperties({}, { code: { get: trap }, message: { get: trap }, stack: { get: trap } });
  expect(classifyOwnedPowerShellResult(result({ error }))).toEqual(unknown);
  const refused = Object.defineProperties(result({ status: 1 }), { stdout: { get: trap }, stderr: { get: trap }, output: { get: trap } });
  expect(classifyOwnedPowerShellResult(refused)).toMatchObject({ outcome: 2, status: 1 });
  const requested: PropertyKey[] = [];
  const proxy = new Proxy(refused, { getOwnPropertyDescriptor(target, key) { requested.push(key); return Object.getOwnPropertyDescriptor(target, key); }, get: trap, ownKeys: trap, getPrototypeOf: trap });
  expect(classifyOwnedPowerShellResult(proxy)).toMatchObject({ outcome: 2 }); expect(requested).toEqual(["status", "signal", "error"]);
  expect(touched).toBe(0);
});

it("contains descriptor traps, revoked proxies and foreign error getters without exposing any text", () => {
  let getterReads = 0;
  const thrown = Object.defineProperties({}, { message: { get() { getterReads++; throw new Error("private"); } }, stack: { get() { getterReads++; throw new Error("private"); } } });
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw thrown; }, get() { getterReads++; throw thrown; }, ownKeys() { getterReads++; throw thrown; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const raw of [hostile, revoked.proxy, result({ error: hostile })]) expect(classifyOwnedPowerShellResult(raw)).toEqual(unknown);
  spawn.mockImplementation(() => { throw hostile; }); const token = captureWindowsUvSpawnPowerShell("fixed", [], {}, "fixed");
  expect(powerShellProcessDiagnostic(token)).toEqual(unknown); expect(() => acceptedPowerShellStdout(token)).toThrow("fixed PowerShell capture was refused");
  expect(spawn).toHaveBeenCalledTimes(1); expect(getterReads).toBe(0);
  expect(JSON.stringify(powerShellProcessDiagnostic(token))).not.toMatch(/private|message|stack|path|stdout|stderr|signal[A-Z]/);
});

it("admits process facts only from this module's opaque tokens and freezes the first owned diagnostic snapshot", () => {
  spawn.mockReturnValue(result({ status: null, error: { code: "ENOENT" } })); const token = captureWindowsUvSpawnPowerShell("fixed", [], {}, "fixed");
  const diagnostic = createUvSpawnBuildDiagnostic(); diagnostic.checkpoint(7); diagnostic.subcheckpoint(1); diagnostic.observePowerShell(token);
  const first = diagnostic.failure("private"), snapshot = diagnostic.classify(first), encoded = JSON.stringify(snapshot);
  expect(snapshot.powerShellDiagnostic).toEqual({ schema: 1, outcome: 4, status: null, signal: 0, errorPresence: 1, errorCode: 1 }); expect(Object.isFrozen(snapshot.powerShellDiagnostic)).toBe(true);
  const projection = classifyOwnedPowerShellResult(result()); expect(powerShellProcessDiagnostic(projection)).toEqual(unknown);
  diagnostic.observePowerShell(projection); diagnostic.subcheckpoint(19); expect(JSON.stringify(diagnostic.classify(first))).toBe(encoded); expect(diagnostic.failure()).toBe(first);
  diagnostic.checkpoint(9); expect(JSON.stringify(diagnostic.classify(first))).toBe(encoded);
  const next = createUvSpawnBuildDiagnostic(); next.checkpoint(7); next.subcheckpoint(1); next.observePowerShell(projection);
  expect(next.classify(next.failure()).powerShellDiagnostic).toEqual(unknown);
  const hostile = new Proxy({}, { get() { throw new Error("private"); }, ownKeys() { throw new Error("private"); }, getOwnPropertyDescriptor() { throw new Error("private"); } });
  expect(powerShellProcessDiagnostic(hostile)).toEqual(unknown); expect(() => acceptedPowerShellStdout(hostile)).toThrow("fixed PowerShell capture was refused");
  next.checkpoint(9); expect(() => next.observePowerShell(token)).toThrow("fixed PowerShell observation was refused");
  const outside = createUvSpawnBuildDiagnostic(); outside.checkpoint(9); expect(outside.classify(outside.failure(token))).toEqual({ schema: 1, status: "failed", checkpoint: 9 });
});

it("binds the new capture authority and preserves the original PowerShell program, arguments and JSON stage", () => {
  const text = fs.readFileSync(new URL("../../scripts/experimental/build-windows-uv-spawn-probe.mjs", import.meta.url), "utf8");
  const body = text.slice(text.indexOf("diagnostic.subcheckpoint(versionSteps.powershellCall)"), text.indexOf("diagnostic.subcheckpoint(versionSteps.powershellJson)"));
  expect(text).toContain('"scripts/experimental/windows-uv-spawn-powershell.mjs"'); expect((body.match(/captureWindowsUvSpawnPowerShell\(/g) ?? []).length).toBe(1);
  expect(body).toContain('path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")');
  expect(body).toContain('["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",');
  expect(body).toContain('{ ...env, EMBER_BUILD_COMPILER: toolPaths.compiler, EMBER_BUILD_LINKER: toolPaths.linker }, destination)');
  expect(body).toContain("diagnostic.observePowerShell(powerShellCapture)"); expect(body).toContain("const metadataOutput = acceptedPowerShellStdout(powerShellCapture)");
  expect(body).not.toMatch(/fallback|retry|preflight|FileVersionRaw|stderr|stdout\s*:/i);
});
