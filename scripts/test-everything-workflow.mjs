#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('src/popup.html');
const popup = read('src/popup.js');
const worker = read('src/service-worker.js');
const content = read('src/content.js');
const readme = read('README.md');

assert.equal((html.match(/<button\b/g) || []).length, 1, 'popup has one button');
assert.match(html, /一键签到&amp;打卡/);
assert.match(popup, /action: 'everything'/);
assert.match(worker, /stage: 'checkin'/);
assert.match(worker, /openActionPage\('checkin', workflowId\)/);
assert.match(worker, /workflow\.stage = 'question'/);
assert.match(worker, /ensureQuestionWorkflowTab\(pending\.workflowId\)/);
assert.match(worker, /isSuccessResult\(result\)/);
assert.match(worker, /closeActionTabSafely\(pending\.tabId\)/);
assert.match(worker, /if \(pending\.status === 'completed'\) \{/);
assert.match(content, /finishRemoteAction\(actionId, 'question', 'success', 'already-completed'\)/);
assert.match(content, /finishRemoteAction\(actionId, 'question', 'success', 'already-completed'\)/);
assert.match(content, /finishRemoteAction\(actionId, 'checkin', 'success', 'already-completed'\)/);
assert.match(content, /requires-login/);
assert.match(content, /timeout/);
assert.match(readme, /先签到、后答题/);
assert.match(readme, /验证码、超时/);
assert.match(readme, /弹窗只提供“一键签到&打卡”操作按钮/);
assert.match(worker, /everything-in-progress/);
assert.match(worker, /workflow-stage-mismatch/);
assert.match(worker, /message: '签到和答题完成'/);
console.log('Everything workflow tests passed.');
