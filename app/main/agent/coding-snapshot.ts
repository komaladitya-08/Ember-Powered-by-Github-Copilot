/**
 * A bounded, fresh-inode copy of a project for a future isolated coding runtime.
 *
 * This is not an isolation boundary, change reconciler, or production coding session. The caller must put the
 * *entire* runtime and its descendants in a verified filesystem/process boundary and must never expose the source
 * tree to it. Linux only: procfs fd-relative access and mount IDs are essential to this implementation.
 */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { HOST_PLATFORM } from "../platform/os";

export interface SnapshotLimits { files: number; bytes: number; fileBytes: number; depth: number }
export interface SnapshotEntry { path: string; size: number; digest: string; executable: boolean }
export interface CodingSnapshot { directory: string; entries: SnapshotEntry[]; directories: string[]; dispose(): Promise<void> }

const DEFAULT_LIMITS: SnapshotLimits = { files: 10_000, bytes: 100 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, depth: 64 };
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A mount ID distinguishes bind mounts even when their device numbers match. Missing procfs must fail closed. */
async function mountId(fd: number): Promise<string> {
  const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
  const id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!id) throw new Error("Cannot verify the project's filesystem boundary.");
  return id;
}

/** Byte names must round-trip through UTF-8; otherwise paths would refer to different files after copying. */
function nameOf(bytes: Buffer): string {
  const name = bytes.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(bytes) || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error("The project contains an unsupported filename.");
  }
  return name;
}

/** Identity plus metadata used to reject changes detected while copying. */
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * Copies a selected project to a new private directory. Links, mount crossings, special files, oversized projects,
 * and changes detected during the copy are rejected; no exclusions are silently applied. Source traversal is relative
 * to open directory handles, with O_NOFOLLOW on every child, and mount ID checks on every opened inode.
 *
 * The base directory must be owned by the current user and inaccessible to other Unix users; ACLs and other processes
 * of the same user are not isolated by these checks. A successful copy is not a transactional snapshot: concurrent
 * changes between independent reads, or privileged mutation of this process or procfs, are outside this primitive's
 * guarantees. Future copyback must independently
 * verify the original files and handle conflicts. No production code should enable coding on this result alone.
 */
