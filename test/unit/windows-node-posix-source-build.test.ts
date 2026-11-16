import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import sourcePin from "../../scripts/experimental/windows-node-posix-source-pin.json";
// @ts-expect-error -- shared trusted-host JavaScript compile recipe and portable bounded receipt parser
import { buildPin, parseWindowsNodePosixSourceBuildReceipt, windowsNodePosixSourceBuildRecipe, windowsNodePosixSourceBuildEnvironment, windowsNodePosixSourceBuildBatch, windowsNodePosixSourceImageFingerprint, windowsNodePosixSourceEntropyImports, windowsNodePosixSourceCompileOutcome, windowsNodePosixRenameAbiBatch, validateWindowsNodePosixRenameAbiReceipt, trustedWindowsNodePosixSourcePythonPath, attestWindowsNodePosixSourcePython } from "../../scripts/experimental/build-windows-node-posix-source.mjs";
// @ts-expect-error -- trusted-host JavaScript source-preparation API
import { validateNodePosixSourceInputs } from "../../scripts/experimental/windows-node-posix-source.mjs";

const child = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: child.sync, execFile: child.async, spawnSync: child.spawn }));
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); child.sync.mockReset(); child.async.mockReset(); child.spawn.mockReset();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const compileCommit = "a".repeat(40), digest = "b".repeat(64);
function receipt() {
  const tool = () => ({ bytes: 2048, sha256: digest });
  const nasm = sourcePin.nasmTool.files.find(file => file.path === "nasm.exe")!;
  return { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256, sourceCommit: sourcePin.provenance.commit,
    source: { stockManifestSha256: sourcePin.inventory.stockManifestSha256, offlineManifestSha256: sourcePin.inventory.offlineManifestSha256,
      directoryManifestSha256: sourcePin.inventory.directoryManifestSha256, files: sourcePin.inventory.files, directories: sourcePin.inventory.directories,
      directoriesExcludeArchiveRoot: true, stockBytes: sourcePin.inventory.stockBytes, offlineBytes: sourcePin.inventory.offlineBytes,
      patchBeforeSha256: sourcePin.patch.beforeSha256, patchAfterSha256: sourcePin.patch.afterSha256,
      patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }) => ({ file, beforeSha256, afterSha256, kind })) },
    build: { ...buildPin, visualStudioVersion: "17.14.37906.3", compilerVersion: "19.44.35211.0", linkerVersion: "14.44.35211.0", msbuildVersion: "17.14.23.30406", pythonVersion: "3.12.10", nasmVersion: "2.16.03" },
    tools: { compiler: tool(), linker: tool(), msbuild: tool(), vcvars: tool(), vswhere: tool(), python: tool(), nasm: { bytes: nasm.bytes, sha256: nasm.sha256 } },
    recipe: windowsNodePosixSourceBuildRecipe() as { file: string; sha256: string }[], commit: compileCommit,
    renameAbi: { schema: 1, adapterSha256: createHash("sha256").update(sourcePin.patches[3].replacement).digest("hex"), sourceSha256: (windowsNodePosixSourceBuildRecipe() as {file:string;sha256:string}[]).find(row => row.file === buildPin.renameAbi.source)!.sha256, targets: buildPin.renameAbi.targets.map((target: {winnt:number;ntddi:number}) => ({ ...target, compileOnly: true, object: tool() })) },
    assets: { node: { name: "source-node.exe", bytes: 1024, sha256: digest }, bootstrap: { name: "bootstrap.exe", bytes: 1024, sha256: digest } } };
}
const parse = (value: unknown, commit = compileCommit) => parseWindowsNodePosixSourceBuildReceipt(Buffer.from(JSON.stringify(value)), commit);

it("accepts a separately issued source build with exact source, toolchain and compile-recipe identities", () => {
  const value = receipt(), parsed = parse(value);
  expect(parsed).toEqual(value); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.assets.node)).toBe(true);
  expect(parsed.issuer).not.toMatch(/OpenJS|official/i);
});

it.each(["issuer", "sourceVersion", "sourceArchiveSha256", "sourceCommit", "commit"])("refuses a changed or foreign provenance field: %s", field => {
  expect(() => parse({ ...receipt(), [field]: "private arbitrary value" })).toThrow("exact source, recipe or issuer contract");
});

it.each(["stockManifestSha256", "offlineManifestSha256", "directoryManifestSha256", "files", "directories", "directoriesExcludeArchiveRoot", "stockBytes", "offlineBytes", "patchBeforeSha256", "patchAfterSha256", "patches"])("binds every original-source and patch witness: %s", field => {
  const value = receipt(); Object.assign(value.source, { [field]: "changed" }); expect(() => parse(value)).toThrow();
});

