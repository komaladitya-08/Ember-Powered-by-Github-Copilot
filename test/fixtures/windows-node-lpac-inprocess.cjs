/* eslint-disable @typescript-eslint/no-require-imports -- fixed CommonJS scripts staged for the native Node diagnostic, not app imports */
/** One useful Node check with child-process test isolation explicitly disabled by the host's fixed CLI. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('an in-process copied-module check works in capability-free LPAC', () => {
  assert.ok(process.execArgv.includes('--experimental-test-isolation=none') || process.execArgv.includes('--test-isolation=none'));
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.equal(process.env.EMBER_HOST_NODE_SECRET, undefined);
  assert.equal(require(path.join(process.env.EMBER_LPAC_WORK, 'copied.cjs')), 42);
  fs.writeFileSync(path.join(process.env.EMBER_LPAC_STATE, 'inprocess.json'), JSON.stringify({ version: process.version, pid: process.pid, inProcessCheck: true }), { flag: 'wx' });
});
