#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const protocolSource = fs.readFileSync(new URL('../src/shared/protocol.js', import.meta.url), 'utf8');
const popupSource = fs.readFileSync(new URL('../src/popup.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {}, Object, console };
vm.runInNewContext(protocolSource, sandbox);
const protocol = sandbox.globalThis.ExtensionProtocol;

assert.deepEqual(Array.from(protocol.PAGE_MATCHES), [
  'https://www.1point3acres.com/next/daily-question*',
  'https://www.1point3acres.com/next/daily-checkin*',
]);
assert.deepEqual({ ...protocol.PAGE_URLS }, {
  dailyQuestion: 'https://www.1point3acres.com/next/daily-question',
  dailyCheckin: 'https://www.1point3acres.com/next/daily-checkin',
});
for (const url of Object.values(protocol.PAGE_URLS)) assert(!url.endsWith('*'), 'navigation URL must not end with *');
assert.match(popupSource, /RUN_ONE_CLICK/);
assert.doesNotMatch(popupSource, /openPage|window\.open|open-question|open-checkin/);
assert.doesNotMatch(popupSource, /window\.open\(\s*ExtensionProtocol\.PAGE_MATCHES/);

console.log('Protocol and popup action tests passed.');
