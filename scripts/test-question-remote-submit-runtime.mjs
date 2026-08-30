#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs
  .readFileSync(new URL('../src/content.js', import.meta.url), 'utf8')
  .replace('const REMOTE_ACTION_TIMEOUT_MS = 5000;', 'const REMOTE_ACTION_TIMEOUT_MS = 80;')
  .replace('const QUESTION_READY_TIMEOUT_MS = 5000;', 'const QUESTION_READY_TIMEOUT_MS = 30;')
  .replace('const REMOTE_ACTION_RETRY_MS = 200;', 'const REMOTE_ACTION_RETRY_MS = 1;')
  .replace('const REMOTE_RESULT_TIMEOUT_MS = 16000;', 'const REMOTE_RESULT_TIMEOUT_MS = 50;')
  .replace('const CAPTCHA_GRACE_PERIOD_MS = 10000;', 'const CAPTCHA_GRACE_PERIOD_MS = 20;')
  .replace('const QUESTION_SUBMIT_WAIT_MS = 4000;', 'const QUESTION_SUBMIT_WAIT_MS = 50;')
  .replace('const QUESTION_SUBMIT_POLL_MS = 100;', 'const QUESTION_SUBMIT_POLL_MS = 1;')
  .replace('const QUESTION_LOOKUP_RESPONSE_TIMEOUT_MS = 1500;', 'const QUESTION_LOOKUP_RESPONSE_TIMEOUT_MS = 10;')
  .replace('const QUESTION_LOOKUP_RETRY_DELAY_MS = 250;', 'const QUESTION_LOOKUP_RETRY_DELAY_MS = 1;')
  .replace('}, 180);', '}, 1);');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

