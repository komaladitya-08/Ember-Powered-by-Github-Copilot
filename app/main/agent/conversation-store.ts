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
 *   `flushNow()` writes the latest state synchronously when the desktop session ends and there is no time to wait; a
 *   write still in flight then gives up at its rename, so it can't put an older state back.
 * - `clear()` bumps an epoch and deletes the file at once; a write begun or queued before it checks the epoch
 *   immediately before its rename and gives up, so a clear is never undone by a late write. It says whether everything
 *   went (false: a file could not be deleted; it is then emptied if that can be done, and never loaded again by this
 *   store, which retries the deletion first). A save that fails is reported too (`problem`), never only logged.
 * - A clear must stick across a restart. Every file carries the generation `gen` it was saved under. Before a clear
 *   deletes anything it writes `conversation.erased` (`{ version, gen }`, temp + fsync + atomic rename, 0600): a later
 *   generation than any file it voids. Every load honours it first: a file with a lower `gen` (or none) is never shown, is
 *   deleted again, and the marker goes only once nothing is left (or a newer save, written under the marker's `gen`,
 *   superseded the file). When the marker itself can't be written and the file can't be deleted, the problem says so
 *   ("exposed"), never "it won't show again".
 * - A file that can't be read as this version, or is too large, is moved aside (`.broken`, replacing an older one) and
 *   logged without its content. A file of another account is deleted, never shown.
 */

import fs from "node:fs";
import path from "node:path";
import type { TranscriptEntry } from "./host";
import { CONVERSATION_LIMIT, CONVERSATION_TEXT_LIMIT } from "../../shared/conversation";

export const HISTORY_FILE = "conversation.json";
export const HISTORY_VERSION = 1;
/** The tombstone of a clear (see the module doc): every saved file of a lower generation is void. */
export const ERASED_FILE = "conversation.erased";
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

/**
 * What is wrong with the saved copy, the worst first: "exposed" (it could not be deleted and could not be hidden either, so
 * it may come back), "delete" (it could not be deleted, but a marker keeps it hidden), "save" (it could not be written),
 * "owner" (history is on but which model service key it belongs to can't be told, so nothing is saved), "account" (the same, for
 * a GitHub account that couldn't be confirmed), "unchecked" (the record of an earlier clear can't be read, so the saved copy
 * isn't shown until it can be).
 */
