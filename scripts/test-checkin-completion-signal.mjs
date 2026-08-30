#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs
  .readFileSync(new URL('../src/content.js', import.meta.url), 'utf8')
  .replace('const REMOTE_ACTION_TIMEOUT_MS = 5000;', 'const REMOTE_ACTION_TIMEOUT_MS = 80;')
  .replace('const REMOTE_ACTION_RETRY_MS = 200;', 'const REMOTE_ACTION_RETRY_MS = 1;')
  .replace('const REMOTE_RESULT_TIMEOUT_MS = 16000;', 'const REMOTE_RESULT_TIMEOUT_MS = 2000;')
  .replace('const CAPTCHA_GRACE_PERIOD_MS = 10000;', 'const CAPTCHA_GRACE_PERIOD_MS = 20;')
  .replace('const REMOTE_RESULT_REPORT_DELAY_MS = 200;', 'const REMOTE_RESULT_REPORT_DELAY_MS = 1;')
  .replace('const QUESTION_SUBMIT_WAIT_MS = 4000;', 'const QUESTION_SUBMIT_WAIT_MS = 50;')
  .replace('const QUESTION_SUBMIT_POLL_MS = 100;', 'const QUESTION_SUBMIT_POLL_MS = 1;')
  .replace('}, 200);', '}, 1);');

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const asyncCallback = (callback, response) => {
  if (typeof callback === 'function') queueMicrotask(() => callback(response));
};
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
    shadowRoot: null,
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
      const selectors = String(selector || '').split(',').map((part) => part.trim()).filter(Boolean);
      let current = element;
      while (current) {
        for (const part of selectors) {
          if (part === 'main' && current.tagName === 'MAIN') return current;
          if (part === 'form' && current.tagName === 'FORM') return current;
          if (part.startsWith('#') && current.id === part.slice(1)) return current;
        }
        current = current.parentNode;
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
          if (selector.includes('input') && child.tagName === 'INPUT') found.push(child);
          if (selector.includes('textarea') && child.tagName === 'TEXTAREA') found.push(child);
          if (selector.includes('img') && child.tagName === 'IMG') found.push(child);
          if (selector.includes('iframe') && child.tagName === 'IFRAME') found.push(child);
          if (selector.includes('canvas') && child.tagName === 'CANVAS') found.push(child);
          if (selector.includes('[role="option"]') && child.getAttribute('role') === 'option') found.push(child);
          if (selector.includes('[class*="captcha"]') && /captcha/i.test(String(child.className || ''))) found.push(child);
          if (selector.includes('[id*="captcha"]') && /captcha/i.test(String(child.id || ''))) found.push(child);
          if (selector.includes('[name*="captcha"]') && /captcha/i.test(String(child.getAttribute?.('name') || ''))) found.push(child);
          if (selector.includes('[placeholder*="验证码"]') && /验证码/.test(String(child.getAttribute?.('placeholder') || ''))) found.push(child);
          if (selector.includes('[placeholder*="captcha" i]') && /captcha/i.test(String(child.getAttribute?.('placeholder') || ''))) found.push(child);
          if (selector.includes('[aria-label*="captcha" i]') && /captcha/i.test(String(child.getAttribute?.('aria-label') || ''))) found.push(child);
          if (selector.includes('[role="status"]') && child.getAttribute('role') === 'status') found.push(child);
          if (selector.includes('[role="alert"]') && child.getAttribute('role') === 'alert') found.push(child);
          if (selector.includes('[class*="toast"]') && /toast/i.test(String(child.className || ''))) found.push(child);
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
  let submitReady = true;

  const body = makeElement('body');
  const main = makeElement('main');
  body.appendChild(main);

  const defaultMood = makeElement('button', '没心情');
  defaultMood.click = () => {
    defaultClicks += 1;
    submitReady = false;
    queueMicrotask(() => { submitReady = true; });
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

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      sendMessage(message, callback) {
        if (message.type === 'ACTION_RESULT') {
          actionResultCalls += 1;
          actionResults.push(message.payload);
          asyncCallback(callback, { ok: true, accepted: true, actionId: message.payload?.actionId });
          return Promise.resolve({ ok: true, accepted: true, actionId: message.payload?.actionId });
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
      findSubmit: () => submitReady ? submit : null,
      getState: () => {
        if (checkinStateOverride) return checkinStateOverride;
        return /今日已签到|已经签到|今日签到已完成|already checked.?in|already signed/i.test(String(body.innerText || body.textContent || ''))
          ? 'completed'
          : 'active';
      },
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
    get toastText() {
      return document.getElementById('p3a-checkin-complete-toast')?.textContent || '';
    },
    setCheckinState(nextState) {
      checkinStateOverride = nextState;
    },
  };
};

const buildQuestionHarness = ({ completionText, noiseText = '', completionToastOutside = false }) => {
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
      if (completionToastOutside) {
        const toast = makeElement('div', completionText || '答题成功，获得大米');
        toast.setAttribute('role', 'status');
        toast.className = 'site-toast';
        body.appendChild(toast);
        return;
      }
      if (completionText != null) {
        main.innerText = completionText;
        main.textContent = completionText;
      }
      if (noiseText) {
        body.innerText = noiseText;
        body.textContent = noiseText;
      }
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

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      sendMessage(message, callback) {
        if (message.type === 'ACTION_RESULT') {
          actionResultCalls += 1;
          actionResults.push(message.payload);
          asyncCallback(callback, { ok: true, accepted: true, actionId: message.payload?.actionId });
          return Promise.resolve({ ok: true, accepted: true, actionId: message.payload?.actionId });
        }
        if (message.type === 'LOOKUP_QUESTION') {
          asyncCallback(callback, { ok: true, payload: { status: 'matched', matchType: 'exact', optionIndex: 2, answerText } });
          return Promise.resolve({ ok: true, payload: { status: 'matched', matchType: 'exact', optionIndex: 2, answerText } });
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
    get toastText() {
      return document.getElementById('p3a-checkin-complete-toast')?.textContent || '';
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
assert.equal(checkinHarness.toastText, '签到完成', 'check-in completion should show a page toast');
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
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'question-done-1', workflowId: 'workflow-done-1' } },
    {},
    resolve,
  );
});
assertRemoteAccepted(questionSuccessResponse, 'question completion-text command must be accepted');
await waitFor(() => questionSuccessHarness.actionResultCalls === 1, { timeoutMs: 1200, message: 'question success text should report ACTION_RESULT once' });
assert.equal(questionSuccessHarness.submitClicks, 1, 'question should click submit exactly once before completion text');
assert.equal(questionSuccessHarness.toastText, '签到和答题完成', 'completed workflow should show the combined page toast');
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
assert.equal(questionDoneHarness.toastText, '答题完成', 'standalone question completion should show an answer toast');
assert.deepEqual(toPlain(questionDoneHarness.actionResults), [{
  actionId: 'question-done-2',
  action: 'question',
  status: 'success',
  reason: 'completed',
  pageKind: 'daily-question',
  url: 'https://www.1point3acres.com/next/daily-question',
}], '今日已答题 should be treated as a completed remote question result');

const questionNoiseHarness = buildQuestionHarness({ completionText: '论坛正文仍然是题目内容', noiseText: '页面其他区域提示：今日已答题，获得大米' });
assert.equal(typeof questionNoiseHarness.runtimeListener, 'function', 'content script must register a runtime listener for noise regression');
const questionNoiseResponse = await new Promise((resolve) => {
  questionNoiseHarness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'question-noise-1' } },
    {},
    resolve,
  );
});
assertRemoteAccepted(questionNoiseResponse, 'noise regression command must be accepted');
await delay(350);
assert.equal(questionNoiseHarness.submitClicks, 1, 'noise text must not trigger an extra submit');
assert.equal(questionNoiseHarness.actionResults.some((result) => result.status === 'success' && result.reason === 'completed'), false, 'unrelated body success text must not be treated as completion');

