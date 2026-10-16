/**
 * Append-only audit log of every decision and action (JSON lines, 0600).
 * Kept for 30 days by default (the administrator can change that); rotated by
 * month. Each line can also go to the systemd journal (tag "ember-audit"), so
 * administrators see it with the rest of the machine's logs.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { typesCharacter } from "./policy";

export interface AuditEntry {
  task?: string;
  event: "decision" | "action" | "confirm" | "task" | "stop";
  [key: string]: unknown;
}

const MONTH_FILE = /^audit-(\d{4})-(\d{2})\.jsonl$/;

export class AuditLog {
  constructor(private dir: string, private now: () => Date = () => new Date(), private sink?: (line: string) => void) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get file(): string {
    const d = this.now();
    return path.join(this.dir, `audit-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  }

  /** The newest entries, newest first: read from the files once, then kept up to date in memory. */
  private latest: (AuditEntry & { t: string })[] | null = null;
  private static readonly KEEP = 500;

  write(e: AuditEntry): void {
    const line = JSON.stringify({ t: this.now().toISOString(), ...e });
    fs.appendFileSync(this.file, line + "\n", { mode: 0o600 });
    if (this.latest) { this.latest.unshift(JSON.parse(line)); this.latest.length = Math.min(this.latest.length, AuditLog.KEEP); }
    try { this.sink?.(line); } catch { /* the journal is a copy; the file is the record */ }
  }

  /** The newest entries, newest first (for the activity timeline, asked for every few seconds). */
  recent(limit = 100): (AuditEntry & { t: string })[] {
    this.latest ??= this.readNewest(AuditLog.KEEP);
    return this.latest.slice(0, limit);
  }

  private readNewest(limit: number): (AuditEntry & { t: string })[] {
    const files = fs.readdirSync(this.dir).filter(f => MONTH_FILE.test(f)).sort().reverse();
    const out: (AuditEntry & { t: string })[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(this.dir, f), "utf8").split("\n").filter(Boolean).reverse();
      for (const l of lines) {
        try { out.push(JSON.parse(l)); } catch { /* a torn last line */ }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Deletes month files older than `days`. */
  prune(days = 30): void {
    const cutoff = this.now().getTime() - days * 86_400_000;
    for (const f of fs.readdirSync(this.dir)) {
      const m = MONTH_FILE.exec(f);
      if (!m) continue;
      const end = Date.UTC(Number(m[1]), Number(m[2]), 1); // first day of the following month
      if (end < cutoff) fs.rmSync(path.join(this.dir, f));
    }
    this.latest = null;
  }
}

/**
 * A copy of each audit line in the systemd journal (`journalctl -t ember-audit`),
 * through one long-lived systemd-cat. Returns undefined where there's no journal.
 */
export function journalSink(onError: (err: unknown) => void = () => undefined): ((line: string) => void) | undefined {
  const bin = ["/usr/bin/systemd-cat", "/bin/systemd-cat"].find(p => fs.existsSync(p));
  if (!bin || !fs.existsSync("/run/systemd/journal/stdout")) return undefined;
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

/** Values that say nothing private: key combinations, scroll directions, Ember's own settings, app names, on/off. */
const PLAIN_VALUE_KINDS = new Set(["keys", "scroll", "setting", "open_app", "toggle"]);

/**
 * The journal is readable by more people than the user's own 0600 audit file: what the user asked,
 * window titles, element names (an email's subject), chosen values (a form's answers) and error messages
 * (they can quote the app's own text) go there as sizes only (the full text stays in ~/.config/ember/audit).
 * A key that types a character goes there as a count like typed text (letters typed one by one would spell it out);
 * shortcuts and keys that edit or move stay. Reasons stay: they are Ember's own words and app names.
 */
export function journalLine(line: string): string {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    const size = (o: Record<string, unknown>, k: string) => {
      if (typeof o[k] === "string") { o[`${k}Chars`] = (o[k] as string).length; delete o[k]; }
    };
    for (const k of ["goal", "summary", "window", "error"]) size(e, k);
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
