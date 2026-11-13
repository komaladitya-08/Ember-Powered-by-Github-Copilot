/**
 * Append-only audit log of every decision and action (JSON lines, 0600), one
 * file per month. Each entry is kept for 30 days by default (the administrator
 * can change that), pruned at start and once a day. Each line can also go to the
 * systemd journal (tag "ember-audit"), so administrators see it with the rest of
 * the machine's logs.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { typesCharacter } from "./policy";
import { writeAllSync } from "../write-all";

export interface AuditEntry {
  task?: string;
  /**
   * `autonomy`: the approval mode in force changed (`mode`, and `before`), and how (`via`: home, voice, typed, file
   * or policy; `verified`); `atStart`: as found in force at start. Entries from before the modes say `on` instead.
   * `read`: a picture of a window went to the model (`kind: "screenshot"`, its app and size, never its title).
   */
  event: "decision" | "action" | "confirm" | "task" | "stop" | "command" | "remote" | "wsl" | "extension" | "autonomy" | "read";
  [key: string]: unknown;
}

const MONTH_FILE = /^audit-(\d{4})-(\d{2})\.jsonl$/;
const TAIL_BLOCK_BYTES = 64 * 1024;

/** How a rename says the file it would replace is open (Windows). */
const REPLACE_REFUSED = new Set(["EPERM", "EACCES", "EBUSY"]);

/** How long a trim waits, after replacing a month's file, for a line another process was just writing to the old one. */
const LATE_WRITER_MS = 10;

/** Command phases written once their step has happened (a run started or ended, the task's folder changed). */
const DONE_PHASES = new Set(["started", "ended", "tainted", "cd"]);

/**
 * Is `e` written after its step happened (an action done or tried, a command started or ended)? Its record failing
 * can't undo the step, so the step is reported as it went; an entry written before its step (a decision, an answer)
 * failing means the step isn't taken (review #117).
 */
export function afterTheStep(e: AuditEntry): boolean {
  return e.event === "action" || (e.event === "command" && DONE_PHASES.has(String(e.phase)));
}

export class AuditLog {
  /** The last write failed: the next failure isn't reported again until a write works. */
  private failing = false;

