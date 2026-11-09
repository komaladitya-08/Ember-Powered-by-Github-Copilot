/**
 * Can Ember use its data folder? Checked when the single-instance lock is refused: Chromium can't take that lock in a
 * folder it can't write to either (owned by root after `sudo ember`, a read-only home, a file in its place, a full
 * disk), and that isn't another Ember running. Ember then says so and exits with 1 instead of quitting silently
 * (review #80). A folder or file Ember makes in it at start that can't be made (a file where the audit folder goes)
 * is said in the same plain words (startupProblem), never as Node's own error text (reliability-performance-r4-1).
 * Plain Node, so it can be unit-tested.
 */

import fs from "node:fs";
import path from "node:path";
import type { OS } from "../shared/shortcuts";
import { ISSUES_URL } from "../shared/support";

/** What the check uses of node:fs (tests pass fakes). */
export type DataFolderFs = Pick<typeof fs, "statSync" | "openSync" | "closeSync" | "rmSync">;

/**
 * What may keep a person from writing to their own folder, by OS (`os`, the platform's: this module can't ask): `sudo`
 * on Linux and macOS, which leaves what it makes owned by root; on Windows, the folder's permissions or security
 * software, never sudo (reliability-performance-c5-2).
 */
const MAKE_WRITABLE: Record<OS, string> = {
  linux: "Make sure it belongs to you and that you can write to it (starting Ember with sudo can leave it owned by another user)",
  darwin: "Make sure it belongs to you and that you can write to it (starting Ember with sudo can leave it owned by another user)",
  win32: "Make sure you can write to it, and that security software isn't keeping Ember out of it",
};

/** What the start-up dialog says when starting again can't help and nothing names what is in the way (a damaged install, a bug). */
const WENT_WRONG = `Something went wrong while Ember was starting. Start Ember again. If it keeps happening, reinstall Ember, or report it at ${ISSUES_URL}.`;

/**
 * Why Ember can't use `dir` as its data folder, in one plain sentence for the start-up dialog, or null when it can
 * (a probe file can be made in it and removed again). `os`: whose words for a folder it can't write to.
 */
export function dataFolderProblem(dir: string, pid: number = process.pid, f: DataFolderFs = fs, os: OS = "linux"): string | null {
  let isDir: boolean;
  try {
    isDir = f.statSync(dir).isDirectory();
  } catch (err) {
    return cantWrite(dir, err, os);
  }
  if (!isDir) return `Ember can't use its data folder, ${dir}, because something that isn't a folder is in its place. Move it away, then start Ember again.`;
  const probe = path.join(dir, `.write-test-${pid}`);
  try {
    f.closeSync(f.openSync(probe, "w", 0o600));
  } catch (err) {
    return cantWrite(dir, err, os);
  }
  try { f.rmSync(probe, { force: true }); } catch { /* it could be made, so the folder can be written to */ }
  return null;
}

/** `inside`: the path in the data folder that couldn't be written, when it isn't the folder itself (named then). */
function cantWrite(dir: string, err: unknown, os: OS, inside?: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return `Ember can't write to its data folder, ${dir}, because the disk is full. Free some space, then start Ember again.`;
  if (code === "EROFS") return `Ember can't write to its data folder, ${dir}, because it is on a disk that can only be read. Start Ember where your home folder can be written to.`;
  const what = inside ? `${inside}, in its data folder` : `its data folder, ${dir}`;
  return `Ember can't write to ${what}. ${MAKE_WRITABLE[os]}, then start Ember again.`;
}

/** Codes of a path that couldn't be written, said as the data folder check says them (cantWrite). */
const CANT_WRITE: ReadonlySet<string> = new Set(["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM"]);

/** `p` is `dir` or lies inside it. */
function inFolder(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * What the start-up dialog says when starting failed with `err` (reliability-performance-r4-1), in one plain sentence:
 * an error making or writing something in the data folder `dir` (node:fs's, with its code and path) in the data
 * folder check's words, naming what is in the way; anything else as something that went wrong, with what to do when
 * starting again doesn't help. Never the error's own text (an errno code, a path in quotes, a bug's message): that
 * stays in the log. `os`: whose words for a folder it can't write to.
 */
export function startupProblem(err: unknown, dir: string, f: Pick<DataFolderFs, "statSync"> = fs, os: OS = "linux"): string {
  const e = err as NodeJS.ErrnoException | null;
  const code = typeof e?.code === "string" ? e.code : null;
  const where = typeof e?.path === "string" ? e.path : null;
  if (!(err instanceof Error) || !code || !where || !inFolder(dir, where)) return WENT_WRONG;
  if (code === "EEXIST" || code === "ENOTDIR") {
    // What isn't a folder: the path itself (EEXIST) or the nearest one above it that exists (ENOTDIR).
    let inWay = where;
    for (let p = where; inFolder(dir, p) && p !== path.dirname(p); p = path.dirname(p)) {
      try { if (!f.statSync(p).isDirectory()) inWay = p; } catch { /* not there: what is in the way is further up */ }
    }
    return `Ember can't use its data folder, ${dir}, because ${inWay} isn't a folder. Move it away, then start Ember again.`;
  }
  if (CANT_WRITE.has(code)) return cantWrite(dir, err, os, path.resolve(where) === path.resolve(dir) ? undefined : where);
  return `Ember couldn't use its data folder, ${dir}. Start Ember again.`;
}

/** The start-up dialog's words: what went wrong, and where the details are when the log could be written (`log`). */
export function startupDialogText(said: string, log: string | null): string {
  return log ? `${said}\n\nThe details are in ${log}.` : said;
}
