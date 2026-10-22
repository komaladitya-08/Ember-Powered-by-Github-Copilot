/**
 * The environment sweep (§3.13; package RUN): every process a run starts carries `EMBER_RUN_ID=<runId>` (§3.3), so
 * the kill ladder finds a run's stragglers by it even after they left its process group and session (`setsid`,
 * `nohup … &`). Linux reads `/proc/<pid>/environ`; macOS asks `ps -E`; a WSL distro (and anything else reached through
 * a shell) runs the fixed `sweepScript` fed on stdin. A process that clears its environment and leaves the session, or
 * runs as another user, can escape it (L10). Plain Node; the readers come in as parameters so the parsing is tested on
 * every OS.
 */

import type { OS } from "../../../shared/shortcuts";

/**
 * The in-distro / remote sweep (§3.13, critique wsl-18), fed on stdin to `/bin/sh -s -- <SIGNAL> <runId>` (never on an
 * argv): every process whose environment holds exactly `EMBER_RUN_ID=<runId>` gets `kill -<SIGNAL>`. The shell running
 * it must not carry that variable itself.
 */
export const sweepScript = 'for p in /proc/[0-9]*; do grep -qz "^EMBER_RUN_ID=$2\\$" "$p/environ" 2>/dev/null && kill -$1 "${p#/proc/}" 2>/dev/null; done\n';

/** A run id as RunSpec makes them: 16 lower-case hex digits. */
export const RUN_ID = /^[0-9a-f]{16}$/;

/** Whether a NUL-separated environment block (`/proc/<pid>/environ`) holds exactly `EMBER_RUN_ID=<runId>` as an entry. */
export function environHasRun(environ: Uint8Array, runId: string): boolean {
  const entry = Buffer.from(`EMBER_RUN_ID=${runId}`, "latin1");
  const buf = Buffer.from(environ.buffer, environ.byteOffset, environ.byteLength);
  for (let at = buf.indexOf(entry); at >= 0; at = buf.indexOf(entry, at + 1)) {
    const end = at + entry.length;
    if ((at === 0 || buf[at - 1] === 0) && (end === buf.length || buf[end] === 0)) return true;
  }
  return false;
}

/** One process the sweep found. */
export interface Swept { pid: number; name: string }

/**
 * The processes `ps -E -ww -U <uid> -o pid=,command=` lists with ` EMBER_RUN_ID=<runId>` among their environment (macOS
 * appends each process's environment to its command, space-separated). The name is the command's first word's base name.
 */
export function psEnvironmentPids(text: string, runId: string): Swept[] {
  const marker = new RegExp(`(?:^|\\s)EMBER_RUN_ID=${runId}(?:\\s|$)`);
  const out: Swept[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !marker.test(m[2])) continue;
    const first = m[2].split(/\s+/)[0] ?? "";
    out.push({ pid: Number(m[1]), name: first.slice(first.lastIndexOf("/") + 1) || first });
  }
  return out;
}

/** What the local sweep reads and does (fakes in the unit tests). */
export interface SweepDeps {
  os: OS;
  /** The user's id (macOS: `ps -U`). */
  uid: number;
  /** Pids never signalled (Ember's own process). */
  self: readonly number[];
  /** Linux: the names in /proc. */
  readdir(dir: string): Promise<string[]>;
  /** Linux: a /proc file's bytes. */
  readFile(file: string): Promise<Uint8Array>;
  /** macOS: runs `ps` to its end. */
  run(file: string, args: string[]): Promise<{ code: number | null; stdout: string }>;
  /** Sends a signal to one process (throws when it is gone or not ours). */
  kill(pid: number, signal: NodeJS.Signals): void;
}

/**
 * Finds every process of this user carrying the run's marker and, with a signal, sends it to each. Resolves the
 * processes found (with a signal: those that were signalled or still there), never rejects. Windows has no sweep: its
 * job object holds the whole tree (§3.13).
 */
export async function sweepLocal(runId: string, signal: NodeJS.Signals | null, deps: SweepDeps): Promise<Swept[]> {
  if (!RUN_ID.test(runId)) return [];
  let found: Swept[] = [];
  try {
    if (deps.os === "linux") found = await sweepProc(runId, deps);
    else if (deps.os === "darwin") {
      const r = await deps.run("/bin/ps", ["-E", "-ww", "-U", String(deps.uid), "-o", "pid=,command="]);
      found = psEnvironmentPids(r.stdout, runId);
    }
  } catch {
    return []; // the process list couldn't be read: nothing found this time
  }
  found = found.filter(p => Number.isInteger(p.pid) && p.pid > 1 && !deps.self.includes(p.pid));
  if (signal) {
    for (const p of found) {
      try {
        deps.kill(p.pid, signal);
      } catch {
        // already gone, or not ours to signal
      }
    }
  }
  return found;
}

/** Linux: every readable /proc/<pid>/environ holding the marker (another user's isn't readable). */
async function sweepProc(runId: string, deps: SweepDeps): Promise<Swept[]> {
  const pids = (await deps.readdir("/proc")).filter(n => /^\d+$/.test(n));
  const out: Swept[] = [];
  await Promise.all(pids.map(async name => {
    let environ: Uint8Array;
    try {
      environ = await deps.readFile(`/proc/${name}/environ`);
    } catch {
      return; // gone, or another user's
    }
    if (!environHasRun(environ, runId)) return;
    let comm = "";
    try {
      comm = Buffer.from(await deps.readFile(`/proc/${name}/comm`)).toString("utf8").trim();
    } catch {
      // gone since: named by its pid
    }
    out.push({ pid: Number(name), name: comm || name });
  }));
  return out.sort((a, b) => a.pid - b.pid);
}
