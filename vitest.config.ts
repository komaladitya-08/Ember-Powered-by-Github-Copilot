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
    include: ["test/unit/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
  },
});