it.each(["image", "platformToolset", "toolsetDirectory", "sdk", "pythonVersion", "nasmVersion", "compilerVersion", "linkerVersion", "msbuildVersion", "visualStudioVersion", "compilerEnvironment", "vcbuildArguments", "bootstrapCompileArguments"])("refuses an alternative build or observed toolchain value: %s", field => {
  const value = receipt(); Object.assign(value.build, { [field]: "changed" }); expect(() => parse(value)).toThrow();
});

it("rejects missing, reordered, unknown or altered compile inputs and excludes future runtime diagnostics", () => {
  expect(windowsNodePosixSourceBuildRecipe().map((item: { file: string }) => item.file)).toEqual([
    "scripts/experimental/build-windows-node-posix-source.mjs", "scripts/experimental/windows-node-posix-source-build-pin.json", "scripts/experimental/windows-node-posix-source.mjs",
    "scripts/experimental/extract-node-posix-source.py", "scripts/experimental/windows-node-posix-source-pin.json", "test/fixtures/windows-node-source-bootstrap.c", "test/fixtures/windows-node-posix-rename-abi.c",
  ]);
  for (const mutate of [
    (value: ReturnType<typeof receipt>) => value.recipe.pop(), (value: ReturnType<typeof receipt>) => value.recipe.reverse(),
    (value: ReturnType<typeof receipt>) => { value.recipe[0].sha256 = "c".repeat(64); },
    (value: ReturnType<typeof receipt>) => value.recipe.push({ file: "test/fixtures/windows-node-source-program.mjs", sha256: digest }),
  ]) { const value = receipt(); mutate(value); expect(() => parse(value)).toThrow(); }
});

it("rejects extra fields, unbounded tool fingerprints and mismatched pinned NASM bytes", () => {
  for (const value of [
    { ...receipt(), unexpected: "private data" }, { ...receipt(), tools: { ...receipt().tools, unexpected: { bytes: 1, sha256: digest } } },
    { ...receipt(), tools: { ...receipt().tools, compiler: { bytes: buildPin.maximumToolBytes + 1, sha256: digest } } },
    { ...receipt(), tools: { ...receipt().tools, python: { bytes: 0, sha256: digest } } },
    { ...receipt(), tools: { ...receipt().tools, nasm: { ...receipt().tools.nasm, sha256: digest } } },
  ]) expect(() => parse(value)).toThrow("exact source, recipe or issuer contract");
});

it("refuses arbitrary asset names, undersized images, oversized images and malformed hashes", () => {
  for (const asset of [{ name: "C:\\private\\node.exe", bytes: 1024, sha256: digest }, { name: "source-node.exe", bytes: 2, sha256: digest },
    { name: "source-node.exe", bytes: buildPin.maximumNodeBytes + 1, sha256: digest }, { name: "source-node.exe", bytes: 1024, sha256: "private" }]) {
    const value = receipt(); value.assets.node = asset; expect(() => parse(value)).toThrow();
  }
});

it("bounds JSON before decoding, refuses invalid UTF-8 and requires an exact caller-supplied compile commit", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(buildPin.maximumReceiptBytes + 1), Buffer.from("private-json"), Buffer.from([0xff, 0x7b])]) {
    expect(() => parseWindowsNodePosixSourceBuildReceipt(bytes, compileCommit)).toThrow("exact source, recipe or issuer contract");
  }
  expect(() => parse(receipt(), "c".repeat(40))).toThrow();
  expect(() => parse(receipt(), "private-commit")).toThrow();
});

