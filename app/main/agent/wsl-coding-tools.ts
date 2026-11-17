/** Authenticated offline WSL tool assets. Projects cannot select paths, acquire packages or mint this capability. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { copyIsolatedCommandAssets, type IsolatedCommandAssetResult } from "./isolated-command-assets";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";

import toolManifest from "../../shared/wsl-coding-tools.json";

export const WSL_TYPESCRIPT = Object.freeze({ ...toolManifest });
const ARCHIVE_BYTES = 8 * 1024 * 1024, TOOL_BYTES = 128 * 1024 * 1024, TOOL_FILES = 10_000;
const bad = () => new Error("The offline WSL coding tools could not be authenticated.");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const stable = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
type ToolFile = { path: string; bytes: Buffer };
interface Profile { node: string; npm: ToolFile[]; typescript: ToolFile[]; files: number; bytes: number; sha256: string }
const profiles = new WeakMap<object, Profile>();

function relative(value: string): string {
  if (!value || value !== value.normalize("NFC") || Buffer.byteLength(value) > 4096 || /[\\:\p{Cc}\p{Cf}]/u.test(value) ||
      value.split("/").some(p => !p || p === "." || p === ".." || Buffer.byteLength(p) > 255 || /[. ]$/.test(p))) throw bad();
  return value;
}
function octal(value: Buffer): number {
  const text = value.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]{1,12}$/.test(text)) throw bad();
  const n = Number.parseInt(text, 8); if (!Number.isSafeInteger(n)) throw bad(); return n;
}
function field(bytes: Buffer): string {
  const end = bytes.indexOf(0), body = bytes.subarray(0, end < 0 ? undefined : end);
  const text = body.toString("utf8"); if (!Buffer.from(text).equals(body)) throw bad(); return text;
}

/** Authenticate before decompression. Only ordinary members of the exact TypeScript package enter fresh files. */
export async function readWslTypeScriptArchive(input: Buffer): Promise<readonly ToolFile[]> {
  if (!Buffer.isBuffer(input) || input.length < 32 || input.length > ARCHIVE_BYTES ||
      typeof SharedArrayBuffer !== "undefined" && input.buffer instanceof SharedArrayBuffer) throw bad();
  const source = Buffer.from(input);
  if ("sha512-" + createHash("sha512").update(source).digest("base64") !== WSL_TYPESCRIPT.integrity) throw bad();
  const unpacked = await promisify(gunzip)(source, { maxOutputLength: 64 * 1024 * 1024 });
  const files: ToolFile[] = [], names = new Map<string, "file" | "directory">(); let offset = 0, total = 0, ended = false;
  while (offset + 512 <= unpacked.length) {
    const h = unpacked.subarray(offset, offset + 512); offset += 512;
    if (h.every(b => b === 0)) { if (unpacked.subarray(offset).some(b => b !== 0)) throw bad(); ended = true; break; }
    const check = octal(h.subarray(148, 156)); let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== check || ![0, 48, 53].includes(h[156])) throw bad();
    const prefix = field(h.subarray(345, 500)), raw = (prefix ? prefix + "/" : "") + field(h.subarray(0, 100));
    const directory = h[156] === 53, name = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!name.startsWith("package/")) throw bad();
    const member = relative(name.slice(8)), folded = member.toLowerCase();
    if (names.has(folded) || !(member.startsWith("lib/") || member.startsWith("bin/") ||
        ["package.json", "LICENSE.txt", "README.md", "SECURITY.md", "ThirdPartyNoticeText.txt"].includes(member))) throw bad();
    names.set(folded, directory ? "directory" : "file");
    const size = octal(h.subarray(124, 136));
    if (directory && size || size > 16 * 1024 * 1024 || (total += size) > 64 * 1024 * 1024 || files.length >= 1000 || offset + size > unpacked.length) throw bad();
    if (!directory) files.push({ path: member, bytes: Buffer.from(unpacked.subarray(offset, offset + size)) });
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || !files.some(f => f.path === "LICENSE.txt") || !files.some(f => f.path === "lib/tsc.js") ||
      !files.some(f => f.path === "lib/_tsc.js") || !files.some(f => f.path === "lib/lib.es2022.d.ts")) throw bad();
  const pkg = JSON.parse(files.find(f => f.path === "package.json")!.bytes.toString("utf8"));
  if (pkg.name !== "typescript" || pkg.version !== WSL_TYPESCRIPT.version || pkg.license !== "Apache-2.0") throw bad();
  for (const f of files) {
    let parent = path.posix.dirname(f.path);
    while (parent !== ".") { if (names.get(parent.toLowerCase()) === "file") throw bad(); parent = path.posix.dirname(parent); }
  }
  return files;
}