const questionToastHarness = buildQuestionHarness({ completionToastOutside: true, completionText: '答题成功，获得大米' });
assert.equal(typeof questionToastHarness.runtimeListener, 'function', 'content script must register a runtime listener for portaled question toast');
const questionToastResponse = await new Promise((resolve) => {
  questionToastHarness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'question-toast-1' } },
    {},
    resolve,
  );
});
assertRemoteAccepted(questionToastResponse, 'portaled question toast command must be accepted');
await waitFor(() => questionToastHarness.actionResults.some((result) => result.status === 'success' && result.reason === 'completed'), { timeoutMs: 1200, message: '答题成功 toast outside main must complete the remote question wait' });
assert.equal(questionToastHarness.submitClicks, 1, 'portaled success toast must not trigger a second submit');

const buildCaptchaHarness = ({ actionId, captchaText = '请输入验证码后继续签到', decorate }) => {
  const body = makeElement('body');
  const outerMain = makeElement('main');
  const captchaMain = makeElement('main');
  body.appendChild(outerMain);
  outerMain.appendChild(captchaMain);
  outerMain.innerText = '页面侧栏提示：今日已签到，验证码规则说明';
  outerMain.textContent = outerMain.innerText;
  captchaMain.innerText = captchaText;
  captchaMain.textContent = captchaText;
  const submit = makeElement('button', '提交签到');
  submit.click = () => {};
  const defaultMood = makeElement('button', '没心情');
  captchaMain.appendChild(submit);
  captchaMain.appendChild(defaultMood);
  const noise = makeElement('aside', '今日已答题');
  outerMain.appendChild(noise);
  if (typeof decorate === 'function') decorate({ body, outerMain, captchaMain, submit, defaultMood });

  let runtimeListener = null;
  const actionResults = [];
  const context = {
    globalThis: {},
    document: {
      body,
      createElement: (tag) => makeElement(tag),
      getElementById: () => null,
      querySelector: (selector) => body.querySelector(selector),
      querySelectorAll: (selector) => body.querySelectorAll(selector),
    },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener(fn) { runtimeListener = fn; } },
        sendMessage(message, callback) {
          if (message.type === 'ACTION_RESULT') {
            actionResults.push(message.payload);
            asyncCallback(callback, { ok: true, accepted: true, actionId: message.payload?.actionId });
            return Promise.resolve({ ok: true, accepted: true, actionId: message.payload?.actionId });
          }
          asyncCallback(callback, { ok: true });
          return Promise.resolve({ ok: true });
        },
      },
    },
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
      createMessage(type, payload) { return { type, payload }; },
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
      getState: () => 'active',
      nodeSignature: () => '',
    },
    CheckinState: { reconcile: () => null, prepare: () => null, nodeSignature: () => '' },
    QuestionMatcher: { normalize: (value) => String(value || '').trim() },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
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
  return { actionId, runtimeListener, actionResults };
};

