/** The manual Windows proof cannot be replaced by portable mocks or silently open product admission. */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { WSL_CODING_READINESS } from "../../app/shared/wsl-coding-readiness";
import { codingNodeCandidates } from "../../app/main/agent/coding-toolchain";

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
  // The realpath, not just the /usr/bin alias, must stay in discovery's fixed supported system prefixes.
  for (const marker of ["test ! -e /opt/node", "test ! -L /opt/node", "install -d -m 755 /opt/node",
    'tar -xJf "$archive" -C /opt/node --strip-components=1', "chown -R root:root /opt/node", "chmod -R go-w /opt/node",
    "test -f /opt/node/bin/node", "test ! -L /opt/node/bin/node", "test ! -L /usr/bin/node", "ln -s /opt/node/bin/node /usr/bin/node",
    'test "$(readlink -f /usr/bin/node)" = /opt/node/bin/node']) expect(native).toContain(marker);
  expect(native).not.toContain("/opt/ember-wsl-coding-node");
  for (const found of source.matchAll(/uses: ([^\s]+)/g)) expect(found[1]).toMatch(/@[0-9a-f]{40}$/);
  expect(WSL_CODING_READINESS).toEqual({
    ready: true,
    proofCommit: "20300c7104003cbb865871821454b7807d0178ab",
    proofRun: 44110658272,
    message: "Supported Node, npm and TypeScript commands are available in your selected WSL2 distribution. That distribution's consent and approval settings still apply.",
  });
  expect(Object.isFrozen(WSL_CODING_READINESS)).toBe(true);
});
it("requires actual PE, interop, socket and whole-writer controls before counting native evidence", () => {
  const source = fs.readFileSync("test/integration/wsl-coding-native.test.ts", "utf8");
  expect(source).toContain("output: output ?? (() => undefined)");
  for (const marker of ["Positive interop control", 'fs.readFileSync(canary, "utf8")', "WSL_INTEROP", "./socket-probe && node interop.cjs",
    "npm run build && npm test", "writers-ready", "requireWslStoppedReceipt", 'connection.call("snapshot")', "await connection.close()"]) expect(source).toContain(marker);
});
it.skipIf(process.platform !== "linux")("accepts the qualification runtime's resolved system prefix and rejects the former unsupported prefix and its aliases", () => {
  const qualified = "/opt/node/bin/node", prior = "/opt/ember-wsl-coding-node/bin/node";
  const actual = codingNodeCandidates({ execPath: qualified, isElectron: false, env: { PATH: "/opt/node/bin" } });
  expect(actual).toContain(qualified);
  for (const rejected of [prior, "/opt/node-shadow/bin/node"]) {
    expect(codingNodeCandidates({ execPath: rejected, isElectron: false, env: { PATH: path.dirname(rejected) } })).not.toContain(rejected);
  }
  // An allowed-looking launcher alias does not itself add the resolved target to the candidate policy.
  const aliases = codingNodeCandidates({ execPath: "/usr/bin/node", isElectron: false, env: { PATH: path.dirname(prior) } });
  expect(aliases).toContain("/usr/bin/node"); expect(aliases).not.toContain(prior);
});