  /**
   * `onError`: told when writes start failing (once, until one works again). `redact`: a pass over every entry before
   * it is written (the vault's redactor: a value the vault filled is never audited, whatever name or title holds it).
   */
  constructor(private dir: string, private now: () => Date = () => new Date(), private sink?: (line: string) => void, private onError?: (err: unknown) => void,
    private redact?: <T>(entry: T) => T) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get file(): string {
    const d = this.now();
    return path.join(this.dir, `audit-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  }

  /** The newest entries, newest first: read from the files once, then kept up to date in memory. */
  private latest: (AuditEntry & { t: string })[] | null = null;
  private static readonly KEEP = 500;

  /**
   * Appends `e`. Throws when it can't be written (a full disk, an unwritable file): callers that must not act
   * unrecorded rely on that, and those that only keep a record catch it. The journal gets the line either way.
   */
  write(e: AuditEntry): void {
    // A redactor that throws writes nothing: the caller hears it as any write that failed.
    const line = JSON.stringify({ t: this.now().toISOString(), ...(this.redact ? this.redact(e) : e) });
    try {
      this.append(line);
    } catch (err) {
      // Where the file can't keep it, the machine's journal still has it (review #117).
      try { this.sink?.(line); } catch { /* the journal is a copy */ }
      if (!this.failing) { try { this.onError?.(err); } catch { /* reporting it mustn't hide the failure */ } }
      this.failing = true;
      throw err;
    }
    this.failing = false;
    if (this.latest) { this.latest.unshift(JSON.parse(line)); this.latest.length = Math.min(this.latest.length, AuditLog.KEEP); }
    try { this.sink?.(line); } catch { /* the journal is a copy; the file is the record */ }
  }

  private append(line: string): void {
    try {
      fs.appendFileSync(this.file, line + "\n", { mode: 0o600 });
    } catch (err) {
      // A folder removed while Ember runs (a clean-up tool) is made again: writing works without a restart (review #117).
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, line + "\n", { mode: 0o600 });
    }
  }

  /** The newest entries, newest first (for the activity timeline, asked for every few seconds). */
  recent(limit = 100): (AuditEntry & { t: string })[] {
    this.latest ??= this.readNewest(AuditLog.KEEP);
    // Further back than the newest KEEP (What Ember did's Show earlier): read from the files, not kept in memory.
    if (limit > AuditLog.KEEP && this.latest.length >= AuditLog.KEEP) return this.readNewest(limit);
    return this.latest.slice(0, limit);
  }

  private readNewest(limit: number): (AuditEntry & { t: string })[] {
    const files = fs.readdirSync(this.dir).filter(f => MONTH_FILE.test(f)).sort().reverse();
    const out: (AuditEntry & { t: string })[] = [];
    for (const f of files) {
      const enough = readTail(path.join(this.dir, f), line => {
        try { out.push(JSON.parse(line.toString("utf8"))); } catch { /* a torn line */ }
        return out.length >= limit;
      });
      if (enough) break;
    }
    return out;
  }

  /**
   * Deletes entries older than `days`, by each entry's own time (review #86): a month whose end is older goes whole, a
   * month that straddles the cutoff is trimmed in place (see trim), and a newer one isn't read at all. A month it can't
   * remove or trim (such as one another process holds open on Windows) is left as it is, and the others are pruned all
   * the same; it then throws, naming each one it couldn't prune.
   */
  prune(days = 30): void {
    const now = this.now().getTime();
    const cutoff = now - days * 86_400_000;
    const failed: { name: string; err: unknown }[] = [];
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const m = MONTH_FILE.exec(f);
        if (!m) continue;
        const file = path.join(this.dir, f);
        const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
        const end = Date.UTC(Number(m[1]), Number(m[2]), 1); // first day of the following month
        try {
          if (end <= cutoff) fs.rmSync(file);
          else if (start < cutoff) this.trim(file, cutoff, end <= now);
        } catch (err) {
          failed.push({ name: f, err });
        }
      }
    } finally {
      // What recent() shows is read again, whatever was removed.
      this.latest = null;
    }
    if (failed.length) {
      const why = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err));
      throw new Error(`Couldn't prune ${failed.map(f => `${f.name} (${why(f.err)})`).join(", ")}`, { cause: failed.length === 1 ? failed[0].err : failed.map(f => f.err) });
    }
  }

