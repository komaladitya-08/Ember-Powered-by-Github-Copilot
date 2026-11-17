/** Execute only portable report/admission guards. No download, Windows process or authority is issued. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { WSL_PRODUCT_CASES, WSL_PRODUCT_FILES, wslProductTitle, type WslProductJourney } from "../fixtures/wsl-coding-product-contract";

const nativeRequire = createRequire(import.meta.url), workflow = fs.readFileSync(".github/workflows/wsl-coding-home.yml", "utf8");
function script(name: string, source = workflow) {
  const marker = "      - name: " + name + "\n", at = source.indexOf(marker); if (at < 0) throw new Error("Missing fixed workflow step.");
  const tail = source.slice(at + marker.length), end = tail.search(/\n(?: {6}-| {2}[a-z][\w-]*:)/), step = end < 0 ? tail : tail.slice(0, end);
  const run = step.indexOf("        run: |\n"); if (run < 0) throw new Error("Missing fixed workflow program.");
  return step.slice(run + "        run: |\n".length).split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}
function report(journey: WslProductJourney): {
  success: boolean; numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number;
  numTodoTests: number; numFailedTestSuites: number; numPendingTestSuites: number;
  testResults: { name: string; status: string; assertionResults: { fullName: string; status: string }[] }[];
} {
  const cases = WSL_PRODUCT_CASES[journey];
  return { success: true, numTotalTests: cases.length, numPassedTests: cases.length, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numFailedTestSuites: 0, numPendingTestSuites: 0, testResults: [{ name: path.resolve(WSL_PRODUCT_FILES[journey]), status: "passed",
      assertionResults: cases.map(name => ({ fullName: wslProductTitle(journey, name), status: "passed" })) }] };
}
function validate(value: ReturnType<typeof report>, journey: WslProductJourney, stepRequire = nativeRequire) {
  const text = JSON.stringify(value), contract = fs.readFileSync("test/fixtures/wsl-coding-product-contract.ts", "utf8");
  const info = vi.fn(), fakeFs = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: text.length }),
    readFileSync: (file: string) => file.endsWith("wsl-coding-product-contract.ts") ? contract : text };
  runInNewContext(script("Reject skipped, partial, foreign or extra WSL cases"), { process: { env: { PRODUCT_REPORT: "/report", EMBER_WSL_CODING_PRODUCT_JOURNEY: journey }, cwd: () => process.cwd() },
    console: { info }, require: (name: string) => name === "node:fs" ? fakeFs : stepRequire(name) }, { timeout: 3000 });
  return info;
}
it("configures both images, all three distinct leaves and a strict required caller without changing Node's inventory", () => {
  expect(workflow).toContain("workflow_call:"); expect(workflow).toContain("required-ci:"); expect(workflow).toContain("default: true");
  expect(workflow).toContain("workflow_dispatch:"); expect(workflow).toContain("pull_request:");
  expect(workflow).toContain("image: [windows-2022, windows-2025]"); expect(workflow).toContain("journey: [resources, source, packaged]");
  expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' || inputs.required-ci == true");
  expect(workflow).toContain("needs: [contracts, product]"); expect(workflow).not.toMatch(/continue-on-error:\s*true|--no-sandbox|--remote-debugging|--inspect/);
  for (const file of Object.values(WSL_PRODUCT_FILES)) expect(workflow).toContain(file);
  for (const flag of ["EMBER_WSL_CODING_RESOURCES_TEST", "EMBER_ELECTRON_WSL_CODING_PRODUCT_TEST", "EMBER_PACKAGED_WSL_CODING_PRODUCT_TEST"]) expect(workflow).toContain(flag + ': "1"');
});
it("retains the exact existing producer/extraction/source-reader programs except the reviewed proof tuple", () => {
  const original = fs.readFileSync(".github/workflows/windows-node-product.yml", "utf8");
  const normal = (value: string) => value.replace(/ready: (?:true|false),/, "ready: PIN,")
    .replace(/(assetProofCommit|assetProofManifestSha256|verifierFileSha256): (?:"[0-9a-f]+"|null),/g, "$1: PIN,")
    .replace("The fixed POSIX producer and expanded current-source graph are independently qualified.", "The fixed POSIX producer and current source graph must be independently qualified.")
    .replace("The fixed POSIX producer is authenticated; the expanded current-source graph awaits fresh qualification.", "The fixed POSIX producer and current source graph must be independently qualified.");
  for (const name of ["Require the reviewed POSIX producer and authenticate its exact archive", "Extract only the authenticated producer members", "Bind all product journeys to the reviewed native source catalog"]) {
    expect(normal(script(name))).toBe(normal(script(name, original)));
  }
});
it("binds WSL Home to the reviewed fixed producer and qualified source proof", () => {
  const literal = script("Require the reviewed POSIX producer and authenticate its exact archive").match(/const reviewed = Object\.freeze\([\s\S]*?\);/)?.[0];
  expect(literal).toBeDefined();
  const reviewed = runInNewContext(literal! + "\nreviewed;");
  expect(reviewed).toEqual({ ready: true, run: 43991252195, commit: "b75c944dec58973d157542e2d4d2db3720667982", artifact: 14289217635, archiveBytes: 38425334,
    archiveSha256: "cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62",
    manifestSha256: "d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f",
    assetProofCommit: "aa5345a934d75d9a7924a4b7984c3b27c9521020",
    assetProofManifestSha256: "91f162e84a22f199606acee94131bcb605761d2796e57d9148c77311e09e8db6",
    verifierFileSha256: "9674e7b019cf736024b00593e0a73cfa4c8a30ed57f8135baf749b15b21e2a97" });
  expect(Object.isFrozen(reviewed)).toBe(true);
});
it.each([
  ["closed", "ready: true,", "ready: false,"],
  ["missing proof commit", 'assetProofCommit: "aa5345a934d75d9a7924a4b7984c3b27c9521020",', "assetProofCommit: null,"],
  ["missing source manifest", 'assetProofManifestSha256: "91f162e84a22f199606acee94131bcb605761d2796e57d9148c77311e09e8db6",', "assetProofManifestSha256: null,"],
  ["missing verifier", 'verifierFileSha256: "9674e7b019cf736024b00593e0a73cfa4c8a30ed57f8135baf749b15b21e2a97",', "verifierFileSha256: null,"],
] as const)("refuses %s proof before any download, source read or spawn", (_kind, before, after) => {
  expect(workflow.split(before)).toHaveLength(2);
  const closed = workflow.replace(before, after), spawnSync = vi.fn(), execFileSync = vi.fn(), readFileSync = vi.fn();
  expect(() => runInNewContext(script("Require the reviewed POSIX producer and authenticate its exact archive", closed), {
    process: { env: {} }, console: { info() {} }, require: (name: string) => name === "node:child_process" ? { spawnSync, execFileSync }
      : name === "node:fs" ? { readFileSync } : nativeRequire(name),
  }, { timeout: 1000 })).toThrow("blocked pending literal reviewed POSIX producer metadata");
  expect(spawnSync).not.toHaveBeenCalled(); expect(execFileSync).not.toHaveBeenCalled(); expect(readFileSync).not.toHaveBeenCalled();
});
it("uses the latest approved system-prefix provisioning rather than a private unsupported Node prefix", () => {
  expect(workflow).toContain("shell: bash"); expect(workflow).toContain("Vampire/setup-wsl@4c48163d9f981914dd8caa0fc335fe19cca5bff4");
  for (const text of ["test ! -e /opt/node", "test ! -L /opt/node", "test ! -L /opt/node/bin/node", "chown -R root:root /opt/node", "chmod -R go-w /opt/node", "test ! -e /usr/bin/node", "test ! -L /usr/bin/node", 'test "$(readlink -f /usr/bin/node)" = /opt/node/bin/node']) expect(workflow).toContain(text);
  expect(workflow).not.toContain("/opt/ember-wsl-coding-node"); expect(workflow).toContain("--with-windows-node-toolchain --with-wsl-coding-tools");
});
it.each(["resources", "source", "packaged"] as const)("executes the real exact %s report contract", journey => { expect(validate(report(journey), journey)).toHaveBeenCalledOnce(); });
it("resolves the report transformer from the checkout when the real Node step lives outside its module ancestry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-report-step-"));
  try {
    const stepRequire = createRequire(path.join(root, "step.cjs"));
    expect(() => stepRequire("esbuild")).toThrow();
    expect(validate(report("source"), "source", stepRequire)).toHaveBeenCalledOnce();
  } finally { fs.rmSync(root, { recursive: true, force: false }); }
});
it.each(["empty", "skip", "extra", "wrong-file", "duplicate", "todo", "cancelled"])("refuses %s evidence", kind => {
  const value = report("source");
  if (kind === "empty") { value.numTotalTests = 0; value.testResults[0].assertionResults = []; }
  if (kind === "skip") value.numPendingTests = 1;
  if (kind === "extra") value.testResults[0].assertionResults.push({ fullName: "Foreign case", status: "passed" });
  if (kind === "wrong-file") value.testResults[0].name += ".foreign";
  if (kind === "duplicate") value.testResults[0].assertionResults[1].fullName = value.testResults[0].assertionResults[0].fullName;
  if (kind === "todo") value.numTodoTests = 1;
  if (kind === "cancelled") value.testResults[0].assertionResults[0].status = "cancelled";
  expect(() => validate(value, "source")).toThrow();
});
it.each(["failure", "cancelled", "skipped", "timed_out"])("the configured aggregate refuses %s", result => {
  expect(() => runInNewContext(script("Require every configured product leaf"), { process: { env: { REQUIRED_RESULTS: JSON.stringify({ contracts: { result: "success" }, product: { result } }) } } })).toThrow();
});
it("the aggregate accepts only both required jobs succeeding", () => {
  expect(() => runInNewContext(script("Require every configured product leaf"), { process: { env: { REQUIRED_RESULTS: JSON.stringify({ contracts: { result: "success" }, product: { result: "success" } }) } } })).not.toThrow();
});
