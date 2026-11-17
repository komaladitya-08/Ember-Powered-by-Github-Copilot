/** Execute the workflow's actual fail-closed scripts without downloading or running a Windows binary. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const product = read(".github/workflows/windows-node-product.yml"), ci = read(".github/workflows/ci.yml");
const diagnostic = read(".github/workflows/coding-boundary.yml");
function script(name: string, workflow = product): string {
  const marker = "      - name: " + name + "\n", start = workflow.indexOf(marker);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const after = workflow.slice(start + marker.length), end = after.search(/\n(?: {6}-| {2}[a-z][\w-]*:)/);
  const step = end < 0 ? after : after.slice(0, end), run = step.indexOf("        run: |\n");
  expect(run, name).toBeGreaterThanOrEqual(0);
  return step.slice(run + "        run: |\n".length).split("\n").filter(line => line.length > 0).map(line => {
    expect(line.startsWith("          "), name).toBe(true); return line.slice(10);
  }).join("\n");
}
const aggregate = script("Require all configured Windows product matrix leaves");
const proof = script("Require the actual native, source Home or packaged Home proof without skipped cases");
const producer = script("Require the reviewed POSIX producer and authenticate its exact archive");
const cases = {
  native: "test/integration/windows-node-product-native.test.ts",
  source: "test/integration/project-coding-windows-node-electron.test.ts",
  packaged: "test/integration/windows-node-packaged-product.test.ts",
} as const;

it("requires the bounded C model once before all remaining units in each ordinary platform job", () => {
  const model = "test/unit/windows-node-asset-enforcement-c.test.ts";
  const steps = "      - name: Fixed C witness model and bounded compiler outcome\n" +
    `        run: npm test -- ${model} --maxWorkers=1\n` +
    "      - name: Remaining unit tests\n" + `        run: npm test -- --exclude ${model}\n`;
  for (const name of ["checks", "windows", "macos"]) {
    const start = ci.indexOf(`\n  ${name}:\n`); expect(start).toBeGreaterThan(0);
    const after = ci.slice(start + 1), end = after.search(/\n {2}[a-z][\w-]*:/);
    const job = end < 0 ? after : after.slice(0, end);
    expect(job).toContain(steps);
    expect(job.match(/run: npm test(?:\s|$)/g)).toHaveLength(2);
  }
});
type Journey = keyof typeof cases;
function passing(journey: Journey) {
  return { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: [{ name: path.resolve(cases[journey]), status: "passed", assertionResults: [{ status: "passed" }] }] };
}
function proofFixture(journey: Journey = "native", report: unknown = passing(journey), options: {
  missing?: boolean; status?: number | null; signal?: string | null; readFailure?: boolean; malformed?: boolean;
} = {}) {
  const outputs: string[] = [], printed = vi.fn(), invoked = vi.fn(() => ({ status: options.status === undefined ? 0 : options.status, signal: options.signal ?? null,
    stdout: Buffer.from("PRIVATE synthetic child output"), stderr: Buffer.from("PRIVATE synthetic child failure") }));
  const info = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 };
  const io = { existsSync: (file: string) => Object.values(cases).includes(file as typeof cases[Journey]) && !options.missing,
    readFileSync: (file: string) => {
      if (options.readFailure) throw new Error("PRIVATE synthetic file path");
      return file === "package.json" ? '{"version":"0.1.1"}' : options.malformed ? "{PRIVATE invalid report" : JSON.stringify(report);
    },
    lstatSync: () => info, appendFileSync: (_file: string, output: string) => outputs.push(output) };
  const env = { EMBER_WINDOWS_NODE_PRODUCT_IMAGE: "windows-2022", EMBER_WINDOWS_NODE_PRODUCT_JOURNEY: journey,
    EMBER_WINDOWS_NODE_PRODUCT_TEST: "1", EMBER_ELECTRON_WINDOWS_NODE_TEST: "1", EMBER_PACKAGED_WINDOWS_NODE_TEST: "1",
    RUNNER_TEMP: path.join(root, "synthetic-ci-temp"), GITHUB_OUTPUT: "synthetic-output", GITHUB_SHA: "1".repeat(40) };
  return { invoked, outputs, printed, run: () => runInNewContext(proof, { process: { env, execPath: "/host/node" }, console: { info: printed },
    require: (name: string) => {
      if (name === "node:fs") return io;
      if (name === "node:path") return path;
      if (name === "node:child_process") return { spawnSync: invoked };
      throw new Error("Unexpected workflow import");
    } }) };
}

it("requires the same-commit reusable product gate and releases only its tested Windows 2022 ZIP", () => {
  expect(ci).toMatch(/windows-node-product:\n[\s\S]*?uses: \.\/\.github\/workflows\/windows-node-product\.yml/);
  expect(product).toContain("  workflow_call:\n"); expect(product).toContain("  workflow_dispatch:\n");
  expect(product).toContain("image: [windows-2022, windows-2025]"); expect(product).toContain("journey: [native, source, packaged]");
  expect(product).toContain("fail-fast: false"); expect(product).not.toMatch(/github\.(?:head_ref|ref_name)|continue-on-error|passWithNoTests/);
  const release = ci.slice(ci.indexOf("\n  release:\n"));
  expect(release).toMatch(/needs: \[[^\n]*windows-node-product[^\n]*\]/);
  expect(release).toContain("name: ember-windows-node-product-windows-2022"); expect(release).not.toMatch(/name: ember-windows\s*\n/);
  expect(product).toContain("path: ${{ steps.proof.outputs.zip }}"); expect(product).toContain("if-no-files-found: error");
  expect(product).toContain("stage.mjs --with-models --with-runtimes --with-windows-node-toolchain");
});

it.each(["success", "failure", "cancelled", "skipped", "unknown"])("the actual aggregate accepts only a complete successful matrix, not %s", result => {
  const run = () => runInNewContext(aggregate, { process: { env: { REQUIRED_RESULTS: JSON.stringify({ product: { result } }) } } });
  if (result === "success") expect(run).not.toThrow(); else expect(run).toThrow("blocks the gate");
  expect(product).toMatch(/required:\n[\s\S]*?if: always\(\)\n\s+needs: \[product\]/);
});

it("does not accept an absent or unexpected required matrix result", () => {
  for (const results of [{}, { other: { result: "success" } }, { product: { result: "success" }, unexpected: { result: "success" } }]) {
    expect(() => runInNewContext(aggregate, { process: { env: { REQUIRED_RESULTS: JSON.stringify(results) } } })).toThrow("blocks the gate");
  }
});

it.each(Object.keys(cases) as Journey[])("runs the required actual %s entry point and accepts its complete passing report", journey => {
  const f = proofFixture(journey); expect(f.run).not.toThrow(); expect(f.invoked).toHaveBeenCalledTimes(1);
  const args = f.invoked.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
  expect(args[1]).toContain(cases[journey]); expect(args[1]).toContain("--reporter=json");
  expect(args[2].env.EMBER_WINDOWS_NODE_PRODUCT_TEST).toBe("1"); expect(args[2].env.EMBER_ELECTRON_WINDOWS_NODE_TEST).toBe("1");
  expect(args[2].env.EMBER_PACKAGED_WINDOWS_NODE_TEST).toBe("1");
  if (journey === "packaged") {
    expect(path.isAbsolute(args[2].env.EMBER_WINDOWS_NODE_PACKAGE)).toBe(true);
    expect(f.outputs).toEqual(["zip=" + args[2].env.EMBER_WINDOWS_NODE_PACKAGE + "\n"]);
  } else expect(f.outputs).toEqual([]);
});

it.each([
  { success: false }, { numTotalTests: 0, numPassedTests: 0, testResults: [] }, { numFailedTests: 1 },
  { numPendingTests: 1 }, { numTodoTests: 1 }, { numFailedTestSuites: 1 }, { numPendingTestSuites: 1 },
  { numTotalTests: 2, numPassedTests: 2 }, { testResults: [] },
  { testResults: [{ name: path.resolve(cases.native), status: "passed", assertionResults: [{ status: "skipped" }] }] },
  { testResults: [{ name: path.resolve(cases.native), status: "passed", assertionResults: [] }] },
  { testResults: [{ name: path.resolve("test/integration/windows-node-scoped-coding-worker.test.ts"), status: "passed", assertionResults: [{ status: "passed" }] }] },
])("refuses an incomplete, skipped, substituted or failing product report %j", change => {
  const f = proofFixture("native", { ...passing("native"), ...change });
  expect(f.run).toThrow("The required Windows Node product proof could not be verified."); expect(f.outputs).toEqual([]);
});

it("rejects a missing entry point, a failed runner and a cancelled runner before publishing any ZIP output", () => {
  for (const options of [{ missing: true }, { status: 1 }, { status: null, signal: "SIGTERM" }]) {
    const f = proofFixture("packaged", passing("packaged"), options);
    expect(f.run).toThrow("required Windows Node product proof"); expect(f.outputs).toEqual([]);
    if (options.missing) expect(f.invoked).not.toHaveBeenCalled();
  }
});

it("keeps pending producer review fail-closed and never accepts environment-selected old assets", () => {
  const spawn = vi.fn(() => ({ status: 1 })), manifest = read("app/shared/windows-node-toolchain.json");
  const reviewed = runInNewContext("(" + producer.match(/const reviewed = Object\.freeze\(([\s\S]*?)\);/)![1] + ")") as { ready: boolean; artifact: number };
  const run = () => runInNewContext(producer, { Buffer, console: { info: vi.fn() }, process: { env: {
    GITHUB_SHA: "1".repeat(40), RUNNER_TEMP: "synthetic-ci-temp", REVIEWED_WINDOWS_NODE_PRODUCER_READY: "1",
    EMBER_WINDOWS_NODE_ASSET_SOURCE: "old-producer", EMBER_WINDOWS_NODE_PRODUCER_ARTIFACT: "14224884648",
  } }, require: (name: string) => {
    if (name === "node:fs") return { readFileSync: () => Buffer.from(manifest) };
    if (name === "node:path") return path;
    if (name === "node:crypto") return { createHash: () => ({ update: () => ({ digest: () => "unreviewed" }) }) };
    if (name === "node:child_process") return { spawnSync: spawn, execFileSync: () => "1".repeat(40) };
    throw new Error("Unexpected workflow import");
  } });
  expect(run).toThrow(reviewed.ready ? "Windows Node product input could not be verified." : "blocked pending literal reviewed POSIX producer metadata");
  expect(spawn).not.toHaveBeenCalled(); expect(product).not.toContain("artifacts/14224884648/");
});

it.each(["child", "filesystem", "report-json"])("never forwards private %s diagnostics or raw parsing failures", kind => {
  const f = proofFixture("native", passing("native"), { status: kind === "child" ? 1 : 0, readFailure: kind === "filesystem", malformed: kind === "report-json" });
  let failure: unknown;
  try { f.run(); } catch (error) { failure = error; }
  expect(String(failure)).toBe("Error: The required Windows Node product proof could not be verified.");
  expect(String((failure as Error).stack)).not.toContain("PRIVATE"); expect(f.printed).not.toHaveBeenCalled(); expect(f.outputs).toEqual([]);
  const options = (f.invoked.mock.calls[0] as unknown as [string, string[], { stdio: string[]; maxBuffer: number }])[2];
  expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]); expect(options.maxBuffer).toBeGreaterThan(0); expect(options.maxBuffer).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it("sanitizes acquisition parsing failures even after future reviewed metadata passes its literal guard", () => {
  const spawn = vi.fn();
  // Reach the guarded parsing body without changing the operational ready:false literal or acquiring an artifact.
  const context = { Buffer, Object: { freeze: () => ({ ready: true, run: 1, commit: "1".repeat(40), artifact: 1,
    archiveBytes: 1, archiveSha256: "1".repeat(64), manifestSha256: "1".repeat(64) }) },
    process: { env: { GITHUB_SHA: "1".repeat(40) } }, require: (name: string) => {
      if (name === "node:fs") return { readFileSync: () => { throw new Error("PRIVATE synthetic manifest path"); } };
      if (name === "node:path") return path;
      if (name === "node:crypto") return {};
      if (name === "node:child_process") return { spawnSync: spawn, execFileSync: () => "1".repeat(40) };
      throw new Error("Unexpected workflow import");
    } };
  let failure: unknown; try { runInNewContext(producer, context); } catch (error) { failure = error; }
  expect(String(failure)).toBe("Error: Windows Node product input could not be verified."); expect(String((failure as Error).stack)).not.toContain("PRIVATE");
  expect(spawn).not.toHaveBeenCalled();
});

it("retains the exact unsupported child and PowerShell invocations and assertions in their explicit diagnostic workflow", () => {
  for (const file of ["experimental-windows-lpac-native", "isolated-windows-command-powershell-native"]) {
    expect(ci).not.toContain("test/integration/" + file + ".test.ts");
    expect(diagnostic).toContain("run: node scripts/run-integration.mjs test/integration/" + file + ".test.ts");
  }
  expect(diagnostic).toContain("os: [windows-2022, windows-2025]"); expect(diagnostic).not.toContain("continue-on-error");
  expect(diagnostic).toContain("!cancelled()");
  const child = read("test/integration/experimental-windows-lpac-native.test.ts");
  expect(child).toContain("expect(observed[9]).toBeGreaterThan(0)");
  expect(child).toContain("await expect(fixture.waitStopped(100)).rejects.toThrow(/descendants|root process/)");
  expect(child).toContain("const lease = await fixture.stop()");
  expect(read("test/integration/isolated-windows-command-powershell-native.test.ts")).toContain("No ACL/capability/AppContainer fallback is permitted");
});

it("keeps the old files-only ZIP proof independent of Node acquisition without weakening the strict Node package or release gate", () => {
  const workflow = read(".github/workflows/experimental-windows-controller.yml"), legacy = workflow.slice(workflow.indexOf("\n  packaged-controller:\n"));
  expect(legacy).toContain("name: Windows files-only ZIP and packaged controller dependencies");
  const recipe = script("Build the explicit files-only regression ZIP with normal fuses", workflow);
  expect(recipe.split("\n")).toEqual(["set -euo pipefail", "npm run build", "node scripts/package/remote-parts.mjs",
    "node scripts/package/stage.mjs", "node scripts/package/archive.mjs"]);
  expect(legacy).not.toMatch(/run: npm run package:win|--with-windows-node-toolchain|continue-on-error|--allow-missing/);
  expect(legacy).toContain("test/integration/windows-packaged-coding-native.test.ts --maxWorkers=1");
  expect(legacy).toContain('EMBER_PACKAGED_WINDOWS_CODING_TEST: "1"'); expect(legacy).toContain("name: windows-file-only-zip-${{ matrix.image }}");
  const probe = read("test/integration/windows-packaged-coding-native.test.ts");
  expect(probe).toContain('const allowed = ["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding"]');
  expect(probe).toContain('checks: { ran: 0, passed: 0, failed: 0 }');
  expect(JSON.parse(read("package.json")).scripts["package:win"]).toContain("stage.mjs --with-windows-node-toolchain");
  expect(product).toContain("stage.mjs --with-models --with-runtimes --with-windows-node-toolchain");
  const release = ci.slice(ci.indexOf("\n  release:\n"));
  expect(release).toContain("name: ember-windows-node-product-windows-2022"); expect(release).not.toContain("name: windows-file-only-zip-");
});
