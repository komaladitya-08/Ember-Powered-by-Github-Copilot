/** Fixed native asset DACL proof only. Does not exercise the project coordinator, model, Home or arbitrary input. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageWindowsNodeToolchain, verifyWindowsNodeToolchain, WINDOWS_NODE_TOOLCHAIN_DIRECTORY } from "../../scripts/package/windows-node-toolchain.mjs";
import { observeWindowsNodeAssetEnforcement, WindowsNodeAssetEnforcementObservationError, type WindowsNodeAssetEnforcementMode } from "../fixtures/windows-node-asset-enforcement-proof";
import { verifyWindowsNodeAssetEnforcementRun, WINDOWS_NODE_ASSET_ENFORCEMENT_RUN as run } from "../fixtures/windows-node-asset-enforcement-run";
// @ts-expect-error -- This separate JavaScript builder owns a same-worker private branded receipt.
import { prepareWindowsNodeAssetEnforcement, verifyWindowsNodeAssetEnforcement } from "../../scripts/experimental/build-windows-node-asset-enforcement.mjs";

const required = process.env.EMBER_WINDOWS_NODE_ASSET_ENFORCEMENT_TEST === "1";
const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
describe.skipIf(!required)("fixed production Node asset enforcement", () => {
  let asset: { executable: string; module: string; program: string }, directory = "", resources = "", producer = "", scratch = "", closed = 0, retired = false;
  const expected = { image: process.env.EMBER_WINDOWS_NODE_ASSET_ENFORCEMENT_IMAGE, commit: process.env.GITHUB_SHA };
  const verify = () => {
    const identity = verifyWindowsNodeAssetEnforcementRun(repository, expected), receipt = verifyWindowsNodeAssetEnforcement(asset, expected);
    if (receipt.issuer !== run.compiledIssuer || receipt.scope !== 4) throw new Error("The native asset witness requires its own compiled issuer.");
    return identity;
  };
  // Full producer/package scans run only when no native child is held. Pre-Resume checks remain bounded.
  const verifyToolchain = () => { verifyWindowsNodeToolchain(producer, "producer"); verifyWindowsNodeToolchain(path.join(resources, WINDOWS_NODE_TOOLCHAIN_DIRECTORY), "package"); };
  beforeAll(async () => {
    try {
      if (process.platform !== "win32" || process.arch !== "x64") throw new Error();
      verifyWindowsNodeAssetEnforcementRun(repository, expected);
      if (typeof process.env.EMBER_WINDOWS_NODE_ASSET_ENFORCEMENT_PRODUCER !== "string" || typeof process.env.RUNNER_TEMP !== "string") throw new Error();
      producer = fs.realpathSync.native(process.env.EMBER_WINDOWS_NODE_ASSET_ENFORCEMENT_PRODUCER);
      directory = path.join(repository, `.ember-node-asset-enforcement-build-${randomUUID()}`);
      asset = await prepareWindowsNodeAssetEnforcement({ destination: directory, ...expected });
      resources = path.join(directory, "resources"); fs.mkdirSync(resources); fs.mkdirSync(path.join(resources, "coding"));
      stageWindowsNodeToolchain(producer, path.join(resources, WINDOWS_NODE_TOOLCHAIN_DIRECTORY)); verifyToolchain(); verify();
      scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(process.env.RUNNER_TEMP), "ember-node-assets-suite-"));
    } catch {
      retired = true;
      // Source/native messages can contain private build paths.
      throw new Error("The fixed native asset witness setup failed; its owners remain retained.");
    }
  }, 180_000);
  afterAll(() => {
    if (!directory || closed !== run.cases.length) return;
    try { verify(); verifyToolchain(); fs.rmdirSync(scratch); fs.rmSync(directory, { recursive: true, force: false }); }
    catch {
      // Only closed fixed facts may leave this fixture.
      throw new Error("The known stopped native asset build could not be retired.");
    }
  });
  it.each(run.cases)("requires real asset enforcement, lifecycle and known cleanup for %s", async (mode: WindowsNodeAssetEnforcementMode) => {
    if (retired) throw new Error("An earlier native asset case retained ownership; later cases cannot reset or start.");
    try {
      if (!scratch) throw new Error(); const identity = verify();
      const result = await observeWindowsNodeAssetEnforcement(asset, () => { verify(); }, resources, scratch, mode);
      expect(result).toMatchObject({ schema: 4, scope: 4, mode, rootOnlyStop: 1, snapshot: 1, seedUnchanged: 1, assetCleanup: 1, privateCleanup: 1, profileCleanup: 1, emittedCjs: 1 });
      if (mode === "natural" || mode === "natural-default") expect(result).toMatchObject({ exitCode: 17, complete: true, reason: "none", prelude: 1, deniedAccess: 524287, positiveAccess: 8191, deniedChecks: 19, positiveChecks: 13, daclPairs: 2, actualNode: 1, parentDefault: mode === "natural-default" ? 1 : 0 });
      else expect(result).toMatchObject({ exitCode: null, complete: false, reason: mode === "overflow" ? "overflow" : "cancelled", prelude: 0 });
      expect(result.rootPresent).toBe(mode === "precreate" ? 0 : 1); expect(result.actualNode).toBe(mode === "precreate" || mode === "preresume" || mode === "sharedcreate" ? 0 : 1);
      expect(result.outputClosed).toBe(mode === "precreate" ? 0 : 1); expect(result.stdinEof).toBe(result.actualNode);
      verifyToolchain(); closed++; console.info("Stopped fixed native Node asset witness", JSON.stringify({ ...identity, result }));
    } catch (error) {
      retired = true; if (error instanceof WindowsNodeAssetEnforcementObservationError) throw error;
      // eslint-disable-next-line preserve-caught-error -- Assertions may retain paths or opaque native references.
      throw new Error("The fixed native asset case failed; owners remain retained and later cases are blocked.");
    }
  }, 120_000);
});
