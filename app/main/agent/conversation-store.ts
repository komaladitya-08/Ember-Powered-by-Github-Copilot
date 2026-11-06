/**
 * The saved copy of Home's conversation, for the person who turned on "Keep my recent conversation" (settings
 * `keepConversation`, off by default): `conversation.json` in Ember's data folder, mode 0600, apart from the settings.
 *
 * It is for the person to read after Ember restarts. It is never model context (the conductor starts a fresh session
 * at every launch) and never replayed as live: the host marks restored lines inert.
 *
 * - The file is `{ version, account, savedAt, entries }`, bounded to CONVERSATION_LIMIT entries, the per-message text
 *   limit and MAX_BYTES in all; the oldest entries go first. Only the fields Home displays are kept.
 * - Writes are coalesced (one in flight, the last state wins) and atomic: a unique temp file, fsync, then rename.
 * - `clear()` bumps an epoch and deletes the file at once; a write begun or queued before it checks the epoch
 *   immediately before its rename and gives up, so a clear is never undone by a late write. It says whether everything
 *   went (false: a file could not be deleted; it is then emptied if that can be done, and never loaded again by this
 *   store, which retries the deletion first). A save that fails is reported too (`problem`), never only logged.
 * - A file that can't be read as this version, or is too large, is moved aside (`.broken`, replacing an older one) and
 *   logged without its content. A file of another account is deleted, never shown.
 */

import fs from "node:fs";
import path from "node:path";
import type { TranscriptEntry } from "./host";
import { CONVERSATION_LIMIT, CONVERSATION_TEXT_LIMIT } from "../../shared/conversation";

export const HISTORY_FILE = "conversation.json";
export const HISTORY_VERSION = 1;
/** The whole file's most, in UTF-8 bytes; older entries are dropped to fit. */
export const MAX_BYTES = 2 * 1024 * 1024;
/** How long a change waits for further ones before it is written (ms). */
export const SAVE_DELAY_MS = 400;

const WHO = new Set(["you", "ember", "task", "problem"]);

/** What is kept of a line: the fields Home shows, and `stopped` (an interrupted partial answer) if it is true. */
export type SavedEntry = Pick<TranscriptEntry, "t" | "who" | "text" | "truncated"> & { stopped?: true };

/** The file operations a write uses, replaceable in tests (a deferred write, a crash). */
export interface HistoryOps {
  /** Writes `data` to a new file `tmp` (mode 0600) and flushes it to disk. */
  write(tmp: string, data: string): Promise<void>;
  /** Flushes the folder `dir` so a rename into it survives a crash. Best effort: may throw where unsupported. */
  syncDir(dir: string): Promise<void>;
}

const realOps: HistoryOps = {
  async write(tmp, data) {
    const fd = await fs.promises.open(tmp, "w", 0o600);
    try {
      await fd.writeFile(data, "utf8");
      await fd.sync();
    } finally {
      await fd.close();
    }
  },
  async syncDir(dir) {
    const fd = await fs.promises.open(dir, "r");
    try { await fd.sync(); } finally { await fd.close(); }
  },
};

export interface HistoryStoreOptions {
  dir: string;
  log: { info(e: string, f?: object): void; warn(e: string, f?: object): void };
  ops?: HistoryOps;
  delayMs?: number;
  /** Told whenever `problem` changes (Home shows it beside the switch). */
  onProblem?: (problem: HistoryProblem | null) => void;
}

/** What is wrong with the saved copy: it could not be written, or it could not be deleted (the worse one). */
export type HistoryProblem = "save" | "delete";

/**
 * One saved line if it is valid, else null. Unknown fields are dropped, not trusted. Contract: a saved line NEVER carries a
 * per-run id (`answerId`, `heardId`, …): those restart at 1 on every launch, so a restored one would collide with a live row.
 */
export function savedEntry(raw: unknown): SavedEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.t !== "string" || e.t.length > 40 || Number.isNaN(Date.parse(e.t))) return null;
  if (typeof e.who !== "string" || !WHO.has(e.who)) return null;
  if (typeof e.text !== "string" || e.text.length > CONVERSATION_TEXT_LIMIT) return null;
  return {
    t: e.t, who: e.who as SavedEntry["who"], text: e.text,
    ...(e.truncated === true ? { truncated: true as const } : {}),
    ...(e.stopped === true ? { stopped: true as const } : {}),
  };
}

/** The entries to write: valid, the newest CONVERSATION_LIMIT, and the newest that fit MAX_BYTES. */
export function boundedEntries(entries: readonly unknown[]): SavedEntry[] {
  let kept = entries.map(savedEntry).filter((e): e is SavedEntry => !!e).slice(-CONVERSATION_LIMIT);
  // 1 KiB of slack covers the file's frame and each line's keys.
  const size = (list: SavedEntry[]) => Buffer.byteLength(JSON.stringify(list), "utf8") + 1024;
  while (kept.length && size(kept) > MAX_BYTES) kept = kept.slice(1);
  return kept;
}

export class HistoryStore {
  readonly file: string;
  private readonly ops: HistoryOps;
  private readonly delayMs: number;
  private epoch = 0;
  private pending: { account: string; entries: SavedEntry[] } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private seq = 0;
  /** A deletion failed and has not succeeded since: the saved copy must not be loaded, and every clear retries it. */
  private erasePending = false;
  private saveFailed = false;

