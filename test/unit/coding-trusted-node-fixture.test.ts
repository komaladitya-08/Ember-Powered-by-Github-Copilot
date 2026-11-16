/** Required CI must distinguish unavailable proofs from optional local skips without relaxing asset validation. */
import { afterEach, expect, it, vi } from "vitest";
import { codingTestIsolationSupported, trustedCodingTestNode } from "../fixtures/coding/trusted-node";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: vi.fn(() => ({ status: 1 })) };
});
afterEach(() => { vi.unstubAllEnvs(); });

it("fails an explicitly required isolation proof instead of skipping when namespaces are unavailable", () => {
  vi.stubEnv("EMBER_REQUIRE_CODING_ISOLATION", "1");
  expect(() => codingTestIsolationSupported()).toThrow("Required coding isolation is unavailable");
  vi.stubEnv("EMBER_REQUIRE_CODING_ISOLATION", "0");
  expect(codingTestIsolationSupported()).toBe(false);
});

it("rejects an explicit unverified asset even if another trusted system Node could be discovered", async () => {
  vi.stubEnv("EMBER_TEST_CODING_NODE", "/unavailable/coding-test/node");
  vi.stubEnv("EMBER_REQUIRE_CODING_ISOLATION", "0");
  await expect(trustedCodingTestNode()).rejects.toThrow("configured coding test Node was not accepted");
});
