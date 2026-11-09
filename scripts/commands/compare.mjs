/**
 * Compare the real classifier and run_command flow against the audit's pinned baseline, with fake runners only.
 * usage: node scripts/commands/compare.mjs --baseline <4d64d3a worktree> [--current <worktree>] [--output <folder>] [--extra-cases <json>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { compareResults } from "./compare-lib.mjs";
import { generatedCases } from "./compare-cases.mjs";
import { AUDIT_BASELINE, assertBaseline } from "./baseline.mjs";

const BASELINE = AUDIT_BASELINE;
const DEFAULTS = { posix: ["bash", "linux"], powershell: ["powershell", "win32"], cmd: ["cmd", "win32"], wsl: ["bash", "wsl"] };
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (!["--baseline", "--current", "--output", "--extra-cases"].includes(name) || !process.argv[i + 1]) throw new Error("Use --baseline <worktree>, with optional --current, --output and --extra-cases paths.");
  options[name.slice(2)] = path.resolve(process.argv[i + 1]);
}
if (!options.baseline) throw new Error("Supply a clean worktree of 4d64d3a with --baseline.");
const current = options.current ?? process.cwd();
const output = options.output ?? fs.mkdtempSync(path.join(os.tmpdir(), "ember-command-comparison-"));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
assertBaseline(options.baseline);
const { build } = createRequire(path.join(current, "package.json"))("esbuild");
const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const corpus = root => Object.entries(DEFAULTS).flatMap(([family, [shell, context]]) => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/commands", `${family}.json`), "utf8"));
  return raw.cases.map((c, index) => ({ shell: raw.shell ?? shell, context: raw.context ?? context, ...c, origin: `${family}:${index}` }));
});
const cases = corpus(options.baseline);
const corpusCount = cases.length;
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordered(v)])) : value;
const caseKey = c => JSON.stringify(ordered({ ...c, origin: undefined, verdict: undefined, rules: undefined, classes: undefined }));
const keys = new Set(cases.map(caseKey));
const add = c => {
  const value = { shell: "bash", context: "linux", verdict: "run", ...c, origin: "generated" };
  const key = caseKey(value);
  if (!keys.has(key)) { keys.add(key); cases.push(value); }
};
for (const c of [...corpus(current), ...generatedCases(), ...JSON.parse(fs.readFileSync(new URL("../../test/fixtures/commands/comparison.json", import.meta.url), "utf8"))]) add(c);
if (options["extra-cases"]) for (const c of JSON.parse(fs.readFileSync(options["extra-cases"], "utf8"))) add(c);
write("cases.json", cases);
async function probe(root, label) {
  const bundle = path.join(output, `${label}.cjs`);
  await build({ entryPoints: [fileURLToPath(new URL("probe.mjs", import.meta.url))], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent",
    nodePaths: [path.join(current, "node_modules")], alias: {
      "@comparison/corpus": path.join(root, "test/fixtures/commands/corpus.ts"),
      "@comparison/flow": path.join(root, "app/main/commands/flow.ts"),
      "@comparison/paths": path.join(root, "app/main/commands/paths.ts"),
    } });
  fs.chmodSync(bundle, 0o600);
  const result = path.join(output, `${label}.json`);
  const run = spawnSync(process.execPath, [bundle, path.join(output, "cases.json"), result], { cwd: root, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`${label} probe failed; no comparison verdict is available.`);
  fs.chmodSync(result, 0o600);
  return JSON.parse(fs.readFileSync(result, "utf8"));
}
const before = await probe(options.baseline, "baseline");
const after = await probe(current, "current");
const report = compareResults(cases, before, after);
report.summary = { baseline: BASELINE, current, corpusCases: corpusCount, ...report.summary };
write("comparison.json", report);
write("summary.json", report.summary);
console.log(JSON.stringify({ ...report.summary, output }, null, 2));
process.exitCode = report.errors.length || report.summary.forbiddenLooser ? 1 : 0;
