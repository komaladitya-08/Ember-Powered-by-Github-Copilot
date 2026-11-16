import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- portable trusted-host recipe and receipt parser, outside the application TypeScript build
import { buildPin, sourcePin, windowsUvSpawnRecipe, parseWindowsUvSpawnBuildReceipt, windowsUvSpawnImageFingerprint, windowsUvSpawnBuildEnvironment, windowsUvSpawnProjectWitness, trustedWindowsUvSpawnPythonPath, attestWindowsUvSpawnPython, validateWindowsUvSpawnToolVersions } from "../../scripts/experimental/build-windows-uv-spawn-probe.mjs";
// @ts-expect-error -- optional private-checkpoint context for the same read-only fixed-pin version validator
import { createUvSpawnBuildDiagnostic } from "../../scripts/experimental/windows-uv-spawn-build-diagnostic.mjs";

const child = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: child.sync, execFile: child.async, spawnSync: child.spawn }));
afterEach(() => { vi.restoreAllMocks(); child.sync.mockReset(); child.async.mockReset(); child.spawn.mockReset(); });
const commit = "a".repeat(40), sha256 = "b".repeat(64), fingerprint = () => ({ bytes: 2048, sha256 });
function receipt() {
  return { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256, sourceCommit: sourcePin.provenance.commit,
    source: { stockManifestSha256: sourcePin.stockManifestSha256, workingManifestSha256: sourcePin.workingManifestSha256, ...sourcePin.inventory,
      patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }: { file: string; beforeSha256: string; afterSha256: string; kind: string }) => ({ file, beforeSha256, afterSha256, kind })) },
    build: { ...buildPin, visualStudioVersion: "17.14.37906.3", compilerVersion: "19.44.35211.0", linkerVersion: "14.44.35211.0", msbuildVersion: "17.14.23.30406",
      pythonVersion: "3.12.10", cmakeVersion: "3.31.6", generatedProjects: ["uv_a", "ember_uv_spawn_probe"].map(target => ({ target, ...fingerprint(), targetMacro: "0x0602", releaseDefinitionCount: 1 })),
      observerListing: { ...fingerprint(), review: "not-reviewed" }, observerObject: fingerprint(),
      observerEmission: { name: "observer-emission.json", ...fingerprint(), schema: 2, review: "not-reviewed", status: "candidate" } },
    tools: Object.fromEntries(["compiler", "linker", "msbuild", "vcvars", "vswhere", "python", "cmake"].map(name => [name, fingerprint()])),
    recipe: windowsUvSpawnRecipe() as { file: string; sha256: string }[], commit, assets: { probe: { name: "uv-spawn-probe.exe", ...fingerprint() } } };
}
const parse = (value: unknown, expected = commit) => parseWindowsUvSpawnBuildReceipt(Buffer.from(JSON.stringify(value)), expected);
const versionKeys = ["visualStudioVersion", "compilerVersion", "linkerVersion", "msbuildVersion", "pythonVersion", "cmakeVersion"] as const;
const toolVersions = () => ({ visualStudioVersion: "17.14.37906.3", compilerVersion: "19.44.35211.0", linkerVersion: "14.44.35211.0", msbuildVersion: "17.14.23.30406", pythonVersion: "3.12.10", cmakeVersion: "3.31.6" });
const accepts = (operation: () => unknown) => { try { operation(); return true; } catch { return false; } };
function previousVersionAcceptance(value: Record<string, unknown>) {
  if (Object.keys(value).length !== versionKeys.length || !versionKeys.every(key => Object.hasOwn(value, key)) ||
      !versionKeys.every(key => typeof value[key] === "string" && /^[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}$/.test(value[key]))) return false;
  const actual = value as Record<string, string>;
  return actual.visualStudioVersion.startsWith(buildPin.visualStudioVersionPrefix) && actual.compilerVersion.startsWith(buildPin.compilerVersionPrefix) &&
    actual.linkerVersion.startsWith(buildPin.linkerVersionPrefix) && actual.msbuildVersion.startsWith(buildPin.msbuildVersionPrefix) &&
    actual.pythonVersion === buildPin.pythonVersion && actual.cmakeVersion === buildPin.cmakeVersion;
}

