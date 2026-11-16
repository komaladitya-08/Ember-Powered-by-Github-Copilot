/** Trusted-host fixed libuv spawn build. Usage: --archive <fixed archive> --destination <fresh directory> --python <hosted interpreter>. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareWindowsUvSpawnSource, validateWindowsUvSpawnSource, sourcePin } from "./windows-uv-spawn-source.mjs";
import { inspectWindowsUvSpawnEmission, parseWindowsUvSpawnEmission, emissionLimits } from "./windows-uv-spawn-emission.mjs";
import { createUvSpawnBuildDiagnostic, classifyUvSpawnBuildFailure, uvSpawnBuildCheckpoints as checkpoints } from "./windows-uv-spawn-build-diagnostic.mjs";
export { sourcePin };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
export const buildPin = freeze(JSON.parse(fs.readFileSync(new URL("./windows-uv-spawn-build-pin.json", import.meta.url), "utf8")));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("The fixed uv_spawn build failed its exact source, recipe or issuer contract."); };
const strict = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const equal = (actual, expected) => {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equal(actual[index], item));
  if (expected && typeof expected === "object") return strict(actual, Object.keys(expected)) && Object.keys(expected).every(key => equal(actual[key], expected[key]));
  return actual === expected;
};
const fixedFiles = ["scripts/experimental/build-windows-uv-spawn-probe.mjs", "scripts/experimental/windows-uv-spawn-build-pin.json",
  "scripts/experimental/windows-uv-spawn-source.mjs", "scripts/experimental/windows-uv-spawn-source-pin.json",
  "scripts/experimental/windows-uv-spawn-emission.mjs", "scripts/experimental/windows-uv-spawn-build-diagnostic.mjs",
  "scripts/experimental/extract-node-libuv-source.py", "scripts/experimental/windows-libuv-source-pin.json",
  "test/fixtures/windows-uv-spawn-build/CMakeLists.txt", "test/fixtures/windows-uv-spawn-probe.c",
  "test/fixtures/windows-uv-spawn-observe.h", "test/fixtures/windows-uv-spawn-observe.c"];
/** Exact compile authority only; runtime proof, harness and future diagnostics have their own authority. */
export function windowsUvSpawnRecipe() { return fixedFiles.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) })); }
const sourceSummary = () => ({ stockManifestSha256: sourcePin.stockManifestSha256, workingManifestSha256: sourcePin.workingManifestSha256,
  ...sourcePin.inventory, patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }) => ({ file, beforeSha256, afterSha256, kind })) });
