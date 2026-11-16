/** Linux fault-logic checks of the actual C file; no Windows ABI/LPAC/cryptographic claim. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const required = process.env.EMBER_SECURE_RNG_FAULT === "1";
const available = process.platform === "linux" && fs.existsSync("/usr/bin/cc");
describe.skipIf(!available && !required)("actual secure API C ownership failure paths using Linux-only test mocks", () => {
  let temporary = "", program = "";
  beforeAll(() => {
    if (!available) throw new Error("The required C fault-logic checks need Linux with its fixed system C compiler.");
    const root = fs.realpathSync.native(os.tmpdir()); temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(root, "ember-secure-rng-fault-")));
    program = path.join(temporary, "fault-logic");
    const result = spawnSync("/usr/bin/cc", ["-std=c11", "-O1", "-Wall", "-Wextra", "-Werror", "-I", path.resolve("test/fixtures/windows-secure-rng-mock"), path.resolve("test/fixtures/windows-secure-rng-mock/main.c"), "-o", program], {
      cwd: temporary, env: { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: temporary }, timeout: 15_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status, "The fixed Linux-only fault-logic harness must compile successfully.").toBe(0);
  });
  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
  const cases = [
    ["useful control", 0, 0, 1, 1, 1, 1, 1],
    ["failed acquire with unexpected output context", 1, 1, 1, 0, 0, 0, 0],
    ["successful acquire with null context", 2, 1, 1, 0, 0, 0, 0],
    ["failed generation releases once before conditional Intel", 3, 0, 2, 2, 2, 1, 1],
    ["uncertain release never retries or continues", 4, 1, 1, 1, 1, 0, 0],
    ["independent CNG failure preserves a closed observation", 5, 0, 1, 1, 1, 1, 1],
    ["uncertain final report close never returns", 6, 1, 1, 1, 1, 1, 1],
    ["default acquire denial takes only the source-conditional Intel path", 7, 0, 2, 1, 1, 1, 1],
  ] as const;
  it.each(cases)("wipes and records only bounded facts for %s", (_name, mode, terminal, acquireAttempts, generateAttempts, releaseAttempts, cngAttempts, reportCloseAttempts) => {
    const result = spawnSync(program, [String(mode)], { cwd: temporary, env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 3_000, maxBuffer: 1_024, stdio: ["ignore", "pipe", "pipe"] });
    expect(result.status, "The fixed injected C path must preserve its wipe/ownership/continuation assertions.").toBe(0);
    expect(result.stderr.length, "The fixed fault harness must have no native stderr.").toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(512);
    expect(JSON.parse(result.stdout.toString("ascii"))).toEqual({ schema: 1, case: mode, terminal, wiped: 1, acquireAttempts, generateAttempts, releaseAttempts, cngAttempts, reportCloseAttempts });
  });
});
