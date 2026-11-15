// Builds the evaluation (eval/src, TypeScript) and runs it with Node. See eval/src/main.ts for options.
// usage: node eval/run.mjs [--live] [--repeat N] [--only id,id] [--tag tag] [--out dir] [--no-gates] [--no-tasks] [--keep] [--verbose]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --help says the options and stops: it used to be passed on like any other word, which ran all the tasks.
if (process.argv.slice(2).some(a => a === "--help" || a === "-h")) {
  console.log([
    "usage: node eval/run.mjs [--live] [--repeat N] [--only id,id] [--tag tag] [--out dir] [--no-gates] [--no-tasks] [--keep] [--verbose]",
    "",
    "Runs Ember's evaluation (eval/tasks/*.json) and measures the release gates, then writes results.json and",
    "report.html. It drives real windows: give it a display and a session bus (docs/DEVELOPING.md §8).",
    "",
    "  (no options)   the per-PR tier: the scripted model, every task once",
    "  --live         the nightly tier: a real model (EMBER_EVAL_MODEL and a GitHub token or EMBER_EVAL_PROVIDER_URL)",
    "  --repeat N     attempts for each task (default 1; 3 with --live)",
    "  --only id,id   only these tasks",
    "  --tag tag      only tasks with this tag",
    "  --out dir      where the results go (default dist/eval)",
    "  --no-gates     run the tasks without measuring the gates",
    "  --no-tasks     measure the gates without running the tasks",
    "  --keep         keep each attempt's temporary folder",
    "  --verbose      print warnings and errors from Ember's parts as they happen",
  ].join("\n"));
  process.exit(0);
}

// An option it doesn't know stops here: it used to be ignored, so a mistyped --no-gates or --only ran the whole suite
// with the gates, minutes later (install-docs-r9-9). Keep in step with eval/src/main.ts's flag() and opt().
const FLAGS = ["--live", "--no-gates", "--no-tasks", "--keep", "--verbose"];
const VALUES = ["--repeat", "--only", "--tag", "--out"];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (FLAGS.includes(a)) continue;
  // (Its value, or the lack of one, is main.ts's to judge.)
  if (VALUES.includes(a)) { if (process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--")) i++; continue; }
  console.error(`eval/run.mjs doesn't know "${a}". Run node eval/run.mjs --help for its options.`);
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist/eval/eval.cjs");
await build({
  entryPoints: [path.join(root, "eval/src/main.ts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["koffi", "@github/copilot-sdk", "sharp", "sherpa-onnx", "electron"], logLevel: "error",
  // main.ts finds the repository from its own folder (dist/eval → ../..).
});
// Ember's desk helper, beside it (the desk makes its X calls there).
await build({
  entryPoints: [path.join(root, "app/main/desk/agent-process.ts")], outfile: path.join(root, "dist/eval/desk-agent.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22",
  external: ["koffi", "sharp", "electron"], logLevel: "error",
});
const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
