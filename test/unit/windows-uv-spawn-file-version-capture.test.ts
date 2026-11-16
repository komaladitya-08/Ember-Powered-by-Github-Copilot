import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- recipe-bound trusted-host JavaScript helper, outside the application TypeScript build
import { readWindowsUvSpawnFileVersions, classifyWindowsUvSpawnFileVersionFailure } from "../../scripts/experimental/windows-uv-spawn-file-version.mjs";
// @ts-expect-error -- actual post-reader fingerprint gate; no Windows build is invoked
import { readAttestedWindowsUvSpawnToolFileVersions, buildPin } from "../../scripts/experimental/build-windows-uv-spawn-probe.mjs";
// @ts-expect-error -- private first-error projection for this one build invocation
import { createUvSpawnBuildDiagnostic } from "../../scripts/experimental/windows-uv-spawn-build-diagnostic.mjs";

const child = vi.hoisted(() => ({ spawn: vi.fn(), sync: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawnSync: child.spawn, execFileSync: child.sync }));
afterEach(() => { child.spawn.mockReset(); child.sync.mockReset(); vi.restoreAllMocks(); });
const python = "C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe";
const compiler = "C:\\trusted\\cl.exe", linker = "C:\\trusted\\link.exe", cwd = "D:\\fresh";
const env = { SystemRoot: "C:\\Windows", PATH: "trusted-only" };
const metadata = { compilerVersion: "19.44.35222.0", linkerVersion: "14.44.35222.0" };
const result = (fields: object = {}) => ({ status: 0, signal: null, stdout: JSON.stringify(metadata) + "\r\n", ...fields });
const invoke = () => readWindowsUvSpawnFileVersions(python, compiler, linker, env, cwd);
function failure() {
  try { invoke(); } catch (error) { return { error, diagnostic: classifyWindowsUvSpawnFileVersionFailure(error) }; }
  throw new Error("The fixed reader fault fixture unexpectedly succeeded.");
}

