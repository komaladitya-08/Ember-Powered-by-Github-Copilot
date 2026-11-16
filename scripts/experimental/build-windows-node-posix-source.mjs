/** Trusted-host source build only. The source-built image has its own issuer; official Node verification is unchanged.
 * usage: node build-windows-node-posix-source.mjs --source-archive ARCHIVE --nasm-archive ZIP --destination FRESH --python ABSOLUTE_PYTHON
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareNodePosixSource, prepareNodePosixNasmTool, validateNodePosixSourceInputs, sourcePin } from "./windows-node-posix-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
export const buildPin = freeze(JSON.parse(fs.readFileSync(path.join(root, "scripts/experimental/windows-node-posix-source-build-pin.json"), "utf8")));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("The source Node build failed its exact source, recipe or issuer contract."); };
const fixedFiles = ["scripts/experimental/build-windows-node-posix-source.mjs", "scripts/experimental/windows-node-posix-source-build-pin.json",
  "scripts/experimental/windows-node-posix-source.mjs", "scripts/experimental/extract-node-posix-source.py", "scripts/experimental/windows-node-posix-source-pin.json",
  "test/fixtures/windows-node-source-bootstrap.c", "test/fixtures/windows-node-posix-rename-abi.c"];
export function windowsNodePosixSourceBuildRecipe() {
  return fixedFiles.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
}
const currentRecipe = freeze(windowsNodePosixSourceBuildRecipe());
const strict = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const equal = (actual, expected) => {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equal(actual[index], item));
  if (expected && typeof expected === "object") return strict(actual, Object.keys(expected)) && Object.keys(expected).every(key => equal(actual[key], expected[key]));
  return actual === expected;
};
const sourceSummary = () => ({ stockManifestSha256: sourcePin.inventory.stockManifestSha256, offlineManifestSha256: sourcePin.inventory.offlineManifestSha256,
  directoryManifestSha256: sourcePin.inventory.directoryManifestSha256, files: sourcePin.inventory.files, directories: sourcePin.inventory.directories,
  directoriesExcludeArchiveRoot: true, stockBytes: sourcePin.inventory.stockBytes, offlineBytes: sourcePin.inventory.offlineBytes,
  patchBeforeSha256: sourcePin.patch.beforeSha256, patchAfterSha256: sourcePin.patch.afterSha256,
  patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }) => ({ file, beforeSha256, afterSha256, kind })) });
const version = value => typeof value === "string" && /^[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}$/.test(value);
const observations = ["visualStudioVersion", "compilerVersion", "linkerVersion", "msbuildVersion", "pythonVersion", "nasmVersion"];
function versions(value) {
  if (!strict(value, observations) || !observations.every(key => version(value[key])) ||
      !value.visualStudioVersion.startsWith(buildPin.visualStudioVersionPrefix) || !value.compilerVersion.startsWith(buildPin.compilerVersionPrefix) ||
      !value.linkerVersion.startsWith(buildPin.linkerVersionPrefix) || !value.msbuildVersion.startsWith(buildPin.msbuildVersionPrefix) ||
      value.pythonVersion !== buildPin.pythonVersion || value.nasmVersion !== buildPin.nasmVersion) fail();
  return value;
}
const fingerprint = value => strict(value, ["bytes", "sha256"]) && Number.isSafeInteger(value.bytes) && value.bytes >= 1 && value.bytes <= buildPin.maximumToolBytes && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);

/** Pure bounded JSON validation; the compiled-input recipe was captured when this trusted module was loaded. */
export function parseWindowsNodePosixSourceBuildReceipt(bytes, expectedCompileCommit) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > buildPin.maximumReceiptBytes || typeof expectedCompileCommit !== "string" || !/^[a-f0-9]{40}$/.test(expectedCompileCommit)) fail();
    const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes)) fail();
    const value = JSON.parse(text);
    if (!strict(value, ["schema", "issuer", "sourceVersion", "sourceArchiveSha256", "sourceCommit", "source", "build", "tools", "recipe", "commit", "assets", "renameAbi"]) ||
        value.schema !== 1 || value.issuer !== sourcePin.issuer || value.sourceVersion !== sourcePin.version || value.sourceArchiveSha256 !== sourcePin.sourceArchive.sha256 ||
        value.sourceCommit !== sourcePin.provenance.commit || value.commit !== expectedCompileCommit || !equal(value.source, sourceSummary()) || !equal(value.recipe, currentRecipe)) fail();
    validateWindowsNodePosixRenameAbiReceipt(value.renameAbi);
    const observed = Object.fromEntries(observations.map(key => [key, value.build?.[key]])); versions(observed);
    if (!equal(value.build, { ...buildPin, ...observed }) || !strict(value.tools, ["compiler", "linker", "msbuild", "vcvars", "vswhere", "python", "nasm"]) || !Object.values(value.tools).every(fingerprint)) fail();
    const nasm = sourcePin.nasmTool.files.find(entry => entry.path === "nasm.exe");
    if (!equal(value.tools.nasm, { bytes: nasm.bytes, sha256: nasm.sha256 }) || !strict(value.assets, ["node", "bootstrap"])) fail();
    for (const [key, name, maximum] of [["node", "source-node.exe", buildPin.maximumNodeBytes], ["bootstrap", "bootstrap.exe", buildPin.maximumBootstrapBytes]]) {
      const asset = value.assets[key];
      if (!strict(asset, ["name", "bytes", "sha256"]) || asset.name !== name || !Number.isSafeInteger(asset.bytes) || asset.bytes < 512 || asset.bytes > maximum || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) fail();
    }
    return freeze(value);
  } catch { fail(); }
}

