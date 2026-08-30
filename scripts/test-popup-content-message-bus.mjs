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
const questionPageSource = read('../src/shared/daily-question-page.js');
const checkinPageSource = read('../src/shared/daily-checkin-page.js');
const checkinStateSource = read('../src/shared/checkin-state.js');
const contentSource = read('../src/content.js');

const runtimeListeners = [];
const events = [];
const session = {};
const local = {};
const tabMap = new Map();
let nextTabId = 1;

const chrome = {
  runtime: {
    getURL: (p) => p,
    lastError: null,
    onMessage: { addListener: (fn) => { runtimeListeners.push(fn); } },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage(message, callback) {
      let settled = false;
      const sendResponse = (response) => {
        if (settled) return;
        settled = true;
        events.push(['popup-response', message.type, response]);
        callback?.(response);
      };
      for (const listener of runtimeListeners) {
        listener(message, { id: 'popup' }, sendResponse);
      }
    },
  },
  storage: {
    session: { get: async (key) => ({ [key]: session[key] }), set: async (value) => Object.assign(session, value) },
    local: { get: async (key) => ({ [key]: local[key] }), set: async (value) => Object.assign(local, value) },
    onChanged: { addListener: () => {} },
  },
  tabs: {
    query: async () => [...tabMap.values()].map((tab) => ({ ...tab })),
    create: async ({ url, active }) => {
      const tab = { id: nextTabId++, url, active: active === true };
      tabMap.set(tab.id, tab);
      events.push(['tabs.create', tab.id, url]);
      return { ...tab };
    },
    update: async (tabId, changes) => {
      const tab = tabMap.get(tabId);
      if (!tab) throw new Error('missing-tab');
      Object.assign(tab, changes);
      return { ...tab };
    },
    remove: async (tabId) => { tabMap.delete(tabId); },
    get: async (tabId) => {
      const tab = tabMap.get(tabId);
      if (!tab) throw new Error('missing-tab');
      return { ...tab };
    },
    sendMessage: async (tabId, message) => {
      events.push(['tabs.sendMessage', tabId, message.type, message.payload]);
      return { ok: true, accepted: true, actionId: message.payload.actionId };
    },
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
  },
  alarms: {
    create: async () => {},
    clear: async () => {},
    get: async () => null,
    getAll: async () => [],
    onAlarm: { addListener: () => {} },
  },
  action: { setIcon: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  notifications: { create: async () => 'n1' },
};

const workerContext = {
  globalThis: {},
  console,
  crypto: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() },
  fetch: async () => ({ ok: true, json: async () => ({ entries: [] }) }),
  chrome,
};
vm.createContext(workerContext);
workerContext.globalThis = workerContext;
workerContext.importScripts = (...files) => files.forEach((file) => {
  const source = file === 'shared/protocol.js' ? protocolSource : file === 'shared/question-matcher.js' ? questionMatcherSource : learnedAnswersSource;
  vm.runInContext(source, workerContext);
});
vm.runInContext(workerSource, workerContext);

const body = { children: [], appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
const contentContext = {
  globalThis: {},
  console,
  chrome,
  document: {
    body,
    getElementById: () => null,
    createElement: () => ({ classList: { add() {}, toggle() {} }, setAttribute() {}, append() {}, addEventListener() {}, style: {}, textContent: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  },
  location: { href: 'https://www.1point3acres.com/next/daily-question' },
  window: null,
  MutationObserver: class { observe() {} disconnect() {} },
  MouseEvent: class {},
  Date,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
vm.createContext(contentContext);
contentContext.window = contentContext;
contentContext.globalThis = contentContext;
for (const source of [protocolSource, questionMatcherSource, learnedAnswersSource, questionPageSource, checkinPageSource, checkinStateSource, contentSource]) {
  vm.runInContext(source, contentContext);
}

assert.equal(runtimeListeners.length >= 2, true, 'worker and content must both register onMessage listeners');

const response = await new Promise((resolve) => {
  chrome.runtime.sendMessage(
    workerContext.ExtensionProtocol.createMessage('RUN_ONE_CLICK', { action: 'everything' }),
    resolve,
  );
});

assert.equal(response?.ok, true, 'popup everything must receive the worker reply even when a task-page content script is present');
assert.notEqual(response?.error, 'invalid-action');
assert.notEqual(response?.error, 'not-ready');
assert.equal(typeof response?.payload?.tabId, 'number');

console.log('popup/content message bus tests passed.');
