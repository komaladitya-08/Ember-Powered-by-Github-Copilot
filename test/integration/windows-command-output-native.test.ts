/** Separate FIRST output-API witness. Fixed own C only; no Node, ordinary-host, replacement or product claim. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeWindowsCommandOutput, WindowsCommandOutputObservationError, type WindowsCommandOutputProofMode } from "../fixtures/windows-command-output-proof";
import { verifyWindowsCommandOutputRun, WINDOWS_COMMAND_OUTPUT_RUN as run } from "../fixtures/windows-command-output-run";
// @ts-expect-error -- Separate fixed producer authority is a private same-worker branded JavaScript receipt.
import { prepareWindowsCommandOutputProof, verifyWindowsCommandOutputProof } from "../../scripts/experimental/build-windows-command-output-proof.mjs";

const required = process.env.EMBER_WINDOWS_COMMAND_OUTPUT_TEST === "1";
const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
describe.skipIf(!required)("fixed C LPAC production-output owner", () => {
  let asset: { executable: string; module: string }, directory = "", scratch = "", closed = 0, retired = false;
  const expected = { image: process.env.EMBER_WINDOWS_COMMAND_OUTPUT_IMAGE, commit: process.env.GITHUB_SHA };
  const verify = () => {
    const identity = verifyWindowsCommandOutputRun(repository, expected), receipt = verifyWindowsCommandOutputProof(asset, expected);
    if (receipt.issuer !== run.compiledIssuer || receipt.scope !== 1) throw new Error("The fixed output witness requires its own compiled issuer.");
    return identity;
  };
  beforeAll(async () => {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The explicitly required output witness needs Windows x64.");
    verifyWindowsCommandOutputRun(repository, expected);
    directory = path.join(repository, `.ember-command-output-build-${randomUUID()}`);
    asset = await prepareWindowsCommandOutputProof({ destination: directory, ...expected }); verify();
    if (typeof process.env.RUNNER_TEMP !== "string" || !/^[A-Za-z]:\\/.test(process.env.RUNNER_TEMP)) throw new Error("The hosted output witness needs separate canonical runner scratch.");
    // A fresh sibling of the framework's managed temp tree can be retained without global teardown deleting it.
    try { scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(process.env.RUNNER_TEMP), "ember-output-suite-")); }
    catch { throw new Error("The fixed output suite could not establish its own scratch parent."); }
  }, 180_000);
  afterAll(() => {
    // A failed case retains both fixture and build owners. No reset, cleanup retry or later native success substitutes.
    if (!directory || closed !== 3) return;
    verify();
    try { fs.rmdirSync(scratch); fs.rmSync(directory, { recursive: true, force: false }); }
    catch { throw new Error("The known stopped output build scratch could not be removed."); }
  });
  it.each(["natural", "overflow", "cancel"] as const)("requires genuine stopped/closed/clean fixed %s output", async (mode: WindowsCommandOutputProofMode) => {
    if (retired) throw new Error("An earlier fixed output case retained ownership; later cases cannot revalidate or start.");
    try {
      if (!scratch) throw new Error("The fixed output suite has no separate scratch parent.");
      const identity = verify();
      const result = await observeWindowsCommandOutput(asset, () => { verify(); }, scratch, mode);
      expect(result).toMatchObject({ schema: 1, scope: 1, mode, stdinEof: 1, liveOutput: 1, rootOnlyStop: 1, snapshot: 1, seedUnchanged: 1,
        privateCleanup: 1, profileCleanup: 1, emittedCjs: 1 });
      if (mode === "natural") expect(result).toMatchObject({ exitCode: 17, complete: true, reason: "none" });
      else expect(result).toMatchObject({ exitCode: null, complete: false, reason: mode === "overflow" ? "overflow" : "cancelled" });
      closed++;
      // Only authenticated completed facts after full known cleanup leave the private fixture.
      console.info("Stopped fixed LPAC output witness", JSON.stringify({ ...identity, result }));
    } catch (error) {
      retired = true;
      if (error instanceof WindowsCommandOutputObservationError) throw error;
      // eslint-disable-next-line preserve-caught-error -- Native/assertion causes may contain private scratch paths; only fixed outcomes leave this fixture.
      throw new Error("The fixed LPAC output case failed; its owners remain retained and later cases are blocked.");
    }
  }, 90_000);
});
