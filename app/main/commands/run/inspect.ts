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
    // Never blocks on a FIFO (it would hold one of libuv's few threads until something writes to it) and never takes
    // a terminal as Ember's own: both are refused below as not regular files.
    const c = fs.constants;
    const fh = await fs.promises.open(p, c.O_RDONLY | (c.O_NONBLOCK ?? 0) | (c.O_NOCTTY ?? 0));
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

/**
 * `raw` made absolute as the OS will walk it: on Windows normalised (Win32 removes `..` lexically before any
 * filesystem sees a path); elsewhere joined to `cwd` with its `..` kept, since the kernel takes `x/..` as the folder
 * above where x really is (`sub/../t.sh` with sub a link is beside the link's target), and realpath and open both
 * walk it that way. Null when it can't be made absolute.
 */
function absolute(raw: string, cwd: string, os: OS): string | null {
  if (os === "win32") {
    if (win32.isAbsolute(raw)) return win32.normalize(raw);
    return win32.isAbsolute(cwd) ? win32.join(cwd, raw) : null;
  }
  if (raw.startsWith("/")) return raw;
  return cwd.startsWith("/") ? `${cwd.replace(/\/+$/, "")}/${raw}` : null;
}

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
      // A link's target is walked like any path: its `..` through links on a POSIX system.
      const next = absolute(target, P.dirname(p), o.os);
      return next === null ? null : await realOf(next, depth + 1);
    } catch {
      return null;
    }
  };

  const one = async (raw: string): Promise<PathFact> => {
    if (typeof raw !== "string" || raw === "" || raw.includes("\0")) return unknown;
    const abs = absolute(raw, cwd, o.os);
    if (abs === null) return unknown;
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
 * the target's own filesystem, a regular file no larger than `maxBytes` (decodeScript). Never throws; null when the
 * path can't be read, is too big, isn't a regular file, reaches another host (a UNC or device path on Windows) or is
 * a POSIX device or process file. Paths follow the target's rules; a relative one is joined to `cwd`.
 */
export async function readScriptText(path: string, cwd: string, o: { os: OS; maxBytes?: number; fs?: InspectFs }): Promise<string | null> {
  const P = o.os === "win32" ? win32 : posix;
  const files = o.fs ?? NODE_FS;
  const maxBytes = o.maxBytes ?? MAX_SCRIPT_BYTES;
  if (typeof path !== "string" || path === "" || path.includes("\0")) return null;
  // Opened by the name as the shell opens it: on a POSIX system `x/../t.sh` through x's real folder.
  const abs = absolute(path, cwd, o.os);
  if (abs === null) return null;
  // A UNC or device path would open a connection to another host before the user was asked (as inspect avoids); a
  // POSIX device or process file is a stream (and /proc/self, /dev/fd would be Ember's own), by its lexical form and,
  // when `..` may lead elsewhere through a link, its real one.
  if (o.os === "win32" && /^[\\/]{2}/.test(abs)) return null;
  const stream = (p: string) => /^\/(dev|proc)(\/|$)/.test(p);
  if (o.os !== "win32" && stream(P.normalize(abs))) return null;
  if (o.os !== "win32" && /(^|\/)\.\.(\/|$)/.test(abs)) {
    const real = await Promise.resolve().then(() => files.realpath(abs)).catch(() => null);
    if (real === null || stream(real)) return null;
  }
  if (!files.open) return null;
  let fh: ScriptFile | null = null;
  try {
    fh = await files.open(abs);
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const bytes = await fh.read(Math.min(st.size, maxBytes));
    return decodeScript(bytes);
  } catch {
    return null; // missing, unreadable, or not a file: today's behaviour (L8) unchanged
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

/**
 * A script's bytes as text, its byte order mark kept as U+FEFF (a POSIX shell doesn't skip one, so `#!` after it is
 * no `#!` line; the flow drops it for PowerShell, which does): UTF-16 with its mark, else UTF-8 (a bad byte becomes
 * U+FFFD and the bytes after it are kept, so the words and separators a shell sees stay the same).
 */
export function decodeScript(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
    for (let k = 0; k + 1 < bytes.length; k += 2) { swapped[k] = bytes[k + 1]; swapped[k + 1] = bytes[k]; }
    return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(swapped);
  }
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}
