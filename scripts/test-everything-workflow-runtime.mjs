#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let listener; let nextTabId = 10; const sent = []; const tabs = []; const tabCreates = []; const tabUpdates = []; const notifications = [];
const context = { console, crypto: { randomUUID: (() => { let n = 0; return () => `id-${++n}`; })() }, chrome: {
  runtime: { getURL: (path) => path, onMessage: { addListener: (fn) => { listener = fn; } } },
  tabs: { query: async () => [...tabs], create: async (change) => { tabCreates.push(change); const tab = { id: nextTabId++, ...change }; tabs.push(tab); return tab; }, update: async (id, change) => { tabUpdates.push({ id, ...change }); const tab = tabs.find((item) => item.id === id); Object.assign(tab, change); return tab; }, remove: async (id) => { const index = tabs.findIndex((item) => item.id === id); if (index >= 0) tabs.splice(index, 1); }, get: async (id) => { const tab = tabs.find((item) => item.id === id); if (!tab) throw new Error('missing-tab'); return { ...tab }; }, sendMessage: (id, message) => { sent.push({ id, message }); return Promise.resolve(); } },
  notifications: { create: async (options) => { notifications.push(options); return 'notification-id'; } },
  storage: { local: { get: async () => ({}), set: async () => {} } },
} };
vm.createContext(context);
context.importScripts = (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), context));
vm.runInContext(fs.readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8'), context);
const send = (type, payload, tabId) => new Promise((resolve) => listener({ type, payload }, { tab: tabId == null ? undefined : { id: tabId } }, resolve));

let response = await send('RUN_ONE_CLICK', { action: 'everything' });
assert.equal(response.ok, true, 'first Everything starts');
assert.equal(tabCreates[0].active, false, 'created workflow tab stays inactive');
const workflowId = response.payload.workflowId;
response = await send('RUN_ONE_CLICK', { action: 'everything' });
assert.equal(response.ok, true, 'duplicate Everything resumes existing workflow');
assert.equal(response.payload.workflowId, workflowId, 'duplicate Everything keeps same workflow');
const checkin = sent.at(-1);
response = await send('ACTION_RESULT', { actionId: checkin.message.payload.actionId, action: 'question', status: 'success' }, checkin.id);
assert.equal(response.ok, false, 'wrong action cannot advance workflow');
assert.equal(response.error, 'workflow-stage-mismatch');
response = await send('ACTION_RESULT', { actionId: checkin.message.payload.actionId, action: 'checkin', status: 'success' }, checkin.id);
assert.equal(response.ok, true, 'check-in advances workflow');
await new Promise((resolve) => setTimeout(resolve, 0));
const question = sent.at(-1);
assert.equal(question.message.payload.workflowId, workflowId, 'question remains in same workflow');
response = await send('ACTION_RESULT', { actionId: question.message.payload.actionId, action: 'question', status: 'timeout' }, question.id);
assert.equal(response.ok, true, 'timeout is acknowledged');
response = await send('RUN_ONE_CLICK', { action: 'everything' });
assert.equal(response.ok, true, 'failed workflow releases duplicate guard');
assert.equal(notifications.length, 1, 'successful check-in creates notification');

tabs.length = 0;
const reused = { id: 77, url: 'https://www.1point3acres.com/next/daily-checkin', active: false };
tabs.push(reused);
response = await send('RUN_ONE_CLICK', { action: 'checkin' });
assert.equal(response.ok, true, 'standalone check-in starts');
assert.equal(tabUpdates.at(-1).active, false, 'reused check-in tab stays inactive');
assert.equal(reused.active, false, 'reused tab is not activated');

tabs.length = 0;
const activeTarget = { id: 88, url: 'https://www.1point3acres.com/next/daily-checkin', active: true };
tabs.push(activeTarget);
const createsBeforeActiveTarget = tabCreates.length;
const updatesBeforeActiveTarget = tabUpdates.length;
response = await send('RUN_ONE_CLICK', { action: 'checkin' });
assert.equal(response.ok, true, 'active target starts in a new tab');
assert.equal(tabCreates.length, createsBeforeActiveTarget + 1, 'active target is not reused');
assert.equal(tabCreates.at(-1).active, false, 'new target tab stays inactive');
assert.equal(tabUpdates.length, updatesBeforeActiveTarget, 'active target is not updated or navigated');
assert.equal(activeTarget.active, true, 'original active target remains active');
console.log('Everything workflow runtime tests passed.');
