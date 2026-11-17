/** Executes the actual manual workflow's private-output boundary without Windows, Electron or a native process. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { expect, it, vi } from "vitest";

const source = fs.readFileSync(".github/workflows/windows-uia-focus-order.yml", "utf8");
const script = source.slice(source.indexOf("          // Keep child streams private;")).split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
const relative = "test/integration/uia-electron-focus-native.test.ts", suite = path.resolve(relative);
const reportPath = path.join(path.resolve("test-output"), "windows-uia-focus-report.json");
const condition = (mode: number, target: number) => ({ schema: 1, mode, target, matched: 1, focus: 15, identity: 255, foreground: 1, performed: 1 });
const conditions = () => [1, 2, 3].flatMap(mode => [1, 2].map(target => condition(mode, target)));
const summary = () => ({ schema: 1, completed: 6, matchedMask: 63, negative: 1, phase: 8 });
const conditionLine = (value: unknown) => "Windows UIA focus condition " + JSON.stringify(value);
const summaryLine = (value: unknown) => "Windows UIA focus summary " + JSON.stringify(value);
const output = () => [...conditions().map(conditionLine), summaryLine(summary())].join("\n");
const attempt = (over: Record<string, unknown> = {}) => ({ status: 0, signal: null, stdout: Buffer.from(output()), stderr: Buffer.from("PRIVATE ordinary child noise\n"), ...over });
const report = () => ({
  success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
  testResults: [{ name: suite, status: "passed", assertionResults: [{ status: "passed" }] }],
});
interface FixtureOptions {
  child?: object; report?: unknown; rawReport?: string; stale?: boolean; missing?: boolean; sourceLink?: boolean;
  reportLink?: boolean; reportLinks?: number; reportBytes?: number; reportFault?: boolean;
}
function fixture(o: FixtureOptions = {}) {
  const printed = vi.fn(), queries: string[] = [];
  const child = o.child ?? attempt(), selectedReport = o.report ?? report();
  const spawn = vi.fn(() => child);
  const fakeFs = {
    lstatSync(file: string) {
      queries.push("stat:" + file);
      if (file === suite && o.missing || file === reportPath && o.reportFault) throw new Error("PRIVATE filesystem path");
      return { isFile: () => true, isSymbolicLink: () => file === suite ? o.sourceLink === true : o.reportLink === true,
        nlink: file === suite ? 1 : o.reportLinks ?? 1, size: file === suite ? 100 : o.reportBytes ?? 1000 };
    },
    realpathSync: { native(file: string) { queries.push("real:" + file); return file; } },
    existsSync(file: string) { queries.push("exists:" + file); return o.stale === true; },
    readFileSync(file: string) { queries.push("read:" + file); return o.rawReport ?? JSON.stringify(selectedReport); },
  };
  const context = {
    process: { execPath: "fixed-node", env: { RUNNER_TEMP: path.dirname(reportPath), EMBER_UIA_FOCUS_NATIVE_TEST: "0" } },
    Buffer, console: { info: printed },
    require(name: string) {
      if (name === "node:fs") return fakeFs;
      if (name === "node:path") return path;
      if (name === "node:util") return { types };
      if (name === "node:child_process") return { spawnSync: spawn };
      throw new Error("PRIVATE unexpected module");
    },
  };
  return { run: () => runInNewContext(script, context, { timeout: 1000 }), printed, queries, spawn };
}
const messages = (f: ReturnType<typeof fixture>) => f.printed.mock.calls.map(call => call[0]);
const projected = (f: ReturnType<typeof fixture>) => f.printed.mock.calls.map(call => [call[0], JSON.parse(call[1] as string)] as const);
function refused(f: ReturnType<typeof fixture>) {
  expect(f.run).toThrow("The required Windows UIA focus primitive could not be verified.");
  expect(messages(f)).not.toContain("Required Windows UIA focus primitive passed");
  expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
}

it("runs only through explicit manual dispatch or its reusable manual caller, without production or publishing privileges", () => {
  const triggers = source.match(/^on:\n([\s\S]*?)\npermissions:/m)![1];
  expect(triggers.trim()).toBe("workflow_dispatch:\n  workflow_call:");
  expect(source).toContain("    if: github.event_name == 'workflow_dispatch'");
  expect(source).toContain("image: [windows-2022, windows-2025]");
  expect(source).toContain("fail-fast: false");
  expect(source).toContain("contents: read");
  expect(source).toContain("persist-credentials: false");
  expect(source).toContain('node-version: "22.23.5"');
  for (const pin of [...source.matchAll(/uses: ([^\s]+)/g)]) expect(pin[1]).toMatch(/@[0-9a-f]{40}$/);
  expect(source).toContain("node node_modules/electron/install.js");
  expect(source).toContain('if ($LASTEXITCODE -ne 0) { throw "The pinned development Electron installation failed." }');
  expect(source).not.toMatch(/npm run build|no-sandbox|disable.*sandbox|pull_request|actions:\s*write|contents:\s*write|upload-artifact|windows-node-product|copilot|--inspect/);
});

it("admits only one canonical passed native leaf after all six genuine focus matches and cleanup summary", () => {
  const f = fixture(); f.run();
  expect(f.spawn).toHaveBeenCalledExactlyOnceWith("fixed-node",
    ["scripts/run-integration.mjs", relative, "--maxWorkers=1", "--reporter=default", "--reporter=json", "--outputFile=" + reportPath],
    { env: { RUNNER_TEMP: path.dirname(reportPath), EMBER_UIA_FOCUS_NATIVE_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"],
      encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 5 * 60_000, windowsHide: true });
  expect(projected(f)).toEqual([...conditions().map(value => ["Windows UIA focus condition", value]), ["Windows UIA focus summary", summary()],
    ["Required Windows UIA focus primitive passed", { schema: 1, passed: 1, skipped: 0 }]]);
  expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
});

it.each([
  { status: 1 }, { status: null }, { status: "0" }, { signal: "SIGTERM" }, { error: Object.assign(new Error("PRIVATE timeout"), { code: "ETIMEDOUT" }) },
])("retains all valid condition frames while refusing the failed child outcome %#", fields => {
  const f = fixture({ child: attempt(fields) }); refused(f);
  expect(messages(f)).toEqual([...Array(6).fill("Windows UIA focus condition"), "Windows UIA focus summary"]);
  expect(f.spawn).toHaveBeenCalledOnce(); expect(f.queries).not.toContain("read:" + reportPath);
});

it("prints mismatched and partial numeric native evidence without converting it into a pass", () => {
  const bad = { ...condition(1, 1), matched: 0, focus: 11, identity: 59 };
  const partial = { schema: 1, completed: 2, matchedMask: 2, negative: 0, phase: 4 };
  const f = fixture({ child: attempt({ status: 1, stdout: Buffer.from([conditionLine(bad), conditionLine(condition(1, 2)), summaryLine(partial)].join("\n")) }) });
  refused(f); expect(projected(f)).toEqual([["Windows UIA focus condition", bad], ["Windows UIA focus condition", condition(1, 2)], ["Windows UIA focus summary", partial]]);
});

it.each([
  ["numTotalTests", 0], ["numTotalTests", 2], ["numPassedTests", 0], ["numFailedTests", 1], ["numPendingTests", 1], ["numTodoTests", 1],
  ["numTotalTestSuites", 2], ["numPassedTestSuites", 0], ["numFailedTestSuites", 1], ["numPendingTestSuites", 1], ["success", false],
] as const)("refuses a report with unsupported %s=%s even when the child and frames claim success", (key, value) => {
  refused(fixture({ report: { ...report(), [key]: value } }));
});

it.each(["foreign", "relative", "empty", "extra", "skipped", "pending", "missing-assertion", "extra-assertion"] as const)("requires the whole canonical native leaf inventory (%s)", selected => {
  const value = report();
  if (selected === "foreign") value.testResults[0].name = path.resolve("test/integration/PRIVATE-other.test.ts");
  if (selected === "relative") value.testResults[0].name = relative;
  if (selected === "empty") value.testResults = [];
  if (selected === "extra") value.testResults.push({ ...value.testResults[0] });
  if (selected === "skipped") value.testResults[0].status = "skipped";
  if (selected === "pending") value.testResults[0].assertionResults[0].status = "pending";
  if (selected === "missing-assertion") value.testResults[0].assertionResults = [];
  if (selected === "extra-assertion") value.testResults[0].assertionResults.push({ status: "passed" });
  refused(fixture({ report: value }));
});

it.each([
  { stale: true }, { missing: true }, { sourceLink: true }, { reportLink: true }, { reportLinks: 2 },
  { reportBytes: 0 }, { reportBytes: 2 * 1024 * 1024 + 1 }, { reportFault: true }, { rawReport: "{PRIVATE malformed" },
])("refuses unavailable, stale or unsupported source/report files without exposing their errors %#", options => {
  const f = fixture(options); refused(f);
  if (options.stale || options.missing || options.sourceLink) expect(f.spawn).not.toHaveBeenCalled();
});

it.each(["missing-condition", "condition-domain", "condition-extra", "condition-fraction", "condition-string", "false-match", "condition-json", "condition-conflict", "summary-conflict", "summary-missing", "summary-incomplete", "summary-negative", "summary-cleanup", "summary-mask", "summary-domain", "oversized-frame"] as const)("refuses incomplete or forged native frames (%s)", selected => {
  const lines = conditions().map(conditionLine); let final: unknown = summary();
  if (selected === "missing-condition") lines.pop();
  if (selected === "condition-domain") lines[0] = conditionLine({ ...condition(1, 1), mode: 4 });
  if (selected === "condition-extra") lines[0] = conditionLine({ ...condition(1, 1), private: "PRIVATE" });
  if (selected === "condition-fraction") lines[0] = conditionLine({ ...condition(1, 1), target: 1.5 });
  if (selected === "condition-string") lines[0] = conditionLine({ ...condition(1, 1), focus: "PRIVATE" });
  if (selected === "false-match") lines[0] = conditionLine({ ...condition(1, 1), identity: 59 });
  if (selected === "condition-json") lines[0] = "Windows UIA focus condition {PRIVATE}";
  if (selected === "condition-conflict") lines.push(conditionLine({ ...condition(1, 1), matched: 0 }));
  if (selected === "summary-incomplete") final = { ...summary(), completed: 5 };
  if (selected === "summary-negative") final = { ...summary(), negative: 0 };
  if (selected === "summary-cleanup") final = { ...summary(), phase: 7 };
  if (selected === "summary-mask") final = { ...summary(), matchedMask: 62 };
  if (selected === "summary-domain") final = { ...summary(), phase: 9 };
  if (selected === "oversized-frame") lines[0] = conditionLine({ private: "PRIVATE" + "X".repeat(257) });
  if (selected !== "summary-missing") lines.push(summaryLine(final));
  if (selected === "summary-conflict") lines.push(summaryLine({ ...summary(), phase: 7 }));
  const f = fixture({ child: attempt({ stdout: Buffer.from(lines.join("\n")) }) }); refused(f);
  if (selected === "condition-conflict") expect(projected(f).filter(([name]) => name === "Windows UIA focus condition")).toHaveLength(5);
  if (selected === "summary-conflict") expect(messages(f)).not.toContain("Windows UIA focus summary");
});

it("accepts agreeing duplicate frames and CRLF/ANSI decoration while discarding unrelated raw output", () => {
  const f = fixture({ child: attempt({ stdout: Buffer.from("\u001b[32m" + output().replace(/\n/g, "\r\n") + "\u001b[0m\r\nPRIVATE raw path\r\n"),
    stderr: Buffer.from(output()) }) });
  f.run(); expect(messages(f)).toHaveLength(8); expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
});

it.each(["invalid-utf8", "oversized", "accessor", "proxy", "shadowed-buffer"] as const)("refuses unsupported captured streams without reading private accessors (%s)", selected => {
  let reads = 0; const privateRead = () => { reads++; throw new Error("PRIVATE accessor"); }, child = attempt();
  if (selected === "invalid-utf8") child.stdout = Buffer.from([0xff]);
  if (selected === "oversized") child.stdout = Buffer.alloc(1024 * 1024 + 1, 88);
  if (selected === "accessor") Object.defineProperty(child, "stdout", { get: privateRead });
  if (selected === "proxy") child.stdout = new Proxy(Buffer.from("PRIVATE"), { get: privateRead, getOwnPropertyDescriptor: privateRead });
  if (selected === "shadowed-buffer") Object.defineProperty(child.stdout, "toString", { get: privateRead });
  refused(fixture({ child })); expect(reads).toBe(0);
});

const startup = () => ({ schema: 1, phase: 2, appReady: 0, appExit: 0, appError: 0, appStage: 6, bridgeReady: 1, bridgeStage: 30, loadCode: 1, quit: 1, fixtureFlags: 7 });
const startupLine = (value: unknown) => "Windows UIA focus startup " + JSON.stringify(value);
it("projects cached startup for a failed zero-condition experiment without reading a report or granting acceptance", () => {
  const partial = { schema: 1, completed: 0, matchedMask: 0, negative: 0, phase: 2 };
  const f = fixture({ child: attempt({ status: 1, stdout: Buffer.from(startupLine(startup()) + "\n" + summaryLine(partial)) }) });
  refused(f); expect(projected(f)).toEqual([["Windows UIA focus summary", partial], ["Windows UIA focus startup", startup()]]);
  expect(f.queries).not.toContain("read:" + reportPath); expect(f.spawn).toHaveBeenCalledOnce();
});
it.each([
  ["schema", 2], ["phase", 9], ["appReady", 7], ["appExit", 4], ["appError", 2], ["appStage", 10], ["bridgeReady", 3], ["bridgeStage", 31], ["loadCode", 8], ["quit", 5], ["fixtureFlags", 8],
] as const)("withholds an invalid startup %s value while retaining the original failed outcome", (key, value) => {
  const f = fixture({ child: attempt({ status: 1, stdout: Buffer.from(output() + "\n" + startupLine({ ...startup(), [key]: value })) }) });
  refused(f); expect(messages(f)).not.toContain("Windows UIA focus startup");
});
it.each(["conflict", "extra", "missing", "string", "fraction", "malformed", "oversized"] as const)("optional %s startup data has no authority over a complete successful six-condition experiment", kind => {
  let value: unknown = startup();
  if (kind === "extra") value = { ...startup(), private: "PRIVATE" };
  if (kind === "missing") { const { appStage: _stage, ...rest } = startup(); value = rest; }
  if (kind === "string") value = { ...startup(), appStage: "PRIVATE" };
  if (kind === "fraction") value = { ...startup(), bridgeStage: 1.5 };
  const frame = kind === "malformed" ? "Windows UIA focus startup {PRIVATE}" : kind === "oversized" ? startupLine({ private: "PRIVATE" + "x".repeat(257) }) : startupLine(value);
  const f = fixture({ child: attempt({ stdout: Buffer.from(output() + "\n" + frame + (kind === "conflict" ? "\n" + startupLine({ ...startup(), appStage: 9 }) : "")) }) });
  f.run(); expect(messages(f)).toContain("Required Windows UIA focus primitive passed"); expect(messages(f)).not.toContain("Windows UIA focus startup");
  expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
});
it("accepts agreeing startup duplicates only for the original failure and withholds conflicting observations", () => {
  for (const conflict of [false, true]) {
    const f = fixture({ child: attempt({ status: 1, stdout: Buffer.from(output() + "\n" + startupLine(startup())),
      stderr: Buffer.from("\u001b[32m" + startupLine({ ...startup(), appStage: conflict ? 9 : 6 }) + "\u001b[0m\r\nPRIVATE ignored") }) });
    refused(f); expect(messages(f).filter(value => value === "Windows UIA focus startup")).toHaveLength(conflict ? 0 : 1);
  }
});
it("recovers the entire original strict workflow by reversing only the optional startup frame parser/projection", () => {
  let old = source.replace('          let startup, startupConflict = false, startupInvalid = false;\n', "")
    .replace('          const startupLimits = { schema: [1, 1], phase: [0, 8], appReady: [0, 6], appExit: [0, 3], appError: [0, 1], appStage: [0, 9], bridgeReady: [0, 2], bridgeStage: [0, 30], loadCode: [0, 7], quit: [0, 4], fixtureFlags: [0, 7] };\n', "");
  const begin = old.indexOf('                const boot ='), end = old.indexOf('                const condition =', begin); expect(begin > 0 && end > begin).toBe(true);
  old = old.slice(0, begin) + old.slice(end);
  old = old.replace('          if (!passed && startup && !startupConflict && !startupInvalid) console.info("Windows UIA focus startup", JSON.stringify(startup));\n', "");
  expect(createHash("sha256").update(old).digest("hex")).toBe("33dea7955b2959fdc5a67886e10f264374c573c040d103d664a255a2c3c474d5");
});

const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
const jobsSource = ci.slice(ci.indexOf("\njobs:\n") + "\njobs:\n".length);
const headers = [...jobsSource.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)];
const jobs = new Map(headers.map((match, index) => [match[1], jobsSource.slice(match.index, headers[index + 1]?.index ?? jobsSource.length)]));
function conditionOf(block: string): string {
  const folded = block.match(/^ {4}if: >-\n((?: {6}[^\n]*\n)+)/m);
  return folded ? folded[1].trim().replace(/\s*\n\s*/g, " ") : block.match(/^ {4}if: (.+)$/m)![1];
}
interface RouteContext { event: string; ref?: string; only?: string; intel?: boolean }
function evaluate(expression: string, context: RouteContext): unknown {
  return runInNewContext("(" + expression + ")", {
    github: { event_name: context.event, ref: context.ref ?? "refs/heads/main", event: { repository: { default_branch: "main" } } },
    inputs: { only: context.only ?? "all", intel: context.intel ?? false, packages: false },
    format: (value: string, replacement: string) => value.replace("{0}", replacement),
    startsWith: (value: string, prefix: string) => value.startsWith(prefix),
  }, { timeout: 1000 });
}
const releaseNeeds = jobs.get("release")!.match(/^ {4}needs: \[([^\]]+)\]/m)![1].split(",").map(value => value.trim());
function scheduled(context: RouteContext): string[] {
  const selected = [...jobs].filter(([name, block]) => name !== "release" && evaluate(conditionOf(block), context)).map(([name]) => name);
  // GitHub's implicit success() skips a dependent release when its required jobs were skipped. Assume scheduled jobs pass.
  if (evaluate(conditionOf(jobs.get("release")!), context) && releaseNeeds.every(name => selected.includes(name))) selected.push("release");
  return selected;
}
const linuxJobs = ["checks", "el8", "package", "voice-e2e", "eval"];
const windowsJobs = ["windows-node-product", "windows"];
const normalJobs = [...linuxJobs, ...windowsJobs, "macos"];
const focusCaller = [
  "  windows-uia-focus-order:",
  "    name: Windows UIA focus diagnostic",
  "    if: github.event_name == 'workflow_dispatch' && inputs.only == 'focus'",
  "    permissions:",
  "      contents: read",
  "    uses: ./.github/workflows/windows-uia-focus-order.yml",
  "", "",
].join("\n");

