/** Fresh private inodes for host-validated continuation bytes. No source path or command authority is accepted. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path/posix";
import { createHash, randomUUID } from "node:crypto";
import { HOST_PLATFORM } from "../platform/os";
import { createCodingReviewExport, type CodingExportBinding, type CodingExportTree, type CodingExportEntry, type ExportedCodingEntry } from "./coding-result-export";
import { codingProjectManifest, type CodingProjectManifest, type CodingExcludedRoot, type CodingScopeOmission } from "./coding-project-scope";
import type { CodingSnapshot } from "./coding-snapshot";

export interface CodingWorkspaceContinuation {
  baseline: CodingExportTree; proposed: CodingExportTree; scope?: CodingProjectManifest;
  /** The predecessor must remain current until the host has accepted the complete new copy. */
  current(): boolean;
}
export class CodingSeedCleanupError extends Error {
  constructor() { super("The private coding seed could not be removed or closed safely."); this.name = "CodingSeedCleanupError"; }
}
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_BYTES = 10 * 1024 * 1024, MAX_FILE = 4 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stable = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export function wipeCodingTree(tree?: CodingExportTree): void { for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0); }
function boundedTree(tree: CodingExportTree, maximum: number): void {
  if (!Array.isArray(tree.entries) || tree.entries.length > 10_000) throw new Error("The coding continuation is too large.");
  let total = 0;
  for (const entry of tree.entries) if (entry.kind === "file" && (!Buffer.isBuffer(entry.bytes) ||
    typeof SharedArrayBuffer !== "undefined" && entry.bytes.buffer instanceof SharedArrayBuffer || entry.bytes.length > MAX_FILE ||
    (total += entry.bytes.length) > maximum)) throw new Error("The coding continuation is too large or has unsupported bytes.");
}

