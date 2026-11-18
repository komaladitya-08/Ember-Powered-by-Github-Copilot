/** Execute only portable report/admission guards. No download, Windows process or authority is issued. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { sourceSummaryKind } from "../fixtures/wsl-coding-product-observation";
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

/** Exercise the actual failed-child branch; its projection can never append successful proof outputs. */
async function failedChild(journey: WslProductJourney, value: unknown, options: { stdout?: string; metadata?: object; handleMetadata?: object; namedMetadata?: object; closeFails?: boolean; malformed?: boolean; outcome?: object; fixtureFailure?: boolean } = {}) {
  const bytes = Buffer.from(options.malformed ? "PRIVATE malformed report" : JSON.stringify(value)), info = vi.fn(), appendFileSync = vi.fn(), spawnSync = vi.fn(() => ({ status: 1, signal: null, stdout: Buffer.from(options.stdout ?? "PRIVATE child transcript\n"), ...options.outcome }));
  const metadata = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: bytes.length, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4, ...options.metadata };
  let names = 0;
  const fakeFs = { constants: fs.constants, existsSync: (file: string) => file === WSL_PRODUCT_FILES[journey],
    lstatSync: (file: string) => file.endsWith(".zip") ? { isFile: () => true, isSymbolicLink: () => false, nlink: 1 } : ++names === 1 ? metadata : { ...metadata, ...options.namedMetadata },
    openSync: vi.fn(() => 10), fstatSync: () => ({ ...metadata, ...options.handleMetadata }), readSync: (_fd: number, target: Buffer, offset: number, length: number, position: number) => bytes.copy(target, offset, position, position + length),
    closeSync: vi.fn(() => { if (options.closeFails) throw new Error("PRIVATE close failure"); }),
    readFileSync: () => JSON.stringify({ version: "1.2.3" }), appendFileSync };
  const withWslProductFixture = (run: () => unknown) => {
    run();
    if (options.fixtureFailure) throw new Error("The WSL qualification fixture did not stay open through the proof.");
  };
  await expect(runInNewContext(script("Run exactly the configured WSL product cases"), {
    Buffer, console: { info }, process: { execPath: "fixed-node", cwd: () => process.cwd(), env: { EMBER_WSL_CODING_PRODUCT_JOURNEY: journey, RUNNER_TEMP: "/fixed-report-parent", GITHUB_OUTPUT: "/fixed-output" } },
    require: (name: string) => name === "node:fs" ? fakeFs : name === "node:child_process" ? { spawnSync }
      : name.endsWith("wsl-coding-product-fixture.cjs") ? { withWslProductFixture } : nativeRequire(name),
  }, { timeout: 1000 })).rejects.toThrow("The required WSL product child failed; private output is withheld.");
  expect(spawnSync).toHaveBeenCalledOnce(); expect(spawnSync.mock.calls[0]).toBeDefined(); expect(appendFileSync).not.toHaveBeenCalled();
  expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE");
  return { frames: info.mock.calls.map(([name, json]) => [name, JSON.parse(json)] as const), fakeFs, spawnSync };
}
function failedReport(journey: WslProductJourney, phase = 2) {
  const value = report(journey); value.success = false; value.numPassedTests--; value.numFailedTests = 1; value.numFailedTestSuites = 1; value.testResults[0].status = "failed";
  const assertion = value.testResults[0].assertionResults[0]; assertion.status = "failed";
  const text = journey === "source" ? "Windows WSL source journey refused (case 1, phase " + phase + ")." : "Windows WSL product journey refused (phase " + phase + ").";
  Object.assign(assertion, { failureMessages: ["Error: " + text] }); return value;
}
it.each(["resources", "source", "packaged"] as const)("projects only numeric exact %s failed-case inventory and retains the fatal outcome", async journey => {
  const value = failedReport(journey), { frames, spawnSync } = await failedChild(journey, value);
  const inventory = frames.find(([name]) => name === "WSL product failure inventory")?.[1];
  expect(inventory).toEqual({ schema: 1, journey: ["resources", "source", "packaged"].indexOf(journey) + 1, report: 1,
    passed: WSL_PRODUCT_CASES[journey].length - 1, failed: 1, pending: 0, todo: 0,
    cases: WSL_PRODUCT_CASES[journey].map((_name, index) => ({ case: index + 1, status: index ? 1 : 2, phase: index ? 0 : 2 })) });
  expect(spawnSync.mock.calls[0]).toEqual([expect.any(String), expect.arrayContaining([WSL_PRODUCT_FILES[journey]]), expect.objectContaining({ timeout: 20 * 60_000, maxBuffer: 2 * 1024 * 1024 })]);
});
it.each(["foreign-file", "foreign-title", "duplicate", "partial", "extra", "counter", "unknown-status", "malformed-json", "symlink", "hardlink", "oversize", "close-error"])("keeps %s failed reports wholly unavailable without exposing private fields", async kind => {
  const value = failedReport("source");
  if (kind === "foreign-file") value.testResults[0].name += ".PRIVATE";
  if (kind === "foreign-title") value.testResults[0].assertionResults[0].fullName = "PRIVATE foreign title";
  if (kind === "duplicate") value.testResults[0].assertionResults[1].fullName = value.testResults[0].assertionResults[0].fullName;
  if (kind === "partial") value.testResults[0].assertionResults.pop();
  if (kind === "extra") value.testResults[0].assertionResults.push({ fullName: "PRIVATE extra case", status: "failed" });
  if (kind === "counter") value.numPassedTests++;
  if (kind === "unknown-status") value.testResults[0].assertionResults[0].status = "PRIVATE unknown status";
  const { frames } = await failedChild("source", value, { malformed: kind === "malformed-json", closeFails: kind === "close-error",
    metadata: kind === "symlink" ? { isSymbolicLink: () => true } : kind === "hardlink" ? { nlink: 2 } : kind === "oversize" ? { size: 16 * 1024 * 1024 + 1 } : undefined });
  expect(frames[1]).toEqual(["WSL product failure inventory", { schema: 1, journey: 2, report: 0, passed: 0, failed: 0, pending: 0, todo: 0, cases: [] }]);
});
it.each(["private", "substring", "newline", "wrong-case", "out-of-range", "multiple"])("refuses %s phase messages while retaining the exact numeric case inventory", async kind => {
  const value = failedReport("source"), assertion = value.testResults[0].assertionResults[0];
  const message = "Error: Windows WSL source journey refused (case 1, phase 2).";
  const text = kind === "private" ? "PRIVATE stack and path" : kind === "substring" ? "PRIVATE prefix " + message : kind === "newline" ? message + "\n" : kind === "wrong-case" ? message.replace("case 1", "case 2") : kind === "out-of-range" ? message.replace("phase 2", "phase 49") : message;
  Object.assign(assertion, { failureMessages: kind === "multiple" ? [text, message] : [text] });
  const { frames } = await failedChild("source", value); expect(frames[1][1].report).toBe(1); expect(frames[1][1].cases[0]).toEqual({ case: 1, status: 2, phase: 0 });
});
it("projects the exact complete cached packaged numeric frame from otherwise private captured output", async () => {
  const { frames } = await failedChild("packaged", failedReport("packaged"), { stdout: 'PRIVATE unrelated transcript\nWindows WSL packaged cached observation {"phase":2,"operation":9,"bridgeStage":30,"projectStage":0,"selection":0,"selectionShape":0}\r\nPRIVATE tail\n' });
  expect(frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 1, phase: 2, operation: 9, bridgeStage: 30, projectStage: 0, selection: 0, selectionShape: 0 }]);
});
it.each([1, 15, 24])("projects packaged project stage %i only for a verified failed phase-six case", async projectStage => {
  const stdout = "Windows WSL packaged cached observation " + JSON.stringify({ phase: 6, operation: 2, bridgeStage: 25, projectStage, selection: 0, selectionShape: 0 }) + "\n";
  const { frames } = await failedChild("packaged", failedReport("packaged", 6), { stdout });
  expect(frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 1, phase: 6, operation: 2, bridgeStage: 25, projectStage, selection: 0, selectionShape: 0 }]);
  const wrongPhase = await failedChild("packaged", failedReport("packaged", 5), { stdout });
  expect(wrongPhase.frames[2][1].projectStage).toBe(0);
  const signal = await failedChild("packaged", failedReport("packaged", 6), { stdout, outcome: { signal: "SIGTERM", status: null } });
  expect(signal.frames[2][1].projectStage).toBe(0);
});
it.each([16, 80, 219])("projects selection guard %i only with a verified stage-fifteen project failure", async selection => {
  const frame = (projectStage: number, value: number) => "Windows WSL packaged cached observation " + JSON.stringify({ phase: 6, operation: 2, bridgeStage: 25, projectStage, selection: value, selectionShape: 0 }) + "\n";
  const { frames } = await failedChild("packaged", failedReport("packaged", 6), { stdout: frame(15, selection) });
  expect(frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 1, phase: 6, operation: 2, bridgeStage: 25, projectStage: 15, selection, selectionShape: 0 }]);
  const unverified = await failedChild("packaged", failedReport("packaged", 5), { stdout: frame(15, selection) });
  expect(unverified.frames[2][1]).toMatchObject({ projectStage: 0, selection: 0, selectionShape: 0 });
  for (const stdout of [frame(14, selection), frame(15, 15), frame(15, 28), frame(15, 220)]) {
    const refused = await failedChild("packaged", failedReport("packaged", 6), { stdout });
    expect(refused.frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 0, phase: 0, operation: 0, bridgeStage: 0, projectStage: 0, selection: 0, selectionShape: 0 }]);
  }
});
it("projects the counted shape under the combo only beside a none-or-several selected refusal", async () => {
  const frame = (selection: number, selectionShape: number) => "Windows WSL packaged cached observation " + JSON.stringify({ phase: 6, operation: 2, bridgeStage: 25, projectStage: 15, selection, selectionShape }) + "\n";
  for (const [selection, selectionShape] of [[112, 771], [128, 2047], [112, 0]]) {
    const { frames } = await failedChild("packaged", failedReport("packaged", 6), { stdout: frame(selection, selectionShape) });
    expect(frames[2][1]).toMatchObject({ available: 1, selection, selectionShape });
  }
  for (const stdout of [frame(96, 771), frame(0, 1), frame(112, 2048)]) {
    const refused = await failedChild("packaged", failedReport("packaged", 6), { stdout });
    expect(refused.frames[2][1]).toMatchObject({ available: 0, selection: 0, selectionShape: 0 });
  }
});
it.each([{ phase: 6, projectStage: 0 }, { phase: 6, projectStage: 25 }, { phase: 5, projectStage: 3 }])("rejects inconsistent packaged project frame %j", async ({ phase, projectStage }) => {
  const stdout = "Windows WSL packaged cached observation " + JSON.stringify({ phase, operation: 2, bridgeStage: 25, projectStage, selection: 0, selectionShape: 0 }) + "\n";
  const { frames } = await failedChild("packaged", failedReport("packaged", phase), { stdout });
  expect(frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 0, phase: 0, operation: 0, bridgeStage: 0, projectStage: 0, selection: 0, selectionShape: 0 }]);
});
it.each(["partial", "duplicate", "partial-duplicate", "prefix", "extra-key", "phase-range", "operation-range", "bridge-range", "oversize"])("keeps %s cached packaged output unavailable", async kind => {
  const line = 'Windows WSL packaged cached observation {"phase":2,"operation":9,"bridgeStage":30,"projectStage":0,"selection":0,"selectionShape":0}';
  const stdout = kind === "partial" ? line : kind === "duplicate" ? line + "\n" + line + "\n" : kind === "partial-duplicate" ? line + "\n" + line : kind === "prefix" ? "PRIVATE " + line + "\n"
    : kind === "extra-key" ? line.replace("}", ',"PRIVATE":1}') + "\n" : kind === "phase-range" ? line.replace('"phase":2', '"phase":49') + "\n"
    : kind === "operation-range" ? line.replace('"operation":9', '"operation":10') + "\n" : kind === "bridge-range" ? line.replace('"bridgeStage":30', '"bridgeStage":31') + "\n" : "PRIVATE".repeat(400_000);
  const { frames } = await failedChild("packaged", failedReport("packaged"), { stdout });
  expect(frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 0, phase: 0, operation: 0, bridgeStage: 0, projectStage: 0, selection: 0, selectionShape: 0 }]);
});
it.each([{ error: { code: "ETIMEDOUT" }, status: null }, { signal: "SIGTERM", status: null }])("keeps original child error classification and fatal refusal with outcome %j", async outcome => {
  const { frames } = await failedChild("resources", failedReport("resources"), { outcome });
  expect(frames[0]).toEqual(["WSL product child refused", { schema: 1, child: "error" in outcome ? 3 : 2, timeout: "error" in outcome ? 1 : 0 }]);
});

