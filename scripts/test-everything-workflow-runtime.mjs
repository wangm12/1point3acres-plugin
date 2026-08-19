#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let listener;
let nextTabId = 10;
const sent = [];
const tabs = [];
const tabCreates = [];
const tabUpdates = [];
const notifications = [];
const storage = { session: {}, local: { 'p3a-learned-answers-v1': [] } };

const context = {
  console,
  crypto: { randomUUID: (() => { let n = 0; return () => `id-${++n}`; })() },
  setTimeout,
  clearTimeout,
  chrome: {
    runtime: { getURL: (path) => path, onMessage: { addListener: (fn) => { listener = fn; } } },
    tabs: {
      query: async (queryInfo = {}) => {
        if (queryInfo?.currentWindow === true) return [];
        const activeTabs = tabs.filter((tab) => tab.active === true);
        if (queryInfo?.lastFocusedWindow === true || queryInfo?.active === true) return activeTabs.map((tab) => ({ ...tab }));
        return tabs.map((tab) => ({ ...tab }));
      },
      create: async (change) => {
        tabCreates.push(change);
        const tab = { id: nextTabId++, active: change.active === true, ...change };
        tabs.push(tab);
        return { ...tab };
      },
      update: async (id, change) => {
        tabUpdates.push({ id, ...change });
        const tab = tabs.find((item) => item.id === id);
        Object.assign(tab, change);
        return { ...tab };
      },
      remove: async (id) => {
        const index = tabs.findIndex((item) => item.id === id);
        if (index >= 0) tabs.splice(index, 1);
      },
      get: async (id) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error('missing-tab');
        return { ...tab };
      },
      sendMessage: (id, message) => {
        sent.push({ id, message });
        return Promise.resolve({ ok: true });
      },
    },
    notifications: { create: async (options) => { notifications.push(options); return 'notification-id'; } },
    storage: {
      session: {
        get: async (key) => ({ [key]: storage.session[key] }),
        set: async (value) => { Object.assign(storage.session, value); },
      },
      local: {
        get: async (key) => ({ [key]: storage.local[key] }),
        set: async (value) => { Object.assign(storage.local, value); },
      },
    },
  },
};

vm.createContext(context);
context.importScripts = (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), context));
vm.runInContext(fs.readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8'), context);

const send = (type, payload, tabId) => new Promise((resolve) => listener({ type, payload }, { tab: tabId == null ? undefined : { id: tabId } }, resolve));
const flush = () => new Promise((resolve) => setImmediate(resolve));

{
  tabs.length = 0;
  tabCreates.length = 0;
  tabUpdates.length = 0;
  sent.length = 0;
  notifications.length = 0;
  nextTabId = 10;
  storage.session = {};

  tabs.push({ id: 81, url: 'https://www.1point3acres.com/bbs/thread-1', active: true });
  const first = await send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(first.ok, true, 'everything should start');
  const firstCheckin = tabCreates.find((event) => String(event.url).includes('/daily-checkin'));
  assert.ok(firstCheckin, 'everything should create a checkin tab');
  assert.equal(firstCheckin.active, false, 'checkin tab must be inactive');
  assert.equal(storage.session['p3a-runtime-v1'].run.stage, 'checkin', 'run should start in checkin stage');

  const second = await send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(second.ok, true, 'everything should be idempotent on the same day');
  assert.equal(second.payload.runId, first.payload.runId, 'repeat entry should reuse the same runId');
  assert.equal(second.payload.tabId, first.payload.tabId, 'repeat entry should not open a new tab');
  assert.equal(tabCreates.filter((event) => String(event.url).includes('/daily-checkin')).length, 1, 'repeat entry should not create another checkin tab');

  const bad = await send('RUN_ONE_CLICK', { action: 'legacy-workflow' });
  await flush();
  assert.equal(bad.ok, false, 'wrong action must be rejected');
  assert.equal(bad.error, 'unknown-action', 'wrong action should return an explicit negative ACK');
}

{
  tabs.length = 0;
  tabCreates.length = 0;
  tabUpdates.length = 0;
  sent.length = 0;
  notifications.length = 0;
  nextTabId = 20;
  storage.session = {};

  tabs.push({ id: 61, url: 'https://www.1point3acres.com/bbs', active: true });
  const start = await send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(start.ok, true, 'everything should start for checkin-to-question flow');
  const checkinCreate = tabCreates.find((event) => String(event.url).includes('/daily-checkin'));
  assert.ok(checkinCreate, 'checkin tab should be created');
  assert.equal(checkinCreate.active, false, 'checkin tab must stay inactive');

  const checkinAction = Object.values(storage.session['p3a-runtime-v1'].actionsByTabId).find((record) => record?.action === 'checkin');
  const checkinResult = await send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success', reason: 'already-completed' }, checkinAction.tabId);
  await flush();
  assert.equal(checkinResult.ok, true, 'checkin success should be acknowledged');

  const questionCreates = tabCreates.filter((event) => String(event.url).includes('/daily-question'));
  assert.equal(questionCreates.length, 1, 'checkin success should produce exactly one question tab');
  assert.equal(questionCreates[0].active, false, 'question tab must be inactive');
  assert.equal(storage.session['p3a-runtime-v1'].run.stage, 'question', 'run stage should advance to question');

  const questionAction = Object.values(storage.session['p3a-runtime-v1'].actionsByTabId).find((record) => record?.action === 'question');
  assert.ok(questionAction, 'question action should exist after checkin success');
  const questionFailure = await send('ACTION_RESULT', { actionId: questionAction.actionId, action: 'question', status: 'failed', reason: 'captcha-required' }, questionAction.tabId);
  await flush();
  assert.equal(questionFailure.ok, true, 'failed question result should still be ACKed');
  assert.equal(questionFailure.accepted, true, 'failed question result should be accepted');
}

{
  tabs.length = 0;
  tabCreates.length = 0;
  tabUpdates.length = 0;
  sent.length = 0;
  notifications.length = 0;
  nextTabId = 30;
  storage.session = {};

  tabs.push(
    { id: 91, url: 'https://www.1point3acres.com/next/daily-checkin', active: true },
    { id: 92, url: 'https://www.1point3acres.com/bbs/thread-92', active: false },
  );
  const response = await send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'active task tab should not block a new everything run');
  assert.equal(tabUpdates.some((event) => event.id === 91 && event.active === true), false, 'active task tab must not be re-activated');
  assert.equal(tabUpdates.some((event) => event.id === 91 && Object.prototype.hasOwnProperty.call(event, 'active')), false, 'active task tab must not receive an active toggle');
  assert.equal(tabUpdates.some((event) => event.id === 91 && event.url && String(event.url).includes('/daily-question')), false, 'active task tab must not be redirected during start');
  assert.equal(tabs.find((tab) => tab.id === 91)?.active, true, 'active task tab should remain active');
  assert.equal(tabs.find((tab) => tab.id === 91)?.url, 'https://www.1point3acres.com/next/daily-checkin', 'active task tab url should remain untouched');
}

console.log('everything workflow runtime tests passed.');