const directories = { temporary: "D:\\fresh\\tmp", profile: "D:\\fresh\\profile", local: "D:\\fresh\\profile\\Local", roaming: "D:\\fresh\\profile\\Roaming" };
const tools = { pythonDirectory: "C:\\trusted-python", nasmDirectory: "D:\\fresh\\nasm" };
it("constructs a fresh build environment without private selectors, flags, credentials or user hooks", () => {
  const env = windowsNodePosixSourceBuildEnvironment({ SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: "private", CL: "/FIprivate.h", _CL_: "private", LINK: "private", _LINK_: "private",
    CFLAGS: "private", CXXFLAGS: "private", INCLUDE: "private", LIB: "private", LIBPATH: "private", config_flags: "private", msbuild_args: "private", NODE_OPTIONS: "private",
    GYP_MSVS_VERSION: "private", PYTHONPATH: "private", PYTHONHOME: "private", GH_TOKEN: "private", APPDATA: "C:\\private", MSBuildSDKsPath: "private" }, directories, tools);
  expect(env.PATH.split(";").slice(0, 2)).toEqual([tools.pythonDirectory, tools.nasmDirectory]);
  expect(env.USERPROFILE).toBe(directories.profile); expect(env.APPDATA).toBe(directories.roaming);
  expect(JSON.stringify(env)).not.toContain("private");
  for (const key of ["CL", "_CL_", "LINK", "_LINK_", "CFLAGS", "CXXFLAGS", "INCLUDE", "LIB", "LIBPATH", "config_flags", "msbuild_args", "NODE_OPTIONS", "GYP_MSVS_VERSION", "PYTHONPATH", "PYTHONHOME", "GH_TOKEN", "MSBuildSDKsPath"]) expect(env).not.toHaveProperty(key);
});

it("refuses conflicting environment aliases and command-bearing, nonlocal or alternate-stream host paths", () => {
  expect(() => windowsNodePosixSourceBuildEnvironment({ SystemRoot: "C:\\Windows", SYSTEMROOT: "D:\\other" }, directories, tools)).toThrow();
  for (const profile of ["\\\\server\\share", "D:\\fresh\\..\\other", "D:\\fresh\\a&command", "D:\\fresh\\file:stream", "D:\\fresh\\bad\tname"]) {
    expect(() => windowsNodePosixSourceBuildEnvironment({ SystemRoot: "C:\\Windows" }, { ...directories, profile }, tools)).toThrow();
  }
});

it("generates only the pinned vcbuild and inert-bootstrap recipe without feature or security workarounds", () => {
  const fields = ["vcvars", "compiler", "linker", "source", "bootstrapSource", "bootstrapObject", "bootstrapOutput", "compilerBefore", "pythonBefore", "nasmBefore", "compilerAfter", "pythonAfter", "nasmAfter"];
  const paths = Object.fromEntries(fields.map(name => [name, `D:\\fixed\\${name}`])); const batch = windowsNodePosixSourceBuildBatch(paths);
  expect(batch).toContain("call vcbuild.bat x64 vs2022 no-cctest nonpm nocorepack");
  expect(batch).toContain('set "CL=/DEMBER_UV_FIXED_PROBE_OFFLINE=1 /DEMBER_NODE_FIXED_PROBE_CNG=1"');
  expect(batch).toContain("/GS /Zl /c"); expect(batch).toContain("/NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE /MACHINE:X64");
  expect(batch).not.toMatch(/\/GS-|without-intl|openssl-no-asm|no-NODE-OPTIONS|jitless|no-sandbox|ExecutionPolicy|registryRead/);
  expect(() => windowsNodePosixSourceBuildBatch({ ...paths, extra: "D:\\other" })).toThrow();
});

function image() {
  const data = Buffer.alloc(1024); data.write("MZ"); data.writeUInt32LE(0x40, 0x3c); data.writeUInt32LE(0x4550, 0x40);
  data.writeUInt16LE(0x8664, 0x44); data.writeUInt16LE(1, 0x46); data.writeUInt16LE(0xf0, 0x54); data.writeUInt16LE(2, 0x56);
  const optional = 0x58; data.writeUInt16LE(0x20b, optional); data.writeUInt32LE(0x1000, optional + 16); data.writeUInt32LE(0x2000, optional + 56);
  data.writeUInt32LE(512, optional + 60); data.writeUInt16LE(3, optional + 68);
  const section = optional + 0xf0; data.writeUInt32LE(512, section + 8); data.writeUInt32LE(0x1000, section + 12);
  data.writeUInt32LE(512, section + 16); data.writeUInt32LE(512, section + 20); data.writeUInt32LE(0x60000020, section + 36);
  return data;
}
it("fingerprints a bounded x64 console PE while refusing malformed or foreign images", () => {
  expect(windowsNodePosixSourceImageFingerprint(image(), buildPin.maximumBootstrapBytes)).toMatchObject({ bytes: 1024, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  for (const mutate of [
    (bytes: Buffer) => bytes.writeUInt32LE(9999, 0x3c), (bytes: Buffer) => bytes.writeUInt16LE(0x14c, 0x44),
    (bytes: Buffer) => bytes.writeUInt16LE(0x2002, 0x56), (bytes: Buffer) => bytes.writeUInt16LE(0x10b, 0x58),
    (bytes: Buffer) => bytes.writeUInt32LE(9999, 0x58 + 0xf0 + 20), (bytes: Buffer) => bytes.writeUInt32LE(0, 0x58 + 0xf0 + 36),
  ]) { const bytes = image(); mutate(bytes); expect(() => windowsNodePosixSourceImageFingerprint(bytes, buildPin.maximumBootstrapBytes)).toThrow(); }
  expect(() => windowsNodePosixSourceImageFingerprint(Buffer.from("MZ"), buildPin.maximumBootstrapBytes)).toThrow();
});

function pythonFilesystem() {
  let bytes = Buffer.from("trusted tool");
  const file = () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, size: bytes.length, dev: 1, ino: 2, mtimeMs: 1, ctimeMs: 1 }) as fs.Stats;
  vi.spyOn(fs, "lstatSync").mockImplementation((value: fs.PathLike) => String(value).toLowerCase().endsWith("python.exe") ? file() :
    ({ isDirectory: () => true, isSymbolicLink: () => false }) as fs.Stats);
  vi.spyOn(fs.realpathSync, "native").mockImplementation(value => String(value));
  vi.spyOn(fs, "openSync").mockReturnValue(7);
  vi.spyOn(fs, "fstatSync").mockImplementation(file);
  vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
    const [, buffer, offset, length, position] = args;
    const start = Number(position), amount = Math.min(Number(length), Math.max(0, bytes.length - start));
    bytes.copy(buffer as Buffer, Number(offset), start, start + amount); return amount;
  });
  vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  return { change: () => { bytes = Buffer.from("changed tool"); } };
}

