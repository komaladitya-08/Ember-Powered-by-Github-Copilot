/**
 * Can Ember use its data folder? Checked when the single-instance lock is refused: Chromium can't take that lock in a
 * folder it can't write to either (owned by root after `sudo ember`, a read-only home, a file in its place, a full
 * disk), and that isn't another Ember running. Ember then says so and exits with 1 instead of quitting silently
 * (review #80). Plain Node, so it can be unit-tested.
 */

import fs from "node:fs";
import path from "node:path";

/** What the check uses of node:fs (tests pass fakes). */
export type DataFolderFs = Pick<typeof fs, "statSync" | "openSync" | "closeSync" | "rmSync">;

/**
 * Why Ember can't use `dir` as its data folder, in one plain sentence for the start-up dialog, or null when it can
 * (a probe file can be made in it and removed again).
 */
export function dataFolderProblem(dir: string, pid: number = process.pid, f: DataFolderFs = fs): string | null {
  let isDir: boolean;
  try {
    isDir = f.statSync(dir).isDirectory();
  } catch (err) {
    return cantWrite(dir, err);
  }
  if (!isDir) return `Ember can't use its data folder, ${dir}, because something that isn't a folder is in its place. Move it away, then start Ember again.`;
  const probe = path.join(dir, `.write-test-${pid}`);
  try {
    f.closeSync(f.openSync(probe, "w", 0o600));
  } catch (err) {
    return cantWrite(dir, err);
  }
  try { f.rmSync(probe, { force: true }); } catch { /* it could be made, so the folder can be written to */ }
  return null;
}

function cantWrite(dir: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return `Ember can't write to its data folder, ${dir}, because the disk is full. Free some space, then start Ember again.`;
  if (code === "EROFS") return `Ember can't write to its data folder, ${dir}, because it is on a disk that can only be read. Start Ember where your home folder can be written to.`;
  return `Ember can't write to its data folder, ${dir}. Make sure it belongs to you and that you can write to it (starting Ember with sudo can leave it owned by another user), then start Ember again.`;
}
