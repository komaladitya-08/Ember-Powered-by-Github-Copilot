/** Separate fixed secure API observations; no Node/OpenSSL/FIPS compatibility or product admission is asserted. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { runWindowsSecureRngProbe, WindowsSecureRngCleanupError } from "../fixtures/windows-secure-rng-proof";

const required = process.env.EMBER_SECURE_RNG_PROBE === "1";
const available = required && process.platform === "win32" && process.arch === "x64";
describe.skipIf(!available && !required)("fixed secure RNG API prerequisite", () => {
  let parent = "", retained = false;
  let input: Parameters<typeof runWindowsSecureRngProbe>[0];
  beforeAll(() => {
    try {
    if (!available) throw new Error("The required secure RNG API prerequisite needs Windows x64.");
    const buildRoot = process.env.EMBER_SECURE_RNG_BUILD_ROOT ?? "", commit = process.env.GITHUB_SHA ?? "", image = process.env.EMBER_SECURE_RNG_IMAGE;
    if (!/^[A-Za-z]:\\/.test(buildRoot) || !/^[0-9a-f]{40}$/.test(commit) || image !== "windows-2022" && image !== "windows-2025") throw new Error("Select only the exact fixed secure RNG build and hosted image.");
    const temporary = fs.realpathSync.native(os.tmpdir()), base = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    parent = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "ember-secure-rng-native-")));
    input = { parent, buildRoot, commit, image };
    } catch {
      retained = true;
      throw new Error("The fixed secure RNG prerequisite could not prepare its explicit Windows host inputs.");
    }
  });
  afterAll(() => { if (parent && !retained) fs.rmSync(parent, { recursive: true, force: true }); });
  let observation: ReturnType<typeof runWindowsSecureRngProbe> | undefined;
  const outcome = () => observation ??= runWindowsSecureRngProbe(input, loadExperimentalWindowsLpacApi()).then(result => {
    console.info("Stopped fixed secure RNG API observations", JSON.stringify(result)); return result;
  }).catch(error => {
    if (error instanceof WindowsSecureRngCleanupError) retained = true;
    throw error;
  });
  for (const api of ["legacy", "cng"] as const) {
    it(`proves useful ${api} generation with a wiped buffer in the independently observed ordinary host`, async () => {
      const result = await outcome();
      expect(result.host.exitCode).toBe(0); expect(result.host.jobStopped).toBe(true);
      expect(result.host.report).toMatchObject({ role: 0, status: 1, controls: 31, buffersWiped: true });
      if (api === "legacy") expect(result.host.report.defaultProvider).toMatchObject({ attempted: 1, acquired: 1, generated: 1, released: 1, wiped: 1, knownClosed: true });
      else expect(result.host.report.cng).toMatchObject({ attempted: 1, status: 0, generated: 1, wiped: 1 });
    }, 90_000);
    it(`records closed ${api} observations under unchanged zero-capability LPAC`, async () => {
      const result = await outcome();
      expect(result.lpac.exitCode).toBe(0); expect(result.lpac.jobStopped).toBe(true);
      expect(result.lpac.report).toMatchObject({ role: 1, status: 1, controls: 31, canaryCode: 5, selfCode: 0, parentReadCode: 5, parentDuplicateCode: 5, parentCreateCode: 5, buffersWiped: true });
      if (api === "legacy") {
        expect(result.lpac.report.defaultProvider).toMatchObject({ attempted: 1, wiped: 1, knownClosed: true });
        expect(result.lpac.report.conditionalIntel.knownClosed).toBe(true);
      } else {
        expect(result.lpac.report.cng.attempted).toBe(1); expect([0, 1]).toContain(result.lpac.report.cng.generated); expect(result.lpac.report.cng.wiped).toBe(1);
      }
      expect(result.canaryUnchanged).toBe(true); expect(result.noOutput).toBe(true);
    }, 90_000);
  }
});
