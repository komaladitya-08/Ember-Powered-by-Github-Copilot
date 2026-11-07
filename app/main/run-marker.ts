/**
 * The run marker (rp-5): Ember writes `run.json` in its data folder as it starts and removes it as it quits, so a
 * start that finds one knows the last run ended unexpectedly (its main process crashed, was killed, or the computer
 * lost power). Before it, a crash of main left no trace: the log ended on an ordinary line and the next start said
 * nothing. It holds only the process id, when the run started and Ember's version: nothing the user said or saw.
 * Only the Ember that holds the single-instance lock reads or writes it (never `ember doctor`), so a marker it finds
 * can't be another Ember's. Every read and write fails quietly: it is a diagnostic, never a reason not to start.
 * Plain Node, so it loads without Electron.
 */

import fs from "node:fs";
import path from "node:path";

/** The marker's name in the data folder. */
export const RUN_FILE = "run.json";

/** What a run leaves while it runs. */
export interface RunRecord {
  pid: number;
  /** ISO time. */
  startedAt: string;
  version: string;
}

/** The marker the last run left, or null: it quit (or never ran), or the file can't be read as one. */
export function previousRun(dataDir: string): RunRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir, RUN_FILE), "utf8")) as Partial<RunRecord> | null;
    if (!r || typeof r !== "object") return null;
    if (!Number.isSafeInteger(r.pid) || typeof r.startedAt !== "string" || typeof r.version !== "string") return null;
    return { pid: r.pid as number, startedAt: r.startedAt.slice(0, 40), version: r.version.slice(0, 40) };
  } catch {
    // No marker (the last run quit), or one that can't be read: nothing to say.
    return null;
  }
}

/** This run starts: its marker replaces the last one, owner-only (0600), written whole. */
export function startRun(dataDir: string, run: { pid: number; version: string; now?: () => Date }): void {
  const file = path.join(dataDir, RUN_FILE);
  const tmp = `${file}.${run.pid}.tmp`;
  const record: RunRecord = { pid: run.pid, startedAt: (run.now?.() ?? new Date()).toISOString(), version: run.version };
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch {
    // A folder that can't be written is said elsewhere (the data folder's own check); the marker is only a diagnostic.
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to tidy */ }
  }
}

/** This run ends as it should (quit, or the session ending): its marker goes. */
export function endRun(dataDir: string): void {
  try {
    fs.rmSync(path.join(dataDir, RUN_FILE), { force: true });
  } catch {
    // (A folder in its place, say: the next start passes over what it can't read.)
  }
}
