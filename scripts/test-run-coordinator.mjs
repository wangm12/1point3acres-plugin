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

const makeHarness = ({ session = {}, local = {}, tabs = [], removeMode = 'normal' } = {}) => {
  const events = [];
  const listeners = { message: null, updated: null, removed: null, startup: null, installed: null, alarm: null };
  let nextTabId = Math.max(0, ...tabs.map((tab) => tab.id || 0)) + 1;
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const chrome = {
    runtime: {
      getURL: (p) => p,
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    },
    storage: {
      session: { get: async (key) => ({ [key]: session[key] }), set: async (value) => { Object.assign(session, value); } },
      local: { get: async (key) => ({ [key]: local[key] }), set: async (value) => { Object.assign(local, value); } },
    },
    tabs: {
      query: async () => [...tabMap.values()].map((tab) => ({ ...tab })),
      create: async ({ url, active }) => {
        const tab = { id: nextTabId++, url, active: active === true };
        tabMap.set(tab.id, tab);
        events.push(['tabs.create', tab.id, url, active === true]);
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
        if (removeMode === 'throw-once') {
          removeMode = 'normal';
          throw new Error('remove-failed');
        }
        if (removeMode === 'vanish-once') {
          removeMode = 'normal';
          tabMap.delete(tabId);
          listeners.removed?.(tabId, { windowId: 1, isWindowClosing: false });
          return;
        }
        tabMap.delete(tabId);
        listeners.removed?.(tabId, { windowId: 1, isWindowClosing: false });
      },
      get: async (tabId) => {
        const tab = tabMap.get(tabId);
        if (!tab) throw new Error('missing-tab');
        return { ...tab };
      },
      sendMessage: async (tabId, message) => {
        events.push(['tabs.sendMessage', tabId, message.type, message.payload]);
        return { ok: true, accepted: true, actionId: message.payload.actionId };
      },
      onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
      onRemoved: { addListener: (fn) => { listeners.removed = fn; } },
    },
    alarms: {
      create: async () => {},
      clear: async () => {},
      get: async () => null,
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
    },
    notifications: { create: async () => 'n1' },
    action: { setIcon: async () => {} },
  };
  const context = { globalThis: {}, console, crypto: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() }, fetch: async () => ({ ok: true, json: async () => ({ entries: [] }) }), chrome };
  context.globalThis = context;
  context.importScripts = (...files) => files.forEach((file) => {
    const source = file === 'shared/protocol.js' ? protocolSource : file === 'shared/question-matcher.js' ? questionMatcherSource : learnedAnswersSource;
    vm.runInContext(source, context);
  });
  vm.createContext(context);
  vm.runInContext(workerSource, context);
  const send = (type, payload = {}, sender = {}) => new Promise((resolve) => listeners.message({ type, payload }, sender, (response) => {
    events.push(['response', type, response]);
    resolve(response);
  }));
  return { send, listeners, events, session, local, tabMap };
};

const runtimeStateOf = (harness) => harness.session['p3a-runtime-v1'] || harness.session['p3a-daily-run-v2'];
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const waitFor = async (predicate, { timeoutMs = 500, stepMs = 20 } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) return true;
    await flush();
  }
  return false;
};

{
  const harness = makeHarness({ local: { 'p3a-learned-answers-v1': [] } });
  const open = await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  assert.equal(open.ok, true);
  const tabId = runtimeStateOf(harness).run.currentTabId;
  await harness.send('CONTENT_READY', { pageState: 'ready' }, { tab: { id: tabId } });
  await flush();
  const sendMessage = harness.events.find((e) => e[0] === 'tabs.sendMessage');
  assert.equal(sendMessage[2], 'RUN_ONE_CLICK');
  assert.equal(sendMessage[3].action, 'checkin');
  assert.equal(typeof sendMessage[3].actionId, 'string');
  const run = runtimeStateOf(harness).run;
  assert.equal(run.stage, 'checkin');
  assert.equal(run.status, 'running');
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 12, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  const checkinTabId = runtimeStateOf(harness).run.currentTabId;
  const response = await harness.send('CONTENT_READY', {
    pageKind: 'daily-checkin',
    pageState: 'completed',
  }, { tab: { id: checkinTabId } });
  assert.equal(response.accepted, true, 'a rendered check-in success must advance the one-click run');
  assert.equal(await waitFor(() => runtimeStateOf(harness).run.stage === 'question'), true, 'rendered check-in success must open the question stage');
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length, 1);
}

