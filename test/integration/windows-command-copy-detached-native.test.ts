/** One fresh detached-root worker; never replays a failed baseline or reloads its quarantined CJS graph. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, it, expect } from "vitest";
import { observeWindowsCommandCopyDetached } from "../fixtures/windows-command-copy-detached-proof";
import { verifyWindowsRootCopyDetachedRun, WINDOWS_ROOT_COPY_DETACHED_RUN as run } from "../fixtures/windows-command-copy-detached-variant";
// @ts-expect-error -- The unchanged fixed JavaScript producer retains its original same-worker brand and compiled issuer.
import { prepareWindowsCommandCopyProof, verifyWindowsCommandCopyProof } from "../../scripts/experimental/build-windows-command-copy-proof.mjs";

const required = process.env.EMBER_WINDOWS_COMMAND_COPY_DETACHED_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64";
const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));

describe.skipIf(!required)("fixed detached-root copy comparison", () => {
  let asset: { executable: string; module: string }, directory = "";
  const expected = { image: process.env.EMBER_WINDOWS_COMMAND_COPY_DETACHED_IMAGE, commit: process.env.GITHUB_SHA };
  const verify = () => {
    const identity = verifyWindowsRootCopyDetachedRun(repository, expected);
    const receipt = verifyWindowsCommandCopyProof(asset, expected);
    if (receipt.issuer !== run.compiledIssuer) throw new Error("The detached-copy run requires the unchanged compiled issuer.");
    return identity;
  };
  beforeAll(async () => {
    if (!available) throw new Error("The explicitly required detached-copy comparison needs Windows x64.");
    verifyWindowsRootCopyDetachedRun(repository, expected); // Public fixed run inputs are checked before compilation/native work.
    directory = path.join(repository, `.ember-root-copy-build-${randomUUID()}`);
    asset = await prepareWindowsCommandCopyProof({ destination: directory, ...expected });
    verify();
  }, 180_000);
  it("requires unchanged useful/revoked/writer, Stop, private review and cleanup gates under the fixed root flag comparison", async () => {
    if (typeof process.env.RUNNER_TEMP !== "string" || !/^[A-Za-z]:\\/.test(process.env.RUNNER_TEMP)) throw new Error("The hosted detached-copy run requires its separate runner scratch parent.");
    const identity = verify();
    // This is public observed run provenance, not a successful native result or authenticated publisher identity.
    console.info("Fixed detached-copy run identity", JSON.stringify(identity));
    const result = await observeWindowsCommandCopyDetached(asset, () => { verify(); }, process.env.RUNNER_TEMP);
    expect(result).toEqual({ schema: 1, scope: 1, usefulOperations: 8, protectedDenials: 12, revokedWorkDenials: 3,
      writerStopped: 1, stableSnapshot: 1, retiredAdmissionRefused: 1, sourceUnchanged: 1, treeCleanup: 1, profileCleanup: 1, emittedCjs: 1 });
    try { fs.rmSync(directory, { recursive: true, force: false }); }
    catch { throw new Error("The known stopped detached-copy build scratch could not be removed."); }
    console.info("Stopped fixed detached-copy observation", JSON.stringify({ ...identity, result }));
  }, 90_000);
});
