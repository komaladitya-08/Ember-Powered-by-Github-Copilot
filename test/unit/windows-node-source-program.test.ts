import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parseWindowsNodeSourceReport } from "../fixtures/windows-node-source-report";
// @ts-expect-error -- fixed literal module shared with native tests
import { windowsNodeSourceProgramReceipts, windowsNodeSourcePrograms } from "../fixtures/windows-node-source-program.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const module = new URL("../fixtures/windows-node-source-program.mjs", import.meta.url).href;

/** Real filesystem, async IO and timers in a separate process. Only Windows path/version metadata is synthetic. */
function run(role: "host" | "lpac", occupied = false) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-source-js-unit-")); roots.push(root);
  const script = `import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';
import {windowsNodeSourcePrograms} from ${JSON.stringify(module)};
const role=${JSON.stringify(role)}, real=process, work=real.platform==='win32'?path.join(real.cwd(),'work'):'C:\\\\ember-work',state=real.platform==='win32'?path.join(real.cwd(),'state'):'C:\\\\ember-state';
fs.mkdirSync(work);fs.mkdirSync(state);
if(${occupied})fs.writeFileSync(path.win32.join(work,role+'-source-node-work.bin'),'private-regression-marker');
const supplied={versions:{node:'22.23.5'},env:{EMBER_LPAC_WORK:work,EMBER_LPAC_STATE:state},cwd:()=>work};
const builtin=createRequire(import.meta.url);const limited=name=>{if(name!=='node:fs'&&name!=='node:path')throw Error('unexpected module');return builtin(name)};
real.once('beforeExit',()=>{real.exitCode=supplied.exitCode??0});
vm.runInNewContext(windowsNodeSourcePrograms[role],{require:limited,Buffer,Uint32Array,process:supplied,setTimeout});`;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH"]) if (process.env[name]) env[name] = process.env[name];
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: root, env, encoding: "utf8", timeout: 10_000, maxBuffer: 4096, windowsHide: true });
  const state = process.platform === "win32" ? path.join(root, "state") : "C:\\ember-state";
  const work = process.platform === "win32" ? path.join(root, "work") : "C:\\ember-work";
  const reportFile = path.win32.join(state, `${role}-source-node-report.bin`);
  const workFile = path.win32.join(work, `${role}-source-node-work.bin`);
  return { result, report: fs.readFileSync(path.resolve(root, reportFile)), workFile: path.resolve(root, workFile) };
}

it.each(["host", "lpac"] as const)("executes the unchanged %s literal with real local IO and timer completion in an isolated host process", role => {
  const { result, report, workFile } = run(role);
  expect(result.status).toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  expect(parseWindowsNodeSourceReport(report, role === "host" ? 0 : 1)).toMatchObject({ status: 1, stage: 7,
    features: 31, payloadBytes: 24, syncBytes: 24, asyncBytes: 24, fsCallbacks: 1, timerCallbacks: 1, fileRemoved: 1, checkpoints: 6 });
  expect(fs.existsSync(workFile)).toBe(false);
});

it("turns a real fixed-file collision into a closed failure without printing its exception or removing the existing file", () => {
  const { result, report, workFile } = run("host", true);
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  const facts = parseWindowsNodeSourceReport(report, 0);
  expect(facts).toMatchObject({ status: 2, error: 1, fileRemoved: 0 });
  expect(JSON.stringify(facts)).not.toMatch(/private-regression-marker|EEXIST|message|path/);
  expect(fs.readFileSync(workFile, "utf8")).toBe("private-regression-marker");
});

it("binds two fixed role literals without a caller-supplied program or CLI flag surface", () => {
  expect(Object.isFrozen(windowsNodeSourcePrograms)).toBe(true);
  expect(Object.keys(windowsNodeSourcePrograms)).toEqual(["host", "lpac"]);
  const receipts = windowsNodeSourceProgramReceipts();
  expect(receipts.host.bytes).toBeLessThan(16 * 1024); expect(receipts.lpac.bytes).toBe(receipts.host.bytes);
  expect(receipts.host.sha256).not.toBe(receipts.lpac.sha256);
  expect(fileURLToPath(module)).toMatch(/windows-node-source-program\.mjs$/);
});
