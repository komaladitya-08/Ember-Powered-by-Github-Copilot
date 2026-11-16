import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parseWindowsNodeCngLoaderReport } from "../fixtures/windows-node-cng-loader-report";
// @ts-expect-error -- fixed JavaScript native diagnostic literals
import { windowsNodeCngLoaderPrograms, windowsNodeCngLoaderProgramReceipts } from "../fixtures/windows-node-cng-loader-program.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixture = fileURLToPath(new URL("../fixtures/windows-node-cng-loader-program.mjs", import.meta.url));
/** Real isolated Node process/file/module IO. Off Windows only version/path representation is synthetic. */
function run(role: "host" | "lpac", fault = "") {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-cng-loader-unit-")); roots.push(root);
  const work = process.platform === "win32" ? path.join(root, "work") : "C:\\ember-work", state = process.platform === "win32" ? path.join(root, "state") : "C:\\ember-state";
  const resolved = (file: string) => path.resolve(root, file);
  fs.mkdirSync(resolved(work)); fs.mkdirSync(resolved(state));
  fs.writeFileSync(resolved(path.win32.join(work, "cng-inprocess-copied.cjs")), "module.exports = 42;\n");
  const script = `const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {windowsNodeCngLoaderPrograms}=require(${JSON.stringify(fixture)}),fault=${JSON.stringify(fault)},work=${JSON.stringify(work)},state=${JSON.stringify(state)};
let getterReads=0;
const privateError=()=>Object.assign(new Error('private synthetic error'),{code:'EACCES'});
const fakeFs={...fs,realpathSync(file){if(fault==='realpath'||fault==='both')throw privateError();if(fault==='getter'){const error={};for(const key of ['code','message','stack','path'])Object.defineProperty(error,key,{get(){getterReads++;throw new Error('private getter');}});throw error;}const actual=fs.realpathSync(path.resolve(file));if(actual!==path.resolve(file))throw new Error('fixed');return file;}};
const known=path.win32.join(work,'cng-inprocess-copied.cjs');
const limited=name=>{if(name==='node:fs')return fakeFs;if(name==='node:path')return path;if(name===known){if(fault==='both')throw privateError();return require(path.resolve(name));}throw new Error('fixed unexpected import');};
const supplied={versions:{node:'22.23.5'},env:{EMBER_LPAC_WORK:work,EMBER_LPAC_STATE:state},cwd:()=>work};
process.once('beforeExit',()=>{process.exitCode=getterReads?88:(supplied.exitCode??0);});
vm.runInNewContext(windowsNodeCngLoaderPrograms[${JSON.stringify(role)}],{require:limited,process:supplied,Buffer,Object});`;
  const env: NodeJS.ProcessEnv = {}; for (const name of ["SystemRoot", "WINDIR", "PATH"]) if (process.env[name]) env[name] = process.env[name];
  const result = spawnSync(process.execPath, ["--no-warnings", "--eval", script], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
  let bytes: Buffer;
  try { bytes = fs.readFileSync(resolved(path.win32.join(state, `${role}-cng-loader-report.bin`))); }
  catch { throw new Error("The fixed loader program supplied no readable numeric report."); }
  expect(result.stdout === "" && result.stderr === "").toBe(true);
  return { status: result.status, facts: parseWindowsNodeCngLoaderReport(bytes, role === "host" ? 0 : 1) };
}
it.each(["host", "lpac"] as const)("runs the fixed %s read/realpath/require operations without a test runner or raw error output", role => {
  const value = run(role); expect(value.status).toBe(0); expect(value.facts.successful).toBe(true);
  expect(value.facts.operations).toEqual([{ operation: 1, status: 1, code: 0, value: 21 }, { operation: 2, status: 1, code: 0, value: 1 }, { operation: 3, status: 1, code: 0, value: 42 }]);
});
it.each(["realpath", "both"])("records known %s refusals independently while keeping the root failed", fault => {
  const value = run("lpac", fault); expect(value.status).toBe(1); expect(value.facts.successful).toBe(false);
  expect(value.facts.operations[0]).toEqual({ operation: 1, status: 1, code: 0, value: 21 });
  expect(value.facts.operations[1]).toEqual({ operation: 2, status: 2, code: 1, value: 0 });
  expect(value.facts.operations[2]).toEqual(fault === "both" ? { operation: 3, status: 2, code: 1, value: 0 } : { operation: 3, status: 1, code: 0, value: 42 });
  expect(JSON.stringify(value.facts)).not.toMatch(/private|message|path|stack|EACCES|TAP/);
});
it("does not invoke error code/message/path/stack getters or invent a known code", () => {
  const value = run("lpac", "getter"); expect(value.status).toBe(1); expect(value.facts.operations[1]).toEqual({ operation: 2, status: 3, code: 0, value: 0 });
});
it("binds only two fixed role programs and separate runtime hashes", () => {
  expect(Object.isFrozen(windowsNodeCngLoaderPrograms)).toBe(true); expect(Object.keys(windowsNodeCngLoaderPrograms)).toEqual(["host", "lpac"]);
  const hashes = windowsNodeCngLoaderProgramReceipts(); expect(hashes.host.sha256).not.toBe(hashes.lpac.sha256); expect(hashes.host.bytes).toBeLessThan(16 * 1024);
});
