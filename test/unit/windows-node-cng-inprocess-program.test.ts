import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parseWindowsNodeCngInprocessReport } from "../fixtures/windows-node-cng-inprocess-report";
// @ts-expect-error -- fixed native test literals, outside the application build
import { windowsNodeCngInprocessPrograms, windowsNodeCngInprocessProgramReceipts } from "../fixtures/windows-node-cng-inprocess-program.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const moduleFile = fileURLToPath(new URL("../fixtures/windows-node-cng-inprocess-program.mjs", import.meta.url));

/** Actual Node CLI/test runner, module import, filesystem callback and timer; Windows metadata is synthetic off Windows. */
function run(role: "host" | "lpac", fault = "") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-cng-inprocess-unit-")); roots.push(root);
  const work = process.platform === "win32" ? path.join(root, "work") : "C:\\ember-work";
  const state = process.platform === "win32" ? path.join(root, "state") : "C:\\ember-state";
  const resolved = (file: string) => path.resolve(root, file);
  fs.mkdirSync(resolved(work)); fs.mkdirSync(resolved(state));
  fs.writeFileSync(resolved(path.win32.join(work, "cng-inprocess-copied.cjs")), `module.exports = ${fault === "module" ? 43 : 42};\n`);
  const report = resolved(path.win32.join(state, `${role}-cng-inprocess-report.bin`));
  if (fault === "occupied") fs.writeFileSync(report, "private-existing-marker");
  const wrapper = path.join(root, "fixed.test.cjs"), tap = path.join(root, "private-test.tap");
  fs.writeFileSync(wrapper, `const vm=require('node:vm'),path=require('node:path');
const {windowsNodeCngInprocessPrograms}=require(${JSON.stringify(moduleFile)});
const nativeRequire=require;
const limited=name=>name===${JSON.stringify(path.win32.join(work, "cng-inprocess-copied.cjs"))}?nativeRequire(path.resolve(${JSON.stringify(root)},name)):nativeRequire(name);
const supplied={versions:{node:'22.23.5'},execArgv:process.execArgv,env:{EMBER_LPAC_WORK:${JSON.stringify(work)},EMBER_LPAC_STATE:${JSON.stringify(state)}},cwd:()=>${JSON.stringify(work)}};
vm.runInNewContext(windowsNodeCngInprocessPrograms[${JSON.stringify(role)}],{require:limited,process:supplied,Buffer,setTimeout});\n`);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH"]) if (process.env[name]) env[name] = process.env[name];
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-test-isolation=none", "--test-reporter=tap", `--test-reporter-destination=${tap}`, "--test", wrapper],
    { cwd: root, env, encoding: "utf8", timeout: 10_000, maxBuffer: 4096, windowsHide: true });
  return { result, bytes: fs.existsSync(report) ? fs.readFileSync(report) : null, tapExists: fs.existsSync(tap) };
}

it.each(["host", "lpac"] as const)("runs the fixed %s test through the actual in-process CLI without exposing TAP", role => {
  const value = run(role);
  expect(value.result.status).toBe(0); expect(value.result.stdout === "" && value.result.stderr === "").toBe(true); expect(value.tapExists).toBe(true);
  expect(parseWindowsNodeCngInprocessReport(value.bytes!, role === "host" ? 0 : 1)).toEqual({ role: role === "host" ? 0 : 1, stage: 4, status: 1,
    error: 0, features: 15, tests: 1, moduleValue: 42, readBytes: 21, fsCallbacks: 1, timerCallbacks: 1, runtimeVersion: 22023005, checkpoints: 3 });
});

it("keeps an actual failed imported-module assertion failed with only a closed report", () => {
  const value = run("lpac", "module"); expect(value.result.status).toBe(1); expect(value.result.stdout === "" && value.result.stderr === "").toBe(true);
  const facts = parseWindowsNodeCngInprocessReport(value.bytes!, 1); expect(facts).toMatchObject({ status: 2, stage: 5, tests: 0, error: 1 });
  expect(JSON.stringify(facts)).not.toMatch(/message|path|stack|TAP|expected|actual/);
});

it("refuses an occupied report without changing its existing bytes", () => {
  const value = run("host", "occupied"); expect(value.result.status).toBe(1); expect(value.result.stdout === "" && value.result.stderr === "").toBe(true);
  expect(value.bytes?.equals(Buffer.from("private-existing-marker"))).toBe(true);
});

it("binds only two fixed role programs and the explicit Node22 in-process flag", () => {
  expect(Object.keys(windowsNodeCngInprocessPrograms)).toEqual(["host", "lpac"]); expect(Object.isFrozen(windowsNodeCngInprocessPrograms)).toBe(true);
  const receipts = windowsNodeCngInprocessProgramReceipts(); expect(receipts.host.sha256).not.toBe(receipts.lpac.sha256);
  expect(receipts.host.bytes).toBeLessThan(16 * 1024); expect(receipts.host.bytes).toBe(receipts.lpac.bytes);
});
