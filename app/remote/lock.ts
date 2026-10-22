/**
 * One agent at a time per remote user and machine (§5.3.10, critique remote-5): a lock file created with O_EXCL that
 * holds `<pid> <start time> <pcId>`. A lock whose process is gone (or is another process now: another start time) is
 * stale and replaced. A live agent with the same pcId is this PC's own previous agent still stopping after a blip: the
 * new one waits up to the command grace + 3 s, then sends it SIGTERM and takes the lock over (its runs are then swept
 * as orphans). A live agent of another PC refuses this one ("busy"). Pure over injected file and process access.
 */

import fs from "node:fs";
import type { Logger } from "../main/logger";

/** Who holds the lock. */
export interface LockHolder {
  pid: number;
  /** The process's start time as the OS tells it, with no white space (see processStart). */
  start: string;
  /** The PC whose agent it is (32 hex digits). */
  pcId: string;
}

/** What acquireLock needs of the machine. */
export interface LockIo {
  /** Creates `file` holding `text` only when nothing is there (O_EXCL, 0600); false when something is. */
  create(file: string, text: string): boolean;
  /** The file's text, or null when it can't be read (gone). */
  read(file: string): string | null;
  remove(file: string): void;
  /** A process's start time (processStart), or null when there is no such process. */
  startOf(pid: number): string | null;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The lock's text for a holder. */
export function lockText(h: LockHolder): string {
  return `${h.pid} ${h.start} ${h.pcId}\n`;
}

/** The holder a lock file names, or null when it isn't one. */
export function parseLock(text: string | null): LockHolder | null {
  if (!text) return null;
  const m = /^(\d{1,10}) (\S{1,64}) ([0-9a-f]{32})\n?$/.exec(text);
  if (!m) return null;
  const pid = Number(m[1]);
  return pid > 0 ? { pid, start: m[2], pcId: m[3] } : null;
}

/** acquireLock's answer: the lock (and whose stale agent it took over), or another PC's live agent holds it. */
export type LockResult =
  | { ok: true; release: () => void; tookOver: number | null }
  | { ok: false; holder: LockHolder };

/** How often a waiting agent looks again, and how long a SIGTERMed one gets to go. */
const POLL_MS = 250;
const TERM_WAIT_MS = 2000;
/** Rounds of "create failed, the holder went" before giving up (two agents racing for ever can't happen). */
const ROUNDS = 50;

/**
 * Takes the lock for `me`. Waits (up to `graceMs` + 3 s, then SIGTERM and up to 2 s more) for this PC's own previous
 * agent; refuses another PC's live agent. Throws only when the lock can't be made at all (its folder is gone).
 */
export async function acquireLock(o: { file: string; me: LockHolder; graceMs: number; io: LockIo; log: Logger }): Promise<LockResult> {
  const { file, me, io } = o;
  let tookOver: number | null = null;
  const alive = (h: LockHolder) => io.startOf(h.pid) === h.start;
  for (let round = 0; round < ROUNDS; round++) {
    if (io.create(file, lockText(me))) {
      const release = () => {
        // Only our own lock: a later agent may have taken it over meanwhile.
        if (parseLock(io.read(file))?.pid === me.pid) {
          try { io.remove(file); } catch { /* already gone */ }
        }
      };
      return { ok: true, release, tookOver };
    }
    const text = io.read(file);
    if (text === null) continue; // removed between the two calls: try again
    const holder = parseLock(text);
    if (!holder || holder.pid === me.pid || !alive(holder)) {
      o.log.info("remote.lock_stale", { pid: holder?.pid ?? null });
      io.remove(file);
      continue;
    }
    if (holder.pcId !== me.pcId) return { ok: false, holder };
    // This PC's own previous agent, still running its grace and exit: wait for it, then end it.
    o.log.info("remote.lock_wait", { pid: holder.pid });
    const deadline = io.now() + o.graceMs + 3000;
    while (alive(holder) && io.now() < deadline) await io.sleep(POLL_MS);
    if (alive(holder)) {
      o.log.warn("remote.lock_takeover", { pid: holder.pid });
      try { io.kill(holder.pid, "SIGTERM"); } catch { /* it went, or isn't ours: checked below */ }
      const end = io.now() + TERM_WAIT_MS;
      while (alive(holder) && io.now() < end) await io.sleep(POLL_MS);
      if (alive(holder)) {
        try { io.kill(holder.pid, "SIGKILL"); } catch { /* as above */ }
      }
      tookOver = holder.pid;
    }
    if (parseLock(io.read(file))?.pid === holder.pid) io.remove(file);
  }
  throw new Error("the agent's lock couldn't be taken");
}

/**
 * A process's start time, from what the OS reads (`stat`: Linux's /proc/<pid>/stat; `ps`: macOS's `ps -o lstart=`),
 * as one token: Linux's starttime field (clock ticks since boot), macOS's date with its spaces turned into "-". null
 * when there is no such process.
 */
export function processStart(os: "linux" | "darwin", pid: number, read: { stat(pid: number): string | null; ps(pid: number): string | null }): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (os === "linux") {
    const stat = read.stat(pid);
    if (!stat) return null;
    // The command name (field 2) may hold spaces and parentheses: the fields after its last ")" are fixed.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = rest[19]; // field 22 (starttime) is the 20th after the name
    return start && /^\d+$/.test(start) ? start : null;
  }
  const out = read.ps(pid)?.trim();
  return out ? out.replace(/\s+/g, "-") : null;
}

/** LockIo over the real file system (the folder exists: places.ts made it 0700). */
export function fileLockIo(startOf: (pid: number) => string | null): LockIo {
  return {
    create(file, text) {
      try {
        fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    },
    read(file) {
      try { return fs.readFileSync(file, "utf8"); } catch { return null; }
    },
    remove(file) {
      try { fs.unlinkSync(file); } catch { /* gone already */ }
    },
    startOf,
    kill: (pid, signal) => { process.kill(pid, signal); },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
