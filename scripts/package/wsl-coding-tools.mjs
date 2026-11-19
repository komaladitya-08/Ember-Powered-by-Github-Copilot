// Prepares/stages the exact reviewed TypeScript archive for the optional offline WSL coding helper.
// usage: node scripts/package/wsl-coding-tools.mjs (developer/CI preparation only; no application runtime download)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import https from "node:https";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import manifest from "../../app/shared/wsl-coding-tools.json" with { type: "json" };

export const WSL_CODING_TOOLS = Object.freeze({ ...manifest });
export const WSL_CODING_TOOLS_DIRECTORY = "wsl-coding";
const refused = () => new Error("The pinned offline WSL coding tools could not be verified.");
const hash = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const retained = new Set(); let uncertainClose = false;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === 1n && b.nlink === 1n &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.isFile() && b.isFile();
function close(fd, bytes) {
  try { fs.closeSync(fd); } catch { uncertainClose = true; retained.add({ fd, bytes }); throw refused(); }
}
function ordinaryParents(target) {
  if (!path.isAbsolute(target) || /[\p{Cc}\p{Cf}]/u.test(target)) throw refused();
  let parent = path.dirname(target);
  while (true) {
    const info = fs.lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refused();
    const next = path.dirname(parent); if (next === parent) return; parent = next;
  }
}
function capture(target, bytes, sha256) {
  if (uncertainClose) throw refused(); ordinaryParents(target);
  const before = fs.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(bytes)) throw refused();
  const buffer = Buffer.alloc(bytes); let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true }); if (!same(before, opened)) throw refused();
    let offset = 0;
    while (offset < bytes) { const n = fs.readSync(fd, buffer, offset, Math.min(65536, bytes - offset), offset); if (n < 1) throw refused(); offset += n; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes) !== 0 || !same(opened, fs.fstatSync(fd, { bigint: true })) ||
        !same(opened, fs.lstatSync(target, { bigint: true })) || hash(buffer) !== sha256) throw refused();
  } catch { buffer.fill(0); throw refused(); }
  finally { if (fd !== undefined) close(fd, buffer); }
  return buffer;
}
function authenticated(bytes) {
  const m = WSL_CODING_TOOLS;
  if (bytes.length !== m.bytes || hash(bytes) !== m.sha256 || "sha512-" + hash(bytes, "sha512", "base64") !== m.integrity) throw refused();
  // The full archive is authenticated before bounded parsing; never extract any archive-selected path.
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  let license, notice, offset = 0, members = 0, ended = false;
  const octal = b => { const text = b.toString("ascii").replace(/\0.*$/, "").trim(); if (!/^[0-7]{1,12}$/.test(text)) throw refused(); return Number.parseInt(text, 8); };
  const field = b => { const zero = b.indexOf(0); return b.subarray(0, zero < 0 ? undefined : zero).toString("utf8"); };
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512); offset += 512;
    if (h.every(b => b === 0)) { if (tar.subarray(offset).some(b => b !== 0)) throw refused(); ended = true; break; }
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
    const name = field(h.subarray(0, 100)), size = octal(h.subarray(124, 136));
    if (++members > 1000 || checksum !== octal(h.subarray(148, 156)) || ![0, 48, 53].includes(h[156]) ||
        field(h.subarray(345, 500)) || !name.startsWith("package/") || name.split("/").some(p => p === "..") ||
        size > 16 * 1024 * 1024 || offset + size > tar.length) throw refused();
    if (name === "package/LICENSE.txt") { if (license || h[156] === 53) throw refused(); license = Buffer.from(tar.subarray(offset, offset + size)); }
    if (name === "package/ThirdPartyNoticeText.txt") { if (notice || h[156] === 53) throw refused(); notice = Buffer.from(tar.subarray(offset, offset + size)); }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || !license || license.length !== m.licenseBytes || hash(license) !== m.licenseSha256 ||
      !notice || notice.length !== m.noticeBytes || hash(notice) !== m.noticeSha256) throw refused();
  return { license, notice };
}
/** Exact bytes, held ordinary descriptor, bounded EOF/identity/clock checks and positive close before return. */
export function readWslCodingTypeScriptArchive(target) {
  const bytes = capture(target, WSL_CODING_TOOLS.bytes, WSL_CODING_TOOLS.sha256);
  try { authenticated(bytes); return bytes; } catch { bytes.fill(0); throw refused(); }
}
export function verifyWslCodingTools(source) {
  const bytes = readWslCodingTypeScriptArchive(source); bytes.fill(0);
  return Object.freeze({ schema: 1, version: WSL_CODING_TOOLS.version, files: 1 });
}
function writeFresh(target, bytes) {
  let fd;
  try {
    fd = fs.openSync(target, "wx", 0o600); let offset = 0;
    while (offset < bytes.length) { const n = fs.writeSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset); if (n < 1) throw refused(); offset += n; }
    fs.fsyncSync(fd);
    const info = fs.fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(bytes.length)) throw refused();
  } finally { if (fd !== undefined) close(fd, bytes); }
  const readback = capture(target, bytes.length, hash(bytes)); readback.fill(0);
}
/** Only a new leaf is created; unknown/partial output is retained, never recursively removed. */
export function stageWslCodingTools(source, destination) {
  const bytes = readWslCodingTypeScriptArchive(source), { license, notice } = authenticated(bytes);
  try {
    ordinaryParents(destination); fs.mkdirSync(destination, { mode: 0o700 });
    const root = fs.lstatSync(destination, { bigint: true });
    const current = () => { const next = fs.lstatSync(destination, { bigint: true }); if (!next.isDirectory() || next.isSymbolicLink() || next.dev !== root.dev || next.ino !== root.ino) throw refused(); };
    current(); writeFresh(path.join(destination, WSL_CODING_TOOLS.filename), bytes);
    current(); writeFresh(path.join(destination, "LICENSE.txt"), license); current();
    writeFresh(path.join(destination, "ThirdPartyNoticeText.txt"), notice); current();
    return Object.freeze({ schema: 1, version: WSL_CODING_TOOLS.version, files: 3 });
  } finally { bytes.fill(0); license.fill(0); notice.fill(0); }
}
/** A fixed, reviewed public artifact only. The model and application runtime cannot choose or fetch tools. */
export async function prepareWslCodingTools(root) {
  const m = WSL_CODING_TOOLS, lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages?.["node_modules/typescript"];
  if (!lock || lock.version !== m.version || lock.resolved !== m.url || lock.integrity !== m.integrity) throw refused();
  const directory = path.join(root, "dist/wsl-coding-tools"), target = path.join(directory, m.filename);
  if (fs.existsSync(target)) return verifyWslCodingTools(target);
  let trust;
  try { trust = [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])]; } catch { /* Node's own trust applies when the system store is unavailable. */ }
  const agent = new https.Agent({ proxyEnv: process.env, ca: trust });
  const bytes = Buffer.alloc(m.bytes); let offset = 0, response;
  try {
    response = await new Promise((resolve, reject) => https.get(m.url, { agent, signal: AbortSignal.timeout(30_000) }, resolve).on("error", reject));
    // A proxy may carry the request; it cannot select another tool, follow redirects or bypass either digest.
    if (response.statusCode !== 200 || response.headers["content-length"] !== String(m.bytes)) throw refused();
    for await (const part of response) { if (offset + part.length > bytes.length) throw refused(); bytes.set(part, offset); offset += part.length; }
    if (offset !== bytes.length) throw refused(); authenticated(bytes);
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 }); ordinaryParents(target);
    writeFresh(target, bytes); return verifyWslCodingTools(target);
  } catch { throw refused(); }
  finally { response?.destroy(); agent.destroy(); bytes.fill(0); }
}
if (typeof import.meta.url === "string" && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: node scripts/package/wsl-coding-tools.mjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  await prepareWslCodingTools(root); console.log("Pinned offline WSL TypeScript tools prepared and verified.");
}
