/** Linux x64 command assets: inspect ELF metadata as bytes, then copy verified files; never execute ldd or a project. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";

export interface IsolatedCommandAssetInput {
  rootfs: string;
  protectedPaths: readonly string[];
  /** Explicit host choice; only a root-owned ELF with verifiable fixed-system dependencies is accepted. */
  nodePath?: string;
  signal?: AbortSignal;
}
export interface IsolatedCommandAssetResult { node: boolean; files: number; bytes: number }
export interface IsolatedCommandElf { interpreter: string | null; needed: string[] }
const LIBRARIES = ["/lib64", "/usr/lib64", "/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib", "/usr/lib"] as const;
const MAX_ASSET = 256 * 1024 * 1024, MAX_TOTAL = 512 * 1024 * 1024, MAX_FILES = 128;

const within = (file: string, root: string) => { const r = path.relative(root, file); return !r || (r !== ".." && !r.startsWith("../") && !path.isAbsolute(r)); };
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const unsupported = () => new Error("The isolated command toolchain or one of its ELF dependencies is unsupported.");

async function inspect(size: number, read: (offset: number, bytes: number) => Promise<Buffer>): Promise<IsolatedCommandElf> {
  const span = async (offset: number, bytes: number, cap: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0 || bytes > cap || offset + bytes > size) throw unsupported();
    const data = await read(offset, bytes);
    if (data.length !== bytes) throw unsupported();
    return data;
  };
  const number = (v: bigint) => { if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported(); return Number(v); };
  const h = await span(0, 64, 64);
  if (!h.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || h[4] !== 2 || h[5] !== 1 || h[6] !== 1 ||
      h.readUInt16LE(18) !== 62 || ![2, 3].includes(h.readUInt16LE(16)) || h.readUInt16LE(52) !== 64 || h.readUInt16LE(54) !== 56) throw unsupported();
  const phnum = h.readUInt16LE(56);
  if (phnum < 1 || phnum > 256) throw unsupported();
  const headers = await span(number(h.readBigUInt64LE(32)), phnum * 56, 256 * 56);
  const load: { virtual: number; offset: number; size: number }[] = [];
  let dynamic: { offset: number; size: number } | null = null, interpreter: string | null = null;
  for (let i = 0; i < phnum; i++) {
    const p = headers.subarray(i * 56, (i + 1) * 56), type = p.readUInt32LE(0);
    const offset = number(p.readBigUInt64LE(8)), virtual = number(p.readBigUInt64LE(16)), length = number(p.readBigUInt64LE(32));
    if (offset + length > size) throw unsupported();
    if (type === 1) load.push({ virtual, offset, size: length });
    if (type === 2) { if (dynamic) throw unsupported(); dynamic = { offset, size: length }; }
    if (type === 3) {
      if (interpreter !== null) throw unsupported();
      const value = await span(offset, length, 4096);
      if (value.length < 2 || value.at(-1) !== 0 || value.subarray(0, -1).includes(0)) throw unsupported();
      interpreter = value.subarray(0, -1).toString("utf8");
      if (!["/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"].includes(interpreter)) throw unsupported();
    }
  }
  if (!dynamic) return { interpreter, needed: [] };
  if (dynamic.size % 16 !== 0) throw unsupported();
  const entries = await span(dynamic.offset, dynamic.size, 64 * 1024);
  let strings: number | null = null, stringBytes: number | null = null, ended = false;
  const neededOffsets: number[] = [];
  for (let i = 0; i < entries.length; i += 16) {
    const tag = entries.readBigInt64LE(i), value = number(entries.readBigUInt64LE(i + 8));
    if (tag === 0n) { ended = true; break; }
    if (tag === 1n) neededOffsets.push(value);
    if (tag === 5n) { if (strings !== null) throw unsupported(); strings = value; }
    if (tag === 10n) { if (stringBytes !== null) throw unsupported(); stringBytes = value; }
    // Custom search paths and loader-injected audit/filter objects require a separate explicit policy.
    if ([15n, 29n, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn].includes(tag)) throw unsupported();
  }
  if (!ended || neededOffsets.length > 64) throw unsupported();
  if (!neededOffsets.length) return { interpreter, needed: [] };
  if (strings === null || stringBytes === null || stringBytes < 1) throw unsupported();
  const mappings = load.filter(p => strings! >= p.virtual && strings! + stringBytes! <= p.virtual + p.size);
  if (mappings.length !== 1) throw unsupported();
  const tableStart = mappings[0].offset + strings - mappings[0].virtual;
  const needed: string[] = [];
  for (const offset of neededOffsets) {
    if (offset >= stringBytes) throw unsupported();
    // Node's symbol string table can be several MiB. Read only each bounded dependency name, never that whole table.
    const value = await span(tableStart + offset, Math.min(256, stringBytes - offset), 256);
    const end = value.indexOf(0);
    if (end < 0) throw unsupported();
    const name = value.subarray(0, end).toString("ascii");
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || !Buffer.from(name, "ascii").equals(value.subarray(0, end))) throw unsupported();
    needed.push(name);
  }
  return { interpreter, needed: [...new Set(needed)] };
}

