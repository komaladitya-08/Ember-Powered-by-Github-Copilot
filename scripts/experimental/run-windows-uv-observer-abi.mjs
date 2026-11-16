/** Run only the fixed, recipe-verified ordinary-host ABI control. Usage: no arguments; trusted workflow supplies build root and GITHUB_SHA. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildPin, windowsUvSpawnBuildEnvironment } from "./build-windows-uv-spawn-probe.mjs";
import { parseWindowsUvObserverAbiBuildReceipt } from "./build-windows-uv-observer-abi.mjs";
import { abiPin } from "./windows-uv-observer-abi-pin.mjs";
import { parseWindowsUvObserverAbiReport } from "./windows-uv-observer-abi-report.mjs";
import { inspectWindowsUvObserverAbiImage, inspectWindowsUvObserverAbiObject } from "./windows-uv-observer-abi-image.mjs";
import { classifyOwnedPowerShellResult as classifyOwnedProcess } from "./windows-uv-spawn-powershell.mjs";
import { abiHash, ordinaryAbiWindowsPath as ordinary, readWindowsUvObserverAbiFile as read, windowsUvObserverAbiFileFingerprint as snapshot } from "./windows-uv-observer-abi-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeFiles = ["scripts/experimental/run-windows-uv-observer-abi.mjs", "scripts/experimental/windows-uv-observer-abi-report.mjs"];
const fail = () => { throw new Error("The fixed ordinary-host observer ABI control was refused."); };
const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const brands = new WeakMap();
function own(value, key, optional = false) {
  if (value === null || typeof value !== "object" && typeof value !== "function") fail();
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field) { if (optional) return undefined; fail(); }
  if (!Object.hasOwn(field, "value")) fail(); return field.value;
}
/** Reuses only the original own-data process classifier, with a fixed dummy success string; binary streams stay private. */
export function classifyWindowsUvObserverAbiProcess(result) {
  try { return classifyOwnedProcess({ status: own(result, "status"), signal: own(result, "signal"), error: own(result, "error", true), stdout: "" }); }
  catch { return classifyOwnedProcess(undefined); }
}
export function windowsUvObserverAbiRuntimeRecipe() { return runtimeFiles.map(file => ({ file, sha256: abiHash(fs.readFileSync(path.join(root, file))) })); }
export function classifyWindowsUvObserverAbiRunFailure(error) {
  const value = error !== null && (typeof error === "object" || typeof error === "function") ? brands.get(error) : undefined;
  return Object.freeze({ schema: 1, status: "failed", stage: value?.stage ?? 0, ...(value?.process ? { process: value.process } : {}) });
}

