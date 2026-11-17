/** Runtime-only held-descriptor reader. No network, installer, decompressor or CLI enters the controller bundle. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import manifest from "../../shared/wsl-coding-tools.json";

const pin = Object.freeze({ ...manifest }), retained = new Set<object>(); let uncertainClose = false;
const refused = () => new Error("The pinned offline WSL coding tools could not be verified.");
const same = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === 1n && b.nlink === 1n &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.isFile() && b.isFile();
/** Returns an owned exact pinned archive only after positive close; unknown close permanently retires this reader. */
export function readWslCodingTypeScriptArchive(target: string): Buffer {
  if (uncertainClose || typeof target !== "string" || !path.isAbsolute(target) || /[\p{Cc}\p{Cf}]/u.test(target)) throw refused();
  let parent = path.dirname(target);
  while (true) {
    const info = fs.lstatSync(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
    const next = path.dirname(parent); if (next === parent) break; parent = next;
  }
  const before = fs.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(pin.bytes)) throw refused();
  const bytes = Buffer.alloc(pin.bytes); let fd: number | undefined, failed = false;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true }); if (!same(before, opened)) throw refused();
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (n < 1) throw refused(); offset += n;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || !same(opened, fs.fstatSync(fd, { bigint: true })) ||
        !same(opened, fs.lstatSync(target, { bigint: true })) || createHash("sha256").update(bytes).digest("hex") !== pin.sha256 ||
        "sha512-" + createHash("sha512").update(bytes).digest("base64") !== pin.integrity) throw refused();
  } catch { bytes.fill(0); failed = true; }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch { uncertainClose = true; retained.add({ fd, bytes }); failed = true; }
    }
  }
  if (failed) throw refused(); return bytes;
}
