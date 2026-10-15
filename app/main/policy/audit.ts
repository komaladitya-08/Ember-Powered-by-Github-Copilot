/**
 * Append-only audit log of every decision and action (JSON lines, 0600).
 * Kept for 30 days; rotated by month.
 */

import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  task?: string;
  event: "decision" | "action" | "confirm" | "task";
  [key: string]: unknown;
}

export class AuditLog {
  constructor(private dir: string, private now: () => Date = () => new Date()) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get file(): string {
    const d = this.now();
    return path.join(this.dir, `audit-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  }

  write(e: AuditEntry): void {
    const line = JSON.stringify({ t: this.now().toISOString(), ...e }) + "\n";
    fs.appendFileSync(this.file, line, { mode: 0o600 });
  }

  /** Deletes month files older than `days`. */
  prune(days = 30): void {
    const cutoff = this.now().getTime() - days * 86_400_000;
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^audit-(\d{4})-(\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const end = Date.UTC(Number(m[1]), Number(m[2]), 1); // first day of the following month
      if (end < cutoff) fs.rmSync(path.join(this.dir, f));
    }
  }
}
