/** Fixed trusted feasibility literals only. No project code, supplied script or arbitrary CLI is accepted. */
import { createHash } from "node:crypto";

export const WINDOWS_NODE_SOURCE_REPORT_BYTES = 64;
export const WINDOWS_NODE_SOURCE_MAGIC = 0x46534e45;
export const WINDOWS_NODE_SOURCE_VERSION = 22023005;
const template = String.raw`(function () {
  'use strict';
  const role = __EMBER_ROLE__;
  const words = new Uint32Array(16);
  words[0] = 0x46534e45; words[1] = 1; words[2] = role; words[14] = 22023005;
  let fs, path, reportFd = -1, workFile = '', created = false, failed = false;
  let readPending = false, readDone = false, timerDone = false;
  function checkpoint() {
    if (reportFd < 0) return;
    const data = Buffer.alloc(64); words[13]++;
    for (let i = 0; i < 16; i++) data.writeUInt32LE(words[i], i * 4);
    if (fs.writeSync(reportFd, data, 0, data.length, 0) !== data.length) throw new Error('fixed');
    fs.fsyncSync(reportFd); data.fill(0);
  }
  function closeReport() {
    const fd = reportFd; reportFd = -1;
    if (fd >= 0) fs.closeSync(fd);
  }
  function fail() {
    if (failed) return;
    failed = true; words[4] = 2; words[5] = 1;
    if (fs && created && !readPending) try { fs.unlinkSync(workFile); created = false; words[12] = 1; } catch {}
    try { checkpoint(); } catch {}
    try { closeReport(); } catch {}
    process.exitCode = 1;
  }
  function finish() {
    if (failed || !readDone || !timerDone) return;
    fs.unlinkSync(workFile); created = false; words[12] = 1; words[6] |= 16;
    words[3] = 7; words[4] = 1; checkpoint(); closeReport();
  }
  try {
    fs = require('node:fs'); path = require('node:path').win32;
    const work = process.env.EMBER_LPAC_WORK, state = process.env.EMBER_LPAC_STATE;
    if (process.versions.node !== '22.23.5' || typeof work !== 'string' || typeof state !== 'string' ||
        !/^[A-Za-z]:\\/.test(work) || !/^[A-Za-z]:\\/.test(state) || work === state ||
        process.cwd().toLowerCase() !== work.toLowerCase()) throw new Error('fixed');
    for (const dir of [work, state]) {
      const info = fs.lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('fixed');
    }
    const tag = role ? 'lpac' : 'host';
    workFile = path.join(work, tag + '-source-node-work.bin');
    reportFd = fs.openSync(path.join(state, tag + '-source-node-report.bin'), 'wx', 0o600);
    words[3] = 1; words[6] = 1; checkpoint();
    const payload = Buffer.from('EMBER_NODE_SOURCE_PROBE\n', 'ascii'); words[7] = payload.length;
    fs.writeFileSync(workFile, payload, { flag: 'wx', mode: 0o600 }); created = true;
    const sync = fs.readFileSync(workFile);
    if (!sync.equals(payload)) throw new Error('fixed');
    words[8] = sync.length; words[6] |= 2; sync.fill(0); words[3] = 2; checkpoint();
    readPending = true;
    fs.readFile(workFile, function (error, data) {
      readPending = false;
      try {
        if (failed) { if (Buffer.isBuffer(data)) data.fill(0); return; }
        words[10]++;
        if (error || words[10] !== 1 || !Buffer.isBuffer(data) || !data.equals(payload)) throw new Error('fixed');
        words[9] = data.length; data.fill(0); words[6] |= 4; readDone = true; words[3] = 4;
        checkpoint(); finish();
      } catch { fail(); }
    });
    setTimeout(function () {
      try {
        if (failed) return;
        words[11]++;
        if (words[11] !== 1) throw new Error('fixed');
        words[6] |= 8; timerDone = true; words[3] = 5; checkpoint(); finish();
      } catch { fail(); }
    }, 1);
    words[3] = 3; checkpoint();
  } catch { fail(); }
})();`;
export const windowsNodeSourcePrograms = Object.freeze({ host: template.replace("__EMBER_ROLE__", "0"), lpac: template.replace("__EMBER_ROLE__", "1") });
export function windowsNodeSourceProgramReceipts() {
  return Object.fromEntries(Object.entries(windowsNodeSourcePrograms).map(([role, program]) => [role,
    { bytes: Buffer.byteLength(program, "utf8"), sha256: createHash("sha256").update(program).digest("hex") }]));
}