const buildQuestionHarness = ({ questionText, changedAfterReads = Infinity, lookupTimeouts = 0, lookupStatus = 'matched', lookupReason = null, lookupMatchType = 'exact', hydrateOptionsAfterReads = 0, lookupDependsOnVisibleAnswer = false } = {}) => {
  const answerText = '这些都有';
  const main = makeElement('main');
  const questionNode = makeElement('div', questionText);
  let selectedNode = null;
  let questionReads = 0;
  let submitClicks = 0;
  let toolbarClicks = 0;
  let lookupCallCount = 0;
  const lookupTimeline = [];
  const actionResults = [];
  let renderLookupRequestedAt = null;
  let renderLookupResolvedAt = null;
  let submitClickedAt = null;
  let questionState = 'active';

  const optionNodes = [
    '美国大学各专业录取信息，留学途中的问题',
    '各公司工作情况，面试信息，薪资水平，职场发展。',
    answerText,
    '投资理财、购置房产',
  ].map((text) => {
    const node = makeElement('button', text);
    node.className = 'cursor-pointer rounded-md px-2.5 py-1.5 bg-gray-200 hover:bg-gray-300';
    node.addEventListener('click', () => {
      for (const other of optionNodes) {
        other.className = other === node ? 'rounded-md cursor-pointer bg-primary' : 'rounded-md cursor-pointer';
      }
      selectedNode = node;
    });
    return node;
  });

  optionNodes[2].className = 'rounded-md cursor-pointer bg-primary';
  selectedNode = optionNodes[2];

  const submitButton = makeElement('button', '提交答案');
  submitButton.setAttribute('type', 'submit');
  submitButton.click = () => {
    submitClicks += 1;
    submitClickedAt = Date.now();
    questionState = 'completed';
    body.innerText = '答题成功，获得大米';
  };

  main.append(questionNode, ...optionNodes, submitButton);
  const fakeToolbarButton = makeElement('button', '一键答题');
  fakeToolbarButton.click = () => {
    toolbarClicks += 1;
  };

  const body = makeElement('body');
  body.append(main);

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
    querySelector: (selector) => document.querySelectorAll(selector)[0] || null,
    querySelectorAll(selector) {
      if (selector === '.p3a-action') return [fakeToolbarButton];
      return body.querySelectorAll(selector);
    },
  };

  const lookupResponse = { ok: true, payload: { status: lookupStatus, ...(lookupReason ? { reason: lookupReason } : {}), matchType: lookupMatchType, optionIndex: 2, answerText } };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeListener = fn; } },
      sendMessage(message, callback) {
        lookupTimeline.push({ type: message.type, at: Date.now(), message });
        const respond = (response) => {
          if (typeof callback === 'function') {
            callback(response);
            return undefined;
          }
          return Promise.resolve(response);
        };

        if (message.type === 'LOOKUP_QUESTION') {
          lookupCallCount += 1;
          if (renderLookupRequestedAt === null) renderLookupRequestedAt = Date.now();
          if (lookupCallCount <= lookupTimeouts) return undefined;
          if (lookupDependsOnVisibleAnswer) {
            const visible = questionPage.findOptions().map(questionPage.clean);
            if (!visible.includes(answerText)) {
              return respond({ ok: true, payload: { status: 'unmatched', reason: 'answer-not-visible' } });
            }
          }
          renderLookupResolvedAt = Date.now();
          return respond(lookupResponse);
        }

        if (message.type === 'CONTENT_READY' || message.type === 'SAVE_LEARNED_ANSWER' || message.type === 'ACTION_RESULT') {
          if (message.type === 'ACTION_RESULT') actionResults.push(message.payload);
          return respond({ ok: true });
        }

        return respond({ ok: true });
      },
    },
  };

  const questionPage = {
    TOOLBAR_ID: 'p3a-daily-question-helper',
    clean: (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim(),
    isQuestionPage: () => true,
    findQuestionContainer: () => main,
    findQuestion: () => {
      questionReads += 1;
      return {
        node: questionNode,
        value: questionReads <= changedAfterReads ? questionText : '另一道题',
      };
    },
    findOptions: () => {
      if (hydrateOptionsAfterReads > 0 && questionReads <= hydrateOptionsAfterReads) {
        return optionNodes.slice(0, 2);
      }
      return optionNodes;
    },
    findSelectedOption: () => selectedNode,
    findSubmit: () => submitButton,
    getState: () => questionState,
  };

  const checkinPage = {
    TOOLBAR_ID: 'p3a-daily-checkin-helper',
    isCheckinPage: () => false,
    findDefault: () => null,
    findSubmit: () => null,
    getState: () => 'active',
  };

  let runtimeListener = null;
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
    DailyQuestionPage: questionPage,
    DailyCheckinPage: checkinPage,
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
    console,
  };
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(source, context);

  return {
    chrome,
    document,
    runtimeListener,
    questionPage,
    get submitClicks() {
      return submitClicks;
    },
    get submitClickedAt() {
      return submitClickedAt;
    },
    get toolbarClicks() {
      return toolbarClicks;
    },
    get lookupCallCount() {
      return lookupCallCount;
    },
    get lookupTimeline() {
      return lookupTimeline;
    },
    get renderLookupRequestedAt() {
      return renderLookupRequestedAt;
    },
    get renderLookupResolvedAt() {
      return renderLookupResolvedAt;
    },
    allowMatchedLookup: true,
    get runtimeListenerFn() {
      return runtimeListener;
    },
    get actionResults() {
      return actionResults;
    },
  };
};

const assertResponse = (response, message) => {
  assert.equal(response?.ok, true, message);
  assert.equal(response?.accepted, true, message);
};

const primary = buildQuestionHarness({ questionText: '一亩三分地里有哪些方面的干货信息？', changedAfterReads: Infinity });
await waitFor(() => primary.runtimeListenerFn, { message: 'content script must register a runtime listener' });
assert(primary.runtimeListenerFn, 'content script must register a runtime listener');

const responsePromise = new Promise((resolve) => {
  primary.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-1' } },
    {},
    (response) => resolve(response),
  );
});

