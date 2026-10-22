/**
 * Real paths on this computer (§3.6, critique integration-26, L25; package RUN): for each path a command names, whether
 * it exists (lstat) and where it really is (realpath with the OS's own semantics: symlinks, Windows 8.3 short names,
 * junctions and subst drives resolved), so a link into ~/.ssh is judged as the secret path it leads to. A path that
 * doesn't exist gets the real path of its nearest existing parent plus the rest, and a dangling symlink the real path
 * of what it points to. Asynchronous (fs.promises.realpath has realpathSync.native's semantics), so a hung network
 * mount stalls a worker thread, never Ember's main thread; the flow bounds the wait. Never throws: what can't be told
 * is null. Paths follow the target's rules (node:path/posix or node:path/win32 by `os`).
 */

import fs from "node:fs";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import type { OS } from "../../../shared/shortcuts";
import type { PathFact } from "../types";

/** At most this many paths are inspected per call (Classification.probe holds at most 64). */
export const MAX_INSPECT = 64;
/** Symlinks followed by hand (dangling ones) before giving up, as the kernel's own limit. */
const MAX_LINKS = 40;

/** The file calls inspect makes (node:fs's promises by default; fakes in the tests). */
export interface InspectFs {
  /** Resolves when the path exists (without following a last symlink); rejects with an error carrying `code`. */
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>;
  /** The real path with the OS's own semantics; rejects when it can't be resolved. */
  realpath(p: string): Promise<string>;
  readlink(p: string): Promise<string>;
}

const NODE_FS: InspectFs = {
  lstat: p => fs.promises.lstat(p),
  realpath: p => fs.promises.realpath(p),
  readlink: p => fs.promises.readlink(p),
};

/** lstat's "not there" answers; anything else (EACCES, EIO) means "couldn't tell". */
const MISSING = new Set(["ENOENT", "ENOTDIR"]);

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/** For each path (relative ones joined to `cwd`): does it exist, and its real path. Never throws. */
export async function inspectPaths(paths: readonly string[], cwd: string, o: { os: OS; fs?: InspectFs }): Promise<PathFact[]> {
  const P = o.os === "win32" ? win32 : posix;
  const files = o.fs ?? NODE_FS;
  const unknown: PathFact = { exists: null, real: null };

  /** The real path of `p`, which may not exist; null when it can't be told. */
  const realOf = async (p: string, depth: number): Promise<string | null> => {
    if (depth > MAX_LINKS) return null;
    try {
      return await files.realpath(p);
    } catch {
      // not resolvable as a whole: missing, a dangling link, or not readable; told apart below
    }
    let link: boolean;
    try {
      link = (await files.lstat(p)).isSymbolicLink();
    } catch (err) {
      if (!MISSING.has(codeOf(err) ?? "")) return null;
      const parent = P.dirname(p);
      if (parent === p) return null;
      const real = await realOf(parent, depth + 1);
      return real === null ? null : P.join(real, P.basename(p));
    }
    if (!link) return null;
    try {
      const target = await files.readlink(p);
      return await realOf(P.isAbsolute(target) ? P.normalize(target) : P.join(P.dirname(p), target), depth + 1);
    } catch {
      return null;
    }
  };

  const one = async (raw: string): Promise<PathFact> => {
    if (typeof raw !== "string" || raw === "" || raw.includes("\0")) return unknown;
    let abs: string;
    if (P.isAbsolute(raw)) abs = P.normalize(raw);
    else if (P.isAbsolute(cwd)) abs = P.join(cwd, raw);
    else return unknown;
    let exists: boolean | null;
    try {
      await files.lstat(abs);
      exists = true;
    } catch (err) {
      exists = MISSING.has(codeOf(err) ?? "") ? false : null;
    }
    if (exists === null) return unknown;
    return { exists, real: await realOf(abs, 0).catch(() => null) };
  };

  try {
    return await Promise.all(paths.map((p, i) => (i < MAX_INSPECT ? one(p).catch(() => unknown) : Promise.resolve(unknown))));
  } catch {
    return paths.map(() => unknown);
  }
}
