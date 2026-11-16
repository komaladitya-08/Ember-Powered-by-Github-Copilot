/** Fresh signed-source preparation for the fixed uv_spawn experiment. The caller supplies an already trusted interpreter. */
import fs from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const fail = () => { throw new Error("The fixed uv_spawn source failed its signed archive and exact catalog contract."); };
const freeze = value => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const sourcePin = freeze(JSON.parse(readFileSync(new URL("./windows-uv-spawn-source-pin.json", import.meta.url), "utf8")));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = stat => `${stat.dev}:${stat.ino}`;
const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
const relative = value => {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\\")) fail();
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /[^\x20-\x7e]|[:<>"|?*]/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part))) fail();
  return parts;
};
async function ancestors(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.normalize(directory) !== directory) fail();
  const chain = []; let current = directory;
  for (;;) { chain.push(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  for (const item of chain.reverse()) { const stat = await fs.lstat(item); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(); }
}
async function fresh(directory) {
  await ancestors(path.dirname(directory));
  await fs.mkdir(directory, { mode: 0o700 });
  await ancestors(directory);
  return identity(await fs.lstat(directory));
}
async function readPinned(file, expected) {
  await ancestors(path.dirname(file));
  const before = await fs.lstat(file);
  if (!regular(before) || before.size !== expected.bytes) fail();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!regular(opened) || identity(opened) !== identity(before) || opened.size !== expected.bytes) fail();
    const output = Buffer.alloc(expected.bytes + 1); let position = 0;
    while (position < output.length) { const result = await handle.read(output, position, output.length - position, position); if (!result.bytesRead) break; position += result.bytesRead; }
    const after = await handle.stat(), observed = await fs.lstat(file);
    if (position !== expected.bytes || !regular(after) || !regular(observed) || identity(after) !== identity(opened) || identity(observed) !== identity(opened) ||
        opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || sha256(output.subarray(0, position)) !== expected.sha256) fail();
    return output.subarray(0, position);
  } finally { await handle.close(); }
}
function expectedFiles(variant) {
  if (variant !== "stock" && variant !== "working") fail();
  return sourcePin.files.map(file => {
    const patch = variant === "working" && sourcePin.patches.find(item => item.file === file.path);
    return patch ? { ...file, bytes: patch.afterBytes, sha256: patch.afterSha256 } : { ...file };
  });
}
function manifestHash(files) { return sha256(Buffer.from(files.map(file => `${file.sha256} ${file.bytes} ${file.path}\n`).join(""), "ascii")); }
const innerPin = JSON.parse(readFileSync(new URL("./windows-libuv-source-pin.json", import.meta.url), "utf8"));
if (JSON.stringify(sourcePin.files) !== JSON.stringify(innerPin.files) || JSON.stringify(sourcePin.directories) !== JSON.stringify(innerPin.directories) ||
    JSON.stringify(sourcePin.sourceArchive) !== JSON.stringify(innerPin.sourceArchive) || sourcePin.innerStockIssuer !== innerPin.issuer ||
    sourcePin.files.length !== sourcePin.inventory.files || sourcePin.directories.length !== sourcePin.inventory.directories ||
    new Set(sourcePin.files.map(file => file.path.toLowerCase())).size !== sourcePin.files.length ||
    manifestHash(expectedFiles("stock")) !== sourcePin.stockManifestSha256 || manifestHash(expectedFiles("working")) !== sourcePin.workingManifestSha256 ||
    expectedFiles("stock").reduce((sum, file) => sum + file.bytes, 0) !== sourcePin.inventory.stockBytes ||
    expectedFiles("working").reduce((sum, file) => sum + file.bytes, 0) !== sourcePin.inventory.workingBytes) fail();


/** Compare every ordinary file, directory and complete byte against the fixed archive/patch manifest. */
export async function validateWindowsUvSpawnSource(root, variant = "stock") {
  try {
    await ancestors(root); const rootId = identity(await fs.lstat(root));
    const files = expectedFiles(variant), expected = new Map(files.map(file => [file.path, file]));
    const directories = new Set(sourcePin.directories), observedFiles = new Set(), observedDirectories = new Set();
    let count = 0;
    async function walk(directory, prefix) {
      await ancestors(directory);
      for await (const item of await fs.opendir(directory)) {
        if (++count > sourcePin.limits.files + sourcePin.directories.length) fail();
        const name = prefix ? `${prefix}/${item.name}` : item.name; relative(name);
        const full = path.join(directory, item.name), stat = await fs.lstat(full);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (!directories.has(name) || observedDirectories.has(name)) fail();
          observedDirectories.add(name); await walk(full, name);
        } else {
          const entry = expected.get(name);
          if (!entry || observedFiles.has(name) || !regular(stat)) fail();
          await readPinned(full, entry); observedFiles.add(name);
        }
      }
    }
    await walk(root, ""); await ancestors(root);
    const manifestSha256 = manifestHash(files), wanted = variant === "stock" ? sourcePin.stockManifestSha256 : sourcePin.workingManifestSha256;
    if (identity(await fs.lstat(root)) !== rootId || observedFiles.size !== expected.size || observedDirectories.size !== directories.size || manifestSha256 !== wanted) fail();
    return { schema: 1, issuer: sourcePin.issuer, version: sourcePin.version, variant, bytes: files.reduce((sum, file) => sum + file.bytes, 0), files, manifestSha256 };
  } catch { fail(); }
}