{
  const harness = makeHarness({ local: { 'p3a-learned-answers-v1': [] } });
  await harness.send('RUN_ONE_CLICK', { action: 'question' });
  const state = runtimeStateOf(harness);
  const tabId = state.run.currentTabId;
  const response = await harness.send('CONTENT_READY', {
    pageKind: 'daily-question',
    pageState: 'completed',
  }, { tab: { id: tabId } });
  assert.equal(response.ok, true, 'observed site completion should be accepted');
  assert.equal(response.accepted, true, 'observed site completion should finalize the managed question action');
  assert.equal(await waitFor(() => !harness.tabMap.has(tabId)), true, 'observed site completion must close the managed question tab');
  assert.equal(runtimeStateOf(harness).run.status, 'idle', 'observed site completion must finish the run');
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 11, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const before = harness.events.filter((e) => e[0] === 'tabs.sendMessage').length;
  const run = runtimeStateOf(harness).run;
  await harness.send('CONTENT_READY', { pageState: 'ready' }, { tab: { id: run.currentTabId } });
  await harness.send('CONTENT_READY', { pageState: 'ready' }, { tab: { id: run.currentTabId } });
  await flush();
  const after = harness.events.filter((e) => e[0] === 'tabs.sendMessage').length;
  assert.equal(after >= before + 1, true);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [
      { id: 10, url: 'https://www.1point3acres.com/next/daily-checkin', active: false },
      { id: 11, url: 'https://www.1point3acres.com/next/daily-checkin', active: false },
    ],
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const run = runtimeStateOf(harness).run;
  const wrongTabId = run.currentTabId === 10 ? 11 : 10;
  const before = harness.events.filter((e) => e[0] === 'tabs.sendMessage').length;
  await harness.send('CONTENT_READY', { pageState: 'ready' }, { tab: { id: wrongTabId } });
  const afterWrongTab = harness.events.filter((e) => e[0] === 'tabs.sendMessage').length;
  assert.equal(afterWrongTab, before, 'unmanaged tab content readiness must not receive a one-click command');
  await harness.send('CONTENT_READY', { pageState: 'ready' }, { tab: { id: run.currentTabId } });
  const after = harness.events.filter((e) => e[0] === 'tabs.sendMessage').length;
  assert.equal(after, before + 1, 'managed tab content readiness must receive one command');
  assert.equal(run.currentTabId === wrongTabId, false);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 21, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  const actionId = state.run.currentActionId;
  const tabId = state.run.currentTabId;
  await harness.send('ACTION_RESULT', { actionId, action: 'checkin', status: 'success' }, { tab: { id: tabId } });
  await flush();
  await harness.send('ACTION_RESULT', { actionId, action: 'checkin', status: 'success' }, { tab: { id: tabId } });
  await flush();
  const responseIndex = harness.events.findIndex((e) => e[0] === 'response' && e[1] === 'ACTION_RESULT');
  const finalizeIndex = harness.events.findIndex((e, idx) => idx > responseIndex && (e[0] === 'tabs.remove' || e[0] === 'tabs.update' || e[0] === 'tabs.create'));
  assert.equal(responseIndex >= 0 && finalizeIndex >= 0 && responseIndex < finalizeIndex, true);
  const questionCreates = harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length;
  const questionUpdates = harness.events.filter((e) => e[0] === 'tabs.update' && e[2]?.url === 'https://www.1point3acres.com/next/daily-question').length;
  assert.equal(questionCreates + questionUpdates, 1, 'tabs.onRemoved recovery must create exactly one question tab');
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 24, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  const before = harness.events.filter((e) => e[0] === 'tabs.remove' || e[0] === 'tabs.update' || e[0] === 'tabs.create').length;
  await harness.send('ACTION_RESULT', { runId: 'wrong-run', actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await flush();
  const after = harness.events.filter((e) => e[0] === 'tabs.remove' || e[0] === 'tabs.update' || e[0] === 'tabs.create').length;
  assert.equal(after, before);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 32, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
    removeMode: 'vanish-once',
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await flush();
  const first = harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length;
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await flush();
  const second = harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length;
  assert.equal(second, first);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 41, url: 'https://www.1point3acres.com/next/daily-checkin', active: true }],
    removeMode: 'throw-once',
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await flush();
  assert.equal(harness.events.some((e) => e[0] === 'tabs.update' && e[2].url === 'https://www.1point3acres.com/next/daily-question'), false);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 42, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
    removeMode: 'throw-once',
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await flush();
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length <= 1, true);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 43, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
    removeMode: 'throw-once',
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  assert.equal(await waitFor(() => runtimeStateOf(harness).run.stage === 'question'), true, 'close failure must not strand the run at completed check-in');
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length, 1, 'close failure must still open exactly one question tab');
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 51, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
    removeMode: 'vanish-once',
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await flush();
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length, 1);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 61, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  assert.equal(harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-checkin').length <= 1, true);
}

{
  const harness = makeHarness({
    local: { 'p3a-learned-answers-v1': [] },
    tabs: [{ id: 52, url: 'https://www.1point3acres.com/next/daily-checkin', active: false }],
  });
  await harness.send('RUN_ONE_CLICK', { action: 'checkin' });
  const state = runtimeStateOf(harness);
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await harness.send('ACTION_RESULT', { actionId: state.run.currentActionId, action: 'checkin', status: 'success' }, { tab: { id: state.run.currentTabId } });
  await flush();
  const questionCreates = harness.events.filter((e) => e[0] === 'tabs.create' && e[2] === 'https://www.1point3acres.com/next/daily-question').length;
  assert.equal(questionCreates, 1);
}

{
  const harness = makeHarness({ local: { 'p3a-learned-answers-v1': [] } });
  await harness.send('RUN_ONE_CLICK', { action: 'everything' });
  await flush();
  const first = runtimeStateOf(harness).run.currentActionId;
  const second = runtimeStateOf(harness).run.currentTabId;
  await harness.send('CONTENT_READY', { pageState: 'ready' }, { tab: { id: second } });
  await flush();
  const firstSendCount = harness.events.filter((e) => e[0] === 'tabs.sendMessage').length;
  const newHarnessState = runtimeStateOf(harness);
  assert.equal(newHarnessState.run.currentActionId, first);
  assert.equal(firstSendCount, 1);
}

console.log('test-run-coordinator: ok');
