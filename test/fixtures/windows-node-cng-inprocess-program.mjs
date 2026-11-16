/** Fixed source-image test files only. No project input, arbitrary CLI, or official-Node authority. */
import { createHash } from "node:crypto";

export const WINDOWS_NODE_CNG_INPROCESS_ISSUER = "ember-experimental-source-node-cng-inprocess";
export const WINDOWS_NODE_CNG_INPROCESS_REPORT_BYTES = 64;
export const WINDOWS_NODE_CNG_INPROCESS_MAGIC = 0x49534e45;
export const WINDOWS_NODE_CNG_INPROCESS_VERSION = 22023005;
export const WINDOWS_NODE_CNG_INPROCESS_MODULE = "module.exports = 42;\n";
const template = String.raw`'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path').win32;
const role = __EMBER_ROLE__;
test('fixed source Node in-process copied-module check', async function () {
  const words = [0x49534e45, 1, role, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22023005, 0, 0, 0];
  let reportFd = -1;
  function checkpoint(stage, status) {
    if (reportFd < 0) return;
    words[3] = stage; words[4] = status; words[5] = status === 2 ? 1 : 0; words[13]++;
    const bytes = Buffer.alloc(64);
    try {
      words.forEach(function (word, index) { bytes.writeUInt32LE(word, index * 4); });
      if (fs.writeSync(reportFd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('fixed');
      fs.fsyncSync(reportFd);
    } finally { bytes.fill(0); }
  }
  try {
    const work = process.env.EMBER_LPAC_WORK, state = process.env.EMBER_LPAC_STATE;
    assert.equal(process.versions.node, '22.23.5');
    assert.ok(process.execArgv.includes('--experimental-test-isolation=none'));
    assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
    assert.equal(process.env.EMBER_NODE_CNG_ARTIFACT_TOKEN, undefined); assert.equal(process.env.EMBER_HOST_NODE_SECRET, undefined);
    assert.ok(typeof work === 'string' && typeof state === 'string' && /^[A-Za-z]:\\/.test(work) && /^[A-Za-z]:\\/.test(state) && work !== state);
    assert.equal(process.cwd().toLowerCase(), work.toLowerCase());
    for (const directory of [work, state]) { const info = fs.lstatSync(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink()); }
    reportFd = fs.openSync(path.join(state, (role ? 'lpac' : 'host') + '-cng-inprocess-report.bin'), 'wx', 0o600);
    words[6] = 1; checkpoint(1, 0);
    const copied = path.join(work, 'cng-inprocess-copied.cjs');
    assert.equal(require(copied), 42); words[8] = 42; words[6] |= 2;
    const bytes = await new Promise(function (resolve, reject) {
      fs.readFile(copied, function (error, data) { words[10]++; if (error) reject(new Error('fixed')); else resolve(data); });
    });
    try { assert.ok(Buffer.isBuffer(bytes) && bytes.equals(Buffer.from('module.exports = 42;\n'))); words[9] = bytes.length; }
    finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
    assert.equal(words[10], 1); words[6] |= 4; checkpoint(2, 0);
    await new Promise(function (resolve) { setTimeout(function () { words[11]++; resolve(); }, 1); });
    assert.equal(words[11], 1); words[6] |= 8; words[7] = 1; checkpoint(4, 1);
  } catch {
    try { checkpoint(5, 2); } catch { /* Failure details remain private; the test still fails. */ }
    throw new Error('The fixed in-process test failed.');
  } finally { if (reportFd >= 0) { const owned = reportFd; reportFd = -1; fs.closeSync(owned); } }
});`;
export const windowsNodeCngInprocessPrograms = Object.freeze({ host: template.replace("__EMBER_ROLE__", "0"), lpac: template.replace("__EMBER_ROLE__", "1") });
export function windowsNodeCngInprocessProgramReceipts() {
  return Object.fromEntries(Object.entries(windowsNodeCngInprocessPrograms).map(([role, program]) => [role,
    { bytes: Buffer.byteLength(program, "utf8"), sha256: createHash("sha256").update(program).digest("hex") }]));
}