/** Each accepted patch has a fixed full-file before/after hash; a caller cannot supply a patch body. */
export function applyWindowsUvSpawnPatch(file, bytes) {
  const patch = sourcePin.patches.find(item => item.file === file);
  if (!patch || !Buffer.isBuffer(bytes) || bytes.length !== patch.beforeBytes || sha256(bytes) !== patch.beforeSha256) fail();
  const text = bytes.toString("utf8");
  if (text.split(patch.needle).length !== 2) fail();
  const output = Buffer.from(text.replace(patch.needle, patch.replacement), "utf8");
  if (output.length !== patch.afterBytes || sha256(output) !== patch.afterSha256) fail();
  return output;
}

/** The stock tree is retained unchanged; only a separate fresh copy receives the exact pinned compile-time guard. */
export async function createWindowsUvSpawnWorkingSource(stockDir, workingDir) {
  try {
    await validateWindowsUvSpawnSource(stockDir, "stock"); const rootId = await fresh(workingDir);
    const current = async () => { await ancestors(workingDir); if (identity(await fs.lstat(workingDir)) !== rootId) fail(); };
    for (const directory of [...sourcePin.directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "en"))) {
      await current(); const full = path.join(workingDir, ...relative(directory)); await ancestors(path.dirname(full)); await fs.mkdir(full, { mode: 0o700 });
    }
    for (const entry of sourcePin.files) {
      await current(); const bytes = await readPinned(path.join(stockDir, ...relative(entry.path)), entry);
      const output = sourcePin.patches.some(item => item.file === entry.path) ? applyWindowsUvSpawnPatch(entry.path, bytes) : bytes;
      const full = path.join(workingDir, ...relative(entry.path)); await ancestors(path.dirname(full));
      await fs.writeFile(full, output, { flag: "wx", mode: 0o600 });
    }
    await current(); await validateWindowsUvSpawnSource(stockDir, "stock");
    return await validateWindowsUvSpawnSource(workingDir, "working");
  } catch { fail(); }
}

/** Fixed archive authority only. pythonPath is a trusted host interpreter, attested before this API by the builder. */
export async function prepareWindowsUvSpawnSource({ archivePath, destination, pythonPath, executionEnv, cwd }) {
  try {
    if (typeof pythonPath !== "string" || !path.isAbsolute(pythonPath) || !executionEnv || typeof executionEnv !== "object" || !path.isAbsolute(cwd)) fail();
    await readPinned(archivePath, sourcePin.sourceArchive);
    await fresh(destination);
    const stockDir = path.join(destination, "stock"), workingDir = path.join(destination, "working");
    const extractor = fileURLToPath(new URL("./extract-node-libuv-source.py", import.meta.url));
    const result = await run(pythonPath, ["-I", "-B", extractor, archivePath, stockDir], {
      env: executionEnv, cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 4096, windowsHide: true,
    });
    const extracted = JSON.parse(result.stdout);
    if (!extracted || Object.keys(extracted).sort().join(",") !== "bytes,files,issuer,schema" || extracted.schema !== 1 ||
        extracted.issuer !== sourcePin.innerStockIssuer || extracted.files !== sourcePin.inventory.files || extracted.bytes !== sourcePin.inventory.stockBytes) fail();
    const stock = await validateWindowsUvSpawnSource(stockDir, "stock"), working = await createWindowsUvSpawnWorkingSource(stockDir, workingDir);
    const receipt = { schema: 1, issuer: sourcePin.issuer, version: sourcePin.version, archive: sourcePin.sourceArchive,
      provenance: sourcePin.provenance, patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }) => ({ file, beforeSha256, afterSha256, kind })), stock, working };
    await fs.writeFile(path.join(destination, "source-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { stockDir, workingDir, receipt };
  } catch { fail(); }
}