export type HistoryProblem = "exposed" | "delete" | "unchecked" | "save" | "owner" | "account";

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
  /** The job the write in flight is writing, until it is on disk or given up (flushNow writes it if nothing is newer). */
  private inflight: { account: string; entries: SavedEntry[] } | null = null;
  private seq = 0;
  /** A deletion failed and has not succeeded since: the saved copy must not be loaded, and every clear retries it. */
  private erasePending = false;
  /** A deletion failed and the marker could not be written either. */
  private exposed = false;
  private saveFailed = false;
  private ownerUnknown: "owner" | "account" | null = null;
  /** The marker exists but couldn't be read (anything but ENOENT): whether an earlier clear voided the file can't be told. */
  private markerUnreadable = false;
  /** The generation files are saved under: at least the marker's (and the last file's) as far as this store has seen. */
  private gen = 0;

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
    if ((this.erasePending || this.exposed) && !this.eraseAll(false)) return [];
    const read = this.readMarker();
    // Only a missing marker means no clear is on record. One that can't be read is refused until it can (retried at the next load).
    this.setProblem(() => { this.markerUnreadable = read.state === "unreadable"; });
    if (read.state === "unreadable") return [];
    const marker = read.state === "gen" ? read.gen : null;
    if (marker !== null) this.gen = Math.max(this.gen, marker);
    this.tidyTemp();
    let raw: string;
    try {
      const size = fs.statSync(this.file).size;
      if (size > MAX_BYTES + 64 * 1024) return this.aside("too_large");
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.o.log.warn("history.unreadable", { code: (err as NodeJS.ErrnoException).code });
      else if (marker !== null) this.eraseAll(false); // nothing left to hide: the marker (and any temp or aside copy) goes
      return [];
    }
    let v: { version?: unknown; account?: unknown; entries?: unknown; gen?: unknown };
    try { v = JSON.parse(raw); } catch { return this.aside("not_json"); }
    if (!v || typeof v !== "object" || v.version !== HISTORY_VERSION || typeof v.account !== "string" || !Array.isArray(v.entries)) return this.aside("wrong_shape");
    const fileGen = typeof v.gen === "number" && Number.isSafeInteger(v.gen) && v.gen >= 0 ? v.gen : 0;
    if (marker !== null) {
      if (fileGen < marker || typeof v.gen !== "number") {
        // Saved before a clear whose deletion failed: void. Deleted again; the marker stays until that works.
        this.o.log.info("history.erased_copy_hidden");
        this.eraseAll(false);
        return [];
      }
      // Saved after the clear: the marker has done its work.
      this.dropMarker();
    }
    this.gen = Math.max(this.gen, fileGen);
    if (v.account !== account) {
      // Another account's: never shown to this one, and not kept for it either.
      this.o.log.info("history.other_account_deleted");
      this.eraseAll(true);
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
    this.inflight = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return this.eraseAll(true);
  }

  /** Whether the owner of the live conversation is known (history is on and nothing can be saved without one: "owner"). */
  setOwnerKnown(known: boolean, kind: "owner" | "account" = "owner"): void {
    this.setProblem(() => { this.ownerUnknown = known ? null : kind; });
  }

  /** What is wrong now, or null. */
  get problem(): HistoryProblem | null {
    return this.exposed ? "exposed" : this.erasePending ? "delete" : this.markerUnreadable ? "unchecked" : this.saveFailed ? "save" : this.ownerUnknown;
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

  /**
   * Writes the latest state now, synchronously (temp file, fsync, rename), for the end of the desktop session: there may
   * be no will-quit and no turn of the event loop left. A write begun earlier gives up at its rename (the epoch moves),
   * so it can't replace this one with an older state. Never throws; a failure is logged and reported as `problem`.
   */
  flushNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const job = this.pending ?? this.inflight;
    this.pending = null;
    if (!job) return;
    this.epoch++;
    this.inflight = null;
    const tmp = `${this.file}.tmp-${process.pid}-${++this.seq}`;
    this.gen = Math.max(this.gen, this.markerGen() ?? 0);
    const body = JSON.stringify({ version: HISTORY_VERSION, account: job.account, gen: this.gen, savedAt: new Date().toISOString(), entries: job.entries }) + "\n";
    try {
      fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeFileSync(fd, body, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      try { const d = fs.openSync(this.o.dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* unsupported here (Windows): the data is already safe */ }
      const replaced = this.erasePending || this.exposed;
      if (replaced) this.dropMarker();
      this.setProblem(() => { this.saveFailed = false; if (replaced) { this.erasePending = false; this.exposed = false; } });
    } catch (err) {
      this.o.log.warn("history.not_saved", { code: (err as NodeJS.ErrnoException).code });
      this.setProblem(() => { this.saveFailed = true; });
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed or gone */ }
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
    this.inflight = job;
    const epoch = this.epoch;
    const tmp = `${this.file}.tmp-${process.pid}-${++this.seq}`;
    // Under at least the marker's generation (a save after a clear supersedes the marker), never under a lower one.
    this.gen = Math.max(this.gen, this.markerGen() ?? 0);
    const body = JSON.stringify({ version: HISTORY_VERSION, account: job.account, gen: this.gen, savedAt: new Date().toISOString(), entries: job.entries }) + "\n";
    this.running = (async () => {
      try {
        fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
        await this.ops.write(tmp, body);
        // Checked and renamed in the same turn: a clear can't fall between them.
        if (epoch === this.epoch) {
          fs.renameSync(tmp, this.file);
          // Best effort (Windows can't open a folder: EISDIR/EPERM): the data is already safe, only the name's durability is at stake.
          try { await this.ops.syncDir(this.o.dir); } catch { /* unsupported here, or the folder can't be flushed */ }
          // A clear during that wait voids this file (its generation is below the new marker's): it neither removes that
          // marker nor changes the clear's problem.
          if (epoch !== this.epoch) return;
          // The new file replaced the old one that couldn't be deleted: it is of a generation the marker doesn't void.
          const replaced = this.erasePending || this.exposed;
          if (replaced) this.dropMarker();
          this.setProblem(() => { this.saveFailed = false; if (replaced) { this.erasePending = false; this.exposed = false; } });
        }
      } catch (err) {
        this.o.log.warn("history.not_saved", { code: (err as NodeJS.ErrnoException).code });
        if (epoch === this.epoch) this.setProblem(() => { this.saveFailed = true; });
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed or gone */ }
      }
    })().finally(() => {
      this.running = null;
      if (this.inflight === job) this.inflight = null;
      if (this.pending) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.delayMs);
    });
    this.running.catch(() => undefined);
  }

  /**
   * Erases with a durable record: `bump`, a new clear, first writes the marker of a generation above every file this store
   * knows (before anything is deleted, so a crash or a failure afterwards still hides the old copy); then deletes. The marker
   * is removed only when everything is gone. Returns whether everything went.
   */
  private eraseAll(bump: boolean): boolean {
    let marked = this.markerGen() !== null;
    if (bump) {
      this.gen = Math.max(this.gen, this.markerGen() ?? 0, this.fileGen()) + 1;
      marked = this.writeMarker(this.gen);
    }
    const ok = this.remove();
    if (ok) this.dropMarker();
    this.setProblem(() => { this.erasePending = !ok; this.exposed = !ok && !marked; if (ok) this.saveFailed = false; if (ok || (bump && marked)) this.markerUnreadable = false; });
    return ok;
  }

  /** The generation the marker records, or null when there is none (an unreadable marker counts as generation 0 and hides everything). */
  private markerGen(): number | null {
    const r = this.readMarker();
    return r.state === "gen" ? r.gen : null;
  }

  /** The marker: absent (ENOENT only), its generation, or present but unreadable (any other error: it fails closed in load). */
  private readMarker(): { state: "none" } | { state: "unreadable" } | { state: "gen"; gen: number } {
    const f = path.join(this.o.dir, ERASED_FILE);
    let raw: string;
    try { raw = fs.readFileSync(f, "utf8"); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "none" };
      this.o.log.warn("history.marker_unreadable", { code: (err as NodeJS.ErrnoException).code });
      return { state: "unreadable" };
    }
    try {
      const v = JSON.parse(raw) as { gen?: unknown };
      return { state: "gen", gen: typeof v.gen === "number" && Number.isSafeInteger(v.gen) && v.gen >= 0 ? v.gen : 2 ** 40 };
    } catch { return { state: "gen", gen: 2 ** 40 }; /* damaged: it still means "a clear happened", so nothing older is shown */ }
  }

  /** The generation the file on disk was saved under (0 if none or unreadable). */
  private fileGen(): number {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8")) as { gen?: unknown };
      return typeof v.gen === "number" && Number.isSafeInteger(v.gen) && v.gen >= 0 ? v.gen : 0;
    } catch { return 0; }
  }

  /** Writes the marker durably (temp, fsync, atomic rename, 0600, folder fsync best effort). True if it is in place. */
  private writeMarker(gen: number): boolean {
    const f = path.join(this.o.dir, ERASED_FILE);
    const tmp = `${f}.tmp`;
    try {
      fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeSync(fd, JSON.stringify({ version: HISTORY_VERSION, gen }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, f);
      try {
        const d = fs.openSync(this.o.dir, "r");
        try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
      } catch { /* a folder can't be flushed here (Windows): the rename itself is done */ }
      return true;
    } catch (err) {
      this.o.log.warn("history.marker_not_written", { code: (err as NodeJS.ErrnoException).code });
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
      return false;
    }
  }

  private dropMarker(): void {
    try { fs.rmSync(path.join(this.o.dir, ERASED_FILE), { force: true }); } catch { /* it stays; the next load tidies it */ }
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
        try { fs.truncateSync(f, 0); } catch { /* neither deleted nor emptied: only the marker (and this run's memory of it) stands in the way */ }
      }
    }
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
