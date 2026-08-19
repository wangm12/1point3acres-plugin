#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const protocol = read('src/shared/protocol.js');
const popup = read('src/popup.js');
const popupHtml = read('src/popup.html');
const worker = read('src/service-worker.js');

assert.match(protocol, /RUN_ONE_CLICK: 'RUN_ONE_CLICK'/);
assert.match(protocol, /CONTENT_READY: 'CONTENT_READY'/);
assert.match(worker, /coordinatorStart/);
assert.match(worker, /coordinatorActionResult/);
assert.match(worker, /coordinatorFinalize/);
assert.match(worker, /runtimeStorage = chrome\.storage\.session \|\| chrome\.storage\.local/);
assert.match(worker, /sendResponse\(reply\);\s*if \(reply\?\.accepted === true && reply\?\.finalize\)/s);
assert.match(worker, /await closeActionTabSafely\(pending\.tabId, pending\);/);
assert.match(worker, /await notifyCheckinCompletedOnce\(pending\.workflowId\)/);
assert.match(worker, /reason: 'completed-checkin-advances-to-question'/);
assert.match(worker, /notifications\.create/);
assert.match(popupHtml, /id="run-everything"/);
assert.match(popupHtml, /id="run-checkin"/);
assert.match(popupHtml, /id="run-question"/);
assert.match(popupHtml, /id="alert-banner"/);
assert.doesNotMatch(popup, /openPage|window\.open|open-question|open-checkin/);
assert.match(popup, /RUN_ONE_CLICK/);
assert.doesNotMatch(popupHtml, /打开每日答题|打开每日签到/);

console.log('popup to service worker to content flow tests passed.');
