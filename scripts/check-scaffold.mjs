#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const readText = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const requiredPaths = [
  'manifest.json',
  'README.md',
  'assets/1point3acres-helper-icon-16.png',
  'assets/1point3acres-helper-icon-32.png',
  'assets/1point3acres-helper-icon-48.png',
  'assets/1point3acres-helper-icon-128.png',
  'assets/1point3acres-helper-icon-enabled.svg',
  'assets/1point3acres-helper-icon-enabled-16.png',
  'assets/1point3acres-helper-icon-enabled-32.png',
  'assets/1point3acres-helper-icon-enabled-48.png',
  'assets/1point3acres-helper-icon-enabled-128.png',
  'src/service-worker.js',
  'src/popup.html',
  'src/popup.js',
  'src/popup.css',
  'src/content.js',
  'src/content.css',
  'src/shared/protocol.js',
  'src/shared/question-matcher.js',
  'src/shared/learned-answers.js',
  'src/shared/daily-question-page.js',
  'src/shared/daily-checkin-page.js',
  'src/shared/checkin-state.js',
];

for (const relativePath of requiredPaths) {
  assert(exists(relativePath), `Missing required file: ${relativePath}`);
}

const manifest = readJson('manifest.json');

assert(manifest.manifest_version === 3, 'manifest_version must be 3');
const iconPaths = ['16', '32', '48', '128'];
for (const size of iconPaths) {
  assert(manifest.icons?.[size] === `assets/1point3acres-helper-icon-${size}.png`, `manifest icon ${size} mismatch`);
  assert(manifest.action?.default_icon?.[size] === manifest.icons[size], `action icon ${size} mismatch`);
}
assert(!JSON.stringify(manifest).includes('helper-icon-enabled'), 'manifest must not reference runtime-only enabled icons');
assert(manifest.background?.service_worker === 'src/service-worker.js', 'background service worker path mismatch');
assert(manifest.action?.default_popup === 'src/popup.html', 'popup path mismatch');
assert(JSON.stringify(manifest.permissions ?? []) === JSON.stringify(['storage', 'notifications', 'alarms']), 'permissions must be exactly storage, notifications, and alarms');
assert(JSON.stringify(manifest.host_permissions ?? []) === JSON.stringify(['https://1point3acres.com/*', 'https://www.1point3acres.com/*']), 'host permissions must be limited to 1point3acres');

const contentScripts = manifest.content_scripts ?? [];
assert(contentScripts.length === 1, 'expected one content_scripts entry');

const script = contentScripts[0];
const expectedMatches = [
  'https://1point3acres.com/next/daily-question*',
  'https://1point3acres.com/next/daily-checkin*',
  'https://www.1point3acres.com/next/daily-question*',
  'https://www.1point3acres.com/next/daily-checkin*',
];
assert(JSON.stringify(script.matches ?? []) === JSON.stringify(expectedMatches), 'content script matches mismatch');
assert(JSON.stringify(script.js ?? []) === JSON.stringify(['src/shared/protocol.js', 'src/shared/question-matcher.js', 'src/shared/learned-answers.js', 'src/shared/daily-question-page.js', 'src/shared/daily-checkin-page.js', 'src/shared/checkin-state.js', 'src/content.js']), 'content script js mismatch');
assert(JSON.stringify(script.css ?? []) === JSON.stringify(['src/content.css']), 'content script css mismatch');

const protocolSource = readText('src/shared/protocol.js');
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.runInNewContext(protocolSource, sandbox, { filename: 'src/shared/protocol.js' });

const protocol = sandbox.ExtensionProtocol;
assert(protocol && typeof protocol === 'object', 'ExtensionProtocol was not defined');

const expectedMessageTypes = [
  'QUESTION_STATE',
  'SELECT_ANSWER',
  'PREPARE_CHECKIN',
  'CONFIRM_SUBMIT',
  'SAVE_LEARNED_ANSWER',
  'LOOKUP_QUESTION',
  'RUN_ONE_CLICK',
  'AUTO_SCHEDULE_GET',
  'AUTO_SCHEDULE_ENABLE',
  'AUTO_SCHEDULE_DISABLE',
  'AUTO_SCHEDULE_STATE',
  'CONTENT_READY',
  'ACTION_RESULT',
  'GET_RUNTIME_STATE',
  'FOCUS_TASK_TAB',
];

assert(
  JSON.stringify(Object.keys(protocol.MESSAGE_TYPES ?? {}).sort()) === JSON.stringify(expectedMessageTypes.slice().sort()),
  'message type keys mismatch',
);
assert(
  JSON.stringify(Object.values(protocol.MESSAGE_TYPES ?? {}).sort()) === JSON.stringify(expectedMessageTypes.slice().sort()),
  'message type values mismatch',
);

assert(Array.isArray(protocol.PAGE_MATCHES), 'PAGE_MATCHES must be an array');
assert(
  JSON.stringify(protocol.PAGE_MATCHES) === JSON.stringify(expectedMatches),
  'PAGE_MATCHES must match the manifest URLs',
);
assert(protocol.PAGE_URLS?.dailyQuestion === 'https://www.1point3acres.com/next/daily-question', 'dailyQuestion navigation URL mismatch');
assert(protocol.PAGE_URLS?.dailyCheckin === 'https://www.1point3acres.com/next/daily-checkin', 'dailyCheckin navigation URL mismatch');
assert(!Object.values(protocol.PAGE_URLS).some((url) => url.endsWith('*')), 'navigation URLs must not contain match wildcard');

const contentSource = readText('src/content.js');
assert(contentSource.includes("document.getElementById(toolbarId)") && contentSource.includes("if (!bar) { bar = document.createElement('section');"), 'daily question toolbar must render from the content script');
assert(contentSource.includes("document.getElementById(checkinToolbarId)") && contentSource.includes("if (!bar) { bar = document.createElement('section');"), 'daily check-in toolbar must render from the content script');
assert(contentSource.includes("select.textContent = '选中答案'"), 'manual select-answer button missing');
assert(contentSource.includes("remember.textContent = '记住当前答案'"), 'remember-answer button missing');
assert(contentSource.includes("submit.textContent = '确认并提交'"), 'manual submit button missing');

console.log('Scaffold checks passed.');