it("offers the registered CI focus selector and calls only the local read-only reusable workflow", () => {
  expect(ci).toContain("options: [all, linux, windows, macos, focus]");
  expect(ci).toContain("        default: all\n");
  expect(jobs.get("windows-uia-focus-order")).toBe(focusCaller);
  expect(releaseNeeds).toEqual(["checks", "el8", "voice-e2e", "package", "eval", "windows", "windows-node-product", "macos", "macos-x64"]);
  expect(releaseNeeds).not.toContain("windows-uia-focus-order");
});

it.each(["refs/heads/main", "refs/heads/review-focus", "refs/tags/v1.2.3"])("manual only=focus on %s schedules no normal or release job, even with Intel requested", ref => {
  for (const intel of [false, true]) expect(scheduled({ event: "workflow_dispatch", ref, only: "focus", intel })).toEqual(["windows-uia-focus-order"]);
});

it.each(["all", "linux", "windows", "macos"])("preserves existing manual only=%s platform selection", only => {
  for (const intel of [false, true]) {
    const expected = only === "linux" ? linuxJobs : only === "windows" ? windowsJobs : only === "macos" ? ["macos"] : normalJobs;
    expect(scheduled({ event: "workflow_dispatch", only, intel })).toEqual([...expected, ...(intel && (only === "all" || only === "macos") ? ["macos-x64"] : [])]);
  }
});