  /**
   * Keeps the lines of `file` written at `cutoff` or later; rewrites it (0600, atomically) only when some go, and
   * removes it when none stay and its month is over (`ended`). Another process may be appending to it all the while
   * (two remote agents for one machine share their audit folder): what it adds before the new file is in place, and
   * just after where the system lets an open file be replaced (not Windows), goes across too, and a line still being
   * written is carried over as it is; a torn line goes with the old ones (review #86).
   */
  private trim(file: string, cutoff: number, ended: boolean): void {
    let src: number | null = fs.openSync(file, "r");
    try {
      const head = fs.readFileSync(src);
      const whole = head.lastIndexOf(0x0a) + 1;
      const lines = head.subarray(0, whole).toString("utf8").split("\n").filter(Boolean);
      const keep = lines.filter(l => {
        try {
          const t = Date.parse((JSON.parse(l) as { t?: unknown }).t as string);
          return Number.isFinite(t) && t >= cutoff;
        } catch {
          return false; // a torn line
        }
      });
      if (keep.length === lines.length) return;
      if (!keep.length && ended) { fs.closeSync(src); src = null; fs.rmSync(file); return; }
      const ino = fs.fstatSync(src).ino;
      const tmp = `${file}.tmp-${process.pid}`;
      let copied = head.length;
      try {
        const out = fs.openSync(tmp, "w", 0o600);
        try {
          writeAllSync(out, Buffer.concat([Buffer.from(keep.map(l => l + "\n").join("")), head.subarray(whole)]));
          copied = copyAdded(src, out, copied);
        } finally {
          fs.closeSync(out);
        }
        // Another prune replaced it first (and lines may have gone into its version since): left as it is.
        if (fs.statSync(file).ino !== ino) { fs.rmSync(tmp, { force: true }); return; }
        try {
          fs.renameSync(tmp, file);
        } catch (err) {
          // Windows won't replace a file anything holds open, this read included: what was added meanwhile goes across,
          // then it lets go of the file and tries once more.
          if (!REPLACE_REFUSED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
          const more = fs.openSync(tmp, "a");
          try { copyAdded(src, more, copied); } finally { fs.closeSync(more); }
          fs.closeSync(src);
          src = null;
          fs.renameSync(tmp, file);
        }
      } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to tidy */ }
        throw err;
      }
      // A line that reached the old file as it was replaced goes across too, and once more a moment later for a writer
      // that had opened it just before (a trim is rare: at start and once a day).
      if (src !== null) {
        const out = fs.openSync(file, "a", 0o600);
        try {
          copied = copyAdded(src, out, copied);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LATE_WRITER_MS);
          copyAdded(src, out, copied);
        } finally {
          fs.closeSync(out);
        }
      }
    } finally {
      if (src !== null) fs.closeSync(src);
    }
  }

  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Prunes once a day as well as at start (an Ember that runs for weeks keeps nothing past `days()`), without keeping
   * the process alive; returns a function that stops it. `onError`: a prune that failed (tried again the next day).
   * A day whose `days()` is null prunes nothing (the policy in force can't be used, so its retention can't be read).
   */
  pruneDaily(days: () => number | null, onError: (err: unknown) => void = () => undefined): () => void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    const timer = setInterval(() => {
      try { const keep = days(); if (keep !== null) this.prune(keep); } catch (err) { onError(err); }
    }, 86_400_000);
    timer.unref?.();
    this.pruneTimer = timer;
    return () => { clearInterval(timer); if (this.pruneTimer === timer) this.pruneTimer = null; };
  }
}

/** Visits lines from the end of one month, reading older blocks only while the caller needs more. */
function readTail(file: string, visit: (line: Buffer) => boolean): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const block = Buffer.allocUnsafe(TAIL_BLOCK_BYTES);
    // Keep an unfinished line as bytes so a multi-byte character can cross a block boundary.
    let pieces: Buffer[] = [];
    const visitLine = (head: Buffer): boolean => {
      if (pieces.length) {
        pieces.push(head);
        head = Buffer.concat(pieces.reverse());
        pieces = [];
      }
      return head.length > 0 && visit(head);
    };
    for (let end = fs.fstatSync(fd).size; end > 0;) {
      const start = Math.max(0, end - block.length);
      const length = end - start;
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, block, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      // An external truncate can leave a gap. Do not join pieces from opposite sides of it.
      if (read < length) pieces = [];
      let stop = read;
      while (stop > 0) {
        const newline = block.lastIndexOf(0x0a, stop - 1);
        if (newline < 0) break;
        if (visitLine(block.subarray(newline + 1, stop))) return true;
        stop = newline;
      }
      if (stop > 0) pieces.push(Buffer.from(block.subarray(0, stop)));
      end = start;
    }
    return pieces.length > 0 && visitLine(Buffer.alloc(0));
  } finally { fs.closeSync(fd); }
}

/** Copies what another process added to `src` past `from` to `out`, until it stops growing; returns where `src` ends. */
function copyAdded(src: number, out: number, from: number): number {
  for (let size = fs.fstatSync(src).size; size > from; size = fs.fstatSync(src).size) {
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(src, buf, 0, buf.length, from);
    if (n <= 0) break;
    writeAllSync(out, buf.subarray(0, n));
    from += n;
  }
  return from;
}

