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

const getLosAngelesDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};
const todayDateKey = getLosAngelesDateKey();
const nextDayDateKey = (() => {
  const [year, month, day] = todayDateKey.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + 1);
  return utc.toISOString().slice(0, 10);
})();

const runtimeKey = 'p3a-runtime-v1';
const flush = () => new Promise((resolve) => setImmediate(resolve));

const baseRun = (overrides = {}) => ({
  runId: null,
  laDateKey: null,
  source: null,
  stage: null,
  status: 'idle',
  transition: null,
  lease: null,
  attempt: 0,
  currentTabId: null,
  originActiveTabId: null,
  currentActionId: null,
  lastError: null,
  events: [],
  ...overrides,
});

const makeHarness = ({ store, tabs = [], sendMessageMode = {}, removeMode = {}, getMode = {} }) => {
  const events = [];
  const listeners = { message: null, updated: null, startup: null, installed: null };
  let nextTabId = Math.max(0, ...tabs.map((tab) => tab.id || 0)) + 1;
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const getCounts = new Map();

  const chrome = {
    runtime: {
      getURL: (p) => p,
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
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
        if (changes.active === true) {
          for (const other of tabMap.values()) if (other.id !== tabId) other.active = false;
        }
        events.push(['tabs.update', tabId, { ...changes }]);
        return { ...tab };
      },
      remove: async (tabId) => {
        events.push(['tabs.remove', tabId]);
        const mode = removeMode[tabId] ?? removeMode.default ?? 'ok';
        if (mode === 'throw') throw new Error('remove-failed');
        tabMap.delete(tabId);
      },
      get: async (tabId) => {
        const tab = tabMap.get(tabId);
        if (!tab) throw new Error('missing-tab');
        const mode = getMode[tabId] ?? getMode.default ?? 'mirror';
        const count = (getCounts.get(tabId) || 0) + 1;
        getCounts.set(tabId, count);
        if (typeof mode === 'function') return mode(tabId, { ...tab }, count, tabMap);
        return { ...tab };
      },
      sendMessage: async (tabId, message) => {
        events.push(['tabs.sendMessage', tabId, message]);
        const mode = sendMessageMode[tabId] ?? sendMessageMode.default ?? 'ack';
        if (mode === 'throw') throw new Error('sendMessage-failed');
        if (mode === 'noack') return null;
        return { ok: true, accepted: true, actionId: message.payload.actionId };
      },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
    },
    notifications: { create: async (opts) => { events.push(['notifications.create', opts]); return 'n1'; } },
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
    const source = file === 'shared/protocol.js' ? protocolSource
      : file === 'shared/question-matcher.js' ? questionMatcherSource
      : learnedAnswersSource;
    vm.runInContext(source, context);
  });
  vm.createContext(context);
  vm.runInContext(workerSource, context);

  const send = (type, payload, sender = {}) => new Promise((resolve) => listeners.message({ type, payload }, sender, (response) => {
    events.push(['sendResponse', type, response]);
    resolve(response);
  }));

  return { events, send, listeners, tabMap, store, chrome };
};

const runStore = (session = {}, local = { 'p3a-learned-answers-v1': [] }) => ({ session, local });

{
  const store = runStore();
  const harness = makeHarness({ store, tabs: [{ id: 11, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }] });
  const [first, second] = await Promise.all([
    harness.send('RUN_ONE_CLICK', { action: 'everything' }),
    harness.send('RUN_ONE_CLICK', { action: 'everything' }),
  ]);
  await flush();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.payload.runId, second.payload.runId);
  assert.equal(harness.events.filter((e) => (e[0] === 'tabs.create' || e[0] === 'tabs.update') && String(e[1]?.url ?? e[2]?.url ?? '').includes('/daily-checkin')).length, 1);
}