/** The new receipt binds two successful compile-only targets to the actual adapter and SDK-check source. */
export function validateWindowsNodePosixRenameAbiReceipt(value) {
  const adapter = sourcePin.patches[3], source = currentRecipe.find(entry => entry.file === buildPin.renameAbi.source);
  if (!adapter || adapter.file !== "deps/uv/src/win/fs.c" || !source ||
      !strict(value, ["schema", "adapterSha256", "sourceSha256", "targets"]) || value.schema !== 1 ||
      value.adapterSha256 !== hash(Buffer.from(adapter.replacement)) || value.sourceSha256 !== source.sha256 ||
      !Array.isArray(value.targets) || value.targets.length !== 2) fail();
  for (let index = 0; index < 2; index++) {
    const target = value.targets[index], expected = buildPin.renameAbi.targets[index];
    if (!strict(target, ["winnt", "ntddi", "compileOnly", "object"]) || target.winnt !== expected.winnt || target.ntddi !== expected.ntddi ||
        target.compileOnly !== true || !fingerprint(target.object) || target.object.bytes < 20 || target.object.bytes > 1024 * 1024) fail();
  }
  return freeze(value);
}
/** Fixed compiler commands only; neither target changes any production compiler/header selector. */
export function windowsNodePosixRenameAbiBatch(paths) {
  if (!strict(paths, ["vcvars", "compiler", "working", "source", "include", "object0", "object1"])) fail();
  for (const value of Object.values(paths)) ordinary(value);
  const lines = ["@echo off", "setlocal", `call "${paths.vcvars}" amd64 ${buildPin.sdk} -vcvars_ver=${buildPin.toolsetDirectory}`,
    "if errorlevel 1 exit /b 1", `if not "%VisualStudioVersion%"=="17.0" exit /b 1`, `if not "%VCToolsVersion%"=="${buildPin.toolsetDirectory}" exit /b 1`,
    `if not "%WindowsSDKVersion%"=="${buildPin.sdk}\\" exit /b 1`, 'set "CL="', 'set "_CL_="', 'set "LINK="', 'set "_LINK_="'];
  for (let index = 0; index < 2; index++) {
    const target = buildPin.renameAbi.targets[index];
    lines.push(`"${paths.compiler}" /nologo /W4 /WX /TC /c /utf-8 /D_WIN32_WINNT=0x${target.winnt.toString(16)} /DNTDDI_VERSION=0x${target.ntddi.toString(16)} /DEMBER_POSIX_ABI_SDK=${index} /I"${path.win32.join(paths.working, "deps", "uv", "include")}" /I"${path.win32.join(paths.working, "deps", "uv", "src")}" /I"${paths.include}" /Fo"${paths[`object${index}`]}" "${paths.source}"`, "if errorlevel 1 exit /b 1");
  }
  return [...lines, "exit /b 0", ""].join("\r\n");
}
function compileWindowsNodePosixRenameAbi(destination, working, tools, env) {
  const directory = path.join(destination, "rename-abi"); fs.mkdirSync(directory, { mode: 0o700 });
  const sourcePath = ordinary(path.join(root, buildPin.renameAbi.source)), sourceBytes = inputBytes(sourcePath, 64 * 1024);
  const sourcePinEntry = currentRecipe.find(entry => entry.file === buildPin.renameAbi.source);
  if (!sourcePinEntry || hash(sourceBytes) !== sourcePinEntry.sha256) fail();
  const source = path.join(directory, "rename-abi.c"), adapter = path.join(directory, "node-posix-adapter.inc"), adapterBytes = Buffer.from(sourcePin.patches[3].replacement);
  fs.writeFileSync(source, sourceBytes, { flag: "wx" }); fs.writeFileSync(adapter, adapterBytes, { flag: "wx" });
  const objects = [path.join(directory, "win8.obj"), path.join(directory, "win10-rs1.obj")];
  const batch = path.join(directory, "compile-abi.cmd");
  fs.writeFileSync(batch, windowsNodePosixRenameAbiBatch({ vcvars: tools.vcvars, compiler: tools.compiler, working, source, include: directory, object0: objects[0], object1: objects[1] }), { flag: "wx" });
  captured(env.ComSpec, ["/d", "/s", "/v:off", "/c", `""${batch}""`], env, directory, 120_000);
  const targets = objects.map((file, index) => {
    const bytes = inputBytes(file, 1024 * 1024);
    if (bytes.length < 20 || bytes.readUInt16LE(0) !== 0x8664 || bytes.readUInt16LE(2) < 1 || bytes.readUInt16LE(2) > 96 || bytes.readUInt16LE(16) !== 0) fail();
    return { ...buildPin.renameAbi.targets[index], compileOnly: true, object: { bytes: bytes.length, sha256: hash(bytes) } };
  });
  if (!sourceBytes.equals(inputBytes(source, 64 * 1024)) || !adapterBytes.equals(inputBytes(adapter, 64 * 1024)) || !equal(currentRecipe, windowsNodePosixSourceBuildRecipe())) fail();
  return validateWindowsNodePosixRenameAbiReceipt({ schema: 1, adapterSha256: hash(adapterBytes), sourceSha256: hash(sourceBytes), targets });
}

