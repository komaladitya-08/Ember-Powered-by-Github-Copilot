/** Fixed libuv witness scaffolding only. First producer CI is compile/listing-only; native admission is held. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { runWindowsUvSpawnProbe, windowsUvSpawnFailureReceipt } from "../fixtures/windows-uv-spawn-proof";
import { WindowsUvSpawnCleanupError, windowsUvSpawnScratchLocation } from "../fixtures/windows-uv-spawn-ownership";

const required = process.env.EMBER_UV_SPAWN_PROBE === "1";
const available = required && process.platform === "win32" && process.arch === "x64";
// The actual first MSVC emission must be independently reviewed before any native attempt is admitted.
const nativeEmissionReviewed = false;
describe.skipIf(!required)("fixed observed libuv three-pipe spawn witness", () => {
  let parent = "", retained = false, buildRoot = "", commit = "";
  let pending: ReturnType<typeof runWindowsUvSpawnProbe> | undefined;
  beforeAll(() => {
    if (!available || !nativeEmissionReviewed) throw new Error("The fixed spawn native witness remains held until its actual compiler emission is reviewed.");
    buildRoot = process.env.EMBER_UV_SPAWN_BUILD_ROOT ?? ""; commit = process.env.GITHUB_SHA ?? "";
    if (!/^[A-Za-z]:\\/.test(buildRoot) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("The fixed spawn native build identity is unavailable.");
    const supplied = process.env.RUNNER_TEMP;
    if (!supplied || !/^[A-Za-z]:\\/.test(supplied) || path.win32.normalize(supplied) !== supplied) throw new Error("The fixed spawn witness requires hosted RUNNER_TEMP without fallback.");
    const runner = fs.realpathSync.native(supplied), stat = fs.lstatSync(supplied), managed = fs.realpathSync.native(os.tmpdir());
    if (!stat.isDirectory() || stat.isSymbolicLink() || runner.toLowerCase() !== supplied.toLowerCase()) throw new Error("The native scratch root is not canonical.");
    const candidate = fs.realpathSync.native(fs.mkdtempSync(path.join(runner, "ember-uv-spawn-native-")));
    parent = windowsUvSpawnScratchLocation(runner, managed, candidate);
  });
  afterAll(() => { if (parent && !retained) fs.rmSync(parent, { recursive: true, force: true }); });
  const outcome = () => {
    if (retained) return Promise.reject(new WindowsUvSpawnCleanupError());
    pending ??= runWindowsUvSpawnProbe({ parent, buildRoot, commit }, loadExperimentalWindowsLpacApi())
      .then(value => { console.info("Stopped fixed libuv spawn observations", JSON.stringify(value)); return value; })
      .catch(error => { if (error instanceof WindowsUvSpawnCleanupError) retained = true; const receipt = windowsUvSpawnFailureReceipt(error);
        if (receipt) console.info("Fixed spawn refusal", JSON.stringify(receipt)); throw error; });
    return pending;
  };
  it("requires the ordinary same-route three-pipe child exchange before the LPAC attempt", async () => {
    const result = await outcome();
    expect(result.host.exitCode).toBe(0); expect(result.host.jobStopped).toBe(true); expect(result.host.admitted).toBe(true);
    expect(result.host.identity.sameUser).toBe(true);
    expect(result.host.identity.parent.appContainer).toBe(0); expect(result.host.identity.host.appContainer).toBe(0);
    expect(result.host.report).toMatchObject({ role: 0, status: 1, controls: 31, useful: true, stdinBytes: 12, stdoutBytes: 14, stderrBytes: 0 });
  }, 90_000);
  it("records only a complete stopped LPAC result and keeps a synchronous denial distinct from useful success", async () => {
    const result = await outcome();
    expect(result.lpac.exitCode).toBe(0); expect(result.lpac.jobStopped).toBe(true);
    expect(result.lpac.report).toMatchObject({ role: 1, status: 1, controls: 31 });
    if (result.lpac.report.useful) expect(result.lpac.admitted).toBe(true);
    expect(result.canaryUnchanged).toBe(true); expect(result.noOutput).toBe(true);
  }, 90_000);
});
