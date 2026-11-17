/** The manual Windows proof cannot be replaced by portable mocks or silently open product admission. */
import fs from "node:fs";
import { expect, it } from "vitest";
import { WSL_CODING_READINESS } from "../../app/shared/wsl-coding-readiness";

it("keeps native qualification separate, manual and required on both Windows images", () => {
  const source = fs.readFileSync(".github/workflows/wsl-coding-product.yml", "utf8");
  expect(source).toContain("workflow_dispatch:"); expect(source).toContain("  pull_request:"); expect(source).not.toMatch(/^ {2}push:/m);
  const native = source.slice(source.indexOf("  native:"));
  expect(native).toContain("if: github.event_name == 'workflow_dispatch' && github.ref_name == 'ember-improve/20261116-windows-node-product'");
  expect(native).toContain("needs: contracts");
  const contracts = source.slice(source.indexOf("  contracts:"), source.indexOf("  native:"));
  expect(contracts).toContain("test/unit/wsl-coding-protocol.test.ts test/unit/wsl-coding-seccomp.test.ts test/unit/wsl-coding-workflow.test.ts --maxWorkers=1");
  expect(contracts).not.toContain("wsl.exe"); expect(contracts).not.toContain("EMBER_WSL_CODING_NATIVE_TEST");
  expect(source).toContain("image: [windows-2022, windows-2025]");
  expect(source).toContain("additional-packages: bubblewrap gcc libc6-dev util-linux");
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
