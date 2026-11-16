/** Build a fixed ordinary-host ABI control around the unchanged producer's exact observer object. Usage: --archive <pinned archive> --destination <fresh directory> --python <hosted interpreter>. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildWindowsUvSpawnProbe, parseWindowsUvSpawnBuildReceipt, windowsUvSpawnRecipe, buildPin } from "./build-windows-uv-spawn-probe.mjs";
import { validateWindowsUvSpawnSource } from "./windows-uv-spawn-source.mjs";
import { windowsUvSpawnBuildEnvironment } from "./build-windows-uv-spawn-probe.mjs";
import { abiPin } from "./windows-uv-observer-abi-pin.mjs";
import { inspectWindowsUvObserverAbiImage, inspectWindowsUvObserverAbiObject } from "./windows-uv-observer-abi-image.mjs";
import { abiHash, ordinaryAbiWindowsPath as ordinary, readWindowsUvObserverAbiFile as read, windowsUvObserverAbiFileFingerprint as snapshot } from "./windows-uv-observer-abi-files.mjs";
export { abiPin };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ownFiles = ["scripts/experimental/build-windows-uv-observer-abi.mjs", "scripts/experimental/windows-uv-observer-abi-pin.json",
  "scripts/experimental/windows-uv-observer-abi-pin.mjs", "scripts/experimental/windows-uv-observer-abi-files.mjs",
  "scripts/experimental/windows-uv-observer-abi-image.mjs", "test/fixtures/windows-uv-observer-abi-control.c",
  "test/fixtures/windows-uv-observer-abi-build/CMakeLists.txt"];
const strict = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const equal = (actual, expected) => Array.isArray(expected) ? Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equal(actual[index], item)) :
  expected && typeof expected === "object" ? strict(actual, Object.keys(expected)) && Object.keys(expected).every(key => equal(actual[key], expected[key])) : actual === expected;
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const fail = () => { throw new Error("The fixed observer ABI build contract was refused."); };
const fingerprint = (value, maximum) => strict(value, ["bytes", "sha256"]) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= maximum && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
const brands = new WeakMap();
function failure(stage) { const error = new Error("The fixed observer ABI build failed."); brands.set(error, stage); return error; }
export function classifyWindowsUvObserverAbiBuildFailure(error) {
  const stage = error !== null && (typeof error === "object" || typeof error === "function") ? brands.get(error) : undefined;
  return Object.freeze({ schema: 1, status: "failed", stage: stage ?? 0 });
}
export function windowsUvObserverAbiRecipe() { return ownFiles.map(file => ({ file, sha256: abiHash(fs.readFileSync(path.join(root, file))) })); }
export function windowsUvObserverAbiBaseRecipeSha256() { return abiHash(Buffer.from(windowsUvSpawnRecipe().map(item => `${item.sha256} ${item.file}\n`).join(""))); }
const imageFingerprint = value => strict(value, ["name", "bytes", "sha256", "importModules", "namedImports", "forbiddenImports", "ordinalImports", "delayImports"]) &&
  value.name === "observer-abi-control.exe" && fingerprint({ bytes: value.bytes, sha256: value.sha256 }, abiPin.maximumExecutableBytes) && value.bytes >= 512 &&
  Number.isInteger(value.importModules) && value.importModules >= 1 && value.importModules <= abiPin.maximumImportModules &&
  Number.isInteger(value.namedImports) && value.namedImports >= 1 && value.namedImports <= abiPin.maximumImports &&
  value.forbiddenImports === 0 && value.ordinalImports === 0 && value.delayImports === 0;

/** The original producer receipt and this recipe are checked separately; the object identity must agree in both. */
export function parseWindowsUvObserverAbiBuildReceipt(bytes, sourceReceiptBytes, expectedCommit) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > abiPin.maximumReceiptBytes || !Buffer.isBuffer(sourceReceiptBytes) ||
        sourceReceiptBytes.length < 1 || sourceReceiptBytes.length > buildPin.maximumReceiptBytes || typeof expectedCommit !== "string" || !/^[a-f0-9]{40}$/.test(expectedCommit)) fail();
    const text = bytes.toString("utf8"); if (!Buffer.from(text).equals(bytes)) fail(); const value = JSON.parse(text);
    const source = parseWindowsUvSpawnBuildReceipt(sourceReceiptBytes, expectedCommit);
    if (windowsUvObserverAbiBaseRecipeSha256() !== abiPin.baseRecipeSha256 ||
        !strict(value, ["schema", "issuer", "commit", "baseRecipeSha256", "sourceReceipt", "observerObject", "recipe", "tools", "project", "assets"]) ||
        value.schema !== 1 || value.issuer !== abiPin.issuer || value.commit !== expectedCommit || value.baseRecipeSha256 !== abiPin.baseRecipeSha256 ||
        !equal(value.recipe, windowsUvObserverAbiRecipe()) || !equal(value.tools, source.tools) || !equal(value.observerObject, source.build.observerObject) ||
        !fingerprint(value.observerObject, abiPin.maximumObjectBytes) || !strict(value.sourceReceipt, ["name", "bytes", "sha256"]) ||
        value.sourceReceipt.name !== "source-build-receipt.json" || value.sourceReceipt.bytes !== sourceReceiptBytes.length || value.sourceReceipt.sha256 !== abiHash(sourceReceiptBytes) ||
        !strict(value.project, ["bytes", "sha256", "targetMacro", "runtimeLibrary", "externalObjects"]) || value.project.targetMacro !== "0x0602" ||
        value.project.runtimeLibrary !== "MultiThreaded" || value.project.externalObjects !== 1 || !fingerprint({ bytes: value.project.bytes, sha256: value.project.sha256 }, abiPin.maximumProjectBytes) ||
        !strict(value.assets, ["control", "license"]) || !imageFingerprint(value.assets.control) || !strict(value.assets.license, ["name", "bytes", "sha256"]) ||
        value.assets.license.name !== "LICENSE" || !fingerprint({ bytes: value.assets.license.bytes, sha256: value.assets.license.sha256 }, 64 * 1024)) fail();
    return freeze(value);
  } catch { fail(); }
}

