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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeHarness = ({ store, tabs = [], tabsGetMode = {}, tabsRemoveMode = {}, queryMode = null, alarmCreateMode = 'ok', alarmGetMode = {}, createThrowsForQuestion = false }) => {
  const events = [];
  const listeners = { message: null, updated: null, alarm: null };
  let nextTabId = Math.max(0, ...tabs.map((tab) => tab.id || 0)) + 1;
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const alarmMap = new Map();
  const firedAlarms = new Set();

  const chrome = {
    runtime: {
      getURL: (p) => p,
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
    },
    alarms: {
      create: async (name, details) => {
        if (alarmCreateMode === 'throw') throw new Error('alarm-create-failed');
        events.push(['alarms.create', name, { ...details }]);
        alarmMap.set(name, { name, ...details });
        if (!firedAlarms.has(name)) {
          firedAlarms.add(name);
          setImmediate(() => listeners.alarm?.({ name, ...details }));
        }
      },
      get: async (name) => {
        const mode = alarmGetMode[name] ?? alarmGetMode.default ?? 'mirror';
        if (mode === 'throw') throw new Error('alarm-get-failed');
        if (mode === 'missing') return null;
        const alarm = alarmMap.get(name);
        return alarm ? { ...alarm } : null;
      },
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
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
      query: async (queryInfo = {}) => {
        if (typeof queryMode === 'function') {
          const result = queryMode(queryInfo, tabMap);
          if (Array.isArray(result)) return result.map((tab) => ({ ...tab }));
        }
        return [...tabMap.values()].map((tab) => ({ ...tab }));
      },
      create: async ({ url, active }) => {
        if (createThrowsForQuestion && String(url || '').includes('/daily-question')) throw new Error('create-failed');
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
          for (const otherTab of tabMap.values()) {
            if (otherTab.id !== tabId) otherTab.active = false;
          }
        }
        events.push(['tabs.update', tabId, { ...changes }]);
        return { ...tab };
      },
      remove: async (tabId) => {
        events.push(['tabs.remove', tabId]);
        const mode = tabsRemoveMode[tabId] ?? tabsRemoveMode.default ?? 'ok';
        if (mode === 'throw') throw new Error('remove-failed');
        tabMap.delete(tabId);
      },
      get: async (tabId) => {
        let tab = tabMap.get(tabId);
        if (!tab) throw new Error('missing-tab');
        const mode = tabsGetMode[tabId] ?? tabsGetMode.default ?? null;
        if (typeof mode === 'function') {
          const next = mode({ ...tab }, tabMap);
          if (next && typeof next === 'object') {
            tabMap.set(tabId, { ...tabMap.get(tabId), ...next });
          }
          tab = tabMap.get(tabId);
        }
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
    setTimeout,
    clearTimeout,
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

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness = makeHarness({
    store,
    tabs: [{ id: 91, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });

  const response = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'workflow should start even if an unrelated daily tab already exists');
  const createdCheckin = harness.events.find((event) => event[0] === 'tabs.create' && event[1].url.includes('/daily-checkin'));
  assert.ok(createdCheckin, 'workflow must create an extension-owned checkin tab');
  assert.equal(createdCheckin[1].id === 91, false, 'workflow must not adopt an arbitrary existing daily checkin tab');
  assert.equal(createdCheckin[1].active, false, 'created checkin tab must stay inactive');
}

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
          createdByExtension: true,
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
const checkinCloseIndex = harness.events.findIndex((event) => event[0] === 'tabs.remove' && event[1] === 51);
const questionCreateIndex = harness.events.findIndex((event) => event[0] === 'tabs.create' && event[1].url.includes('/daily-question'));
assert.ok(checkinCloseIndex >= 0, 'completed checkin close event should be recorded');
assert.ok(questionCreateIndex >= 0, 'question create event should be recorded');
assert.ok(checkinCloseIndex < questionCreateIndex, 'completed checkin tab must close before question tab is created');
const questionRecord = Object.values(store.session[runtimeKey].actionsByTabId).find((record) => record?.action === 'question');
assert.ok(questionRecord, 'question action should be persisted');
assert.equal(store.session[runtimeKey].workflowsById['workflow-51'].stage, 'question', 'workflow should advance to question');
assert.equal(harness.events.filter((event) => event[0] === 'notifications.create' && event[1].message === '签到完成').length, 1, 'checkin success should notify exactly once');

const questionResp = await harness.send('ACTION_RESULT', { actionId: questionRecord.actionId, action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: questionRecord.tabId } });
await flush();
assert.equal(questionResp.ok, true, 'completed question should be accepted');
assert.equal(store.session[runtimeKey].workflowsById['workflow-51'], undefined, 'workflow should be cleared after completed question');
assert.equal(store.session[runtimeKey].activeWorkflowId, null, 'active workflow should be cleared after completed question');
assert.ok(harness.events.find((event) => event[0] === 'tabs.remove' && event[1] === questionRecord.tabId), 'completed question should close the question tab');
assert.ok(harness.events.find((event) => event[0] === 'notifications.create' && event[1].message === '签到和答题完成'), 'workflow completion should notify');

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness = makeHarness({
    store,
    tabs: [{ id: 91, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
    alarmCreateMode: 'throw',
  });

  const response = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'workflow should start even when finalize alarm later fails');
  const checkinAction = Object.values(store.session[runtimeKey].actionsByTabId).find((record) => record?.action === 'checkin');
  const checkinResult = await harness.send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success', reason: 'completed' }, { tab: { id: checkinAction.tabId } });
  await flush();
  await flush();
  assert.equal(checkinResult.ok, true, 'checkin success should still be accepted when runtime finalize alarm creation fails');
  assert.equal(checkinResult.finalizationScheduled, false, 'alarm creation failure must be surfaced in the response');
  const diagnosticsRecord = Object.values(store.session[runtimeKey].actionsByTabId).find((record) => record?.action === 'question')
    || store.session[runtimeKey].actionsByTabId['91'];
  const workflowDiagnostics = Object.values(store.session[runtimeKey].workflowsById || {})[0];
  assert.ok(
    String(diagnosticsRecord?.finalizationError || workflowDiagnostics?.finalizationError || '').includes('alarm-create-failed'),
    'alarm failure should be persisted as diagnostics',
  );
  const deliveredQuestion = harness.events.find((event) => event[0] === 'tabs.sendMessage' && event[2]?.payload?.action === 'question');
  assert.ok(deliveredQuestion, 'alarm failure fallback must still deliver the question action');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '161': {
            action: 'checkin',
            actionId: 'checkin-161',
            workflowId: 'workflow-161',
            tabId: 161,
            createdByExtension: true,
            originActiveTabId: 71,
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
          'workflow-161': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [161],
            checkinActionId: 'checkin-161',
            questionActionId: null,
          },
        },
        activeWorkflowId: 'workflow-161',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [{ id: 161, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
    createThrowsForQuestion: true,
  });

  const checkinResp = await harness.send('ACTION_RESULT', { actionId: 'checkin-161', action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: 161 } });
  await flush();
  await flush();
  await flush();
  assert.equal(checkinResp.ok, true, 'checkin success should still be accepted when question tab creation fails');
  assert.equal(store.session[runtimeKey].run.stage, 'question', 'run should persist the question stage for retry');
  assert.equal(store.session[runtimeKey].run.currentTabId, null, 'run should clear the tab lock after question creation fails');
  assert.equal(store.session[runtimeKey].run.currentActionId, null, 'run should clear the action lock after question creation fails');
  assert.ok(harness.events.find((event) => event[0] === 'tabs.remove' && event[1] === 161), 'checkin tab should still be closed before retrying');
}

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness = makeHarness({
    store,
    tabs: [{ id: 61, url: 'https://www.1point3acres.com/bbs/thread-61', active: true }],
    queryMode: (queryInfo, tabMap) => {
      if (queryInfo?.currentWindow === true) return [];
      const activeTabs = [...tabMap.values()].filter((tab) => tab.active === true);
      if (queryInfo?.lastFocusedWindow === true || queryInfo?.active === true) return activeTabs;
      return [...tabMap.values()];
    },
  });

  const response = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'real run should create a workflow');
  const checkinCreated = harness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-checkin'));
  assert.ok(checkinCreated, 'real workflow must create a checkin tab');
  assert.equal(checkinCreated[1].active, false, 'created checkin tab must be inactive');

  const checkinTabId = checkinCreated[1].id;
  const checkinAction = store.session[runtimeKey].actionsByTabId[String(checkinTabId)];
  assert.ok(checkinAction?.actionId, 'real workflow must persist checkin action record');
  assert.equal(checkinAction.originActiveTabId, 61, 'workflow should fall back to the last focused active tab when currentWindow query is empty');
  const originalTab = harness.tabMap.get(61);
  const createdCheckinTab = harness.tabMap.get(checkinTabId);
  originalTab.active = false;
  createdCheckinTab.active = true;
  const checkinResult = await harness.send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: checkinTabId } });
  await flush();
  assert.equal(checkinResult.ok, true, 'already-completed checkin should be accepted from a real workflow record');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.update' && event[1] === 61), false, 'completed checkin should not switch the user back to the origin tab');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === checkinTabId), true, 'completed checkin task tab should be closed');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.update' && event[1] === checkinTabId && String(event[2].url).includes('/daily-question')), false, 'closed checkin tab should not be promoted in place');
  const questionCreate = harness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-question'));
  assert.ok(questionCreate, 'real workflow should open a question tab after closing checkin');
  const questionTabId = questionCreate[1].id;
  const questionAction = store.session[runtimeKey].actionsByTabId[String(questionTabId)];
  assert.ok(questionAction?.actionId, 'real workflow should persist question action on the new tab');
  const questionResult = await harness.send('ACTION_RESULT', { actionId: questionAction.actionId, action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: questionTabId } });
  await flush();
  assert.equal(questionResult.ok, true, 'already-completed question should be accepted from a real workflow record');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.update' && event[1] === 61), false, 'active question should not switch back to the origin tab');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === questionTabId), true, 'completed question tab should be closed');
  assert.equal(store.session[runtimeKey].workflowsById[response.payload.workflowId], undefined, 'real workflow should be cleared after question success');
  assert.equal(store.session[runtimeKey].activeWorkflowId, null, 'real workflow should clear activeWorkflowId after question success');
}

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness = makeHarness({
    store,
    tabs: [{ id: 71, url: 'https://www.1point3acres.com/bbs', active: true }],
    queryMode: (queryInfo, tabMap) => {
      if (queryInfo?.currentWindow === true) return [];
      const activeTabs = [...tabMap.values()].filter((tab) => tab.active === true);
      if (queryInfo?.lastFocusedWindow === true || queryInfo?.active === true) return activeTabs;
      return [...tabMap.values()];
    },
  });

  const response = await harness.send('RUN_ONE_CLICK', { action: 'question' });
  await flush();
  assert.equal(response.ok, true, 'independent question action should start');
  const questionTabId = response.payload.tabId;
  const questionAction = store.session[runtimeKey].actionsByTabId[String(questionTabId)];
  assert.equal(questionAction.originActiveTabId, 71, 'independent question action should remember the user active tab');
  harness.tabMap.get(71).active = false;
  harness.tabMap.get(questionTabId).active = true;

  const result = await harness.send('ACTION_RESULT', { actionId: questionAction.actionId, action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: questionTabId } });
  await flush();
  assert.equal(result.ok, true, 'independent question already-completed should be accepted');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.update' && event[1] === 71), false, 'independent question should not reactivate the user tab');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === questionTabId), true, 'independent one-click question tab should close after completion');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '151': {
            action: 'checkin',
            actionId: 'checkin-151',
            workflowId: 'workflow-151',
            tabId: 151,
            createdByExtension: true,
            originActiveTabId: 202,
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
          'workflow-151': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [151],
            checkinActionId: 'checkin-151',
            questionActionId: null,
          },
        },
        activeWorkflowId: 'workflow-151',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [
      { id: 151, url: 'https://www.1point3acres.com/next/daily-checkin', active: true },
      { id: 202, url: 'https://www.1point3acres.com/bbs/thread-202', active: false },
    ],
    tabsGetMode: {
      151: (tab) => ({ ...tab, active: true }),
    },
  });

  const checkinResp = await harness.send('ACTION_RESULT', { actionId: 'checkin-151', action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: 151 } });
  await new Promise((resolve) => setTimeout(resolve, 260));
  await flush();
  assert.equal(checkinResp.ok, true, 'active checkin completion should still be accepted');
  assert.equal(harness.events.filter((event) => event[0] === 'tabs.remove' && event[1] === 151).length, 1, 'active task tab should be closed after completion');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.update' && event[1] === 151 && String(event[2].url).includes('/daily-question')), false, 'closed active checkin tab should not be promoted in-place');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.update' && event[1] === 202), false, 'ordinary origin tab must not be touched during task finalization');
  assert.equal(harness.tabMap.has(151), false, 'completed active checkin tab should be removed');
  const questionCreate = harness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-question'));
  assert.ok(questionCreate, 'closing an active checkin tab should still start the question stage');
  assert.equal(store.session[runtimeKey].workflowsById['workflow-151'].stage, 'question', 'workflow should continue into question stage');
  assert.equal(store.session[runtimeKey].actionsByTabId[String(questionCreate[1].id)].action, 'question', 'new tab should carry the question action');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '152': {
            action: 'checkin',
            actionId: 'checkin-152',
            workflowId: 'workflow-152',
            tabId: 152,
            createdByExtension: true,
            originActiveTabId: 201,
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
          'workflow-152': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [152],
            checkinActionId: 'checkin-152',
            questionActionId: null,
          },
        },
        activeWorkflowId: 'workflow-152',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [
      { id: 201, url: 'https://www.1point3acres.com/bbs/thread-201', active: false },
      { id: 152, url: 'https://www.1point3acres.com/next/daily-checkin', active: false },
    ],
    tabsRemoveMode: { 152: 'throw' },
  });

  const checkinResp = await harness.send('ACTION_RESULT', { actionId: 'checkin-152', action: 'checkin', status: 'success', reason: 'completed' }, { tab: { id: 152 } });
  await new Promise((resolve) => setTimeout(resolve, 260));
  await flush();
  assert.equal(checkinResp.ok, true, 'real checkin success should be accepted when close throws');
  assert.ok(harness.events.find((event) => event[0] === 'tabs.remove' && event[1] === 152), 'worker should still attempt to close the completed checkin tab');
  assert.ok(harness.events.find((event) => event[0] === 'tabs.update' && event[1] === 152 && String(event[2].url).includes('/daily-question')), 'remove failure should still reuse the owned task tab for question');
  const checkinActionResult = store.session[runtimeKey].run.events.find((event) => event?.type === 'action-result' && event?.tabId === 152);
  assert.ok(checkinActionResult, 'action-result should be persisted in run.events for the completed checkin');
  const checkinRemoveIndex = harness.events.findIndex((event) => event[0] === 'tabs.remove' && event[1] === 152);
  const checkinStorageSetIndex = harness.events.findIndex((event) => event[0] === 'storage.session.set' && JSON.stringify(event[1]).includes('"tabId":152'));
  assert.ok(checkinRemoveIndex >= 0 && checkinStorageSetIndex >= 0 && checkinStorageSetIndex < checkinRemoveIndex, 'persisted action-result should be stored before the tab close');
  assert.equal(store.session[runtimeKey].actionsByTabId['152'].action, 'question', 'remove failure should preserve recoverable question state on the same tab');
}

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const harness = makeHarness({
    store,
    tabs: [{ id: 81, url: 'https://www.1point3acres.com/bbs/thread-1', active: true }],
    queryMode: (queryInfo, tabMap) => {
      if (queryInfo?.currentWindow === true) return [];
      const activeTabs = [...tabMap.values()].filter((tab) => tab.active === true);
      if (queryInfo?.lastFocusedWindow === true || queryInfo?.active === true) return activeTabs;
      return [...tabMap.values()];
    },
  });

  const response = await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'daily-run-v2 should start with a real everything workflow');

  const checkinCreateIndex = harness.events.findIndex((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-checkin'));
  assert.ok(checkinCreateIndex >= 0, 'daily-run-v2 should open a checkin tab');
  const checkinTabId = harness.events[checkinCreateIndex][1].id;
  const checkinAction = store.session[runtimeKey].actionsByTabId[String(checkinTabId)];
  assert.equal(checkinAction.action, 'checkin', 'first action must be checkin');
  assert.equal(checkinAction.originActiveTabId, 81, 'checkin should remember the active user tab');

  const checkinResult = await harness.send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: checkinTabId } });
  await flush();
  assert.equal(checkinResult.ok, true, 'checkin success should be accepted');
  const checkinResultIndex = store.session[runtimeKey].run.events.findIndex((event) => event?.type === 'action-result' && event?.tabId === checkinTabId);
  const checkinRemoveIndex = harness.events.findIndex((event) => event[0] === 'tabs.remove' && event[1] === checkinTabId);
  const checkinStorageSetIndex = harness.events.findIndex((event) => event[0] === 'storage.session.set' && JSON.stringify(event[1]).includes(`"tabId":${checkinTabId}`) && JSON.stringify(event[1]).includes('"type":"action-result"'));
  assert.ok(checkinResultIndex >= 0 && checkinRemoveIndex >= 0 && checkinStorageSetIndex >= 0, 'checkin result, close, and persistence should all be recorded');
  assert.ok(checkinStorageSetIndex < checkinRemoveIndex, 'checkin result must be persisted before the tab closes');

  const questionCreateIndex = harness.events.findIndex((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-question'));
  assert.ok(questionCreateIndex > checkinRemoveIndex, 'question tab must be created after checkin close');
  const questionTabId = harness.events[questionCreateIndex][1].id;
  const questionAction = store.session[runtimeKey].actionsByTabId[String(questionTabId)];
  assert.equal(questionAction.action, 'question', 'second action must be question');
  assert.ok(questionAction.actionId !== checkinAction.actionId, 'question must get a fresh actionId');
  assert.equal(store.session[runtimeKey].run.runId, response.payload.runId, 'run should stay on the same coordinator run');
  assert.equal(store.session[runtimeKey].run.stage, 'question', 'run stage should advance to question');

  const questionResult = await harness.send('ACTION_RESULT', { actionId: questionAction.actionId, action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: questionTabId } });
  await flush();
  assert.equal(questionResult.ok, true, 'question success should be accepted');
  const questionRemoveIndex = harness.events.findIndex((event) => event[0] === 'tabs.remove' && event[1] === questionTabId);
  assert.ok(questionRemoveIndex > questionCreateIndex, 'question tab should close after success');
  assert.equal(store.session[runtimeKey].workflowsById[response.payload.workflowId], undefined, 'workflow should terminate after question success');
  assert.equal(store.session[runtimeKey].activeWorkflowId, null, 'active workflow should clear after terminal question success');
  assert.ok(harness.events.find((event) => event[0] === 'notifications.create' && event[1].message === '签到和答题完成'), 'terminal success should notify');
}

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const getState = { targetGets: 0 };
  const delayedActiveHarness = makeHarness({
    store,
    tabs: [{ id: 71, url: 'https://www.1point3acres.com/bbs', active: true }],
    tabsGetMode: {
      72: (tab) => {
        getState.targetGets += 1;
        return { ...tab, active: getState.targetGets <= 2 };
      },
    },
  });

  const response = await delayedActiveHarness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(response.ok, true, 'workflow should start for delayed-active regression');
  const checkinCreate = delayedActiveHarness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-checkin'));
  assert.ok(checkinCreate, 'workflow should create a checkin tab');
  assert.equal(checkinCreate[1].active, false, 'checkin tab must be created inactive');

  const checkinAction = store.session[runtimeKey].actionsByTabId[String(checkinCreate[1].id)];
  assert.equal(checkinAction.createdByExtension, true, 'checkin tab must be marked extension-owned');
  assert.equal(checkinAction.reusedExistingTab, false, 'checkin tab must not be marked as reused');
  assert.equal(checkinAction.originActiveTabId, 71, 'checkin tab must remember the original active tab');

  const checkinResult = await delayedActiveHarness.send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: checkinCreate[1].id } });
  await sleep(300);
  await flush();
  await flush();
  assert.equal(checkinResult.ok, true, 'already-completed checkin should be accepted on delayed-active tabs');
  assert.ok(delayedActiveHarness.events.find((event) => event[0] === 'tabs.remove' && event[1] === checkinCreate[1].id), 'completed checkin should close after the tab becomes inactive');
  const questionCreate = delayedActiveHarness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-question'));
  assert.ok(questionCreate, 'completed checkin should still advance to a new question tab');

  const questionAction = store.session[runtimeKey].actionsByTabId[String(questionCreate[1].id)];
  assert.equal(questionAction.createdByExtension, true, 'question tab must be marked extension-owned');
  assert.equal(questionAction.reusedExistingTab, false, 'question tab must not be marked as reused');
  assert.equal(questionAction.originActiveTabId, 71, 'question tab must remember the original active tab');

  const questionResult = await delayedActiveHarness.send('ACTION_RESULT', { actionId: questionAction.actionId, action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: questionCreate[1].id } });
  await sleep(300);
  await flush();
  await flush();
  assert.equal(questionResult.ok, true, 'already-completed question should be accepted on delayed-active tabs');
  assert.equal(store.session[runtimeKey].workflowsById[response.payload.workflowId], undefined, 'workflow should clear after delayed-active completion');
  assert.equal(store.session[runtimeKey].activeWorkflowId, null, 'active workflow should clear after delayed-active completion');
}

