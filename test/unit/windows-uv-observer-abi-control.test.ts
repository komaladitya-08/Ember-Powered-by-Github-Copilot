/** Actual unchanged observer C plus the new control, with Linux-only declarations: logic evidence, no Windows ABI claim. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const canCompile = process.platform === "linux" && spawnSync("cc", ["--version"], { stdio: ["ignore", "pipe", "pipe"] }).status === 0;
describe.skipIf(!canCompile)("actual observer ABI control C: non-Windows logic only", () => {
  let directory = "", program = "";
  beforeAll(() => {
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-uv-abi-control-"));
    program = path.join(directory, "control-logic");
    const fixtures = path.resolve("test/fixtures/windows-uv-observer-abi-shim");
    const result = spawnSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fstrict-aliasing",
      "-D_WIN32_WINNT=0x0602", "-I", fixtures, path.join(fixtures, "logic.c"), "-o", program],
    { timeout: 15_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] });
    // Compiler output stays private even on failure; assertions expose fixed booleans/statuses only.
    expect(result.error === undefined && result.signal === null, "The fixed portable C compilation must complete.").toBe(true);
    expect(result.status === 0, "The fixed portable C control must compile.").toBe(true);
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  function run(mode: number) {
    const result = spawnSync(program, [String(mode)], { timeout: 2_000, maxBuffer: 4_096, stdio: ["ignore", "pipe", "pipe"] });
    expect(result.error === undefined && result.signal === null, "The fixed portable fault case must finish naturally.").toBe(true);
    expect(result.stderr.length === 0, "The fixed portable fault case must keep stderr empty.").toBe(true);
    return result;
  }
  it("completes all 96 fixed baseline-before-wrapper cases with only the exact 256-byte report", () => {
    const result = run(0);
    expect(result.status === 0, "The portable success case must exit zero.").toBe(true);
    expect(result.stdout.length === 256, "The portable success report has a fixed byte length.").toBe(true);
    const words = Array.from({ length: 64 }, (_, i) => result.stdout.readUInt32LE(i * 4));
    const expected = [0x31494241, 1, 1, 0, 96, 96, 96, 96, 127, 0, 0, 0, 0, 0, 0, 0,
      ...Array.from({ length: 6 }, (_, i) => [i + 1, 16, 16, 32, 32, 32, 32, 8]).flat()];
    expect(words.every((word, i) => word === expected[i]), "Every fixed report DWORD must match the complete matrix.").toBe(true);
  });
  const faults = [
    [1, "a changed eighth stack argument"], [2, "a truncated high DWORD bit"],
    [3, "a truncated completion key"], [4, "a changed mutable command pointer"],
    [5, "a changed OVERLAPPED output"], [6, "a changed PROCESS_INFORMATION output"],
    [7, "a changed delegate entry error"], [8, "a changed caller error"],
    [9, "a normalised true BOOL"], [10, "an extra dynamic delegated call"],
    [11, "an unexpected pre-main call"], [12, "a failed report write"],
    [15, "a missing dynamic delegated call"], [16, "a changed armed ledger"],
    [17, "a truncated handle"],
  ] as const;
  it.each(faults)("refuses %s: %s without a success report", (mode) => {
    const result = run(mode);
    expect(result.status !== 0, "The injected fault must have a fixed nonzero exit.").toBe(true);
    expect(result.stdout.length === 0, "A rejected control case must emit no success report.").toBe(true);
  });
  it("rejects a short report write by its exit status", () => {
    const result = run(13);
    expect(result.status !== 0 && result.stdout.length === 128, "A partial report must end nonzero and cannot be COMPLETE.").toBe(true);
  });
  it("exits nonzero for an unexpected DONE call even after report bytes were written", () => {
    const result = run(14);
    expect(result.status !== 0 && result.stdout.length === 256, "A late delegate call must invalidate the prior report through nonzero exit.").toBe(true);
  });
  it("checks every DWORD of the original 112-byte ledger", () => {
    const result = run(18);
    expect(result.status === 0 && result.stdout.length === 0, "Every changed ledger word must be rejected by the actual comparison helper.").toBe(true);
  });
});