/** systemd-cat, when there is a journal to write to (its program and the journal's socket both exist). */
function systemdCat(exists: (p: string) => boolean): string | undefined {
  const bin = ["/usr/bin/systemd-cat", "/bin/systemd-cat"].find(p => exists(p));
  return bin && exists("/run/systemd/journal/stdout") ? bin : undefined;
}

/**
 * Is there a systemd journal journalSink can copy audit lines to? (The settings window mentions the journal only
 * then; Windows and macOS have none, and neither has every Linux.)
 */
export function journalAvailable(exists: (p: string) => boolean = fs.existsSync): boolean {
  return systemdCat(exists) !== undefined;
}

/**
 * A copy of each audit line in the systemd journal (`journalctl -t ember-audit`),
 * through one long-lived systemd-cat. Returns undefined where there's no journal.
 */
export function journalSink(onError: (err: unknown) => void = () => undefined): ((line: string) => void) | undefined {
  // The same test as journalAvailable(), so the settings window names the journal exactly when lines go there.
  const bin = systemdCat(fs.existsSync);
  if (!bin) return undefined;
  let child: ReturnType<typeof spawn> | null = null;
  let broken = false;
  const start = () => {
    child = spawn(bin, ["-t", "ember-audit", "-p", "info"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", err => { broken = true; onError(err); });
    child.stdin!.on("error", err => { broken = true; onError(err); });
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
  };
  return line => {
    if (broken) return;
    if (!child) start();
    child!.stdin!.write(journalLine(line) + "\n");
  };
}

/** What Assisted's check said of an app step (Decision.review): Ember's own fixed words, never the model's. */
const STEP_REVIEWS: ReadonlySet<string> = new Set(["match", "no-match", "none"]);
/** Values that say nothing private: key combinations, scroll directions, Ember's own settings, app names, on/off. */
const PLAIN_VALUE_KINDS = new Set(["keys", "scroll", "setting", "open_app", "toggle"]);

/**
 * The journal is readable by more people than the user's own 0600 audit file: what the user asked,
 * window titles, element names (an email's subject), chosen values (a form's answers) and error messages
 * (they can quote the app's own text) go there as sizes only (the full text stays in ~/.config/ember/audit).
 * A key that types a character goes there as a count like typed text (letters typed one by one would spell it out);
 * shortcuts and keys that edit or move stay. Reasons stay: they are Ember's own words and app names. A command
 * review's words (`review`) are the model's, and can name the file and the request: a size only (safety-privacy-v1).
 * What Assisted's check said of an app step is one of Ember's three fixed words (Decision.review): it stays.
 */
export function journalLine(line: string): string {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    const size = (o: Record<string, unknown>, k: string) => {
      if (typeof o[k] === "string") { o[`${k}Chars`] = (o[k] as string).length; delete o[k]; }
    };
    for (const k of ["goal", "summary", "window", "error", "cwd"]) size(e, k);
    if (!STEP_REVIEWS.has(String(e.review))) size(e, "review");
    // A command's text goes as its size only, as typed text does; the size its entry already gives (before redaction
    // and the 2000-character cut, §3.12) stays.
    if (typeof e.command === "string") { if (typeof e.commandChars !== "number") e.commandChars = e.command.length; delete e.command; }
    if (!PLAIN_VALUE_KINDS.has(String(e.kind))) size(e, "value");
    else if (e.kind === "keys" && typeof e.value === "string" && typesCharacter(e.value)) { delete e.value; e.chars = 1; }
    for (const k of ["element", "after"]) {
      if (e[k] && typeof e[k] === "object") {
        const copy = { ...(e[k] as Record<string, unknown>) };
        size(copy, "name");
        size(copy, "selected");
        e[k] = copy;
      }
    }
    return JSON.stringify(e);
  } catch {
    return line;
  }
}