/** Fixed CMake metadata only, never a general XML reader. No project path or XML is returned. */
export function windowsUvObserverAbiProjectWitness(bytes, controlPath, objectPath) {
  try {
    ordinary(controlPath); ordinary(objectPath);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > abiPin.maximumProjectBytes) fail();
    const text = bytes.toString("utf8"); if (!Buffer.from(text).equals(bytes) || /<!DOCTYPE|<!ENTITY|&#/.test(text)) fail();
    const groups = [...text.matchAll(/<ItemDefinitionGroup\b[^>]*Condition="([^"]*)"[^>]*>([\s\S]*?)<\/ItemDefinitionGroup>/g)]
      .filter(item => item[1].replaceAll(" ", "") === "'$(Configuration)|$(Platform)'=='Release|x64'");
    if (groups.length !== 1) fail();
    const children = body => {
      const result = [], stack = []; let cursor = 0;
      for (;;) {
        const start = body.indexOf("<", cursor); if (start < 0) break;
        if (!stack.length && body.slice(cursor, start).trim()) fail();
        const end = body.indexOf(">", start + 1); if (end < 0) fail();
        const token = body.slice(start, end + 1), closing = /^<\/([A-Za-z][A-Za-z0-9_.:-]*)\s*>$/.exec(token);
        if (closing) {
          const item = stack.pop(); if (!item || item.name !== closing[1]) fail();
          if (!stack.length) result.push({ ...item, body: body.slice(item.content, start), raw: body.slice(item.start, end + 1) });
        } else {
          const match = /^<([A-Za-z][A-Za-z0-9_.:-]*)([^<>]*?)(\/?)>$/.exec(token); if (!match || stack.length >= 8) fail();
          const item = { name: match[1], attributes: match[2], start, content: end + 1 };
          if (match[3]) { if (!stack.length) result.push({ ...item, body: "", raw: token }); } else stack.push(item);
        }
        if (result.length > 4096) fail(); cursor = end + 1;
      }
      if (stack.length || body.slice(cursor).trim()) fail(); return result;
    };
    const direct = children(groups[0][2]), admitted = [];
    for (const name of ["ClCompile", "ResourceCompile"]) {
      const block = direct.filter(item => item.name === name);
      if (block.length !== 1 || block[0].attributes.trim()) fail();
      const fields = children(block[0].body), definitions = fields.filter(item => item.name === "PreprocessorDefinitions");
      if (definitions.length !== 1 || definitions[0].attributes.trim() || definitions[0].body.includes("<")) fail();
      const values = definitions[0].body.split(";");
      if (!equal(values.filter(item => item.includes("_WIN32_WINNT")), ["_WIN32_WINNT=0x0602"]) ||
          !equal(values.filter(item => item.includes("EMBER_UV_FIXED_PROBE_OFFLINE")), [buildPin.offlineMacro])) fail();
      admitted.push(definitions[0].raw);
      if (name === "ClCompile") {
        const runtime = fields.filter(item => item.name === "RuntimeLibrary");
        if (runtime.length !== 1 || runtime[0].attributes.trim() || runtime[0].body !== "MultiThreaded" ||
            [...block[0].body.matchAll(/<RuntimeLibrary\b/g)].length !== 1) fail();
      }
    }
    if (/_WIN32_WINNT|EMBER_UV_FIXED_PROBE_OFFLINE|EMBER_UV_SPAWN_OBSERVE_/.test(groups[0][2].replace(admitted[0], "").replace(admitted[1], ""))) fail();
    const toolsets = [...text.matchAll(/<PlatformToolset>([^<]*)<\/PlatformToolset>/g)], sdk = [...text.matchAll(/<WindowsTargetPlatformVersion>([^<]*)<\/WindowsTargetPlatformVersion>/g)];
    if (!toolsets.length || toolsets.some(item => item[1] !== "v143") || sdk.length !== 1 || sdk[0][1] !== buildPin.sdk) fail();
    const sources = [...text.matchAll(/<ClCompile\s+Include="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/ClCompile>)/g)], objects = [...text.matchAll(/<Object\s+Include="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/Object>)/g)];
    const normal = value => value.replaceAll("\\", "/").toLowerCase();
    if (sources.length !== 1 || objects.length !== 1 || normal(sources[0][1]) !== normal(controlPath) || normal(objects[0][1]) !== normal(objectPath) ||
        /_WIN32_WINNT|EMBER_UV_FIXED_PROBE_OFFLINE|EMBER_UV_SPAWN_OBSERVE_|ForcedInclude|AdditionalOptions|PreprocessorDefinitions/.test(sources[0][2] ?? "") || (objects[0][2] ?? "").trim()) fail();
    return { bytes: bytes.length, sha256: abiHash(bytes), targetMacro: "0x0602", runtimeLibrary: "MultiThreaded", externalObjects: 1 };
  } catch { fail(); }
}