const runCaptchaScenario = async (name, options) => {
  const harness = buildCaptchaHarness({ actionId: `checkin-captcha-${name}`, ...options });
  const response = await new Promise((resolve) => {
    harness.runtimeListener(
      { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId: harness.actionId } },
      {},
      resolve,
    );
  });
  assertRemoteAccepted(response, `${name} captcha command must be accepted`);
  await waitFor(() => harness.actionResults.some((result) => result.reason === 'captcha-required'), { timeoutMs: 1200, message: `${name} captcha prompt should report captcha-required` });
  assert.equal(harness.actionResults.some((result) => result.reason === 'captcha-required' && result.status === 'failed'), true, `${name} captcha-required must be reported as failed`);
};

await runCaptchaScenario('input', {
  decorate: ({ captchaMain }) => {
    const input = makeElement('input');
    input.setAttribute('placeholder', '请输入验证码');
    captchaMain.appendChild(input);
  },
});

await runCaptchaScenario('iframe', {
  decorate: ({ captchaMain }) => {
    const iframe = makeElement('iframe');
    iframe.setAttribute('title', 'captcha challenge');
    captchaMain.appendChild(iframe);
  },
});

await runCaptchaScenario('image', {
  decorate: ({ captchaMain }) => {
    const image = makeElement('img');
    image.setAttribute('alt', '验证码图片');
    image.setAttribute('src', 'https://example.test/captcha.png');
    captchaMain.appendChild(image);
  },
});

await runCaptchaScenario('widget', {
  captchaText: '请完成安全验证后继续签到',
  decorate: ({ captchaMain }) => {
    const widget = makeElement('div');
    widget.className = 'geetest-container';
    widget.setAttribute('data-widget', 'captcha');
    captchaMain.appendChild(widget);
  },
});

await runCaptchaScenario('shadow-dom', {
  captchaText: '请完成人机验证后继续签到',
  decorate: ({ captchaMain }) => {
    const host = makeElement('div');
    host.setAttribute('data-widget', 'verification');
    host.shadowRoot = {
      children: [makeElement('iframe')],
      querySelector(selector) {
        return selector === '*' ? this.children[0] : null;
      },
    };
    captchaMain.appendChild(host);
  },
});

await runCaptchaScenario('success-text-with-captcha-input', {
  captchaText: '签到成功，请输入验证码完成验证',
  decorate: ({ captchaMain }) => {
    const input = makeElement('input');
    input.setAttribute('placeholder', '请输入验证码');
    captchaMain.appendChild(input);
  },
});

await runCaptchaScenario('success-text-with-captcha-widget', {
  captchaText: '今日已签到，请完成安全验证',
  decorate: ({ captchaMain }) => {
    const widget = makeElement('div');
    widget.className = 'captcha-widget';
    widget.setAttribute('data-widget', 'captcha');
    captchaMain.appendChild(widget);
  },
});