it("makes one isolated fixed-script invocation with exactly the fingerprint-bound pair and all existing capture bounds", () => {
  child.spawn.mockReturnValue(result());
  const actual = invoke(); expect(actual).toEqual(metadata); expect(Object.isFrozen(actual)).toBe(true);
  expect(child.spawn).toHaveBeenCalledTimes(1); expect(child.sync).not.toHaveBeenCalled();
  const [program, args, options] = child.spawn.mock.calls[0];
  expect(program).toBe(python); expect(args.slice(0, 2)).toEqual(["-I", "-B"]);
  expect(args[2].endsWith("windows-uv-spawn-file-version.py")).toBe(true);
  expect(args.slice(3)).toEqual(["--compiler", compiler, "--linker", linker]);
  expect(options).toEqual({ env, cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  expect(options.env).toBe(env);
});

it.each(["019.044.035222.0", "19.44.35222"])("returns admitted original spelling without reconstruction: %s", compilerVersion => {
  child.spawn.mockReturnValue(result({ stdout: JSON.stringify({ ...metadata, compilerVersion }) }));
  expect(invoke().compilerVersion).toBe(compilerVersion);
});

it.each(Array.from({ length: 16 }, (_, stage) => stage))("projects only the fixed reader's exit-1 refusal stage %s", stage => {
  child.spawn.mockReturnValue(result({ status: 1, stdout: JSON.stringify({ schema: 1, status: "failed", stage }) }));
  const { diagnostic } = failure();
  expect(diagnostic).toEqual({ schema: 1, stage, process: { schema: 1, outcome: 2, status: 1, signal: 0, errorPresence: 0, errorCode: 0 } });
  expect(Object.isFrozen(diagnostic)).toBe(true); expect(Object.isFrozen(diagnostic.process)).toBe(true);
  expect(classifyWindowsUvSpawnFileVersionFailure(Object.assign(new Error("The fixed VERSION reader was refused."), { stage }))).toBeUndefined();
});

it.each([2, 23, 0xffffffff])("does not read refused stdout for any other process status %s", status => {
  let reads = 0;
  child.spawn.mockReturnValue(Object.defineProperty(result({ status }), "stdout", { get() { reads++; throw new Error("private"); } }));
  expect(failure().diagnostic.stage).toBe(0); expect(reads).toBe(0); expect(child.spawn).toHaveBeenCalledTimes(1);
});

it.each([
  { status: null, error: { code: "ETIMEDOUT" } }, { status: 0, error: { code: "EIO" } }, { status: 1, signal: "SIGTERM" },
  { status: 1, error: false }, { status: -1 }, { status: 1.2 }, { status: null },
])("refuses process faults without inspecting stdout or forwarding captured exceptions", fields => {
  let reads = 0;
  child.spawn.mockReturnValue(Object.defineProperty(result(fields), "stdout", { get() { reads++; throw new Error("private"); } }));
  const diagnostic = failure().diagnostic;
  expect(diagnostic.stage).toBe(0); expect(reads).toBe(0); expect(JSON.stringify(diagnostic).includes("private")).toBe(false);
});

it.each([
  { status: 0, stdout: "private" }, { status: 0, stdout: "x".repeat(513) }, { status: 0, stdout: Buffer.from("private") },
  { status: 0, stdout: JSON.stringify({ ...metadata, path: "private" }) },
  { status: 0, stdout: JSON.stringify({ ...metadata, compilerVersion: "19.44.1-vendor" }) },
  { status: 0, stdout: JSON.stringify({ ...metadata, compilerVersion: "19.44.1\n" }) },
  { status: 0, stdout: JSON.stringify({ ...metadata, compilerVersion: 19 }) },
  { status: 0, stdout: '{"compilerVersion":"19.44.1","compilerVersion":"19.44.2","linkerVersion":"14.44.1"}' },
  { status: 0, stdout: '{"schema":1,"status":"failed","stage":8}' },
  { status: 1, stdout: JSON.stringify(metadata) }, { status: 1, stdout: '{"schema":1,"status":"failed","stage":16}' },
  { status: 1, stdout: '{"schema":1,"status":"failed","stage":1,"path":"private"}' },
])("keeps malformed or foreign output private and does not use it as metadata or a stage", fields => {
  child.spawn.mockReturnValue(result(fields));
  const diagnostic = failure().diagnostic;
  expect(diagnostic.stage).toBe(0); expect(JSON.stringify(diagnostic).includes("private")).toBe(false);
});

it("does not inspect a thrown foreign value, a forged failure, or any stderr accessor", () => {
  let reads = 0; const foreign = new Proxy({}, { get() { reads++; throw new Error("private"); }, ownKeys() { reads++; throw new Error("private"); } });
  child.spawn.mockImplementationOnce(() => { throw foreign; }); expect(failure().diagnostic.process.outcome).toBe(0); expect(reads).toBe(0);
  expect(classifyWindowsUvSpawnFileVersionFailure(foreign)).toBeUndefined(); expect(reads).toBe(0);
  child.spawn.mockReturnValue(Object.defineProperty(result(), "stderr", { get() { reads++; throw new Error("private"); } }));
  expect(invoke()).toEqual(metadata); expect(reads).toBe(0);
});

it("freezes the earliest phase-7 reader facts and never attaches them to another invocation or phase", () => {
  child.spawn.mockReturnValue(result({ status: 1, stdout: '{"schema":1,"status":"failed","stage":6}' }));
  const { error } = failure(), diagnostic = createUvSpawnBuildDiagnostic();
  diagnostic.checkpoint(7); diagnostic.subcheckpoint(1); diagnostic.observeFileVersionFailure(error);
  const first = diagnostic.failure(error), observed = diagnostic.classify(first);
  expect(observed.fileVersionDiagnostic.stage).toBe(6);
  diagnostic.checkpoint(8); expect(diagnostic.failure(new Error("private"))).toBe(first);
  expect(diagnostic.classify(first)).toEqual(observed);
  expect(Object.isFrozen(observed.fileVersionDiagnostic)).toBe(true);
  const other = createUvSpawnBuildDiagnostic(); other.checkpoint(8);
  expect(other.classify(first)).toEqual({ schema: 1, status: "failed", checkpoint: 0 });
  expect(() => other.observeFileVersionFailure(error)).toThrow("fixed VERSION observation");
  const foreign = createUvSpawnBuildDiagnostic(); foreign.checkpoint(7); foreign.subcheckpoint(1);
  foreign.observeFileVersionFailure({ schema: 1, stage: 6 });
  expect(foreign.classify(foreign.failure(new Error("private")))).not.toHaveProperty("fileVersionDiagnostic");
});

function mockFingerprints(changed?: string) {
  const info = { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 4, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4 };
  const files = new Map<number, string>(); let handle = 0;
  vi.spyOn(fs, "lstatSync").mockImplementation((() => info) as unknown as typeof fs.lstatSync);
  vi.spyOn(fs.realpathSync, "native").mockImplementation((value => value) as typeof fs.realpathSync.native);
  vi.spyOn(fs, "openSync").mockImplementation(((file: unknown) => { const fd = ++handle; files.set(fd, String(file)); return fd; }) as typeof fs.openSync);
  vi.spyOn(fs, "fstatSync").mockImplementation((() => info) as unknown as typeof fs.fstatSync);
  vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
    const fd = args[0] as number, buffer = args[1] as Buffer, offset = args[2] as number, position = args[4] as number;
    if (position) return 0; buffer.write(files.get(fd) === changed ? "fail" : "test", offset); return 4;
  }) as typeof fs.readSync);
}

it.each([undefined, python, compiler, linker])("actual post-reader admission requires unchanged interpreter and both tool bytes", changed => {
  mockFingerprints(changed); child.spawn.mockReturnValue(result());
  const fingerprint = { bytes: 4, sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" };
  const read = () => readAttestedWindowsUvSpawnToolFileVersions({ pythonPath: python, fingerprint }, { compiler, linker }, { compiler: fingerprint, linker: fingerprint }, env, cwd);
  if (changed) expect(read).toThrow("exact source, recipe or issuer contract"); else expect(read()).toEqual(metadata);
  expect(child.spawn).toHaveBeenCalledTimes(1); expect(child.sync).not.toHaveBeenCalled();
  expect(buildPin.pythonExecutable).toBe(python);
});
