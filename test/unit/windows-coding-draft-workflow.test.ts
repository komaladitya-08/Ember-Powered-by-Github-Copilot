/** Real workflow guard programs over synthetic reports only; never a Windows/keyring/native acceptance result. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const nativeRequire = createRequire(import.meta.url), workflow = fs.readFileSync(".github/workflows/windows-coding-draft-product.yml", "utf8");
const file = "test/integration/windows-coding-draft-product.test.ts", title = "saves an encrypted stopped repair, restarts the real app and keyring, imports against fresh source and starts only a new typed continuation before Forget drains writers";
function script(name: string) {
  const marker = "      - name: " + name + "\n", at = workflow.indexOf(marker); if (at < 0) throw new Error("Missing fixed workflow step.");
  const tail = workflow.slice(at + marker.length), end = tail.search(/\n(?: {6}-| {2}[a-z][\w-]*:)/), step = end < 0 ? tail : tail.slice(0, end);
  const run = step.indexOf("        run: |\n"); if (run < 0) throw new Error("Missing fixed workflow program.");
  return step.slice(run + "        run: |\n".length).split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}
function report() { return { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
  testResults: [{ name: path.resolve(file), status: "passed", assertionResults: [{ fullName: title, status: "passed" }] }] }; }
function execute(value: ReturnType<typeof report>, outcome: Record<string, unknown> = { status: 0 }) {
  const spawnSync = vi.fn(() => outcome), info = vi.fn(), fakeFs = { existsSync: (name: string) => name === file,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 }), readFileSync: () => JSON.stringify(value) };
  const work = () => runInNewContext(script("Run the one real Windows encrypted-draft Home case"), { process: { execPath: "/fixed-node", env: { RUNNER_TEMP: "/private-report" } },
    console: { info }, require: (name: string) => name === "node:fs" ? fakeFs : name === "node:child_process" ? { spawnSync } : nativeRequire(name) }, { timeout: 1000 });
  return { work, spawnSync, info };
}
it("keeps the one Windows/keyring case separate from WSL admission and both images mandatory", () => {
  expect(workflow).toContain("workflow_call:"); expect(workflow).toContain("workflow_dispatch:"); expect(workflow).toContain("pull_request:");
  expect(workflow).toContain("image: [windows-2022, windows-2025]"); expect(workflow).toContain("default: true");
  expect(workflow).toContain('EMBER_WINDOWS_CODING_DRAFT_PRODUCT_TEST: "1"'); expect(workflow).toContain(file);
  expect(workflow).not.toContain("EMBER_WSL_CODING_RESOURCES_TEST"); expect(workflow).not.toContain("setup-wsl@");
  expect(workflow).not.toMatch(/continue-on-error:\s*true|--no-sandbox|--remote-debugging|--inspect/);
  expect(fs.readFileSync(file, "utf8")).toContain(title);
});
it("the closed producer/source admission cannot download or spawn", () => {
  const spawnSync = vi.fn(), execFileSync = vi.fn();
  expect(() => runInNewContext(script("Require the reviewed POSIX producer and authenticate its exact archive"), { process: { env: {} },
    require: (name: string) => name === "node:child_process" ? { spawnSync, execFileSync } : nativeRequire(name) }, { timeout: 1000 })).toThrow();
  expect(spawnSync).not.toHaveBeenCalled(); expect(execFileSync).not.toHaveBeenCalled(); expect(workflow).toContain("ready: false");
  for (const field of ["assetProofCommit", "assetProofManifestSha256", "verifierFileSha256"]) expect(workflow).toContain(field + ": null");
});
it("requires a single exact passing file and sets the required flag on the one child", () => {
  const f = execute(report()); expect(f.work).not.toThrow(); expect(f.spawnSync).toHaveBeenCalledOnce();
  const args = f.spawnSync.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
  expect(args[1].slice(0, 2)).toEqual(["scripts/run-integration.mjs", file]); expect(args[2].env.EMBER_WINDOWS_CODING_DRAFT_PRODUCT_TEST).toBe("1");
});
it.each(["empty", "skip", "extra", "wrong-file", "wrong-title", "todo", "cancelled"])("rejects %s evidence", kind => {
  const value = report(); if (kind === "empty") value.numTotalTests = 0;
  if (kind === "skip") value.numPendingTests = 1;
  if (kind === "extra") value.testResults[0].assertionResults.push({ fullName: title, status: "passed" });
  if (kind === "wrong-file") value.testResults[0].name += ".foreign";
  if (kind === "wrong-title") value.testResults[0].assertionResults[0].fullName = "Foreign title";
  if (kind === "todo") value.numTodoTests = 1;
  if (kind === "cancelled") value.testResults[0].assertionResults[0].status = "cancelled";
  expect(execute(value).work).toThrow();
});
it("withholds child output/errors and emits only bounded timeout facts", () => {
  const f = execute(report(), { status: null, signal: "SIGTERM", error: Object.assign(new Error("PRIVATE synthetic error"), { code: "ETIMEDOUT" }), stdout: "PRIVATE output", stderr: "PRIVATE path" });
  expect(f.work).toThrow("private output is withheld"); expect(JSON.stringify(f.info.mock.calls)).not.toContain("PRIVATE");
  expect(f.info).toHaveBeenCalledExactlyOnceWith("Windows draft child refused", JSON.stringify({ schema: 1, child: 3, timeout: 1 }));
});
it.each(["failure", "cancelled", "skipped"])("rejects %s required leaves", result => {
  expect(() => runInNewContext(script("Require every configured product leaf"), { process: { env: { REQUIRED_RESULTS: JSON.stringify({ contracts: { result: "success" }, product: { result } }) } } })).toThrow();
});