{
  const store = { session: {}, local: { 'p3a-learned-answers-v1': [] } };
  const missingTabHarness = makeHarness({
    store,
    tabs: [{ id: 81, url: 'https://www.1point3acres.com/bbs', active: true }],
    tabsGetMode: {
      82: (tab, tabMap) => {
        tabMap.delete(tab.id);
        throw new Error('missing-tab');
      },
    },
  });

  const response = await missingTabHarness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const checkinCreate = missingTabHarness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-checkin'));
  assert.ok(checkinCreate, 'workflow should create a checkin tab for missing-tab regression');
  const checkinAction = store.session[runtimeKey].actionsByTabId[String(checkinCreate[1].id)];
  const checkinResult = await missingTabHarness.send('ACTION_RESULT', { actionId: checkinAction.actionId, action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: checkinCreate[1].id } });
  await flush();
  assert.equal(response.ok, true);
  assert.equal(checkinResult.ok, true, 'already-completed checkin should still be accepted when the tab disappears during finalize');
  const questionCreate = missingTabHarness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-question'));
  assert.ok(questionCreate, 'missing checkin tab should fall back to creating a question tab');
  assert.equal(questionCreate[1].active, false, 'fallback question tab should remain inactive');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '52': {
            action: 'checkin',
            actionId: 'checkin-52',
            workflowId: 'workflow-52',
            tabId: 52,
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
          'workflow-52': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [52],
            checkinActionId: 'checkin-52',
            questionActionId: null,
          },
        },
        activeWorkflowId: 'workflow-52',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [{ id: 52, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });

  const checkinResp = await harness.send('ACTION_RESULT', { actionId: 'checkin-52', action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: 52 } });
  await flush();
  assert.equal(checkinResp.ok, true, 'legacy ambiguous completed checkin should still be accepted');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === 52), true, 'legacy ambiguous checkin should be closed after completion');
  assert.ok(harness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-question')), 'legacy completed checkin should open the question tab after closing');
  assert.equal(store.session[runtimeKey].workflowsById['workflow-52'].stage, 'question', 'legacy ambiguous checkin should still advance workflow');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '53': {
            action: 'question',
            actionId: 'question-53',
            workflowId: 'workflow-53',
            tabId: 53,
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
          'workflow-53': {
            action: 'everything',
            stage: 'done',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [53],
            checkinActionId: 'checkin-53',
            questionActionId: 'question-53',
          },
        },
        activeWorkflowId: 'workflow-53',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [{ id: 53, url: 'https://www.1point3acres.com/next/daily-question', active: false }],
  });

  const questionResp = await harness.send('ACTION_RESULT', { actionId: 'question-53', action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: 53 } });
  await flush();
  assert.equal(questionResp.ok, true, 'legacy ambiguous completed question should still be accepted');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === 53), true, 'legacy ambiguous question should be closed after completion');
  assert.equal(store.session[runtimeKey].workflowsById['workflow-53'], undefined, 'legacy ambiguous question should clear the workflow after closing');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '54': {
            action: 'question',
            actionId: 'question-54',
            workflowId: 'workflow-54',
            tabId: 54,
            createdByExtension: true,
            reusedExistingTab: true,
            status: 'completed',
            deliveredAt: 1,
            deliveredCount: 1,
            lastDeliveryAttemptAt: 1,
            lastDeliveryError: null,
            lastResult: { action: 'question', status: 'success' },
            finalizationPending: true,
          },
        },
        awaitingContentByTabId: {},
        pendingActionsById: {
          'question-54': {
            action: 'question',
            actionId: 'question-54',
            workflowId: 'workflow-54',
            tabId: 54,
            createdByExtension: true,
            reusedExistingTab: true,
            status: 'completed',
            deliveredAt: 1,
            deliveredCount: 1,
            lastDeliveryAttemptAt: 1,
            lastDeliveryError: null,
            lastResult: { action: 'question', status: 'success' },
            finalizationPending: true,
          },
        },
        workflowsById: {
          'workflow-54': {
            action: 'everything',
            stage: 'done',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [54],
            checkinActionId: 'checkin-54',
            questionActionId: 'question-54',
          },
        },
        activeWorkflowId: 'workflow-54',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [{ id: 54, url: 'https://www.1point3acres.com/next/daily-question', active: false }],
  });

  const questionResp = await harness.send('ACTION_RESULT', { actionId: 'question-54', action: 'question', status: 'success', reason: 'already-completed' }, { tab: { id: 54 } });
  await flush();
  assert.equal(questionResp.ok, true, 'reusedExistingTab question should still be accepted');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === 54), true, 'reusedExistingTab question should close after completion');
  assert.equal(store.session[runtimeKey].workflowsById['workflow-54'], undefined, 'reusedExistingTab question should clear the workflow after closing');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '81': {
            action: 'checkin',
            actionId: 'checkin-81',
            workflowId: 'workflow-81',
            tabId: 81,
            createdByExtension: false,
            reusedExistingTab: true,
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
          'workflow-81': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [81],
            checkinActionId: 'checkin-81',
            questionActionId: null,
          },
        },
        activeWorkflowId: 'workflow-81',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [{ id: 81, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });

  const checkinResp = await harness.send('ACTION_RESULT', { actionId: 'checkin-81', action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: 81 } });
  await flush();
  assert.equal(checkinResp.ok, true, 'user-owned completed checkin should still be accepted');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === 81), true, 'user-owned task tab should be closed after completion');
  const questionCreate = harness.events.find((event) => event[0] === 'tabs.create' && event[1].url.includes('/daily-question'));
  assert.ok(questionCreate, 'workflow should still advance to question after a user-owned completed checkin');
  const userOwnedRemoveIndex = harness.events.findIndex((event) => event[0] === 'tabs.remove' && event[1] === 81);
  const userOwnedQuestionCreateIndex = harness.events.findIndex((event) => event[0] === 'tabs.create' && event[1].url.includes('/daily-question'));
  assert.ok(userOwnedRemoveIndex >= 0, 'user-owned completed checkin must emit a remove event');
  assert.ok(userOwnedQuestionCreateIndex >= 0, 'user-owned completed checkin should still create question tab');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '82': {
            action: 'checkin',
            actionId: 'checkin-82',
            workflowId: 'workflow-82',
            tabId: 82,
            createdByExtension: false,
            reusedExistingTab: true,
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
          'workflow-82': {
            action: 'everything',
            stage: 'checkin',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [82],
            checkinActionId: 'checkin-82',
            questionActionId: null,
          },
        },
        activeWorkflowId: 'workflow-82',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [{ id: 82, url: 'https://www.1point3acres.com/next/daily-checkin', active: true }],
  });

  const checkinResp = await harness.send('ACTION_RESULT', { actionId: 'checkin-82', action: 'checkin', status: 'success', reason: 'already-completed' }, { tab: { id: 82 } });
  await flush();
  assert.equal(checkinResp.ok, true, 'active user-owned completed checkin should be accepted');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.remove' && event[1] === 82), true, 'active user-owned checkin tab should be closed after completion');
  assert.equal(harness.events.some((event) => event[0] === 'tabs.update' && event[1] === 82 && String(event[2].url).includes('/daily-question')), false, 'closed checkin tab should not be promoted in place');
  assert.equal(harness.tabMap.has(82), false, 'active user-owned checkin tab should be removed');
  const questionCreate = harness.events.find((event) => event[0] === 'tabs.create' && String(event[1].url).includes('/daily-question'));
  assert.ok(questionCreate, 'active user-owned checkin should still advance to a question tab');
}

