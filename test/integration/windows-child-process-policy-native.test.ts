/** Fixed policy observations, never generic process admission or a replacement for the six known LPAC refusals. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { runWindowsChildProcessPolicyProbe, WindowsChildProcessPolicyCleanupError, type WindowsChildPolicyCase } from "../fixtures/windows-child-process-policy-proof";
import { windowsChildPolicyScratchLocation } from "../fixtures/windows-child-process-policy-ownership";
import { windowsChildPolicyFailure } from "../fixtures/windows-child-process-policy-diagnostic";
const required = process.env.EMBER_CHILD_POLICY_PROBE === "1";
const available = required && process.platform === "win32" && process.arch === "x64";
describe.skipIf(!available && !required)("fixed creation-time child-policy witness", () => {
  let parent = "", retained = false, buildRoot = "", commit = "", image: "windows-2022" | "windows-2025";
  const outcomes = new Map<WindowsChildPolicyCase, ReturnType<typeof runWindowsChildProcessPolicyProbe>>();
  beforeAll(() => {
    if (!available) throw new Error("The required child-policy witness needs Windows x64.");
    buildRoot = process.env.EMBER_CHILD_POLICY_BUILD_ROOT ?? ""; commit = process.env.GITHUB_SHA ?? "";
    const selected = process.env.EMBER_CHILD_POLICY_IMAGE;
    if (!/^[A-Za-z]:\\/.test(buildRoot) || !/^[0-9a-f]{40}$/.test(commit) || selected !== "windows-2022" && selected !== "windows-2025") throw new Error("The fixed child-policy build inputs are unavailable.");
    image = selected;
    const supplied = process.env.RUNNER_TEMP;
    if (!supplied || !/^[A-Za-z]:\\/.test(supplied) || path.win32.normalize(supplied) !== supplied) throw new Error("The policy witness requires hosted RUNNER_TEMP with no fallback.");
    const runner = fs.realpathSync.native(supplied), stat = fs.lstatSync(supplied), managed = fs.realpathSync.native(os.tmpdir());
    if (!stat.isDirectory() || stat.isSymbolicLink() || runner.toLowerCase() !== supplied.toLowerCase()) throw new Error("The hosted native scratch root is not canonical.");
    // A fresh sibling is retained on uncertainty; the test runner owns and deletes only its managed run directory.
    const candidate = fs.realpathSync.native(fs.mkdtempSync(path.join(runner, "ember-child-policy-native-")));
    parent = windowsChildPolicyScratchLocation(runner, managed, candidate);
  });
  afterAll(() => { if (parent && !retained) fs.rmSync(parent, { recursive: true, force: true }); });
  const outcome = (caseId: WindowsChildPolicyCase) => {
    if (retained) return Promise.reject(new WindowsChildProcessPolicyCleanupError());
    let result = outcomes.get(caseId);
    if (!result) {
      result = runWindowsChildProcessPolicyProbe({ parent: fs.mkdtempSync(path.join(parent, `case-${caseId}-`)), buildRoot, commit, image, caseId }, loadExperimentalWindowsLpacApi())
        .then(value => { console.info("Stopped fixed child-policy observations", JSON.stringify({ caseId, ...value })); return value; })
        .catch(error => { const failure = windowsChildPolicyFailure(error); if (failure) console.info("Fixed first child-policy failure", JSON.stringify({ caseId, failure }));
          if (error instanceof WindowsChildProcessPolicyCleanupError) retained = true; throw error; });
      outcomes.set(caseId, result);
    }
    return result;
  };
  const prerequisite = async () => {
    const value = await outcome(0);
    if (value.host.report?.plain.created !== 1 || value.host.report.override.created !== 1) throw new Error("The ordinary same-route child controls have not passed.");
    return value;
  };
  it("requires useful ordinary direct-create controls and records the independently limited LPAC baseline", async () => {
    const result = await prerequisite();
    expect(result.host.report).toMatchObject({ role: 0, caseId: 0, status: 1, controls: 15, plain: { created: 1, knownClosed: true }, override: { created: 1, knownClosed: true } });
    expect(result.lpac.report).toMatchObject({ role: 1, caseId: 0, status: 1, controls: 15, policyCausality: "not-established" });
    expect(result.lpac.exitCode).toBe(0); expect(result.lpac.jobStopped).toBe(true);
  }, 90_000);
  it("proves only broker-created LPAC leaf compatibility, separately from direct creation", async () => {
    await prerequisite(); const result = await outcome(8);
    expect(result.host.exitCode).toBe(0); expect(result.lpac.exitCode).toBe(0);
    expect(result.host.report).toBeNull(); expect(result.lpac.report).toBeNull();
    expect(result.host.jobStopped).toBe(true); expect(result.lpac.jobStopped).toBe(true);
  }, 90_000);
  for (const caseId of [1, 2, 3, 4, 5, 6, 7] as const) it(`records closed case${caseId} with native birth attestation and no policy-causality shortcut`, async () => {
    await prerequisite(); const result = await outcome(caseId);
    for (const role of ["host", "lpac"] as const) {
      expect(result[role].exitCode).toBe(0); expect(result[role].jobStopped).toBe(true);
      expect(result[role].report).toMatchObject({ caseId, status: 1, controls: 15, plain: { knownClosed: true }, override: { knownClosed: true }, policyCausality: "not-established" });
      if (caseId !== 2) {
        expect(result[role].birthFlags).toBe(1); expect(result[role].report?.beforeFlags).toBe(1);
        expect(result[role].report?.plain.created).toBe(0); expect(result[role].report?.override.created).toBe(0);
      }
      if (caseId >= 3) expect(result[role].report?.setter.validity).toBe("not-established");
    }
    expect(result.canaryUnchanged).toBe(true); expect(result.noOutput).toBe(true);
  }, 90_000);
});
