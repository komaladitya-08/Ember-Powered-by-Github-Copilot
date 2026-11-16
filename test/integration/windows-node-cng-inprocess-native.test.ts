/** Separate fixed in-process source-image experiment. The six older default-isolation assertions remain unchanged. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import artifactPin from "../../scripts/experimental/windows-node-cng-artifact-pin.json";
import { runWindowsNodeCngInprocessProbe, windowsNodeCngInprocessFailureReceipt, WindowsNodeCngInprocessCleanupError } from "../fixtures/windows-node-cng-inprocess-proof";

const required = process.env.EMBER_NODE_CNG_INPROCESS_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64";
const within = (root: string, candidate: string) => {
  const relative = path.win32.relative(root.toLowerCase(), candidate.toLowerCase());
  return relative === "" || !path.win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\");
};
describe.skipIf(!required)("separate CNG source Node explicit in-process test pair", () => {
  let parent = "", retained = false, buildRoot = "", runCommit = "";
  let outcome: ReturnType<typeof runWindowsNodeCngInprocessProbe> | undefined;
  beforeAll(() => {
    if (!available) throw new Error("The explicitly required fixed in-process test needs Windows x64.");
    const runner = process.env.RUNNER_TEMP;
    buildRoot = process.env.EMBER_NODE_SOURCE_BUILD_ROOT ?? ""; runCommit = process.env.GITHUB_SHA ?? "";
    if (!runner || !/^[A-Za-z]:\\/.test(runner) || !/^[A-Za-z]:\\/.test(buildRoot) ||
        process.env.EMBER_NODE_SOURCE_BUILD_COMMIT !== artifactPin.compileCommit || !/^[0-9a-f]{40}$/.test(runCommit))
      throw new Error("Use only the fixed authenticated source build and hosted run identities.");
    try {
      parent = fs.mkdtempSync(path.join(fs.realpathSync.native(runner), "ember-cng-inprocess-native-"));
      const managed = fs.realpathSync.native(os.tmpdir()), actual = fs.realpathSync.native(parent);
      if (within(managed, actual) || within(actual, managed)) {
        fs.rmdirSync(parent); parent = ""; throw new Error();
      }
    } catch { retained = parent !== ""; throw new Error("The fixed native fixture could not establish separate canonical scratch."); }
  });
  afterAll(() => {
    if (!parent || retained) return;
    try { fs.rmdirSync(parent); }
    catch { retained = true; throw new Error("The known empty native fixture parent could not be removed."); }
  });
  const result = () => outcome ??= Promise.resolve().then(() => runWindowsNodeCngInprocessProbe({ parent, buildRoot, buildCommit: artifactPin.compileCommit, runCommit }, loadExperimentalWindowsLpacApi()))
    .then(value => { console.info("Stopped fixed source Node in-process pair", JSON.stringify(value)); return value; })
    .catch(error => {
      if (error instanceof WindowsNodeCngInprocessCleanupError) retained = true;
      const facts = windowsNodeCngInprocessFailureReceipt(error); if (facts) console.info("Stopped fixed in-process failure", JSON.stringify(facts));
      if (error instanceof WindowsNodeCngInprocessCleanupError) throw error;
      throw new Error("The separate fixed in-process native test failed; no useful result was accepted.");
    });
  it("requires one fixed test in the parent's observed ordinary context and complete cleanup", async () => {
    const value = await result();
    expect(value.issuer).toBe("ember-experimental-source-node-cng-inprocess"); expect(value.cleanupComplete).toBe(true);
    expect(value.host.exitCode).toBe(0); expect(value.host.jobStopped).toBe(true); expect(value.host.identity.sameUser).toBe(true);
    expect(value.host.identity.host).toEqual(value.host.identity.parent);
    expect(value.host.report).toMatchObject({ role: 0, status: 1, tests: 1, features: 15 });
  }, 90_000);
  it("requires one fixed copied-module test under zero-capability LPAC with explicit in-process isolation", async () => {
    const value = await result();
    expect(value.lpac.exitCode).toBe(0); expect(value.lpac.jobStopped).toBe(true); expect(value.cleanupComplete).toBe(true);
    expect(value.lpac.report).toMatchObject({ role: 1, status: 1, tests: 1, features: 15, moduleValue: 42, readBytes: 21, fsCallbacks: 1, timerCallbacks: 1 });
    expect(value.lpac.output).toEqual({ bytes: 0, empty: true, discovery: 0 });
  }, 90_000);
});