// Explicit error fast-path
{
  const harness = buildCaptchaHarness({
    actionId: 'checkin-captcha-explicit-error',
    captchaText: '安全验证失败，请重试',
  });
  const response = await new Promise((resolve) => {
    harness.runtimeListener(
      { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId: harness.actionId } },
      {},
      resolve,
    );
  });
  assertRemoteAccepted(response, 'explicit error command must be accepted');
  await waitFor(() => harness.actionResults.some((result) => result.reason === 'captcha-error'), { timeoutMs: 1200, message: 'explicit error should immediately report captcha-error' });
  assert.equal(harness.actionResults.some((result) => result.reason === 'captcha-error' && result.status === 'failed'), true);
}

// Auto-resolving Cloudflare Turnstile during grace period
{
  let targetIframe = null;
  let targetMain = null;
  const harness = buildCaptchaHarness({
    actionId: 'checkin-cloudflare-autoresolve',
    captchaText: '安全验证中',
    decorate: ({ captchaMain }) => {
      targetMain = captchaMain;
      targetIframe = makeElement('iframe');
      targetIframe.setAttribute('src', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/m0fkl/0x4AAAAAAADnPIDROrmt1Wwj/light/normal');
      captchaMain.appendChild(targetIframe);
    },
  });
  const response = await new Promise((resolve) => {
    harness.runtimeListener(
      { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId: harness.actionId } },
      {},
      resolve,
    );
  });
  assertRemoteAccepted(response, 'autoresolve command must be accepted');
  // Turnstile auto-resolves after 5ms in mock test and completion message appears
  setTimeout(() => {
    targetIframe?.remove();
    if (targetMain) {
      targetMain.innerText = '签到成功';
      targetMain.textContent = '签到成功';
    }
  }, 5);
  await waitFor(() => harness.actionResults.some((result) => result.status === 'success' && result.reason === 'completed'), { timeoutMs: 1200, message: 'autoresolved turnstile should complete with success' });
  assert.equal(harness.actionResults.some((result) => result.reason === 'captcha-required'), false, 'autoresolved turnstile must never trigger captcha-required');
}

// Persistent Cloudflare Turnstile "Verifying..." must not expire into
// captcha-required and yank a background tab. The live site leaves the
// widget mounted after submit; success text appears later.
{
  let targetIframe = null;
  let targetMain = null;
  const harness = buildCaptchaHarness({
    actionId: 'checkin-cloudflare-persistent-turnstile',
    captchaText: '正在验证...',
    decorate: ({ captchaMain }) => {
      targetMain = captchaMain;
      targetIframe = makeElement('iframe');
      targetIframe.setAttribute('src', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/m0fkl/0x4AAAAAAADnPIDROrmt1Wwj/light/normal');
      targetIframe.setAttribute('title', 'Verifying...');
      captchaMain.appendChild(targetIframe);
    },
  });
  const response = await new Promise((resolve) => {
    harness.runtimeListener(
      { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId: harness.actionId } },
      {},
      resolve,
    );
  });
  assertRemoteAccepted(response, 'persistent turnstile command must be accepted');
  await delay(80);
  assert.equal(harness.actionResults.some((result) => result.reason === 'captcha-required'), false, 'a verifying Turnstile that outlives the captcha grace period must not report captcha-required');
  setTimeout(() => {
    if (targetMain) {
      targetMain.innerText = '签到成功';
      targetMain.textContent = '签到成功';
    }
  }, 90);
  await waitFor(() => harness.actionResults.some((result) => result.status === 'success' && result.reason === 'completed'), { timeoutMs: 1200, message: 'persistent verifying Turnstile should still complete when success text appears later' });
  assert.equal(harness.actionResults.some((result) => result.reason === 'captcha-required'), false, 'late success after persistent Turnstile must not have reported captcha-required');
}