export async function createCodingSnapshot(source: string, baseDir: string, protectedPaths: readonly string[], override: Partial<SnapshotLimits> = {}): Promise<CodingSnapshot> {
  if (HOST_PLATFORM !== "linux") throw new Error("Isolated project copies are not supported on this platform.");
  if (!path.isAbsolute(source) || !path.isAbsolute(baseDir) || !protectedPaths.length || protectedPaths.some(p => !path.isAbsolute(p))) {
    throw new Error("Choose absolute project, snapshot and protected paths.");
  }
  const limits = { ...DEFAULT_LIMITS, ...override };
  if (Object.values(limits).some(v => !Number.isSafeInteger(v) || v < 1)) throw new Error("Invalid project copy limits.");
  const base = await fs.realpath(baseDir);
  const baseStat = await fs.stat(base);
  if (!baseStat.isDirectory() || baseStat.uid !== process.getuid?.() || (baseStat.mode & 0o077) !== 0) {
    throw new Error("The snapshot directory must be private and owned by you.");
  }
  // The protected roots must already exist and resolve: treating an unverifiable root as absent is unsafe.
  const protectedRoots = await Promise.all(protectedPaths.map(async p => {
    const real = await fs.realpath(p);
    const stat = await fs.stat(real, { bigint: true });
    return { real, dev: stat.dev, ino: stat.ino };
  }));
  const checkProtected = async (handle: fs.FileHandle): Promise<void> => {
    const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    const stat = await handle.stat({ bigint: true });
    if (protectedRoots.some(p => {
      const rel = path.relative(p.real, actual);
      return (stat.dev === p.dev && stat.ino === p.ino) || !rel || (rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel));
    })) throw new Error("The project reaches Ember's protected data.");
  };
  const root = await fs.open(source, DIR);
  let directory: string | undefined;
  let disposed = false;
  try {
    const rootStat = await root.stat({ bigint: true });
    if (!rootStat.isDirectory()) throw new Error("Choose a project folder.");
    await checkProtected(root);
    const rootPath = await fs.realpath(`/proc/self/fd/${root.fd}`);
    const baseRelative = path.relative(rootPath, base);
    if (!baseRelative || (baseRelative !== ".." && !baseRelative.startsWith("../") && !path.isAbsolute(baseRelative))) {
      throw new Error("The snapshot directory must be outside the project.");
    }
    const rootMount = await mountId(root.fd);
    directory = await fs.mkdtemp(path.join(base, "ember-coding-snapshot-"));
    await fs.chmod(directory, 0o700);
    const entries: SnapshotEntry[] = [];
    const directories: string[] = [];
    let count = 0, bytes = 0;
    const walk = async (dir: fs.FileHandle, dest: string, prefix: string, depth: number): Promise<void> => {
      if (depth > limits.depth) throw new Error("The project is too deeply nested to copy.");
      const before = await dir.stat({ bigint: true });
      if (!before.isDirectory() || before.dev !== rootStat.dev || await mountId(dir.fd) !== rootMount) throw new Error("The project crosses a filesystem boundary.");
      await checkProtected(dir);
      // Node accepts "buffer" here at runtime, although @types/node omits it from this overload.
      const listing = await fs.opendir(`/proc/self/fd/${dir.fd}`, { encoding: "buffer" as BufferEncoding, bufferSize: 32 });
      for await (const item of listing) {
        if (++count > limits.files) throw new Error("The project has too many files or folders to copy.");
        const name = nameOf(item.name as unknown as Buffer);
        const relative = prefix ? `${prefix}/${name}` : name;
        const childPath = `/proc/self/fd/${dir.fd}/${name}`;
        // lstat identifies the type without following a link; the subsequent open still checks O_NOFOLLOW and fstat.
        const listed = await fs.lstat(childPath, { bigint: true });
        if (listed.isSymbolicLink()) throw new Error("The project contains a symbolic link; it cannot be copied safely.");
        if (listed.isDirectory()) {
          const child = await fs.open(childPath, DIR);
          try {
            const live = await child.stat({ bigint: true });
            if (!live.isDirectory() || live.dev !== listed.dev || live.ino !== listed.ino) throw new Error("The project changed while copying.");
            const target = path.join(dest, name);
            await fs.mkdir(target, { mode: 0o700 });
            directories.push(relative);
            await walk(child, target, relative, depth + 1);
          } finally { await child.close(); }
        } else if (listed.isFile()) {
          const child = await fs.open(childPath, FILE);
          try {
            const live = await child.stat({ bigint: true });
            if (!live.isFile() || live.dev !== listed.dev || live.ino !== listed.ino || live.nlink !== 1n) throw new Error("The project contains a linked or changed file.");
            if (live.dev !== rootStat.dev || await mountId(child.fd) !== rootMount) throw new Error("The project crosses a filesystem boundary.");
            await checkProtected(child);
            if (live.size < 0n || live.size > BigInt(limits.fileBytes) || live.size > BigInt(limits.bytes - bytes)) throw new Error("The project is too large to copy.");
            const size = Number(live.size);
            bytes += size;
            const target = await fs.open(path.join(dest, name), "wx", (live.mode & 0o111n) ? 0o700 : 0o600);
            const digest = crypto.createHash("sha256");
            try {
              const buf = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
              let offset = 0;
              while (offset < size) {
                const { bytesRead } = await child.read(buf, 0, Math.min(buf.length, size - offset), offset);
                if (!bytesRead) throw new Error("The project changed while copying.");
                digest.update(buf.subarray(0, bytesRead));
                let written = 0;
                while (written < bytesRead) {
                  const n = (await target.write(buf, written, bytesRead - written)).bytesWritten;
                  if (!n) throw new Error("Could not write the project copy.");
                  written += n;
                }
                offset += bytesRead;
              }
              if (!unchanged(live, await child.stat({ bigint: true }))) throw new Error("The project changed while copying.");
            } finally { await target.close(); }
            entries.push({ path: relative, size, digest: digest.digest("hex"), executable: !!(live.mode & 0o111n) });
          } finally { await child.close(); }
        } else throw new Error("The project contains a special file; it cannot be copied safely.");
      }
      if (!unchanged(before, await dir.stat({ bigint: true }))) throw new Error("The project changed while copying.");
    };
    await walk(root, directory, "", 0);
    const resultDir = directory;
    return { directory: resultDir, entries, directories, dispose: async () => {
      if (disposed) return;
      await fs.rm(resultDir, { recursive: true, force: true });
      disposed = true;
    } };
  } catch (err) {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    throw err;
  } finally { await root.close(); }
}
