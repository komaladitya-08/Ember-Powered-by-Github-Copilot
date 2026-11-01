/**
 * The audit log's retention under the administrator's policy (review #106): the log is never pruned while Ember can't
 * read the administrator's retention (a broken policy, or a newer one an older Ember can't read), on the PC and on a
 * remote, so a locked-down Ember never deletes evidence.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "../../app/main/policy/audit";
import { AdminPolicySchema, auditRetentionDays, lockedDown, parseAdminPolicy, type LoadedAdminPolicy } from "../../app/main/admin";
import { createRemoteAudit } from "../../app/remote/audit";
import type { Logger } from "../../app/main/logger";

const FILE = "/etc/ember/policy.json";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const none: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const MONTHS = ["audit-2026-01.jsonl", "audit-2026-05.jsonl", "audit-2026-08.jsonl", "audit-2026-10.jsonl"];
const NOW = new Date("2026-10-27T10:00:00Z");

/** An audit folder with one file per month, as a policy keeping a year leaves it. */
function auditDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-audit-"));
  for (const f of MONTHS) fs.writeFileSync(path.join(dir, f), "{}\n");
  return dir;
}
/** A policy keeping a year, with a key this Ember doesn't know (a newer policy, or a typo). */
const BROKEN = () => parseAdminPolicy(JSON.stringify({ auditRetentionDays: 365, futureKey: 1 }), FILE);

describe("auditRetentionDays", () => {
  it("is the policy's retention, or 30 days without one", () => {
    expect(auditRetentionDays(parseAdminPolicy(JSON.stringify({ auditRetentionDays: 365 }), FILE))).toBe(365);
    expect(auditRetentionDays(parseAdminPolicy("{}", FILE))).toBe(30);
    expect(auditRetentionDays(none)).toBe(30);
  });

  it("is null (keep everything) while the policy can't be read", () => {
    expect(BROKEN().error).toBeDefined();
    expect(auditRetentionDays(BROKEN())).toBeNull();
    expect(auditRetentionDays(lockedDown(FILE, "must belong to root"))).toBeNull();
  });

  it("leaves every month's file in place when the PC prunes by it under a broken policy", () => {
    const dir = auditDir();
    const keep = auditRetentionDays(BROKEN());
    if (keep !== null) new AuditLog(dir, () => NOW).prune(keep);
    expect(fs.readdirSync(dir).sort()).toEqual(MONTHS);
  });

  it("leaves every file in place on a remote whose policy is broken, and prunes by a retention that reads fine", () => {
    const dir = auditDir();
    createRemoteAudit({ dir, retentionDays: auditRetentionDays(BROKEN()), source: () => ({ from: "", pcId: "" }), log: quiet, now: () => NOW });
    expect(fs.readdirSync(dir).sort()).toEqual(MONTHS);
    const pruned = auditDir();
    createRemoteAudit({ dir: pruned, retentionDays: 30, source: () => ({ from: "", pcId: "" }), log: quiet, now: () => NOW });
    expect(fs.readdirSync(pruned)).toEqual(["audit-2026-10.jsonl"]);
  });

  it("keeps the remote's log working when pruning old months fails, and logs that the prune failed", () => {
    const dir = auditDir();
    // A month that can't be deleted (as a file another process holds open on Windows): a folder by that name.
    fs.mkdirSync(path.join(dir, "audit-2025-12.jsonl"));
    const said: string[] = [];
    const log = { ...quiet, warn: (m: string) => said.push(`warn ${m}`), error: (m: string) => said.push(`error ${m}`), child: () => log } as unknown as Logger;
    const audit = withStuckFirst(() => createRemoteAudit({ dir, retentionDays: 30, source: () => ({ from: "ana-laptop", pcId: "pc-1" }), log, now: () => NOW }));
    expect(said).toEqual(["warn remote.audit_prune_failed"]);
    // The other old months still went, though the folder lists the stuck one first.
    expect(fs.readdirSync(dir).sort()).toEqual(["audit-2025-12.jsonl", "audit-2026-10.jsonl"]);
    // Steps and commands are still written, so they aren't all refused for the rest of the session.
    expect(audit.write({ event: "remote", step: "connected" })).toBe(true);
    const lines = fs.readFileSync(path.join(dir, "audit-2026-10.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: "remote", step: "connected", from: "ana-laptop", fromUnverified: true, pcId: "pc-1" });
    expect(said).toEqual(["warn remote.audit_prune_failed"]);
  });

  it("prunes every other month when one can't be removed, and then says which (review #86)", () => {
    const dir = auditDir();
    fs.writeFileSync(path.join(dir, "audit-2025-12.jsonl"), JSON.stringify({ t: "2025-12-05T08:00:00Z", event: "task" }) + "\n");
    // A month that straddles the cutoff (2026-09-27): its old line goes, its newer one stays.
    fs.writeFileSync(path.join(dir, "audit-2026-09.jsonl"), [{ t: "2026-09-02T08:00:00Z", event: "task" }, { t: "2026-09-30T08:00:00Z", event: "task" }].map(e => JSON.stringify(e) + "\n").join(""));
    const log = new AuditLog(dir, () => NOW);
    log.write({ event: "task", n: 1 });
    expect(log.recent()).toHaveLength(8); // read and kept
    // December 2025 is held open by another process (Windows: EBUSY), and the folder happens to list it first.
    expect(() => withStuckFirst(() => log.prune(30), "audit-2025-12.jsonl")).toThrow(/^Couldn't prune audit-2025-12\.jsonl \(EBUSY/);
    // January, May and August went all the same, and September was trimmed.
    expect(fs.readdirSync(dir).sort()).toEqual(["audit-2025-12.jsonl", "audit-2026-09.jsonl", "audit-2026-10.jsonl"]);
    expect(fs.readFileSync(path.join(dir, "audit-2026-09.jsonl"), "utf8")).toBe(JSON.stringify({ t: "2026-09-30T08:00:00Z", event: "task" }) + "\n");
    // What it shows is read again: nothing it removed is still listed.
    expect(log.recent().map(e => e.t)).toEqual([NOW.toISOString(), undefined, "2026-09-30T08:00:00Z", "2025-12-05T08:00:00Z"]);
  });
});

/**
 * Runs `fn` with the audit folder listing its stuck month first, as readdir may (its order isn't sorted). The stuck month
 * is the folder's subfolder, or `locked`: a file that can't be removed, as one another process holds open on Windows.
 */
function withStuckFirst<T>(fn: () => T, locked?: string): T {
  const real = fs.readdirSync.bind(fs) as (d: fs.PathLike) => string[];
  const stuckIn = (d: fs.PathLike, n: string) => n === locked || fs.statSync(path.join(String(d), n)).isDirectory();
  const list = vi.spyOn(fs, "readdirSync").mockImplementation(((d: fs.PathLike) => {
    const names = real(d);
    return [...names.filter(n => stuckIn(d, n)), ...names.filter(n => !stuckIn(d, n))];
  }) as unknown as typeof fs.readdirSync);
  const realRm = fs.rmSync.bind(fs);
  const rm = vi.spyOn(fs, "rmSync").mockImplementation((p, o) => {
    if (locked && path.basename(String(p)) === locked) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${String(p)}'`), { code: "EBUSY" });
    realRm(p, o);
  });
  try { return fn(); } finally { list.mockRestore(); rm.mockRestore(); }
}
