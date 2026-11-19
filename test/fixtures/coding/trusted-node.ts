/** Test asset selection stays independent of the CLI running Vitest and uses the unchanged production trust checks. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverCodingToolchain } from "../../../app/main/agent/coding-toolchain";

export interface TrustedCodingTestNode { nodePath: string; version: string }
const selected = new Map<string, Promise<TrustedCodingTestNode | null>>();
const required = () => process.env.EMBER_REQUIRE_CODING_ISOLATION === "1";

/** Required Linux CI proofs fail rather than silently skip when their actual OS boundary is unavailable. */
export function codingTestIsolationSupported(): boolean {
  const probe = spawnSync("/usr/bin/bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  const available = !probe.error && probe.status === 0;
  if (!available && required()) throw new Error("Required coding isolation is unavailable: Bubblewrap could not create a namespace.");
  return available;
}

/** An explicit test asset must itself be accepted; fallback cannot disguise an invalid CI installation. */
export function trustedCodingTestNode(): Promise<TrustedCodingTestNode | null> {
  const configured = process.env.EMBER_TEST_CODING_NODE;
  const search = [configured ? path.dirname(configured) : "", process.env.PATH ?? "", "/usr/bin", "/usr/local/bin", "/opt/node/bin",
    "/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin"].filter(Boolean).join(path.delimiter);
  const key = JSON.stringify([configured ?? null, process.execPath, search, required()]);
  let pending = selected.get(key);
  if (!pending) {
    pending = (async () => {
      const protectedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ember-trusted-node-fixture-")); await fs.chmod(protectedRoot, 0o700);
      try {
        const result = await discoverCodingToolchain({ env: { PATH: search }, execPath: configured ?? process.execPath,
          isElectron: !!process.versions.electron, protectedPaths: [protectedRoot] });
        if (configured && (!path.isAbsolute(configured) || !result.available || result.nodePath !== await fs.realpath(configured).catch(() => null))) {
          throw new Error("The configured coding test Node was not accepted by the production asset validator.");
        }
        if (result.available && result.nodePath && result.version) return { nodePath: result.nodePath, version: result.version };
        if (required()) throw new Error(`Required coding isolation/toolchain is unavailable. ${result.message}`);
        return null;
      } finally { await fs.rm(protectedRoot, { recursive: true, force: true }); }
    })();
    selected.set(key, pending);
  }
  return pending;
}

/** Call inside the test, before optional namespace probes, so required CI never skips an unavailable trusted asset. */
export async function trustedCodingTestNodeOrSkip(context: { skip(note?: string): never }): Promise<TrustedCodingTestNode> {
  const asset = await trustedCodingTestNode();
  if (!asset) context.skip("A verified Node asset and working coding namespace are unavailable.");
  return asset;
}
