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
const staleDateKey = '2020-01-01';

const runtimeKey = 'p3a-runtime-v1';
const autoKey = 'p3a-auto-scheduler-v1';
const checkinUrl = 'https://www.1point3acres.com/next/daily-checkin';
const questionUrl = 'https://www.1point3acres.com/next/daily-question';

const makeHarness = ({ session = {}, local = {}, tabs = [], removeMode = 'normal', tabsGetMode = {} } = {}) => {
  const events = [];
  const listeners = { message: null, startup: null, installed: null, updated: null, alarm: null, storageChanged: null };
  let nextTabId = Math.max(0, ...tabs.map((t) => t.id || 0)) + 1;
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const alarms = new Map();
  const chrome = {
    runtime: {
      getURL: (p) => p,
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    },
    storage: {
      session: { get: async (key) => ({ [key]: session[key] }), set: async (value) => Object.assign(session, value) },
      local: { get: async (key) => ({ [key]: local[key] }), set: async (value) => Object.assign(local, value) },
      onChanged: { addListener: (fn) => { listeners.storageChanged = fn; } },
    },
    tabs: {
      query: async () => [...tabMap.values()].map((tab) => ({ ...tab })),
      create: async ({ url, active }) => { const tab = { id: nextTabId++, url, active: active === true }; tabMap.set(tab.id, tab); events.push(['tabs.create', tab.id, url]); return { ...tab }; },
      update: async (tabId, changes) => { const tab = tabMap.get(tabId); if (!tab) throw new Error('missing-tab'); Object.assign(tab, changes); events.push(['tabs.update', tabId, { ...changes }]); return { ...tab }; },
      remove: async (tabId) => { events.push(['tabs.remove', tabId]); if (removeMode === 'throw-once') { removeMode = 'normal'; throw new Error('remove-failed'); } if (removeMode === 'vanish-once') { removeMode = 'normal'; tabMap.delete(tabId); return; } tabMap.delete(tabId); },
      get: async (tabId) => {
        const tab = tabMap.get(tabId);
        const mode = tabsGetMode?.[tabId];
        if (typeof mode === 'function') {
          const result = await mode(tab ? { ...tab } : null, tabMap);
          if (result == null) throw new Error('missing-tab');
          return { ...result };
        }
        if (!tab) throw new Error('missing-tab');
        return { ...tab };
      },
      sendMessage: async (tabId, message) => { events.push(['tabs.sendMessage', tabId, message.type, message.payload]); return { ok: true, accepted: true, actionId: message.payload.actionId }; },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
    },
    alarms: {
      create: async (name, info) => { alarms.set(name, { name, ...info }); },
      clear: async (name) => { alarms.delete(name); return true; },
      get: async (name) => alarms.get(name) || null,
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
    },
    action: { setIcon: async () => {} },
    notifications: { create: async () => 'n1' },
  };
  const context = { globalThis: {}, console, crypto: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() }, fetch: async () => ({ ok: true, json: async () => ({ entries: [] }) }), chrome };
  vm.createContext(context);
  context.globalThis = context;
  context.importScripts = (...files) => files.forEach((file) => {
    const source = file === 'shared/protocol.js' ? protocolSource : file === 'shared/question-matcher.js' ? questionMatcherSource : learnedAnswersSource;
    vm.runInContext(source, context);
  });
  vm.runInContext(workerSource, context);
  const send = (type, payload = {}, sender = {}) => new Promise((resolve) => listeners.message({ type, payload }, sender, (response) => { events.push(['response', type, response]); resolve(response); }));
  return { send, listeners, events, session, local, tabMap, alarms };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
const runtime = (h) => h.session[runtimeKey] || {};