/** Preserve the old baseline, validate both old bindings, and clone before any asynchronous admission or source read. */
export function prepareCodingContinuation(input: CodingWorkspaceContinuation, binding: CodingExportBinding, excludedRoots: readonly CodingExcludedRoot[], signal?: AbortSignal): { baseline: CodingExportTree; proposed: CodingExportTree } {
  const old = input.baseline, proposed = input.proposed, scope = input.scope === undefined ? undefined : codingProjectManifest(input.scope);
  if (old.binding.owner !== binding.owner || [...(scope?.source.excludedRoots ?? [])].sort().join("\0") !== [...excludedRoots].sort().join("\0")) throw new Error("The coding continuation does not match the current owner or source scope.");
  const maximum = Math.min(MAX_BYTES, scope?.source.byteLimit ?? MAX_BYTES);
  boundedTree(old, maximum); boundedTree(proposed, maximum);
  if ([old, proposed].some(tree => tree.entries.some(entry => excludedRoots.includes(entry.path.split("/")[0] as CodingExcludedRoot)))) throw new Error("The coding continuation contains an excluded source root.");
  const limits = { bytes: 2 * MAX_BYTES, fileBytes: MAX_FILE, entries: 10_000, depth: 64 };
  const captured = createCodingReviewExport({ binding: old.binding, baseline: old, proposed, ...(scope ? { scope } : {}), limits, signal }).review;
  for (const entries of [captured.baseline, captured.proposed]) {
    if (entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0) > maximum) throw new Error("The coding continuation is too large.");
  }
  const restore = (entries: ExportedCodingEntry[]): CodingExportTree => {
    const restored: CodingExportEntry[] = [];
    try {
      for (const entry of entries) {
        signal?.throwIfAborted();
        // These exact sizes, paths and canonical bytes were just produced by the trusted formatter.
        restored.push(entry.kind === "directory" ? { ...entry } : { path: entry.path, kind: "file", bytes: Buffer.from(entry.base64, "base64"), executable: entry.executable });
      }
      return { binding: { ...binding }, entries: restored };
    } catch (error) { wipeCodingTree({ binding, entries: restored }); throw error; }
  };
  let baseline: CodingExportTree | undefined, result: CodingExportTree | undefined;
  try {
    baseline = restore(captured.baseline); result = restore(captured.proposed); return { baseline, proposed: result };
  } catch (error) { wipeCodingTree(baseline); wipeCodingTree(result); throw error; }
}
async function mount(handle: fs.FileHandle): Promise<string> {
  const id = /^mnt_id:\s*(\d+)\s*$/m.exec(await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8"))?.[1];
  if (!id) throw new CodingSeedCleanupError(); return id;
}

/** Caller owns these copied buffers and must prove all command writers stopped before disposing a returned snapshot. */
export async function createCodingSeedSnapshot(tree: CodingExportTree, basePath: string, excluded: readonly CodingScopeOmission[], check: () => void): Promise<CodingSnapshot> {
  if (HOST_PLATFORM !== "linux" || !path.isAbsolute(basePath) || path.normalize(basePath) !== basePath) throw new Error("Private coding seeds require an ordinary Linux directory.");
  boundedTree(tree, MAX_BYTES);
  // Reuse the portable path/type/parent/alias validator; never resolve a tree path against the original project.
  createCodingReviewExport({ binding: tree.binding, baseline: tree, proposed: tree, limits: { bytes: 2 * MAX_BYTES, fileBytes: MAX_FILE, entries: 10_000, depth: 64 } });
  if (tree.entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.bytes.length : 0), 0) > MAX_BYTES) throw new Error("The coding continuation is too large.");
  const handles = new Set<fs.FileHandle>(); let uncertain = false;
  const close = async (handle?: fs.FileHandle) => {
    if (!handle || !handles.has(handle)) return;
    handles.delete(handle); // A close with unknown completion must never be retried on a recycled descriptor.
    try { await handle.close(); } catch { uncertain = true; throw new CodingSeedCleanupError(); }
  };
  const open = async (location: string | Buffer, flags: number, mode?: number) => { const handle = await fs.open(location, flags, mode); handles.add(handle); return handle; };
  let base: fs.FileHandle | undefined, root: fs.FileHandle | undefined, baseInfo: BigIntStats | undefined, rootInfo: BigIntStats | undefined;
  let mounted = "", created = false, disposed: Promise<void> | null = null;
  const name = `ember-coding-seed-${randomUUID()}`, directory = path.join(basePath, name);
  const rootPath = () => `/proc/self/fd/${root!.fd}`;
  const privateDir = (info: BigIntStats) => info.isDirectory() && info.uid === BigInt(process.getuid!()) && (info.mode & 0o7077n) === 0n;
  const ownedCurrent = async (privateMode = false) => {
    if (uncertain || !base || !root || !baseInfo || !rootInfo) throw new CodingSeedCleanupError();
    const b = await base.stat({ bigint: true }), r = await root.stat({ bigint: true });
    if (!same(b, baseInfo) || !privateDir(b) || !same(r, rootInfo) || !r.isDirectory() || r.uid !== rootInfo.uid || privateMode && !privateDir(r) ||
        await mount(base) !== mounted || await mount(root) !== mounted || await fs.realpath(`/proc/self/fd/${base.fd}`) !== basePath ||
        await fs.realpath(rootPath()) !== directory || !same(await fs.lstat(`/proc/self/fd/${base.fd}/${name}`, { bigint: true }), rootInfo)) throw new CodingSeedCleanupError();
  };
  const guard = async () => { check(); await ownedCurrent(true); check(); };
  const removeChildren = async (parent: fs.FileHandle) => {
    if (await mount(parent) !== mounted) throw new CodingSeedCleanupError();
    const listing = await fs.opendir(`/proc/self/fd/${parent.fd}`, { encoding: "buffer" as BufferEncoding });
    for await (const item of listing) {
      const childPath = Buffer.concat([Buffer.from(`/proc/self/fd/${parent.fd}/`), item.name as unknown as Buffer]);
      const info = await fs.lstat(childPath, { bigint: true });
      if (info.isDirectory() && !info.isSymbolicLink()) {
        const child = await open(childPath, DIR);
        try {
          if (!same(await child.stat({ bigint: true }), info) || await mount(child) !== mounted) throw new CodingSeedCleanupError();
          await removeChildren(child);
          if (!same(await fs.lstat(childPath, { bigint: true }), info)) throw new CodingSeedCleanupError();
          await fs.rmdir(childPath);
        } finally { await close(child); }
      } else await fs.unlink(childPath); // unlink never follows a symbolic link or writes an external inode.
    }
  };
  const dispose = () => disposed ??= (async () => {
    let failed = false;
    try {
      if (created) { await ownedCurrent(); await removeChildren(root!); await ownedCurrent(); await fs.rmdir(`/proc/self/fd/${base!.fd}/${name}`); }
    } catch { failed = true; }
    const closing = await Promise.allSettled([...handles].map(close));
    if (failed || uncertain || closing.some(result => result.status === "rejected")) throw new CodingSeedCleanupError();
  })();
  try {
    check(); base = await open(basePath, DIR); check(); baseInfo = await base.stat({ bigint: true }); check();
    if (!privateDir(baseInfo) || await fs.realpath(`/proc/self/fd/${base.fd}`) !== basePath) throw new Error("The private coding seed base is unavailable.");
    mounted = await mount(base); check();
    await fs.mkdir(`/proc/self/fd/${base.fd}/${name}`, { mode: 0o700 }); created = true;
    root = await open(`/proc/self/fd/${base.fd}/${name}`, DIR); rootInfo = await root.stat({ bigint: true });
    if (!privateDir(rootInfo) || rootInfo.dev !== baseInfo.dev) throw new CodingSeedCleanupError();
    await guard();
    const directories = new Map<string, BigIntStats>([["", rootInfo]]), entries: CodingSnapshot["entries"] = [];
    const parentFor = async (relative: string) => {
      const parts = relative.split("/"); parts.pop(); let parent = root!, prefix = "";
      try {
        for (const part of parts) {
          prefix = prefix ? `${prefix}/${part}` : part;
          const child = await open(`/proc/self/fd/${parent.fd}/${part}`, DIR); const info = await child.stat({ bigint: true });
          if (!directories.has(prefix) || !same(info, directories.get(prefix)!) || !privateDir(info) || await mount(child) !== mounted) { await close(child); throw new CodingSeedCleanupError(); }
          if (parent !== root) await close(parent); parent = child; await guard();
        }
        return parent;
      } catch (error) { if (parent !== root) await close(parent); throw error; }
    };
    for (const entry of [...tree.entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      await guard(); const parent = await parentFor(entry.path), target = `/proc/self/fd/${parent.fd}/${path.basename(entry.path)}`;
      try {
        if (entry.kind === "directory") {
          await fs.mkdir(target, { mode: 0o700 }); await guard(); const child = await open(target, DIR);
          try { const info = await child.stat({ bigint: true }); if (!privateDir(info) || await mount(child) !== mounted) throw new CodingSeedCleanupError(); directories.set(entry.path, info); }
          finally { await close(child); }
        } else {
          const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, entry.executable ? 0o700 : 0o600);
          let written: BigIntStats;
          try { await guard(); await out.writeFile(entry.bytes); await guard(); await out.sync(); await guard(); written = await out.stat({ bigint: true }); await guard(); }
          finally { await close(out); }
          const read = await open(target, FILE);
          try {
            const before = await read.stat({ bigint: true }); await guard(); const bytes = await read.readFile(); await guard(); const after = await read.stat({ bigint: true });
            try { if (!before.isFile() || !same(before, written) || before.uid !== baseInfo.uid || before.nlink !== 1n || (before.mode & 0o777n) !== (entry.executable ? 0o700n : 0o600n) || before.size !== BigInt(entry.bytes.length) || !stable(before, after) || digest(bytes) !== digest(entry.bytes) || await mount(read) !== mounted) throw new CodingSeedCleanupError(); }
            finally { bytes.fill(0); }
            entries.push({ path: entry.path, size: entry.bytes.length, digest: digest(entry.bytes), executable: entry.executable });
          } finally { await close(read); }
        }
        await guard();
      } finally { if (parent !== root) await close(parent); }
    }
    await guard();
    return { directory, entries, directories: [...directories.keys()].filter(Boolean), excluded: excluded.map(item => ({ ...item })), dispose };
  } catch (error) {
    try { await dispose(); } catch { throw new CodingSeedCleanupError(); }
    throw error;
  }
}
