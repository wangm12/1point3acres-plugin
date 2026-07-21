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

const makeHarness = ({ store, tabs = [], sendMessageMode = {} }) => {
  const events = [];
  const listeners = { message: null, updated: null };
  let nextTabId = Math.max(0, ...tabs.map((tab) => tab.id || 0)) + 1;

  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const sessionStore = store.session;
  const localStore = store.local;

  const chrome = {
    runtime: {
      getURL: (p) => p,
      onMessage: {
        addListener: (fn) => { listeners.message = fn; },
      },
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionStore[key] }),
        set: async (value) => { Object.assign(sessionStore, value); events.push(['storage.session.set', JSON.parse(JSON.stringify(value))]); },
      },
      local: {
        get: async (key) => ({ [key]: localStore[key] }),
        set: async (value) => { Object.assign(localStore, value); },
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
        const mode = sendMessageMode[tabId] ?? sendMessageMode.default ?? 'ack';
        if (mode === 'throw') throw new Error('sendMessage-failed');
        if (mode === 'noack') return null;
        if (typeof mode === 'function') return mode(tabId, message);
        return { ok: true, accepted: true, actionId: message.payload.actionId };
      },
      onUpdated: {
        addListener: (fn) => { listeners.updated = fn; },
      },
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

  const send = (type, payload, sender = {}) => new Promise((resolve) => listeners.message({ type, payload }, sender, (response) => {
    events.push(['sendResponse', type, response]);
    resolve(response);
  }));
  const triggerUpdated = (tabId, changeInfo, tab) => listeners.updated?.(tabId, changeInfo, tab);

  return { chrome, events, sessionStore, localStore, send, triggerUpdated, tabMap };
};

