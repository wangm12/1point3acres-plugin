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
const actionIndicatorSource = read('../src/shared/action-indicator.js');
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

const makeHarness = ({ session = {}, local = {}, tabs = [], removeMode = 'normal', tabsGetMode = {}, sendMessageImpl = null, tabsCreateFails = false } = {}) => {
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
      create: async ({ url, active }) => {
        if (tabsCreateFails) throw new Error('tabs-create-unavailable');
        const tab = { id: nextTabId++, url, active: active === true };
        tabMap.set(tab.id, tab);
        events.push(['tabs.create', tab.id, url]);
        return { ...tab };
      },
      reload: async (tabId) => { events.push(['tabs.reload', tabId]); },
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
      sendMessage: async (tabId, message) => {
        events.push(['tabs.sendMessage', tabId, message.type, message.payload]);
        if (typeof sendMessageImpl === 'function') return sendMessageImpl(tabId, message);
        return { ok: true, accepted: true, actionId: message.payload.actionId };
      },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
    },
    alarms: {
      create: async (name, info) => { alarms.set(name, { name, ...info }); },
      clear: async (name) => { alarms.delete(name); return true; },
      get: async (name) => alarms.get(name) || null,
      getAll: async () => [...alarms.values()],
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
    },
    action: {
      setIcon: async (details) => { events.push(['action.setIcon', details]); },
      setBadgeText: async (details) => { events.push(['action.setBadgeText', details]); },
      setBadgeBackgroundColor: async (details) => { events.push(['action.setBadgeBackgroundColor', details]); },
      setBadgeTextColor: async (details) => { events.push(['action.setBadgeTextColor', details]); },
      setTitle: async (details) => { events.push(['action.setTitle', details]); },
    },
    notifications: { create: async (opts) => { events.push(['notifications.create', opts]); return 'n1'; } },
  };
  const context = { globalThis: {}, console, crypto: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() }, fetch: async () => ({ ok: true, json: async () => ({ entries: [] }) }), chrome };
  vm.createContext(context);
  context.globalThis = context;
  context.importScripts = (...files) => files.forEach((file) => {
    const source = file === 'shared/protocol.js' ? protocolSource
      : file === 'shared/question-matcher.js' ? questionMatcherSource
      : file === 'shared/learned-answers.js' ? learnedAnswersSource
      : file === 'shared/action-indicator.js' ? actionIndicatorSource
      : null;
    if (!source) throw new Error(`unknown importScripts: ${file}`);
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
  assert.equal(h.events.filter((e) => e[0] === 'tabs.sendMessage' && e[1] === 999).length, 0);
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
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === questionUrl).length, 0, 'standalone check-in must never chain into a question tab');
  assert.equal(h.tabMap.has(42), true, 'a reused user tab must remain open after standalone check-in');
}

{
  const h = makeHarness({ tabs: [{ id: 44, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const checkinRun = runtime(h).run;
  await h.send('ACTION_RESULT', { actionId: checkinRun.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: checkinRun.currentTabId } });
  await flush();
  assert.equal(runtime(h).run.stage, 'checkin');
  assert.equal(runtime(h).run.status, 'paused');
  await h.send('RUN_ONE_CLICK', { action: 'question' });
  assert.equal(runtime(h).run.stage, 'question', 'a later standalone question request must not be swallowed by a paused check-in run');
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === questionUrl).length, 1);
  assert.equal(h.tabMap.has(44), true, 'switching standalone stages must preserve the completed user tab');
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
  assert.equal(after, before, 'standalone question must not mutate a reused user tab');
  assert.equal(h.tabMap.has(91), true);
}

{
  const h = makeHarness({ tabs: [{ id: 51, url: questionUrl, active: true }, { id: 52, url: checkinUrl, active: false }] });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.tabMap.has(52), true, 'startup must not close an unowned inactive task tab');
  assert.equal(h.tabMap.has(51), true);
}

{
  const h = makeHarness({ tabs: [{ id: 61, url: questionUrl, active: true }, { id: 62, url: checkinUrl, active: false }] });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.tabMap.has(62), true, 'cleanup must not remove a task tab without an explicit success record');
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
  assert.equal(h.tabMap.has(99), true, 'cross-day reconciliation must leave an unowned tab untouched');
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
  assert.equal(h.tabMap.has(99), true, 'cross-day question cleanup must leave the task tab untouched');
}

{
  const h = makeHarness({
    session: { [runtimeKey]: { version: 2, run: { runId: 'old-alarm-run', laDateKey: staleDateKey, source: 'manual', stage: 'question', status: 'running', transition: null, lease: null, attempt: 1, currentTabId: 101, originActiveTabId: null, currentActionId: 'old-action', lastError: null, events: [] }, actionsByTabId: {}, awaitingContentByTabId: {}, pendingActionsById: {}, workflowsById: {}, activeWorkflowId: null } },
    tabs: [{ id: 101, url: questionUrl, active: false }],
  });
  h.alarms.set('p3a-runtime-finalize:old-action', { name: 'p3a-runtime-finalize:old-action', when: Date.now() });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.alarms.has('p3a-runtime-finalize:old-action'), false, 'cross-day runtime finalization alarm must be cleared');
}

