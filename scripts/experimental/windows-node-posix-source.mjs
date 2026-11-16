// Trusted-host source preparation only. This does not build or launch Node, or admit project source or replacement pins.
// usage: node windows-node-posix-source.mjs --archive ARCHIVE --destination FRESH --python ABSOLUTE_PYTHON
import fs from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile), extractor = fileURLToPath(new URL("./extract-node-posix-source.py", import.meta.url));
const fail = () => { throw new Error("The fixed Node source preparation could not be verified; retain its incomplete assets."); };
const freeze = value => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const sourcePin = freeze(JSON.parse(readFileSync(new URL("./windows-node-posix-source-pin.json", import.meta.url), "utf8")));
const identity = info => `${info.dev}:${info.ino}`;
const ordinary = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
async function ancestors(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.normalize(directory) !== directory) fail();
  const chain = []; let current = directory;
  for (;;) { chain.push(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  for (const item of chain.reverse()) { const info = await fs.lstat(item); if (!info.isDirectory() || info.isSymbolicLink()) fail(); }
}
async function verifyArchive(file, asset = sourcePin.sourceArchive) {
  await ancestors(path.dirname(file));
  const before = await fs.lstat(file); if (!ordinary(before) || before.size !== asset.bytes) fail();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat(); if (!ordinary(opened) || identity(opened) !== identity(before) || opened.size !== asset.bytes) fail();
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, asset.bytes + 1 - length), length);
      if (!bytesRead) break;
      length += bytesRead; if (length > asset.bytes) fail(); hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), named = await fs.lstat(file);
    if (length !== asset.bytes || !ordinary(after) || !ordinary(named) || identity(after) !== identity(opened) || identity(named) !== identity(opened) ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || hash.digest("hex") !== asset.sha256) fail();
  } finally { await handle.close(); }
}
async function invoke(pythonPath, args, { executionEnv, cwd } = {}) {
  const result = await run(pythonPath, ["-I", "-B", extractor, ...args], { encoding: "utf8", timeout: 300_000, maxBuffer: 4096, windowsHide: true, env: executionEnv, cwd });
  return JSON.parse(result.stdout);
}
function checked(result, variant, allowGenerated) {
  const fields = ["variant", "files", "directories", "bytes", "manifestSha256", "directoryManifestSha256", "allowGenerated", "directoriesExcludeArchiveRoot"];
  const expected = sourcePin.inventory;
  if (!result || typeof result !== "object" || Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field)) ||
      result.variant !== variant || result.allowGenerated !== allowGenerated || result.files !== expected.files || result.directories !== expected.directories ||
      result.bytes !== expected[variant === "stock" ? "stockBytes" : "offlineBytes"] || result.manifestSha256 !== expected[variant === "stock" ? "stockManifestSha256" : "offlineManifestSha256"] ||
      result.directoryManifestSha256 !== expected.directoryManifestSha256 || result.directoriesExcludeArchiveRoot !== true) fail();
  return result;
}

/** Validate the complete original-input catalog. Generated working outputs are never traversed or treated as inputs. */
export async function validateNodePosixSourceInputs(root, variant = "stock", { allowGenerated = false, pythonPath = "python", executionEnv, cwd } = {}) {
  try {
    if (!["stock", "offline"].includes(variant) || typeof allowGenerated !== "boolean") fail();
    await ancestors(root);
    return checked(await invoke(pythonPath, ["validate", root, variant, allowGenerated ? "generated" : "exact"], { executionEnv, cwd }), variant, allowGenerated);
  } catch { fail(); }
}

/**
 * The operator must supply a trusted Python interpreter; this standalone preparer cannot authenticate arbitrary
 * caller executables. The Windows builder attests its fixed hosted interpreter before calling either preparer.
 * Keep the baseline out of all builds; only the working copy receives the fixed reviewed source deltas.
 */
export async function prepareNodePosixSource({ archivePath, destination, pythonPath = "python", executionEnv, cwd }) {
  try {
    await verifyArchive(archivePath); await ancestors(path.dirname(destination)); await fs.mkdir(destination, { mode: 0o700 }); await ancestors(destination);
    const result = await invoke(pythonPath, ["extract", archivePath, destination], { executionEnv, cwd });
    if (!result || result.schema !== 1 || result.issuer !== sourcePin.issuer || result.version !== sourcePin.version || Object.keys(result).length !== 5) fail();
    const baseline = checked(result.baseline, "stock", false), working = checked(result.working, "offline", false);
    const receipt = { schema: 1, issuer: sourcePin.issuer, version: sourcePin.version, archive: sourcePin.sourceArchive, provenance: sourcePin.provenance,
      patch: { file: sourcePin.patch.file, beforeSha256: sourcePin.patch.beforeSha256, afterSha256: sourcePin.patch.afterSha256, macro: sourcePin.patch.macro, value: sourcePin.patch.value },
      patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }) => ({ file, beforeSha256, afterSha256, kind })), baseline, working };
    await fs.writeFile(path.join(destination, "source-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { baselineDir: path.join(destination, "baseline"), workingDir: path.join(destination, "working"), receipt };
  } catch { fail(); }
}

/** Same trusted-interpreter assumption as prepareNodePosixSource; stage only NASM/licence after checking all ZIP members. */
export async function prepareNodePosixNasmTool({ archivePath, destination, pythonPath = "python", executionEnv, cwd }) {
  try {
    await verifyArchive(archivePath, sourcePin.nasmTool); await ancestors(path.dirname(destination));
    const result = await invoke(pythonPath, ["nasm", archivePath, destination], { executionEnv, cwd });
    const files = sourcePin.nasmTool.files.filter(entry => entry.stage);
    if (!result || result.schema !== 1 || result.issuer !== sourcePin.issuer || result.tool !== "nasm" || result.version !== sourcePin.nasmTool.version ||
        result.archiveSha256 !== sourcePin.nasmTool.sha256 || result.verifiedArchiveFiles !== 3 || result.signatureVerified !== false ||
        JSON.stringify(result.files) !== JSON.stringify(files) || Object.keys(result).length !== 8) fail();
    const receipt = { ...result, provenance: sourcePin.nasmTool.provenance };
    await fs.writeFile(path.join(destination, "nasm-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { nasmPath: path.join(destination, "nasm.exe"), licensePath: path.join(destination, "LICENSE"), receipt };
  } catch { fail(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--archive" || args[2] !== "--destination" || args[4] !== "--python") fail();
    const prepared = await prepareNodePosixSource({ archivePath: args[1], destination: args[3], pythonPath: args[5] });
    console.log(JSON.stringify({ files: prepared.receipt.baseline.files, directories: prepared.receipt.baseline.directories,
      directoriesExcludeArchiveRoot: true, baselineManifestSha256: prepared.receipt.baseline.manifestSha256, workingManifestSha256: prepared.receipt.working.manifestSha256 }));
  } catch { console.error("Fixed Node source preparation failed; its partial assets are retained."); process.exitCode = 1; }
}