it("uses handle clocks only against handle clocks and pathname clocks only against pathname clocks", async () => {
  const { frames } = await failedChild("resources", failedReport("resources"), { handleMetadata: { mtimeMs: 13, ctimeMs: 14 } });
  expect(frames[1][1].report).toBe(1); expect(frames[1][1].failed).toBe(1);
  const changed = await failedChild("resources", failedReport("resources"), { namedMetadata: { ctimeMs: 99 } });
  expect(changed.frames[1][1].report).toBe(0); expect(changed.frames[1][1].cases).toEqual([]);
});

it("accepts only known SGR decoration around a complete canonical packaged frame, as emitted by the real Vitest formatter", async () => {
  const line = 'Windows WSL packaged cached observation {"phase":2,"operation":9,"bridgeStage":30,"projectStage":0,"selection":0,"selectionShape":0}';
  const { frames } = await failedChild("packaged", failedReport("packaged"), { stdout: "\x1b[22m" + line + "\x1b[39m\n" });
  expect(frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 1, phase: 2, operation: 9, bridgeStage: 30, projectStage: 0, selection: 0, selectionShape: 0 }]);
});
it.each(["other-escape", "control-prefix", "partial-sgr", "private-prefix", "decorated-duplicate"])("refuses %s around otherwise canonical cached packaged data", async kind => {
  const line = 'Windows WSL packaged cached observation {"phase":2,"operation":9,"bridgeStage":30,"projectStage":0,"selection":0,"selectionShape":0}';
  const stdout = kind === "other-escape" ? "\x1b[2J" + line + "\n" : kind === "control-prefix" ? "\0" + line + "\n" : kind === "partial-sgr" ? "\x1b[22" + line + "\n"
    : kind === "private-prefix" ? "\x1b[22mPRIVATE " + line + "\x1b[39m\n" : "\x1b[22m" + line + "\n" + line + "\x1b[39m\n";
  const { frames } = await failedChild("packaged", failedReport("packaged"), { stdout });
  expect(frames[2]).toEqual(["WSL product failure cached stage", { schema: 1, available: 0, phase: 0, operation: 0, bridgeStage: 0, projectStage: 0, selection: 0, selectionShape: 0 }]);
});

