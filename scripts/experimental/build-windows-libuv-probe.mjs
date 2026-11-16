/** Fixed trusted-host C/library build. This never builds Node or accepts project code. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareWindowsLibuvSource, validateSourceTree, sourcePin } from "./windows-libuv-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const buildPin = Object.freeze(JSON.parse(fs.readFileSync(path.join(root, "scripts/experimental/windows-libuv-build-pin.json"), "utf8")));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fixedFiles = ["scripts/experimental/build-windows-libuv-probe.mjs", "scripts/experimental/windows-libuv-build-pin.json",
  "scripts/experimental/windows-libuv-source.mjs", "scripts/experimental/extract-node-libuv-source.py", "scripts/experimental/windows-libuv-source-pin.json",
  "test/fixtures/windows-libuv-probe-build/CMakeLists.txt", "test/fixtures/windows-libuv-offline-probe.c"];

export function windowsLibuvRecipe() {
  return fixedFiles.map(file => ({ file, sha256: digest(fs.readFileSync(path.join(root, file))) }));
}
const snapshot = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 64 * 1024 * 1024)
    throw new Error("The fixed build requires ordinary bounded tool/source files.");
  const bytes = fs.readFileSync(file);
  if (bytes.length !== stat.size) throw new Error("A fixed build input changed.");
  return { bytes: bytes.length, sha256: digest(bytes) };
};
const ordinary = value => {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || /[%!^&|<>";\r\n\0]/.test(value) || path.win32.normalize(value) !== value)
    throw new Error("The fixed build requires ordinary local host toolchain paths.");
  return value;
};
/** Typed CMake definitions use forward slashes; native backslashes can be re-parsed as CMake escapes. */
export const windowsLibuvCmakePath = value => ordinary(value).replaceAll("\\", "/");
const same = (before, after) => JSON.stringify(before) === JSON.stringify(after);
/** No ambient compiler flags, toolchain selectors, Python hooks, user props, credentials or SDK variables. */
export function windowsLibuvBuildEnvironment(base, directories) {
  const names = ["SystemRoot", "WINDIR", "ComSpec", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "PATHEXT"];
  const env = {};
  for (const name of names) {
    const matches = Object.entries(base).filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === "string");
    if (matches.length > 1 && matches.some(([, value]) => value !== matches[0][1])) throw new Error("Conflicting build environment metadata.");
    if (matches.length) env[name] = matches[0][1];
  }
  const windows = ordinary(env.SystemRoot), programFiles = ordinary(env.ProgramFiles ?? "C:\\Program Files");
  for (const directory of Object.values(directories)) ordinary(directory);
  return { ...env, WINDIR: windows, ComSpec: path.win32.join(windows, "System32", "cmd.exe"), SystemDrive: path.win32.parse(windows).root.slice(0, 2),
    PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: [path.win32.join(windows, "System32"), windows, path.win32.join(programFiles, "CMake", "bin")].join(";"),
    TEMP: directories.temporary, TMP: directories.temporary, USERPROFILE: directories.profile,
    LOCALAPPDATA: directories.local, APPDATA: directories.roaming, PROCESSOR_ARCHITECTURE: "AMD64", NUMBER_OF_PROCESSORS: "2" };
}
let buildStage = "inputs";
let selectedBuildEnvironment;
const run = (program, args, timeout) => {
  try { return execFileSync(program, args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024, env: selectedBuildEnvironment }); }
  catch { throw new Error("The fixed selected libuv compiler/build command failed; no alternative toolchain is admitted."); }
};

