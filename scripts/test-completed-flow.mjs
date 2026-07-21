#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../src/', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
const workerSource = read('../src/service-worker.js');
const protocolSource = read('../src/shared/protocol.js');
const questionMatcherSource = read('../src/shared/question-matcher.js');
const learnedAnswersSource = read('../src/shared/learned-answers.js');

const runtimeKey = 'p3a-runtime-v1';
const flush = () => new Promise((resolve) => setImmediate(resolve));

const makeHarness = ({ store, tabs = [] }) => {
  const events = [];
  const listeners = { message: null, updated: null };
  let nextTabId = Math.max(0, ...tabs.map((tab) => tab.id || 0)) + 1;
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));

  const chrome = {
    runtime: {
      getURL: (p) => p,
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: store.session[key] }),
        set: async (value) => { Object.assign(store.session, value); events.push(['storage.session.set', JSON.parse(JSON.stringify(value))]); },
      },
      local: {
        get: async (key) => ({ [key]: store.local[key] }),
        set: async (value) => { Object.assign(store.local, value); },
      },
    },
    tabs: {
      query: async () => [...tabMap.values()].map((tab) => ({ ...tab })),
      create: async ({ url, active }) => {
        const tab = { id: nextTabId++, url, active: active === true };
        tabMap.set(tab.id, tab);
        events.push(['tabs.create', { ...tab }]);
        return { ...tab };
      },
      update: async (tabId, changes) => {
        const tab = tabMap.get(tabId);
        if (!tab) throw new Error('missing-tab');
        Object.assign(tab, changes);
        events.push(['tabs.update', tabId, { ...changes }]);
        return { ...tab };
      },
      remove: async (tabId) => {
        events.push(['tabs.remove', tabId]);
        tabMap.delete(tabId);
      },
      get: async (tabId) => {
        const tab = tabMap.get(tabId);
        if (!tab) throw new Error('missing-tab');
        return { ...tab };
      },
      sendMessage: async (tabId, message) => {
        events.push(['tabs.sendMessage', tabId, message]);
        return { ok: true, accepted: true, actionId: message.payload.actionId };
      },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
    },
    notifications: {
      create: async (opts) => { events.push(['notifications.create', opts]); return 'n1'; },
    },
  };

  const context = {
    globalThis: {},
    console,
    crypto: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() },
    fetch: async () => ({ ok: true, json: async () => ({ entries: [] }) }),
    chrome,
  };
  context.globalThis = context;
  context.importScripts = (...files) => files.forEach((file) => {
    const source = file === 'shared/protocol.js' ? protocolSource : file === 'shared/question-matcher.js' ? questionMatcherSource : learnedAnswersSource;
    vm.runInContext(source, context);
  });
  vm.createContext(context);
  vm.runInContext(workerSource, context);

  const send = (type, payload, sender = {}) => new Promise((resolve) => listeners.message({ type, payload }, sender, resolve));
  return { events, send, store, tabMap };
};

const store = {
  session: {
    [runtimeKey]: {
      version: 1,
      actionsByTabId: {
        '51': {
          action: 'checkin',
          actionId: 'checkin-51',
          workflowId: 'workflow-51',
          tabId: 51,
          status: 'pending',
          deliveredAt: 1,
          deliveredCount: 1,
          lastDeliveryAttemptAt: 1,
          lastDeliveryError: null,
          lastResult: null,
        },
      },
      awaitingContentByTabId: {},
      pendingActionsById: {},
      workflowsById: {
        'workflow-51': {
          action: 'everything',
          stage: 'checkin',
          createdAt: 1,
          updatedAt: 1,
          tabIds: [51],
          checkinActionId: 'checkin-51',
          questionActionId: null,
        },
      },
      activeWorkflowId: 'workflow-51',
    },
  },
  local: { 'p3a-learned-answers-v1': [] },
};

const harness = makeHarness({
  store,
  tabs: [{ id: 51, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
});

const checkinResp = await harness.send('ACTION_RESULT', { actionId: 'checkin-51', action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: 51 } });
await flush();
assert.equal(checkinResp.ok, true, 'completed checkin should be accepted');
const questionCreate = harness.events.find((event) => event[0] === 'tabs.create' && event[1].url.includes('/daily-question'));
assert.ok(questionCreate, 'completed checkin should open question tab');
assert.equal(questionCreate[1].active, false, 'question tab must open inactive');
assert.ok(harness.events.find((event) => event[0] === 'tabs.remove' && event[1] === 51), 'completed checkin should close only the checkin tab');
const questionRecord = Object.values(store.session[runtimeKey].actionsByTabId).find((record) => record?.action === 'question');
assert.ok(questionRecord, 'question action should be persisted');
assert.equal(store.session[runtimeKey].workflowsById['workflow-51'].stage, 'question', 'workflow should advance to question');
assert.ok(harness.events.find((event) => event[0] === 'notifications.create' && event[1].message === '签到完成'), 'checkin success should notify');

const questionResp = await harness.send('ACTION_RESULT', { actionId: questionRecord.actionId, action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: questionRecord.tabId } });
await flush();
assert.equal(questionResp.ok, true, 'completed question should be accepted');
assert.equal(store.session[runtimeKey].workflowsById['workflow-51'], undefined, 'workflow should be cleared after completed question');
assert.equal(store.session[runtimeKey].activeWorkflowId, null, 'active workflow should be cleared after completed question');
assert.ok(harness.events.find((event) => event[0] === 'tabs.remove' && event[1] === questionRecord.tabId), 'completed question should close the question tab');
assert.ok(harness.events.find((event) => event[0] === 'notifications.create' && event[1].message === '签到和答题完成'), 'workflow completion should notify');

console.log('completed workflow regression test passed.');
