#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

const makeElement = (tagName, text = '') => {
  const listenersByType = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    textContent: text,
    innerText: text,
    disabled: false,
    isConnected: true,
    hidden: false,
    children: [],
    parentNode: null,
    attributes: Object.create(null),
    style: {},
    className: '',
    classList: { add() {}, remove() {} },
    addEventListener(type, handler) {
      const list = listenersByType.get(type) || [];
      list.push(handler);
      listenersByType.set(type, list);
    },
    appendChild(child) {
      child.parentNode = element;
      child.isConnected = true;
      element.children.push(child);
      return child;
    },
    append(...nodes) {
      nodes.flat().forEach((node) => element.appendChild(node));
    },
    replaceChildren(...nodes) {
      element.children = [];
      nodes.flat().forEach((node) => element.appendChild(node));
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
      if (name === 'id') element.id = String(value);
    },
    removeAttribute(name) {
      delete element.attributes[name];
      if (name === 'id') delete element.id;
    },
    getAttribute(name) {
      return element.attributes[name] ?? null;
    },
    remove() {
      element.isConnected = false;
      if (element.parentNode) {
        element.parentNode.children = element.parentNode.children.filter((child) => child !== element);
        element.parentNode = null;
      }
    },
    closest(selector) {
      if (selector === 'main') {
        let current = element;
        while (current) {
          if (current.tagName === 'MAIN') return current;
          current = current.parentNode;
        }
      }
      return null;
    },
    querySelector(selector) {
      return element.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (selector.includes('button') && child.tagName === 'BUTTON') found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
    click() {
      const handlers = listenersByType.get('click') || [];
      for (const handler of handlers) handler({ type: 'click', currentTarget: element, target: element });
    },
  };
  return element;
};

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, { timeoutMs = 200, intervalMs = 1, message = 'condition not met' } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await delay(intervalMs);
  }
  throw new Error(message);
};

const buildCompletedCheckinHarness = () => {
  let runtimeListener = null;
  let defaultClicks = 0;
  let submitClicks = 0;
  let actionResultCalls = 0;

  const body = makeElement('body');
  const main = makeElement('main');
  body.appendChild(main);

  const defaultMood = makeElement('button', '没心情');
  defaultMood.click = () => {
    defaultClicks += 1;
  };
  const submit = makeElement('button', '提交签到');
  submit.click = () => {
    submitClicks += 1;
  };

  const document = {
    body,
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => {
      const walk = (node) => {
        if (!node) return null;
        if (node.id === id) return node;
        for (const child of node.children || []) {
          const match = walk(child);
          if (match) return match;
        }
        return null;
      };
      return walk(body);
    },
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };

  const asyncCallback = (callback, response) => {
    if (typeof callback !== 'function') return;
    queueMicrotask(() => {
      callback(response);
    });
  };

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      sendMessage(message, callback) {
        if (message.type === 'ACTION_RESULT') {
          actionResultCalls += 1;
          if (actionResultCalls === 1) {
            queueMicrotask(() => {
              chrome.runtime.lastError = { message: 'The message port closed before a response was received.' };
              asyncCallback(callback, undefined);
              queueMicrotask(() => {
                chrome.runtime.lastError = null;
              });
            });
            return Promise.resolve(undefined);
          }
          if (actionResultCalls === 2) {
            asyncCallback(callback, { ok: true, accepted: false, actionId: 'mismatch-action' });
            return Promise.resolve({ ok: true, accepted: false, actionId: 'mismatch-action' });
          }
          asyncCallback(callback, { ok: true });
          return Promise.resolve({ ok: true });
        }
        asyncCallback(callback, { ok: true });
        return Promise.resolve({ ok: true });
      },
    },
  };

  const context = {
    globalThis: {},
    document,
    chrome,
    location: { href: 'https://www.1point3acres.com/next/daily-checkin' },
    window: null,
    ExtensionProtocol: {
      MESSAGE_TYPES: {
        RUN_ONE_CLICK: 'RUN_ONE_CLICK',
        LOOKUP_QUESTION: 'LOOKUP_QUESTION',
        CONTENT_READY: 'CONTENT_READY',
        ACTION_RESULT: 'ACTION_RESULT',
        SAVE_LEARNED_ANSWER: 'SAVE_LEARNED_ANSWER',
      },
      createMessage(type, payload) {
        return { type, payload };
      },
    },
    DailyQuestionPage: {
      TOOLBAR_ID: 'p3a-daily-question-helper',
      isQuestionPage: () => false,
      findQuestionContainer: () => null,
      findQuestion: () => ({ node: null, value: '' }),
      findOptions: () => [],
      findSelectedOption: () => null,
      findSubmit: () => null,
      clean: (node) => String(node?.textContent || '').trim(),
      getState: () => 'active',
    },
    DailyCheckinPage: {
      TOOLBAR_ID: 'p3a-daily-checkin-helper',
      isCheckinPage: () => true,
      findDefault: () => defaultMood,
      findSubmit: () => submit,
      getState: () => 'completed',
      nodeSignature: (node) => String(node?.textContent || ''),
    },
    CheckinState: {
      reconcile: () => null,
      prepare: () => null,
      nodeSignature: (node) => String(node?.textContent || ''),
    },
    QuestionMatcher: { normalize: (value) => String(value || '').trim() },
    MutationObserver: class {
      constructor() {}
      observe() {}
      disconnect() {}
    },
    MouseEvent: class {},
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    checkinStatusNode: null,
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context);

  return {
    get runtimeListener() {
      return runtimeListener;
    },
    get actionResultCalls() {
      return actionResultCalls;
    },
    get defaultClicks() {
      return defaultClicks;
    },
    get submitClicks() {
      return submitClicks;
    },
  };
};