{
  const h = makeHarness({
    local: {
      [autoKey]: {
        enabled: true,
        plan: { dateKey: staleDateKey, nextRunAt: Date.now() - 1000, scheduledAt: Date.now() - 2000, alarmName: 'p3a-auto-schedule' },
      },
    },
  });
  h.alarms.set('p3a-auto-schedule', { name: 'p3a-auto-schedule', when: Date.now() });
  h.alarms.set(`p3a-auto-retry:${staleDateKey}`, { name: `p3a-auto-retry:${staleDateKey}`, when: Date.now() });
  await h.send('AUTO_SCHEDULE_GET');
  assert.equal(h.alarms.has('p3a-auto-schedule'), false, 'stale auto plan alarm must be cleared');
  assert.equal(h.alarms.has(`p3a-auto-retry:${staleDateKey}`), false, 'stale auto retry alarm must be cleared');
}

{
  const h = makeHarness({
    local: {
      [autoKey]: {
        enabled: true,
        plan: { dateKey: todayDateKey, nextRunAt: Date.now() - 1000, scheduledAt: Date.now() - 2000, alarmName: 'p3a-auto-schedule' },
        lastRunDateKey: todayDateKey,
        lastRunStatus: 'completed',
      },
    },
  });
  await h.send('AUTO_SCHEDULE_GET');
  assert.equal(h.alarms.size, 0, 'completed auto plan must not be re-scheduled by a state read');
}

{
  const h = makeHarness({
    local: {
      [autoKey]: {
        enabled: true,
        activeRunDateKey: todayDateKey,
        lastRunStatus: 'started',
        plan: { dateKey: todayDateKey, nextRunAt: Date.now() - 1000, scheduledAt: Date.now() - 2000, alarmName: 'p3a-auto-schedule' },
      },
    },
    tabs: [{ id: 71, url: checkinUrl, active: false }],
  });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.tabMap.has(71), true, 'auto startup recovery must preserve an unrelated inactive task tab');
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === checkinUrl).length, 1, 'auto startup recovery must create its own managed task tab');
  assert.notEqual(runtime(h).run.currentTabId, 71, 'auto startup recovery must not adopt the unrelated inactive tab');
}

{
  const slashUrl = `${checkinUrl}/`;
  const h = makeHarness({ tabs: [{ id: 201, url: slashUrl, active: true }] });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  assert.equal(runtime(h).run.currentTabId, 201, 'trailing-slash check-in URL must be reused instead of opening a duplicate tab');
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && String(e[2]).includes('daily-checkin')).length, 0);
}

{
  const h = makeHarness({ tabs: [{ id: 202, url: 'https://1point3acres.com/next/daily-checkin', active: true }] });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  assert.equal(runtime(h).run.currentTabId, 202, 'apex host check-in URL must be reused');
}

{
  const h = makeHarness();
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  const tabId = runtime(h).run.currentTabId;
  const tab = h.tabMap.get(tabId);
  tab.url = `${checkinUrl}/`;
  await h.send('ACTION_RESULT', { actionId: runtime(h).run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: tabId } });
  await flush();
  assert.equal(h.tabMap.has(tabId), false, 'everything check-in success must close a tab after it redirects to a trailing-slash URL');
}