it("accepts only the separate fixed issuer, signed source, compiled recipe and unreviewed emission receipt", () => {
  const value = receipt(), parsed = parse(value); expect(parsed).toEqual(value);
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.assets.probe)).toBe(true);
  expect(parsed.build.observerListing.review).toBe("not-reviewed");
  expect(parsed.issuer).not.toMatch(/OpenJS|official/i);
});

it.each(["issuer", "sourceVersion", "sourceArchiveSha256", "sourceCommit", "commit"])("refuses altered source or compile provenance: %s", field => {
  expect(() => parse({ ...receipt(), [field]: "foreign" })).toThrow("exact source, recipe or issuer contract");
});

it.each(["stockManifestSha256", "workingManifestSha256", "files", "directories", "stockBytes", "workingBytes", "patches"])("binds every source catalog witness: %s", field => {
  const value = receipt(); Object.assign(value.source, { [field]: "changed" }); expect(() => parse(value)).toThrow();
});

it.each(["image", "generator", "toolsetDirectory", "sdk", "targetMacro", "runtimeLibrary", "pythonVersion", "cmakeVersion", "compilerVersion", "linkerVersion", "visualStudioVersion", "offlineMacro"])("refuses an alternative build or observed version: %s", field => {
  const value = receipt(); Object.assign(value.build, { [field]: "changed" }); expect(() => parse(value)).toThrow();
});

it.each(versionKeys)("keeps prior format, prefix and exact-pin acceptance unchanged for %s", field => {
  const current = toolVersions();
  for (const output of [current[field], current[field].split(".").slice(0, 3).join("."), current[field] + ".0", current[field] + "\n",
    "1.2", "1", "1.2.3.4.5", "1.1000000.3", "1.2.3-private", " " + current[field], "999999.2.3", null, 123]) {
    const observed = { ...current, [field]: output }, expected = previousVersionAcceptance(observed);
    // Preserve the original regex and predicates, including their existing final-newline semantics.
    expect(accepts(() => validateWindowsUvSpawnToolVersions(observed))).toBe(expected);
    const value = receipt(); Object.assign(value.build, observed); expect(accepts(() => parse(value))).toBe(expected);
  }
});

function failedVersionDiagnostic(observed: ReturnType<typeof toolVersions>) {
  const diagnostic = createUvSpawnBuildDiagnostic(); diagnostic.checkpoint(7);
  versionKeys.forEach((key, index) => diagnostic.observeVersion(index + 1, index === 5 ? `cmake version ${observed[key]}` : observed[key]));
  try { validateWindowsUvSpawnToolVersions(observed, diagnostic); } catch (error) { return diagnostic.classify(diagnostic.failure(error)); }
  throw new Error("The fixed version fault fixture did not fail.");
}

it.each(versionKeys)("keeps a two-component projection separate from the original format gate for %s", field => {
  const observed = { ...toolVersions(), [field]: "1.2" }, index = versionKeys.indexOf(field), value = failedVersionDiagnostic(observed);
  expect(value.versionDiagnostic.subcheckpoint).toBe(8 + index);
  expect(value.versionDiagnostic.tools[index]).toEqual({ toolId: index + 1, state: 1, components: [1, 2] });
  const receiptValue = receipt(); Object.assign(receiptValue.build, observed); expect(() => parse(receiptValue)).toThrow();
});

it("runs every existing format gate before any prefix comparison and keeps individual short-circuit order", () => {
  for (const [fields, subcheckpoint] of [
    [{ visualStudioVersion: "18.14.1", msbuildVersion: "private-invalid" }, 11],
    [{ compilerVersion: "private-invalid", linkerVersion: "private-invalid" }, 9],
    [{ visualStudioVersion: "18.14.1", compilerVersion: "20.44.1" }, 14],
    [{ linkerVersion: "15.44.1", msbuildVersion: "18.14.1" }, 16],
    [{ pythonVersion: "3.12.11", cmakeVersion: "3.31.7" }, 18],
    [{ cmakeVersion: "3.31.7" }, 19],
  ] as const) expect(failedVersionDiagnostic({ ...toolVersions(), ...fields }).versionDiagnostic.subcheckpoint).toBe(subcheckpoint);
});

