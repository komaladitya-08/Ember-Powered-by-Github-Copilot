/**
 * Clean-up after a successful serve start (§5.2.6), under the agent's single-instance lock: this machine notes that it
 * uses its parts and runtime (`last-used-<machine>` in each folder), then deletes every other version and runtime that
 * no machine sharing this home has used for 30 days (each `last-used-*` stamp older than that; a folder without one
 * counts from its own time, so a fresh install is never taken), and leftover `staging-*` folders and an
 * `install.lock` older than a day (a bootstrap that died mid-install). Nothing outside the data folder is touched; links
 * are never followed; removal is asynchronous, so a large runtime never stalls the main loop (the watchdog would end
 * the agent after 2 s). If this machine's stamps can't be written, nothing is deleted. Pure over injected I/O.
 */

import fs from "node:fs";
import path from "node:path/posix";
import type { Logger } from "../main/logger";

/** A version or runtime nobody has used for this long is deleted. */
export const UNUSED_MS = 30 * 86_400_000;
/** A staging folder or install lock this old is a dead install's. */
export const LEFTOVER_MS = 86_400_000;

/** A version's or a runtime's folder name (as the bootstrap makes them). */
const ID = /^[A-Za-z0-9._+-]{1,80}$/;
/** One machine's stamp (places.ts machineKey). */
const STAMP = /^last-used-[0-9a-f]{16}$/;

/** What the clean-up reads and changes. */
export interface CleanupIo {
  /** The names in a folder ([] when it can't be read). */
  list(dir: string): string[];
  /** lstat's facts (a folder that isn't a link, and its modification time), or null when it isn't there. */
  stat(p: string): { dir: boolean; mtimeMs: number } | null;
  /** Creates the empty stamp file, or freshens its time. Throws when it can't. */
  touch(p: string): void;
  /** Removes a folder and everything in it, never following a link. */
  remove(p: string): Promise<void>;
}

/** The runtime this agent runs on (`<data>/runtime/<id>/bin/node`), or null when it isn't one of the data folder's. */
export function runtimeIdOf(execPath: string, data: string, io: Pick<CleanupIo, "stat">): string | null {
  const m = /\/runtime\/([^/]+)\/bin\/node$/.exec(execPath);
  if (!m || !ID.test(m[1])) return null;
  return io.stat(path.join(data, "runtime", m[1]))?.dir ? m[1] : null;
}

/**
 * Notes this machine's use and deletes what nobody uses any more; returns what it deleted ("versions/<id>",
 * "runtime/<id>", "staging-…", "install.lock"). `runtimeId` null: runtimes are left alone (the one in use is unknown).
 */
export async function cleanUp(o: { data: string; machine: string; partsId: string; runtimeId: string | null; now: number; io: CleanupIo; log: Logger }): Promise<string[]> {
  const { io, data } = o;
  if (!/^[0-9a-f]{16}$/.test(o.machine) || !ID.test(o.partsId)) return [];
  const stamp = `last-used-${o.machine}`;
  try {
    io.touch(path.join(data, "versions", o.partsId, stamp));
    if (o.runtimeId) io.touch(path.join(data, "runtime", o.runtimeId, stamp));
  } catch (err) {
    o.log.warn("remote.cleanup_stamp_failed", { err });
    return [];
  }
  const removed: string[] = [];
  const take = async (rel: string) => {
    try {
      await io.remove(path.join(data, rel));
      removed.push(rel);
    } catch (err) {
      o.log.warn("remote.cleanup_failed", { what: rel, err });
    }
  };
  const kinds: { kind: "versions" | "runtime"; keep: string }[] = [{ kind: "versions", keep: o.partsId }];
  if (o.runtimeId) kinds.push({ kind: "runtime", keep: o.runtimeId });
  for (const { kind, keep } of kinds) {
    for (const name of io.list(path.join(data, kind))) {
      if (name === keep || !ID.test(name)) continue;
      const dir = path.join(data, kind, name);
      const st = io.stat(dir);
      if (!st?.dir) continue;
      const stamps = io.list(dir).filter(n => STAMP.test(n)).map(n => io.stat(path.join(dir, n))?.mtimeMs ?? null);
      const times = stamps.length ? stamps : [st.mtimeMs];
      // A time that can't be read counts as now: kept.
      if (times.every(t => t !== null && o.now - t > UNUSED_MS)) await take(`${kind}/${name}`);
    }
  }
  for (const name of io.list(data)) {
    if (!(/^staging-[A-Za-z0-9._-]{1,64}$/.test(name) || name === "install.lock")) continue;
    const st = io.stat(path.join(data, name));
    if (st?.dir && o.now - st.mtimeMs > LEFTOVER_MS) await take(name);
  }
  if (removed.length) o.log.info("remote.cleanup", { removed });
  return removed;
}

/** CleanupIo over the real file system. */
export const REAL_CLEANUP_IO: CleanupIo = {
  list(dir) {
    try { return fs.readdirSync(dir); } catch { return []; }
  },
  stat(p) {
    try {
      const st = fs.lstatSync(p);
      return { dir: st.isDirectory(), mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
  touch(p) {
    const now = new Date();
    try {
      fs.utimesSync(p, now, now);
    } catch {
      fs.writeFileSync(p, "", { mode: 0o600 });
    }
  },
  remove: p => fs.promises.rm(p, { recursive: true, force: true }),
};
