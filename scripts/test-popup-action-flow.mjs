#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const protocol = read('src/shared/protocol.js');
const popup = read('src/popup.js');
const popupHtml = read('src/popup.html');
const worker = read('src/service-worker.js');
const content = read('src/content.js');

assert.match(protocol, /RUN_ONE_CLICK: 'RUN_ONE_CLICK'/);
assert.match(protocol, /CONTENT_READY: 'CONTENT_READY'/);
assert.match(worker, /\['question', 'checkin', 'everything'\]\.includes/);
assert.match(popupHtml, /id="run-everything"[^>]*>一键签到&amp;打卡/);
assert.doesNotMatch(popupHtml, /id="run-question"|id="run-checkin"/);
assert.doesNotMatch(popup, /openPage|window\.open|open-question|open-checkin/);
assert.match(popup, /action: 'everything'/);
assert.doesNotMatch(popupHtml, /打开每日答题|打开每日签到/);
assert.match(worker, /const RUNTIME_STORAGE_KEY = 'p3a-runtime-v1'/);
assert.match(worker, /const runtimeStorage = chrome\.storage\.session \|\| chrome\.storage\.local/);
assert.match(worker, /runtimeState\.pendingActionsById\[record\.actionId\] = \{ \.\.\.record \}/);
assert.match(worker, /await retryDeliverIfNeeded\(tabId\)/);
assert.match(worker, /if \(pending\?\.status === 'completed' && isSuccessResult\(pending\.lastResult\)\)/);
assert.match(worker, /claimPendingActionForTab\(tabId, page\)/);
assert.match(worker, /if \(!ack \|\| ack\.ok !== true \|\| ack\.accepted !== true \|\| ack\.actionId !== action\.actionId\)/);
assert.match(worker, /case ExtensionProtocol\.MESSAGE_TYPES\.CONTENT_READY:/);
assert.match(worker, /case ExtensionProtocol\.MESSAGE_TYPES\.ACTION_RESULT:/);
assert.match(worker, /pending\.status = 'completed'/);
assert.match(worker, /if \(success && pending\.action === 'checkin'\)/);
assert.match(worker, /pending\.action === 'question'/);
assert.match(worker, /await closeActionTabSafely\(pending\.tabId\);/);
assert.match(content, /REMOTE_RESULT_TIMEOUT_MS = 12000/);
assert.match(content, /waitForRemoteResult/);

assert.match(content, /const REMOTE_ACTION_TIMEOUT_MS = 8000/);
assert.match(content, /const REMOTE_ACTION_RETRY_MS = 200/);
assert.match(content, /Date\.now\(\) - started >= REMOTE_RESULT_TIMEOUT_MS/);
assert.match(content, /pendingRemoteActions\.has\(actionId\)/);
assert.match(content, /const runQuestionAction = async/);
assert.match(content, /if \(action === 'question'\) \{\s*runQuestionAction\(\{ actionId \}\)\.catch\(\(\) => \{\}\);\s*\}/, 'remote question command must call the direct execution path');
assert.doesNotMatch(content, /runToolbarAction\(action, actionId\)/, 'question remote path must not depend on toolbar clicks');
const handler = content.slice(content.indexOf('chrome.runtime.onMessage.addListener'), content.indexOf('let prepared = null'));
assert.match(handler, /pendingRemoteActions\.add\(actionId\)/);
assert.match(handler, /remoteActionTimers\.delete\(actionId\)/);
assert.match(handler, /if \(action === 'question'\)/);
assert.match(handler, /pendingRemoteActions\.add\(actionId\)/);
assert.match(handler, /runCheckinAction\(\{ actionId \}\)\.catch\(\(\) => \{\}\);/, 'checkin may still use its site button flow');
const initialPath = content.slice(0, content.indexOf("oneClick.addEventListener('click'"));
assert.doesNotMatch(initialPath, /(?:siteSubmit|DailyCheckinPage\.findSubmit\(\))\.click\(\)/);

console.log('popup to service worker to content flow tests passed.');