async function trusted(file: string, directory = false): Promise<string> {
  if (!path.isAbsolute(file)) throw bad();
  let part = path.parse(file).root, pending = file.slice(part.length).split(path.sep).filter(Boolean), links = 0;
  const root = await fs.lstat(part); if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) !== 0) throw bad();
  while (pending.length) {
    const next = path.join(part, pending.shift()!), s = await fs.lstat(next);
    if (s.uid !== 0 || !s.isSymbolicLink() && (s.mode & 0o022) !== 0) throw bad();
    if (s.isSymbolicLink()) {
      if (++links > 32) throw bad(); const target = path.resolve(path.dirname(next), await fs.readlink(next));
      pending = [...target.slice(path.parse(target).root.length).split(path.sep).filter(Boolean), ...pending]; part = path.parse(target).root; continue;
    }
    if (pending.length && !s.isDirectory()) throw bad(); part = next;
  }
  const real = await fs.realpath(file); if (real !== part) throw bad();
  const s = await fs.lstat(real); if (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) throw bad();
  return real;
}
async function npmFiles(folder: string, protectedPaths: readonly string[], signal?: AbortSignal): Promise<ToolFile[]> {
  const root = await trusted(folder, true), protectedRoots = await Promise.all(protectedPaths.map(p => fs.realpath(p)));
  if (protectedRoots.some(p => inside(root, p))) throw bad();
  const files: ToolFile[] = []; let bytes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32 || files.length >= TOOL_FILES) throw bad(); signal?.throwIfAborted();
    const before = await fs.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== 0n || (before.mode & 0o022n) !== 0n) throw bad();
    for (const name of await fs.readdir(directory)) {
      // Configuration is not executable tool code. Never transfer host registry/auth settings into a guest.
      if (name.toLowerCase() === ".npmrc") continue;
      if ([".git", ".ssh", ".aws", ".azure", ".env"].includes(name.toLowerCase()) || name.toLowerCase().startsWith(".env.")) throw bad();
      const member = relative(prefix ? prefix + "/" + name : name), file = path.join(directory, name), s = await fs.lstat(file);
      if (s.isSymbolicLink()) throw bad();
      if (s.isDirectory()) await visit(file, member, depth + 1);
      else {
        const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await h.stat({ bigint: true });
          if (!stat.isFile() || stat.uid !== 0n || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n || stat.size > 16n * 1024n * 1024n ||
              (bytes += Number(stat.size)) > TOOL_BYTES || files.length >= TOOL_FILES) throw bad();
          const body = await h.readFile(); if (body.length !== Number(stat.size) || !stable(stat, await h.stat({ bigint: true })) || !stable(stat, await fs.lstat(file, { bigint: true }))) throw bad();
          files.push({ path: member, bytes: body });
        } finally { await h.close(); }
      }
    }
    if (!stable(before, await fs.lstat(directory, { bigint: true }))) throw bad();
  };
  await visit(root, "", 0);
  const pkg = JSON.parse(files.find(f => f.path === "package.json")?.bytes.toString("utf8") ?? "null");
  if (!pkg || pkg.name !== "npm" || !/^\d+\.\d+\.\d+$/.test(pkg.version) || !files.some(f => f.path === "bin/npm-cli.js")) throw bad();
  return files;
}

