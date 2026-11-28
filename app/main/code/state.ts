/**
 * Where the coding runtime keeps its sessions (COPILOT_HOME: `session-state/<id>` with each session's plan, files,
 * checkpoints and event log, the session store's database, the runtime's logs, personal skills and instructions, MCP
 * configuration), and what one session's sandbox may reach of it (docs/CODING-APP.md §3 "Ember's data", §7).
 *
 * The constraint behind it, probed on runtime 1.0.97 with bubblewrap: the sandbox denies Ember's whole data folder,
 * and a path it grants (`readwritePaths`, or the runtime's own grant of a session's `files/` and plan) doesn't open
 * anything under a denied one, so with the state inside the data folder plan mode couldn't write its `plan.md`. So
 * the state lives in a folder of its own beside the data folder (the platform names it: `SystemPaths.codeState`),
 * and each session's sandbox denies, beside Ember's paths, every entry of that folder but `session-state`, and every
 * session's folder there but its own (`siblingDenials`). The runtime's own grants then give a session its own
 * plan and `files/`, and nothing of another session's, wherever the folder lies (also under a temporary folder,
 * which the sandbox grants every session whole). Fails closed: a folder that can't be read whole is denied whole.
 *
 * An earlier build kept the state in `<userData>/code/copilot`: it is moved once at start (`settleCodeState`), by a
 * rename where both lie on one filesystem, else by a copy of a renamed-aside original that is removed only once the
 * copy is in place; where the move fails the old folder stays in use (safe: the sandbox denies it whole, as before).
 * Plain Node; logs carry an error code at most, never a path.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Entries of the state folder listed for one session's sandbox at most; past it the folder is denied whole. */
export const SIBLINGS_MAX = 2_000;

type Log = { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };

