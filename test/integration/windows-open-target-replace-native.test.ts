/** Separate manual ordinary-host comparison. Original creator proof and product gates remain unchanged. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { observeWindowsOpenTargetReplace } from "../fixtures/windows-open-target-replace-proof";
import { verifyWindowsOpenTargetReplaceRun, WINDOWS_OPEN_TARGET_REPLACE_RUN as run } from "../fixtures/windows-open-target-replace-run";
// @ts-expect-error -- The separate fixed producer has a private same-worker compiled brand.
import { prepareWindowsOpenTargetReplaceProof, verifyWindowsOpenTargetReplaceProof } from "../../scripts/experimental/build-windows-open-target-replace.mjs";

const required = process.env.EMBER_WINDOWS_OPEN_TARGET_REPLACE_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64";
const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
describe.skipIf(!required)("ordinary-host parameter-equivalent open-target comparison", () => {
  let asset: { executable: string; module: string }, directory = "";
  const expected = { image: process.env.EMBER_WINDOWS_OPEN_TARGET_REPLACE_IMAGE, commit: process.env.GITHUB_SHA };
  const verify = () => {
    const identity = verifyWindowsOpenTargetReplaceRun(repository, expected), receipt = verifyWindowsOpenTargetReplaceProof(asset, expected);
    if (receipt.issuer !== run.compiledIssuer || receipt.scope !== 1) throw new Error("The ordinary-host comparison requires its separate compiled issuer.");
    return identity;
  };
  beforeAll(async () => {
    if (!available) throw new Error("The explicitly required open-target control needs Windows x64.");
    verifyWindowsOpenTargetReplaceRun(repository, expected);
    directory = path.join(repository, `.ember-open-target-build-${randomUUID()}`);
    asset = await prepareWindowsOpenTargetReplaceProof({ destination: directory, ...expected }); verify();
  }, 180_000);
  it("requires valid unpinned A, equal initial security, retained B and genuine Stop before observing its outcome", async () => {
    if (typeof process.env.RUNNER_TEMP !== "string" || !/^[A-Za-z]:\\/.test(process.env.RUNNER_TEMP)) throw new Error("The hosted control requires its separate canonical runner scratch parent.");
    const identity = verify(); console.info("Fixed ordinary-host open-target identity", JSON.stringify(identity));
    const result = await observeWindowsOpenTargetReplace(asset, () => { verify(); }, process.env.RUNNER_TEMP);
    expect(result).toMatchObject({ schema: 1, scope: 1, parameterEquivalent: 1, ordinaryHost: 1, rootOnlyStop: 1,
      equalInitialState: 1, aNeverPinned: 1, bHeldThroughStop: 1, privateCleanup: 1, report: { a: { success: 1, error: 0 } } });
    try { fs.rmSync(directory, { recursive: true, force: false }); }
    catch { throw new Error("The known stopped control build scratch could not be removed."); }
    console.info("Stopped ordinary-host open-target comparison", JSON.stringify({ ...identity, result }));
  }, 90_000);
});