it("preserves bounded child failure evidence if the fixture pipe also fails", async () => {
  const { frames } = await failedChild("resources", failedReport("resources"), { fixtureFailure: true });
  expect(frames[1][1].cases[0]).toEqual({ case: 1, status: 2, phase: 2 });
});

it.each(["held", "startup-failure", "early-close", "proof-failure", "pipe-error", "foreign-byte"] as const)("owns the dedicated fixture pipe through the exact proof step (%s)", async mode => {
  const source = fs.readFileSync("test/fixtures/wsl-coding-product-fixture.cjs", "utf8"), module = { exports: {} };
  const childCommand = mode === "startup-failure" ? "process.exit(1)"
    : mode === "early-close" ? 'process.stdin.once("data", bytes => { process.stdout.end(bytes); process.stdin.destroy(); })'
    : "process.stdin.pipe(process.stdout)";
  const closeObserved = vi.fn(), fixtureTimer = vi.fn(setTimeout);
  const observed = { output: "", outputAtEof: "" };
  const open = vi.fn(() => {
    const child = spawn(process.execPath, ["-e", childCommand], { stdio: ["pipe", "pipe", "ignore"] });
    child.once("close", closeObserved);
    child.stdout.on("data", bytes => { observed.output += bytes.toString("latin1"); });
    const end = child.stdin.end;
    child.stdin.end = (...args: unknown[]) => {
      observed.outputAtEof = observed.output;
      return Reflect.apply(end, child.stdin, args);
    };
    return child;
  });
  runInNewContext(source, { module, process, setTimeout: fixtureTimer, clearTimeout, require: () => ({ spawn: open }) }, { timeout: 1000 });
  const info = vi.fn(), appendFileSync = vi.fn(), spawnSync = vi.fn(() => {
    expect(closeObserved).not.toHaveBeenCalled();
    const child = open.mock.results[0].value;
    if (mode === "pipe-error") child.stdout.emit("error", new Error("PRIVATE fixture error"));
    if (mode === "foreign-byte") child.stdout.emit("data", Buffer.from("PRIVATE fixture bytes"));
    if (mode === "proof-failure") throw new Error("controlled proof failure");
    return { status: 0, signal: null, stdout: Buffer.from(resourceStageFrame(1) + "\n") };
  });
  const proof = runInNewContext(script("Run exactly the configured WSL product cases"), {
    console: { info }, process: { execPath: process.execPath, cwd: () => process.cwd(), env: { EMBER_WSL_CODING_PRODUCT_JOURNEY: "resources", RUNNER_TEMP: "/fixed-report-parent", GITHUB_OUTPUT: "/fixed-output" } },
    require: (name: string) => name === "node:fs" ? { existsSync: (file: string) => file === WSL_PRODUCT_FILES.resources, appendFileSync }
      : name === "node:child_process" ? { spawnSync }
      : name.endsWith("wsl-coding-product-fixture.cjs") ? module.exports : nativeRequire(name),
  }, { timeout: 1000 });
  if (mode === "held") expect(await proof).toBeUndefined();
  else if (mode === "proof-failure") await expect(proof).rejects.toThrow("controlled proof failure");
  else await expect(proof).rejects.toThrow(/The WSL qualification fixture/);
  expect(open).toHaveBeenCalledExactlyOnceWith("wsl.exe", ["-d", "Ubuntu-22.04", "-u", "ember", "--cd", "/", "--exec", "/bin/cat"],
    expect.objectContaining({ stdio: ["pipe", "pipe", "ignore"] }));
  expect(spawnSync).toHaveBeenCalledTimes(mode === "startup-failure" ? 0 : 1);
  expect(closeObserved).toHaveBeenCalledOnce();
  expect(fixtureTimer.mock.calls.map(([, ms]) => ms)).toEqual(mode === "startup-failure" ? [15_000] : [15_000, 5_000]);
  if (mode === "held" || mode === "proof-failure") expect(observed.outputAtEof).toBe("RC");
  expect(info).not.toHaveBeenCalled();
  expect(appendFileSync).toHaveBeenCalledTimes(mode === "held" ? 1 : 0);
});