const harness = buildCompletedCheckinHarness();
assert.equal(typeof harness.runtimeListener, 'function', 'content script must register runtime listener');

const firstResponse = await new Promise((resolve) => {
  harness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId: 'checkin-1' } },
    {},
    resolve,
  );
});

assert.equal(firstResponse?.ok, true, 'initial remote action must be accepted');
assert.equal(firstResponse?.accepted, true, 'initial remote action must be accepted');
await waitFor(() => harness.actionResultCalls === 1, { message: 'initial ACTION_RESULT should be reported once' });
assert.equal(harness.actionResultCalls, 1, 'completed checkin should attempt to report ACTION_RESULT once immediately');
assert.equal(harness.defaultClicks, 0, 'already-completed checkin must not click the mood option');
assert.equal(harness.submitClicks, 0, 'already-completed checkin must not click submit');
await waitFor(() => harness.actionResultCalls === 3, { timeoutMs: 1200, message: 'accepted:false should keep pending ACTION_RESULT until a matching ACK arrives' });
assert.equal(harness.actionResultCalls, 3, 'mismatched ACK must not clear pending remote result');

const duplicateResponse = await new Promise((resolve) => {
  harness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId: 'checkin-1' } },
    {},
    resolve,
  );
});

assert.equal(duplicateResponse?.ok, true, 'duplicate remote action must still be accepted');
assert.equal(duplicateResponse?.accepted, true, 'duplicate remote action must still be accepted');
assert.equal(duplicateResponse?.duplicate, true, 'duplicate remote action should be marked duplicate');
await waitFor(() => harness.actionResultCalls >= 2, { timeoutMs: 1200, message: 'stored ACTION_RESULT should be retried after an earlier transport failure' });
assert.equal(harness.actionResultCalls >= 2, true, 'duplicate remote action must preserve eventual ACTION_RESULT replay after an earlier transport failure');
assert.equal(harness.defaultClicks, 0, 'duplicate replay must remain idempotent');
assert.equal(harness.submitClicks, 0, 'duplicate replay must not submit the site again');

console.log('remote action result replay regression test passed.');