function ordinary(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || /[^\x20-\x7e]|[%!^&|<>";]/.test(value) || value.slice(2).includes(":") || path.win32.normalize(value) !== value ||
      value.slice(3).split("\\").some(part => part === "." || part === ".." || /[. ]$/.test(part))) fail();
  return value;
}
/** The compiler receives no inherited secrets, selectors, Python hooks, user profiles or ambient compiler/link flags. */
export function windowsNodePosixSourceBuildEnvironment(base, directories, tools) {
  if (!strict(directories, ["temporary", "profile", "local", "roaming"]) || !strict(tools, ["pythonDirectory", "nasmDirectory"])) fail();
  const result = {};
  for (const name of ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"]) {
    const found = Object.entries(base).filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === "string");
    if (found.length > 1 && found.some(([, value]) => value !== found[0][1])) fail();
    if (found.length) result[name] = ordinary(found[0][1]);
  }
  for (const value of [...Object.values(directories), ...Object.values(tools)]) ordinary(value);
  const windows = ordinary(result.SystemRoot);
  return { ...result, WINDIR: windows, ComSpec: path.win32.join(windows, "System32", "cmd.exe"), SystemDrive: path.win32.parse(windows).root.slice(0, 2),
    PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: [tools.pythonDirectory, tools.nasmDirectory, path.win32.join(windows, "System32"), windows,
      path.win32.join(windows, "System32", "Wbem"), path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0")].join(";"),
    USERPROFILE: directories.profile, LOCALAPPDATA: directories.local, APPDATA: directories.roaming, TEMP: directories.temporary, TMP: directories.temporary,
    PROCESSOR_ARCHITECTURE: "AMD64", NUMBER_OF_PROCESSORS: "2", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", MSBUILDDISABLENODEREUSE: "1" };
}

export function windowsNodePosixSourceImageFingerprint(bytes, maximum) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(maximum) || maximum < 512 || maximum > buildPin.maximumNodeBytes || bytes.length < 512 || bytes.length > maximum || bytes.toString("ascii", 0, 2) !== "MZ") fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) fail();
  const sections = bytes.readUInt16LE(pe + 6), optional = pe + 24, optionalSize = bytes.readUInt16LE(pe + 20), characteristics = bytes.readUInt16LE(pe + 22);
  if (sections < 1 || sections > 96 || optionalSize < 0x70 || optionalSize > 0x1000 || optional + optionalSize + sections * 40 > bytes.length ||
      (characteristics & 2) === 0 || (characteristics & 0x2000) !== 0 || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt16LE(optional + 68) !== 3) fail();
  const entry = bytes.readUInt32LE(optional + 16), imageSize = bytes.readUInt32LE(optional + 56), headerSize = bytes.readUInt32LE(optional + 60);
  if (!entry || entry >= imageSize || headerSize > bytes.length || headerSize < optional + optionalSize + sections * 40 || imageSize > 512 * 1024 * 1024) fail();
  let executableEntry = false;
  for (let index = 0; index < sections; index++) {
    const section = optional + optionalSize + index * 40, virtualSize = bytes.readUInt32LE(section + 8), address = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16), rawOffset = bytes.readUInt32LE(section + 20), flags = bytes.readUInt32LE(section + 36);
    if (address + virtualSize > imageSize || rawSize && (rawOffset < headerSize || rawOffset + rawSize > bytes.length)) fail();
    if (entry >= address && entry < address + virtualSize && entry - address < rawSize && (flags & 0x20000000) !== 0) executableEntry = true;
  }
  if (!executableEntry) fail();
  return { bytes: bytes.length, sha256: hash(bytes) };
}
/** Bounded regular-import check for the staged executable; no loader/DLL execution or arbitrary names escape. */
export function windowsNodePosixSourceEntropyImports(bytes) {
  windowsNodePosixSourceImageFingerprint(bytes, buildPin.maximumNodeBytes);
  const pe = bytes.readUInt32LE(0x3c), optional = pe + 24, optionalSize = bytes.readUInt16LE(pe + 20), sections = bytes.readUInt16LE(pe + 6);
  if (optionalSize < 240 || bytes.readUInt32LE(optional + 108) !== 16 || bytes.readUInt32LE(optional + 216) || bytes.readUInt32LE(optional + 220)) fail();
  const ranges = [];
  for (let index = 0; index < sections; index++) {
    const at = optional + optionalSize + index * 40;
    ranges.push({ address: bytes.readUInt32LE(at + 12), size: bytes.readUInt32LE(at + 16), offset: bytes.readUInt32LE(at + 20) });
  }
  const location = (rva, length) => {
    if (!Number.isSafeInteger(rva) || rva < 1 || !Number.isSafeInteger(length) || length < 1 || rva + length > 0x100000000) fail();
    const matches = ranges.filter(range => rva >= range.address && rva + length <= range.address + range.size);
    if (matches.length !== 1) fail();
    const offset = matches[0].offset + rva - matches[0].address;
    if (offset < 0 || offset + length > bytes.length) fail(); return offset;
  };
  const ascii = (rva, maximum) => {
    let value = "";
    for (let index = 0; index <= maximum; index++) {
      const code = bytes[location(rva + index, 1)];
      if (code === 0) { if (!value) fail(); return value; }
      if (code < 33 || code > 126 || index === maximum) fail(); value += String.fromCharCode(code);
    }
    fail();
  };
  const table = bytes.readUInt32LE(optional + 120), size = bytes.readUInt32LE(optional + 124);
  if (!table || size < 40 || size > 64 * 1024) fail();
  let completed = false, required = 0, legacy = 0, symbols = 0;
  for (let index = 0; index < 64 && index * 20 + 20 <= size; index++) {
    const offset = location(table + index * 20, 20), fields = Array.from({ length: 5 }, (_, field) => bytes.readUInt32LE(offset + field * 4));
    if (fields.every(value => value === 0)) { completed = true; break; }
    const module = ascii(fields[3], 128).toLowerCase();
    if (!/^[a-z0-9_-]+\.dll$/.test(module)) fail();
    const thunk = fields[0] || fields[4]; if (!thunk) fail();
    let terminated = false;
    for (let symbol = 0; symbol < 4096; symbol++) {
      const value = bytes.readBigUInt64LE(location(thunk + symbol * 8, 8));
      if (value === 0n) { terminated = true; break; }
      if (++symbols > 4096) fail();
      if (value & (1n << 63n)) continue;
      if (value > 0xffffffffn) fail();
      const name = ascii(Number(value) + 2, 256);
      if (name.toLowerCase() === "cryptgenrandom") legacy++;
      if (name === "BCryptGenRandom") { if (module !== buildPin.entropyImportPolicy.module) fail(); required++; }
    }
    if (!terminated) fail();
  }
  if (!completed || required !== 1 || legacy !== 0) fail();
  return freeze({ module: buildPin.entropyImportPolicy.module, required: buildPin.entropyImportPolicy.required, requiredCount: required, legacyCryptGenRandomCount: legacy });
}

