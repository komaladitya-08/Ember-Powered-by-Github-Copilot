/** Bounded trusted-CI file reads for this fixed build/control. These checks do not exclude concurrent same-user mutators. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const abiHash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("The fixed observer ABI file contract was refused."); };
export function ordinaryAbiWindowsPath(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || /[^\x20-\x7e]|[%!^&|<>";]/.test(value) || value.slice(2).includes(":") ||
      path.win32.normalize(value) !== value || value.slice(3).split("\\").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) fail();
  return value;
}
export function readWindowsUvObserverAbiFile(file, maximum) {
  try {
    ordinaryAbiWindowsPath(file);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 * 1024) fail();
    const parents = []; let directory = path.win32.dirname(file);
    for (;;) { parents.push(directory); const next = path.win32.dirname(directory); if (next === directory) break; directory = next; }
    for (const parent of parents.reverse()) { const info = fs.lstatSync(parent); if (!info.isDirectory() || info.isSymbolicLink()) fail(); }
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) fail();
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd), buffer = Buffer.alloc(before.size + 1); let length = 0;
      while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
      const after = fs.fstatSync(fd), named = fs.lstatSync(file);
      const same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink;
      if (!opened.isFile() || !after.isFile() || !named.isFile() || named.isSymbolicLink() || !same(before, opened) || !same(opened, after) || !same(before, named) ||
          length !== before.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
          before.mtimeMs !== named.mtimeMs || before.ctimeMs !== named.ctimeMs || fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) fail();
      return buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
  } catch { fail(); }
}
export function windowsUvObserverAbiFileFingerprint(file, maximum) {
  const bytes = readWindowsUvObserverAbiFile(file, maximum); return { bytes: bytes.length, sha256: abiHash(bytes) };
}
