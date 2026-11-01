// Builds and runs the bare-name keyword tuner (eval/src/tune.ts) on recorded real voices. See there for options.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist/eval/tune.cjs");
await build({ entryPoints: [path.join(root, "eval/src/tune.ts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["sherpa-onnx", "electron"], logLevel: "error" });
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