it("rejects caller-chosen Python executables before executing or inspecting them", () => {
  for (const candidate of ["D:\\attacker\\python.exe", "C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x86\\python.exe", "python", `${buildPin.pythonExecutable}:stream`]) {
    expect(() => attestWindowsNodePosixSourcePython(candidate, {}, "D:\\fresh")).toThrow();
  }
  expect(child.sync).not.toHaveBeenCalled(); expect(child.async).not.toHaveBeenCalled();
  expect(trustedWindowsNodePosixSourcePythonPath(buildPin.pythonExecutable.toUpperCase())).toBe(buildPin.pythonExecutable);
});

it("attests the hosted Python version and stable fingerprint with explicit captured pipes in the clean profile", () => {
  pythonFilesystem(); child.sync.mockReturnValue("3.12.10\n");
  const env = windowsNodePosixSourceBuildEnvironment({ SystemRoot: "C:\\Windows", PYTHONPATH: "private", GH_TOKEN: "private" }, directories, tools);
  const result = attestWindowsNodePosixSourcePython(buildPin.pythonExecutable, env, directories.profile);
  expect(result).toMatchObject({ pythonPath: buildPin.pythonExecutable, version: "3.12.10", fingerprint: { bytes: 12, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(child.sync).toHaveBeenCalledWith(buildPin.pythonExecutable, ["-I", "-B", "-c", expect.any(String)], expect.objectContaining({ env, cwd: directories.profile, stdio: ["ignore", "pipe", "pipe"] }));
  expect(child.async).not.toHaveBeenCalled();
});

it("refuses Python version drift, changed bytes and canonical-path aliases before source preparation", () => {
  const filesystem = pythonFilesystem(); child.sync.mockReturnValue("3.13.0\n");
  expect(() => attestWindowsNodePosixSourcePython(buildPin.pythonExecutable, {}, "D:\\fresh")).toThrow();
  child.sync.mockImplementation(() => { filesystem.change(); return "3.12.10\n"; });
  expect(() => attestWindowsNodePosixSourcePython(buildPin.pythonExecutable, {}, "D:\\fresh")).toThrow();
  vi.mocked(fs.realpathSync.native).mockReturnValue("D:\\attacker\\python.exe");
  const count = child.sync.mock.calls.length;
  expect(() => attestWindowsNodePosixSourcePython(buildPin.pythonExecutable, {}, "D:\\fresh")).toThrow();
  expect(child.sync).toHaveBeenCalledTimes(count); expect(child.async).not.toHaveBeenCalled();
});

it("retains fixed errors rather than forwarding a failed Python probe's private diagnostic", () => {
  pythonFilesystem(); child.sync.mockImplementation(() => { throw new Error("private-python-diagnostic"); });
  expect(() => attestWindowsNodePosixSourcePython(buildPin.pythonExecutable, {}, "D:\\fresh")).toThrow("exact source, recipe or issuer contract");
  expect(child.sync.mock.calls[0][2].stdio).toEqual(["ignore", "pipe", "pipe"]);
});

it("hands the same clean environment and fresh cwd to the isolated source validator", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ember-node-context-unit-")); temporary.push(root);
  const baseline = path.join(root, "baseline"); fs.mkdirSync(baseline);
  const env = { SystemRoot: "C:\\Windows", TEMP: "D:\\fresh\\tmp", PYTHONNOUSERSITE: "1" };
  const facts = { variant: "stock", files: sourcePin.inventory.files, directories: sourcePin.inventory.directories, bytes: sourcePin.inventory.stockBytes,
    manifestSha256: sourcePin.inventory.stockManifestSha256, directoryManifestSha256: sourcePin.inventory.directoryManifestSha256, allowGenerated: false, directoriesExcludeArchiveRoot: true };
  child.async.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: null, value: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: JSON.stringify(facts), stderr: "" });
  });
  await expect(validateNodePosixSourceInputs(baseline, "stock", { pythonPath: buildPin.pythonExecutable, executionEnv: env, cwd: root })).resolves.toEqual(facts);
  expect(child.async.mock.calls[0][2]).toMatchObject({ env, cwd: root });
  expect(child.async.mock.calls[0][1].slice(0, 2)).toEqual(["-I", "-B"]);
});

