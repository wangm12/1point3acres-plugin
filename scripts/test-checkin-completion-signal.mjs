#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs
  .readFileSync(new URL('../src/content.js', import.meta.url), 'utf8')
  .replace('const REMOTE_ACTION_TIMEOUT_MS = 8000;', 'const REMOTE_ACTION_TIMEOUT_MS = 80;')
  .replace('const REMOTE_ACTION_RETRY_MS = 200;', 'const REMOTE_ACTION_RETRY_MS = 1;')
  .replace('const REMOTE_RESULT_TIMEOUT_MS = 12000;', 'const REMOTE_RESULT_TIMEOUT_MS = 80;')
  .replace('const REMOTE_RESULT_REPORT_DELAY_MS = 200;', 'const REMOTE_RESULT_REPORT_DELAY_MS = 1;')
  .replace('const QUESTION_SUBMIT_WAIT_MS = 4000;', 'const QUESTION_SUBMIT_WAIT_MS = 50;')
  .replace('const QUESTION_SUBMIT_POLL_MS = 100;', 'const QUESTION_SUBMIT_POLL_MS = 1;');

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, { timeoutMs = 500, intervalMs = 1, message = 'condition not met' } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(message);
};

const makeElement = (tagName, text = '') => {
  const listenersByType = new Map();
  const element = {
    tagName: tagName.toUpperCase(),
    textContent: text,
    innerText: text,
    disabled: false,
    isConnected: true,
    hidden: false,
    className: '',
    children: [],
    parentNode: null,
    attributes: Object.create(null),
    style: {},
    classList: {
      add() {},
      remove() {},
    },
    addEventListener(type, handler) {
      const list = listenersByType.get(type) || [];
      list.push(handler);
      listenersByType.set(type, list);
    },
    dispatchEvent() {},
    click() {
      const handlers = listenersByType.get('click') || [];
      for (const handler of handlers) handler({ type: 'click', currentTarget: element, target: element });
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
      if (selector.includes('#p3a-daily-question-helper') && element.id === 'p3a-daily-question-helper') return element;
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
          if (selector.includes('[role="option"]') && child.getAttribute('role') === 'option') found.push(child);
          if (selector.includes('main') && child.tagName === 'MAIN') found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
  };
  return element;
};

const assertRemoteAccepted = (response, message) => {
  assert.equal(response?.ok, true, message);
  assert.equal(response?.accepted, true, message);
};
const toPlain = (value) => JSON.parse(JSON.stringify(value));

const cleanNodeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const checkinNodeSignature = (node) => {
  if (!node) return '';
  const attrs = ['name', 'id', 'value', 'data-value', 'data-qdxq', 'aria-label']
    .map((name) => `${name}=${cleanNodeText(node.getAttribute?.(name))}`).join('|');
  return `${cleanNodeText(node.textContent)}|${attrs}`;
};

const buildCheckinHarness = () => {
  let runtimeListener = null;
  let actionResultCalls = 0;
  const actionResults = [];
  let defaultClicks = 0;
  let submitClicks = 0;
  let checkinStateOverride = null;

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
    queueMicrotask(() => {
      body.innerText = '今日已签到，不能重复签到';
      body.textContent = body.innerText;
    });
  };

  main.append(defaultMood, submit);

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
    if (typeof callback === 'function') queueMicrotask(() => callback(response));
  };

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      sendMessage(message, callback) {
        if (message.type === 'ACTION_RESULT') {
          actionResultCalls += 1;
          actionResults.push(message.payload);
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
      getState: () => {
        if (checkinStateOverride) return checkinStateOverride;
        return /今日已签到|已经签到|今日签到已完成|already checked.?in|already signed/i.test(String(body.innerText || body.textContent || ''))
          ? 'completed'
          : 'active';
      },
      nodeSignature: (node) => String(node?.textContent || ''),
    },
    CheckinState: {
      reconcile: (prepared, href, current) => {
        if (!prepared || prepared.href !== href || !current || checkinNodeSignature(current) !== prepared.signature) return null;
        return { ...prepared, node: current };
      },
      prepare: (node, href) => (node && href ? { href, signature: checkinNodeSignature(node), node } : null),
      nodeSignature: checkinNodeSignature,
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
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context);

  return {
    get runtimeListener() {
      return runtimeListener;
    },
    get defaultClicks() {
      return defaultClicks;
    },
    get submitClicks() {
      return submitClicks;
    },
    get actionResultCalls() {
      return actionResultCalls;
    },
    get actionResults() {
      return actionResults;
    },
    setCheckinState(nextState) {
      checkinStateOverride = nextState;
    },
  };
};