/** Opaque host-issued profile. Its only executable is an existing root-owned Node, never project PATH or Electron. */
export class WslCodingToolProfile {
  private constructor() { Object.freeze(this); }
  static async create(input: { nodePath: string; npmPath?: string; typescriptArchive: Buffer; protectedPaths: readonly string[]; signal?: AbortSignal }): Promise<WslCodingToolProfile> {
    if (HOST_PLATFORM !== "linux" || HOST_ARCH !== "x64" || !input.protectedPaths.length) throw bad();
    input.signal?.throwIfAborted(); const node = await trusted(input.nodePath);
    if (!/^(node|nodejs)$/.test(path.basename(node))) throw bad();
    const npm = await npmFiles(input.npmPath ?? path.join(path.dirname(path.dirname(node)), "lib/node_modules/npm"), input.protectedPaths, input.signal);
    const typescript = [...await readWslTypeScriptArchive(input.typescriptArchive)]; input.signal?.throwIfAborted();
    const all = [...npm.map(f => ({ ...f, path: "npm/" + f.path })), ...typescript.map(f => ({ ...f, path: "typescript/" + f.path }))];
    const value = new WslCodingToolProfile(); profiles.set(value, { node, npm, typescript, files: all.length,
      bytes: all.reduce((n, f) => n + f.bytes.length, 0), sha256: digest(Buffer.from(JSON.stringify(all.map(f => [f.path, f.bytes.length, digest(f.bytes)]).sort()))) });
    return value;
  }
}

/** A genuine profile is consumed only by the trusted Linux workspace factory, before any untrusted command starts. */
export async function prepareWslCodingTools(profile: WslCodingToolProfile, input: { rootfs: string; nodePath?: string; protectedPaths: readonly string[]; signal?: AbortSignal }): Promise<IsolatedCommandAssetResult> {
  const value = profiles.get(profile); if (!value || input.nodePath !== value.node) throw bad();
  const assets = await copyIsolatedCommandAssets(input);
  const root = await fs.realpath(input.rootfs), folder = path.join(root, "opt/ember-coding-tools");
  await fs.mkdir(path.dirname(folder), { recursive: true, mode: 0o700 }); await fs.mkdir(folder, { mode: 0o700 });
  for (const [name, files] of [["npm", value.npm], ["typescript", value.typescript]] as const) for (const f of files) {
    input.signal?.throwIfAborted(); const target = path.join(folder, name, f.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const out = await fs.open(target, "wx", 0o600);
    try { await out.writeFile(f.bytes); await out.sync(); const read = await fs.readFile(target); if (!read.equals(f.bytes)) throw bad(); }
    finally { await out.close(); }
  }
  await fs.symlink("bash", path.join(root, "usr/bin/sh"));
  for (const [name, entry] of [["npm", "npm/bin/npm-cli.js"], ["tsc", "typescript/lib/tsc.js"]]) {
    const offline = name === "npm" ? 'process.env.NPM_CONFIG_OFFLINE="true";process.env.NPM_CONFIG_UPDATE_NOTIFIER="false";process.env.NPM_CONFIG_AUDIT="false";process.env.NPM_CONFIG_FUND="false";\n' : "";
    await fs.writeFile(path.join(root, "usr/bin", name), '#!/usr/bin/node\n' + offline + 'require("/opt/ember-coding-tools/' + entry + '");\n', { flag: "wx", mode: 0o700 });
  }
  return { node: assets.node, files: assets.files + value.files + 3, bytes: assets.bytes + value.bytes };
}

/** Public diagnostics carry only immutable counts/digests; no tool path or source buffer is exposed. */
export function wslCodingToolReceipt(profile: WslCodingToolProfile): Readonly<{ files: number; bytes: number; sha256: string; typescript: string }> {
  const value = profiles.get(profile); if (!value) throw bad(); return Object.freeze({ files: value.files, bytes: value.bytes, sha256: value.sha256, typescript: WSL_TYPESCRIPT.version });
}