function entropyImage() {
  const data = Buffer.alloc(2048); image().copy(data);
  const optional = 0x58, section = optional + 0xf0;
  data.writeUInt32LE(1536, section + 8); data.writeUInt32LE(1536, section + 16);
  data.writeUInt32LE(16, optional + 108); data.writeUInt32LE(0x1100, optional + 120); data.writeUInt32LE(40, optional + 124);
  const descriptor = 0x300;
  data.writeUInt32LE(0x1180, descriptor); data.writeUInt32LE(0x1150, descriptor + 12); data.writeUInt32LE(0x1180, descriptor + 16);
  data.write("bcrypt.dll\0", 0x350, "ascii"); data.writeBigUInt64LE(0x11c0n, 0x380); data.write("BCryptGenRandom\0", 0x3c2, "ascii");
  return data;
}
it("requires the actual named CNG import in a bounded mapped PE and refuses legacy entropy imports", () => {
  expect(windowsNodePosixSourceEntropyImports(entropyImage())).toEqual({ module: "bcrypt.dll", required: "BCryptGenRandom", requiredCount: 1, legacyCryptGenRandomCount: 0 });
  for (const mutate of [
    (data: Buffer) => data.write("foreign.dll\0", 0x350, "ascii"),
    (data: Buffer) => { data.fill(0, 0x3c2, 0x3e0); data.write("CryptGenRandom\0", 0x3c2, "ascii"); },
    (data: Buffer) => { data.writeBigUInt64LE(0x1200n, 0x388); data.write("CryptGenRandom\0", 0x402, "ascii"); },
    (data: Buffer) => data.writeBigUInt64LE(0x8000000000000001n, 0x380),
    (data: Buffer) => data.writeBigUInt64LE(0x200000000n, 0x380),
    (data: Buffer) => data.writeUInt32LE(0x5000, 0x300),
    (data: Buffer) => data.writeUInt32LE(20, 0x58 + 124),
    (data: Buffer) => data.writeUInt32LE(0x1100, 0x58 + 216),
    (data: Buffer) => data.writeUInt32LE(0x1100, 0x314),
    (data: Buffer) => data.fill(65, 0x350, 0x3d2),
  ]) { const data = entropyImage(); mutate(data); expect(() => windowsNodePosixSourceEntropyImports(data)).toThrow("exact source, recipe or issuer"); }
});

