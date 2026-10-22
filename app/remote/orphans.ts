/**
 * Run stamps and the orphan sweep (§3.13, critique remote-8). Every command run leaves `runs/<runId>` holding the
 * agent's pid and start time, removed when the run ends. An agent that died abnormally (SIGKILL, a crash, the machine's
 * OOM killer) leaves its stamps behind; the next agent kills every process still carrying such a run's
 * EMBER_RUN_ID (the environment sweep) before it serves, and after it takes a stale agent's lock over, and audits them
 * as `{ event: "stop", source: "orphan", runs }`. Runs of a live agent are never touched. Pure over injected I/O.
 */

import fs from "node:fs";
import path from "node:path/posix";

/** A run id: 16 lower-case hex digits (RunSpec.runId), the only names a stamp may have. */
export const RUN_ID = /^[0-9a-f]{16}$/;

/** A stamp's text: the agent that started the run. */
export function stampText(pid: number, start: string): string {
  return `${pid} ${start}\n`;
}

/** What the sweep needs of the machine. */
export interface OrphanIo {
  /** The names in the runs folder. */
  list(): string[];
  read(name: string): string | null;
  remove(name: string): void;
  /** A process's start time (lock.ts processStart), or null when there is no such process. */
  startOf(pid: number): string | null;
  /** The environment sweep for a run (contracts' sweepScript), with SIGKILL. */
  sweep(runId: string): Promise<void>;
}

/**
 * Sweeps every run whose agent is gone (or whose stamp can't be read) and removes its stamp; returns the swept run ids.
 * A stamp that isn't a run id's is removed unread (nothing of Ember's makes one).
 */
export async function sweepOrphans(io: OrphanIo): Promise<string[]> {
  const swept: string[] = [];
  for (const name of io.list()) {
    if (!RUN_ID.test(name)) {
      io.remove(name);
      continue;
    }
    const m = /^(\d{1,10}) (\S{1,64})\n?$/.exec(io.read(name) ?? "");
    if (m && io.startOf(Number(m[1])) === m[2]) continue; // its agent is alive: its own runs
    await io.sweep(name);
    io.remove(name);
    swept.push(name);
  }
  return swept;
}

/** OrphanIo and a run's stamp writer over the runs folder (made 0700 by the caller). */
export function stampFolder(dir: string, o: { startOf: (pid: number) => string | null; sweep: (runId: string) => Promise<void> }): OrphanIo & { write(runId: string, text: string): void } {
  const file = (name: string) => path.join(dir, name);
  return {
    list: () => {
      try { return fs.readdirSync(dir); } catch { return []; }
    },
    read: name => {
      try { return fs.readFileSync(file(name), "utf8"); } catch { return null; }
    },
    remove: name => {
      try { fs.rmSync(file(name), { force: true, recursive: true }); } catch { /* gone already */ }
    },
    write: (runId, text) => {
      if (!RUN_ID.test(runId)) throw new Error("not a run id");
      fs.writeFileSync(file(runId), text, { mode: 0o600 });
    },
    startOf: o.startOf,
    sweep: o.sweep,
  };
}
