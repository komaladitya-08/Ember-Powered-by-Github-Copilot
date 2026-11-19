/** Fresh, bounded dependency inodes for a read-only command mount; source links never become runtime host links. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { HOST_PLATFORM } from "../platform/os";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { codingWorkspaceFilePathProblem, codingWorkspaceFileProblemAsync } from "./scoped-coding-files";
import { CodingPrivacyScanner, CodingPrivacyCleanupError, captureCodingPrivacyScope, assertCodingPrivacyScope, type CodingPrivacyScope } from "./coding-privacy-scanner";
import type { CodingWorkspace } from "./coding-workspace";
import type { CodingDependencyManifest } from "./coding-project-scope";

export interface CodingDependencySnapshot {
  directory: string;
  manifest: CodingDependencyManifest;
  current(): boolean;
  dispose(): Promise<void>;
}
export interface CodingDependencyLimits { entries: number; bytes: number; fileBytes: number; depth: number; links: number }
const LIMITS: CodingDependencyLimits = { entries: 50_000, bytes: 128 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, depth: 64, links: 1000 };
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const within = (file: string, root: string) => { const rel = path.relative(root, file); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)); };
const stable = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
async function closeHandles(handles: readonly Promise<unknown>[], unsafeCleanup?: CodingPrivacyCleanupError): Promise<void> {
  const closed = await Promise.allSettled(handles);
  if (unsafeCleanup) throw unsafeCleanup;
  const failed = closed.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

function name(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || !text || text !== text.normalize("NFC") || /[\\/:<>"|?*\p{Cc}\p{Cf}]/u.test(text) ||
      text === "." || text === ".." || /[. ]$/.test(text) || bytes.length > 255 || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(text)) throw new Error("The dependency tree contains an unsupported filename.");
  return text;
}
async function mount(fd: number): Promise<string> {
  const id = /^mnt_id:\s*(\d+)\s*$/m.exec(await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
  if (!id) throw new Error("The dependency mount boundary is unavailable."); return id;
}

/** Every input component is pinned without following a link, including the dependency grant's root. */
async function openDirectory(value: string): Promise<fs.FileHandle> {
  if (!path.isAbsolute(value) || value.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw new Error("Choose an ordinary absolute dependency folder.");
  let directory = await fs.open("/", DIR);
  try {
    for (const part of value.slice(1).split("/")) {
      const child = await fs.open(`/proc/self/fd/${directory.fd}/${part}`, DIR); await directory.close(); directory = child;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

/** Materialises only links whose final target is inside this separately granted tree, never outside it. */
export async function createCodingDependencySnapshot(input: {
  source: CodingWorkspace; baseDir: string; protectedPaths: readonly string[]; signal?: AbortSignal; limits?: Partial<CodingDependencyLimits>; privacyScope?: CodingPrivacyScope;
}): Promise<CodingDependencySnapshot> {
  if (HOST_PLATFORM !== "linux") throw new Error("Dependency snapshots require Linux.");
  const privacyScope = input.privacyScope ?? captureCodingPrivacyScope(), signal = input.signal;
  const sourceGrant = Object.freeze({ path: input.source.path, current: input.source.current.bind(input.source) });
  const current = () => { try { assertCodingPrivacyScope(privacyScope); return !signal?.aborted && sourceGrant.current() === true; } catch { return false; } };
  const check = () => { assertCodingPrivacyScope(privacyScope); if (!current()) throw new Error("The dependency grant is no longer current."); };
  check();
  const limits = { ...LIMITS, ...input.limits };
  if (Object.entries(limits).some(([key, value]) => !Object.hasOwn(LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key as keyof CodingDependencyLimits])) throw new Error("Invalid dependency snapshot limits.");
  if (!input.protectedPaths.length || !path.isAbsolute(input.baseDir) || input.protectedPaths.some(value => !path.isAbsolute(value))) throw new Error("Dependency copies require absolute private and protected paths.");
  const root = await openDirectory(sourceGrant.path);
  let directory: string | undefined, privacy: CodingPrivacyScanner | undefined, unsafeCleanup: CodingPrivacyCleanupError | undefined;
  try {
    privacy = new CodingPrivacyScanner({ signal, scope: privacyScope });
    check();
    const original = await root.stat({ bigint: true }), source = await fs.realpath(`/proc/self/fd/${root.fd}`), rootMount = await mount(root.fd);
    const base = await fs.realpath(input.baseDir), baseStat = await fs.stat(base, { bigint: true });
    if (!baseStat.isDirectory() || baseStat.uid !== BigInt(process.getuid!()) || (baseStat.mode & 0o7077n) !== 0n || within(source, base) || within(base, source) || identity(original, baseStat)) throw new Error("Dependencies and the private coding copy base must be outside one another.");
    const protectedRoots = await Promise.all(input.protectedPaths.map(async value => {
      const real = await fs.realpath(value), handle = await fs.open(real, FILE);
      try { const stat = await handle.stat({ bigint: true }); return { real: await fs.realpath(`/proc/self/fd/${handle.fd}`), stat, mount: await mount(handle.fd) }; }
      finally { await handle.close(); }
    }));
    const verify = async (file: fs.FileHandle, stat: BigIntStats) => {
      check(); const real = await fs.realpath(`/proc/self/fd/${file.fd}`);
      const mounted = await mount(file.fd);
      if (!within(real, source) || stat.dev !== original.dev || mounted !== rootMount || protectedRoots.some(protectedRoot => within(real, protectedRoot.real) ||
          (stat.dev === protectedRoot.stat.dev && (stat.ino === protectedRoot.stat.ino || mounted !== protectedRoot.mount)))) throw new Error("The dependency tree crosses a protected or mount boundary.");
      check();
    };
    await verify(root, original);
    directory = await fs.mkdtemp(path.join(base, "ember-coding-dependencies-")); await fs.chmod(directory, 0o700);
    const receipts: { path: string; kind: string; sha256?: string; executable?: boolean }[] = [], links: CodingDependencyManifest["materializedLinks"] = [];
    let entries = 0, bytes = 0, files = 0;
    const target = async (relative: string): Promise<fs.FileHandle> => {
      if (codingWorkspaceFilePathProblem(relative)) throw new Error("A dependency link reaches a credential-bearing path.");
      const parts = relative.split("/"); let parent = await fs.open(`/proc/self/fd/${root.fd}/.`, DIR);
      try {
        for (const part of parts.slice(0, -1)) {
          const next = await fs.open(`/proc/self/fd/${parent.fd}/${part}`, DIR); await parent.close(); parent = next;
          const stat = await parent.stat({ bigint: true }); await verify(parent, stat);
        }
        const where = `/proc/self/fd/${parent.fd}/${parts.at(-1)}`, listed = await fs.lstat(where, { bigint: true });
        if (!listed.isDirectory() && !listed.isFile()) throw new Error("A dependency link target changed or has an unsupported type.");
        const opened = await fs.open(where, listed.isDirectory() ? DIR : FILE);
        try { const actual = await opened.stat({ bigint: true }); if (!identity(actual, listed)) throw new Error("The dependency link target changed."); await verify(opened, actual); return opened; }
        catch (error) { await opened.close(); throw error; }
      } finally { await parent.close(); }
    };
    const copy = async (file: fs.FileHandle, relative: string, destination: string, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
      check();
      if (++entries > limits.entries || depth > limits.depth || Buffer.byteLength(relative) > 4096) throw new Error("The dependency tree exceeds its entry or depth limit.");
      const before = await file.stat({ bigint: true }); await verify(file, before);
      if (codingWorkspaceFilePathProblem(relative)) throw new Error("The dependency tree contains credential-bearing paths.");
      if (before.isDirectory()) {
        const key = `${before.dev}:${before.ino}`;
        if (ancestors.has(key)) throw new Error("The dependency tree contains a cyclic directory link.");
        const parents = new Set(ancestors); parents.add(key);
        if (relative) { await fs.mkdir(destination, { mode: 0o700 }); receipts.push({ path: relative, kind: "directory" }); }
        const listing = await fs.opendir(`/proc/self/fd/${file.fd}`, { encoding: "buffer" as BufferEncoding, bufferSize: 32 });
        for await (const entry of listing) {
          check(); const childName = name(entry.name as unknown as Buffer), childPath = relative ? `${relative}/${childName}` : childName;
          const where = `/proc/self/fd/${file.fd}/${childName}`, listed = await fs.lstat(where, { bigint: true });
          let child: fs.FileHandle;
          if (listed.isSymbolicLink()) {
            if (links.length >= limits.links) throw new Error("The dependency tree has too many links.");
            const resolved = await fs.realpath(where);
            if (!within(resolved, source) || resolved === source) throw new Error("The dependency tree contains an escaping or cyclic link.");
            const to = path.relative(source, resolved).split(path.sep).join("/");
            child = await target(to); links.push({ path: childPath, target: to });
            const after = await fs.lstat(where, { bigint: true });
            if (!stable(listed, after)) { await child.close(); throw new Error("A dependency link changed while copying."); }
          } else {
            if (!listed.isFile() && !listed.isDirectory()) throw new Error("The dependency tree contains a special file.");
            child = await fs.open(where, listed.isDirectory() ? DIR : FILE);
            const opened = await child.stat({ bigint: true });
            if (!identity(listed, opened)) { await child.close(); throw new Error("The dependency tree changed while copying."); }
          }
          try { await copy(child, childPath, path.join(destination, childName), depth + 1, parents); }
          finally { await child.close(); }
          await yieldToLoop(); check();
        }
      } else if (before.isFile()) {
        if (before.nlink !== 1n || before.size < 0n || before.size > BigInt(limits.fileBytes) || before.size > BigInt(limits.bytes - bytes)) throw new Error("The dependency tree contains a hardlinked or oversized file.");
        const content = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < content.length) {
          check(); const read = await file.read(content, offset, content.length - offset, offset);
          if (!read.bytesRead) throw new Error("A dependency file shrank while copying."); offset += read.bytesRead;
        }
        const extra = await file.read(Buffer.alloc(1), 0, 1, content.length); check();
        if (extra.bytesRead) throw new Error("The dependency tree changed while copying.");
        const problem = await codingWorkspaceFileProblemAsync(relative, content, privacy!, { signal, current });
        check();
        if (problem) throw new Error("The dependency tree contains secret text.");
        if (!stable(before, await file.stat({ bigint: true }))) throw new Error("The dependency tree changed while copying.");
        check();
        bytes += content.length; files++;
        await fs.writeFile(destination, content, { flag: "wx", mode: (before.mode & 0o111n) ? 0o700 : 0o600 });
        check();
        receipts.push({ path: relative, kind: "file", sha256: createHash("sha256").update(content).digest("hex"), executable: (before.mode & 0o111n) !== 0n });
      } else throw new Error("The dependency tree contains an unsupported link target.");
      if (!stable(before, await file.stat({ bigint: true }))) throw new Error("The dependency tree changed while copying.");
      check();
    };
    await copy(root, "", directory, 0, new Set());
    const selected = await fs.lstat(sourceGrant.path, { bigint: true }), liveBase = await fs.lstat(base, { bigint: true });
    if (!selected.isDirectory() || !identity(selected, original) || !identity(liveBase, baseStat)) throw new Error("The dependency or private coding root changed.");
    check();
    receipts.sort((a, b) => a.path.localeCompare(b.path)); links.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: CodingDependencyManifest = { access: "copied-read-only", mount: "/work/node_modules", files, bytes,
      sha256: createHash("sha256").update(JSON.stringify(receipts)).digest("hex"), materializedLinks: links };
    await privacy.close(); check();
    const result = directory, outputIdentity = await fs.lstat(result, { bigint: true }); let disposed = false;
    check();
    return { directory: result, manifest, current, dispose: async () => {
      if (disposed) return;
      const live = await fs.lstat(result, { bigint: true });
      if (!live.isDirectory() || !identity(live, outputIdentity)) throw new Error("The private dependency copy changed before cleanup.");
      await fs.rm(result, { recursive: true, force: true }); disposed = true;
    } };
  } catch (error) {
    if (error instanceof CodingPrivacyCleanupError) unsafeCleanup = error;
    let privacyFailure: unknown;
    try { await privacy?.close(); } catch (failure) { privacyFailure = failure; if (failure instanceof CodingPrivacyCleanupError) unsafeCleanup = failure; }
    const cleaned = await Promise.allSettled([directory ? fs.rm(directory, { recursive: true, force: true }) : Promise.resolve()]);
    if (unsafeCleanup) throw unsafeCleanup;
    const failed = cleaned.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    if (privacyFailure) throw privacyFailure; throw error;
  }
  finally {
    await closeHandles([root.close()], unsafeCleanup);
  }
}
