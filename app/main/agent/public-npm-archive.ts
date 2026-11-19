/** Authenticate public package bytes, then inspect bounded tar members as data; never extract or execute them on the host. */
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { parseBoundedCodingJson } from "./coding-bounded-json";
import { PUBLIC_NPM_LIMITS, PublicNpmPreparationError, publicNpmPackageIdentity, type PublicNpmPackage } from "./public-npm-lock";

export interface PublicNpmArchiveReceipt { readonly compressedBytes: number; readonly expandedBytes: number; readonly entries: number; readonly sha512: string }
const bad = () => new PublicNpmPreparationError();
function octal(bytes: Buffer): number {
  const value = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]{1,12}$/.test(value)) throw bad(); const result = Number.parseInt(value, 8); if (!Number.isSafeInteger(result)) throw bad(); return result;
}
function field(bytes: Buffer): string {
  const zero = bytes.indexOf(0), body = bytes.subarray(0, zero < 0 ? undefined : zero), value = body.toString("utf8");
  if (!Buffer.from(value).equals(body)) throw bad(); return value;
}
function member(value: string): string {
  if (!value || value !== value.normalize("NFC") || Buffer.byteLength(value) > 4096 || /[\\:\p{Cc}\p{Cf}]/u.test(value) ||
      value.split("/").length > PUBLIC_NPM_LIMITS.depth || value.split("/").some(part => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255 || /[. ]$/.test(part))) throw bad();
  return value;
}
/** The receipt describes inspected immutable input, not the mutable installed dependency tree. */
export async function verifyPublicNpmArchive(artifact: PublicNpmPackage, input: Buffer, options: { signal?: AbortSignal; current?: () => void; maximumExpandedBytes?: number } = {}): Promise<PublicNpmArchiveReceipt> {
  try {
    const expected = publicNpmPackageIdentity(artifact), signal = options.signal, checkCurrent = options.current?.bind(options);
    const current = () => { signal?.throwIfAborted(); checkCurrent?.(); }; current();
    const maximum = options.maximumExpandedBytes ?? PUBLIC_NPM_LIMITS.expandedBytes;
    if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > PUBLIC_NPM_LIMITS.expandedBytes) throw bad();
    if (!Buffer.isBuffer(input) || input.length < 32 || input.length > PUBLIC_NPM_LIMITS.archiveBytes ||
        typeof SharedArrayBuffer !== "undefined" && input.buffer instanceof SharedArrayBuffer) throw bad();
    const source = Buffer.from(input), sha512 = createHash("sha512").update(source).digest("base64");
    if ("sha512-" + sha512 !== expected.integrity) throw bad();
    const tar = await promisify(gunzip)(source, { maxOutputLength: maximum });
    current();
    const names = new Map<string, "file" | "directory">(); let offset = 0, expandedBytes = 0, entries = 0, ended = false, packageJson: Buffer | undefined;
    while (offset + 512 <= tar.length) {
      if (entries % 128 === 0) { await yieldToLoop(); current(); }
      const h = tar.subarray(offset, offset + 512); offset += 512;
      if (h.every(byte => byte === 0)) {
        for (let at = offset; at < tar.length; at += 64 * 1024) {
          current(); if (tar.subarray(at, Math.min(tar.length, at + 64 * 1024)).some(byte => byte !== 0)) throw bad();
          await yieldToLoop();
        }
        ended = true; break;
      }
      let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
      if (checksum !== octal(h.subarray(148, 156)) || ![0, 48, 53].includes(h[156])) throw bad();
      const directory = h[156] === 53, prefix = field(h.subarray(345, 500));
      const raw = (prefix ? prefix + "/" : "") + field(h.subarray(0, 100)), name = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
      const size = octal(h.subarray(124, 136)), mode = octal(h.subarray(100, 108));
      if (mode & 0o7000 || directory && size || size > PUBLIC_NPM_LIMITS.fileBytes || offset + size > tar.length ||
          (expandedBytes += size) > PUBLIC_NPM_LIMITS.expandedBytes || ++entries > PUBLIC_NPM_LIMITS.entries) throw bad();
      if (name === "package" && directory) { offset += Math.ceil(size / 512) * 512; continue; }
      if (!name.startsWith("package/")) throw bad();
      const relative = member(name.slice(8)), folded = relative.toLowerCase(); if (names.has(folded)) throw bad();
      names.set(folded, directory ? "directory" : "file");
      if (relative === "npm-shrinkwrap.json" || relative === "node_modules" || relative.startsWith("node_modules/")) throw bad();
      if (relative === "package.json") {
        if (directory || size > PUBLIC_NPM_LIMITS.packageJsonBytes) throw bad(); packageJson = Buffer.from(tar.subarray(offset, offset + size));
      }
      offset += Math.ceil(size / 512) * 512;
    }
    if (!ended || !packageJson) throw bad();
    const text = packageJson.toString("utf8"); if (!Buffer.from(text).equals(packageJson)) throw bad();
    await yieldToLoop(); current();
    const pkg = parseBoundedCodingJson(text, { depth: 64, containers: 128_000, keyBytes: 4096 }) as Record<string, unknown>;
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || pkg.name !== expected.name || pkg.version !== expected.version ||
        Array.isArray(pkg.bundledDependencies) && pkg.bundledDependencies.length || Array.isArray(pkg.bundleDependencies) && pkg.bundleDependencies.length) throw bad();
    let inspected = 0;
    for (const key of names.keys()) {
      if (++inspected % 128 === 0) { await yieldToLoop(); current(); }
      const parts = key.split("/"); for (let i = 1; i < parts.length; i++) if (names.get(parts.slice(0, i).join("/")) === "file") throw bad();
    }
    // All inflated bytes count, including headers/alignment/end padding; a tiny payload cannot hide a zip bomb.
    current(); return Object.freeze({ compressedBytes: source.length, expandedBytes: tar.length, entries, sha512 });
  } catch { throw bad(); }
}