it("rejects missing, reordered or changed compile inputs, and excludes independent runtime proof", () => {
  const names = windowsUvSpawnRecipe().map((item: { file: string }) => item.file);
  expect(names).toContain("scripts/experimental/extract-node-libuv-source.py"); expect(names).toContain("scripts/experimental/windows-libuv-source-pin.json");
  expect(names).toContain("test/fixtures/windows-uv-spawn-observe.c"); expect(names).toContain("test/fixtures/windows-uv-spawn-build/CMakeLists.txt");
  expect(names.join(" ")).not.toMatch(/proof|report\.ts|native\.test|workflow/);
  for (const mutate of [(value: ReturnType<typeof receipt>) => value.recipe.pop(), (value: ReturnType<typeof receipt>) => value.recipe.reverse(),
    (value: ReturnType<typeof receipt>) => { value.recipe[0].sha256 = "c".repeat(64); }]) { const value = receipt(); mutate(value); expect(() => parse(value)).toThrow(); }
});

it("bounds tools, public assets, generated project witnesses and private emission identities", () => {
  for (const mutate of [
    (value: ReturnType<typeof receipt>) => { value.tools.python.bytes = 0; },
    (value: ReturnType<typeof receipt>) => { value.tools.compiler.bytes = buildPin.maximumToolBytes + 1; },
    (value: ReturnType<typeof receipt>) => { value.assets.probe.name = "C:\\private.exe"; },
    (value: ReturnType<typeof receipt>) => { value.assets.probe.bytes = buildPin.maximumExecutableBytes + 1; },
    (value: ReturnType<typeof receipt>) => { value.assets.probe.bytes = 2; },
    (value: ReturnType<typeof receipt>) => { value.build.generatedProjects[0].targetMacro = "0x0A00"; },
    (value: ReturnType<typeof receipt>) => { value.build.generatedProjects[0].releaseDefinitionCount = 2; },
    (value: ReturnType<typeof receipt>) => { value.build.observerListing.review = "approved"; },
    (value: ReturnType<typeof receipt>) => { value.build.observerObject.sha256 = "invalid"; },
    (value: ReturnType<typeof receipt>) => { value.build.observerEmission.name = "private-path"; },
    (value: ReturnType<typeof receipt>) => { value.build.observerEmission.review = "approved"; },
    (value: ReturnType<typeof receipt>) => { value.build.observerEmission.schema = 1; },
  ]) { const value = receipt(); mutate(value); expect(() => parse(value)).toThrow(); }
  expect(() => parse({ ...receipt(), unknown: "private" })).toThrow();
});

it("refuses malformed, oversized and invalid UTF-8 receipts and foreign compile commits", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(buildPin.maximumReceiptBytes + 1), Buffer.from([0xff]), Buffer.from("invalid")]) {
    expect(() => parseWindowsUvSpawnBuildReceipt(bytes, commit)).toThrow("exact source, recipe or issuer contract");
  }
  expect(() => parse(receipt(), "c".repeat(40))).toThrow(); expect(() => parse(receipt(), "invalid")).toThrow();
});

