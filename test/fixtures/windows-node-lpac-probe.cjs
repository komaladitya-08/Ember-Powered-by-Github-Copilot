/* eslint-disable @typescript-eslint/no-require-imports -- fixed CommonJS scripts staged for the native Node diagnostic, not app imports */
/** Fixed trusted probe, never project/model code. Writes only bounded reports into this fixture's state directory. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const child = require('node:child_process');
const [mode, hostCanary, portText] = process.argv.slice(2);
const state = process.env.EMBER_LPAC_STATE, work = process.env.EMBER_LPAC_WORK;
const codeOf = error => error && typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN';
const put = (name, value) => fs.writeFileSync(path.join(state, name), JSON.stringify(value), { flag: 'wx' });
const denied = action => { try { action(); return { denied: false, code: null }; } catch (error) { const code = codeOf(error); return { denied: code === 'EACCES' || code === 'EPERM', code }; } };
async function loopback(port) {
  return new Promise(resolve => {
    const socket = new net.Socket(); let finished = false;
    const end = value => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => end({ denied: false, code: 'TIMEOUT' }), 2000);
    socket.once('connect', () => end({ denied: false, code: 'CONNECTED' }));
    socket.once('error', error => { const code = codeOf(error); end({ denied: code === 'EACCES' || code === 'EPERM', code }); });
    socket.connect({ host: '127.0.0.1', port });
  });
}
(async () => {
  if (!state || !work || !['direct', 'child'].includes(mode)) throw new Error('INVALID_FIXED_PROBE_INPUT');
  if (mode === 'direct') {
    const before = fs.readFileSync(path.join(work, 'copied.cjs'), 'utf8');
    if (before !== 'module.exports = 41;\n') throw new Error('UNEXPECTED_COPY');
    fs.writeFileSync(path.join(work, 'copied.cjs'), 'module.exports = 42;\n');
    const read = denied(() => fs.readFileSync(hostCanary));
    const write = denied(() => fs.writeFileSync(hostCanary, 'not permitted'));
    const network = await loopback(Number(portText));
    const environmentAbsent = process.env.GH_TOKEN === undefined && process.env.EMBER_HOST_NODE_SECRET === undefined;
    const copiedEdit = fs.readFileSync(path.join(work, 'copied.cjs'), 'utf8') === 'module.exports = 42;\n';
    put('direct.json', { version: process.version, pid: process.pid, environmentAbsent, copiedEdit, read, write, network, localAppData: process.env.LOCALAPPDATA, temp: process.env.TEMP, tmp: process.env.TMP });
    if (!environmentAbsent || !copiedEdit || !read.denied || !write.denied || !network.denied) process.exitCode = 41;
  } else {
    const marker = path.join(state, 'ordinary-child.json');
    const expression = "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({child:true,pid:process.pid}),{flag:'wx'})";
    const result = child.spawnSync(process.execPath, ['--no-warnings', '-e', expression, marker], { stdio: 'ignore', timeout: 2000, killSignal: 'SIGKILL', windowsHide: true, env: { ...process.env } });
    put('child.json', { version: process.version, attempted: true, errorCode: result.error ? codeOf(result.error) : null,
      status: result.status, signal: result.signal, markerPresent: fs.existsSync(marker) });
  }
})().catch(error => {
  try { put('failure.json', { stage: ['direct', 'child'].includes(mode) ? mode : 'input', code: codeOf(error) }); } catch {}
  process.exitCode = 42;
});