const version = value => typeof value === "string" && /^[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}$/.test(value);
const observationKeys = ["visualStudioVersion", "compilerVersion", "linkerVersion", "msbuildVersion", "pythonVersion", "cmakeVersion"];
function versions(value) {
  if (!strict(value, observationKeys) || !observationKeys.every(key => version(value[key])) ||
      !value.visualStudioVersion.startsWith(buildPin.visualStudioVersionPrefix) || !value.compilerVersion.startsWith(buildPin.compilerVersionPrefix) ||
      !value.linkerVersion.startsWith(buildPin.linkerVersionPrefix) || !value.msbuildVersion.startsWith(buildPin.msbuildVersionPrefix) ||
      value.pythonVersion !== buildPin.pythonVersion || value.cmakeVersion !== buildPin.cmakeVersion) fail();
  return value;
}
const fingerprint = (value, maximum = buildPin.maximumToolBytes) => strict(value, ["bytes", "sha256"]) && Number.isSafeInteger(value.bytes) && value.bytes >= 1 && value.bytes <= maximum && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
/** Pure bounded receipt validation. Recipe is recomputed from the trusted checkout, never supplied by the asset. */
export function parseWindowsUvSpawnBuildReceipt(bytes, expectedCompileCommit) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > buildPin.maximumReceiptBytes || typeof expectedCompileCommit !== "string" || !/^[a-f0-9]{40}$/.test(expectedCompileCommit)) fail();
    const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes)) fail(); const value = JSON.parse(text);
    if (!strict(value, ["schema", "issuer", "sourceVersion", "sourceArchiveSha256", "sourceCommit", "source", "build", "tools", "recipe", "commit", "assets"]) ||
        value.schema !== 1 || value.issuer !== sourcePin.issuer || value.sourceVersion !== sourcePin.version || value.sourceArchiveSha256 !== sourcePin.sourceArchive.sha256 ||
        value.sourceCommit !== sourcePin.provenance.commit || value.commit !== expectedCompileCommit || !equal(value.source, sourceSummary()) || !equal(value.recipe, windowsUvSpawnRecipe())) fail();
    const observed = Object.fromEntries(observationKeys.map(key => [key, value.build?.[key]])); versions(observed);
    const projects = value.build?.generatedProjects, listing = value.build?.observerListing, object = value.build?.observerObject, emission = value.build?.observerEmission;
    if (!Array.isArray(projects) || projects.length !== 2) fail();
    for (const [index, target] of ["uv_a", "ember_uv_spawn_probe"].entries()) {
      const project = projects[index];
      if (!strict(project, ["target", "bytes", "sha256", "targetMacro", "releaseDefinitionCount"]) || project.target !== target || project.targetMacro !== buildPin.targetMacro ||
          project.releaseDefinitionCount !== 1 || !fingerprint({ bytes: project.bytes, sha256: project.sha256 }, buildPin.maximumProjectBytes)) fail();
    }
    if (!strict(listing, ["bytes", "sha256", "review"]) || listing.review !== "not-reviewed" || !fingerprint({ bytes: listing.bytes, sha256: listing.sha256 }, buildPin.maximumListingBytes) ||
        !fingerprint(object, buildPin.maximumObjectBytes) || !strict(emission, ["name", "bytes", "sha256", "schema", "review", "status"]) ||
        emission.name !== "observer-emission.json" || emission.schema !== 1 || emission.review !== "not-reviewed" || !["candidate", "refused"].includes(emission.status) ||
        !fingerprint({ bytes: emission.bytes, sha256: emission.sha256 }, emissionLimits.artifactBytes) ||
        !equal(value.build, { ...buildPin, ...observed, generatedProjects: projects, observerListing: listing, observerObject: object, observerEmission: emission }) ||
        !strict(value.tools, ["compiler", "linker", "msbuild", "vcvars", "vswhere", "python", "cmake"]) || !Object.values(value.tools).every(item => fingerprint(item)) || !strict(value.assets, ["probe"])) fail();
    const asset = value.assets.probe;
    if (!strict(asset, ["name", "bytes", "sha256"]) || asset.name !== "uv-spawn-probe.exe" || asset.bytes < 512 || !fingerprint({ bytes: asset.bytes, sha256: asset.sha256 }, buildPin.maximumExecutableBytes)) fail();
    return freeze(value);
  } catch { fail(); }
}

function ordinary(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || /[^\x20-\x7e]|[%!^&|<>";]/.test(value) || value.slice(2).includes(":") || path.win32.normalize(value) !== value ||
      value.slice(3).split("\\").some(part => part === "." || part === ".." || /[. ]$/.test(part))) fail();
  return value;
}

export function windowsUvSpawnImageFingerprint(bytes, maximum) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(maximum) || maximum < 512 || maximum > buildPin.maximumExecutableBytes || bytes.length < 512 || bytes.length > maximum || bytes.toString("ascii", 0, 2) !== "MZ") fail();
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

