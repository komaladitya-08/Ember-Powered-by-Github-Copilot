// Builds the Electron app into dist/app:
//   main.cjs (main process), preload/*.cjs (sandboxed preloads), renderer/<page>/ (bundled pages)
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const out = new URL("dist/app/", root);
const common = { bundle: true, sourcemap: true, logLevel: "info", absWorkingDir: root.pathname };

const pages = ["home", "overlay", "handle", "ask"];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await Promise.all([
  build({
    ...common,
    entryPoints: ["app/main/main.ts"],
    outfile: "dist/app/main.cjs",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "koffi", "@github/copilot-sdk", "sharp"],
  }),
  build({
    ...common,
    entryPoints: pages.map(p => ({ in: `app/preload/${p}.ts`, out: p })),
    outdir: "dist/app/preload",
    outExtension: { ".js": ".cjs" },
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  }),
  ...pages.map(p => build({
    ...common,
    entryPoints: [`app/renderer/${p}/main.ts`],
    outfile: `dist/app/renderer/${p}/main.js`,
    platform: "browser",
    format: "iife",
    target: "chrome140",
  })),
]);

for (const p of pages) {
  for (const f of ["index.html", "styles.css"]) {
    await cp(new URL(`app/renderer/${p}/${f}`, root), new URL(`renderer/${p}/${f}`, out));
  }
}
