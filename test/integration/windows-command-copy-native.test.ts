/** Explicit hosted Windows test for the unwired, root-only fresh-tree prerequisite. No project or general commands. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, it, expect } from "vitest";
import { observeWindowsCommandCopy } from "../fixtures/windows-command-copy-proof";
// @ts-expect-error -- Fixed CI-only JavaScript builder has a deliberately closed runtime API, exercised by its portable contracts.
import { prepareWindowsCommandCopyProof, verifyWindowsCommandCopyProof } from "../../scripts/experimental/build-windows-command-copy-proof.mjs";

const required = process.env.EMBER_WINDOWS_COMMAND_COPY_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64";
const repository = fileURLToPath(new URL("../../", import.meta.url));

describe.skipIf(!required)("real Windows root-only copy ownership", () => {
  let asset: { executable: string; module: string }, directory = "";
  const expected = { image: process.env.EMBER_WINDOWS_COMMAND_COPY_IMAGE, commit: process.env.GITHUB_SHA };
  beforeAll(async () => {
    if (!available) throw new Error("The explicitly required native copy witness needs Windows x64.");
    directory = path.join(repository, `.ember-root-copy-build-${randomUUID()}`);
    // Build and verification stay in this worker: issuer identity is not reconstructed from a serialized receipt.
    asset = await prepareWindowsCommandCopyProof({ destination: directory, ...expected });
  }, 180_000);
  it("proves useful root-only edits, protected denials, revoke, stable Stop and complete private cleanup through emitted CJS", async () => {
    if (typeof process.env.RUNNER_TEMP !== "string" || !/^[A-Za-z]:\\/.test(process.env.RUNNER_TEMP)) throw new Error("The hosted root-only witness requires its separate runner scratch parent.");
    const result = await observeWindowsCommandCopy(asset, () => { verifyWindowsCommandCopyProof(asset, expected); }, process.env.RUNNER_TEMP);
    expect(result).toEqual({ schema: 1, scope: 1, usefulOperations: 8, protectedDenials: 12, revokedWorkDenials: 3,
      writerStopped: 1, stableSnapshot: 1, retiredAdmissionRefused: 1, sourceUnchanged: 1, treeCleanup: 1, profileCleanup: 1, emittedCjs: 1 });
    // The build tree contains only fixed public source/PE/CJS, and every program/module pin has now closed.
    try { fs.rmSync(directory, { recursive: true, force: false }); }
    catch { throw new Error("The known stopped root-only build scratch could not be removed."); }
    console.log(JSON.stringify(result));
  }, 90_000);
});
