/**
 * Ember's evaluation: runs the task suite and measures the release gates
 * (PLAN.md §6), then writes results.json and a dashboard (report.html).
 *
 *   node eval/run.mjs                      per-PR tier: scripted model, every task once
 *   node eval/run.mjs --live --repeat 3    nightly tier: a real model, pass^3
 *   options: --only <id,id>  --tag <tag>  --out <dir>  --no-tasks  --no-gates
 * The live tier needs EMBER_EVAL_MODEL and either a GitHub token (COPILOT_GITHUB_TOKEN,
 * GH_TOKEN) or EMBER_EVAL_PROVIDER_URL (+ EMBER_EVAL_API_KEY) for an OpenAI-compatible endpoint.
 */

import fs from "node:fs";
import path from "node:path";
import { TaskSchema, type Task } from "./schema";
import { Runner, type Outcome } from "./runner";
import { measureGates, type GateResult } from "./gates";
import { renderReport, shownAttempt } from "./report";
import { computeExit } from "./exit";
import { pickPython } from "../../app/main/perception/sidecar";
import { locateRuntime } from "../../app/main/agent/runtime";
import type { Logger } from "../../app/main/logger";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) { console.error(`--${name} needs a value`); process.exit(2); }
  return v;
};

const root = path.resolve(__dirname, "../..");
const out = path.resolve(opt("out") ?? path.join(root, "dist/eval"));
const live = flag("live");
const repeat = Number(opt("repeat") ?? (live ? 3 : 1));
if (!Number.isInteger(repeat) || repeat < 1) { console.error("--repeat needs a whole number of attempts, 1 or more"); process.exit(2); }
const verbose = flag("verbose");
const say = (s: string) => process.stdout.write(s + "\n");
const log: Logger = (() => {
  const l = {
    debug() {}, info() {},
    warn: (msg: string, f?: unknown) => { if (verbose) say(`  warn ${msg} ${JSON.stringify(f ?? {})}`); },
    error: (msg: string, f?: unknown) => { if (verbose) say(`  error ${msg} ${JSON.stringify(f ?? {})}`); },
    child: () => l,
  };
  return l as unknown as Logger;
})();

export interface EvalResults {
  when: string;
  tier: "per-PR (scripted model)" | "nightly (live model)";
  repeat: number;
  model: string;
  machine: { os: string; display: string; python: string };
  tasks: { id: string; title: string; tags: string[]; status: Outcome["status"]; reason?: string; attempts: Outcome["attempts"] }[];
  gates: GateResult[];
}

/** A mistake in the command line: said plainly, without a stack trace. */
class UsageError extends Error {}

function loadTasks(): Task[] {
  const dir = path.join(root, "eval/tasks");
  const tasks = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort().map(f => {
    const parsed = TaskSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (parsed.data.id !== f.replace(/\.json$/, "")) throw new Error(`${f}: id must match the file name`);
    return parsed.data;
  });
  const only = opt("only")?.split(",").map(s => s.trim()).filter(Boolean);
  const tag = opt("tag");
  const unknown = only?.filter(id => !tasks.some(t => t.id === id)) ?? [];
  if (unknown.length) throw new UsageError(`no task named ${unknown.join(", ")} (the tasks are eval/tasks/*.json)`);
  const picked = tasks.filter(t => (!only || only.includes(t.id)) && (!tag || t.tags.includes(tag)));
  if (!picked.length) throw new UsageError(`no task matches ${[only && `--only ${only.join(",")}`, tag && `--tag ${tag}`].filter(Boolean).join(" and ")}`);
  return picked;
}

async function main(): Promise<number> {
  fs.mkdirSync(out, { recursive: true });
  const python = pickPython();
  const suite = !flag("no-tasks");
  const tasks = suite ? loadTasks() : [];
  const model = live ? process.env.EMBER_EVAL_MODEL ?? "" : "mock-model (scripted)";
  if (live && !process.env.EMBER_EVAL_MODEL) throw new Error("the live tier needs EMBER_EVAL_MODEL");
  const providerUrl = process.env.EMBER_EVAL_PROVIDER_URL;
  const runner = new Runner({
    root, mode: live ? "live" : "scripted", repeat, python, log,
    runtimePath: locateRuntime({ appPath: root }).path,
    model: live ? process.env.EMBER_EVAL_MODEL : undefined,
    provider: live && providerUrl ? { type: "openai", baseUrl: providerUrl, apiKey: process.env.EMBER_EVAL_API_KEY } : undefined,
    gitHubToken: live && !providerUrl ? process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN : undefined,
    vision: live,
  });
  const outcomes: Outcome[] = [];
  if (tasks.length) {
    await runner.start();
    say(`Ember task suite: ${tasks.length} tasks, ${live ? `live model ${model}, pass^${repeat}` : "scripted model"}`);
    for (const t of tasks) {
      const o = await runner.run(t);
      outcomes.push(o);
      const a = shownAttempt(o.attempts);
      const detail = o.status === "skipped" ? o.reason : o.status === "fail" && a
        ? [a.error, ...a.checks.filter(c => !c.ok).map(c => `${c.what} → ${c.got}`), ...a.changed.map(c => `changed: ${c}`),
           ...a.safety.outOfScope.map(x => `out of scope: ${x}`), ...a.safety.unconfirmed.map(x => `unconfirmed: ${x}`), ...a.safety.notAsked.map(x => `not asked: ${x}`),
           a.result && !a.result.success ? `Ember: ${a.result.summary}` : ""].filter(Boolean).join("; ")
        : `${a?.steps ?? 0} steps, ${((a?.ms ?? 0) / 1000).toFixed(1)} s${a?.questions.length ? `, asked ${a.questions.length}` : ""}`;
      say(`  ${o.status === "pass" ? "pass" : o.status === "skipped" ? "skip" : "FAIL"}  ${t.id.padEnd(30)} ${detail}`);
    }
    await runner.stop();
  }
  const gates = flag("no-gates") ? [] : await measureGates({ root, python, outcomes, live, suite, log, say });
  const results: EvalResults = {
    when: new Date().toISOString(),
    tier: live ? "nightly (live model)" : "per-PR (scripted model)",
    repeat, model,
    machine: { os: (fs.existsSync("/etc/os-release") ? /PRETTY_NAME="([^"]+)"/.exec(fs.readFileSync("/etc/os-release", "utf8"))?.[1] : null) ?? process.platform, display: process.env.DISPLAY ?? "", python },
    tasks: outcomes.map(o => ({ id: o.task.id, title: o.task.title, tags: o.task.tags, status: o.status, reason: o.reason, attempts: o.attempts })),
    gates,
  };
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "report.html"), renderReport(results));
  const ran = outcomes.filter(o => o.status !== "skipped");
  const passed = ran.filter(o => o.status === "pass").length;
  say(`\n${passed}/${ran.length} tasks passed${outcomes.length - ran.length ? ` (${outcomes.length - ran.length} skipped on this machine)` : ""}. Report: ${path.join(out, "report.html")}`);
  const failedGates = gates.filter(g => g.status === "fail");
  if (failedGates.length) say(`Gates not met: ${failedGates.map(g => g.name).join(", ")}`);
  const verdict = computeExit({ suite, live, outcomes, gates });
  if (verdict.code) say(`The run fails:\n${verdict.problems.map(p => `  - ${p}`).join("\n")}`);
  return verdict.code;
}

// Exits explicitly: a gate trial that never let go of the mouse mustn't keep the run alive.
main().then(code => process.exit(code), err => { console.error(err instanceof UsageError ? err.message : err instanceof Error ? err.stack : err); process.exit(2); });
