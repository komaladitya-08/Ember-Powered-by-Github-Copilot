// Packaging integrity only: this does not grant native execution, profile access, or a stopped-writer receipt.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import manifest from "../../app/shared/windows-node-toolchain.json" with { type: "json" };

const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const WINDOWS_NODE_TOOLCHAIN = freeze(manifest);
export const WINDOWS_NODE_TOOLCHAIN_DIRECTORY = "coding/windows-node-x64";
const retained = new Set();
let uncertainClose = false;
const refused = () => new Error("The pinned Windows coding toolchain could not be verified.");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function closeDescriptor(fd, bytes, target) {
  try { fs.closeSync(fd); }
  catch { uncertainClose = true; retained.add({ fd, bytes, target }); throw refused(); }
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === 1n && b.nlink === 1n && a.isFile() && b.isFile();
const members = kind => {
  if (kind !== "producer" && kind !== "package") throw refused();
  return WINDOWS_NODE_TOOLCHAIN.files.filter(file => kind === "producer" || file.ship);
};
function capture(directory, kind, expectedRoot) {
  try { return captureKnown(directory, kind, expectedRoot); } catch { throw refused(); }
}
function captureKnown(directory, kind, expectedRoot) {
  if (uncertainClose) throw refused();
  if (typeof directory !== "string" || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw refused();
  const expected = members(kind), root = fs.lstatSync(directory, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) throw refused();
  if (expectedRoot && !sameDirectoryIdentity(expectedRoot, root)) throw refused();
  const names = fs.readdirSync(directory).sort(), wanted = expected.map(file => kind === "producer" ? file.source : file.name).sort();
  if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) throw refused();
  const buffers = new Map();
  try {
    for (const file of expected) {
      const target = path.join(directory, kind === "producer" ? file.source : file.name);
      const before = fs.lstatSync(target, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(file.bytes)) throw refused();
      let fd;
      const bytes = Buffer.alloc(file.bytes); buffers.set(file, bytes);
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        if (!same(before, fs.fstatSync(fd, { bigint: true }))) throw refused();
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
          if (count < 1) throw refused(); offset += count;
        }
        if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || !same(before, fs.fstatSync(fd, { bigint: true })) ||
            !same(before, fs.lstatSync(target, { bigint: true })) || digest(bytes) !== file.sha256) throw refused();
      } finally {
        if (fd !== undefined) closeDescriptor(fd, bytes, target);
      }
    }
    if (!sameDirectory(root, fs.lstatSync(directory, { bigint: true })) || fs.readdirSync(directory).sort().some((name, index) => name !== wanted[index]) || fs.readdirSync(directory).length !== wanted.length) throw refused();
    return buffers;
  } catch {
    for (const bytes of buffers.values()) bytes.fill(0);
    throw refused();
  }
}
const sameDirectory = (a, b) => a.isDirectory() && b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameDirectoryIdentity = (a, b) => a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
/** Checks exact bytes using held descriptors, bounded reads and post-read identity/EOF. No authority token is minted. */
export function verifyWindowsNodeToolchain(directory, kind = "package") {
  const buffers = capture(directory, kind);
  try { return Object.freeze({ schema: 1, issuer: WINDOWS_NODE_TOOLCHAIN.issuer, files: buffers.size }); }
  finally { for (const bytes of buffers.values()) bytes.fill(0); }
}
/** Only a new leaf directory may be created. Failure leaves the known partial staging tree for inspection. */
export function stageWindowsNodeToolchain(source, destination) {
  if (uncertainClose) throw refused();
  if (typeof destination !== "string" || !path.isAbsolute(destination) || /[\0\r\n]/.test(destination)) throw refused();
  const buffers = capture(source, "producer");
  try {
    fs.mkdirSync(destination, { mode: 0o700 });
    const createdRoot = fs.lstatSync(destination, { bigint: true });
    const checkRoot = () => { if (!sameDirectoryIdentity(createdRoot, fs.lstatSync(destination, { bigint: true }))) throw refused(); };
    checkRoot();
    for (const [file, bytes] of buffers) if (file.ship) {
      checkRoot();
      const target = path.join(destination, file.name);
      let fd;
      try {
        fd = fs.openSync(target, "wx", 0o600);
        let offset = 0;
        while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset); if (count < 1) throw refused(); offset += count; }
        fs.fsyncSync(fd);
        const info = fs.fstatSync(fd, { bigint: true });
        if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(file.bytes)) throw refused();
      } finally {
        if (fd !== undefined) closeDescriptor(fd, bytes, target);
      }
      checkRoot();
    }
    const staged = capture(destination, "package", createdRoot);
    try { checkRoot(); return Object.freeze({ schema: 1, issuer: WINDOWS_NODE_TOOLCHAIN.issuer, files: staged.size }); }
    finally { for (const bytes of staged.values()) bytes.fill(0); }
  } catch { throw refused(); }
  finally { for (const bytes of buffers.values()) bytes.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: node scripts/package/windows-node-toolchain.mjs <verified producer directory> <new destination>");
  const result = stageWindowsNodeToolchain(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
  console.log(`Pinned Windows Node toolchain staged (${result.files} files).`);
}