{
  const store = {
    session: {
      [runtimeKey]: {
        version: 1,
        actionsByTabId: {
          '61': {
            action: 'question',
            actionId: 'question-61',
            workflowId: 'workflow-61',
            tabId: 61,
            createdByExtension: true,
            status: 'completed',
            deliveredAt: 1,
            deliveredCount: 1,
            lastDeliveryAttemptAt: 1,
            lastDeliveryError: null,
            lastResult: { action: 'question', status: 'success' },
            finalizationPending: true,
          },
        },
        awaitingContentByTabId: {},
        pendingActionsById: {
          'question-61': {
            action: 'question',
            actionId: 'question-61',
            workflowId: 'workflow-61',
            tabId: 61,
            createdByExtension: true,
            status: 'completed',
            deliveredAt: 1,
            deliveredCount: 1,
            lastDeliveryAttemptAt: 1,
            lastDeliveryError: null,
            lastResult: { action: 'question', status: 'success' },
            finalizationPending: true,
          },
        },
        workflowsById: {
          'workflow-61': {
            action: 'everything',
            stage: 'done',
            createdAt: 1,
            updatedAt: 1,
            tabIds: [61],
            checkinActionId: 'checkin-61',
            questionActionId: 'question-61',
          },
        },
        activeWorkflowId: 'workflow-61',
      },
    },
    local: { 'p3a-learned-answers-v1': [] },
  };

  const harness = makeHarness({
    store,
    tabs: [{ id: 61, url: 'https://www.1point3acres.com/next/daily-question', active: false }],
    tabsGetMode: {
      61: (tab, tabMap) => {
        tabMap.set(61, { ...tab, active: true });
        return null;
      },
    },
  });

  await harness.send('CONTENT_READY', {}, { tab: { id: 61 } });
  await flush();
  await flush();
  assert.equal(harness.tabMap.has(61), true, 'active tab must be preserved');
  assert.equal(store.session[runtimeKey].actionsByTabId['61'].finalizationPending, true, 'active tab must remain pending for recovery');
  assert.ok(
    ['active-tab', 'origin-active-tab', 'origin-restore-failed', undefined].includes(store.session[runtimeKey].actionsByTabId['61'].closeSkippedReason),
    'active user-visible tab must never be force-closed when no safe restore path exists',
  );
  assert.ok(store.session[runtimeKey].workflowsById['workflow-61'], 'active tab should preserve workflow evidence for recovery');
  assert.equal(harness.events.filter((event) => event[0] === 'tabs.remove' && event[1] === 61).length, 0, 'active tab must not be removed');
}

console.log('completed workflow regression test passed.');