it.each([
  [{ status: 0, signal: null }, { outcome: "success", exitCode: 0 }],
  [{ status: 1, signal: null }, { outcome: "exit", exitCode: 1 }],
  [{ status: 0xffffffff, signal: null }, { outcome: "exit", exitCode: 0xffffffff }],
  [{ status: -1073741819, signal: null }, { outcome: "exit", exitCode: -1073741819 }],
  [{ status: null, signal: "SIGTERM", error: Object.assign(new Error("private host path"), { code: "ETIMEDOUT" }) }, { outcome: "timeout", exitCode: null }],
  [{ status: null, signal: null, error: Object.assign(new Error("private host path"), { code: "ENOENT" }) }, { outcome: "spawn", exitCode: null }],
  [{ status: null, signal: "private signal name" }, { outcome: "signal", exitCode: null }],
])("classifies only finite compile outcome facts for injected result %#", (result, expected) => {
  const observed = windowsNodePosixSourceCompileOutcome(result);
  expect(observed).toEqual({ schema: 1, ...expected }); expect(Object.isFrozen(observed)).toBe(true);
  expect(JSON.stringify(observed)).not.toMatch(/private|ETIMEDOUT|ENOENT|SIGTERM/);
});
it.each([null, [], {}, { status: 0 }, { status: 0, signal: "SIGTERM" }, { status: null, signal: null },
  { status: "private", signal: null }, { status: 1.5, signal: null }, { status: 0x100000000, signal: null },
  { status: 0, signal: null, error: "private" }, { status: null, signal: "" }, { status: null, signal: true },
  { status: 0, signal: null, error: { code: "ETIMEDOUT" } }, { get status() { throw new Error("private property"); }, signal: null },
])("refuses malformed or contradictory compile outcome %# without forwarding private data", result => {
  expect(windowsNodePosixSourceCompileOutcome(result)).toEqual({ schema: 1, outcome: "malformed", exitCode: null });
});
it("keeps the fixed compiler budget and registers only a manual source producer", () => {
  expect(buildPin.nodeBuildTimeoutMs).toBe(3_600_000);
  const workflow = fs.readFileSync(new URL("../../.github/workflows/experimental-windows-node-posix-source.yml", import.meta.url), "utf8");
  expect(workflow).toMatch(/source-node:[\s\S]*?timeout-minutes: 90/);
  expect(workflow).toMatch(/name: Build the source Node[\s\S]*?timeout-minutes: 70/);
  expect(workflow).not.toContain("run-integration");
  expect(workflow).toContain("github.event_name == 'workflow_dispatch' && github.ref_name == 'ember-improve/20261116-source-node-posix'");
  expect(buildPin.compilerEnvironment).toBe("/DEMBER_UV_FIXED_PROBE_OFFLINE=1 /DEMBER_NODE_FIXED_PROBE_CNG=1");
});

it("requires both ABI compile targets, original target selectors and the exact adapter/source hashes", () => {
  const value = receipt().renameAbi;
  expect(validateWindowsNodePosixRenameAbiReceipt(value)).toBe(value);
  expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.targets[0].object)).toBe(true);
});
it.each(["missing", "old-three", "adapter", "source", "order", "count", "compileOnly", "object", "target", "extra"])("rejects an incomplete or foreign ABI witness: %s", kind => {
  const value = receipt();
  if (kind === "missing") delete (value as { renameAbi?: unknown }).renameAbi;
  if (kind === "old-three") value.source.patches.pop();
  if (kind === "adapter") value.renameAbi.adapterSha256 = digest;
  if (kind === "source") value.renameAbi.sourceSha256 = digest;
  if (kind === "order") value.renameAbi.targets.reverse();
  if (kind === "count") value.renameAbi.targets.pop();
  if (kind === "compileOnly") value.renameAbi.targets[0].compileOnly = false;
  if (kind === "object") value.renameAbi.targets[0].object.bytes = 19;
  if (kind === "target") value.renameAbi.targets[0].winnt = 0x0a00;
  if (kind === "extra") Object.assign(value.renameAbi, { runtimeSuccess: true });
  expect(() => parse(value)).toThrow("exact source, recipe or issuer contract");
});
it("only compiles the actual adapter with two isolated target selectors, never links or executes it", () => {
  const paths = { vcvars: "C:\\VS\\vcvarsall.bat", compiler: "C:\\VS\\cl.exe", working: "D:\\working", source: "D:\\abi\\check.c", include: "D:\\abi", object0: "D:\\abi\\win8.obj", object1: "D:\\abi\\sdk.obj" };
  const batch = windowsNodePosixRenameAbiBatch(paths);
  expect(batch.match(/\/TC \/c /g)).toHaveLength(2);
  expect(batch).toContain("/D_WIN32_WINNT=0x602 /DNTDDI_VERSION=0x6020000 /DEMBER_POSIX_ABI_SDK=0");
  expect(batch).toContain("/D_WIN32_WINNT=0xa00 /DNTDDI_VERSION=0xa000002 /DEMBER_POSIX_ABI_SDK=1");
  expect(batch).not.toMatch(/\/link|vcbuild|\.obj"\r?\n/);
  expect(batch).toContain('set "CL="');
  expect(() => windowsNodePosixRenameAbiBatch({ ...paths, compiler: "C:\\bad&injected.exe" })).toThrow();
});
