// Builds the Electron app into dist/app:
//   main.cjs (main process), preload/*.cjs (sandboxed preloads), renderer/<page>/ (bundled pages),
//   desk-agent.cjs, voice.cjs, tts.cjs, ax-sidecar.cjs, askpass.cjs, remote-link.cjs and job-host.cjs (helpers Ember runs
//   as plain Node)
// and the remote agent into dist/remote: ember-remote.cjs (plain Node, run on computers reached over SSH) and
// meta.json (esbuild's metafile, which the agent's bundle test checks).
import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const out = new URL("dist/app/", root);
const remoteOut = new URL("dist/remote/", root);
const common = { bundle: true, sourcemap: true, logLevel: "info", absWorkingDir: fileURLToPath(root) };

const pages = ["home", "overlay", "handle", "ask", "mic", "desk", "command", "prompt"];

// The remote agent's bundle takes app/remote/capture-stub.ts wherever code imports app/main/perception/capture.ts, so
// sharp's loader never enters it (§5.2.2). esbuild's own `alias` maps package names only, so this plugin maps the file.
const captureFile = fileURLToPath(new URL("app/main/perception/capture.ts", root));
const captureStub = fileURLToPath(new URL("app/remote/capture-stub.ts", root));
const remoteCaptureStub = {
  name: "remote-capture-stub",
  setup(b) {
    b.onResolve({ filter: /(^|[\\/])capture(\.ts)?$/ }, args => {
      if (!args.path.startsWith(".")) return undefined;
      const p = path.resolve(args.resolveDir, args.path);
      return p === captureFile || `${p}.ts` === captureFile ? { path: captureStub } : undefined;
    });
  },
};

await rm(out, { recursive: true, force: true });
await rm(remoteOut, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await mkdir(remoteOut, { recursive: true });

// The remote agent: plain Node 24 on the remote, koffi beside it (loaded lazily, only by the desktop child).
const remote = build({
  ...common,
  entryPoints: ["app/remote/main.ts"],
  outfile: "dist/remote/ember-remote.cjs",
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["koffi"],
  plugins: [remoteCaptureStub],
  metafile: true,
});

await Promise.all([
  remote,
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
  // The accessibility host on Windows and macOS (app/sidecar-host): Ember's own binary runs it as plain Node on Windows,
  // and as a utility process on macOS (review #177); it speaks the Python AT-SPI sidecar's protocol. It never imports
  // electron.
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
  // Ember's voice (the neural voice's utility process; sherpa-onnx WASM stays external, as for voice.cjs).
  build({
    ...common,
    entryPoints: ["app/voice/tts-process.ts"],
    outfile: "dist/app/tts.cjs",
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "sherpa-onnx"],
  }),
  // SSH's askpass helper (Linux and macOS PCs), the link worker thread, and the Windows job host for commands: plain
  // Node, never electron.
  ...[
    ["app/askpass/main.ts", "dist/app/askpass.cjs"],
    ["app/main/remote/link-worker.ts", "dist/app/remote-link.cjs"],
    ["app/main/commands/run/job-host.ts", "dist/app/job-host.cjs"],
  ].map(([entry, outfile]) => build({
    ...common,
    entryPoints: [entry],
    outfile,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "koffi"],
  })),
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
// The command window's terminal styles (@xterm/xterm, MIT). Without the package installed the build goes on: only the
// command window lacks them.
await cp(new URL("node_modules/@xterm/xterm/css/xterm.css", root), new URL("renderer/command/xterm.css", out)).catch(err => {
  if (err.code !== "ENOENT") throw err;
  console.warn("warning: node_modules/@xterm/xterm/css/xterm.css is missing (run npm ci): the command window has no terminal styles");
});
// The icon Ember's windows carry on Linux (windows.ts WINDOW_ICON), from the same SVG as the packages' icons. Without
// sharp the build goes on: only the windows lack an icon where no .desktop entry gives them one.
await import("./package/icon.mjs")
  .then(icon => icon.writePng(fileURLToPath(new URL("assets/ember.svg", root)), fileURLToPath(new URL("ember.png", out)), 256))
  .catch(err => console.warn(`warning: dist/app/ember.png wasn't made (${err.message}): Ember's windows on Linux have no icon`));
await writeFile(new URL("meta.json", remoteOut), JSON.stringify((await remote).metafile));