function resourceStageFrame(stage: number, caseIndex = 1) {
  return 'Windows WSL resource workspace observation {"case":' + caseIndex + ',"stage":' + stage + '}';
}

function resourceStageReport(phase = 5, caseIndex = 1) {
  const value = failedReport("resources", phase), [first, second] = value.testResults[0].assertionResults;
  second.status = "failed";
  Object.assign(second, { failureMessages: ["Error: Windows WSL product journey refused (phase " + (caseIndex === 1 ? 1 : phase) + ")."] });
  if (caseIndex === 1) {
    value.numPassedTests = 0;
    value.numFailedTests = 2;
  } else {
    first.status = "passed";
    Object.assign(first, { failureMessages: undefined });
  }
  return value;
}

it.each([1, 2, 3, 4, 5])("projects resource stage %i only with its verified failed phase-five case", async stage => {
  const { frames } = await failedChild("resources", resourceStageReport(), {
    stdout: "PRIVATE unrelated\n\x1b[22m" + resourceStageFrame(stage) + "\x1b[39m\r\nPRIVATE tail\n",
  });
  expect(frames[2]).toEqual(["WSL product failure resource workspace stage", { schema: 1, available: 1, case: 1, stage }]);
});

it("projects a second-case stage only when the first resource case passed", async () => {
  const { frames } = await failedChild("resources", resourceStageReport(5, 2), { stdout: resourceStageFrame(3, 2) + "\n" });
  expect(frames[2]).toEqual(["WSL product failure resource workspace stage", { schema: 1, available: 1, case: 2, stage: 3 }]);
});