{
  const h = makeHarness({ tabs: [{ id: 211, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('ACTION_RESULT', { actionId: runtime(h).run.currentActionId, action: 'checkin', status: 'failed', reason: 'timeout' }, { tab: { id: tabId } });
  await flush();
  assert.equal(runtime(h).run.status, 'paused', 'timeout must pause the run so the popup can retry');
  assert.equal(runtime(h).run.lastError, 'timeout');
}

{
  const h = makeHarness({ tabs: [{ id: 221, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  await h.send('ACTION_RESULT', {
    actionId: runtime(h).run.currentActionId,
    action: 'checkin',
    status: 'failed',
    reason: 'captcha-required',
  }, { tab: { id: runtime(h).run.currentTabId } });
  await flush();
  assert.equal(runtime(h).run.mode, 'checkin');
  assert.equal(runtime(h).run.status, 'paused');
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(runtime(h).run.mode, 'everything', '一键 must upgrade a live standalone check-in run');
  await h.send('ACTION_RESULT', {
    actionId: runtime(h).run.currentActionId,
    action: 'checkin',
    status: 'success',
  }, { tab: { id: runtime(h).run.currentTabId } });
  await flush();
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create' && e[2] === questionUrl).length, 1, 'upgraded everything run must chain into the question tab');
}

{
  const h = makeHarness();
  await h.send('RUN_ONE_CLICK', { action: 'question' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('ACTION_RESULT', { actionId: runtime(h).run.currentActionId, action: 'question', status: 'success' }, { tab: { id: tabId } });
  await flush();
  const notes = h.events.filter((e) => e[0] === 'notifications.create').map((e) => e[1]?.message);
  assert.equal(notes.includes('答题完成'), true, 'standalone question success must notify 答题完成');
  assert.equal(notes.includes('签到和答题完成'), false, 'standalone question success must not claim check-in finished');
}

{
  const h = makeHarness({
    local: {
      [autoKey]: {
        enabled: true,
        plan: { dateKey: todayDateKey, nextRunAt: Date.now() - 1000, scheduledAt: Date.now() - 2000, alarmName: 'p3a-auto-schedule' },
      },
    },
    tabs: [{ id: 231, url: checkinUrl, active: false }],
  });
  h.listeners.alarm?.({ name: 'p3a-auto-schedule' });
  await flush();
  await flush();
  assert.equal(h.local[autoKey].lastRunStatus, 'started');
  const createsAfterFirst = h.events.filter((e) => e[0] === 'tabs.create').length;
  h.listeners.alarm?.({ name: 'p3a-auto-schedule' });
  await flush();
  await flush();
  assert.equal(h.local[autoKey].lastRunStatus, 'started', 'an in-flight auto run must not be consumed again');
  assert.equal(h.events.filter((e) => e[0] === 'tabs.create').length, createsAfterFirst, 'a second auto alarm must not open another task tab');
}

{
  const h = makeHarness({
    tabs: [{ id: 241, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(h.events.some((event) => event[0] === 'tabs.reload' && event[1] === 241), true, 'failed delivery to a reused tab must reload it');
  assert.equal(runtime(h).run.currentTabId, 241, 'reload recovery must keep the reused tab until CONTENT_READY');
  assert.notEqual(runtime(h).run.status, 'paused', 'reload recovery must not pause before CONTENT_READY');
  await h.send('CONTENT_READY', { pageState: 'active' }, { tab: { id: 241 } });
  await flush();
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length, 1, 'reload plus failed redelivery must open an extension-owned check-in tab');
  assert.notEqual(runtime(h).run.currentTabId, 241, 'failed reused tab must be abandoned after reload recovery fails');
  assert.equal(runtime(h).run.status, 'running', 'owned fallback tab must keep the run alive for CONTENT_READY');
}

{
  const h = makeHarness({ tabs: [{ id: 251, url: checkinUrl, active: true }] });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  assert.equal(runtime(h).run.currentTabId, 251, 'successful delivery must keep reusing the active check-in tab');
  assert.equal(h.events.filter((event) => event[0] === 'tabs.reload').length, 0, 'successful reuse must not reload the tab');
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create').length, 0, 'successful reuse must not open a duplicate check-in tab');
}

{
  const h = makeHarness({
    tabs: [{ id: 271, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
    tabsCreateFails: true,
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  await h.send('CONTENT_READY', { pageState: 'active' }, { tab: { id: 271 } });
  await flush();
  assert.equal(runtime(h).run.status, 'paused', 'reload and create both failing must pause the run');
  assert.equal(runtime(h).run.lastError, 'content-script-unavailable');
}

{
  const h = makeHarness({
    local: {
      'p3a-daily-status-v1': {
        dateKey: todayDateKey,
        checkin: { completed: true, at: 1 },
        question: { completed: false, at: null },
      },
    },
    tabs: [{ id: 261, url: questionUrl, active: true }],
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && String(event[2]).includes('daily-checkin')).length, 0, 'already-completed check-in must not open a hidden check-in tab');
  assert.equal(runtime(h).run.stage, 'question', 'already-completed check-in must start the question stage');
  assert.equal(runtime(h).run.currentTabId, 261, 'already-completed check-in must reuse the active question tab');
}


{
  const h = makeHarness({
    tabs: [{ id: 281, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(runtime(h).actionsByTabId?.['281']?.reloadAttempted, true, 'failed reuse delivery must set reloadAttempted');
  assert.equal(h.events.filter((event) => event[0] === 'tabs.reload' && event[1] === 281).length, 1, 'first failed reuse delivery must reload once');
  runtime(h).run.currentTabId = null;
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(
    h.events.filter((event) => event[0] === 'tabs.reload' && event[1] === 281).length,
    1,
    'rebuilding the action record must keep reloadAttempted true so recovery does not reload again',
  );
  assert.equal(
    h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length,
    1,
    'preserved reloadAttempted must abandon the reused tab instead of reloading again',
  );
}

{
  const h = makeHarness({
    local: {
      'p3a-daily-status-v1': {
        dateKey: todayDateKey,
        checkin: { completed: true, at: 1 },
        question: { completed: false, at: null },
      },
    },
    tabs: [{ id: 291, url: questionUrl, active: true }],
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const firstActionId = runtime(h).run.currentActionId;
  const firstQuestionSends = h.events.filter((event) => event[0] === 'tabs.sendMessage' && event[2] === 'RUN_ONE_CLICK' && event[3]?.action === 'question');
  assert.equal(typeof firstActionId, 'string');
  assert.equal(firstActionId.length > 0, true);
  assert.equal(firstQuestionSends.length >= 1, true, 'first everything click must deliver the question action');
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(runtime(h).run.currentActionId, firstActionId, 'second everything click must reuse the in-flight question actionId');
  const questionSends = h.events.filter((event) => event[0] === 'tabs.sendMessage' && event[2] === 'RUN_ONE_CLICK' && event[3]?.action === 'question');
  const questionActionIds = [...new Set(questionSends.map((event) => event[3]?.actionId).filter(Boolean))];
  assert.equal(questionActionIds.length, 1, 'must not send a second question RUN_ONE_CLICK with a different actionId');
  assert.equal(questionActionIds[0], firstActionId);
  assert.equal(questionSends.length, firstQuestionSends.length, 'already-delivered in-flight action must not be delivered again');
}

{
  const h = makeHarness({
    local: {
      'p3a-daily-status-v1': {
        dateKey: todayDateKey,
        checkin: { completed: true, at: 1 },
        question: { completed: false, at: null },
      },
    },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const tabId = runtime(h).run.currentTabId;
  const firstRecord = runtime(h).actionsByTabId[String(tabId)];
  assert.equal(firstRecord?.createdByExtension, true);
  assert.equal(firstRecord?.reusedExistingTab, false, 'new owned question tab must not be marked reused');
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const reused = runtime(h).actionsByTabId[String(tabId)];
  assert.equal(runtime(h).run.currentTabId, tabId, 'second everything click must reuse the owned question tab');
  assert.equal(reused?.createdByExtension, true);
  assert.equal(reused?.reusedExistingTab, false, 'reusing an owned not-reused question tab must keep reusedExistingTab false');
}

{
  const h = makeHarness({
    local: {
      'p3a-daily-status-v1': {
        dateKey: todayDateKey,
        checkin: { completed: false, at: null },
        question: { completed: false, at: null },
      },
    },
    tabs: [{ id: 262, url: questionUrl, active: true }],
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && String(event[2]).includes('daily-checkin')).length, 0, 'active question tab must skip check-in even when dailyStatus.checkin.completed is false');
  assert.equal(runtime(h).run.stage, 'question', 'active question tab must start the question stage without a completed check-in flag');
  assert.equal(runtime(h).run.currentTabId, 262, 'active question tab must be reused for the question stage');
}

{
  const h = makeHarness({
    local: {
      'p3a-daily-status-v1': {
        dateKey: todayDateKey,
        checkin: { completed: true, at: 1 },
        question: { completed: false, at: null },
      },
    },
    tabs: [{ id: 263, url: checkinUrl, active: true }],
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(runtime(h).run.stage, 'checkin', 'live check-in tab must win over a completed check-in flag');
  assert.equal(runtime(h).run.currentTabId, 263, 'live check-in tab must remain the current tab');
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && String(event[2]).includes('daily-question')).length, 0, 'live check-in tab must not skip ahead to a question tab');
}

{
  const tabId = 264;
  const actionId = 'everything-checkin-264';
  const actionRecord = {
    action: 'checkin',
    actionId,
    tabId,
    status: 'pending',
    deliveredAt: Date.now(),
    deliveredCount: 1,
    lastDeliveryError: null,
    createdByExtension: true,
    reusedExistingTab: false,
    reloadAttempted: false,
  };
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
          runId: 'run-264',
          laDateKey: todayDateKey,
          mode: 'everything',
          source: 'manual',
          stage: 'checkin',
          status: 'running',
          transition: 'running',
          lease: { owner: 'coordinator', acquiredAt: 1 },
          attempt: 1,
          currentTabId: tabId,
          originActiveTabId: null,
          currentActionId: actionId,
          lastError: null,
          events: [],
        },
        actionsByTabId: { [String(tabId)]: { ...actionRecord } },
        awaitingContentByTabId: {},
        pendingActionsById: { [actionId]: { ...actionRecord } },
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    tabs: [
      { id: 266, url: questionUrl, active: true },
      { id: tabId, url: checkinUrl, active: false },
    ],
  });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  await flush();
  assert.equal(runtime(h).run.stage, 'checkin', 'standalone check-in must not inherit everything skip-to-question while a check-in stage is live');
  assert.equal(runtime(h).run.currentTabId, tabId, 'standalone check-in must keep the live check-in tab');
}

{
  const scheduledAt = Date.now();
  const h = makeHarness({
    tabs: [{ id: 284, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(h.events.some((event) => event[0] === 'tabs.reload' && event[1] === 284), true, 'failed delivery to a reused tab must reload it');
  const reuseReloadAlarm = [...h.alarms.values()].find((alarm) => typeof alarm.name === 'string' && alarm.name.startsWith('p3a-reuse-reload:'));
  assert.ok(reuseReloadAlarm, 'successful reload must schedule a reuse-reload timeout alarm');
  assert.equal(reuseReloadAlarm.name, 'p3a-reuse-reload:284');
  assert.equal(reuseReloadAlarm.when >= scheduledAt + 8000, true, 'reuse-reload timeout must be 8000ms');
  assert.equal(reuseReloadAlarm.when <= Date.now() + 8000, true, 'reuse-reload timeout must not be scheduled farther than 8000ms');
  assert.equal(runtime(h).run.currentTabId, 284, 'reload recovery must keep the reused tab until the timeout fires');
  await h.listeners.alarm?.({ name: reuseReloadAlarm.name });
  await flush();
  await flush();
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length, 1, 'reuse-reload timeout must open an extension-owned check-in tab');
  assert.notEqual(runtime(h).run.currentTabId, 284, 'timeout must abandon the dead reused tab');
  assert.equal(runtime(h).run.status, 'running', 'owned fallback tab must keep the run alive');
  assert.equal(h.alarms.has('p3a-reuse-reload:284'), false, 'abandoning the reused tab must clear the reuse-reload alarm');
  const createsAfterTimeout = h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length;
  await h.listeners.alarm?.({ name: 'p3a-reuse-reload:284' });
  await flush();
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length, createsAfterTimeout, 'a later reuse-reload alarm must no-op after the run moved on');
}

{
  const h = makeHarness({
    tabs: [{ id: 285, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
    tabsCreateFails: true,
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const reuseReloadAlarm = [...h.alarms.values()].find((alarm) => typeof alarm.name === 'string' && alarm.name.startsWith('p3a-reuse-reload:'));
  assert.ok(reuseReloadAlarm, 'successful reload must schedule a reuse-reload timeout even if later create will fail');
  await h.listeners.alarm?.({ name: reuseReloadAlarm.name });
  await flush();
  await flush();
  assert.equal(runtime(h).run.status, 'paused', 'timeout create failure must pause the run');
  assert.equal(runtime(h).run.lastError, 'content-script-unavailable');
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create').length, 0, 'a failed fallback create must not leave a new owned tab');
}

{
  const h = makeHarness({
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const ownedTabId = runtime(h).run.currentTabId;
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  await flush();
  assert.equal(Number.isInteger(ownedTabId), true);
  assert.equal(h.events.filter((event) => event[0] === 'tabs.reload').length, 0, 'owned non-reused tabs must not reload on failed delivery');
  assert.equal([...h.alarms.keys()].some((name) => String(name).startsWith('p3a-reuse-reload:')), false, 'owned non-reused tabs must not schedule a reuse-reload timeout');
}

{
  let failCount = 1;
  const h = makeHarness({
    tabs: [{ id: 286, url: checkinUrl, active: true }],
    sendMessageImpl: async (_tabId, message) => {
      if (failCount > 0) {
        failCount -= 1;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return { ok: true, accepted: true, actionId: message.payload.actionId };
    },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(h.alarms.has('p3a-reuse-reload:286'), true, 'failed first delivery must schedule a reuse-reload timeout');
  await h.send('CONTENT_READY', { pageState: 'active' }, { tab: { id: 286 } });
  await flush();
  assert.equal(h.alarms.has('p3a-reuse-reload:286'), false, 'successful CONTENT_READY ack must clear the reuse-reload timeout');
  const createsBefore = h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length;
  await h.listeners.alarm?.({ name: 'p3a-reuse-reload:286' });
  await flush();
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length, createsBefore, 'reuse-reload alarm must no-op after successful delivery');
  assert.equal(runtime(h).run.currentTabId, 286, 'successful delivery must keep the reused tab');
}

{
  const tabId = 287;
  const actionId = 'legacy-unowned-287';
  const actionRecord = {
    action: 'checkin',
    actionId,
    tabId,
    status: 'pending',
    deliveredAt: null,
    deliveredCount: 0,
    lastDeliveryAttemptAt: null,
    lastDeliveryError: 'sendMessage-failed',
    lastResult: null,
    createdByExtension: false,
    reusedExistingTab: false,
    reloadAttempted: false,
  };
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
          runId: 'run-287',
          laDateKey: todayDateKey,
          mode: 'checkin',
          source: 'manual',
          stage: 'checkin',
          status: 'running',
          transition: 'running',
          lease: { owner: 'coordinator', acquiredAt: 1 },
          attempt: 1,
          currentTabId: tabId,
          originActiveTabId: null,
          currentActionId: actionId,
          lastError: null,
          events: [],
        },
        actionsByTabId: { [String(tabId)]: { ...actionRecord } },
        awaitingContentByTabId: { [String(tabId)]: { ...actionRecord } },
        pendingActionsById: { [actionId]: { ...actionRecord } },
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    tabs: [{ id: tabId, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  await h.send('CONTENT_READY', { pageState: 'active' }, { tab: { id: tabId } });
  await flush();
  const reloaded = h.events.some((event) => event[0] === 'tabs.reload' && event[1] === tabId);
  const abandoned = h.events.some((event) => event[0] === 'tabs.create' && event[2] === checkinUrl);
  assert.equal(reloaded || abandoned, true, 'failed CONTENT_READY ack on createdByExtension=false without reusedExistingTab must still recover');
}

{
  const tabId = 288;
  const actionId = 'owned-not-reused-288';
  const actionRecord = {
    action: 'checkin',
    actionId,
    tabId,
    status: 'pending',
    deliveredAt: null,
    deliveredCount: 0,
    lastDeliveryAttemptAt: null,
    lastDeliveryError: 'sendMessage-failed',
    lastResult: null,
    createdByExtension: true,
    reusedExistingTab: false,
    reloadAttempted: false,
  };
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
          runId: 'run-288',
          laDateKey: todayDateKey,
          mode: 'checkin',
          source: 'manual',
          stage: 'checkin',
          status: 'running',
          transition: 'running',
          lease: { owner: 'coordinator', acquiredAt: 1 },
          attempt: 1,
          currentTabId: tabId,
          originActiveTabId: null,
          currentActionId: actionId,
          lastError: null,
          events: [],
        },
        actionsByTabId: { [String(tabId)]: { ...actionRecord } },
        awaitingContentByTabId: { [String(tabId)]: { ...actionRecord } },
        pendingActionsById: { [actionId]: { ...actionRecord } },
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    tabs: [{ id: tabId, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  await h.send('CONTENT_READY', { pageState: 'active' }, { tab: { id: tabId } });
  await flush();
  assert.equal(h.events.some((event) => event[0] === 'tabs.reload'), false, 'owned not-reused tabs must not recover on failed CONTENT_READY ack');
  assert.equal(h.events.some((event) => event[0] === 'tabs.create'), false, 'owned not-reused tabs must not abandon on failed CONTENT_READY ack');
}

{
  const reusedTabId = 301;
  const actionId = 'startup-reuse-a1';
  const actionRecord = {
    action: 'checkin',
    actionId,
    workflowId: 'wf-startup-reuse',
    tabId: reusedTabId,
    dateKey: todayDateKey,
    originActiveTabId: 300,
    status: 'pending',
    deliveredAt: null,
    deliveredCount: 1,
    lastDeliveryAttemptAt: 1,
    lastDeliveryError: 'sendMessage-failed',
    lastResult: null,
    createdByExtension: false,
    reusedExistingTab: true,
    reloadAttempted: true,
  };
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
          runId: 'startup-reuse-run',
          laDateKey: todayDateKey,
          mode: 'everything',
          source: 'manual',
          stage: 'checkin',
          status: 'running',
          transition: 'reconcile',
          lease: null,
          attempt: 1,
          currentTabId: reusedTabId,
          originActiveTabId: 300,
          currentActionId: actionId,
          lastError: null,
          events: [],
        },
        actionsByTabId: { [String(reusedTabId)]: { ...actionRecord } },
        awaitingContentByTabId: { [String(reusedTabId)]: { ...actionRecord } },
        pendingActionsById: { [actionId]: { ...actionRecord } },
        workflowsById: {
          'wf-startup-reuse': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [reusedTabId],
            checkinActionId: actionId,
          },
        },
        activeWorkflowId: 'wf-startup-reuse',
      },
    },
    tabs: [
      { id: 300, url: 'https://www.1point3acres.com/', active: false },
      { id: reusedTabId, url: checkinUrl, active: true },
    ],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  h.listeners.startup?.();
  await flush();
  assert.equal(
    h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length,
    1,
    'startup reconcile must abandon a reused check-in tab after reload already failed delivery',
  );
  assert.equal(h.events.filter((event) => event[0] === 'tabs.reload').length, 0, 'reload already attempted so startup must not reload again');
  assert.notEqual(runtime(h).run.currentTabId, reusedTabId, 'failed reused tab must be abandoned on startup reconcile');
  assert.equal(runtime(h).run.status, 'running', 'owned fallback tab must keep the run alive');
  assert.equal(h.tabMap.has(reusedTabId), true, 'abandoning a reused user tab must leave it open');
}

{
  const h = makeHarness({
    tabs: [{ id: 310, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(h.events.some((event) => event[0] === 'tabs.reload' && event[1] === 310), true, 'failed reuse delivery must reload the visible tab');
  const createsAfterReload = h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length;
  h.listeners.updated?.(310, { status: 'complete' }, { id: 310, url: checkinUrl });
  await flush();
  await flush();
  assert.equal(runtime(h).run.currentTabId, 310, 'onUpdated complete after reload must not abandon the visible reused tab');
  assert.equal(
    h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length,
    createsAfterReload,
    'onUpdated complete after reload must not open a hidden owned tab',
  );
  assert.equal(h.alarms.has('p3a-reuse-reload:310'), true, 'onUpdated complete after reload must keep the 8s reuse-reload timeout');
  h.listeners.updated?.(310, { url: checkinUrl }, { id: 310, url: checkinUrl });
  await flush();
  await flush();
  assert.equal(runtime(h).run.currentTabId, 310, 'onUpdated url after reload must not abandon the visible reused tab');
  await h.send('CONTENT_READY', { pageState: 'active' }, { tab: { id: 310 } });
  await flush();
  await flush();
  assert.notEqual(runtime(h).run.currentTabId, 310, 'a failed real CONTENT_READY ack after reload must still abandon the dead reused tab');
  assert.equal(h.events.filter((event) => event[0] === 'tabs.create' && event[2] === checkinUrl).length, createsAfterReload + 1, 'failed CONTENT_READY after reload must create an owned fallback tab');
}

{
  const h = makeHarness({
    tabs: [{ id: 370, url: checkinUrl, active: true }],
    sendMessageImpl: async (tabId, message) => {
      if (tabId === 371) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true, accepted: true, actionId: message.payload.actionId };
    },
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const checkinTabId = runtime(h).run.currentTabId;
  const checkinActionId = runtime(h).run.currentActionId;
  h.tabMap.set(371, { id: 371, url: questionUrl, active: true });
  const checkinTab = h.tabMap.get(checkinTabId);
  if (checkinTab) checkinTab.active = false;
  await h.send('ACTION_RESULT', { actionId: checkinActionId, action: 'checkin', status: 'success' }, { tab: { id: checkinTabId } });
  await flush();
  await flush();
  assert.equal(runtime(h).run.stage, 'question', 'completed everything check-in must advance to the question stage');
  const questionRecord = runtime(h).actionsByTabId?.[371] || runtime(h).awaitingContentByTabId?.[371];
  assert.equal(questionRecord?.createdByExtension, false, 'handoff must not stamp a reused user question tab as extension-owned');
  assert.equal(questionRecord?.reusedExistingTab, true, 'handoff must mark the visible question tab as reused');
  assert.equal(h.events.some((event) => event[0] === 'tabs.reload' && event[1] === 371), true, 'failed handoff delivery to an open question tab must reload it');
  assert.equal(runtime(h).run.currentTabId, 371, 'handoff reload must keep the visible question tab until timeout');
}

{
  const leftoverRecord = {
    action: 'checkin',
    actionId: 'owned-leftover-380',
    tabId: 380,
    status: 'completed',
    deliveredAt: 1,
    deliveredCount: 1,
    lastDeliveryError: null,
    createdByExtension: true,
    reusedExistingTab: false,
  };
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
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
        },
        actionsByTabId: { 380: { ...leftoverRecord } },
        awaitingContentByTabId: {},
        pendingActionsById: {},
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    tabs: [
      { id: 380, url: checkinUrl, active: false },
      { id: 381, url: checkinUrl, active: true },
    ],
  });
  await h.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(runtime(h).run.currentTabId, 381, 'everything must drive the visible check-in tab instead of an earlier owned leftover');
}

{
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
          runId: 'adopt-361',
          laDateKey: todayDateKey,
          mode: 'everything',
          source: 'manual',
          stage: 'checkin',
          status: 'running',
          transition: 'running',
          lease: { owner: 'coordinator', acquiredAt: 1 },
          attempt: 1,
          currentTabId: 360,
          originActiveTabId: null,
          currentActionId: 'adopt-action-361',
          lastError: null,
          events: [],
        },
        actionsByTabId: {},
        awaitingContentByTabId: {},
        pendingActionsById: {},
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    tabs: [{ id: 361, url: checkinUrl, active: true }],
  });
  h.listeners.startup?.();
  await flush();
  await flush();
  assert.equal(runtime(h).run.currentTabId, 361, 'reconcile must adopt the remaining same-URL tab when currentTabId is gone');
  assert.equal(
    h.events.some((event) => event[0] === 'tabs.sendMessage' && event[1] === 361),
    true,
    'reconcile adopt must deliver RUN_ONE_CLICK to the replacement tab',
  );
}

{
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
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
        },
        actionsByTabId: {},
        awaitingContentByTabId: {},
        pendingActionsById: {},
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    local: {
      [autoKey]: {
        enabled: true,
        activeRunDateKey: todayDateKey,
        lastRunStatus: 'started',
        lastRunDateKey: todayDateKey,
        plan: {
          dateKey: todayDateKey,
          nextRunAt: Date.now() - 1000,
          scheduledAt: Date.now() - 2000,
          alarmName: 'p3a-auto-schedule',
        },
      },
    },
    tabs: [{ id: 350, url: checkinUrl, active: true }],
    sendMessageImpl: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
  });
  h.listeners.startup?.();
  await flush();
  await flush();
  assert.equal(runtime(h).run.source, 'auto', 'startup must recover an in-flight auto run');
  assert.equal(h.events.some((event) => event[0] === 'tabs.reload' && event[1] === 350), true, 'auto-recover must reload a reused tab when sendMessage fails');
}

{
  const h = makeHarness({
    session: {
      [runtimeKey]: {
        version: 2,
        run: {
          runId: 'old-rollover',
          laDateKey: staleDateKey,
          source: 'manual',
          stage: 'checkin',
          status: 'running',
          transition: null,
          lease: null,
          attempt: 1,
          currentTabId: 77,
          originActiveTabId: null,
          currentActionId: 'old-rollover-action',
          lastError: null,
          events: [],
        },
        actionsByTabId: { 77: { action: 'checkin', actionId: 'old-rollover-action', tabId: 77, status: 'completed' } },
        awaitingContentByTabId: {},
        pendingActionsById: {},
        workflowsById: {},
        activeWorkflowId: null,
      },
    },
    tabs: [{ id: 77, url: checkinUrl, active: false }],
  });
  h.alarms.set('p3a-reuse-reload:77', { name: 'p3a-reuse-reload:77', when: Date.now() + 8000 });
  h.listeners.startup?.();
  await flush();
  assert.equal(h.alarms.has('p3a-reuse-reload:77'), false, 'day-rollover reconcile must clear leftover reuse-reload alarms');
}

const oneClickSends = (h, tabId) => h.events.filter((event) => (
  event[0] === 'tabs.sendMessage'
  && event[2] === 'RUN_ONE_CLICK'
  && (tabId == null || event[1] === tabId)
));

{
  const h = makeHarness({ tabs: [{ id: 401, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('CONTENT_READY', { pageState: 'active', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  const firstActionId = runtime(h).run.currentActionId;
  const sendsBeforePause = oneClickSends(h, tabId).length;
  await h.send('ACTION_RESULT', {
    actionId: firstActionId,
    action: 'checkin',
    status: 'failed',
    reason: 'captcha-required',
    resumeMode: 'replay',
  }, { tab: { id: tabId } });
  await flush();
  assert.equal(runtime(h).run.status, 'paused');
  assert.equal(oneClickSends(h, tabId).length, sendsBeforePause, 'captcha pause without active pageState must not refresh');
  await h.send('CONTENT_READY', { pageState: 'active', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  assert.notEqual(runtime(h).run.currentActionId, firstActionId, 'active after pre-submit captcha must mint a new actionId');
  assert.equal(oneClickSends(h, tabId).length, sendsBeforePause + 1, 'active after pre-submit captcha must send RUN_ONE_CLICK again');
  assert.equal(oneClickSends(h, tabId).at(-1)[3].resumeMode, 'replay');
}

{
  const h = makeHarness({ tabs: [{ id: 402, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('CONTENT_READY', { pageState: 'active', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  const firstActionId = runtime(h).run.currentActionId;
  const sendsBeforePause = oneClickSends(h, tabId).length;
  await h.send('ACTION_RESULT', {
    actionId: firstActionId,
    action: 'checkin',
    status: 'failed',
    reason: 'captcha-required',
    resumeMode: 'join',
  }, { tab: { id: tabId } });
  await flush();
  await h.send('CONTENT_READY', { pageState: 'active', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  assert.notEqual(runtime(h).run.currentActionId, firstActionId);
  assert.equal(oneClickSends(h, tabId).length, sendsBeforePause + 1);
  assert.equal(oneClickSends(h, tabId).at(-1)[3].resumeMode, 'join');
}

{
  const h = makeHarness({ tabs: [{ id: 403, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('CONTENT_READY', { pageState: 'active', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  const firstActionId = runtime(h).run.currentActionId;
  const sendsBefore = oneClickSends(h, tabId).length;
  await h.send('ACTION_RESULT', {
    actionId: firstActionId,
    action: 'checkin',
    status: 'failed',
    reason: 'captcha-required',
    resumeMode: 'replay',
  }, { tab: { id: tabId } });
  await flush();
  await h.send('CONTENT_READY', { pageState: 'captcha-required', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  assert.equal(runtime(h).run.currentActionId, firstActionId);
  assert.equal(oneClickSends(h, tabId).length, sendsBefore);
  await h.send('CONTENT_READY', { pageState: 'updated', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  assert.equal(runtime(h).run.currentActionId, firstActionId, 'updated must not refresh a captcha-paused run');
  assert.equal(oneClickSends(h, tabId).length, sendsBefore);
}

{
  const h = makeHarness({ tabs: [{ id: 404, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('CONTENT_READY', { pageState: 'active', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  const firstActionId = runtime(h).run.currentActionId;
  const sendsBefore = oneClickSends(h, tabId).length;
  await h.send('ACTION_RESULT', {
    actionId: firstActionId,
    action: 'checkin',
    status: 'failed',
    reason: 'captcha-required',
    resumeMode: 'replay',
  }, { tab: { id: tabId } });
  await flush();
  await h.send('CONTENT_READY', { pageState: 'completed', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  assert.equal(oneClickSends(h, tabId).length, sendsBefore, 'completed must not replay a captcha-paused submit');
  assert.equal(runtime(h).actionsByTabId[String(tabId)]?.status, 'completed');
}

{
  const h = makeHarness({ tabs: [{ id: 405, url: checkinUrl, active: false }] });
  await h.send('RUN_ONE_CLICK', { action: 'checkin' });
  const tabId = runtime(h).run.currentTabId;
  await h.send('CONTENT_READY', { pageState: 'active', pageKind: 'daily-checkin' }, { tab: { id: tabId } });
  await flush();
  const firstActionId = runtime(h).run.currentActionId;
  const sendsBefore = oneClickSends(h, tabId).length;
  await h.send('ACTION_RESULT', {
    actionId: firstActionId,
    action: 'checkin',
    status: 'failed',
    reason: 'captcha-required',
    resumeMode: 'join',
    pageState: 'active',
  }, { tab: { id: tabId } });
  await flush();
  assert.notEqual(runtime(h).run.currentActionId, firstActionId, 'ACTION_RESULT with pageState active must refresh without another CONTENT_READY');
  assert.equal(oneClickSends(h, tabId).length, sendsBefore + 1);
  assert.equal(oneClickSends(h, tabId).at(-1)[3].resumeMode, 'join');
}

{
  const lastBadge = (h) => [...h.events].reverse().find((event) => event[0] === 'action.setBadgeText')?.[1]?.text ?? null;
  const lastTitle = (h) => [...h.events].reverse().find((event) => event[0] === 'action.setTitle')?.[1]?.title ?? '';
  const running = makeHarness({ tabs: [{ id: 511, url: checkinUrl, active: false }] });
  await running.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(lastBadge(running), '…');
  assert.equal(lastTitle(running), '正在签到…');

  const blocked = makeHarness({ tabs: [{ id: 512, url: checkinUrl, active: false }] });
  await blocked.send('RUN_ONE_CLICK', { action: 'checkin' });
  await blocked.send('ACTION_RESULT', {
    actionId: runtime(blocked).run.currentActionId,
    action: 'checkin',
    status: 'failed',
    reason: 'captcha-required',
  }, { tab: { id: runtime(blocked).run.currentTabId } });
  await flush();
  assert.equal(runtime(blocked).run.status, 'paused');
  assert.equal(lastBadge(blocked), '!');
  assert.match(lastTitle(blocked), /Verify you are human/);
}

console.log('test-coordinator-lifecycle: ok');