await responsePromise.then((response) => assertResponse(response, 'remote question command must be accepted'));
await waitFor(() => primary.submitClicks === 1, { message: 'remote question flow should eventually click the native submit' });
assert.equal(primary.toolbarClicks, 0, 'remote question flow must not click the toolbar button');
assert.equal(primary.submitClicks, 1, 'remote question flow must click the native site submit exactly once');
assert(primary.submitClickedAt !== null, 'submit click timestamp should be recorded');
assert(primary.lookupCallCount >= 1, 'remote question flow should consult the answer bank before submit');

{
  let responded = false;
  const keepChannel = primary.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'everything' } },
    {},
    () => { responded = true; },
  );
  assert.equal(keepChannel, false, 'popup everything must not be answered by the content script');
  assert.equal(responded, false, 'popup everything must not call sendResponse in the content script');
}

{
  let responded = false;
  const keepChannel = primary.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question' } },
    {},
    () => { responded = true; },
  );
  assert.equal(keepChannel, false, 'popup question without actionId must not be answered by the content script');
  assert.equal(responded, false);
}

const duplicate = await new Promise((resolve) => {
  primary.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-1' } },
    {},
    (response) => resolve(response),
  );
});
assert.equal(duplicate.ok, true, 'duplicate remote action should be accepted');
assert.equal(duplicate.accepted, true, 'duplicate remote action should be accepted');
assert.equal(duplicate.duplicate, true, 'duplicate remote action should be deduped');
assert.equal(primary.submitClicks, 1, 'duplicate action must not submit again');

const fuzzy = buildQuestionHarness({ questionText: '一亩三分地里有哪些方面的干货信息？', lookupMatchType: 'fuzzy' });
await waitFor(() => fuzzy.runtimeListenerFn, { message: 'fuzzy harness should register a runtime listener' });
const fuzzyResponse = new Promise((resolve) => {
  fuzzy.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-fuzzy' } },
    {},
    (response) => resolve(response),
  );
});
await fuzzyResponse.then((response) => assertResponse(response, 'fuzzy remote command must be accepted before validation'));
await waitFor(() => fuzzy.actionResults.length >= 1, { message: 'fuzzy match must report a confirmation-required failure' });
assert.equal(fuzzy.submitClicks, 0, 'fuzzy match must never submit automatically');
assert.equal(fuzzy.actionResults[0]?.reason, 'question-fuzzy-match-requires-confirmation', 'fuzzy match must use the confirmation-required reason');

const invisibleAnswer = buildQuestionHarness({ questionText: '一亩三分地里有哪些方面的干货信息？', lookupStatus: 'unmatched', lookupReason: 'answer-not-visible' });
await waitFor(() => invisibleAnswer.runtimeListenerFn, { message: 'answer-not-visible harness should register a runtime listener' });
const invisibleResponse = new Promise((resolve) => {
  invisibleAnswer.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-answer-not-visible' } },
    {},
    (response) => resolve(response),
  );
});
await invisibleResponse.then((response) => assertResponse(response, 'answer-not-visible remote command must be accepted before validation'));
await waitFor(() => invisibleAnswer.actionResults.length >= 1, { message: 'answer-not-visible match must report a safety failure' });
assert.equal(invisibleAnswer.submitClicks, 0, 'answer-not-visible must never submit automatically');
assert.equal(invisibleAnswer.actionResults[0]?.reason, 'answer-not-visible', 'answer-not-visible reason must be preserved');

const guard = buildQuestionHarness({ questionText: '一亩三分地里有哪些方面的干货信息？', changedAfterReads: 1 });
await waitFor(() => guard.runtimeListenerFn, { message: 'guard harness should register a runtime listener' });
const guardResponse = new Promise((resolve) => {
  guard.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-2' } },
    {},
    (response) => resolve(response),
  );
});
await guardResponse.then((response) => assertResponse(response, 'guarded remote command must be accepted'));
await waitFor(() => guard.submitClicks === 1, { message: 'a later stable snapshot must be allowed to submit after the first paint changes' });
assert.equal(guard.submitClicks, 1, 'question hydration/change inside the wait window must re-stabilize and submit');

