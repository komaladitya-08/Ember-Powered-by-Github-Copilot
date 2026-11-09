/** The run marker (app/main/run-marker.ts): telling a run that ended unexpectedly from one that quit. */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUN_FILE, endRun, previousRun, startRun } from "../../app/main/run-marker";

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-run-marker-"));

describe("the run marker", () => {
  it("says the last run ended unexpectedly when its marker is still there, with when it started and its version (rp-5)", () => {
    const dir = folder();
    startRun(dir, { pid: 4242, version: "1.2.3", now: () => new Date("2026-11-07T09:15:00Z") });
    // Main crashed: nothing removed it. The next start finds it.
    expect(previousRun(dir)).toEqual({ pid: 4242, startedAt: "2026-11-07T09:15:00.000Z", version: "1.2.3" });
  });

  it("finds nothing after a quit, so a quit and a crash can be told apart (rp-5)", () => {
    const dir = folder();
    startRun(dir, { pid: 1, version: "1.2.3" });
    endRun(dir);
    expect(previousRun(dir)).toBeNull();
    // Ending twice, or with no marker at all, is harmless.
    endRun(dir);
    expect(previousRun(folder())).toBeNull();
  });

  it("keeps only the process id, the start time and the version, readable by the owner alone (rp-5)", () => {
    const dir = folder();
    startRun(dir, { pid: 7, version: "1.2.3" });
    const file = path.join(dir, RUN_FILE);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort()).toEqual(["pid", "startedAt", "version"]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // A marker left with wider permissions is replaced, not reused.
    fs.chmodSync(file, 0o644);
    startRun(dir, { pid: 8, version: "1.2.3" });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("passes over a damaged or unreadable marker quietly (rp-5)", () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, RUN_FILE), "{ not json");
    expect(previousRun(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, RUN_FILE), JSON.stringify({ pid: "x", startedAt: 3 }));
    expect(previousRun(dir)).toBeNull();
    const odd = folder();
    fs.mkdirSync(path.join(odd, RUN_FILE));
    expect(previousRun(odd)).toBeNull();
    expect(() => endRun(odd)).not.toThrow();
    expect(() => startRun(path.join(odd, "missing", "deeper"), { pid: 1, version: "1" })).not.toThrow();
  });
});