function inputBytes(file, maximum, pe = false) {
  const before = fs.lstatSync(file); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd), buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const read = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!read) break; length += read; }
    const bytes = buffer.subarray(0, length), after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || bytes.length !== before.size ||
        after.dev !== opened.dev || after.ino !== opened.ino || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink() || named.nlink !== 1 ||
        opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail();
    if (pe) windowsNodePosixSourceImageFingerprint(bytes, maximum);
    return bytes;
  } finally { fs.closeSync(fd); }
}
const snapshot = file => { const bytes = inputBytes(file, buildPin.maximumToolBytes); return { bytes: bytes.length, sha256: hash(bytes) }; };
const captured = (program, args, env, cwd, timeout = 30_000) => {
  try { return execFileSync(program, args, { env, cwd, encoding: "utf8", timeout, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { fail(); }
};
/** Caller-selected executables are not an interpreter trust root; this experiment accepts only the hosted image path. */
export function trustedWindowsNodePosixSourcePythonPath(value) {
  ordinary(value);
  if (value.toLowerCase() !== buildPin.pythonExecutable.toLowerCase()) fail();
  return buildPin.pythonExecutable;
}
export function attestWindowsNodePosixSourcePython(value, env, cwd) {
  const pythonPath = trustedWindowsNodePosixSourcePythonPath(value);
  const folders = []; let directory = path.win32.dirname(pythonPath);
  for (;;) { folders.push(directory); const parent = path.win32.dirname(directory); if (parent === directory) break; directory = parent; }
  for (const folder of folders.reverse()) { const info = fs.lstatSync(folder); if (!info.isDirectory() || info.isSymbolicLink()) fail(); }
  if (fs.realpathSync.native(pythonPath).toLowerCase() !== pythonPath.toLowerCase()) fail();
  const fingerprint = snapshot(pythonPath);
  const observedVersion = captured(pythonPath, ["-I", "-B", "-c", "import sys; print('.'.join(map(str,sys.version_info[:3])))"], env, cwd);
  if (observedVersion !== buildPin.pythonVersion || !equal(fingerprint, snapshot(pythonPath))) fail();
  return { pythonPath, version: observedVersion, fingerprint };
}
const firstPath = file => { const text = inputBytes(file, 16_384).toString("utf8"); return ordinary(text.split(/\r?\n/).filter(Boolean)[0]); };

export function windowsNodePosixSourceBuildBatch(paths) {
  if (!strict(paths, ["vcvars", "compiler", "linker", "source", "bootstrapSource", "bootstrapObject", "bootstrapOutput",
    "compilerBefore", "pythonBefore", "nasmBefore", "compilerAfter", "pythonAfter", "nasmAfter"])) fail();
  for (const value of Object.values(paths)) ordinary(value);
  return ["@echo off", "setlocal", `call "${paths.vcvars}" amd64 ${buildPin.sdk} -vcvars_ver=${buildPin.toolsetDirectory}`,
    "if errorlevel 1 exit /b 1", `if not "%VisualStudioVersion%"=="17.0" exit /b 1`, `if not "%VCToolsVersion%"=="${buildPin.toolsetDirectory}" exit /b 1`,
    `if not "%WindowsSDKVersion%"=="${buildPin.sdk}\\" exit /b 1`, `set "CL=${buildPin.compilerEnvironment}"`, "set _CL_=", "set LINK=", "set _LINK_=",
    `set "msbuild_args=${buildPin.msbuildArguments}"`, `where cl.exe > "${paths.compilerBefore}"`, `where python.exe > "${paths.pythonBefore}"`,
    `where nasm.exe > "${paths.nasmBefore}"`, `cd /d "${paths.source}"`, `call vcbuild.bat ${buildPin.vcbuildArguments.join(" ")}`, "if errorlevel 1 exit /b 1",
    `where cl.exe > "${paths.compilerAfter}"`, `where python.exe > "${paths.pythonAfter}"`, `where nasm.exe > "${paths.nasmAfter}"`,
    `"${paths.compiler}" ${buildPin.bootstrapCompileArguments.join(" ")} "${paths.bootstrapSource}" /Fo"${paths.bootstrapObject}"`, "if errorlevel 1 exit /b 1",
    `"${paths.linker}" ${buildPin.bootstrapLinkArguments.join(" ")} /OUT:"${paths.bootstrapOutput}" "${paths.bootstrapObject}" kernel32.lib`,
    "if errorlevel 1 exit /b 1", "exit /b 0", ""].join("\r\n");
}
/** Closed child outcome only: no error message, signal name, command, output or host path is retained. */
export function windowsNodePosixSourceCompileOutcome(result) {
  const outcome = (name, exitCode = null) => freeze({ schema: 1, outcome: name, exitCode });
  try {
    if (!result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "status") || !Object.hasOwn(result, "signal")) return outcome("malformed");
    const status = result.status, signal = result.signal, error = result.error;
    if (status !== null && (!Number.isInteger(status) || status < -0x80000000 || status > 0xffffffff) ||
        signal !== null && (typeof signal !== "string" || signal.length < 1 || signal.length > 64) ||
        error !== undefined && error !== null && (typeof error !== "object" || Array.isArray(error))) return outcome("malformed");
    if (error) {
      if (status !== null) return outcome("malformed");
      return outcome(error.code === "ETIMEDOUT" ? "timeout" : "spawn");
    }
    if (signal !== null) return status === null ? outcome("signal") : outcome("malformed");
    if (status === null) return outcome("malformed");
    return outcome(status === 0 ? "success" : "exit", status);
  } catch { return outcome("malformed"); }
}
let compileOutcome;
let buildStage = "inputs";
export async function buildWindowsNodePosixSource({ sourceArchivePath, nasmArchivePath, destination, pythonPath }) {
  buildStage = "inputs"; compileOutcome = undefined;
  if (process.platform !== "win32" || process.arch !== "x64") fail();
  for (const value of [sourceArchivePath, nasmArchivePath, destination, pythonPath]) ordinary(value);
  pythonPath = trustedWindowsNodePosixSourcePythonPath(pythonPath);
  if (/\s|[^\x21-\x7e]/.test(destination) || fs.existsSync(destination)) fail();
  const compileCommit = process.env.GITHUB_SHA; if (!/^[a-f0-9]{40}$/.test(compileCommit ?? "")) fail();
  fs.mkdirSync(destination, { mode: 0o700 });
  const directories = { temporary: path.join(destination, "temporary"), profile: path.join(destination, "profile"), local: path.join(destination, "profile", "Local"), roaming: path.join(destination, "profile", "Roaming") };
  for (const folder of Object.values(directories)) fs.mkdirSync(folder, { mode: 0o700 });
  const recipe = windowsNodePosixSourceBuildRecipe();
  const env = windowsNodePosixSourceBuildEnvironment(process.env, directories, { pythonDirectory: path.dirname(pythonPath), nasmDirectory: path.join(destination, "nasm") });
  buildStage = "attest-python";
  const python = attestWindowsNodePosixSourcePython(pythonPath, env, destination);
  const execution = { pythonPath: python.pythonPath, executionEnv: env, cwd: destination };
  buildStage = "prepare-source";
  const source = await prepareNodePosixSource({ archivePath: sourceArchivePath, destination: path.join(destination, "source"), ...execution });
  buildStage = "prepare-nasm";
  const nasm = await prepareNodePosixNasmTool({ archivePath: nasmArchivePath, destination: path.join(destination, "nasm"), ...execution });
  if (!equal(python.fingerprint, snapshot(pythonPath))) fail();
  const vswhere = ordinary(path.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"));
  buildStage = "select-toolchain";
  const selection = ["-latest", "-version", buildPin.visualStudioRange, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
  const installation = ordinary(captured(vswhere, [...selection, "-property", "installationPath"], env, destination));
  const vcvars = ordinary(path.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat"));
  const toolDirectory = path.join(installation, "VC", "Tools", "MSVC", buildPin.toolsetDirectory, "bin", "Hostx64", "x64");
  const toolsPaths = { compiler: ordinary(path.join(toolDirectory, "cl.exe")), linker: ordinary(path.join(toolDirectory, "link.exe")),
    msbuild: ordinary(path.join(installation, "MSBuild", "Current", "Bin", "amd64", "MSBuild.exe")), vcvars, vswhere, python: pythonPath, nasm: nasm.nasmPath };
  const tools = Object.fromEntries(Object.entries(toolsPaths).map(([name, file]) => [name, snapshot(file)]));
  if (!equal(tools.python, python.fingerprint)) fail();
  buildStage = "identify-tools";
  const powerShell = path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const metadata = JSON.parse(captured(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';[pscustomobject]@{compilerVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:EMBER_BUILD_COMPILER).FileVersion;linkerVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:EMBER_BUILD_LINKER).FileVersion}|ConvertTo-Json -Compress"],
  { ...env, EMBER_BUILD_COMPILER: toolsPaths.compiler, EMBER_BUILD_LINKER: toolsPaths.linker }, destination, 60_000));
  if (!strict(metadata, ["compilerVersion", "linkerVersion"])) fail();
  const nasmLine = captured(nasm.nasmPath, ["-v"], env, destination); if (nasmLine.length > 256 || !/^NASM version 2\.16\.03(?: compiled on [A-Za-z0-9 :]+)?$/.test(nasmLine)) fail();
  const observed = versions({ visualStudioVersion: captured(vswhere, [...selection, "-property", "installationVersion"], env, destination),
    compilerVersion: metadata.compilerVersion, linkerVersion: metadata.linkerVersion, msbuildVersion: captured(toolsPaths.msbuild, ["-version", "-nologo"], env, destination),
    pythonVersion: python.version, nasmVersion: buildPin.nasmVersion });
  buildStage = "validate-before";
  await validateNodePosixSourceInputs(source.baselineDir, "stock", execution); await validateNodePosixSourceInputs(source.workingDir, "offline", execution);
  buildStage = "compile-rename-abi";
  const renameAbi = compileWindowsNodePosixRenameAbi(destination, source.workingDir, toolsPaths, env);
  if (!equal(tools, Object.fromEntries(Object.entries(toolsPaths).map(([name, file]) => [name, snapshot(file)])))) fail();
  const bootstrapSource = ordinary(path.join(root, "test/fixtures/windows-node-source-bootstrap.c"));
  const batchPaths = { vcvars, compiler: toolsPaths.compiler, linker: toolsPaths.linker, source: source.workingDir, bootstrapSource,
    bootstrapObject: path.join(destination, "bootstrap.obj"), bootstrapOutput: path.join(destination, "bootstrap-built.exe") };
  for (const name of ["compilerBefore", "pythonBefore", "nasmBefore", "compilerAfter", "pythonAfter", "nasmAfter"]) batchPaths[name] = path.join(destination, `${name}.txt`);
  const batch = path.join(destination, "build-source.cmd"); fs.writeFileSync(batch, windowsNodePosixSourceBuildBatch(batchPaths), { flag: "wx" });
  buildStage = "compile";
  const result = spawnSync(env.ComSpec, ["/d", "/s", "/v:off", "/c", batch], { env, cwd: destination, stdio: "inherit", timeout: buildPin.nodeBuildTimeoutMs, windowsHide: true });
  compileOutcome = windowsNodePosixSourceCompileOutcome(result);
  if (compileOutcome.outcome !== "success") fail();
  buildStage = "post-batch-tool-identity";
  for (const [name, expected] of [["compiler", toolsPaths.compiler], ["python", pythonPath], ["nasm", nasm.nasmPath]]) {
    for (const suffix of ["Before", "After"]) if (firstPath(batchPaths[`${name}${suffix}`]).toLowerCase() !== expected.toLowerCase()) fail();
  }
  buildStage = "validate-after";
  await validateNodePosixSourceInputs(source.baselineDir, "stock", execution); await validateNodePosixSourceInputs(source.workingDir, "offline", { ...execution, allowGenerated: true });
  if (!equal(recipe, windowsNodePosixSourceBuildRecipe()) || !equal(tools, Object.fromEntries(Object.entries(toolsPaths).map(([name, file]) => [name, snapshot(file)])))) fail();
  buildStage = "stage-assets";
  const assets = {};
  for (const [key, file, name, maximum] of [["node", path.join(source.workingDir, "out", "Release", "node.exe"), "source-node.exe", buildPin.maximumNodeBytes],
    ["bootstrap", batchPaths.bootstrapOutput, "bootstrap.exe", buildPin.maximumBootstrapBytes]]) {
    const bytes = inputBytes(file, maximum, true), destinationFile = path.join(destination, name);
    if (key === "node") windowsNodePosixSourceEntropyImports(bytes);
    fs.writeFileSync(destinationFile, bytes, { flag: "wx" });
    const readback = inputBytes(destinationFile, maximum, true); if (!bytes.equals(readback)) fail();
    if (key === "node") windowsNodePosixSourceEntropyImports(readback);
    assets[key] = { name, bytes: bytes.length, sha256: hash(readback) };
  }
  fs.writeFileSync(path.join(destination, "LICENSE"), inputBytes(path.join(source.baselineDir, "LICENSE"), 1024 * 1024), { flag: "wx" });
  buildStage = "final-receipt";
  const receipt = { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256, sourceCommit: sourcePin.provenance.commit,
    source: sourceSummary(), build: { ...buildPin, ...observed }, tools, recipe, commit: compileCommit, assets, renameAbi };
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"); parseWindowsNodePosixSourceBuildReceipt(bytes, compileCommit);
  fs.writeFileSync(path.join(destination, "build-receipt.json"), bytes, { flag: "wx" });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 8 || args[0] !== "--source-archive" || args[2] !== "--nasm-archive" || args[4] !== "--destination" || args[6] !== "--python") fail();
    const receipt = await buildWindowsNodePosixSource({ sourceArchivePath: args[1], nasmArchivePath: args[3], destination: args[5], pythonPath: args[7] });
    console.log(JSON.stringify({ issuer: receipt.issuer, version: receipt.sourceVersion, compilerVersion: receipt.build.compilerVersion, nodeBytes: receipt.assets.node.bytes, bootstrapBytes: receipt.assets.bootstrap.bytes }));
  } catch { console.error(JSON.stringify({ status: "failed", stage: buildStage, ...(compileOutcome ? { compile: compileOutcome } : {}) })); process.exitCode = 1; }
}
