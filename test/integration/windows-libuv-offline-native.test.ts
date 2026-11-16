/** Fixed verified-source C/library feasibility only. This is neither Node nor a general offline-runtime boundary. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { runWindowsLibuvFixedProbe, windowsLibuvProbeFailureReceipt, WindowsLibuvProbeCleanupError } from "../fixtures/windows-libuv-probe";

describe.skipIf(process.platform !== "win32" || process.env.EMBER_LPAC_LIBUV_PROBE !== "1")("fixed verified-source libuv initialization in capability-free LPAC", () => {
  let parent = "", buildRoot = "", commit = "", retained = false;
  let image: "windows-2022" | "windows-2025";
  const outcomes = new Map<string, ReturnType<typeof runWindowsLibuvFixedProbe>>();
  beforeAll(() => {
    if (process.arch !== "x64") throw new Error("The explicitly configured libuv probe requires Windows x64.");
    buildRoot = process.env.EMBER_LIBUV_BUILD_ROOT ?? ""; commit = process.env.GITHUB_SHA ?? "";
    const selectedImage = process.env.EMBER_LIBUV_BUILD_IMAGE;
    if (selectedImage !== "windows-2022" && selectedImage !== "windows-2025") throw new Error("Select one fixed workflow image recipe.");
    image = selectedImage;
    if (!/^[A-Za-z]:\\/.test(buildRoot) || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("Use only the workflow's fixed build and checked-out commit.");
    const temporary = fs.realpathSync.native(os.tmpdir());
    const base = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    // Global test cleanup must not erase an unverified native fixture.
    parent = fs.mkdtempSync(path.join(base, "ember-libuv-fixed-"));
  });
  afterAll(() => { if (parent && !retained) fs.rmSync(parent, { recursive: true, force: true }); });

  function outcome(variant: "stock" | "offline") {
    let pending = outcomes.get(variant);
    if (!pending) {
      if (retained) return Promise.reject(new WindowsLibuvProbeCleanupError());
      const fresh = fs.mkdtempSync(path.join(parent, `${variant}-`));
      pending = runWindowsLibuvFixedProbe({ parent: fresh, buildRoot, commit, variant, image }, loadExperimentalWindowsLpacApi())
        .then(result => { console.info("Fixed verified-source libuv result", JSON.stringify(result)); return result; })
        .catch(error => {
          if (error instanceof WindowsLibuvProbeCleanupError) retained = true;
          const receipt = windowsLibuvProbeFailureReceipt(error);
          if (receipt) console.info("Fixed libuv stopped failure receipt", JSON.stringify(receipt));
          throw error;
        });
      outcomes.set(variant, pending);
    }
    return pending;
  }
  for (const variant of ["stock", "offline"] as const) {
    it(`runs all fixed useful operations in the separate ${variant} ordinary-host control`, async () => {
      const result = await outcome(variant);
      expect(result.host.exitCode).toBe(0); expect(result.host.jobStopped).toBe(true);
      expect(result.host.report).toMatchObject({ token: 0, stage: 10, status: 1, features: 63, cleanup: 15 });
    }, 90_000);
  }
  it("preserves the separate stock libuv LPAC Winsock failure as an observed control", async () => {
    const result = await outcome("stock");
    expect(result.lpac.exitCode).toBe(0x80000003); expect(result.lpac.jobStopped).toBe(true);
    expect(result.lpac.report).toMatchObject({ build: 0, token: 1, stage: 1, status: 0, features: 0, loopInit: 0xffffffff });
    expect(result.lpac.output.nativeFailure).toEqual({ family: "libuv-win32", operation: "WSAStartup", code: 10107 });
  }, 90_000);
  it("performs only the fixed local operations after compile-time Winsock omission without claiming a generic runtime", async () => {
    const result = await outcome("offline");
    expect(result.lpac.exitCode).toBe(0); expect(result.lpac.jobStopped).toBe(true);
    expect(result.lpac.report).toMatchObject({ build: 1, token: 1, stage: 10, status: 1, features: 63, cleanup: 15 });
    expect(result.lpac.output).toEqual({ output: { status: "no-location", bytes: 0 } });
  }, 90_000);
});