const hydrate = buildQuestionHarness({
  questionText: '一亩三分地里有哪些方面的干货信息？',
  hydrateOptionsAfterReads: 1,
});
await waitFor(() => hydrate.runtimeListenerFn, { message: 'hydrate harness should register a runtime listener' });
const hydrateResponse = new Promise((resolve) => {
  hydrate.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-hydrate' } },
    {},
    (response) => resolve(response),
  );
});
await hydrateResponse.then((response) => assertResponse(response, 'hydrating options must be accepted'));
await waitFor(() => hydrate.submitClicks === 1, { message: '2-then-4 option hydration must re-stabilize and submit' });
assert.equal(hydrate.submitClicks, 1, 'option hydration inside the 5s window must not abort auto-submit');

const lateAnswer = buildQuestionHarness({
  questionText: '在一亩三分地发帖，需要遵守哪些规则？',
  hydrateOptionsAfterReads: 4,
  lookupDependsOnVisibleAnswer: true,
});
await waitFor(() => lateAnswer.runtimeListenerFn, { message: 'late-answer harness should register a runtime listener' });
const lateAnswerResponse = new Promise((resolve) => {
  lateAnswer.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-late-answer' } },
    {},
    (response) => resolve(response),
  );
});
await lateAnswerResponse.then((response) => assertResponse(response, 'late-appearing bank answer must be accepted'));
await waitFor(() => lateAnswer.submitClicks === 1, { message: 'a first-stable snapshot missing the bank answer must keep waiting and submit after the option appears' });
assert.equal(lateAnswer.submitClicks, 1, 'answer-not-visible during the readiness window must not abort auto-submit');

const notReady = buildQuestionHarness({ questionText: '', changedAfterReads: Infinity });
await waitFor(() => notReady.runtimeListenerFn, { message: 'not-ready harness should register a runtime listener' });
const notReadyResponse = new Promise((resolve) => {
  notReady.runtimeListenerFn(
    { type: 'RUN_ONE_CLICK', payload: { action: 'question', actionId: 'remote-3' } },
    {},
    (response) => resolve(response),
  );
});
await notReadyResponse.then((response) => assertResponse(response, 'not-ready remote command must be accepted'));
await waitFor(() => notReady.actionResults.length >= 1, { message: 'not-ready question must report a failed ACTION_RESULT' });
assert.equal(notReady.submitClicks, 0, 'question not ready within the readiness window must not submit');
assert.equal(notReady.actionResults[0]?.actionId, 'remote-3', 'question not ready should keep the original action id');
assert.equal(notReady.actionResults[0]?.action, 'question', 'question not ready should report the question action');
assert.equal(notReady.actionResults[0]?.status, 'failed', 'question not ready should report failure');
assert.equal(notReady.actionResults[0]?.reason, 'question-not-ready', 'question not ready within the readiness window should fail without submitting');

const delayedLookup = buildQuestionHarness({
  questionText: '一亩三分地里有哪些方面的干货信息？',
  changedAfterReads: Infinity,
  lookupTimeouts: 1,
});
await waitFor(() => {
  const toolbar = delayedLookup.document.getElementById('p3a-daily-question-helper');
  return toolbar?.querySelectorAll('button').some((node) => node.textContent === '一键答题');
}, { timeoutMs: 500, message: 'initial page render must retry a timed-out answer lookup' });
assert(delayedLookup.lookupCallCount >= 2, 'initial page render must retry the background answer lookup');
assert(delayedLookup.renderLookupResolvedAt !== null, 'a later answer lookup must recover the initial render');

const noCallbackHarness = buildQuestionHarness({ questionText: '一亩三分地里有哪些方面的干货信息？', changedAfterReads: Infinity });
const noCallbackResult = noCallbackHarness.chrome.runtime.sendMessage({ type: 'CONTENT_READY' });
assert.equal(typeof noCallbackResult?.then, 'function', 'sendMessage without callback should return a promise-like value');
await noCallbackResult;

console.log('question remote submit runtime tests passed.');
