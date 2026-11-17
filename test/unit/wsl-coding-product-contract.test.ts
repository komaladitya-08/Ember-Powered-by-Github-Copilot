/** Separate WSL acceptance cannot accept a subset, forgery or closed production literal. */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { expect, it } from "vitest";
import { runtimeRelative, runtimeFor, locateRuntime } from "../../app/main/agent/runtime";
import { fixedWslProductRuntime, wslProductChildEnvironment } from "../fixtures/wsl-coding-product-preflight";
import { requireWslProductAdmission, requireWslProductReport, wslProductTitle, WSL_PRODUCT_CASES, WSL_PRODUCT_FILES, type WslProductJourney } from "../fixtures/wsl-coding-product-contract";

const repository = path.resolve("."), commit = "a".repeat(40);
const admitted = () => ({ required: true, platform: "win32", arch: "x64", image: "windows-2022", commit,
  readiness: { ready: true, proofCommit: "b".repeat(40), proofRun: 1 } });
const report = (journey: WslProductJourney) => ({ success: true, numTotalTests: WSL_PRODUCT_CASES[journey].length,
  numPassedTests: WSL_PRODUCT_CASES[journey].length, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
  testResults: [{ name: path.resolve(repository, WSL_PRODUCT_FILES[journey]), status: "passed", assertionResults: WSL_PRODUCT_CASES[journey].map(name => ({ status: "passed", fullName: wslProductTitle(journey, name) })) }] });
it("pins separate resources2/source9/packaged1 without altering the Node 2/7/1 workflow", () => {
  expect(Object.values(WSL_PRODUCT_CASES).map(value => value.length)).toEqual([2, 9, 1]);
  const node = fs.readFileSync(".github/workflows/windows-node-product.yml", "utf8");
  expect(node).toContain('const expectedCases = { native: 2, source: 7, packaged: 1 }');
});
it.each(["windows-2022", "windows-2025"])("checks only literal qualification metadata for %s and grants no workspace", image => {
  expect(requireWslProductAdmission({ ...admitted(), image })).toEqual({ commit, image, nativeProofCommit: "b".repeat(40), nativeProofRun: 1 });
});
it.each(["closed", "missing-proof", "missing-run", "invalid-run", "not-required", "platform", "arch", "image", "head"])("refuses %s before any product operation", kind => {
  const input = admitted();
  if (kind === "closed") input.readiness.ready = false;
  if (kind === "missing-proof") input.readiness.proofCommit = "";
  if (kind === "missing-run") input.readiness.proofRun = 0;
  if (kind === "invalid-run") input.readiness.proofRun = 1.5;
  if (kind === "not-required") input.required = false;
  if (kind === "platform") input.platform = "linux";
  if (kind === "arch") input.arch = "arm64";
  if (kind === "image") input.image = "other";
  if (kind === "head") input.commit = "PRIVATE";
  expect(() => requireWslProductAdmission(input)).toThrow("The required Windows WSL product proof could not be verified.");
});
it("never invokes proxy traps or readiness accessors", () => {
  let calls = 0; const secret = () => { calls++; throw new Error("PRIVATE"); };
  const proxy = new Proxy({}, { get: secret, getOwnPropertyDescriptor: secret, getPrototypeOf: secret });
  expect(() => requireWslProductAdmission({ ...admitted(), readiness: proxy })).toThrow();
  expect(() => requireWslProductAdmission({ ...admitted(), get readiness() { return secret(); } })).toThrow();
  expect(calls).toBe(0);
});
it.each(Object.keys(WSL_PRODUCT_CASES) as WslProductJourney[])("requires the whole exact %s inventory", journey => {
  expect(requireWslProductReport(report(journey), journey, repository)).toEqual({ journey, cases: WSL_PRODUCT_CASES[journey].length });
  for (const field of ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"] as const) {
    expect(() => requireWslProductReport({ ...report(journey), [field]: 1 }, journey, repository)).toThrow();
  }
});
it.each(["subset", "extra", "duplicate", "other-file", "skipped", "empty", "not-success"])("rejects a %s source report without projecting private diagnostics", kind => {
  const value = report("source"), suite = value.testResults[0];
  if (kind === "subset") suite.assertionResults.pop();
  if (kind === "extra") suite.assertionResults.push({ status: "passed", fullName: "PRIVATE" });
  if (kind === "duplicate") suite.assertionResults[1] = suite.assertionResults[0];
  if (kind === "other-file") suite.name = "PRIVATE";
  if (kind === "skipped") suite.assertionResults[0].status = "skipped";
  if (kind === "empty") value.testResults = [];
  if (kind === "not-success") value.success = false;
  let error: unknown; try { requireWslProductReport(value, "source", repository); } catch (caught) { error = caught; }
  expect(String(error)).toBe("Error: The required Windows WSL product proof could not be verified."); expect((error as Error).stack).not.toContain("PRIVATE");
});
it("rejects accessor and proxy reports without reading raw fields", () => {
  let reads = 0; const secret = () => { reads++; throw new Error("PRIVATE"); };
  const value = report("source"); Object.defineProperty(value.testResults[0].assertionResults[0], "status", { get: secret });
  expect(() => requireWslProductReport(value, "source", repository)).toThrow();
  expect(() => requireWslProductReport(new Proxy({}, { get: secret, getOwnPropertyDescriptor: secret }), "source", repository)).toThrow(); expect(reads).toBe(0);
});

it("refuses an external-only SDK override and accepts only the separately staged fixed Windows runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-product-runtime-")), repository = path.join(root, "app"), external = path.join(root, "external.exe");
  fs.mkdirSync(repository); fs.writeFileSync(external, "fixed public non-executable fixture");
  const previous = process.env.EMBER_COPILOT_RUNTIME; process.env.EMBER_COPILOT_RUNTIME = external;
  try {
    const runtime = runtimeFor("win32", "x64");
    expect(locateRuntime({ appPath: repository, runtimeId: runtime.id, exe: runtime.exe })).toEqual({ path: external, exists: true });
    expect(fixedWslProductRuntime(repository)).toMatchObject({ exists: false });
    const staged = path.join(repository, runtimeRelative(runtime.id, runtime.exe)); fs.mkdirSync(path.dirname(staged), { recursive: true }); fs.writeFileSync(staged, "fixed staged public fixture");
    expect(fixedWslProductRuntime(repository)).toEqual({ path: staged, exists: true });
  } finally {
    if (previous === undefined) delete process.env.EMBER_COPILOT_RUNTIME; else process.env.EMBER_COPILOT_RUNTIME = previous;
    fs.rmSync(root, { recursive: true, force: false });
  }
});
it("removes every Windows case variant of the SDK override from a fresh child environment", () => {
  const input = { PATH: "fixed", EMBER_COPILOT_RUNTIME: "external-one", Ember_Copilot_Runtime: "external-two" };
  expect(wslProductChildEnvironment(input)).toEqual({ PATH: "fixed" }); expect(input.Ember_Copilot_Runtime).toBe("external-two");
});
