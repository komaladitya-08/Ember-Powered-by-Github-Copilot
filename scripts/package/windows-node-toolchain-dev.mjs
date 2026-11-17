// Stage only the verified coding Node cache beside npm's installed Windows Electron; never discover or download a runtime.
// usage: node scripts/package/windows-node-toolchain-dev.mjs (strict; requires the fixed cache)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stageWindowsNodeToolchain, verifyWindowsNodeToolchain, WINDOWS_NODE_TOOLCHAIN_DIRECTORY } from "./windows-node-toolchain.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const processFence = {}, failures = new WeakMap(), retained = new WeakMap();
const refused = () => { const error = new Error("The fixed Windows development coding toolchain could not be staged."); error.stack = `Error: ${error.message}`; return error; };
const absent = error => {
  if (!error || typeof error !== "object") return false;
  try { const value = Object.getOwnPropertyDescriptor(error, "code"); return value && Object.hasOwn(value, "value") && value.value === "ENOENT"; } catch { return false; }
};
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fileIdentity = (a, b) => identity(a, b) && a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
  a.nlink === 1n && b.nlink === 1n && a.size === b.size;
const clock = (a, b) => fileIdentity(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Test seam for real-filesystem models. The normal entry point fixes the repository, helpers, resolver and host platform. */
export function bindWindowsNodeToolchainDevelopment({ files = fs, root = repository, platform = process.platform, arch = process.arch,
  resolvePackage = () => createRequire(path.join(root, "package.json")).resolve("electron/package.json"),
  verifyToolchain = verifyWindowsNodeToolchain, stageToolchain = stageWindowsNodeToolchain, fence = processFence } = {}) {
  const samePath = (a, b) => platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const usable = () => { const error = failures.get(fence); if (error) throw error; };
  const fail = owner => {
    let error = failures.get(fence); if (!error) { error = refused(); failures.set(fence, error); }
    if (owner !== undefined) { let owners = retained.get(fence); if (!owners) { owners = []; retained.set(fence, owners); } owners.push(owner); }
    throw error;
  };
  const guard = operation => { usable(); const value = operation(); usable(); return value; };
  const absolute = value => {
    if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || /[\p{Cc}\p{Cf}]/u.test(value)) throw refused();
    return value;
  };
  const directory = (selected, allowMissing = false) => {
    absolute(selected); const chain = []; let current = selected;
    for (;;) { chain.push(current); const parent = path.dirname(current); if (parent === current) break; current = parent; }
    let result;
    for (const file of chain.reverse()) {
      let info;
      try { info = guard(() => files.lstatSync(file, { bigint: true })); }
      catch (error) { if (allowMissing && absent(error)) return null; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(guard(() => files.realpathSync.native(file)), file)) throw refused(); result = info;
    }
    return result;
  };
  const read = (file, maximum, prefix = false) => {
    absolute(file); directory(path.dirname(file));
    const before = guard(() => files.lstatSync(file, { bigint: true }));
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum) ||
        !samePath(guard(() => files.realpathSync.native(file)), file)) throw refused();
    const bytes = Buffer.alloc(Number(prefix ? before.size < 4096n ? before.size : 4096n : before.size)); let fd, failure;
    try {
      usable(); fd = files.openSync(file, files.constants.O_RDONLY | (files.constants.O_NOFOLLOW ?? 0)); usable();
      const opened = guard(() => files.fstatSync(fd, { bigint: true })); if (!fileIdentity(before, opened)) throw refused();
      let offset = 0;
      while (offset < bytes.length) { const count = guard(() => files.readSync(fd, bytes, offset, bytes.length - offset, offset)); if (!Number.isInteger(count) || count < 1 || count > bytes.length - offset) throw refused(); offset += count; }
      if (!prefix && guard(() => files.readSync(fd, Buffer.alloc(1), 0, 1, offset)) !== 0) throw refused();
      const after = guard(() => files.fstatSync(fd, { bigint: true })), named = guard(() => files.lstatSync(file, { bigint: true }));
      // Windows pathname and handle clocks have different meanings: compare clocks only within each API.
      if (!clock(opened, after) || !clock(before, named) || !fileIdentity(after, named) || !samePath(guard(() => files.realpathSync.native(file)), file)) throw refused();
    } catch (error) { failure = error; }
    if (fd !== undefined) {
      if (failures.get(fence)) fail({ fd, bytes, file, files });
      let closed = false;
      try { closed = files.closeSync(fd) === undefined; } catch { /* The same descriptor remains retained without a retry. */ }
      if (!closed || failures.get(fence)) fail({ fd, bytes, file, files });
    }
    if (failure) { bytes.fill(0); throw failure; }
    usable(); return bytes;
  };
  const json = file => {
    const bytes = read(file, 1024 * 1024);
    try { const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes)) throw refused(); return JSON.parse(text); }
    finally { bytes.fill(0); }
  };
  const electronResources = () => {
    const project = json(path.join(root, "package.json")), expected = project.devDependencies?.electron;
    if (typeof expected !== "string" || !/^\d+\.\d+\.\d+$/.test(expected)) throw refused();
    const installed = absolute(guard(resolvePackage)), known = path.join(root, "node_modules", "electron", "package.json");
    if (!samePath(installed, known)) throw refused();
    const pkg = json(installed); if (pkg.name !== "electron" || pkg.version !== expected) throw refused();
    const packageRoot = path.dirname(installed), executableName = read(path.join(packageRoot, "path.txt"), 64);
    try { if (!executableName.equals(Buffer.from("electron.exe"))) throw refused(); } finally { executableName.fill(0); }
    const binary = path.join(packageRoot, "dist", "electron.exe"), header = read(binary, 512 * 1024 * 1024, true);
    try {
      if (header.length < 512 || header.toString("ascii", 0, 2) !== "MZ") throw refused(); const pe = header.readUInt32LE(0x3c);
      if (pe < 64 || pe > header.length - 96 || header.readUInt32LE(pe) !== 0x4550 || header.readUInt16LE(pe + 4) !== 0x8664 ||
          header.readUInt16LE(pe + 24) !== 0x20b || header.readUInt16LE(pe + 24 + 68) !== 2) throw refused();
    } finally { header.fill(0); }
    const resources = path.join(path.dirname(binary), "resources"); return { resources, identity: directory(resources) };
  };
  return ({ required = true } = {}) => {
    usable();
    if (platform !== "win32" || arch !== "x64") { if (required) throw refused(); return Object.freeze({ status: "skipped-platform", files: 0 }); }
    try {
      absolute(root); const source = path.join(root, ".cache", "windows-node-toolchain");
      if (!directory(source, true)) { if (required) throw refused(); return Object.freeze({ status: "skipped-absent", files: 0 }); }
      guard(() => verifyToolchain(source, "producer"));
      const selected = electronResources(), parent = path.join(selected.resources, "coding"), destination = path.join(selected.resources, WINDOWS_NODE_TOOLCHAIN_DIRECTORY);
      if (!directory(parent, true)) { guard(() => files.mkdirSync(parent, { mode: 0o700 })); directory(parent); }
      const existing = directory(destination, true);
      if (!existing) guard(() => stageToolchain(source, destination));
      const result = guard(() => verifyToolchain(destination, "package"));
      if (result.files !== 3 || !identity(selected.identity, directory(selected.resources))) throw refused();
      return Object.freeze({ status: existing ? "verified" : "staged", files: 3 });
    } catch { return fail({ root, files, verifyToolchain, stageToolchain }); }
  };
}

const stageDevelopment = bindWindowsNodeToolchainDevelopment();
/** Ordinary Windows builds may skip only an absent cache; the strict no-argument CLI always requires it. */
export function stageWindowsNodeToolchainDevelopment(options) { return stageDevelopment(options); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw refused();
    const result = stageWindowsNodeToolchainDevelopment(); console.log(`Pinned Windows coding Node development resources ${result.status} (${result.files} files).`);
  } catch { console.error("The fixed Windows development coding toolchain could not be staged."); process.exitCode = 1; }
}
