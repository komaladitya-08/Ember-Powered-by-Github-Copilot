import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@ember/characters": pkg("characters"),
      "@ember/bubble": pkg("bubble"),
      "@ember/motion": pkg("motion"),
    },
  },
  test: {
    include: process.env.EMBER_INTEGRATION ? ["test/integration/**/*.test.ts"] : ["test/unit/**/*.test.ts", "packages/**/*.test.ts"],
    fileParallelism: !process.env.EMBER_INTEGRATION,
    environment: "node",
    // Builds fontconfig's cache before the tests that draw Ember's marks (test/warm-text.ts).
    // Gives the run its own temporary folder and removes it, and vitest's module cache, at the end (test/temp-folder.ts).
    globalSetup: ["test/temp-folder.ts", "test/warm-text.ts"],
    // Windows starts processes slowly (antivirus scans each new file) and its timers tick every 15.6 ms, so tests that
    // spawn helpers or chain real waits (worker-scroll's take about 3 s on Linux) get more than the default 5 s there.
    // Their own time bounds still apply.
    ...(process.platform === "win32" ? { testTimeout: 15_000 } : {}),
  },
});