const directories = { temporary: "D:\\fresh\\tmp", profile: "D:\\fresh\\profile", local: "D:\\fresh\\profile\\Local", roaming: "D:\\fresh\\profile\\Roaming" };
it("constructs a fresh environment without credentials, ambient flags, Python hooks or user profiles", () => {
  const env = windowsUvSpawnBuildEnvironment({ SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: "private", CL: "private", _CL_: "private", LINK: "private", INCLUDE: "private", LIB: "private",
    NODE_OPTIONS: "private", PYTHONPATH: "private", PYTHONHOME: "private", GH_TOKEN: "private", APPDATA: "private" }, directories, "C:\\trusted-python");
  expect(JSON.stringify(env)).not.toContain("private"); expect(env.USERPROFILE).toBe(directories.profile);
  expect(env.PATH.split(";")[0]).toBe("C:\\trusted-python");
  for (const key of ["CL", "_CL_", "LINK", "INCLUDE", "LIB", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "GH_TOKEN"]) expect(env).not.toHaveProperty(key);
  expect(() => windowsUvSpawnBuildEnvironment({ SystemRoot: "C:\\Windows", SYSTEMROOT: "D:\\other" }, directories, "C:\\Python")).toThrow();
  expect(() => windowsUvSpawnBuildEnvironment({ SystemRoot: "C:\\Windows" }, { ...directories, profile: "D:\\x&command" }, "C:\\Python")).toThrow();
});

it("rejects arbitrary Python executables before they can run or fabricate extraction receipts", () => {
  expect(trustedWindowsUvSpawnPythonPath(buildPin.pythonExecutable)).toBe(buildPin.pythonExecutable);
  for (const value of ["python", "D:\\attacker\\python.exe", "C:\\hostedtoolcache\\windows\\Python\\3.12.9\\x64\\python.exe"]) {
    expect(() => attestWindowsUvSpawnPython(value, {}, "D:\\fresh")).toThrow();
  }
  expect(child.sync).not.toHaveBeenCalled();
});

it("attests isolated Python using piped diagnostics, the same clean environment and stable pre/post bytes", () => {
  const info = { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 4, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4 };
  vi.spyOn(fs, "lstatSync").mockImplementation((() => info) as unknown as typeof fs.lstatSync);
  vi.spyOn(fs.realpathSync, "native").mockImplementation((value => value) as typeof fs.realpathSync.native);
  vi.spyOn(fs, "openSync").mockReturnValue(1); vi.spyOn(fs, "fstatSync").mockImplementation((() => info) as unknown as typeof fs.fstatSync);
  vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
    const buffer = args[1] as Buffer, offset = args[2] as number, position = args[4] as number;
    if (position) return 0; buffer.write("test", offset); return 4;
  }) as typeof fs.readSync);
  child.sync.mockReturnValue("3.12.10\r\n"); const env = { SystemRoot: "C:\\Windows", PATH: "trusted-only" };
  expect(attestWindowsUvSpawnPython(buildPin.pythonExecutable, env, "D:\\fresh").version).toBe("3.12.10");
  expect(child.sync).toHaveBeenCalledWith(buildPin.pythonExecutable, ["-I", "-B", "-c", expect.any(String)], expect.objectContaining({ env, cwd: "D:\\fresh", stdio: ["ignore", "pipe", "pipe"] }));
});

