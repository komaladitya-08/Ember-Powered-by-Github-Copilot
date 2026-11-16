import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { windowsNodeCngInprocessTestRoute } from "../fixtures/windows-node-cng-inprocess-route";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it.each(["host", "lpac"] as const)("binds the %s relative pattern to the same owned pinned filename", role => {
  const route = windowsNodeCngInprocessTestRoute("D:\\owned\\work", "D:\\owned\\tools", role);
  expect(route).toEqual({ file: `D:\\owned\\tools\\${role}-cng-inprocess.test.cjs`, pattern: `..\\tools\\${role}-cng-inprocess.test.cjs` }); expect(Object.isFrozen(route)).toBe(true);
  expect(path.win32.resolve("D:\\owned\\work", route.pattern)).toBe(route.file);
});
it.each([
  ["D:\\owned\\work", "D:\\another\\tools", "lpac"], ["D:\\owned\\work", "E:\\owned\\tools", "lpac"],
  ["D:\\owned\\other", "D:\\owned\\tools", "lpac"], ["D:\\owned\\work", "D:\\owned\\other", "lpac"],
  ["D:\\owned\\work", "D:\\owned\\tools", "other"], ["relative\\work", "D:\\owned\\tools", "lpac"],
  ["D:\\owned\\.\\work", "D:\\owned\\tools", "lpac"], ["D:\\owned\\work", "D:\\owned\\tools\\", "lpac"],
  ["D:\\owned.\\work", "D:\\owned.\\tools", "lpac"], ["D:\\owned\\work\n", "D:\\owned\\tools", "lpac"],
])("refuses routes outside the exact canonical fixture relationship (%#)", ([work, tools, role]) => {
  expect(() => windowsNodeCngInprocessTestRoute(work, tools, role as "lpac")).toThrow("known owned fixture tree");
});

/** Real Node CLI and its public Glob implementation. Only metadata denial is simulated; this is not Windows enforcement. */
it.each(["absolute", "relative"] as const)("observes %s discovery with external ancestor metadata synthetically denied", mode => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-cng-route-unit-")); roots.push(root);
  const work = path.join(root, "work"), tools = path.join(root, "tools"); fs.mkdirSync(work); fs.mkdirSync(tools);
  const file = path.join(tools, "fixed.cjs"); fs.writeFileSync(file, 'module.exports = require("../work/copied.cjs");\n'); fs.writeFileSync(path.join(work, "copied.cjs"), "module.exports = 42;\n");
  const script = `const fs=require('node:fs'),path=require('node:path');
const root=${JSON.stringify(root)},work=${JSON.stringify(work)},file=${JSON.stringify(file)},mode=${JSON.stringify(mode)};
const original=fs.lstatSync;let denied=0;
fs.lstatSync=function(name,...args){const absolute=path.resolve(name),relative=path.relative(root,absolute);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)){denied++;throw Object.assign(new Error('fixed simulated metadata refusal'),{code:'EACCES'});}return Reflect.apply(original,fs,[name,...args]);};
const pattern=mode==='absolute'?file:path.relative(work,file),matches=fs.globSync(pattern,{cwd:work});
const same=matches.length===1&&path.resolve(work,matches[0])===file;
const value=same?require(file):0;
process.stdout.write(JSON.stringify({schema:1,count:matches.length,same,value,denied}));`;
  const env: NodeJS.ProcessEnv = {}; for (const name of ["SystemRoot", "WINDIR", "PATH"]) if (process.env[name]) env[name] = process.env[name];
  const result = spawnSync(process.execPath, ["--no-warnings", "--eval", script], { cwd: work, env, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  expect(result.status).toBe(0); expect(result.stderr === "").toBe(true);
  let value: { schema: number; count: number; same: boolean; value: number; denied: number } | undefined;
  try { value = JSON.parse(result.stdout); } catch { /* Never print a refused stream. */ }
  expect(value !== undefined).toBe(true);
  expect(value).toMatchObject(mode === "absolute" ? { schema: 1, count: 0, same: false, value: 0 } : { schema: 1, count: 1, same: true, value: 42 });
  expect(value!.denied > 0).toBe(mode === "absolute");
});