const buildFlushHarness = ({ href, storedResults, windowName = 'p3a-test-tab' }) => {
  let runtimeListener = null;
  const actionResults = [];
  const store = { 'p3a-pending-remote-results-v1': toPlain(storedResults) };
  const chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (value) => { Object.assign(store, value); },
      },
    },
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      sendMessage(message, callback) {
        if (message.type === 'ACTION_RESULT') actionResults.push(message.payload);
        asyncCallback(callback, { ok: true, accepted: true, actionId: message.payload?.actionId });
        return Promise.resolve({ ok: true, accepted: true, actionId: message.payload?.actionId });
      },
    },
  };
  const context = {
    globalThis: {},
    document: {
      body: makeElement('body'),
      createElement: (tag) => makeElement(tag),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    chrome,
    location: { href },
    window: null,
    ExtensionProtocol: {
      MESSAGE_TYPES: {
        RUN_ONE_CLICK: 'RUN_ONE_CLICK',
        LOOKUP_QUESTION: 'LOOKUP_QUESTION',
        CONTENT_READY: 'CONTENT_READY',
        ACTION_RESULT: 'ACTION_RESULT',
        SAVE_LEARNED_ANSWER: 'SAVE_LEARNED_ANSWER',
      },
      createMessage(type, payload) { return { type, payload }; },
    },
    DailyQuestionPage: {
      TOOLBAR_ID: 'p3a-daily-question-helper',
      isQuestionPage: (url) => String(url || '').includes('/next/daily-question'),
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
      isCheckinPage: (url) => String(url || '').includes('/next/daily-checkin'),
      findDefault: () => null,
      findSubmit: () => null,
      getState: () => 'active',
      nodeSignature: () => '',
    },
    CheckinState: { reconcile: () => null, prepare: () => null, nodeSignature: () => '' },
    QuestionMatcher: { normalize: (value) => String(value || '').trim() },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
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
  context.window.name = windowName;
  vm.runInNewContext(source, context);
  return { runtimeListener, actionResults, store };
};

const sharedTabName = 'p3a-tab-p3a-test-tab';
const storedAt = Date.now();
const questionRecord = {
  actionId: 'flushQuestion',
  action: 'question',
  status: 'success',
  reason: 'completed',
  pageKind: 'daily-question',
  taskUrl: 'https://www.1point3acres.com/next/daily-question',
  tabIdentity: sharedTabName,
  updatedAt: storedAt,
  url: 'https://www.1point3acres.com/next/daily-question',
};
const checkinRecord = {
  actionId: 'flushCheckin',
  action: 'checkin',
  status: 'success',
  reason: 'completed',
  pageKind: 'daily-checkin',
  taskUrl: 'https://www.1point3acres.com/next/daily-checkin',
  tabIdentity: sharedTabName,
  updatedAt: storedAt,
  url: 'https://www.1point3acres.com/next/daily-checkin',
};

const wrongPageQuestionHarness = buildFlushHarness({
  href: 'https://www.1point3acres.com/next/daily-checkin',
  windowName: sharedTabName,
  storedResults: { flushQuestion: questionRecord },
});
await delay(20);
assert.equal(typeof wrongPageQuestionHarness.runtimeListener, 'function', 'content script must register on check-in page');
assert.deepEqual(toPlain(wrongPageQuestionHarness.actionResults), [], 'question result must not flush on check-in page');
assert.deepEqual(toPlain(wrongPageQuestionHarness.store['p3a-pending-remote-results-v1']), toPlain({ flushQuestion: { ...questionRecord, url: undefined } }), 'question result must be preserved without the live URL');

const wrongPageCheckinHarness = buildFlushHarness({
  href: 'https://www.1point3acres.com/next/daily-question',
  windowName: sharedTabName,
  storedResults: { flushCheckin: checkinRecord },
});
await delay(20);
assert.equal(typeof wrongPageCheckinHarness.runtimeListener, 'function', 'content script must register on question page');
assert.deepEqual(toPlain(wrongPageCheckinHarness.actionResults), [], 'check-in result must not flush on question page');
assert.deepEqual(toPlain(wrongPageCheckinHarness.store['p3a-pending-remote-results-v1']), toPlain({ flushCheckin: { ...checkinRecord, url: undefined } }), 'check-in result must be preserved without the live URL');

const samePageHarness = buildFlushHarness({
  href: 'https://www.1point3acres.com/next/daily-checkin',
  windowName: sharedTabName,
  storedResults: { flushCheckin: checkinRecord },
});
await waitFor(() => samePageHarness.actionResults.length === 1, { timeoutMs: 1200, message: 'matching check-in result should flush once' });
assert.deepEqual(toPlain(samePageHarness.actionResults), [{
  actionId: 'flushCheckin',
  action: 'checkin',
  status: 'success',
  reason: 'completed',
  pageKind: 'daily-checkin',
  url: 'https://www.1point3acres.com/next/daily-checkin',
}], 'matching check-in result should ACK once');
assert.deepEqual(toPlain(samePageHarness.store['p3a-pending-remote-results-v1']), {}, 'matching check-in result should be cleared after ACK');

console.log('checkin/question dynamic completion signal regression tests passed.');
