/** Guest-owned mutable dependency/cache mounts. Only a fresh opaque runtime can enable them; no host/source grant. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { issueIsolatedPublicNpmTools, type IsolatedPublicNpmToolsRef } from "./isolated-command-assets";
import { CodingArtifactCleanupError } from "./coding-artifact-store";
import { PublicNpmPlan, publicNpmPlanData, PublicNpmPreparationError, PUBLIC_NPM_LIMITS } from "./public-npm-lock";
import { verifyPublicNpmArchive } from "./public-npm-archive";

export class WslPublicDependencyCleanupError extends CodingArtifactCleanupError {}
type Identity = Pick<BigIntStats, "dev" | "ino">;
interface Runtime {
  root: string; cache: string; dependencies: string; identities: { root: Identity; cache: Identity; dependencies: Identity };
  anchor: fs.FileHandle; tools?: IsolatedPublicNpmToolsRef; closing?: Promise<void>; failure?: WslPublicDependencyCleanupError;
}
const issued = new WeakMap<object, Runtime>(), retained = new Set<Runtime>(), retainedHandles = new Set<fs.FileHandle>();
const bad = () => new PublicNpmPreparationError();
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
async function close(handle: fs.FileHandle, value: Runtime): Promise<void> {
  try { await handle.close(); }
  catch { retainedHandles.add(handle); value.failure ??= new WslPublicDependencyCleanupError(); retained.add(value); throw value.failure; }
}
function live(ref: WslPublicDependencyRuntime): Runtime {
  const value = issued.get(ref); if (!value || value.closing || value.failure) throw value?.failure ?? bad(); return value;
}
export function requireWslPublicDependencyRuntime(ref: WslPublicDependencyRuntime): void { live(ref); }

/** Construction alone does not mint authority; only create() registers a successfully pinned private tree. */
export class WslPublicDependencyRuntime {
  private constructor() { Object.freeze(this); }
  static async create(parent: string, signal: AbortSignal): Promise<WslPublicDependencyRuntime> {
    if (HOST_PLATFORM !== "linux" || HOST_ARCH !== "x64" || !process.getuid || process.getuid() <= 0 || !path.isAbsolute(parent)) throw bad();
    signal.throwIfAborted(); const p = await fs.lstat(parent);
    if (!p.isDirectory() || p.isSymbolicLink() || p.uid !== process.getuid() || (p.mode & 0o077) !== 0) throw bad();
    const root = await fs.mkdtemp(path.join(parent, "public-dependencies-")); await fs.chmod(root, 0o700);
    let anchor: fs.FileHandle | undefined, value: Runtime | undefined;
    try {
      signal.throwIfAborted(); anchor = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const cache = path.join(root, "cache"), dependencies = path.join(root, "node_modules");
      value = { root, cache, dependencies, anchor, identities: { root: { dev: -1n, ino: -1n }, cache: { dev: -1n, ino: -1n }, dependencies: { dev: -1n, ino: -1n } } };
      value.tools = issueIsolatedPublicNpmTools(); value.identities.root = await anchor.stat({ bigint: true });
      signal.throwIfAborted(); await fs.mkdir(cache, { mode: 0o700 }); await fs.mkdir(dependencies, { mode: 0o700 });
      value.identities.cache = await fs.lstat(cache, { bigint: true }); value.identities.dependencies = await fs.lstat(dependencies, { bigint: true });
      signal.throwIfAborted(); const ref = new WslPublicDependencyRuntime(); issued.set(ref, value); await ref.current(); return ref;
    } catch (error) {
      let failed = false; try { await fs.rm(root, { recursive: true, force: false }); } catch { failed = true; }
      if (anchor) try { if (value) await close(anchor, value); else await anchor.close(); } catch { retainedHandles.add(anchor); failed = true; }
      if (failed) {
        if (value) { value.failure ??= new WslPublicDependencyCleanupError(); retained.add(value); throw value.failure; }
        throw new WslPublicDependencyCleanupError();
      } throw error;
    }
  }
  /** Ordinary inode identities, not paths or JSON fields, bind both command mounts to this private runtime. */
  async current(): Promise<void> {
    const value = live(this);
    try {
      for (const key of ["root", "cache", "dependencies"] as const) {
        const info = await fs.lstat(value[key], { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid!()) || !same(info, value.identities[key]) ||
            key === "root" && (info.mode & 0o077n) !== 0n) throw bad();
      }
      if (!same(await value.anchor.stat({ bigint: true }), value.identities.root)) throw bad();
    } catch { value.failure ??= new WslPublicDependencyCleanupError(); retained.add(value); throw value.failure; }
  }
  paths(): Readonly<{ cache: string; dependencies: string; tools: IsolatedPublicNpmToolsRef }> {
    const value = live(this); if (!value.tools) throw bad(); return Object.freeze({ cache: value.cache, dependencies: value.dependencies, tools: value.tools });
  }
  /** Called only under the held engine file lease. Imported archives are data; npm scripts run later inside bwrap. */
  async importCache(plan: PublicNpmPlan, archives: readonly Buffer[], signal: AbortSignal, current: () => void): Promise<void> {
    const value = live(this), data = publicNpmPlanData(plan), check = () => { signal.throwIfAborted(); current(); };
    check(); await this.current(); check(); if (archives.length !== data.packages.length) throw bad();
    let expanded = 0, compressed = 0, entries = 0;
    for (let i = 0; i < archives.length; i++) {
      check(); if ((compressed += archives[i].length) > PUBLIC_NPM_LIMITS.compressedBytes) throw bad();
      const receipt = await verifyPublicNpmArchive(data.packages[i], archives[i], { signal, current: check, maximumExpandedBytes: PUBLIC_NPM_LIMITS.expandedBytes - expanded });
      expanded += receipt.expandedBytes; if ((entries += receipt.entries) > PUBLIC_NPM_LIMITS.entries) throw bad(); check();
    }
    // The private mount root is kept; no command writer exists while its content generation is replaced.
    for (const name of await fs.readdir(value.cache)) { check(); await fs.rm(path.join(value.cache, name), { recursive: true, force: false }); check(); }
    for (let i = 0; i < archives.length; i++) {
      check(); const hex = Buffer.from(data.packages[i].integrity.slice(7), "base64").toString("hex");
      const file = path.join(value.cache, "_cacache/content-v2/sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); check();
      const handle = await fs.open(file, "wx", 0o600);
      try {
        for (let offset = 0; offset < archives[i].length;) {
          check(); const n = (await handle.write(archives[i], offset, Math.min(64 * 1024, archives[i].length - offset), offset)).bytesWritten;
          if (n < 1) throw bad(); offset += n;
        }
        check(); await handle.sync(); check(); const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size !== archives[i].length) throw bad();
      } finally { await close(handle, value); }
      check();
    }
    await this.current(); check();
  }
  close(): Promise<void> {
    const value = issued.get(this); if (!value) return Promise.reject(bad());
    value.closing ??= (async () => {
      if (value.failure) throw value.failure;
      try {
        const named = await fs.lstat(value.root, { bigint: true });
        if (!named.isDirectory() || named.isSymbolicLink() || !same(named, value.identities.root) || !same(await value.anchor.stat({ bigint: true }), value.identities.root)) throw bad();
        await fs.rm(value.root, { recursive: true, force: false }); await close(value.anchor, value); retained.delete(value);
      } catch { value.failure ??= new WslPublicDependencyCleanupError(); retained.add(value); throw value.failure; }
    })(); return value.closing;
  }
}
