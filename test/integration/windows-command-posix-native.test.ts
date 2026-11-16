/** One fresh fixed-C creator-owner experiment. No baseline retry, project command or production capability. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, it, expect } from "vitest";
import { observeWindowsCommandCreatorOwner } from "../fixtures/windows-command-creator-owner-proof";
import { verifyWindowsCommandPosixRun, WINDOWS_COMMAND_POSIX_RUN as run } from "../fixtures/windows-command-posix-variant";
// @ts-expect-error -- Separately scoped fixed C producer retains its new same-worker compiled issuer/brand.
import { prepareWindowsCommandPosixProof, verifyWindowsCommandPosixProof } from "../../scripts/experimental/build-windows-command-posix-proof.mjs";

const required = process.env.EMBER_WINDOWS_COMMAND_POSIX_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64";
const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));

describe.skipIf(!required)("fixed creator-owner capture, confinement and private normalization", () => {
  let asset: { executable: string; module: string }, directory = "";
  const expected = { image: process.env.EMBER_WINDOWS_COMMAND_POSIX_IMAGE, commit: process.env.GITHUB_SHA };
  const verify = () => {
    const identity = verifyWindowsCommandPosixRun(repository, expected), receipt = verifyWindowsCommandPosixProof(asset, expected);
    if (receipt.issuer !== run.compiledIssuer || receipt.scope !== 2) throw new Error("The creator-owner run requires its separate compiled issuer and scope.");
    return identity;
  };
  beforeAll(async () => {
    if (!available) throw new Error("The explicitly required creator-owner experiment needs Windows x64.");
    verifyWindowsCommandPosixRun(repository, expected);
    directory = path.join(repository, `.ember-creator-posix-build-${randomUUID()}`);
    asset = await prepareWindowsCommandPosixProof({ destination: directory, ...expected }); verify();
  }, 180_000);
  it("requires host-positive and in-run ACL denials, genuine creator/Stop authority, useful work and complete private cleanup", async () => {
    if (typeof process.env.RUNNER_TEMP !== "string" || !/^[A-Za-z]:\\/.test(process.env.RUNNER_TEMP)) throw new Error("The hosted creator-owner experiment requires its separate runner scratch parent.");
    const identity = verify(); console.info("Fixed LPAC POSIX run identity", JSON.stringify(identity));
    const result = await observeWindowsCommandCreatorOwner(asset, () => { verify(); }, process.env.RUNNER_TEMP);
    expect(result).toEqual({ schema: 2, scope: 2, usefulOperations: 8, protectedDenials: 12, revokedWorkDenials: 3,
      writerStopped: 1, stableSnapshot: 1, retiredAdmissionRefused: 1, sourceUnchanged: 1, treeCleanup: 1, profileCleanup: 1, emittedCjs: 1,
      hostAclControls: 4, inRunAclDenials: 4, creatorAttested: 1, privateOwnerVerified: 1 });
    try { fs.rmSync(directory, { recursive: true, force: false }); }
    catch { throw new Error("The known stopped creator-owner build scratch could not be removed."); }
    console.info("Stopped fixed LPAC POSIX observation", JSON.stringify({ ...identity, result }));
  }, 120_000);
});
