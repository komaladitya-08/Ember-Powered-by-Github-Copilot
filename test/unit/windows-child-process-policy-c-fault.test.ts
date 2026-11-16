/** Linux-only C ownership logic; no Windows ABI, process policy or native behavior is established. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const required = process.env.EMBER_CHILD_POLICY_C_FAULT === "1";
const available = process.platform === "linux" && fs.existsSync("/usr/bin/cc");
describe.skipIf(!available && !required)("actual fixed C creation/close ownership boundaries using test-only declarations", () => {
  let temporary = "", program = "";
  beforeAll(() => {
    if (!available) throw new Error("The required C ownership checks need Linux and its fixed system compiler.");
    temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-child-policy-c-fault-")));
    program = path.join(temporary, "ownership-fault");
    const result = spawnSync("/usr/bin/cc", ["-std=c11", "-O1", "-Wall", "-Wextra", "-Werror", "-ffunction-sections", "-fdata-sections", "-I",
      path.resolve("test/fixtures/windows-child-process-policy-mock"), path.resolve("test/fixtures/windows-child-process-policy-mock/main.c"), "-Wl,--gc-sections", "-o", program], {
      cwd: temporary, env: { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: temporary }, timeout: 15_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status, "The fixed C ownership-only harness must compile successfully.").toBe(0);
  });
  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
  it.each([
    ["closed denied creation", 0, 0, 0, 0],
    ["failed creation with unexpected process handle", 1, 1, 0, 1],
    ["failed creation with unexpected process ID", 2, 1, 0, 1],
    ["successful creation with null process handle", 3, 1, 0, 1],
    ["successful creation with aliased process/thread handles", 4, 1, 0, 1],
    ["successful creation followed by two verified closes", 5, 0, 2, 0],
    ["uncertain thread close stops before process close", 6, 1, 1, 1],
    ["uncertain process close is never retried", 7, 1, 2, 1],
    ["successful creation with invalid process handle", 8, 1, 0, 1],
    ["successful creation claiming the current process", 9, 1, 0, 1],
  ])("preserves terminal non-continuation for %s", (_name, mode, terminal, closeAttempts, checkpointWrites) => {
    const result = spawnSync(program, [String(mode)], { cwd: temporary, env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 3_000, maxBuffer: 1_024, stdio: ["ignore", "pipe", "pipe"] });
    expect(result.status, "The injected C ownership state must preserve its fixed close/terminal contract.").toBe(0);
    expect(result.stderr.length, "The fixed ownership harness must have no stderr.").toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(256);
    expect(JSON.parse(result.stdout.toString("ascii"))).toEqual({ schema: 1, case: mode, terminal, closeAttempts, checkpointWrites });
  });
});