function inputBytes(file, maximum, pe = false) {
  ordinary(file);
  const parents = []; let directory = path.win32.dirname(file);
  for (;;) { parents.push(directory); const next = path.win32.dirname(directory); if (next === directory) break; directory = next; }
  for (const parent of parents.reverse()) { const info = fs.lstatSync(parent); if (!info.isDirectory() || info.isSymbolicLink()) fail(); }
  if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) fail();
  const before = fs.lstatSync(file); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd), buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const read = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!read) break; length += read; }
    const bytes = buffer.subarray(0, length), after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || bytes.length !== before.size ||
        after.dev !== opened.dev || after.ino !== opened.ino || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink() || named.nlink !== 1 ||
        opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) fail();
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) fail();
    if (pe) windowsUvSpawnImageFingerprint(bytes, maximum);
    return bytes;
  } finally { fs.closeSync(fd); }
}
const snapshot = file => { const bytes = inputBytes(file, buildPin.maximumToolBytes); return { bytes: bytes.length, sha256: hash(bytes) }; };
const captured = (program, args, env, cwd, timeout = 30_000) => {
  try { return execFileSync(program, args, { env, cwd, encoding: "utf8", timeout, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { fail(); }
};
/** Caller-selected executables are not an interpreter trust root; this experiment accepts only the hosted image path. */
export function trustedWindowsUvSpawnPythonPath(value) {
  ordinary(value);
  if (value.toLowerCase() !== buildPin.pythonExecutable.toLowerCase()) fail();
  return buildPin.pythonExecutable;
}
export function attestWindowsUvSpawnPython(value, env, cwd) {
  const pythonPath = trustedWindowsUvSpawnPythonPath(value);
  const folders = []; let directory = path.win32.dirname(pythonPath);
  for (;;) { folders.push(directory); const parent = path.win32.dirname(directory); if (parent === directory) break; directory = parent; }
  for (const folder of folders.reverse()) { const info = fs.lstatSync(folder); if (!info.isDirectory() || info.isSymbolicLink()) fail(); }
  if (fs.realpathSync.native(pythonPath).toLowerCase() !== pythonPath.toLowerCase()) fail();
  const fingerprint = snapshot(pythonPath);
  const observedVersion = captured(pythonPath, ["-I", "-B", "-c", "import sys; print('.'.join(map(str,sys.version_info[:3])))"], env, cwd);
  if (observedVersion !== buildPin.pythonVersion || !equal(fingerprint, snapshot(pythonPath))) fail();
  return { pythonPath, version: observedVersion, fingerprint };
}

/** Build tools receive only Windows installation paths and a fresh profile, with no ambient flags or credentials. */
export function windowsUvSpawnBuildEnvironment(base, directories, pythonDirectory) {
  if (!strict(directories, ["temporary", "profile", "local", "roaming"])) fail();
  const env = {};
  for (const name of ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"]) {
    const found = Object.entries(base).filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === "string");
    if (found.length > 1 && found.some(([, value]) => value !== found[0][1])) fail();
    if (found.length) env[name] = ordinary(found[0][1]);
  }
  for (const value of [...Object.values(directories), pythonDirectory]) ordinary(value);
  const windows = ordinary(env.SystemRoot);
  return { ...env, WINDIR: windows, ComSpec: path.win32.join(windows, "System32", "cmd.exe"), SystemDrive: path.win32.parse(windows).root.slice(0, 2),
    PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: [pythonDirectory, path.win32.join(windows, "System32"), windows].join(";"),
    USERPROFILE: directories.profile, LOCALAPPDATA: directories.local, APPDATA: directories.roaming, TEMP: directories.temporary, TMP: directories.temporary,
    PROCESSOR_ARCHITECTURE: "AMD64", NUMBER_OF_PROCESSORS: "2", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", MSBUILDDISABLENODEREUSE: "1" };
}

/** Inspect the selected Release x64 compile definitions without loading the generated project or executing MSBuild. */
export function windowsUvSpawnProjectWitness(bytes, target) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > buildPin.maximumProjectBytes || !["uv_a", "ember_uv_spawn_probe"].includes(target)) fail();
    const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes) || /<!DOCTYPE|<!ENTITY/.test(text)) fail();
    const groups = [...text.matchAll(/<ItemDefinitionGroup\b[^>]*Condition="([^"]*)"[^>]*>([\s\S]*?)<\/ItemDefinitionGroup>/g)]
      .filter(match => match[1].replaceAll(" ", "") === "'$(Configuration)|$(Platform)'=='Release|x64'");
    if (groups.length !== 1) fail();
    const definitions = [...groups[0][2].matchAll(/<PreprocessorDefinitions>([^<]*)<\/PreprocessorDefinitions>/g)];
    if (definitions.length !== 1) fail();
    const macros = definitions[0][1].split(";").filter(value => value.includes("_WIN32_WINNT"));
    if (!equal(macros, ["_WIN32_WINNT=0x0602"]) || !definitions[0][1].split(";").includes(buildPin.offlineMacro) ||
        !groups[0][2].includes("<RuntimeLibrary>MultiThreaded</RuntimeLibrary>") ||
        groups[0][2].replace(definitions[0][0], "").includes("_WIN32_WINNT")) fail();
    const toolset = [...text.matchAll(/<PlatformToolset>([^<]*)<\/PlatformToolset>/g)];
    const sdk = [...text.matchAll(/<WindowsTargetPlatformVersion>([^<]*)<\/WindowsTargetPlatformVersion>/g)];
    if (toolset.length < 1 || toolset.some(item => item[1] !== "v143") || sdk.length !== 1 || sdk[0][1] !== buildPin.sdk) fail();
    const units = [...text.matchAll(/<ClCompile\s+Include="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/ClCompile>)/g)];
    let selected = 0;
    for (const unit of units) {
      const file = unit[1].replaceAll("\\", "/").toLowerCase(), properties = unit[2] ?? "";
      if (properties.includes("_WIN32_WINNT")) fail();
      const kind = target === "uv_a" && /\/src\/win\/pipe\.c$/.test(file) ? "PIPE" :
        target === "uv_a" && /\/src\/win\/process\.c$/.test(file) ? "PROCESS" : null;
      if (kind) {
        selected++;
        const release = [...properties.matchAll(/<(PreprocessorDefinitions|ForcedIncludeFiles|AdditionalOptions)\b([^>]*)>([^<]*)<\/\1>/g)]
          .filter(item => {
            const conditions = [...item[2].matchAll(/\bCondition="([^"]*)"/g)];
            return conditions.length === 0 || conditions.length === 1 && conditions[0][1].replaceAll(" ", "") === "'$(Configuration)|$(Platform)'=='Release|x64'";
          });
        const definitions = release.filter(item => item[1] === "PreprocessorDefinitions").map(item => item[3]).join(";");
        const includes = release.filter(item => item[1] !== "PreprocessorDefinitions").map(item => item[3]).join(";");
        if (!definitions.split(";").includes(`EMBER_UV_SPAWN_OBSERVE_${kind}=1`) || !includes.includes("windows-uv-spawn-observe.h") ||
            properties.includes(`EMBER_UV_SPAWN_OBSERVE_${kind === "PIPE" ? "PROCESS" : "PIPE"}=1`)) fail();
      } else if (/EMBER_UV_SPAWN_OBSERVE_|windows-uv-spawn-observe\.h/.test(properties)) fail();
    }
    if (selected !== (target === "uv_a" ? 2 : 0) || units.length < (target === "uv_a" ? 2 : 2)) fail();
    return { target, bytes: bytes.length, sha256: hash(bytes), targetMacro: buildPin.targetMacro, releaseDefinitionCount: 1 };
  } catch { fail(); }
}

