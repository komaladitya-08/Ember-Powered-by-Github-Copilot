// Builds the Electron app into dist/app:
//   main.cjs (main process), preload/*.cjs (sandboxed preloads), renderer/<page>/ (bundled pages),
//   desk-agent.cjs, voice.cjs and ax-sidecar.cjs (helpers Ember runs as plain Node)
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const out = new URL("dist/app/", root);
const common = { bundle: true, sourcemap: true, logLevel: "info", absWorkingDir: fileURLToPath(root) };

const pages = ["home", "overlay", "handle", "ask", "mic", "desk"];

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
  // The desk helper: every X call on Ember's desk is made in this process, never in Ember's.
  build({
    ...common,
    entryPoints: ["app/main/desk/agent-process.ts"],
    outfile: "dist/app/desk-agent.cjs",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "koffi", "sharp"],
  }),
  // The accessibility host on Windows and macOS (app/sidecar-host): Ember's own binary runs it as plain Node, and it
  // speaks the Python AT-SPI sidecar's protocol. It never imports electron.
  build({
    ...common,
    entryPoints: ["app/sidecar-host/main.ts"],
    outfile: "dist/app/ax-sidecar.cjs",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "koffi", "sharp"],
  }),
  // The voice utility process (sherpa-onnx WASM stays external: it loads its .wasm beside itself).
  build({
    ...common,
    entryPoints: ["app/voice/process.ts"],
    outfile: "dist/app/voice.cjs",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "sherpa-onnx"],
  }),
  build({
    ...common,
    entryPoints: ["app/renderer/mic/worklet.ts"],
    outfile: "dist/app/renderer/mic/worklet.js",
    platform: "browser",
    format: "iife",
    target: "chrome140",
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
    await cp(new URL(`app/renderer/${p}/${f}`, root), new URL(`renderer/${p}/${f}`, out)).catch(err => {
      if (!(f === "styles.css" && err.code === "ENOENT")) throw err;
    });
  }
}
// What every page shares: the design tokens and controls (renderer/shared/ember.css), and the typeface they set
// (Inter, SIL OFL 1.1: its licence ships beside the fonts and in THIRD_PARTY_NOTICES).
await cp(new URL("app/renderer/shared/", root), new URL("renderer/shared/", out), { recursive: true });
await cp(new URL("assets/fonts/", root), new URL("renderer/fonts/", out), { recursive: true });