{
  const store = runStore();
  const harness = makeHarness({ store, tabs: [{ id: 21, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }] });
  const open = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const checkinTabId = open.payload.tabId;
  const runId = open.payload.runId;
  const runtime = store.session[runtimeKey];
  const checkinAction = runtime.actionsByTabId[String(checkinTabId)];
  assert.equal(runtime.run.runId, runId);
  assert.equal(runtime.run.stage, 'checkin');
  assert.equal(runtime.run.currentActionId, checkinAction.actionId);
  assert.equal(checkinAction.workflowId, null);
  const result = await harness.send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success' }, { tab: { id: checkinTabId } });
  await flush();
  assert.equal(result.ok, true);
  assert.equal(store.session[runtimeKey].run.stage, 'question');
  assert.equal(store.session[runtimeKey].run.runId, runId);
  const questionTabId = harness.events.find((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question'))[1].id;
  const questionAction = store.session[runtimeKey].actionsByTabId[String(questionTabId)];
  assert.equal(questionAction.action, 'question');
  assert.equal(questionAction.workflowId, null);
  assert.notEqual(questionAction.actionId, checkinAction.actionId);
  const questionResp = await harness.send('ACTION_RESULT', { actionId: questionAction.actionId, action: 'question', status: 'success' }, { tab: { id: questionTabId } });
  await flush();
  assert.equal(questionResp.ok, true);
  assert.equal(store.session[runtimeKey].run.runId, null);
  assert.equal(store.session[runtimeKey].run.stage, null);
  assert.equal(store.session[runtimeKey].run.currentActionId, null);
  assert.equal(store.session[runtimeKey].actionsByTabId[String(questionTabId)], undefined);
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun({ runId: 'run-q', laDateKey: todayDateKey, stage: 'question', status: 'running', currentTabId: 72, currentActionId: 'q-72' }),
      actionsByTabId: { '72': { action: 'question', actionId: 'q-72', workflowId: null, tabId: 72, createdByExtension: true, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'question', status: 'success' }, finalizationPending: true } },
      awaitingContentByTabId: {},
      pendingActionsById: {},
      workflowsById: {},
      activeWorkflowId: null,
    },
  });
  const harness = makeHarness({ store, tabs: [{ id: 72, url: 'https://www.1point3acres.com/next/daily-question', active: false }] });
  await harness.listeners.startup?.();
  await flush(); await flush();
  assert.equal(harness.tabMap.has(72), false);
  assert.equal(store.session[runtimeKey].actionsByTabId['72'], undefined);
  assert.equal(store.session[runtimeKey].run.status, 'idle');
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun({ runId: 'run-q2', laDateKey: todayDateKey, stage: 'question', status: 'running', currentTabId: 73, currentActionId: 'q-73' }),
      actionsByTabId: { '73': { action: 'question', actionId: 'q-73', workflowId: null, tabId: 73, createdByExtension: true, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'question', status: 'success' }, finalizationPending: true } },
      awaitingContentByTabId: {},
      pendingActionsById: {},
      workflowsById: {},
      activeWorkflowId: null,
    },
  });
  const harness = makeHarness({ store, tabs: [{ id: 73, url: 'https://www.1point3acres.com/next/daily-question', active: false }], removeMode: { 73: 'throw' } });
  await harness.listeners.startup?.();
  await flush();
  assert.equal(harness.tabMap.has(73), true);
  assert.equal(store.session[runtimeKey].actionsByTabId['73'].finalizationPending, true);
  assert.equal(store.session[runtimeKey].run.status, 'paused');
  assert.equal(store.session[runtimeKey].run.lastError, 'remove-failed');
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun({ runId: 'run-active', laDateKey: todayDateKey, stage: 'question', status: 'running', currentTabId: 74, currentActionId: 'q-74' }),
      actionsByTabId: { '74': { action: 'question', actionId: 'q-74', workflowId: null, tabId: 74, createdByExtension: true, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'question', status: 'success' }, finalizationPending: true } },
      awaitingContentByTabId: {},
      pendingActionsById: {},
      workflowsById: {},
      activeWorkflowId: null,
    },
  });
  const harness = makeHarness({ store, tabs: [{ id: 74, url: 'https://www.1point3acres.com/next/daily-question', active: true }, { id: 274, url: 'https://example.com', active: false }] });
  await harness.listeners.startup?.();
  await flush();
  assert.equal(harness.tabMap.has(74), false);
  assert.equal(harness.events.some((e) => e[0] === 'tabs.remove' && e[1] === 74), true);
  assert.equal(harness.events.some((e) => e[0] === 'tabs.update' && e[1] === 274), false);
  assert.equal(store.session[runtimeKey].actionsByTabId['74'], undefined);
  assert.equal(store.session[runtimeKey].run.status, 'idle');
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun({ runId: 'run-c', laDateKey: todayDateKey, stage: 'checkin', status: 'running', currentTabId: 101, currentActionId: 'checkin-101' }),
      actionsByTabId: { '101': { action: 'checkin', actionId: 'checkin-101', workflowId: null, tabId: 101, createdByExtension: true, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'checkin', status: 'success' }, finalizationPending: true } },
      awaitingContentByTabId: {},
      pendingActionsById: {},
      workflowsById: {},
      activeWorkflowId: null,
    },
  });
  const harness = makeHarness({ store, tabs: [{ id: 101, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }] });
  await harness.listeners.startup?.();
  await flush();
  assert.equal(harness.tabMap.has(101), false);
  const recoveredQuestion = harness.events.find((event) => event[0] === 'tabs.create' && event[1].url.includes('/daily-question'));
  assert.ok(recoveredQuestion, 'a completed checkin recovered at startup must continue to daily question');
  assert.equal(store.session[runtimeKey].run.status, 'running');
  assert.equal(store.session[runtimeKey].run.stage, 'question');
  assert.equal(store.session[runtimeKey].run.currentTabId, recoveredQuestion[1].id);
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun({ runId: 'run-c2', laDateKey: todayDateKey, stage: 'checkin', status: 'running', currentTabId: 102, currentActionId: 'checkin-102' }),
      actionsByTabId: { '102': { action: 'checkin', actionId: 'checkin-102', workflowId: null, tabId: 102, createdByExtension: true, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'checkin', status: 'success' }, finalizationPending: true } },
      awaitingContentByTabId: {},
      pendingActionsById: {},
      workflowsById: {},
      activeWorkflowId: null,
    },
  });
  const harness = makeHarness({ store, tabs: [{ id: 102, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }, { id: 202, url: 'https://www.1point3acres.com/next/daily-question', active: false }] });
  await harness.listeners.startup?.();
  await flush();
  assert.equal(harness.tabMap.has(102), false);
  assert.equal(harness.tabMap.has(202), true, 'recovery must not close an unrelated background question tab');
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')).length, 1, 'recovery must replace stale question pages with one managed question tab');
  assert.equal(store.session[runtimeKey].run.stage, 'question');
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun({ runId: 'run-m', laDateKey: todayDateKey, stage: 'question', status: 'running', currentTabId: 103, currentActionId: 'checkin-103' }),
      actionsByTabId: { '103': { action: 'checkin', actionId: 'checkin-103', workflowId: null, tabId: 103, createdByExtension: true, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'checkin', status: 'success' }, finalizationPending: true } },
      awaitingContentByTabId: {},
      pendingActionsById: {},
      workflowsById: {},
      activeWorkflowId: null,
    },
  });
  const harness = makeHarness({ store, tabs: [] });
  await harness.listeners.startup?.();
  await flush();
  assert.equal(harness.events.some((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')), true);
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun({ runId: 'run-ack', laDateKey: todayDateKey, stage: 'checkin', status: 'running', currentTabId: 41, currentActionId: 'pending-1' }),
      actionsByTabId: { '41': { action: 'checkin', actionId: 'pending-1', workflowId: null, tabId: 41, status: 'pending', deliveredAt: null, deliveredCount: 0, lastDeliveryAttemptAt: null, lastDeliveryError: null, lastResult: null } },
      awaitingContentByTabId: { '41': { action: 'checkin', actionId: 'pending-1', workflowId: null, tabId: 41, status: 'pending', deliveredAt: null, deliveredCount: 0, lastDeliveryAttemptAt: null, lastDeliveryError: null, lastDeliveryError: null, lastResult: null } },
      pendingActionsById: { 'pending-1': { action: 'checkin', actionId: 'pending-1', workflowId: null, tabId: 41, status: 'pending', deliveredAt: null, deliveredCount: 0, lastDeliveryAttemptAt: null, lastDeliveryError: null, lastResult: null } },
      workflowsById: {},
      activeWorkflowId: null,
    },
  });
  const harness = makeHarness({ store, tabs: [{ id: 41, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }] });
  await harness.send('CONTENT_READY', { pageState: 'ready' }, { tab: { id: 41 } });
  await flush();
  assert.equal(store.session[runtimeKey].actionsByTabId['41'].deliveredAt > 0, true);
  assert.equal(store.session[runtimeKey].awaitingContentByTabId['41'].actionId, 'pending-1');
}