function project(target = "uv_a") {
  const units = target === "uv_a" ? ["pipe", "process"].map(name => `<ClCompile Include="D:/source/src/win/${name}.c"><PreprocessorDefinitions>EMBER_UV_SPAWN_OBSERVE_${name.toUpperCase()}=1;%(PreprocessorDefinitions)</PreprocessorDefinitions><ForcedIncludeFiles>D:/repo/test/fixtures/windows-uv-spawn-observe.h</ForcedIncludeFiles></ClCompile>`).join("") :
    '<ClCompile Include="D:/repo/windows-uv-spawn-probe.c"/><ClCompile Include="D:/repo/windows-uv-spawn-observe.c"/>';
  return `<Project><PropertyGroup><PlatformToolset>v143</PlatformToolset><WindowsTargetPlatformVersion>10.0.26100.0</WindowsTargetPlatformVersion></PropertyGroup><ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'"><ClCompile><PreprocessorDefinitions>WIN32;_WIN32_WINNT=0x0602;EMBER_UV_FIXED_PROBE_OFFLINE=1;%(PreprocessorDefinitions)</PreprocessorDefinitions><RuntimeLibrary>MultiThreaded</RuntimeLibrary></ClCompile><ResourceCompile><PreprocessorDefinitions>WIN32;_WIN32_WINNT=0x0602;EMBER_UV_FIXED_PROBE_OFFLINE=1;%(PreprocessorDefinitions)</PreprocessorDefinitions></ResourceCompile></ItemDefinitionGroup><ItemGroup>${units}</ItemGroup></Project>`;
}
it("checks the generated Release target macro and admits aliases only on the two original selected units", () => {
  expect(windowsUvSpawnProjectWitness(Buffer.from(project()), "uv_a")).toMatchObject({ target: "uv_a", targetMacro: "0x0602", releaseDefinitionCount: 1 });
  expect(windowsUvSpawnProjectWitness(Buffer.from(project("ember_uv_spawn_probe")), "ember_uv_spawn_probe")).toMatchObject({ target: "ember_uv_spawn_probe" });
  for (const text of [project().replace("_WIN32_WINNT=0x0602", "_WIN32_WINNT=0x0A00"), project().replace("_WIN32_WINNT=0x0602", "_WIN32_WINNT=0x0602;_WIN32_WINNT=0x0A00"),
    project().replace("MultiThreaded", "MultiThreadedDLL"), project().replace("OBSERVE_PIPE", "OBSERVE_PROCESS"), project().replace("10.0.26100.0", "10.0.1.0"),
    project().replace("windows-uv-spawn-observe.h", "foreign.h"), project().replace("<Project>", "<!DOCTYPE Project><Project>"),
    project().replace("<PreprocessorDefinitions>EMBER_UV_SPAWN_OBSERVE_PIPE", "<PreprocessorDefinitions Condition=\"'$(Configuration)|$(Platform)'=='Debug|x64'\">EMBER_UV_SPAWN_OBSERVE_PIPE")]) {
    expect(() => windowsUvSpawnProjectWitness(Buffer.from(text), "uv_a")).toThrow("exact source, recipe or issuer contract");
  }
});

it("refuses a Release undefine option outside the single canonical Windows target definition", () => {
  const text = project().replace("<RuntimeLibrary>", "<AdditionalOptions>/U_WIN32_WINNT %(AdditionalOptions)</AdditionalOptions><RuntimeLibrary>");
  expect(() => windowsUvSpawnProjectWitness(Buffer.from(text), "uv_a")).toThrow("exact source, recipe or issuer contract");
});

function image() {
  const bytes = Buffer.alloc(1024); bytes.write("MZ"); bytes.writeUInt32LE(0x40, 0x3c); bytes.writeUInt32LE(0x4550, 0x40);
  bytes.writeUInt16LE(0x8664, 0x44); bytes.writeUInt16LE(1, 0x46); bytes.writeUInt16LE(0xf0, 0x54); bytes.writeUInt16LE(2, 0x56);
  bytes.writeUInt16LE(0x20b, 0x58); bytes.writeUInt32LE(0x1000, 0x68); bytes.writeUInt32LE(0x2000, 0x90); bytes.writeUInt32LE(512, 0x94); bytes.writeUInt16LE(3, 0x9c);
  const section = 0x148; bytes.writeUInt32LE(512, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20); bytes.writeUInt32LE(0x60000020, section + 36);
  return bytes;
}
it("accepts ordinary x64 console images and refuses foreign, unbacked or nonexecutable entry points", () => {
  expect(windowsUvSpawnImageFingerprint(image(), buildPin.maximumExecutableBytes).bytes).toBe(1024);
  for (const mutate of [(bytes: Buffer) => bytes.writeUInt16LE(0x14c, 0x44), (bytes: Buffer) => bytes.writeUInt16LE(0x2002, 0x56),
    (bytes: Buffer) => bytes.writeUInt16LE(2, 0x9c), (bytes: Buffer) => bytes.writeUInt32LE(0x1500, 0x68),
    (bytes: Buffer) => bytes.writeUInt32LE(0x40000040, 0x148 + 36), (bytes: Buffer) => bytes.writeUInt32LE(900, 0x148 + 20)]) {
    const bytes = image(); mutate(bytes); expect(() => windowsUvSpawnImageFingerprint(bytes, buildPin.maximumExecutableBytes)).toThrow();
  }
});
