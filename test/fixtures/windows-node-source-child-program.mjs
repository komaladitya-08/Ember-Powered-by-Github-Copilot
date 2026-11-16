/** Fixed child/stdio and default-test literals. ACK observes a running trusted child; it is not pre-exec admission.
 * A failure file requires literal entry; default-test root failures before its fixture starts remain unknown. */
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
let failureRecorded = false;
function recordFailure(operation, error) {
  if (failureRecorded) return;
  failureRecorded = true;
  const codes = ['EACCES','EPERM','ENOENT','EINVAL','EAGAIN','EMFILE','ENFILE','ENOMEM','EIO','ENOSYS','ENOTSUP','UNKNOWN','EPIPE','ENOBUFS','ECANCELED','ETIMEDOUT'];
  let code = 0, present = 0, errno = 0;
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    try {
      const field = Object.getOwnPropertyDescriptor(error, 'code');
      if (field && Object.prototype.hasOwnProperty.call(field, 'value') && typeof field.value === 'string') code = codes.indexOf(field.value) + 1;
    } catch { /* Descriptor traps supply no diagnostic data. */ }
    try {
      const field = Object.getOwnPropertyDescriptor(error, 'errno');
      if (field && Object.prototype.hasOwnProperty.call(field, 'value') && typeof field.value === 'number' && Number.isInteger(field.value) && field.value >= -2147483648 && field.value <= 2147483647) {
        present = 1; errno = field.value;
      }
    } catch { /* Never read a getter, message, path, stack or syscall string. */ }
  }
  const data = Buffer.alloc(48), values = [0x46434e45,1,role,mode,operation,code,present,0,22023005,0,0,0];
  for (let i = 0; i < 12; i++) data.writeUInt32LE(values[i], i * 4);
  data.writeInt32LE(errno, 28);
  let fd = -1;
  try {
    fd = fs.openSync(path.join(state, tag + '-source-child-' + mode + '-failure.bin'), 'wx', 0o600);
    if (fs.writeSync(fd, data, 0, 48, 0) !== 48) throw Error('fixed');
    fs.fsyncSync(fd);
  } catch { process.exitCode = 1; }
  finally {
    data.fill(0);
    if (fd >= 0) try { fs.closeSync(fd); } catch { process.exitCode = 1; }
  }
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
let operation = 1, observeFailure = () => {};
try {
__EMBER_COMMON__
observeFailure = recordFailure;
const spawn = require('node:child_process').spawn;
operation = 2;
const child = spawn(process.execPath, ['--eval', __EMBER_CHILD__], { stdio: ['pipe', 'pipe', 'pipe'] });
operation = 1;
let spawned = 0, exited = 0, closed = 0, stdout = Buffer.alloc(0), stderr = 0, failed = false, granted = false;
const fail = (phase, error) => { observeFailure(phase, error); failed = true; process.exitCode = 1; };
child.on('error', error => fail(3, error));
child.stdin.on('error', error => fail(4, error));
child.stdout.on('error', error => fail(5, error)); child.stderr.on('error', error => fail(6, error));
child.stdout.on('data', bytes => {
  if (stdout.length + bytes.length > 14) { bytes.fill(0); fail(9); return; }
  const old = stdout; stdout = Buffer.concat([stdout, bytes]); old.fill(0); bytes.fill(0);
});
child.stderr.on('data', bytes => { stderr += bytes.length; bytes.fill(0); fail(9); });
child.on('spawn', () => { spawned++; if (spawned !== 1) fail(8); });
child.on('exit', (code, signal) => { exited++; if (code !== 0 || signal !== null || exited !== 1) fail(8); });
child.on('close', (code, signal) => {
  closed++;
  try {
    if (failed || !granted || code !== 0 || signal !== null || spawned !== 1 || exited !== 1 || closed !== 1 || stderr !== 0 ||
        !stdout.equals(Buffer.from('EMBER_STDIO_1\n', 'ascii'))) throw Error('fixed');
    complete(12, stdout.length, stderr, spawned, exited, closed);
  } catch (error) { fail(11, error); }
  finally { stdout.fill(0); }
});
try { await waitGrant(); if (failed) throw Error('fixed'); granted = true; child.stdin.end(Buffer.from('EMBER_ACK_1\n', 'ascii')); }
catch (error) { fail(7, error); }
} catch (error) { observeFailure(operation, error); process.exitCode = 1; }
})();`;
const testTemplate = String.raw`'use strict';
let observeFailure = () => {};
try {
__EMBER_COMMON__
observeFailure = recordFailure;
const test = require('node:test'), assert = require('node:assert/strict');
test('fixed source Node local test', async () => {
  try {
    await waitGrant();
    assert.equal(6 * 7, 42);
    complete(0, 0, 0, 1, 1, 1);
  } catch (error) { observeFailure(10, error); throw error; }
});
} catch (error) { observeFailure(1, error); process.exitCode = 1; }`;

export const windowsNodeSourceChildPrograms = Object.freeze(Object.fromEntries(['host', 'lpac'].map((role, index) => [role,
  Object.freeze({ spawn: spawnTemplate.replace('__EMBER_COMMON__', common.replace('__EMBER_ROLE__', String(index)).replace('__EMBER_MODE__', '1'))
    .replace('__EMBER_CHILD__', JSON.stringify(child)),
  test: testTemplate.replace('__EMBER_COMMON__', common.replace('__EMBER_ROLE__', String(index)).replace('__EMBER_MODE__', '2')) })])));
export function windowsNodeSourceChildProgramReceipts() {
  return Object.fromEntries(Object.entries(windowsNodeSourceChildPrograms).map(([role, programs]) => [role,
    Object.fromEntries(Object.entries(programs).map(([mode, program]) => [mode, { bytes: Buffer.byteLength(program), sha256: createHash('sha256').update(program).digest('hex') }]))]));
}
