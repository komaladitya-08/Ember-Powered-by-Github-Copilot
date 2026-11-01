// Builds and runs the AI command review's gate (eval/src/review-gate.ts). See there for options and what it needs.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outfile = path.join(root, "dist/eval/review-gate.cjs");
await build({ entryPoints: [path.join(root, "eval/src/review-gate.ts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["@github/copilot-sdk", "electron", "koffi", "sharp"], logLevel: "error" });
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