/** Pure parser used by the host; no executable is launched to inspect ELF dependencies. */
export function inspectIsolatedCommandElf(data: Buffer): Promise<IsolatedCommandElf> {
  return inspect(data.length, async (offset, bytes) => data.subarray(offset, offset + bytes));
}

async function trustedParents(file: string): Promise<void> {
  let parent = path.dirname(file);
  for (;;) {
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw unsupported();
    const next = path.dirname(parent); if (next === parent) return; parent = next;
  }
}

/** The caller creates a new private empty rootfs and mounts only these copies, never these host library directories. */
export async function copyIsolatedCommandAssets(input: IsolatedCommandAssetInput): Promise<IsolatedCommandAssetResult> {
  if (HOST_PLATFORM !== "linux" || HOST_ARCH !== "x64") throw new Error("Isolated command assets require Linux x64.");
  if (!path.isAbsolute(input.rootfs) || !input.protectedPaths.length || input.protectedPaths.some(p => !path.isAbsolute(p)) || (input.nodePath !== undefined && !path.isAbsolute(input.nodePath))) throw unsupported();
  input.signal?.throwIfAborted();
  const root = await fs.realpath(input.rootfs), stat = await fs.lstat(input.rootfs);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (await fs.readdir(root)).length) throw new Error("The isolated command root must be a new private empty directory.");
  const protectedRoots = await Promise.all(input.protectedPaths.map(p => fs.realpath(p)));
  const copied = new Map<string, string>();
  let bytes = 0;
  const resolveLibrary = async (name: string) => {
    for (const dir of LIBRARIES) {
      const candidate = path.join(dir, name);
      try { await fs.lstat(candidate); return candidate; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    throw unsupported();
  };
  const copy = async (source: string, target: string): Promise<void> => {
    input.signal?.throwIfAborted();
    const real = await fs.realpath(source);
    if (protectedRoots.some(p => within(real, p))) throw new Error("An isolated command asset reaches protected data.");
    if (!path.isAbsolute(target) || target.split("/").some(p => p === "." || p === "..") || target.includes("\\") || target.includes("\0")) throw unsupported();
    const prior = copied.get(target);
    if (prior) { if (prior !== real) throw unsupported(); return; }
    if (copied.size >= MAX_FILES) throw unsupported();
    await trustedParents(real);
    const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let info: IsolatedCommandElf;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== 0n || (before.mode & 0o022n) !== 0n || before.size < 64n || before.size > BigInt(MAX_ASSET)) throw unsupported();
      if ((bytes += Number(before.size)) > MAX_TOTAL) throw unsupported();
      info = await inspect(Number(before.size), async (offset, length) => {
        input.signal?.throwIfAborted();
        const data = Buffer.alloc(length); let read = 0;
        while (read < length) { const n = (await handle.read(data, read, length - read, offset + read)).bytesRead; if (!n) throw unsupported(); read += n; }
        return data;
      });
      const dest = path.join(root, target.slice(1));
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      const output = await fs.open(dest, "wx", before.mode & 0o111n ? 0o700 : 0o600);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024), size = Number(before.size);
        for (let offset = 0; offset < size;) {
          input.signal?.throwIfAborted();
          const read = (await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)).bytesRead;
          if (!read) throw unsupported();
          let written = 0;
          while (written < read) { const n = (await output.write(buffer, written, read - written)).bytesWritten; if (!n) throw unsupported(); written += n; }
          offset += read;
        }
      } finally { await output.close(); }
      if (!same(before, await handle.stat({ bigint: true }))) throw unsupported();
      copied.set(target, real);
    } finally { await handle.close(); }
    if (info.interpreter) await copy(info.interpreter, info.interpreter);
    for (const library of info.needed) { const resolved = await resolveLibrary(library); await copy(resolved, resolved); }
  };
  for (const file of ["/usr/bin/bash", "/usr/bin/cat", "/usr/bin/sleep"]) await copy(file, file);
  if (input.nodePath) await copy(input.nodePath, "/usr/bin/node");
  input.signal?.throwIfAborted();
  return { node: input.nodePath !== undefined, files: copied.size, bytes };
}
