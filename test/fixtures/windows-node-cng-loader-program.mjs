/** Fixed loader diagnostics only. No supplied program, runtime flag override, project input or official issuer. */
import { createHash } from "node:crypto";

export const WINDOWS_NODE_CNG_LOADER_ISSUER = "ember-experimental-source-node-cng-loader";
export const WINDOWS_NODE_CNG_LOADER_REPORT_BYTES = 96;
export const WINDOWS_NODE_CNG_LOADER_MAGIC = 0x4c534e45;
export const WINDOWS_NODE_CNG_LOADER_VERSION = 22023005;
export const WINDOWS_NODE_CNG_LOADER_MODULE = "module.exports = 42;\n";
const template = String.raw`(function () {
  'use strict';
  const role = __EMBER_ROLE__, fs = require('node:fs'), path = require('node:path').win32;
  const words = [0x4c534e45,1,role,0,0,0,22023005,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  const codes = ['EACCES','EPERM','ENOENT','ENOTDIR','EINVAL','MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ERR_ACCESS_DENIED'];
  let reportFd = -1;
  function checkpoint(stage) {
    words[3] = stage; words[19]++;
    const bytes = Buffer.alloc(96);
    try {
      words.forEach(function (word, index) { bytes.writeUInt32LE(word, index * 4); });
      if (fs.writeSync(reportFd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('fixed');
      fs.fsyncSync(reportFd);
    } finally { bytes.fill(0); }
  }
  function operation(index, body) {
    const offset = 10 + index * 3, bit = 1 << index; words[7] |= bit;
    try { words[offset + 2] = body(); words[offset] = 1; words[8] |= bit; }
    catch (error) {
      let code = 0;
      try {
        if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
          const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
          if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') code = codes.indexOf(descriptor.value) + 1;
        }
      } catch { /* Unknown objects supply no error facts. */ }
      words[offset] = code > 0 ? 2 : 3; words[offset + 1] = code > 0 ? code : 0; words[offset + 2] = 0; words[9] |= bit;
    }
    checkpoint(index + 2);
  }
  try {
    const work = process.env.EMBER_LPAC_WORK, state = process.env.EMBER_LPAC_STATE;
    if (process.versions.node !== '22.23.5' || typeof work !== 'string' || typeof state !== 'string' ||
        !/^[A-Za-z]:\\/.test(work) || !/^[A-Za-z]:\\/.test(state) || work === state || process.cwd().toLowerCase() !== work.toLowerCase()) throw new Error('fixed');
    for (const key of ['GH_TOKEN','GITHUB_TOKEN','EMBER_NODE_CNG_ARTIFACT_TOKEN','EMBER_HOST_NODE_SECRET']) if (process.env[key] !== undefined) throw new Error('fixed');
    for (const directory of [work,state]) { const info = fs.lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('fixed'); }
    const file = path.join(work, 'cng-inprocess-copied.cjs');
    reportFd = fs.openSync(path.join(state, (role ? 'lpac' : 'host') + '-cng-loader-report.bin'), 'wx', 0o600); checkpoint(1);
    operation(0, function () {
      const bytes = fs.readFileSync(file);
      try { if (!bytes.equals(Buffer.from('module.exports = 42;\n'))) throw new Error('fixed'); return bytes.length; }
      finally { bytes.fill(0); }
    });
    operation(1, function () {
      const actual = fs.realpathSync(file);
      if (typeof actual !== 'string' || path.normalize(actual).toLowerCase() !== path.normalize(file).toLowerCase()) throw new Error('fixed'); return 1;
    });
    operation(2, function () { const value = require(file); if (value !== 42) throw new Error('fixed'); return 42; });
    words[4] = 1; words[5] = words[8] === 7 && words[9] === 0 ? 1 : 0; checkpoint(5);
    process.exitCode = words[5] === 1 ? 0 : 1;
  } catch { process.exitCode = 1; }
  finally { if (reportFd >= 0) { const owned = reportFd; reportFd = -1; try { fs.closeSync(owned); } catch { process.exitCode = 1; } } }
})();`;
export const windowsNodeCngLoaderPrograms = Object.freeze({ host: template.replace("__EMBER_ROLE__", "0"), lpac: template.replace("__EMBER_ROLE__", "1") });
export function windowsNodeCngLoaderProgramReceipts() {
  return Object.fromEntries(Object.entries(windowsNodeCngLoaderPrograms).map(([role, program]) => [role,
    { bytes: Buffer.byteLength(program, "utf8"), sha256: createHash("sha256").update(program).digest("hex") }]));
}
