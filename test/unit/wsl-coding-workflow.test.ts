/** The manual Windows proof cannot be replaced by portable mocks or silently open product admission. */
import fs from "node:fs";
import { expect, it } from "vitest";
import { WSL_CODING_READINESS } from "../../app/shared/wsl-coding-readiness";

it("keeps native qualification separate, manual and required on both Windows images", () => {
  const source = fs.readFileSync(".github/workflows/wsl-coding-product.yml", "utf8");
  expect(source).toContain("workflow_dispatch:"); expect(source).not.toMatch(/^ {2}(?:push|pull_request):/m);
  expect(source).toContain("image: [windows-2022, windows-2025]");
  expect(source).toContain("EMBER_WSL_CODING_NATIVE_TEST: \"1\"");
  expect(source).toContain("test/integration/wsl-coding-native.test.ts");
  expect(source).toContain("result.numPassedTests !== 1"); expect(source).toContain("result.numPendingTests !== 0");
  expect(source).toContain("persist-credentials: false"); expect(source).not.toContain("continue-on-error");
  expect(source).toContain("permissions:\n  contents: read");
  for (const found of source.matchAll(/uses: ([^\s]+)/g)) expect(found[1]).toMatch(/@[0-9a-f]{40}$/);
  expect(WSL_CODING_READINESS).toMatchObject({ ready: false, proofCommit: null, proofRun: null });
});
it("requires actual PE, interop, socket and whole-writer controls before counting native evidence", () => {
  const source = fs.readFileSync("test/integration/wsl-coding-native.test.ts", "utf8");
  expect(source).toContain("output: output ?? (() => undefined)");
  for (const marker of ["Positive interop control", 'fs.readFileSync(canary, "utf8")', "WSL_INTEROP", "./socket-probe && node interop.cjs",
    "npm run build && npm test", "writers-ready", "requireWslStoppedReceipt", 'connection.call("snapshot")', "await connection.close()"]) expect(source).toContain(marker);
});