const buildQuestionHarness = ({ completionText }) => {
  let runtimeListener = null;
  let actionResultCalls = 0;
  const actionResults = [];
  let questionState = 'active';
  let submitClicks = 0;

  const answerText = '这些都有';
  const body = makeElement('body');
  const main = makeElement('main');
  body.appendChild(main);
  const questionNode = makeElement('div', '一亩三分地里有哪些方面的干货信息？');

  let selectedNode = null;
  const optionNodes = [
    '美国大学各专业录取信息，留学途中的问题',
    '各公司工作情况，面试信息，薪资水平，职场发展。',
    answerText,
    '投资理财、购置房产',
  ].map((text, index) => {
    const node = makeElement('button', text);
    node.className = index === 2 ? 'rounded-md cursor-pointer bg-primary' : 'rounded-md cursor-pointer';
    node.addEventListener('click', () => {
      selectedNode = node;
    });
    return node;
  });
  selectedNode = optionNodes[2];

  const submitButton = makeElement('button', '提交答案');
  submitButton.click = () => {
    submitClicks += 1;
    queueMicrotask(() => {
      body.innerText = completionText;
      body.textContent = completionText;
    });
  };

  main.append(questionNode, ...optionNodes, submitButton);

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
    if (typeof callback === 'function') queueMicrotask(() => callback(response));
  };

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      sendMessage(message, callback) {
        if (message.type === 'ACTION_RESULT') {
          actionResultCalls += 1;
          actionResults.push(message.payload);
          asyncCallback(callback, { ok: true });
          return Promise.resolve({ ok: true });
        }
        if (message.type === 'LOOKUP_QUESTION') {
          asyncCallback(callback, { ok: true, payload: { status: 'matched', optionIndex: 2, answerText } });
          return Promise.resolve({ ok: true, payload: { status: 'matched', optionIndex: 2, answerText } });
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
    location: { href: 'https://www.1point3acres.com/next/daily-question' },
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
      clean: (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim(),
      isQuestionPage: () => true,
      findQuestionContainer: () => main,
      findQuestion: () => ({ node: questionNode, value: questionNode.textContent }),
      findOptions: () => optionNodes,
      findSelectedOption: () => selectedNode,
      findSubmit: () => submitButton,
      getState: () => questionState,
    },
    DailyCheckinPage: {
      TOOLBAR_ID: 'p3a-daily-checkin-helper',
      isCheckinPage: () => false,
      findDefault: () => null,
      findSubmit: () => null,
      getState: () => 'active',
      nodeSignature: () => '',
    },
    CheckinState: { reconcile: () => null, prepare: () => null, nodeSignature: () => '' },
    QuestionMatcher: { normalize: (value) => String(value || '').replace(/\s+/g, ' ').trim() },
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
    get actionResults() {
      return actionResults;
    },
    get submitClicks() {
      return submitClicks;
    },
    setQuestionState(nextState) {
      questionState = nextState;
    },
  };
};

const checkinHarness = buildCheckinHarness();
assert.equal(typeof checkinHarness.runtimeListener, 'function', 'content script must register a runtime listener for check-in');

const checkinResponse = await new Promise((resolve) => {
  checkinHarness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId: 'checkin-done-1' } },
    {},
    resolve,
  );
});

assertRemoteAccepted(checkinResponse, 'dynamic completion check-in command must be accepted');
await waitFor(() => checkinHarness.actionResultCalls === 1, { timeoutMs: 1200, message: 'check-in ACTION_RESULT must be reported once' });
assert.equal(checkinHarness.defaultClicks, 1, 'remote check-in should click the default mood exactly once');
assert.equal(checkinHarness.submitClicks, 1, 'remote check-in should click the native submit exactly once');
assert.deepEqual(toPlain(checkinHarness.actionResults), [{
  actionId: 'checkin-done-1',
  action: 'checkin',
  status: 'success',
  reason: 'completed',
  pageKind: 'daily-checkin',
  url: 'https://www.1point3acres.com/next/daily-checkin',
}], 'dynamic completed text should report success/completed for check-in');
assert.equal(checkinHarness.actionResults.some((result) => result.status === 'failed'), false, 'check-in completion text must not report failed');
await delay(250);
assert.equal(checkinHarness.defaultClicks, 1, 'check-in must not click again after completion text appears');
assert.equal(checkinHarness.submitClicks, 1, 'check-in must not submit again after completion text appears');

const questionSuccessHarness = buildQuestionHarness({ completionText: '答题成功，获得大米' });
assert.equal(typeof questionSuccessHarness.runtimeListener, 'function', 'content script must register a runtime listener for question success');
const questionSuccessResponse = await new Promise((resolve) => {
  questionSuccessHarness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'question-done-1' } },
    {},
    resolve,
  );
});
assertRemoteAccepted(questionSuccessResponse, 'question completion-text command must be accepted');
await waitFor(() => questionSuccessHarness.actionResultCalls === 1, { timeoutMs: 1200, message: 'question success text should report ACTION_RESULT once' });
assert.equal(questionSuccessHarness.submitClicks, 1, 'question should click submit exactly once before completion text');
assert.deepEqual(toPlain(questionSuccessHarness.actionResults), [{
  actionId: 'question-done-1',
  action: 'question',
  status: 'success',
  reason: 'completed',
  pageKind: 'daily-question',
  url: 'https://www.1point3acres.com/next/daily-question',
}], '答题成功 should be treated as a completed remote question result');

const questionDoneHarness = buildQuestionHarness({ completionText: '今日已答题' });
assert.equal(typeof questionDoneHarness.runtimeListener, 'function', 'content script must register a runtime listener for already-done question');
const questionDoneResponse = await new Promise((resolve) => {
  questionDoneHarness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'question-done-2' } },
    {},
    resolve,
  );
});
assertRemoteAccepted(questionDoneResponse, 'already-done question command must be accepted');
await waitFor(() => questionDoneHarness.actionResultCalls === 1, { timeoutMs: 1200, message: '今日已答题 should report ACTION_RESULT once' });
assert.equal(questionDoneHarness.submitClicks, 1, 'question should not need a second submit to observe 今日已答题');
assert.deepEqual(toPlain(questionDoneHarness.actionResults), [{
  actionId: 'question-done-2',
  action: 'question',
  status: 'success',
  reason: 'completed',
  pageKind: 'daily-question',
  url: 'https://www.1point3acres.com/next/daily-question',
}], '今日已答题 should be treated as a completed remote question result');

console.log('checkin/question dynamic completion signal regression tests passed.');