it.each(["absent", "partial", "duplicate", "partial-duplicate", "prefix", "extra-key", "out-of-range", "other-case", "other-phase", "untrusted-report", "contradictory-report", "wrong-quarantine", "signal", "oversize"] as const)("keeps %s resource stage unknown", async kind => {
  const value = kind === "wrong-quarantine" ? failedReport("resources", 5)
    : resourceStageReport(kind === "other-phase" ? 4 : 5), line = resourceStageFrame(4);
  const stdout = kind === "absent" ? "" : kind === "partial" ? line : kind === "duplicate" ? line + "\n" + line + "\n"
    : kind === "partial-duplicate" ? line + "\n" + line : kind === "prefix" ? "PRIVATE " + line + "\n"
      : kind === "extra-key" ? line.replace("}", ',"PRIVATE":1}') + "\n" : kind === "out-of-range" ? resourceStageFrame(6) + "\n"
        : kind === "other-case" ? resourceStageFrame(4, 2) + "\n" : kind === "oversize" ? "PRIVATE".repeat(400_000) + "\n" + line + "\n" : line + "\n";
  if (kind === "contradictory-report") {
    const [first, second] = value.testResults[0].assertionResults;
    Object.assign(second, { failureMessages: Reflect.get(first, "failureMessages") });
  }
  const { frames } = await failedChild("resources", value, {
    stdout, malformed: kind === "untrusted-report", outcome: kind === "signal" ? { status: null, signal: "SIGTERM" } : undefined,
  });
  expect(frames[2]).toEqual(["WSL product failure resource workspace stage", { schema: 1, available: 0, case: 0, stage: 0 }]);
});