{
  const store = runStore();
  const harness = makeHarness({ store, tabs: [] });
  const open = await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  await flush();
  const tabId = open.payload.tabId;
  const actionId = store.session[runtimeKey].actionsByTabId[String(tabId)].actionId;
  const resp = await harness.send('ACTION_RESULT', { actionId, action: 'checkin', status: 'success' }, { tab: { id: tabId } });
  await flush();
  assert.equal(resp.ok, true);
  assert.equal(store.session[runtimeKey].run.status, 'idle', 'standalone check-in should finish without creating a question stage');
  assert.equal(store.session[runtimeKey].run.stage, null);
  assert.equal(harness.events.some((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')), false, 'standalone check-in must not create a question tab');
  assert.equal(harness.tabMap.has(tabId), false, 'an extension-created standalone check-in tab can be closed after success');
}

{
  const store = runStore({
    [runtimeKey]: {
      version: 1,
      run: baseRun(),
      actionsByTabId: {
        '71': { action: 'question', actionId: 'question-71', workflowId: 'workflow-71', tabId: 71, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'question', status: 'success' }, finalizationPending: true },
      },
      awaitingContentByTabId: {},
      pendingActionsById: {
        'question-71': { action: 'question', actionId: 'question-71', workflowId: 'workflow-71', tabId: 71, status: 'completed', deliveredAt: 1, deliveredCount: 1, lastDeliveryAttemptAt: 1, lastDeliveryError: null, lastResult: { action: 'question', status: 'success' }, finalizationPending: true },
      },
      workflowsById: { 'workflow-71': { action: 'everything', stage: 'question', createdAt: 1, updatedAt: 1, tabIds: [71], checkinActionId: 'checkin-71', questionActionId: 'question-71' } },
      activeWorkflowId: 'workflow-71',
    },
  });
  const harness = makeHarness({ store, tabs: [{ id: 71, url: 'https://www.1point3acres.com/next/daily-question', active: false }, { id: 171, url: 'https://www.1point3acres.com/next/daily-question', active: true }] });
  await harness.listeners.startup?.();
  await flush();
  assert.equal(harness.tabMap.has(71), true, 'a legacy workflow without a current run must not close tabs during startup');
  assert.equal(harness.tabMap.has(171), true);
  assert.equal(store.session[runtimeKey].actionsByTabId['71'].finalizationPending, true);
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[1].url.includes('/daily-question')).length, 0);
}





console.log('service worker recovery tests passed.');
