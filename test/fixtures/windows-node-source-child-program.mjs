/** Fixed child/stdio and default-test literals. ACK observes a running trusted child; it is not pre-exec admission. */
import { createHash } from 'node:crypto';

export const WINDOWS_NODE_SOURCE_CHILD_ACK = 'EMBER_ACK_1\n';
export const WINDOWS_NODE_SOURCE_CHILD_STDOUT = 'EMBER_STDIO_1\n';
const common = String.raw`
const fs = require('node:fs'), path = require('node:path').win32;
const role = __EMBER_ROLE__, mode = __EMBER_MODE__;
const tag = role ? 'lpac' : 'host';
const tools = process.env.EMBER_LPAC_TOOLS, state = process.env.EMBER_LPAC_STATE;
if (process.versions.node !== '22.23.5' || !/^[A-Za-z]:\\/.test(tools || '') || !/^[A-Za-z]:\\/.test(state || '')) throw Error('fixed');
const grant = path.join(tools, tag + '-source-child-' + mode + '-ack.bin');
const report = path.join(state, tag + '-source-child-' + mode + '-report.bin');
let polls = 0;
async function waitGrant() {
  for (let i = 0; i < 500; i++) {
    polls++;
    let bytes;
    try { bytes = fs.readFileSync(grant); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('fixed'); }
    if (bytes) {
      const valid = bytes.equals(Buffer.from('EMBER_ACK_1\n', 'ascii')); bytes.fill(0);
      if (!valid) throw Error('fixed');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('fixed');
}
function complete(stdinBytes, stdoutBytes, stderrBytes, spawned, exited, closed) {
  const data = Buffer.alloc(64), values = [0x43534e45,1,role,mode,4,1,31,stdinBytes,stdoutBytes,stderrBytes,spawned,exited,closed,polls,22023005,0];
  for (let i = 0; i < 16; i++) data.writeUInt32LE(values[i], i * 4);
  let fd = -1;
  try { fd = fs.openSync(report, 'wx', 0o600); if (fs.writeSync(fd, data, 0, 64, 0) !== 64) throw Error('fixed'); fs.fsyncSync(fd); }
  finally { data.fill(0); if (fd >= 0) fs.closeSync(fd); }
}
`;
const child = String.raw`'use strict';
let bytes = Buffer.alloc(0), done = false;
const timer = setTimeout(() => { process.exitCode = 1; process.stdin.destroy(); }, 6000);
process.stdin.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
process.stdin.on('data', part => {
  try {
    if (done || bytes.length + part.length > 12) throw Error('fixed');
    const previous = bytes; bytes = Buffer.concat([bytes, part]); previous.fill(0); part.fill(0);
    if (bytes.length === 12) {
      if (!bytes.equals(Buffer.from('EMBER_ACK_1\n', 'ascii'))) throw Error('fixed');
      done = true; bytes.fill(0); clearTimeout(timer); process.stdin.destroy();
      process.stdout.end(Buffer.from('EMBER_STDIO_1\n', 'ascii'));
    }
  } catch { clearTimeout(timer); bytes.fill(0); process.exitCode = 1; process.stdin.destroy(); }
});
process.stdin.on('end', () => { if (!done) { clearTimeout(timer); bytes.fill(0); process.exitCode = 1; } });`;
const spawnTemplate = String.raw`(async function () {
'use strict';
try {
__EMBER_COMMON__
const spawn = require('node:child_process').spawn;
const child = spawn(process.execPath, ['--eval', __EMBER_CHILD__], { stdio: ['pipe', 'pipe', 'pipe'] });
let spawned = 0, exited = 0, closed = 0, stdout = Buffer.alloc(0), stderr = 0, failed = false, granted = false;
const fail = () => { failed = true; process.exitCode = 1; };
child.on('error', fail);
child.stdin.on('error', fail);
child.stdout.on('error', fail); child.stderr.on('error', fail);
child.stdout.on('data', bytes => {
  if (stdout.length + bytes.length > 14) { bytes.fill(0); fail(); return; }
  const old = stdout; stdout = Buffer.concat([stdout, bytes]); old.fill(0); bytes.fill(0);
});
child.stderr.on('data', bytes => { stderr += bytes.length; bytes.fill(0); fail(); });
child.on('spawn', () => { spawned++; if (spawned !== 1) fail(); });
child.on('exit', (code, signal) => { exited++; if (code !== 0 || signal !== null || exited !== 1) fail(); });
child.on('close', (code, signal) => {
  closed++;
  try {
    if (failed || !granted || code !== 0 || signal !== null || spawned !== 1 || exited !== 1 || closed !== 1 || stderr !== 0 ||
        !stdout.equals(Buffer.from('EMBER_STDIO_1\n', 'ascii'))) throw Error('fixed');
    complete(12, stdout.length, stderr, spawned, exited, closed);
  } catch { fail(); }
  finally { stdout.fill(0); }
});
try { await waitGrant(); if (failed) throw Error('fixed'); granted = true; child.stdin.end(Buffer.from('EMBER_ACK_1\n', 'ascii')); }
catch { fail(); }
} catch { process.exitCode = 1; }
})();`;
const testTemplate = String.raw`'use strict';
try {
__EMBER_COMMON__
const test = require('node:test'), assert = require('node:assert/strict');
test('fixed source Node local test', async () => {
  await waitGrant();
  assert.equal(6 * 7, 42);
  complete(0, 0, 0, 1, 1, 1);
});
} catch { process.exitCode = 1; }`;

export const windowsNodeSourceChildPrograms = Object.freeze(Object.fromEntries(['host', 'lpac'].map((role, index) => [role,
  Object.freeze({ spawn: spawnTemplate.replace('__EMBER_COMMON__', common.replace('__EMBER_ROLE__', String(index)).replace('__EMBER_MODE__', '1'))
    .replace('__EMBER_CHILD__', JSON.stringify(child)),
  test: testTemplate.replace('__EMBER_COMMON__', common.replace('__EMBER_ROLE__', String(index)).replace('__EMBER_MODE__', '2')) })])));
export function windowsNodeSourceChildProgramReceipts() {
  return Object.fromEntries(Object.entries(windowsNodeSourceChildPrograms).map(([role, programs]) => [role,
    Object.fromEntries(Object.entries(programs).map(([mode, program]) => [mode, { bytes: Buffer.byteLength(program), sha256: createHash('sha256').update(program).digest('hex') }]))]));
}