  constructor(private readonly o: HistoryStoreOptions) {
    this.file = path.join(o.dir, HISTORY_FILE);
    this.ops = o.ops ?? realOps;
    this.delayMs = o.delayMs ?? SAVE_DELAY_MS;
  }

  /**
   * The saved lines of `account`, oldest first; none if there is no file, it isn't this account's (it is deleted), or it
   * can't be read (it is moved aside). Never throws. Also clears temp files an earlier crash left.
   */
  load(account: string): SavedEntry[] {
    // A deletion that failed is retried before anything is read: what should be gone is never shown.
    if (this.erasePending && !this.remove()) return [];
    this.tidyTemp();
    let raw: string;
    try {
      const size = fs.statSync(this.file).size;
      if (size > MAX_BYTES + 64 * 1024) return this.aside("too_large");
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.o.log.warn("history.unreadable", { code: (err as NodeJS.ErrnoException).code });
      return [];
    }
    let v: { version?: unknown; account?: unknown; entries?: unknown };
    try { v = JSON.parse(raw); } catch { return this.aside("not_json"); }
    if (!v || typeof v !== "object" || v.version !== HISTORY_VERSION || typeof v.account !== "string" || !Array.isArray(v.entries)) return this.aside("wrong_shape");
    if (v.account !== account) {
      // Another account's: never shown to this one, and not kept for it either.
      this.o.log.info("history.other_account_deleted");
      this.remove();
      return [];
    }
    return boundedEntries(v.entries);
  }

  /** Queues the saved copy to be this (the last call wins); written soon, and atomically. */
  save(account: string, entries: readonly unknown[]): void {
    this.pending = { account, entries: boundedEntries(entries) };
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.delayMs);
    this.timer.unref?.();
  }

  /**
   * Deletes the saved copy now, and makes any write begun or queued earlier give up. True when every file is gone; false
   * when one could not be deleted (the caller tells the person; this store won't load it meanwhile).
   */
  clear(): boolean {
    this.epoch++;
    this.pending = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return this.remove();
  }

  /** What is wrong now, or null. */
  get problem(): HistoryProblem | null {
    return this.erasePending ? "delete" : this.saveFailed ? "save" : null;
  }

  /** Resolves once everything queued is on disk (or given up): no timer, nothing pending, no write running. Quit waits for it. */
  async flush(): Promise<void> {
    for (;;) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.running) { await this.running; continue; }
      if (this.pending) { this.pump(); continue; }
      return;
    }
  }

  private setProblem(change: () => void): void {
    const before = this.problem;
    change();
    if (this.problem !== before) this.o.onProblem?.(this.problem);
  }

  private pump(): void {
    if (this.running || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    const epoch = this.epoch;
    const tmp = `${this.file}.tmp-${process.pid}-${++this.seq}`;
    const body = JSON.stringify({ version: HISTORY_VERSION, account: job.account, savedAt: new Date().toISOString(), entries: job.entries }) + "\n";
    this.running = (async () => {
      try {
        fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
        await this.ops.write(tmp, body);
        // Checked and renamed in the same turn: a clear can't fall between them.
        if (epoch === this.epoch) {
          fs.renameSync(tmp, this.file);
          // Best effort (Windows can't open a folder: EISDIR/EPERM): the data is already safe, only the name's durability is at stake.
          try { await this.ops.syncDir(this.o.dir); } catch { /* unsupported here, or the folder can't be flushed */ }
          this.setProblem(() => { this.saveFailed = false; });
        }
      } catch (err) {
        this.o.log.warn("history.not_saved", { code: (err as NodeJS.ErrnoException).code });
        if (epoch === this.epoch) this.setProblem(() => { this.saveFailed = true; });
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed or gone */ }
      }
    })().finally(() => {
      this.running = null;
      if (this.pending) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.delayMs);
    });
    this.running.catch(() => undefined);
  }

  /**
   * Every file of the saved conversation: the file, its temp files and a moved-aside one. A file that can't be deleted is
   * emptied if that can be done (a restart then finds nothing to show), and the failure is remembered and reported.
   */
  private remove(): boolean {
    let ok = true;
    for (const f of [this.file, `${this.file}.broken`, ...this.tempFiles()]) {
      try { fs.rmSync(f, { force: true }); } catch (err) {
        ok = false;
        this.o.log.warn("history.not_deleted", { code: (err as NodeJS.ErrnoException).code });
        try { fs.truncateSync(f, 0); } catch { /* neither deleted nor emptied: only this run's marker stands in the way */ }
      }
    }
    this.setProblem(() => { this.erasePending = !ok; if (ok) this.saveFailed = false; });
    return ok;
  }

  private tempFiles(): string[] {
    try {
      return fs.readdirSync(this.o.dir).filter(f => f.startsWith(`${HISTORY_FILE}.tmp-`)).map(f => path.join(this.o.dir, f));
    } catch { return []; }
  }

  private tidyTemp(): void {
    // (A write of this run in flight has its own temp file: leave it.)
    if (this.running) return;
    for (const f of this.tempFiles()) { try { fs.rmSync(f, { force: true }); } catch { /* left for the next start */ } }
  }

  private aside(why: string): SavedEntry[] {
    this.o.log.warn("history.moved_aside", { why });
    try { fs.renameSync(this.file, `${this.file}.broken`); }
    catch { try { fs.rmSync(this.file, { force: true }); } catch { /* nothing more to do */ } }
    return [];
  }
}
