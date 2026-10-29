/**
 * The remote's own audit log (§5.3.8): policy/audit.ts's AuditLog in state/<machine>/audit/ (0700 folder, 0600 files),
 * a copy of each line in the systemd journal through journalSink (titles, values and commands there as sizes only),
 * kept for the remote administrator's `auditRetentionDays` (default 30). Every entry says which PC it came from as that
 * PC reported it (`from`, `fromUnverified: true`) with its `pcId`. Writes are write-ahead: a step or command whose entry
 * can't be written isn't done. The PC can read the newest entries (audit.recent) but never delete or change any.
 * Plain Node.
 */

import { AuditLog, type AuditEntry } from "../main/policy/audit";
import type { Logger } from "../main/logger";
import { CAPS } from "../main/remote/protocol";

/** The audit log as the agent uses it. */
export interface RemoteAudit {
  /** Writes `e` with the PC's name and id; false when it couldn't be written (the step is then refused). */
  write(e: AuditEntry): boolean;
  /** The newest entries, newest first, as audit.recent sends them (bounded as its schema says). */
  recent(limit: number): Record<string, unknown>[];
}

/** Who the entries are from (set by hello; "" before). */
export interface AuditSource { from: string; pcId: string }

/**
 * Opens the audit log in `dir` and prunes entries older than `retentionDays` (null: prunes nothing, as while the remote's
 * policy can't be read, so its retention isn't known: admin.ts auditRetentionDays). A prune that fails (an old month's
 * file it can't delete or rewrite, such as one another agent holds open on Windows) keeps what it couldn't remove and
 * says so; the log itself stays open, so steps and commands are still written.
 */
export function createRemoteAudit(o: { dir: string; retentionDays: number | null; source: () => AuditSource; log: Logger; sink?: (line: string) => void; now?: () => Date }): RemoteAudit {
  let audit: AuditLog | null = null;
  try {
    audit = new AuditLog(o.dir, o.now, o.sink);
  } catch (err) {
    // A folder that can't be made: every write fails, so every step and command is refused.
    o.log.error("remote.audit_unavailable", { err });
  }
  if (audit && o.retentionDays !== null) {
    try { audit.prune(o.retentionDays); } catch (err) { o.log.warn("remote.audit_prune_failed", { err }); }
  }
  return {
    write(e) {
      if (!audit) return false;
      const s = o.source();
      try {
        audit.write({ ...e, from: s.from, fromUnverified: true, pcId: s.pcId });
        return true;
      } catch (err) {
        o.log.error("remote.audit_write_failed", { err });
        return false;
      }
    },
    recent(limit) {
      if (!audit) return [];
      try {
        return audit.recent(Math.min(limit, CAPS.auditEntries)).map(wireEntry);
      } catch (err) {
        o.log.warn("remote.audit_read_failed", { err });
        return [];
      }
    },
  };
}

const KEYS_MAX = 64;
const KEY_MAX = 64;

/** One value as audit.recent's schema takes it: plain JSON, strings cut to 4000 characters, two levels deep. */
function wireValue(v: unknown, depth: number): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.slice(0, CAPS.str.text);
  if (depth <= 0) return typeof v === "object" ? JSON.stringify(v)?.slice(0, CAPS.str.text) ?? null : null;
  if (Array.isArray(v)) return v.slice(0, KEYS_MAX).map(x => wireValue(x, depth - 1));
  if (typeof v === "object") return wireObject(v as Record<string, unknown>, depth - 1);
  return null;
}

function wireObject(o: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o).slice(0, KEYS_MAX)) {
    if (v === undefined) continue;
    out[k.slice(0, KEY_MAX)] = wireValue(v, depth);
  }
  return out;
}

/** An audit entry shaped to audit.recent's schema (keys ≤ 64 of ≤ 64 characters, strings ≤ 4000, depth 2). */
export function wireEntry(e: object): Record<string, unknown> {
  return wireObject(e as Record<string, unknown>, 2);
}