export async function buildWindowsLibuvProbe({ archivePath, destination, pythonPath }) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This fixed build requires a Windows x64 host.");
  ordinary(destination); ordinary(archivePath); ordinary(pythonPath);
  if (fs.existsSync(destination)) throw new Error("The fixed build destination must be fresh.");
  fs.mkdirSync(destination, { mode: 0o700 });
  const environmentDirectories = { temporary: path.join(destination, "temporary"), profile: path.join(destination, "build-profile"),
    local: path.join(destination, "build-profile", "Local"), roaming: path.join(destination, "build-profile", "Roaming") };
  for (const directory of Object.values(environmentDirectories)) fs.mkdirSync(directory, { mode: 0o700 });
  selectedBuildEnvironment = windowsLibuvBuildEnvironment(process.env, environmentDirectories);
  const recipe = windowsLibuvRecipe();
  buildStage = "verified-source";
  const sources = await prepareWindowsLibuvSource({ archivePath, destination: path.join(destination, "source"), pythonPath });
  const programFiles = ordinary(process.env.ProgramFiles ?? "C:\\Program Files");
  const vswhere = ordinary(path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"));
  buildStage = "selected-toolchain";
  const installation = ordinary(run(vswhere, ["-latest", "-version", "[17.0,18.0)", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], 15_000).trim());
  const cmake = ordinary(path.join(programFiles, "CMake", "bin", "cmake.exe"));
  const toolsDirectory = path.join(installation, "VC", "Tools", "MSVC", buildPin.toolsetDirectory, "bin", "Hostx64", "x64");
  const cl = ordinary(path.join(toolsDirectory, "cl.exe")), linker = ordinary(path.join(toolsDirectory, "link.exe"));
  const tools = { cmake: snapshot(cmake), compiler: snapshot(cl), linker: snapshot(linker) };
  if (run(cmake, ["--version"], 15_000).split(/\r?\n/, 1)[0] !== `cmake version ${buildPin.cmakeVersion}`)
    throw new Error("The fixed CMake version is unavailable.");
  const cmakeProject = path.join(root, "test/fixtures/windows-libuv-probe-build");
  const cProgram = ordinary(path.join(root, "test/fixtures/windows-libuv-offline-probe.c"));
  const assets = {};
  let compilerVersion;
  for (const variant of ["stock", "offline"]) {
    buildStage = `configure-${variant}`;
    const sourceDirectory = variant === "stock" ? sources.stockDir : sources.offlineDir;
    await validateSourceTree(sourceDirectory, variant);
    const buildDirectory = ordinary(path.join(destination, `build-${variant}`));
    run(cmake, ["-S", windowsLibuvCmakePath(cmakeProject), "-B", windowsLibuvCmakePath(buildDirectory), "-G", buildPin.generator, "-A", buildPin.platform, "-T", buildPin.toolset,
      `-DCMAKE_GENERATOR_INSTANCE:PATH=${windowsLibuvCmakePath(installation)}`, `-DCMAKE_SYSTEM_VERSION=${buildPin.sdk}`, `-DCMAKE_MSVC_RUNTIME_LIBRARY=${buildPin.runtimeLibrary}`,
      `-DEMBER_PROBE_MODE=${variant}`, `-DEMBER_UV_SOURCE:PATH=${windowsLibuvCmakePath(sourceDirectory)}`, `-DEMBER_PROBE_C:FILEPATH=${windowsLibuvCmakePath(cProgram)}`], 90_000);
    const metadataPath = path.join(buildDirectory, "CMakeFiles", buildPin.cmakeVersion, "CMakeCCompiler.cmake");
    const metadata = fs.readFileSync(metadataPath, "utf8");
    if (metadata.length > 64 * 1024) throw new Error("The selected compiler metadata is not bounded.");
    const versions = [...metadata.matchAll(/^set\(CMAKE_C_COMPILER_VERSION "([0-9.]+)"\)\r?$/gm)];
    const compilers = [...metadata.matchAll(/^set\(CMAKE_C_COMPILER "([^"\r\n]+)"\)\r?$/gm)];
    if (versions.length !== 1 || !versions[0][1].startsWith(buildPin.compilerVersionPrefix) || compilers.length !== 1 ||
      compilers[0][1].replaceAll("/", "\\").toLowerCase() !== cl.toLowerCase() || compilerVersion && compilerVersion !== versions[0][1])
      throw new Error("CMake did not select the pinned compiler instance.");
    compilerVersion = versions[0][1];
    buildStage = `compile-${variant}`;
    run(cmake, ["--build", buildDirectory, "--config", buildPin.configuration, "--target", "ember_uv_probe", "--parallel", "2", "--",
      "/p:ImportDirectoryBuildProps=false", "/p:ImportDirectoryBuildTargets=false"], 180_000);
    await validateSourceTree(sourceDirectory, variant);
    if (!same(recipe, windowsLibuvRecipe())) throw new Error("The fixed probe recipe changed during compilation.");
    const built = path.join(buildDirectory, buildPin.configuration, "ember_uv_probe.exe"), bytes = fs.readFileSync(built);
    if (bytes.length < 2 || bytes.length > buildPin.maximumExecutableBytes || bytes.toString("ascii", 0, 2) !== "MZ")
      throw new Error("The compiled fixed probe is not a bounded native image.");
    const name = `${variant}-probe.exe`;
    fs.writeFileSync(path.join(destination, name), bytes, { flag: "wx" });
    assets[variant] = { name, bytes: bytes.length, sha256: digest(bytes) };
  }
  buildStage = "final-receipt";
  if (!same(tools, { cmake: snapshot(cmake), compiler: snapshot(cl), linker: snapshot(linker) }))
    throw new Error("The selected build tools changed during compilation.");
  const commit = process.env.GITHUB_SHA;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("Record the exact checked-out experimental build commit.");
  const receipt = { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256,
    sourceCommit: sourcePin.provenance.commit, source: { stockManifestSha256: sources.receipt.stock.manifestSha256,
      offlineManifestSha256: sources.receipt.offline.manifestSha256, files: sourcePin.files.length, stockBytes: sources.receipt.stock.bytes,
      offlineBytes: sources.receipt.offline.bytes, patchBeforeSha256: sourcePin.patch.beforeSha256, patchAfterSha256: sourcePin.patch.afterSha256 },
    build: { ...buildPin, compilerVersion }, tools, recipe, commit, assets };
  fs.writeFileSync(path.join(destination, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--archive" || args[2] !== "--destination" || args[4] !== "--python") throw new Error("Provide the fixed archive, fresh destination and trusted Python paths.");
    const receipt = await buildWindowsLibuvProbe({ archivePath: args[1], destination: args[3], pythonPath: args[5] });
    process.stdout.write(JSON.stringify({ issuer: receipt.issuer, sourceVersion: receipt.sourceVersion, compilerVersion: receipt.build.compilerVersion,
      stockBytes: receipt.assets.stock.bytes, offlineBytes: receipt.assets.offline.bytes }) + "\n");
  } catch { process.stderr.write(JSON.stringify({ status: "failed", stage: buildStage }) + "\n"); process.exitCode = 1; }
}
