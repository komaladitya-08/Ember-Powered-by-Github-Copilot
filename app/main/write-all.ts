/** Complete byte writes for files that must never publish a truncated replacement. */
import fs from "node:fs";

/** Writes every byte at the descriptor's current position, or throws before the caller publishes its file. */
export function writeAllSync(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    // A zero-byte result cannot make progress. Fail rather than loop forever or publish an incomplete file.
    if (written <= 0) throw Object.assign(new Error("The file write made no progress"), { code: "EIO" });
    offset += written;
  }
}
