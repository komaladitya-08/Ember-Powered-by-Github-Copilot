import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../../app/main/policy/audit";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-audit-tail-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
  fs.rmdirSync(dir);
});

const file = (month: string) => path.join(dir, `audit-2026-${month}.jsonl`);
const record = (task: string) => JSON.stringify({ event: "task", task });

describe("recent audit activity", () => {
  it("reads the newest 500 without loading the rest of a large month", () => {
    const log = new AuditLog(dir);
    const old = (record("an old task " + "x".repeat(200)) + "\n").repeat(15_000);
    const recent = Array.from({ length: 501 }, (_, i) => record(String(i))).join("\n") + "\n";
    const month = file("11");
    fs.writeFileSync(month, old + recent);
    const fullRead = vi.spyOn(fs, "readFileSync");
    const read = vi.spyOn(fs, "readSync");

    const tasks = log.recent(500).map(e => e.task);
    expect(tasks).toEqual(Array.from({ length: 500 }, (_, i) => String(500 - i)));
    expect(fullRead.mock.calls.some(args => args[0] === month)).toBe(false);
    const bytes = read.mock.results.reduce((n, result) => n + (typeof result.value === "number" ? result.value : 0), 0);
    expect(bytes).toBeLessThan(Buffer.byteLength(old) / 4);
  });

  it("joins records across blocks, skips torn lines, and keeps month order and cached appends", () => {
    const log = new AuditLog(dir, () => new Date("2026-12-01T00:00:00Z"));
    // Place the two-block boundary halfway through the emoji's four UTF-8 bytes.
    const suffix = `"}\n\n${record("newest")}\n{"event":`;
    const text = "café🔒" + "x".repeat(2 * 64 * 1024 - Buffer.byteLength(suffix) - 2);
    fs.writeFileSync(file("11"), `${record("older")}\n{"event":"task","task":"${text}${suffix}`);
    fs.writeFileSync(file("10"), record("last month without a final newline"));
    expect(log.recent(500).map(e => e.task)).toEqual(["newest", text, "older", "last month without a final newline"]);

    log.write({ event: "task", task: "just added" });
    expect(log.recent(2).map(e => e.task)).toEqual(["just added", "newest"]);
  });

  it("closes the file when a read fails and can retry without caching partial history", () => {
    const log = new AuditLog(dir);
    fs.writeFileSync(file("11"), record("newest") + "\n");
    const error = new Error("read failed");
    vi.spyOn(fs, "readSync").mockImplementationOnce(() => { throw error; });
    const close = vi.spyOn(fs, "closeSync");
    expect(() => log.recent()).toThrow(error);
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.recent().map(e => e.task)).toEqual(["newest"]);
  });
});