it("keeps default manual runs equivalent to only=all", () => {
  expect(scheduled({ event: "workflow_dispatch" })).toEqual(normalJobs);
});

it.each([
  { event: "push", ref: "refs/heads/main", expected: [...normalJobs, "macos-x64"] },
  { event: "pull_request", ref: "refs/pull/1/merge", expected: normalJobs },
  { event: "push", ref: "refs/tags/v1.2.3", expected: [...normalJobs, "macos-x64", "release"] },
])("keeps $event on $ref unchanged and never schedules the diagnostic", ({ event, ref, expected }) => {
  expect(scheduled({ event, ref, only: "focus", intel: true })).toEqual(expected);
  expect(Boolean(evaluate(conditionOf(source), { event, ref, only: "focus" }))).toBe(false);
});

it("retains the existing fully checked tagged manual release behaviour", () => {
  expect(scheduled({ event: "workflow_dispatch", ref: "refs/tags/v1.2.3", only: "all", intel: true })).toEqual([...normalJobs, "macos-x64", "release"]);
});

it("separates only the diagnostic concurrency group so it cannot cancel ordinary CI", () => {
  const group = ci.match(/^ {2}group: (.+)$/m)![1];
  const render = (context: RouteContext) => group.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_all, expression: string) => String(evaluate(expression, context)));
  for (const event of ["push", "pull_request", "workflow_dispatch"]) for (const only of ["all", "linux", "windows", "macos"]) {
    expect(render({ event, ref: "refs/heads/review-focus", only })).toBe("ci-refs/heads/review-focus");
  }
  expect(render({ event: "push", ref: "refs/heads/review-focus", only: "focus" })).toBe("ci-refs/heads/review-focus");
  expect(render({ event: "workflow_dispatch", ref: "refs/heads/review-focus", only: "focus" })).toBe("ci-focus-refs/heads/review-focus");
  expect(render({ event: "workflow_dispatch", ref: "refs/heads/review", only: "focus" })).not.toBe(render({ event: "push", ref: "refs/heads/review-focus" }));
  expect(ci).toContain("  cancel-in-progress: true");
});

it("recovers the entire previous CI file after reversing only the explicit diagnostic route and concurrency namespace", () => {
  const restored = ci
    .replace('description: "Run one platform\'s jobs or the focus diagnostic (pushes and pull requests always run all normal jobs; macOS minutes cost ten times Linux\'s)"',
      'description: "Run only one platform\'s jobs (pushes and pull requests always run them all; macOS minutes cost ten times Linux\'s)"')
    .replace("options: [all, linux, windows, macos, focus]", "options: [all, linux, windows, macos]")
    .replace("group: ${{ github.event_name == 'workflow_dispatch' && inputs.only == 'focus' && 'ci-focus-' || 'ci-' }}${{ github.ref }}", "group: ci-${{ github.ref }}")
    .replace(focusCaller, "");
  expect(createHash("sha256").update(restored).digest("hex")).toBe("eb833e8964fec6fbefdcb244acf372a00a6a720b718a3acc1fa544a1ee30afc9");
});
