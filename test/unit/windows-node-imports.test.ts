/** Production-style module initialization only. No issuer is replaced and no Native factory is called. */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it.each([
  ["windows-node-workspace", "WindowsNodeWorkspace"],
  ["windows-coding-resources", "WindowsProjectCodingResources"],
  ["windows-node-coding-platform", "windowsNodeCodingPlatform"],
] as const)("initializes the real CommonJS graph from %s before any Native load", async (entry, exported) => {
  const emitted = await build({ stdin: { contents: `export { ${exported} } from "./app/main/agent/${entry}";`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, platform: "node", format: "cjs", target: "node24", write: false, logLevel: "silent",
    external: ["koffi", "@github/copilot-sdk", "sharp", "electron"], define: { __EMBER_CODING_PRIVACY_WORKER_SOURCE__: JSON.stringify("") } });
  const module = { exports: {} as Record<string, unknown> }, hostRequire = createRequire(import.meta.url);
  let nativeLoads = 0;
  runInNewContext(emitted.outputFiles[0].text, { module, exports: module.exports,
    require: (name: string) => { if (name === "koffi") { nativeLoads++; throw new Error("A module import cannot load Native bindings"); } return hostRequire(name); },
    process, Buffer, AbortController, AbortSignal, setTimeout, clearTimeout, setImmediate, clearImmediate, structuredClone,
    __filename: "/fixed/windows-node-entry.cjs", __dirname: "/fixed" });
  expect(module.exports[exported]).toBeDefined(); expect(nativeLoads).toBe(0);
});