const runtimeKey = 'p3a-runtime-v1';
const flush = () => new Promise((resolve) => setImmediate(resolve));

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness1 = makeHarness({
    store,
    sendMessageMode: { default: 'throw' },
  });

  const open1 = await harness1.send('RUN_ONE_CLICK', { action: 'checkin' });
  assert.equal(open1.ok, true);
  const tabId = open1.payload.tabId;
  const runtimeAfterOpen = store.session[runtimeKey];
  const checkinAction = runtimeAfterOpen.actionsByTabId[String(tabId)];
  assert.equal(checkinAction.action, 'checkin');
  assert.equal(checkinAction.status, 'pending');
  assert.equal(runtimeAfterOpen.awaitingContentByTabId[String(tabId)].actionId, checkinAction.actionId);

  await harness1.send('CONTENT_READY', {}, { tab: { id: tabId } });
  await flush();
  assert.equal(store.session[runtimeKey].actionsByTabId[String(tabId)].lastDeliveryError, 'sendMessage-failed');
  assert.equal(store.session[runtimeKey].awaitingContentByTabId[String(tabId)].actionId, checkinAction.actionId);

  const harness2 = makeHarness({
    store,
    tabs: [{ id: tabId, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness2.send('CONTENT_READY', {}, { tab: { id: tabId } });
  await flush();
  assert.equal(store.session[runtimeKey].actionsByTabId[String(tabId)].deliveredAt > 0, true);
  assert.equal(store.session[runtimeKey].awaitingContentByTabId[String(tabId)], undefined);
  assert.deepEqual(harness2.events.filter((e) => e[0] === 'tabs.sendMessage').length, 1);
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {},
        awaitingContentByTabId: {},
        pendingActionsById: {
          'pending-1': {
            action: 'checkin',
            actionId: 'pending-1',
            workflowId: null,
            tabId: null,
            status: 'pending',
            deliveredAt: null,
            deliveredCount: 0,
            lastDeliveryAttemptAt: null,
            lastDeliveryError: null,
            lastResult: null,
          },
        },
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };
  const harness = makeHarness({
    store,
    tabs: [{ id: 41, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness.send('CONTENT_READY', {}, { tab: { id: 41 } });
  await flush();
  assert.equal(store.session[runtimeKey].actionsByTabId['41'].actionId, 'pending-1');
  assert.equal(store.session[runtimeKey].actionsByTabId['41'].deliveredAt > 0, true);
}

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness = makeHarness({
    store,
    tabs: [{ id: 11, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  const open = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  assert.equal(open.ok, true);
  const checkinTabId = open.payload.tabId;
  const runtime = store.session[runtimeKey];
  const workflowId = open.payload.workflowId;
  const checkinAction = runtime.actionsByTabId[String(checkinTabId)];
  assert.equal(checkinAction.workflowId, workflowId);

  const resultResp = await harness.send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success' }, { tab: { id: checkinTabId } });
  await flush();
  assert.equal(resultResp.ok, true);
  const eventNames = harness.events.map((e) => e[0]);
  assert.ok(eventNames.indexOf('sendResponse') < eventNames.indexOf('tabs.remove'));
  assert.ok(eventNames.indexOf('tabs.remove') > eventNames.indexOf('notifications.create'));
  assert.equal(store.session[runtimeKey].workflowsById[workflowId].stage, 'question');
  const questionTabId = harness.events.find((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question'))[1].id;
  const questionAction = store.session[runtimeKey].actionsByTabId[String(questionTabId)];
  assert.equal(questionAction.action, 'question');
  assert.equal(questionAction.status, 'pending');
  assert.equal(harness.tabMap.has(checkinTabId), false);

  const questionActionId = store.session[runtimeKey].actionsByTabId[String(questionTabId)].actionId;
  const questionResp = await harness.send('ACTION_RESULT', { actionId: questionActionId, action: 'question', status: 'success' }, { tab: { id: questionTabId } });
  await flush();
  assert.equal(questionResp.ok, true);
  assert.equal(store.session[runtimeKey].workflowsById[workflowId], undefined);
  assert.equal(store.session[runtimeKey].activeWorkflowId, null);
  assert.equal(store.session[runtimeKey].actionsByTabId[String(questionTabId)], undefined);
  assert.equal(store.session[runtimeKey].pendingActionsById[questionActionId], undefined);
  assert.equal(harness.tabMap.has(questionTabId), false);

  const duplicateCountBefore = harness.events.length;
  const duplicate = await harness.send('ACTION_RESULT', { actionId: questionActionId, action: 'question', status: 'success' }, { tab: { id: questionTabId } });
  await flush();
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'unknown-action-id');
  assert.equal(harness.events.length, duplicateCountBefore + 1);
}

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness = makeHarness({
    store,
    tabs: [{ id: 21, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  const open = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  const checkinTabId = open.payload.tabId;
  const checkinActionId = store.session[runtimeKey].actionsByTabId[String(checkinTabId)].actionId;

  const failed = await harness.send('ACTION_RESULT', { actionId: checkinActionId, action: 'checkin', status: 'failed' }, { tab: { id: checkinTabId } });
  await flush();
  assert.equal(failed.ok, true);
  assert.equal(harness.tabMap.has(checkinTabId), true);
  assert.equal(store.session[runtimeKey].workflowsById[open.payload.workflowId], undefined);

  const timeoutHarness = makeHarness({
    store: { session: {}, local: { 'p3a-learned-answers-v1': [] } },
    tabs: [{ id: 31, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  const opened = await timeoutHarness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const timeoutTabId = opened.payload.tabId;
  const timeoutActionId = timeoutHarness.sessionStore[runtimeKey].actionsByTabId[String(timeoutTabId)].actionId;
  await timeoutHarness.send('ACTION_RESULT', { actionId: timeoutActionId, action: 'checkin', status: 'timeout' }, { tab: { id: timeoutTabId } });
  await flush();
  assert.equal(timeoutHarness.tabMap.has(timeoutTabId), true);
}

{
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
            status: 'completed',
            deliveredAt: 1,
            deliveredCount: 1,
            lastDeliveryAttemptAt: 1,
            lastDeliveryError: null,
            lastResult: { action: 'checkin', status: 'success', reason: 'already-completed' },
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
  const response = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'completed checkin workflow should resume instead of failing');
  assert.equal(store.session[runtimeKey].workflowsById['workflow-51'].stage, 'question');
  const questionCreate = harness.events.find((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question'));
  assert.ok(questionCreate, 'question tab should open after completed checkin');
  assert.equal(store.session[runtimeKey].actionsByTabId[String(questionCreate[1].id)].action, 'question');
  const createCountBeforeDuplicate = harness.events.filter((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')).length;
  const duplicate = await harness.send('ACTION_RESULT', { actionId: 'checkin-51', action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: 51 } });
  await flush();
  assert.equal(duplicate.ok, true, 'duplicate completed ACTION_RESULT should be accepted for recovery');
  assert.equal(duplicate.duplicate, true, 'duplicate completed ACTION_RESULT should be marked duplicate');
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')).length, createCountBeforeDuplicate, 'duplicate recovery must not create another question tab');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '61': {
            action: 'checkin',
            actionId: 'checkin-61',
            workflowId: 'workflow-61',
            tabId: 61,
            status: 'pending',
            deliveredAt: null,
            deliveredCount: 0,
            lastDeliveryAttemptAt: null,
            lastDeliveryError: null,
            lastResult: null,
          },
        },
        awaitingContentByTabId: {
          '61': {
            action: 'checkin',
            actionId: 'checkin-61',
            workflowId: 'workflow-61',
            tabId: 61,
            status: 'pending',
            deliveredAt: null,
            deliveredCount: 0,
            lastDeliveryAttemptAt: null,
            lastDeliveryError: null,
            lastResult: null,
          },
        },
        pendingActionsById: {
          'checkin-61': {
            action: 'checkin',
            actionId: 'checkin-61',
            workflowId: 'workflow-61',
            tabId: 61,
            status: 'pending',
            deliveredAt: null,
            deliveredCount: 0,
            lastDeliveryAttemptAt: null,
            lastDeliveryError: null,
            lastResult: null,
          },
        },
        workflowsById: {
          'workflow-61': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [61],
            checkinActionId: 'checkin-61',
            questionActionId: null,
          },
        },
        activeWorkflowId: 'workflow-61',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };
  const harness = makeHarness({
    store,
    tabs: [{ id: 61, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  const response = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'pending checkin workflow should resume instead of failing');
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')).length, 0);
  const checkinTabId = response.payload.tabId;
  const checkinActionId = store.session[runtimeKey].actionsByTabId[String(checkinTabId)].actionId;
  const result = await harness.send('ACTION_RESULT', { actionId: checkinActionId, action: 'checkin', status: 'success' }, { tab: { id: checkinTabId } });
  await flush();
  assert.equal(result.ok, true);
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')).length, 1);
  const questionActions = Object.values(store.session[runtimeKey].actionsByTabId).filter((record) => record?.action === 'question');
  assert.equal(questionActions.length, 1);
}

console.log('service worker recovery tests passed.');