it.each([1, 2, 3, 4, 5])("records resource assembly stage %i in the actual binding callback before cleanup", async stage => {
  const source = fs.readFileSync("test/integration/wsl-coding-product-resources.test.ts", "utf8");
  const enumSource = source.slice(source.indexOf("const workspaceStage"), source.indexOf("type WorkspaceStage"));
  const assembly = source.slice(source.indexOf("      phase = 5;"), source.indexOf("      const observations:"));
  const freeze = source.slice(source.indexOf("    if (phase === 5) refusedStage"), source.indexOf("    task.abort(); try { await resource?.invalidate()"));
  const graph = {}, task = new AbortController(), close = vi.fn(), connection = { close };
  const unavailable = () => { throw new Error("PRIVATE original refusal"); };
  const observed = await runInNewContext(enumSource.replace(" as const", "") + `
    (async () => {
      let phase = 4, assembling, refusedStage, workspace, observeCalls, refusedCalls;
      try { ${assembly} }
      catch {
        ${freeze}
        assembling = workspaceStage.readiness;
        return refusedStage;
      }
      return 0;
    })();`, {
    graph, task, spec: {}, current: () => true, transport: {}, scriptLinuxPath: "/fixed",
    path, input: { repository: "/repository" }, expect, known: (work: Promise<unknown>) => work,
    observeResourceWorkspaceCalls: () => () => ({ rpc: 0, edge: 0, refusal: 0, reply: 0 }), resourceOuterKind: () => 3, error: new Error(),
    connectWslCodingHelper: async () => stage === 2 ? unavailable() : connection,
    readWslCodingTypeScriptArchive: () => stage === 3 ? unavailable() : Buffer.alloc(1),
    resource: { async createWslWorkspace(_spec: unknown, _signal: AbortSignal, _current: () => boolean, binding: { open(): Promise<unknown> }) {
      if (stage === 1) unavailable();
      await binding.open();
      if (stage === 4) unavailable();
      return { executionRoot: "/work", nodeAvailable: false };
    } },
  }, { timeout: 1000 });
  expect(observed).toBe(stage);
  expect(close).toHaveBeenCalledTimes(stage === 3 ? 1 : 0);
});

function sourceTerminalReport(phase = 6) {
  const value = failedReport("source", phase);
  for (const [index, assertion] of value.testResults[0].assertionResults.entries()) {
    if (index === 0) continue;
    assertion.status = "failed";
    Object.assign(assertion, { failureMessages: ["Error: Windows WSL source journey refused (case " + (index + 1) + ", phase 1)."] });
  }
  value.numPassedTests = 0;
  value.numFailedTests = WSL_PRODUCT_CASES.source.length;
  return value;
}

function sourceTerminalFrame(episode: number, stage: number, session: number, turn: number) {
  return "Windows WSL source terminal observation " + JSON.stringify({ episode, stage, session, turn });
}

it.each([[1, 1, 5, 0], [2, 2, 4, 3], [1, 3, 4, 1]])("projects source repair episode %i stage %i with closed observations", async (episode, stage, session, turn) => {
  const { frames } = await failedChild("source", sourceTerminalReport(), { stdout: "\x1b[22m" + sourceTerminalFrame(episode, stage, session, turn) + "\x1b[39m\r\n" });
  expect(frames[2]).toEqual(["WSL product failure source terminal stage", { schema: 1, available: 1, episode, stage, session, turn }]);
});

