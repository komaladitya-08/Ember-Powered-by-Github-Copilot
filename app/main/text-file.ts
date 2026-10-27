/**
 * Text files people write by hand or with scripts (settings.json, the administrator's policy), decoded whatever
 * Unicode form they were saved in. Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a byte-order mark,
 * `Out-File` writes UTF-16, and older editors do either; JSON.parse takes neither, which reset every setting or locked
 * Ember down (review #82). Plain Node.
 */

import fs from "node:fs";

/** `buf` as text: UTF-8 (with or without a byte-order mark), or UTF-16 LE or BE when its byte-order mark says so. */
export function decodeText(buf: Uint8Array): string {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString("utf8");
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b[0] === 0xfe && b[1] === 0xff) {
    // Node has no UTF-16 BE decoder: swap each pair into a copy and read it as LE.
    const le = Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1)));
    le.swap16();
    return le.toString("utf16le");
  }
  return b.toString("utf8");
}

/** Reads `file` as text with decodeText (throws as fs.readFileSync does). */
export function readTextFile(file: string): string {
  return decodeText(fs.readFileSync(file));
}

/** `text` without a leading byte-order mark (left on text decoded elsewhere: a registry value, a remote's file). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