const captured = (program, args, env, cwd, timeout = 30_000) => {
  try { return execFileSync(program, args, { env, cwd, encoding: "utf8", timeout, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { fail(); }
};

export async function buildWindowsUvObserverAbi({ archivePath, destination, pythonPath }) {
  let stage = 1;
  try {
    if (process.platform !== "win32" || process.arch !== "x64") fail();
    [archivePath, destination, pythonPath].forEach(ordinary);
    const commit = process.env.GITHUB_SHA; if (!/^[a-f0-9]{40}$/.test(commit ?? "") || fs.existsSync(destination)) fail();
    stage = 2; if (windowsUvObserverAbiBaseRecipeSha256() !== abiPin.baseRecipeSha256) fail();
    const recipe = windowsUvObserverAbiRecipe(); fs.mkdirSync(destination, { mode: 0o700 });
    const dirs = { temporary: path.join(destination, "temporary"), profile: path.join(destination, "profile"), local: path.join(destination, "profile", "Local"), roaming: path.join(destination, "profile", "Roaming") };
    Object.values(dirs).forEach(folder => fs.mkdirSync(folder, { mode: 0o700 }));
    const env = windowsUvSpawnBuildEnvironment(process.env, dirs, path.dirname(pythonPath)), sourceRoot = path.join(destination, "source-build");
    stage = 3; await buildWindowsUvSpawnProbe({ archivePath, destination: sourceRoot, pythonPath });
    stage = 4;
    const sourceBytes = read(path.join(sourceRoot, "build-receipt.json"), buildPin.maximumReceiptBytes), source = parseWindowsUvSpawnBuildReceipt(sourceBytes, commit);
    stage = 5;
    const vswhere = ordinary(path.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe"));
    if (!equal(snapshot(vswhere, abiPin.maximumToolBytes), source.tools.vswhere)) fail();
    const installation = ordinary(captured(vswhere, ["-latest", "-version", buildPin.visualStudioRange, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], env, destination));
    const toolDirectory = path.join(installation, "VC", "Tools", "MSVC", buildPin.toolsetDirectory, "bin", "Hostx64", "x64");
    const tools = { compiler: path.join(toolDirectory, "cl.exe"), linker: path.join(toolDirectory, "link.exe"), msbuild: path.join(installation, "MSBuild", "Current", "Bin", "amd64", "MSBuild.exe"),
      vcvars: path.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat"), vswhere, python: pythonPath,
      cmake: path.join(env.ProgramFiles ?? "C:\\Program Files", "CMake", "bin", "cmake.exe") };
    const toolFingerprints = () => Object.fromEntries(Object.entries(tools).map(([name, file]) => [name, snapshot(file, abiPin.maximumToolBytes)]));
    if (!equal(source.tools, toolFingerprints())) fail();
    stage = 6;
    const object = path.join(sourceRoot, "build", "ember_uv_spawn_probe.dir", buildPin.configuration, "windows-uv-spawn-observe.obj");
    if (!equal(inspectWindowsUvObserverAbiObject(read(object, abiPin.maximumObjectBytes)), source.build.observerObject)) fail();
    const control = path.join(root, "test", "fixtures", "windows-uv-observer-abi-control.c"), build = path.join(destination, "control-build");
    const cmakePath = value => ordinary(value).replaceAll("\\", "/");
    stage = 7;
    captured(tools.cmake, ["-S", cmakePath(path.join(root, "test", "fixtures", "windows-uv-observer-abi-build")), "-B", cmakePath(build), "-G", buildPin.generator, "-A", buildPin.platform, "-T", buildPin.toolset,
      `-DCMAKE_GENERATOR_INSTANCE:PATH=${cmakePath(installation)}`, `-DCMAKE_SYSTEM_VERSION=${buildPin.sdk}`, `-DCMAKE_MSVC_RUNTIME_LIBRARY=${buildPin.runtimeLibrary}`,
      `-DEMBER_ABI_CONTROL_C:FILEPATH=${cmakePath(control)}`, `-DEMBER_OBSERVER_OBJECT:FILEPATH=${cmakePath(object)}`,
      `-DEMBER_UV_INCLUDE:PATH=${cmakePath(path.join(sourceRoot, "source", "working", "include"))}`], env, destination, buildPin.configureTimeoutMs);
    stage = 8;
    const compilerMetadata = read(path.join(build, "CMakeFiles", buildPin.cmakeVersion, "CMakeCCompiler.cmake"), 64 * 1024).toString("utf8");
    const paths = [...compilerMetadata.matchAll(/^set\(CMAKE_C_COMPILER "([^"\r\n]+)"\)\r?$/gm)], versions = [...compilerMetadata.matchAll(/^set\(CMAKE_C_COMPILER_VERSION "([0-9.]+)"\)\r?$/gm)];
    if (paths.length !== 1 || normalPath(paths[0][1]) !== normalPath(tools.compiler) || versions.length !== 1 || !versions[0][1].startsWith(buildPin.compilerVersionPrefix)) fail();
    stage = 9;
    const projectPath = path.join(build, "ember_uv_observer_abi_control.vcxproj"), project = windowsUvObserverAbiProjectWitness(read(projectPath, abiPin.maximumProjectBytes), control, object);
    stage = 10;
    captured(tools.cmake, ["--build", build, "--config", buildPin.configuration, "--target", "ember_uv_observer_abi_control", "--parallel", "2", "--",
      `/p:VCToolsVersion=${buildPin.toolsetDirectory}`, `/p:WindowsTargetPlatformVersion=${buildPin.sdk}`, "/p:ImportDirectoryBuildProps=false", "/p:ImportDirectoryBuildTargets=false", "/nodeReuse:false"], env, destination, buildPin.compileTimeoutMs);
    stage = 11;
    if (!equal(inspectWindowsUvObserverAbiObject(read(object, abiPin.maximumObjectBytes)), source.build.observerObject) || !equal(source.tools, toolFingerprints()) || !equal(recipe, windowsUvObserverAbiRecipe()) ||
        windowsUvObserverAbiBaseRecipeSha256() !== abiPin.baseRecipeSha256 || !equal(project, windowsUvObserverAbiProjectWitness(read(projectPath, abiPin.maximumProjectBytes), control, object))) fail();
    await validateWindowsUvSpawnSource(path.join(sourceRoot, "source", "stock"), "stock"); await validateWindowsUvSpawnSource(path.join(sourceRoot, "source", "working"), "working");
    stage = 12;
    const imageBytes = read(path.join(build, buildPin.configuration, "ember_uv_observer_abi_control.exe"), abiPin.maximumExecutableBytes), image = inspectWindowsUvObserverAbiImage(imageBytes);
    stage = 13;
    fs.writeFileSync(path.join(destination, "observer-abi-control.exe"), imageBytes, { flag: "wx" });
    if (!equal(image, inspectWindowsUvObserverAbiImage(read(path.join(destination, "observer-abi-control.exe"), abiPin.maximumExecutableBytes)))) fail();
    fs.writeFileSync(path.join(destination, "source-build-receipt.json"), sourceBytes, { flag: "wx" });
    const license = read(path.join(sourceRoot, "LICENSE"), 64 * 1024); fs.writeFileSync(path.join(destination, "LICENSE"), license, { flag: "wx" });
    stage = 14;
    const receipt = { schema: 1, issuer: abiPin.issuer, commit, baseRecipeSha256: abiPin.baseRecipeSha256,
      sourceReceipt: { name: "source-build-receipt.json", bytes: sourceBytes.length, sha256: abiHash(sourceBytes) }, observerObject: source.build.observerObject,
      recipe, tools: source.tools, project, assets: { control: { name: "observer-abi-control.exe", ...image }, license: { name: "LICENSE", bytes: license.length, sha256: abiHash(license) } } };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"); parseWindowsUvObserverAbiBuildReceipt(receiptBytes, sourceBytes, commit);
    fs.writeFileSync(path.join(destination, "abi-build-receipt.json"), receiptBytes, { flag: "wx" }); return receipt;
  } catch { throw failure(stage); }
}
const normalPath = value => value.replaceAll("/", "\\").toLowerCase();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (args.length !== 6 || args[0] !== "--archive" || args[2] !== "--destination" || args[4] !== "--python") throw failure(0);
    const receipt = await buildWindowsUvObserverAbi({ archivePath: args[1], destination: args[3], pythonPath: args[5] });
    process.stdout.write(JSON.stringify({ schema: 1, issuer: abiPin.issuer, status: "built", bytes: receipt.assets.control.bytes }) + "\n");
  } catch (error) { process.stderr.write(JSON.stringify(classifyWindowsUvObserverAbiBuildFailure(error)) + "\n"); process.exitCode = 1; }
}
