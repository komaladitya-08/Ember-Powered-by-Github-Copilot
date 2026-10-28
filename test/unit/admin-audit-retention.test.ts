/**
 * The audit log's retention under the administrator's policy (review #106): the log is never pruned while Ember can't
 * read the administrator's retention (a broken policy, or a newer one an older Ember can't read), on the PC and on a
 * remote, so a locked-down Ember never deletes evidence.
 */

import { describe, expect, it } from "vitest";
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
});