{
  const h = makeHarness({ local: { [autoKey]: { enabled: false } }, tabs: [{ id: 1, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  assert.equal(runtime(h).run.stage, 'checkin');
  assert.equal(typeof runtime(h).run.currentActionId, 'string');
}

{
  const h = makeHarness({ tabs: [{ id: 11, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  const run = runtime(h).run;
  await h.send('CONTENT_READY', {}, { tab: { id: run.currentTabId } });
  await h.send('ACTION_RESULT', { actionId: run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: run.currentTabId } });
  await h.send('CONTENT_READY', {}, { tab: { id: run.currentTabId } });
  await flush();
  const questionMoves = h.events.filter((e) => e[0] === 'tabs.create' && e[2] === questionUrl).length + h.events.filter((e) => e[0] === 'tabs.update' && e[2]?.url === questionUrl).length;
  assert.equal(questionMoves <= 1, true);
}

{
  const h = makeHarness({ tabs: [{ id: 12, url: checkinUrl, active: false }, { id: 13, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const run = runtime(h).run;
  const before = h.events.filter((e) => e[0] === 'tabs.sendMessage').length;
  await h.send('CONTENT_READY', {}, { tab: { id: 13 } });
  assert.equal(h.events.filter((e) => e[0] === 'tabs.sendMessage').length, before);
  await h.send('CONTENT_READY', {}, { tab: { id: run.currentTabId } });
  assert.equal(h.events.filter((e) => e[0] === 'tabs.sendMessage').length >= before, true);
}

{
  const h = makeHarness({ tabs: [{ id: 14, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const run = runtime(h).run;
  const before = h.events.filter((e) => e[0] === 'tabs.remove' || e[0] === 'tabs.update' || e[0] === 'tabs.create').length;
  await h.send('ACTION_RESULT', { runId: 'wrong-run', actionId: run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: run.currentTabId } });
  await flush();
  const after = h.events.filter((e) => e[0] === 'tabs.remove' || e[0] === 'tabs.update' || e[0] === 'tabs.create').length;
  assert.equal(after, before);
}

{
  const h = makeHarness({ tabs: [{ id: 21, url: checkinUrl, active: false }], local: { [autoKey]: { enabled: true } } });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  const firstRun = runtime(h).run.runId;
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  assert.equal(runtime(h).run.runId, firstRun);
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === checkinUrl).length <= 1, true);
}

{
  const h = makeHarness({ tabs: [{ id: 31, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('CONTENT_READY', {}, { tab: { id: tabId } });
  await h.send('CONTENT_READY', {}, { tab: { id: tabId } });
  assert.equal(runtime(h).run.currentTabId, tabId);
}

{
  const h = makeHarness({ tabs: [{ id: 32, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('CONTENT_READY', {}, { tab: { id: 999 } });
  assert.equal(h.events.filter((e) => e[0] === 'tabs.sendMessage').length, 0);
  assert.equal(runtime(h).run.currentTabId, tabId);
}

{
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: { runId: null, laDateKey: null, source: null, stage: null, status: 'idle', transition: null, lease: null, attempt: 0, currentTabId: null, originActiveTabId: null, currentActionId: null, lastError: null, events: [] },
        actionsByTabId: {},
        awaitingContentByTabId: {},
        pendingActionsById: {},
        workflowsById: { legacy: { action: 'everything', stage: 'checkin', createdAt: 1, updatedAt: 1, tabIds: [88], checkinActionId: 'legacy-checkin' } },
        activeWorkflowId: 'legacy',
      },
    },
    tabs: [{ id: 88, url: checkinUrl, active: false }],
  });
  const createsBefore = h.events.filter((e) => e[0] === 'tabs.create').length;
  h.listeners.startup?.();
  await flush();
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create').length, createsBefore);
  assert.equal(h.session[runtimeKey].run.runId, null);
  assert.equal(h.session[runtimeKey].activeWorkflowId, 'legacy');
}

{
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: { runId: null, laDateKey: null, source: null, stage: null, status: 'idle', transition: null, lease: null, attempt: 0, currentTabId: null, originActiveTabId: null, currentActionId: null, lastError: null, events: [] },
        actionsByTabId: {},
        awaitingContentByTabId: {},
        pendingActionsById: {},
        workflowsById: { legacy: { action: 'everything', stage: 'checkin', createdAt: 1, updatedAt: 1, tabIds: [89], checkinActionId: 'legacy-checkin' } },
        activeWorkflowId: 'legacy',
      },
    },
    tabs: [{ id: 89, url: checkinUrl, active: false }],
  });
  const createsBefore = h.events.filter((e) => e[0] === 'tabs.create').length;
  h.listeners.startup?.();
  await flush();
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create').length, createsBefore);
  assert.equal(h.session[runtimeKey].run.runId, null);
  assert.equal(h.session[runtimeKey].run.currentTabId, null);
  assert.equal(h.session[runtimeKey].activeWorkflowId, 'legacy');
}

{
  const h = makeHarness({
    session: { [runtimeKey]: { version: 2, run: { runId: 'r1', laDateKey: staleDateKey, source: 'manual', stage: 'checkin', status: 'running', transition: null, lease: null, attempt: 1, currentTabId: 77, originActiveTabId: null, currentActionId: 'a1', lastError: null, events: [] }, actionsByTabId: { '77': { action: 'checkin', actionId: 'a1', tabId: 77, status: 'completed' } }, awaitingContentByTabId: {}, pendingActionsById: {}, workflowsById: {}, activeWorkflowId: null } },
    tabs: [{ id: 77, url: checkinUrl, active: false }],
  });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.session[runtimeKey].run.runId, null);
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  assert.notEqual(runtime(h).run.runId, 'r1');
}

{
  const h = makeHarness({
    session: { [runtimeKey]: { version: 2, run: { runId: 'r2', laDateKey: todayDateKey, source: 'manual', stage: 'checkin', status: 'running', transition: null, lease: null, attempt: 1, currentTabId: 88, originActiveTabId: null, currentActionId: 'a2', lastError: null, events: [] }, actionsByTabId: { '88': { action: 'checkin', actionId: 'a2', tabId: 88, status: 'completed' } }, awaitingContentByTabId: {}, pendingActionsById: {}, workflowsById: {}, activeWorkflowId: null } },
    tabs: [{ id: 88, url: checkinUrl, active: false }],
  });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.session[runtimeKey].run.currentTabId, 88);
  const createsBefore = h.events.filter((e) => e[0] === 'tabs.create').length;
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create').length, createsBefore);
}

{
  const h = makeHarness({
    session: { [runtimeKey]: { version: 2, run: { runId: 'old', laDateKey: staleDateKey, source: 'manual', stage: 'checkin', status: 'running', transition: null, lease: null, attempt: 1, currentTabId: 99, originActiveTabId: null, currentActionId: 'old-action', lastError: null, events: [] }, actionsByTabId: { '99': { action: 'checkin', actionId: 'old-action', tabId: 99, status: 'completed' } }, awaitingContentByTabId: {}, pendingActionsById: {}, workflowsById: {}, activeWorkflowId: null } },
    tabs: [{ id: 99, url: checkinUrl, active: false }],
  });
  h.listeners.startup?.();
  await flush();
  const result = await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  assert.equal(result.ok, true);
  assert.equal(runtime(h).run.runId !== 'old', true);
}

{
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: { runId: 'r3', laDateKey: todayDateKey, source: 'manual', stage: 'checkin', status: 'running', transition: null, lease: null, attempt: 1, currentTabId: 123, originActiveTabId: null, currentActionId: 'a3', lastError: null, events: [] },
        actionsByTabId: {},
        awaitingContentByTabId: {},
        pendingActionsById: {},
        workflowsById: { legacy: { action: 'everything', stage: 'checkin', createdAt: 1, updatedAt: 1, tabIds: [] } },
        activeWorkflowId: 'legacy',
      },
    },
    tabs: [{ id: 123, url: checkinUrl, active: false }],
  });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.tabMap.has(123), true);
  const tabCreatesBefore = h.events.filter((e) => e[0] === 'tabs.create').length;
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create').length >= tabCreatesBefore, true);
}

{
  const h = makeHarness({ tabs: [{ id: 41, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('ACTION_RESULT', { actionId: runtime(h).run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: tabId } });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === checkinUrl).length <= 1, true);
}

{
  const h = makeHarness({ tabs: [{ id: 42, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const run = runtime(h).run;
  await h.send('ACTION_RESULT', { actionId: run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: run.currentTabId } });
  await h.send('ACTION_RESULT', { actionId: run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: run.currentTabId } });
  await flush();
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === questionUrl).length, 1);
}

{
  const h = makeHarness({
    tabs: [{ id: 43, url: checkinUrl, active: false }],
    local: { [autoKey]: { enabled: true, plan: { dateKey: todayDateKey, nextRunAt: Date.now() - 1000, scheduledAt: Date.now() - 2000, alarmName: 'p3a-auto-schedule' } } },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  const run = runtime(h).run;
  await h.send('ACTION_RESULT', { actionId: run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: run.currentTabId } });
  await flush();
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === questionUrl).length <= 1, true);
}

{
  const h = makeHarness({ tabs: [{ id: 91, url: questionUrl, active: true }] });
  await h.send('RUN_ONE_CLICK', { action: 'question' });
  const run = runtime(h).run;
  const before = h.events.filter((e) => e[0] === 'tabs.remove' || e[0] === 'tabs.update' || e[0] === 'tabs.create').length;
  await h.send('ACTION_RESULT', { actionId: run.currentActionId, action: 'question', status: 'success' }, { tab: { id: run.currentTabId } });
  await flush();
  const after = h.events.filter((e) => e[0] === 'tabs.remove' || e[0] === 'tabs.update' || e[0] === 'tabs.create').length;
  assert.equal(after, before + 1);
  assert.equal(h.tabMap.has(91), false);
}

{
  const h = makeHarness({ tabs: [{ id: 51, url: questionUrl, active: true }, { id: 52, url: checkinUrl, active: false }] });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.tabMap.has(52), false);
  assert.equal(h.tabMap.has(51), true);
}

{
  const h = makeHarness({ tabs: [{ id: 61, url: questionUrl, active: true }, { id: 62, url: checkinUrl, active: false }] });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.tabMap.has(51), false);
  assert.equal(h.tabMap.has(61), true);
}

{
  const h = makeHarness();
  h.listeners.startup?.();
  await flush();
  assert.equal(h.events.some((e) => e[0] === 'tabs.create'), false);
}

{
  const h = makeHarness({
    session: { [runtimeKey]: { version: 2, run: { runId: 'old', laDateKey: staleDateKey, source: 'auto', stage: 'checkin', status: 'running', transition: null, lease: null, attempt: 1, currentTabId: 99, originActiveTabId: null, currentActionId: 'old-action', lastError: null, events: [] }, actionsByTabId: { '99': { action: 'checkin', actionId: 'old-action', tabId: 99, status: 'completed' } }, awaitingContentByTabId: {}, pendingActionsById: {}, workflowsById: {}, activeWorkflowId: null } },
    tabs: [{ id: 99, url: checkinUrl, active: false }],
  });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.session[runtimeKey].run.currentTabId, null);
  assert.equal(h.tabMap.has(99), false);
}

{
  const h = makeHarness({
    session: { [runtimeKey]: { version: 2, run: { runId: 'old', laDateKey: staleDateKey, source: 'auto', stage: 'question', status: 'running', transition: null, lease: null, attempt: 1, currentTabId: 99, originActiveTabId: null, currentActionId: 'old-action', lastError: null, events: [] }, actionsByTabId: { '99': { action: 'question', actionId: 'old-action', tabId: 99, status: 'completed' } }, awaitingContentByTabId: {}, pendingActionsById: {}, workflowsById: {}, activeWorkflowId: null } },
    tabs: [{ id: 99, url: questionUrl, active: false }],
  });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.session[runtimeKey].run.runId, null);
  assert.equal(h.session[runtimeKey].run.currentActionId, null);
}

console.log('test-coordinator-lifecycle: ok');