/** All inputs come from the reviewed CI build, never arbitrary project code or executable arguments. Unknown timeout ownership is not a whole-process-tree cleanup proof. */
export function runWindowsUvObserverAbi({ buildRoot, expectedCommit }) {
  let stage = 1, processDiagnostic, result, stdout, stderr;
  try {
    if (process.platform !== "win32" || process.arch !== "x64" || process.env.EMBER_UV_OBSERVER_ABI_CONTROL !== "1") fail();
    ordinary(buildRoot); if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? "") || expectedCommit !== process.env.GITHUB_SHA) fail();
    stage = 2;
    const receiptPath = path.join(buildRoot, "abi-build-receipt.json"), sourcePath = path.join(buildRoot, "source-build-receipt.json");
    const receiptBytes = read(receiptPath, abiPin.maximumReceiptBytes), sourceBytes = read(sourcePath, buildPin.maximumReceiptBytes);
    const receipt = parseWindowsUvObserverAbiBuildReceipt(receiptBytes, sourceBytes, expectedCommit), runtimeRecipe = windowsUvObserverAbiRuntimeRecipe();
    const imagePath = path.join(buildRoot, receipt.assets.control.name), objectPath = path.join(buildRoot, "source-build", "build", "ember_uv_spawn_probe.dir", "Release", "windows-uv-spawn-observe.obj");
    stage = 3;
    const image = inspectWindowsUvObserverAbiImage(read(imagePath, abiPin.maximumExecutableBytes));
    if (!equal({ name: receipt.assets.control.name, ...image }, receipt.assets.control) || !equal(inspectWindowsUvObserverAbiObject(read(objectPath, abiPin.maximumObjectBytes)), receipt.observerObject)) fail();
    const license = snapshot(path.join(buildRoot, "LICENSE"), 64 * 1024);
    if (!equal({ name: "LICENSE", ...license }, receipt.assets.license)) fail();
    stage = 4;
    const runtime = path.join(buildRoot, "ordinary-control-runtime"); if (fs.existsSync(runtime)) fail(); fs.mkdirSync(runtime, { mode: 0o700 });
    const directories = { temporary: path.join(runtime, "temporary"), profile: path.join(runtime, "profile"), local: path.join(runtime, "profile", "Local"), roaming: path.join(runtime, "profile", "Roaming") };
    Object.values(directories).forEach(file => fs.mkdirSync(file, { mode: 0o700 }));
    const env = windowsUvSpawnBuildEnvironment(process.env, directories, path.dirname(buildPin.pythonExecutable));
    stage = 5;
    try { result = spawnSync(imagePath, [], { env, cwd: runtime, encoding: "buffer", timeout: abiPin.runtimeTimeoutMs, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { processDiagnostic = classifyOwnedProcess(undefined); fail(); }
    processDiagnostic = classifyWindowsUvObserverAbiProcess(result);
    if (processDiagnostic.outcome !== 1 || processDiagnostic.status !== 0 || processDiagnostic.signal !== 0 || processDiagnostic.errorPresence !== 0) fail();
    stage = 6;
    stdout = own(result, "stdout"); stderr = own(result, "stderr");
    if (!Buffer.isBuffer(stdout) || stdout.length !== abiPin.reportBytes || !Buffer.isBuffer(stderr) || stderr.length !== 0) fail();
    const report = parseWindowsUvObserverAbiReport(stdout), reportSha256 = abiHash(stdout);
    stage = 7;
    if (!equal(image, inspectWindowsUvObserverAbiImage(read(imagePath, abiPin.maximumExecutableBytes))) ||
        !equal(inspectWindowsUvObserverAbiObject(read(objectPath, abiPin.maximumObjectBytes)), receipt.observerObject) ||
        !read(receiptPath, abiPin.maximumReceiptBytes).equals(receiptBytes) || !read(sourcePath, buildPin.maximumReceiptBytes).equals(sourceBytes) ||
        !equal(runtimeRecipe, windowsUvObserverAbiRuntimeRecipe())) fail();
    stage = 8;
    const value = { schema: 1, issuer: abiPin.issuer, compileCommit: receipt.commit, runCommit: expectedCommit, scope: "ordinary-host-only",
      observerObject: receipt.observerObject, controlImage: { bytes: image.bytes, sha256: image.sha256 }, runtimeRecipe, reportSha256, report };
    fs.writeFileSync(path.join(buildRoot, "abi-result.json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    return freeze(value);
  } catch {
    const error = new Error("The fixed ordinary-host observer ABI control failed.");
    brands.set(error, Object.freeze({ stage, ...(processDiagnostic ? { process: processDiagnostic } : {}) })); throw error;
  } finally {
    if (Buffer.isBuffer(stdout)) stdout.fill(0); if (Buffer.isBuffer(stderr)) stderr.fill(0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail();
    const value = runWindowsUvObserverAbi({ buildRoot: process.env.EMBER_UV_OBSERVER_ABI_ROOT, expectedCommit: process.env.GITHUB_SHA });
    process.stdout.write(JSON.stringify({ schema: 1, issuer: abiPin.issuer, status: "passed", cases: value.report.cases, observerObject: value.observerObject }) + "\n");
  } catch (error) { process.stderr.write(JSON.stringify(classifyWindowsUvObserverAbiRunFailure(error)) + "\n"); process.exitCode = 1; }
}
