/** Actual local Node CLI control; it does not establish Windows enforcement or LPAC compatibility. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { WINDOWS_NODE_CNG_PRESERVE_FLAGS } from "../fixtures/windows-node-cng-preserve-proof";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("freezes the exact explicit flags without changing the historical invocation", () => {
  expect(Object.isFrozen(WINDOWS_NODE_CNG_PRESERVE_FLAGS)).toBe(true);
  expect(WINDOWS_NODE_CNG_PRESERVE_FLAGS).toEqual(["--no-warnings", "--experimental-test-isolation=none", "--preserve-symlinks", "--preserve-symlinks-main", "--test-reporter=tap"]);
});

it("runs a fixed relative CommonJS test, copied module, async read and timer with the explicit flags", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-cng-preserve-cli-")); roots.push(root);
  const work = path.join(root, "work"), tools = path.join(root, "tools"), state = path.join(root, "state");
  for (const directory of [work, tools, state]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(work, "copied.cjs"), "module.exports = 42;\n");
  fs.writeFileSync(path.join(tools, "fixed.test.cjs"), `const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('fixed module flags',async()=>{
 for(const flag of ['--experimental-test-isolation=none','--preserve-symlinks','--preserve-symlinks-main'])assert.ok(process.execArgv.includes(flag));
 assert.equal(require('../work/copied.cjs'),42);
 const bytes=await fs.promises.readFile('../work/copied.cjs');
 try{assert.ok(bytes.equals(Buffer.from('module.exports = 42;\\n')));}finally{bytes.fill(0);}
 await new Promise(resolve=>setTimeout(resolve,1));
 const result=Buffer.alloc(8);result.writeUInt32LE(0x50534e45);result.writeUInt32LE(42,4);
 try{fs.writeFileSync('../state/report.bin',result,{flag:'wx'});}finally{result.fill(0);}
});`);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
  const result = spawnSync(process.execPath, [...WINDOWS_NODE_CNG_PRESERVE_FLAGS,
    `--test-reporter-destination=${path.join(state, "private.tap")}`, "--test", "../tools/fixed.test.cjs"],
  { cwd: work, env, timeout: 10_000, maxBuffer: 4096, windowsHide: true });
  // Neither failure output nor TAP is read, decoded or included in an assertion.
  expect(result.status).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0);
  const bytes = fs.readFileSync(path.join(state, "report.bin"));
  try { expect(bytes.length).toBe(8); expect(bytes.readUInt32LE(0)).toBe(0x50534e45); expect(bytes.readUInt32LE(4)).toBe(42); }
  finally { bytes.fill(0); }
});
