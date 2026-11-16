/** Separate once-only namespace observations; no Node/libuv compatibility or product admission is asserted. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { runWindowsPipeNamespaceProbe, WindowsPipeNamespaceCleanupError } from "../fixtures/windows-pipe-namespace-proof";

const required = process.env.EMBER_PIPE_NAMESPACE_PROBE === "1";
const available = required && process.platform === "win32" && process.arch === "x64";
describe.skipIf(!available && !required)("fixed current-vsLOCAL pipe namespace prerequisite", () => {
  let parent = "", retained = false;
  let input: Parameters<typeof runWindowsPipeNamespaceProbe>[0];
  beforeAll(() => {
    try {
    if (!available) throw new Error("The required pipe namespace prerequisite needs Windows x64.");
    const buildRoot = process.env.EMBER_PIPE_NAMESPACE_BUILD_ROOT ?? "", commit = process.env.GITHUB_SHA ?? "", image = process.env.EMBER_PIPE_NAMESPACE_IMAGE;
    if (!/^[A-Za-z]:\\/.test(buildRoot) || !/^[0-9a-f]{40}$/.test(commit) || image !== "windows-2022" && image !== "windows-2025") throw new Error("Select only the exact fixed pipe build and hosted image.");
    const temporary = fs.realpathSync.native(os.tmpdir()), base = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    parent = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "ember-pipe-namespace-native-")));
    input = { parent, buildRoot, commit, image };
    } catch {
      retained = true;
      throw new Error("The fixed pipe prerequisite could not prepare its explicit Windows host inputs.");
    }
  });
  afterAll(() => { if (parent && !retained) fs.rmSync(parent, { recursive: true, force: true }); });
  let observation: ReturnType<typeof runWindowsPipeNamespaceProbe> | undefined;
  const outcome = () => observation ??= runWindowsPipeNamespaceProbe(input, loadExperimentalWindowsLpacApi()).then(result => {
    console.info("Stopped fixed pipe namespace observations", JSON.stringify(result)); return result;
  }).catch(error => {
    if (error instanceof WindowsPipeNamespaceCleanupError) retained = true;
    throw error;
  });
  for (const namespace of ["current", "local"] as const) {
    it(`connects and closes the ${namespace} pair in the independently observed ordinary host`, async () => {
      const result = await outcome();
      expect(result.host.exitCode).toBe(0); expect(result.host.jobStopped).toBe(true);
      expect(result.host.report).toMatchObject({ role: 0, status: 1, controls: 31 });
      expect(result.host.report[namespace]).toMatchObject({ outcome: 1, code: 0, created: 7, closed: 7, serverInherit: 0, clientInherit: 1, closeComplete: true });
    }, 90_000);
    it(`records one closed ${namespace} attempt under unchanged zero-capability LPAC`, async () => {
      const result = await outcome();
      expect(result.lpac.exitCode).toBe(0); expect(result.lpac.jobStopped).toBe(true);
      expect(result.lpac.report).toMatchObject({ role: 1, status: 1, controls: 31, canaryCode: 5, selfCode: 0, parentReadCode: 5, parentDuplicateCode: 5, parentCreateCode: 5 });
      expect([1, 2]).toContain(result.lpac.report[namespace].outcome);
      expect(result.lpac.report[namespace].closeComplete).toBe(true);
      expect(result.canaryUnchanged).toBe(true); expect(result.noOutput).toBe(true);
    }, 90_000);
  }
});
