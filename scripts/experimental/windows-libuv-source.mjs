// Host-only provenance and fresh source preparation for the fixed libuv C experiment. No product/project inputs.
import fs from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const fail = () => { throw new Error("The pinned libuv probe source could not be verified; retain its incomplete preparation."); };
const freeze = value => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const sourcePin = freeze(JSON.parse(readFileSync(new URL("./windows-libuv-source-pin.json", import.meta.url), "utf8")));
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
  if (variant !== "stock" && variant !== "offline") fail();
  return sourcePin.files.map(file => variant === "offline" && file.path === sourcePin.patch.file
    ? { ...file, bytes: sourcePin.patch.afterBytes, sha256: sourcePin.patch.afterSha256 } : { ...file });
}
function manifestHash(files) { return sha256(Buffer.from(files.map(file => `${file.sha256} ${file.bytes} ${file.path}\n`).join(""), "ascii")); }

/** Compare every ordinary file, directory and complete byte against the fixed archive/patch manifest. */
export async function validateSourceTree(root, variant = "stock") {
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
    const manifestSha256 = manifestHash(files), wanted = variant === "stock" ? sourcePin.stockManifestSha256 : sourcePin.offlineManifestSha256;
    if (identity(await fs.lstat(root)) !== rootId || observedFiles.size !== expected.size || observedDirectories.size !== directories.size || manifestSha256 !== wanted) fail();
    return { schema: 1, issuer: sourcePin.issuer, version: sourcePin.version, variant, bytes: files.reduce((sum, file) => sum + file.bytes, 0), files, manifestSha256 };
  } catch { fail(); }
}

export function applyOfflineCorePatch(bytes) {
  const patch = sourcePin.patch;
  if (!Buffer.isBuffer(bytes) || bytes.length !== patch.beforeBytes || sha256(bytes) !== patch.beforeSha256) fail();
  const text = bytes.toString("utf8");
  if (text.split(patch.needle).length !== 2) fail();
  const output = Buffer.from(text.replace(patch.needle, patch.replacement), "utf8");
  if (output.length !== patch.afterBytes || sha256(output) !== patch.afterSha256) fail();
  return output;
}

/** The stock tree is retained unchanged; only a separate fresh copy receives the exact pinned compile-time guard. */
export async function createOfflineLibuvSource(stockDir, offlineDir) {
  try {
    await validateSourceTree(stockDir, "stock"); const rootId = await fresh(offlineDir);
    const current = async () => { await ancestors(offlineDir); if (identity(await fs.lstat(offlineDir)) !== rootId) fail(); };
    for (const directory of [...sourcePin.directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "en"))) {
      await current(); const full = path.join(offlineDir, ...relative(directory)); await ancestors(path.dirname(full)); await fs.mkdir(full, { mode: 0o700 });
    }
    for (const entry of sourcePin.files) {
      await current(); const bytes = await readPinned(path.join(stockDir, ...relative(entry.path)), entry);
      const output = entry.path === sourcePin.patch.file ? applyOfflineCorePatch(bytes) : bytes;
      const full = path.join(offlineDir, ...relative(entry.path)); await ancestors(path.dirname(full));
      await fs.writeFile(full, output, { flag: "wx", mode: 0o600 });
    }
    await current(); await validateSourceTree(stockDir, "stock");
    return await validateSourceTree(offlineDir, "offline");
  } catch { fail(); }
}

/** No caller-supplied source URL, expected hash, patch or extractor is admitted. pythonPath is a trusted host tool. */
export async function prepareWindowsLibuvSource({ archivePath, destination, pythonPath = "python" }) {
  try {
    await readPinned(archivePath, sourcePin.sourceArchive);
    await fresh(destination);
    const stockDir = path.join(destination, "stock"), offlineDir = path.join(destination, "offline");
    const extractor = fileURLToPath(new URL("./extract-node-libuv-source.py", import.meta.url));
    const result = await run(pythonPath, ["-I", "-B", extractor, archivePath, stockDir], { encoding: "utf8", timeout: 60_000, maxBuffer: 4096, windowsHide: true });
    const extracted = JSON.parse(result.stdout);
    if (extracted.schema !== 1 || extracted.issuer !== sourcePin.issuer || extracted.files !== sourcePin.files.length || extracted.bytes !== sourcePin.files.reduce((sum, entry) => sum + entry.bytes, 0)) fail();
    const stock = await validateSourceTree(stockDir, "stock"), offline = await createOfflineLibuvSource(stockDir, offlineDir);
    const receipt = { schema: 1, issuer: sourcePin.issuer, version: sourcePin.version, archive: sourcePin.sourceArchive, provenance: sourcePin.provenance,
      patch: { file: sourcePin.patch.file, beforeSha256: sourcePin.patch.beforeSha256, afterSha256: sourcePin.patch.afterSha256, macro: sourcePin.patch.macro, value: sourcePin.patch.value }, stock, offline };
    await fs.writeFile(path.join(destination, "source-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { stockDir, offlineDir, receipt };
  } catch { fail(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), values = {};
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (!["--archive", "--destination", "--python"].includes(args[i]) || !args[i + 1] || values[args[i]]) fail();
      values[args[i]] = args[i + 1];
    }
    if (!values["--archive"] || !values["--destination"]) fail();
    const prepared = await prepareWindowsLibuvSource({ archivePath: values["--archive"], destination: values["--destination"], pythonPath: values["--python"] ?? "python" });
    console.log(JSON.stringify({ stockDir: prepared.stockDir, offlineDir: prepared.offlineDir, receipt: path.join(values["--destination"], "source-receipt.json") }));
  } catch { console.error("Pinned libuv source preparation failed; its partial assets are retained."); process.exitCode = 1; }
}
