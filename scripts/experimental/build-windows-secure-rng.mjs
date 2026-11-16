/** Compile the separate fixed repository C secure API witness.
 * usage: node scripts/experimental/build-windows-secure-rng.mjs --destination <fresh-absolute-directory> --image <windows-2022|windows-2025>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const fail = () => { throw new Error("The fixed secure RNG prerequisite failed its exact build contract."); };
const hash = value => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const strict = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && equal(Object.keys(value).sort(), [...keys].sort());
export const buildPin = freeze(JSON.parse(fs.readFileSync(path.join(root, "scripts/experimental/windows-secure-rng-pin.json"), "utf8")));
export function selectedWindowsSecureRngPin(image) {
  if (typeof image !== "string" || !Object.hasOwn(buildPin.hostRecipes, image)) fail();
  const { hostRecipes, ...common } = buildPin;
  return freeze({ ...common, image, ...hostRecipes[image] });
}
const recipeFiles = ["scripts/experimental/build-windows-secure-rng.mjs", "scripts/experimental/windows-secure-rng-pin.json", "test/fixtures/windows-secure-rng-probe.c"];
export function windowsSecureRngRecipe() { return recipeFiles.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) })); }
const loadedRecipe = windowsSecureRngRecipe();
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const fingerprint = value => strict(value, ["bytes", "sha256"]) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 64 * 1024 * 1024 && digest(value.sha256);
export function parseWindowsSecureRngBuildReceipt(bytes, commit, image) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16384 || !/^[0-9a-f]{40}$/.test(commit)) fail();
    const value = JSON.parse(bytes.toString("utf8")), selected = selectedWindowsSecureRngPin(image);
    if (!strict(value, ["schema", "issuer", "build", "tools", "recipe", "commit", "asset"]) || value.schema !== 1 || value.issuer !== buildPin.issuer || value.commit !== commit) fail();
    const observations = ["visualStudioVersion", "compilerVersion", "linkerVersion"];
    if (!strict(value.build, [...Object.keys(selected), ...observations])) fail();
    for (const key of observations) if (typeof value.build[key] !== "string" || !/^\d+(?:\.\d+){1,3}$/.test(value.build[key]) ||
      !value.build[key].startsWith(selected[`${key}Prefix`])) fail();
    if (!equal(value.build, { ...selected, ...Object.fromEntries(observations.map(key => [key, value.build[key]])) })) fail();
    if (!strict(value.tools, ["compiler", "linker", "vcvars", "vswhere"]) || !Object.values(value.tools).every(fingerprint) || !equal(value.recipe, loadedRecipe)) fail();
    if (!strict(value.asset, ["name", "bytes", "sha256"]) || value.asset.name !== "secure-rng-probe.exe" || !fingerprint(value.asset === null ? null : { bytes: value.asset.bytes, sha256: value.asset.sha256 }) || value.asset.bytes > buildPin.maximumExecutableBytes) fail();
    return freeze(value);
  } catch { fail(); }
}
const ordinary = value => {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || /[%!^&|<>";\p{Cc}\p{Cf}]/u.test(value) || path.win32.normalize(value) !== value ||
      value.slice(3).split("\\").some(part => !part || /[. ]$/.test(part) || part.includes(":"))) fail();
  return value;
};
export function windowsSecureRngBuildEnvironment(base, directories) {
  if (!strict(directories, ["profile", "temporary", "local", "roaming"])) fail();
  Object.values(directories).forEach(ordinary);
  const get = key => {
    const values = Object.entries(base).filter(([name]) => name.toLowerCase() === key.toLowerCase()).map(([, value]) => value);
    if (values.length > 1 && !values.every(value => value === values[0])) fail(); return values[0];
  };
  const windows = ordinary(get("SystemRoot") ?? "C:\\Windows");
  if (windows.toLowerCase() !== "c:\\windows") fail();
  return { SystemRoot: windows, WINDIR: windows, ComSpec: `${windows}\\System32\\cmd.exe`, SystemDrive: "C:",
    ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files",
    CommonProgramFiles: "C:\\Program Files\\Common Files", "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files", CommonProgramW6432: "C:\\Program Files\\Common Files",
    PATH: `${windows}\\System32;${windows}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", PROCESSOR_ARCHITECTURE: "AMD64", NUMBER_OF_PROCESSORS: "2",
    USERPROFILE: directories.profile, TEMP: directories.temporary, TMP: directories.temporary, LOCALAPPDATA: directories.local, APPDATA: directories.roaming };
}
function inputBytes(file, maximum) {
  const absolute = path.resolve(file), parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || current !== absolute && !stat.isDirectory()) fail();
  }
  if (fs.realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) fail();
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const start = fs.fstatSync(fd), bytes = Buffer.alloc(before.size + 1); let read = 0;
    if (start.ino !== before.ino || start.dev !== before.dev || start.size !== before.size || !start.isFile() || start.nlink !== 1) fail();
    while (read < bytes.length) { const count = fs.readSync(fd, bytes, read, bytes.length - read, read); if (!count) break; read += count; }
    const end = fs.fstatSync(fd), observed = fs.lstatSync(file);
    if (read !== start.size || end.ino !== start.ino || end.dev !== start.dev || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs ||
      observed.isSymbolicLink() || observed.ino !== start.ino || observed.dev !== start.dev || observed.size !== start.size || observed.nlink !== 1) fail();
    return bytes.subarray(0, read);
  } finally { fs.closeSync(fd); }
}
const snapshot = file => { const bytes = inputBytes(file, 64 * 1024 * 1024); return { bytes: bytes.length, sha256: hash(bytes) }; };
export function windowsSecureRngPeFingerprint(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > buildPin.maximumExecutableBytes || bytes.readUInt16LE(0) !== 0x5a4d) fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) fail();
  const sections = bytes.readUInt16LE(pe + 6), optional = pe + 24, optionalSize = bytes.readUInt16LE(pe + 20), characteristics = bytes.readUInt16LE(pe + 22);
  if (sections < 1 || sections > 96 || optionalSize < 0x70 || optionalSize > 0x1000 || optional + optionalSize + sections * 40 > bytes.length ||
    (characteristics & 0x2002) !== 2 || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt16LE(optional + 68) !== 3) fail();
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
export function windowsSecureRngBuildBatch(paths) {
  if (!strict(paths, ["vcvars", "compiler", "linker", "source", "object", "output", "compilerPath", "linkerPath", "sdkMetadata", "toolsetMetadata"])) fail();
  Object.values(paths).forEach(ordinary);
  return ["@echo off", "setlocal", `call "${paths.vcvars}" amd64 ${buildPin.sdk} -vcvars_ver=${buildPin.toolsetDirectory} >nul`,
    "if errorlevel 1 exit /b 1", `where cl.exe > "${paths.compilerPath}"`, "if errorlevel 1 exit /b 1", `where link.exe > "${paths.linkerPath}"`, "if errorlevel 1 exit /b 1",
    `> "${paths.sdkMetadata}" echo %WindowsSDKVersion%`, `> "${paths.toolsetMetadata}" echo %VCToolsVersion%`,
    `"${paths.compiler}" /nologo /O1 /GS /MT /W4 /WX /Fo"${paths.object}" /Fe"${paths.output}" "${paths.source}" /link /MACHINE:X64 /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib bcrypt.lib`,
    "if errorlevel 1 exit /b 1", "exit /b 0", ""].join("\r\n");
}
let buildStage = "inputs";
export function buildWindowsSecureRng({ destination, image }) {
  if (process.platform !== "win32" || process.arch !== "x64") fail();
  const selected = selectedWindowsSecureRngPin(image), commit = process.env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "") || fs.existsSync(ordinary(destination))) fail();
  fs.mkdirSync(destination, { mode: 0o700 });
  const directories = { profile: path.join(destination, "profile"), temporary: path.join(destination, "temporary"), local: path.join(destination, "profile", "Local"), roaming: path.join(destination, "profile", "Roaming") };
  Object.values(directories).forEach(directory => fs.mkdirSync(directory, { mode: 0o700 }));
  const env = windowsSecureRngBuildEnvironment(process.env, directories);
  const captured = (program, args, extra = {}) => {
    try { return execFileSync(program, args, { env: { ...env, ...extra }, cwd: destination, encoding: "utf8", timeout: buildPin.compileTimeoutMs, maxBuffer: 1024 * 1024,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { fail(); }
  };
  buildStage = "toolchain";
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  const selectedArgs = ["-latest", "-version", selected.visualStudioRange, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
  const vswhereBefore = snapshot(vswhere);
  const installation = ordinary(captured(vswhere, [...selectedArgs, "-property", "installationPath"]));
  if (!installation.toLowerCase().startsWith("c:\\program files\\microsoft visual studio\\")) fail();
  const vcvars = path.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat"), tool = path.join(installation, "VC", "Tools", "MSVC", buildPin.toolsetDirectory, "bin", "Hostx64", "x64");
  const toolPaths = { compiler: path.join(tool, "cl.exe"), linker: path.join(tool, "link.exe"), vcvars, vswhere };
  const tools = Object.fromEntries(Object.entries(toolPaths).map(([name, file]) => [name, snapshot(file)]));
  if (!equal(vswhereBefore, tools.vswhere)) fail();
  const powershell = path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const metadata = JSON.parse(captured(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';[pscustomobject]@{compilerVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:EMBER_SECURE_RNG_COMPILER).FileVersion;linkerVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:EMBER_SECURE_RNG_LINKER).FileVersion}|ConvertTo-Json -Compress"],
  { EMBER_SECURE_RNG_COMPILER: toolPaths.compiler, EMBER_SECURE_RNG_LINKER: toolPaths.linker }));
  if (!strict(metadata, ["compilerVersion", "linkerVersion"])) fail();
  const build = { ...selected, visualStudioVersion: captured(vswhere, [...selectedArgs, "-property", "installationVersion"]), ...metadata };
  const paths = { vcvars, compiler: toolPaths.compiler, linker: toolPaths.linker, source: path.join(root, recipeFiles[2]), object: path.join(destination, "probe.obj"), output: path.join(destination, "built.exe"),
    compilerPath: path.join(destination, "compiler-path.txt"), linkerPath: path.join(destination, "linker-path.txt"), sdkMetadata: path.join(destination, "sdk.txt"), toolsetMetadata: path.join(destination, "toolset.txt") };
  const recipe = windowsSecureRngRecipe(); if (!equal(recipe, loadedRecipe)) fail();
  const batch = path.join(destination, "build.cmd"); fs.writeFileSync(batch, windowsSecureRngBuildBatch(paths), { flag: "wx" });
  buildStage = "compile"; captured(env.ComSpec, ["/d", "/s", "/v:off", "/c", batch]);
  for (const [name, expected] of [["compilerPath", paths.compiler], ["linkerPath", paths.linker]]) {
    const first = inputBytes(paths[name], 32768).toString("utf8").split(/\r?\n/).filter(Boolean)[0]; if (first?.toLowerCase() !== expected.toLowerCase()) fail();
  }
  if (inputBytes(paths.sdkMetadata, 256).toString("utf8").trim().replace(/\\$/, "") !== buildPin.sdk ||
    inputBytes(paths.toolsetMetadata, 256).toString("utf8").trim().replace(/\\$/, "") !== buildPin.toolsetDirectory) fail();
  if (!equal(recipe, windowsSecureRngRecipe()) || !equal(tools, Object.fromEntries(Object.entries(toolPaths).map(([name, file]) => [name, snapshot(file)])))) fail();
  buildStage = "stage";
  const bytes = inputBytes(paths.output, buildPin.maximumExecutableBytes), asset = { name: "secure-rng-probe.exe", ...windowsSecureRngPeFingerprint(bytes) };
  const output = path.join(destination, asset.name); fs.writeFileSync(output, bytes, { flag: "wx" });
  if (!bytes.equals(inputBytes(output, buildPin.maximumExecutableBytes))) fail();
  const receipt = { schema: 1, issuer: buildPin.issuer, build, tools, recipe, commit, asset };
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"); parseWindowsSecureRngBuildReceipt(receiptBytes, commit, image);
  fs.writeFileSync(path.join(destination, "build-receipt.json"), receiptBytes, { flag: "wx" }); return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (args.length !== 4 || args[0] !== "--destination" || args[2] !== "--image") fail();
    const receipt = buildWindowsSecureRng({ destination: args[1], image: args[3] });
    console.log(JSON.stringify({ issuer: receipt.issuer, image: receipt.build.image, bytes: receipt.asset.bytes, sha256: receipt.asset.sha256 }));
  } catch { console.error(JSON.stringify({ status: "failed", stage: buildStage })); process.exitCode = 1; }
}