/** The file operations the move uses (node:fs/promises; a fake in tests). */
export interface StateFs {
  rename(from: string, to: string): Promise<void>;
  cp(from: string, to: string, o: { recursive: true; errorOnExist: true; force: false; verbatimSymlinks: true; preserveTimestamps: true }): Promise<void>;
  rm(p: string, o: { recursive: true; force: true }): Promise<void>;
  mkdir(p: string, o: { recursive: true; mode: number }): Promise<unknown>;
  chmod(p: string, mode: number): Promise<void>;
  readdir(p: string): Promise<string[]>;
  lstat(p: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
}

const realFs: StateFs = {
  rename: (a, b) => fs.rename(a, b),
  cp: (a, b, o) => fs.cp(a, b, o),
  rm: (p, o) => fs.rm(p, o),
  mkdir: (p, o) => fs.mkdir(p, o),
  chmod: (p, m) => fs.chmod(p, m),
  readdir: p => fs.readdir(p),
  lstat: p => fs.lstat(p),
};

const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";

/** A private folder (0700), made with its parents. */
async function privateDir(f: StateFs, dir: string): Promise<void> {
  await f.mkdir(dir, { recursive: true, mode: 0o700 });
  await f.chmod(dir, 0o700);
}

/** Whether `p` is there: false only for ENOENT (any other failure is thrown, so the caller keeps what it had). */
async function there(f: StateFs, p: string): Promise<boolean> {
  try { await f.lstat(p); return true; } catch (err) { if (codeOf(err) === "ENOENT") return false; throw err; }
}

/**
 * Settles where the coding runtime's state is before the runtime starts: `wanted` (made 0700), after moving an
 * earlier build's `legacy` folder there once; `legacy` itself (or its renamed-aside copy) where the move couldn't be
 * made. Never leaves two folders in use: the one returned is the only one the runtime is given.
 */
export async function settleCodeState(o: { legacy: string; wanted: string; log?: Log; fs?: StateFs }): Promise<string> {
  const f = o.fs ?? realFs;
  const aside = `${o.legacy}.moving`;
  const partial = `${o.wanted}.partial`;
  try {
    await privateDir(f, path.dirname(o.wanted));
    // A copy cut short by a crash: the original is still whole aside.
    if (await there(f, aside)) {
      if (await there(f, o.wanted)) {
        // The copy was put in place; only the original's removal was left.
        await f.rm(aside, { recursive: true, force: true }).catch(() => undefined);
        await privateDir(f, o.wanted);
        return o.wanted;
      }
      return await copyAside(f, aside, o.legacy, o.wanted, partial, o.log);
    }
    if (!await there(f, o.legacy)) {
      await privateDir(f, o.wanted);
      return o.wanted;
    }
    if (await there(f, o.wanted)) {
      // An empty folder (made by a start that found nothing to move) gives way; one with sessions in it stays in use,
      // and the earlier folder is left as it is.
      const kept = await f.readdir(o.wanted);
      if (kept.length) {
        o.log?.warn("code.state_both", {});
        await privateDir(f, o.wanted);
        return o.wanted;
      }
      await f.rm(o.wanted, { recursive: true, force: true });
    }
    try {
      await f.rename(o.legacy, o.wanted);
      await privateDir(f, o.wanted);
      o.log?.info("code.state_moved", { how: "rename" });
      return o.wanted;
    } catch (err) {
      if (codeOf(err) !== "EXDEV") throw err;
    }
    // Another filesystem: the original is put aside first (a rename in its own folder), so the old place is never
    // in use beside the new one, and is removed only once the whole copy is in place.
    await f.rename(o.legacy, aside);
    return await copyAside(f, aside, o.legacy, o.wanted, partial, o.log);
  } catch (err) {
    o.log?.warn("code.state_not_moved", { code: codeOf(err) });
    // Where the state is now: the original, its aside copy where putting it back failed, the new folder where only a
    // step after the move failed; with none of them, the old place (inside the data folder: it works, denied whole).
    for (const p of [o.legacy, aside, o.wanted]) if (await there(f, p).catch(() => p === o.legacy)) return p;
    return o.legacy;
  }
}

/** Copies the aside original to `wanted` through `partial`, then removes it; on failure puts it back and uses it. */
async function copyAside(f: StateFs, aside: string, legacy: string, wanted: string, partial: string, log?: Log): Promise<string> {
  try {
    await f.rm(partial, { recursive: true, force: true });
    await f.cp(aside, partial, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
    await privateDir(f, partial);
    await f.rename(partial, wanted);
  } catch (err) {
    await f.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    log?.warn("code.state_not_moved", { code: codeOf(err) });
    try { await f.rename(aside, legacy); return legacy; } catch { return aside; /* still whole where it was put aside */ }
  }
  log?.info("code.state_moved", { how: "copy" });
  await f.rm(aside, { recursive: true, force: true }).catch(err => log?.warn("code.state_aside_left", { code: codeOf(err) }));
  return wanted;
}

/**
 * What a session's sandbox denies of the state folder `root` (each of `spellings`, the folder as named and as
 * resolved): every entry beside `session-state` (the session store, logs, skills, instructions, MCP configuration,
 * plugins) and every entry of `session-state` but `sessionId`'s own folder. The whole folder where it can't be read,
 * or holds more than SIBLINGS_MAX entries: the session then can't write its own plan, but reaches nothing else.
 */
export async function siblingDenials(spellings: readonly string[], sessionId: string, f: Pick<StateFs, "readdir"> = realFs): Promise<string[]> {
  const root = spellings[0];
  if (!root || !/^[A-Za-z0-9-]{1,200}$/.test(sessionId)) return [...spellings];
  try {
    const top = (await f.readdir(root)).filter(n => n !== "session-state");
    const sessions = (await f.readdir(path.join(root, "session-state")).catch(err => { if (codeOf(err) === "ENOENT") return [] as string[]; throw err; })).filter(n => n !== sessionId);
    if (top.length + sessions.length > SIBLINGS_MAX) return [...spellings];
    const out: string[] = [];
    for (const r of spellings) {
      for (const n of top) out.push(path.join(r, n));
      for (const n of sessions) out.push(path.join(r, "session-state", n));
    }
    return [...new Set(out)];
  } catch {
    return [...spellings];
  }
}
