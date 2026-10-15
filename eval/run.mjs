// Builds the evaluation (eval/src, TypeScript) and runs it with Node. See eval/src/main.ts for options.
// usage: node eval/run.mjs [--live] [--repeat N] [--only id,id] [--tag tag] [--out dir] [--no-gates] [--no-tasks]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outfile = path.join(root, "dist/eval/eval.cjs");
await build({
  entryPoints: [path.join(root, "eval/src/main.ts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["koffi", "@github/copilot-sdk", "sharp", "sherpa-onnx", "electron"], logLevel: "error",
  // main.ts finds the repository from its own folder (dist/eval → ../..).
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