it.each(["partial", "duplicate", "episode", "stage", "session", "turn", "invalid-session-stage", "invalid-idle-stage", "invalid-results-stage", "other-phase", "not-quarantined", "untrusted-report"] as const)("keeps %s source terminal observations unknown", async kind => {
  const value = kind === "not-quarantined" ? failedReport("source", 6) : sourceTerminalReport(kind === "other-phase" ? 5 : 6);
  const valid = sourceTerminalFrame(1, 3, 4, 1);
  const line = kind === "episode" ? sourceTerminalFrame(3, 3, 4, 1) : kind === "stage" ? sourceTerminalFrame(1, 4, 4, 1)
    : kind === "session" ? sourceTerminalFrame(1, 1, 7, 0) : kind === "turn" ? sourceTerminalFrame(2, 2, 4, 5)
      : kind === "invalid-session-stage" ? sourceTerminalFrame(1, 1, 4, 0) : kind === "invalid-idle-stage" ? sourceTerminalFrame(1, 2, 3, 2)
        : kind === "invalid-results-stage" ? sourceTerminalFrame(1, 3, 4, 4) : valid;
  const stdout = kind === "partial" ? line : kind === "duplicate" ? line + "\n" + line + "\n" : line + "\n";
  const { frames } = await failedChild("source", value, { stdout, malformed: kind === "untrusted-report" });
  expect(frames[2]).toEqual(["WSL product failure source terminal stage", { schema: 1, available: 0, episode: 0, stage: 0, session: 0, turn: 0 }]);
});

it.each([[0, "failed", "idle", 1, 5, 0], [1, "done", "held", 2, 4, 4], [1, "done", "idle", 3, 4, 1]] as const)(
  "caches the existing source terminal polls for episode index %i with session %s and turn %s",
  async (index, status, turn, stage, sessionId, turnId) => {
    const source = fs.readFileSync("test/integration/wsl-coding-product-electron.test.ts", "utf8");
    const definitions = source.slice(source.indexOf("const sourceTerminalStage"), source.indexOf("class Journey"));
    const method = source.slice(source.indexOf("  async terminal(index"), source.indexOf("  async results()"));
    const freeze = source.slice(source.indexOf("    if (phase === 6 && fixture?.terminalObservation)"), source.indexOf("  finally {\n    quarantined = true;"));
    const { transformSync } = nativeRequire("esbuild");
    const extracted = transformSync(definitions + `
      (async () => {
        const fixture = { kind: "repair", sessions, home: { evaluate }, ${method} };
        try { await fixture.terminal(index, "done"); } catch {}
        let refusedTerminal, refusedDetail;
        const phase = fixture.phase;
        ${freeze.slice(0, freeze.lastIndexOf("  }"))}
        fixture.terminalObservation.stage = 0;
        return { refusedTerminal, refusedDetail };
      })();`, { loader: "ts", target: "node22" }).code;
    const sessions = vi.fn(async () => Array.from({ length: index + 1 }, () => ({ status, summary: "The coding worker did not report an explicit completed result." })));
    const terminalEvidence = vi.fn(() => ({ steps: 4, command: 1 }));
    const evaluate = vi.fn(async () => turn);
    const poll = (read: () => Promise<unknown>) => ({ async toBe(expected: unknown) { expect(await read()).toBe(expected); } });
    const observed = await runInNewContext(extracted, { expect: { poll }, sessions, evaluate, index, sourceSummaryKind, model: { terminalEvidence } }, { timeout: 1000 });
    expect(observed.refusedTerminal).toEqual({ episode: index + 1, stage, session: sessionId, turn: turnId });
    expect(Object.isFrozen(observed.refusedTerminal)).toBe(true);
    expect(observed.refusedDetail).toEqual({ episode: index + 1, summaryKind: 6, steps: 4, command: 1 });
    expect(Object.isFrozen(observed.refusedDetail)).toBe(true);
    expect(terminalEvidence).toHaveBeenCalledExactlyOnceWith(index + 1);
    expect(sessions).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledTimes(stage === 1 ? 0 : 1);
  },
);

