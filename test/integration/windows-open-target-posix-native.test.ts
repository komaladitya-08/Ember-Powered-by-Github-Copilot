/** Separate manual ordinary-host comparison. Original creator proof and product gates remain unchanged. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { observeWindowsOpenTargetPosix } from "../fixtures/windows-open-target-posix-proof";
import { verifyWindowsOpenTargetPosixRun, WINDOWS_OPEN_TARGET_POSIX_RUN as run } from "../fixtures/windows-open-target-posix-run";
// @ts-expect-error -- The separate fixed producer has a private same-worker compiled brand.
import { prepareWindowsOpenTargetPosixProof, verifyWindowsOpenTargetPosixProof } from "../../scripts/experimental/build-windows-open-target-posix.mjs";

const required = process.env.EMBER_WINDOWS_OPEN_TARGET_POSIX_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64";
const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
describe.skipIf(!required)("ordinary-host POSIX open-target comparison", () => {
  let asset: { executable: string; module: string }, directory = "";
  const expected = { image: process.env.EMBER_WINDOWS_OPEN_TARGET_POSIX_IMAGE, commit: process.env.GITHUB_SHA };
  const verify = () => {
    const identity = verifyWindowsOpenTargetPosixRun(repository, expected), receipt = verifyWindowsOpenTargetPosixProof(asset, expected);
    if (receipt.issuer !== run.compiledIssuer || receipt.scope !== 1) throw new Error("The ordinary-host comparison requires its separate compiled issuer.");
    return identity;
  };
  beforeAll(async () => {
    if (!available) throw new Error("The explicitly required open-target control needs Windows x64.");
    verifyWindowsOpenTargetPosixRun(repository, expected);
    directory = path.join(repository, `.ember-open-target-posix-build-${randomUUID()}`);
    asset = await prepareWindowsOpenTargetPosixProof({ destination: directory, ...expected }); verify();
  }, 180_000);
  it("requires valid unpinned A, equal initial security, retained B and genuine Stop before observing its outcome", async () => {
    if (typeof process.env.RUNNER_TEMP !== "string" || !/^[A-Za-z]:\\/.test(process.env.RUNNER_TEMP)) throw new Error("The hosted control requires its separate canonical runner scratch parent.");
    const identity = verify(); console.info("Fixed ordinary-host POSIX identity", JSON.stringify(identity));
    const result = await observeWindowsOpenTargetPosix(asset, () => { verify(); }, process.env.RUNNER_TEMP);
    expect(result).toMatchObject({ schema: 2, scope: 1, parameterEquivalent: 1, ordinaryHost: 1, rootOnlyStop: 1,
      equalInitialState: 1, aNeverPinned: 1, bHeldThroughStop: 1, privateCleanup: 1, newSourceIdentityMatched: 1, oldIdentityVerified: 1, oldSecurityVerified: 1, oldStreamsVerified: 1, report: { a: { success: 1, error: 0 } } });
    try { fs.rmSync(directory, { recursive: true, force: false }); }
    catch { throw new Error("The known stopped control build scratch could not be removed."); }
    console.info("Stopped ordinary-host POSIX comparison", JSON.stringify({ ...identity, result }));
  }, 90_000);
});