/** Fixed Windows-only MSVC producer. This definition does not run until the separately reviewed workflow invokes it. */
export async function buildWindowsUvSpawnProbe({ archivePath, destination, pythonPath }) {
  const diagnostic = createUvSpawnBuildDiagnostic();
  try {
    diagnostic.checkpoint(checkpoints.input);
    if (process.platform !== "win32" || process.arch !== "x64") fail();
    for (const value of [archivePath, destination, pythonPath]) ordinary(value);
    pythonPath = trustedWindowsUvSpawnPythonPath(pythonPath);
    if (fs.existsSync(destination)) fail();
    const commit = process.env.GITHUB_SHA; if (!/^[a-f0-9]{40}$/.test(commit ?? "")) fail();
    diagnostic.checkpoint(checkpoints.setup);
    fs.mkdirSync(destination, { mode: 0o700 });
    const directories = { temporary: path.join(destination, "temporary"), profile: path.join(destination, "profile"),
      local: path.join(destination, "profile", "Local"), roaming: path.join(destination, "profile", "Roaming") };
    for (const folder of Object.values(directories)) fs.mkdirSync(folder, { mode: 0o700 });
    const env = windowsUvSpawnBuildEnvironment(process.env, directories, path.dirname(pythonPath));
    const recipe = windowsUvSpawnRecipe();
    diagnostic.checkpoint(checkpoints.python);
    const python = attestWindowsUvSpawnPython(pythonPath, env, destination);
    diagnostic.checkpoint(checkpoints.source);
    const sources = await prepareWindowsUvSpawnSource({ archivePath, destination: path.join(destination, "source"), pythonPath: python.pythonPath, executionEnv: env, cwd: destination });
    if (!equal(python.fingerprint, snapshot(pythonPath))) fail();
    diagnostic.checkpoint(checkpoints.visualStudio);
    const vswhere = ordinary(path.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"));
    const vswhereBefore = snapshot(vswhere);
    const selection = ["-latest", "-version", buildPin.visualStudioRange, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
    const installation = ordinary(captured(vswhere, [...selection, "-property", "installationPath"], env, destination));
    diagnostic.checkpoint(checkpoints.tools);
    const toolDirectory = path.join(installation, "VC", "Tools", "MSVC", buildPin.toolsetDirectory, "bin", "Hostx64", "x64");
    const toolPaths = { compiler: ordinary(path.join(toolDirectory, "cl.exe")), linker: ordinary(path.join(toolDirectory, "link.exe")),
      msbuild: ordinary(path.join(installation, "MSBuild", "Current", "Bin", "amd64", "MSBuild.exe")),
      vcvars: ordinary(path.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat")), vswhere,
      python: pythonPath, cmake: ordinary(path.join(env.ProgramFiles ?? "C:\\Program Files", "CMake", "bin", "cmake.exe")) };
    const tools = Object.fromEntries(Object.entries(toolPaths).map(([name, file]) => [name, snapshot(file)]));
    if (!equal(tools.python, python.fingerprint) || !equal(tools.vswhere, vswhereBefore)) fail();
    diagnostic.checkpoint(checkpoints.versions);
    const metadata = JSON.parse(captured(path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';[pscustomobject]@{compilerVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:EMBER_BUILD_COMPILER).FileVersion;linkerVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:EMBER_BUILD_LINKER).FileVersion}|ConvertTo-Json -Compress"],
      { ...env, EMBER_BUILD_COMPILER: toolPaths.compiler, EMBER_BUILD_LINKER: toolPaths.linker }, destination));
    if (!strict(metadata, ["compilerVersion", "linkerVersion"])) fail();
    const cmakeVersion = captured(toolPaths.cmake, ["--version"], env, destination).split(/\r?\n/, 1)[0];
    if (cmakeVersion !== `cmake version ${buildPin.cmakeVersion}`) fail();
    const observed = versions({ visualStudioVersion: captured(vswhere, [...selection, "-property", "installationVersion"], env, destination),
      compilerVersion: metadata.compilerVersion, linkerVersion: metadata.linkerVersion,
      msbuildVersion: captured(toolPaths.msbuild, ["-version", "-nologo"], env, destination), pythonVersion: python.version, cmakeVersion: buildPin.cmakeVersion });
    diagnostic.checkpoint(checkpoints.sourceBefore);
    await validateWindowsUvSpawnSource(sources.stockDir, "stock"); await validateWindowsUvSpawnSource(sources.workingDir, "working");
    const projectDirectory = ordinary(path.join(root, "test", "fixtures", "windows-uv-spawn-build")), buildDirectory = ordinary(path.join(destination, "build"));
    const cmakePath = value => ordinary(value).replaceAll("\\", "/");
    diagnostic.checkpoint(checkpoints.configure);
    captured(toolPaths.cmake, ["-S", cmakePath(projectDirectory), "-B", cmakePath(buildDirectory), "-G", buildPin.generator, "-A", buildPin.platform, "-T", buildPin.toolset,
      `-DCMAKE_GENERATOR_INSTANCE:PATH=${cmakePath(installation)}`, `-DCMAKE_SYSTEM_VERSION=${buildPin.sdk}`, `-DCMAKE_MSVC_RUNTIME_LIBRARY=${buildPin.runtimeLibrary}`,
      `-DEMBER_UV_SOURCE:PATH=${cmakePath(sources.workingDir)}`, `-DEMBER_PROBE_C:FILEPATH=${cmakePath(path.join(root, "test/fixtures/windows-uv-spawn-probe.c"))}`,
      `-DEMBER_OBSERVER_C:FILEPATH=${cmakePath(path.join(root, "test/fixtures/windows-uv-spawn-observe.c"))}`,
      `-DEMBER_OBSERVER_HEADER:FILEPATH=${cmakePath(path.join(root, "test/fixtures/windows-uv-spawn-observe.h"))}`], env, destination, buildPin.configureTimeoutMs);
    diagnostic.checkpoint(checkpoints.compilerSelection);
    const compilerMetadata = inputBytes(path.join(buildDirectory, "CMakeFiles", buildPin.cmakeVersion, "CMakeCCompiler.cmake"), 64 * 1024).toString("utf8");
    const compilerPaths = [...compilerMetadata.matchAll(/^set\(CMAKE_C_COMPILER "([^"\r\n]+)"\)\r?$/gm)];
    const compilerVersions = [...compilerMetadata.matchAll(/^set\(CMAKE_C_COMPILER_VERSION "([0-9.]+)"\)\r?$/gm)];
    if (compilerPaths.length !== 1 || compilerVersions.length !== 1 || compilerPaths[0][1].replaceAll("/", "\\").toLowerCase() !== toolPaths.compiler.toLowerCase() ||
        !compilerVersions[0][1].startsWith(buildPin.compilerVersionPrefix)) fail();
    diagnostic.checkpoint(checkpoints.generatedProject);
    const generatedProjects = [windowsUvSpawnProjectWitness(inputBytes(path.join(buildDirectory, "uv", "uv_a.vcxproj"), buildPin.maximumProjectBytes), "uv_a"),
      windowsUvSpawnProjectWitness(inputBytes(path.join(buildDirectory, "ember_uv_spawn_probe.vcxproj"), buildPin.maximumProjectBytes), "ember_uv_spawn_probe")];
    diagnostic.checkpoint(checkpoints.msbuild);
    captured(toolPaths.cmake, ["--build", buildDirectory, "--config", buildPin.configuration, "--target", "ember_uv_spawn_probe", "--parallel", "2", "--",
      `/p:VCToolsVersion=${buildPin.toolsetDirectory}`, `/p:WindowsTargetPlatformVersion=${buildPin.sdk}`, "/p:ImportDirectoryBuildProps=false", "/p:ImportDirectoryBuildTargets=false", "/nodeReuse:false"], env, destination, buildPin.compileTimeoutMs);
    diagnostic.checkpoint(checkpoints.sourceAfter);
    await validateWindowsUvSpawnSource(sources.stockDir, "stock"); await validateWindowsUvSpawnSource(sources.workingDir, "working");
    diagnostic.checkpoint(checkpoints.postValidation);
    if (!equal(recipe, windowsUvSpawnRecipe()) || !equal(tools, Object.fromEntries(Object.entries(toolPaths).map(([name, file]) => [name, snapshot(file)])))) fail();
    const afterProjects = [windowsUvSpawnProjectWitness(inputBytes(path.join(buildDirectory, "uv", "uv_a.vcxproj"), buildPin.maximumProjectBytes), "uv_a"),
      windowsUvSpawnProjectWitness(inputBytes(path.join(buildDirectory, "ember_uv_spawn_probe.vcxproj"), buildPin.maximumProjectBytes), "ember_uv_spawn_probe")];
    if (!equal(generatedProjects, afterProjects)) fail();
    diagnostic.checkpoint(checkpoints.listing);
    const listing = inputBytes(path.join(buildDirectory, "observer.asm"), buildPin.maximumListingBytes);
    const observerListing = { bytes: listing.length, sha256: hash(listing), review: "not-reviewed" };
    diagnostic.checkpoint(checkpoints.emission);
    const emissionBytes = Buffer.from(JSON.stringify(inspectWindowsUvSpawnEmission(listing)) + "\n");
    const emission = parseWindowsUvSpawnEmission(emissionBytes), emissionFile = path.join(destination, "observer-emission.json");
    fs.writeFileSync(emissionFile, emissionBytes, { flag: "wx" });
    const emissionReadback = inputBytes(emissionFile, emissionLimits.artifactBytes); if (!emissionBytes.equals(emissionReadback)) fail();
    parseWindowsUvSpawnEmission(emissionReadback);
    const observerEmission = { name: "observer-emission.json", bytes: emissionReadback.length, sha256: hash(emissionReadback), schema: 1, review: "not-reviewed", status: emission.status };
    diagnostic.checkpoint(checkpoints.object);
    const object = inputBytes(path.join(buildDirectory, "ember_uv_spawn_probe.dir", buildPin.configuration, "windows-uv-spawn-observe.obj"), buildPin.maximumObjectBytes);
    const observerObject = { bytes: object.length, sha256: hash(object) };
    diagnostic.checkpoint(checkpoints.pe);
    const bytes = inputBytes(path.join(buildDirectory, buildPin.configuration, "ember_uv_spawn_probe.exe"), buildPin.maximumExecutableBytes, true);
    diagnostic.checkpoint(checkpoints.readback);
    const staged = path.join(destination, "uv-spawn-probe.exe"); fs.writeFileSync(staged, bytes, { flag: "wx" });
    const readback = inputBytes(staged, buildPin.maximumExecutableBytes, true); if (!bytes.equals(readback)) fail();
    const assets = { probe: { name: "uv-spawn-probe.exe", ...windowsUvSpawnImageFingerprint(readback, buildPin.maximumExecutableBytes) } };
    fs.writeFileSync(path.join(destination, "LICENSE"), inputBytes(path.join(sources.stockDir, "LICENSE"), 64 * 1024), { flag: "wx" });
    diagnostic.checkpoint(checkpoints.receipt);
    const receipt = { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256, sourceCommit: sourcePin.provenance.commit,
      source: sourceSummary(), build: { ...buildPin, ...observed, generatedProjects, observerListing, observerObject, observerEmission }, tools, recipe, commit, assets };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"); parseWindowsUvSpawnBuildReceipt(receiptBytes, commit);
    fs.writeFileSync(path.join(destination, "build-receipt.json"), receiptBytes, { flag: "wx" }); return receipt;
  } catch (error) { throw diagnostic.failure(error); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--archive" || args[2] !== "--destination" || args[4] !== "--python") fail();
    const value = await buildWindowsUvSpawnProbe({ archivePath: args[1], destination: args[3], pythonPath: args[5] });
    process.stdout.write(JSON.stringify({ issuer: value.issuer, sourceVersion: value.sourceVersion, bytes: value.assets.probe.bytes }) + "\n");
  } catch (error) { process.stderr.write(JSON.stringify(classifyUvSpawnBuildFailure(error)) + "\n"); process.exitCode = 1; }
}