it.each(["resources", "source"] as const)("withholds contradictory %s stages without changing the failed-case inventory", async journey => {
  const value = journey === "resources" ? resourceStageReport() : sourceTerminalReport();
  const stdout = (journey === "resources" ? resourceStageFrame(3) : sourceTerminalFrame(1, 3, 4, 1)) + "\n";
  const valid = await failedChild(journey, value, { stdout });
  value.success = true;
  const contradictory = await failedChild(journey, value, { stdout });
  expect(contradictory.frames.slice(0, 2)).toEqual(valid.frames.slice(0, 2));
  expect(contradictory.frames[1][1]).toMatchObject({ report: 1, failed: WSL_PRODUCT_CASES[journey].length });
  expect(valid.frames[2][1]).toMatchObject({ available: 1, stage: 3 });
  expect(contradictory.frames[2][1]).toMatchObject({ available: 0, stage: 0 });
});

const resourceDetail = 'Windows WSL resource workspace detail {"case":1,"rpc":2,"edge":3,"refusal":1,"reply":0,"outer":2}';
const sourceDetail = 'Windows WSL source terminal detail {"episode":1,"summaryKind":6,"steps":4,"command":1}';

it.each(["resources", "source"] as const)("projects only report-bound optional %s details", async journey => {
  const resource = journey === "resources";
  const report = resource ? resourceStageReport() : sourceTerminalReport();
  const prior = resource ? resourceStageFrame(4) : sourceTerminalFrame(1, 1, 5, 0);
  const detail = resource ? resourceDetail : sourceDetail;
  const without = await failedChild(journey, report, { stdout: prior + "\n" });
  const withDetail = await failedChild(journey, report, { stdout: prior + "\n\x1b[22m" + detail + "\x1b[39m\r\n" });
  const label = resource ? "WSL product failure resource workspace detail" : "WSL product failure source terminal detail";
  expect(withDetail.frames.slice(0, 3)).toEqual(without.frames.slice(0, 3));
  expect(withDetail.frames[3]).toEqual([label, resource
    ? { schema: 1, available: 1, case: 1, rpc: 2, edge: 3, refusal: 1, reply: 0, outer: 2 }
    : { schema: 1, available: 1, episode: 1, summaryKind: 6, steps: 4, command: 1 }]);
  expect(without.frames[3][1].available).toBe(0);
});

it.each([
  ["resources", resourceStageFrame(4), resourceDetail.replace('"case":1', '"case":2')],
  ["resources", resourceStageFrame(3), resourceDetail],
  ["resources", resourceStageFrame(4), resourceDetail.replace('"rpc":2', '"rpc":0')],
  ["resources", resourceStageFrame(4), resourceDetail.replace('"refusal":1', '"refusal":0')],
  ["resources", resourceStageFrame(4), resourceDetail.replace('"edge":3', '"edge":2')],
  ["resources", resourceStageFrame(4), resourceDetail.replace('"outer":2', '"outer":0')],
  ["resources", resourceStageFrame(4), resourceDetail.replace('"reply":0', '"reply":1')],
  ["source", sourceTerminalFrame(1, 1, 5, 0), sourceDetail.replace('"episode":1', '"episode":2')],
  ["source", sourceTerminalFrame(1, 1, 5, 0), sourceDetail.replace('"steps":4', '"steps":3')],
  ["source", sourceTerminalFrame(1, 1, 5, 0), sourceDetail.replace('"steps":4', '"steps":6')],
  ["source", sourceTerminalFrame(1, 1, 5, 0), sourceDetail.replace('"summaryKind":6', '"summaryKind":13')],
  ["source", sourceTerminalFrame(1, 1, 2, 0), sourceDetail],
  ["source", sourceTerminalFrame(1, 1, 5, 0), sourceDetail.replace("}", ',"PRIVATE":1}')],
  ["source", sourceTerminalFrame(1, 1, 5, 0), sourceDetail + "\n" + sourceDetail],
  ["source", sourceTerminalFrame(1, 1, 5, 0), "PRIVATE " + sourceDetail],
] as const)("withholds contradictory or noncanonical %s detail", async (journey, prior, detail) => {
  const report = journey === "resources" ? resourceStageReport() : sourceTerminalReport();
  const { frames } = await failedChild(journey, report, { stdout: prior + "\n" + detail + "\n" });
  expect(frames[2][1].available).toBe(1);
  expect(frames[3][1].available).toBe(0);
});

it("withholds a partial detail and leaves the existing failed-case frames unchanged", async () => {
  const prior = resourceStageFrame(4) + "\n";
  const without = await failedChild("resources", resourceStageReport(), { stdout: prior });
  const partial = await failedChild("resources", resourceStageReport(), { stdout: prior + resourceDetail });
  expect(partial.frames).toEqual(without.frames);
});
