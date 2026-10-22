/**
 * Real paths on this computer (§3.6, critique integration-26, L25; package RUN): for each path a command names, whether
 * it exists (lstat) and where it really is (realpath with the OS's own semantics: symlinks, Windows 8.3 short names,
 * junctions and subst drives resolved), so a link into ~/.ssh is judged as the secret path it leads to. A path that
 * doesn't exist gets the real path of its nearest existing parent plus the rest, and a dangling symlink the real path
 * of what it points to. Asynchronous (fs.promises.realpath has realpathSync.native's semantics), so a hung network
 * mount stalls a worker thread, never Ember's main thread; the flow bounds the wait. Never throws: what can't be told
 * is null. Windows UNC and device paths are never touched (a lookup there reaches another host). Paths follow the
 * target's rules (node:path/posix or node:path/win32 by `os`).
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
  /** Opens a file for reading its first bytes (readScript); rejects when it can't be opened. Absent: no script read. */
  open?(p: string): Promise<ScriptFile>;
}

/** A file open for reading a script's start (readScript). */
export interface ScriptFile {
  /** Its byte length and whether it is a regular file. */
  stat(): Promise<{ size: number; isFile(): boolean }>;
  /** Reads up to `n` bytes from the start into a buffer. */
  read(n: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

const NODE_FS: InspectFs = {
  lstat: p => fs.promises.lstat(p),
  realpath: p => fs.promises.realpath(p),
  readlink: p => fs.promises.readlink(p),
  open: async p => {
    const fh = await fs.promises.open(p, "r");
    return {
      stat: async () => fh.stat(),
      read: async n => { const buf = Buffer.alloc(n); const { bytesRead } = await fh.read(buf, 0, n, 0); return buf.subarray(0, bytesRead); },
      close: () => fh.close(),
    };
  },
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
    // A UNC or device path (\\host\share, \\?\, \\.\, //host) would make Windows open a connection to that host, and
    // hand it the user's sign-in (NTLM), before the user was asked anything: it is answered "can't tell", untouched.
    if (o.os === "win32" && /^[\\/]{2}/.test(abs)) return unknown;
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

/** At most this many bytes of a script are read and classified (L8, the lead's ruling: a 64 KiB cap). */
export const MAX_SCRIPT_BYTES = 64 * 1024;

/**
 * The text of a shell script Ember is about to run, so the classifier can judge what it does (L8, the lead's ruling):
 * the target's own filesystem, a regular file no larger than `maxBytes`, decoded as UTF-8. Never throws; null when the
 * path can't be read, is too big, isn't a regular file, or reaches another host (a UNC or device path on Windows).
 * Paths follow the target's rules; a relative one is joined to `cwd`.
 */
export async function readScriptText(path: string, cwd: string, o: { os: OS; maxBytes?: number; fs?: InspectFs }): Promise<string | null> {
  const P = o.os === "win32" ? win32 : posix;
  const files = o.fs ?? NODE_FS;
  const maxBytes = o.maxBytes ?? MAX_SCRIPT_BYTES;
  if (typeof path !== "string" || path === "" || path.includes("\0")) return null;
  let abs: string;
  if (P.isAbsolute(path)) abs = P.normalize(path);
  else if (P.isAbsolute(cwd)) abs = P.join(cwd, path);
  else return null;
  // A UNC or device path would open a connection to another host before the user was asked (as inspect avoids).
  if (o.os === "win32" && /^[\\/]{2}/.test(abs)) return null;
  if (!files.open) return null;
  let fh: ScriptFile | null = null;
  try {
    fh = await files.open(abs);
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const bytes = await fh.read(Math.min(st.size, maxBytes));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null; // missing, unreadable, or not a file: today's behaviour (L8) unchanged
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}
