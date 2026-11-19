/** Supported native resources/coordinator/review path only. Home/SDK and packaged journeys have separate proofs. */
import { describe, it, expect } from "vitest";
import { WINDOWS_NODE_PRODUCT_NATIVE_CASES, runWindowsNodeProductNativeCase } from "../fixtures/windows-node-product-native";

const required = process.env.EMBER_WINDOWS_NODE_PRODUCT_TEST === "1";
// Normal developer runs skip this opt-in proof. An explicitly required Linux run fails its first pure platform gate.
describe.skipIf(!required)("native Windows Node product resources", () => {
  it.each(WINDOWS_NODE_PRODUCT_NATIVE_CASES)("closes the actual %s resource journey", async mode => {
    const result = await runWindowsNodeProductNativeCase(mode);
    expect(result).toMatchObject({ schema: 1, case: mode, stdinEof: 1, retired: 1, adopted: 1, published: 1,
      exported: 1, forgotten: 1, sourceUnchanged: 1, protectedUnchanged: 1, outputClosed: 1, completeCleanup: 1 });
    expect([2022, 2025]).toContain(result.image); expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    if (mode === "natural-repair") {
      expect(result).toMatchObject({ runs: 2, firstExit: 17, finalExit: 0, checksRan: 2, checksPassed: 1, checksFailed: 1, heldTargetRename: 1, stopped: 0 });
      expect(result.stdoutBytes).toBeGreaterThan(64 * 1024); expect(result.stderrBytes).toBeGreaterThan(64 * 1024);
    } else expect(result).toMatchObject({ runs: 1, checksRan: 0, checksPassed: 0, checksFailed: 0, heldTargetRename: 0, stopped: 1 });
    // Only the closed result leaves the fixture. Raw errors, child output, paths, handles and SIDs stay private.
    console.info("Windows Node product native closed facts", JSON.stringify(result));
  }, 240_000);
});
