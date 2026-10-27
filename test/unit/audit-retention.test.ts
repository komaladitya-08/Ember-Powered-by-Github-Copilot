/**
 * Audit retention by each entry's own time (review #86): an entry older than the administrator's auditRetentionDays
 * goes even when its month's file has newer ones (the file is trimmed in place, still 0600), a month with nothing left
 * goes whole, and an Ember that runs for weeks prunes once a day, not only at start.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../../app/main/policy/audit";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-retention-"));
const at = (iso: string) => new Date(iso);
const tasks = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l).task) : [];

afterEach(() => { vi.useRealTimers(); });

describe("audit retention (review #86)", () => {
  it("drops entries older than the retention from a month's file that has newer ones", () => {
    const dir = tmp();
    let now = at("2026-09-01T09:00:00Z");
    const log = new AuditLog(dir, () => now);
    log.write({ event: "task", task: "sep-1" });
    now = at("2026-09-26T09:00:00Z");
    log.write({ event: "task", task: "sep-26" });
    now = at("2026-10-01T09:00:00Z");
    log.write({ event: "task", task: "oct-1" });
    now = at("2026-10-02T09:00:00Z");
    log.prune(7);
    expect(tasks(path.join(dir, "audit-2026-09.jsonl"))).toEqual(["sep-26"]);
    expect(tasks(path.join(dir, "audit-2026-10.jsonl"))).toEqual(["oct-1"]);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "audit-2026-09.jsonl")).mode & 0o777).toBe(0o600);
    // The activity timeline reads what is left.
    expect(log.recent(10).map(e => e.task)).toEqual(["oct-1", "sep-26"]);
  });

  it("removes a month's file once nothing in it is recent enough, and keeps the default 30 days", () => {
    const dir = tmp();
    let now = at("2026-09-01T09:00:00Z");
    const log = new AuditLog(dir, () => now);
    log.write({ event: "task", task: "sep-1" });
    // Exactly 30 days old: kept; a second later, gone.
    now = at("2026-10-01T09:00:00Z");
    log.prune(30);
    expect(tasks(path.join(dir, "audit-2026-09.jsonl"))).toEqual(["sep-1"]);
    now = at("2026-10-01T09:00:01Z");
    log.prune(30);
    expect(fs.existsSync(path.join(dir, "audit-2026-09.jsonl"))).toBe(false);
  });

  it("leaves a file it has nothing to remove from as it is (not rewritten)", () => {
    const dir = tmp();
    const now = at("2026-10-20T09:00:00Z");
    const log = new AuditLog(dir, () => now);
    log.write({ event: "task", task: "a" });
    const before = fs.statSync(log.file).mtimeMs;
    const ino = fs.statSync(log.file).ino;
    log.prune(7);
    expect(fs.statSync(log.file).ino).toBe(ino);
    expect(fs.statSync(log.file).mtimeMs).toBe(before);
  });

  it("an Ember that keeps running prunes once a day", () => {
    vi.useFakeTimers();
    const dir = tmp();
    let now = at("2026-10-01T09:00:00Z");
    const log = new AuditLog(dir, () => now);
    log.write({ event: "task", task: "old" });
    now = at("2026-10-05T09:00:00Z");
    log.write({ event: "task", task: "new" });
    const errors: unknown[] = [];
    const stop = log.pruneDaily(() => 7, err => errors.push(err));
    now = at("2026-10-09T09:00:00Z");
    vi.advanceTimersByTime(86_400_000);
    expect(tasks(log.file)).toEqual(["new"]);
    stop();
    expect(errors).toEqual([]);
  });
});
