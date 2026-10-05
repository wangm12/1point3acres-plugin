#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mockTrustedSubmitTransport } from './helpers/mock-trusted-submit.mjs';

const source = `${fs
  .readFileSync(new URL('../src/content.js', import.meta.url), 'utf8')
  .replace('const REMOTE_ACTION_TIMEOUT_MS = 5000;', 'const REMOTE_ACTION_TIMEOUT_MS = 80;')
  .replace('const REMOTE_ACTION_RETRY_MS = 200;', 'const REMOTE_ACTION_RETRY_MS = 1;')
  .replace('const REMOTE_RESULT_TIMEOUT_MS = 16000;', 'const REMOTE_RESULT_TIMEOUT_MS = 400;')
  .replace('const CAPTCHA_GRACE_PERIOD_MS = 10000;', 'const CAPTCHA_GRACE_PERIOD_MS = 20;')
  .replace('const REMOTE_RESULT_REPORT_DELAY_MS = 200;', 'const REMOTE_RESULT_REPORT_DELAY_MS = 1;')
  .replace('const CHECKIN_SUBMIT_WAIT_MS = 2000;', 'const CHECKIN_SUBMIT_WAIT_MS = 50;')
  .replace('const CHECKIN_SUBMIT_POLL_MS = 100;', 'const CHECKIN_SUBMIT_POLL_MS = 1;')
  .replace('}, 180);', '}, 1);')
  .replace('}, 200);', '}, 1);')}
this.__runCheckinAction = runCheckinAction;
this.__getLocalCheckinSubmitInFlight = () => (typeof localCheckinSubmitInFlight === 'undefined' ? false : localCheckinSubmitInFlight);
this.__getCheckinActionKey = () => (typeof checkinActionKey === 'undefined' ? null : checkinActionKey);
this.__clearCheckinPrepared = () => { checkinPrepared = null; };
this.__renderCheckin = renderCheckin;
`;

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
    children: [],
    parentNode: null,
    attributes: Object.create(null),
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
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
          if (selector.includes('[role="status"]') && child.getAttribute('role') === 'status') found.push(child);
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

const checkinNodeSignature = (node) => {
  if (!node) return '';
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const attrs = ['name', 'id', 'value', 'data-value', 'data-qdxq', 'aria-label']
    .map((name) => `${name}=${clean(node.getAttribute?.(name))}`).join('|');
  return `${clean(node.textContent)}|${attrs}`;
};

const buildCheckinHarness = ({ holdSubmitResult = false, autoStart = false, preselected = true, submitInitiallyReady = true, challenge = null, initialState = 'active' } = {}) => {
  let runtimeListener = null;
  const actionResults = [];
  let defaultClicks = 0;
  let submitClicks = 0;
  let submitReady = submitInitiallyReady;

  const body = makeElement('body');
  const main = makeElement('main');
  body.appendChild(main);

  const defaultMood = makeElement('button', '没心情');
  if (preselected) {
    defaultMood.setAttribute('aria-checked', 'true');
    defaultMood.className = 'bg-primary';
  }
  defaultMood.click = () => {
    defaultClicks += 1;
    defaultMood.setAttribute('aria-checked', 'true');
  };
  if (challenge) {
    const iframe = makeElement('iframe');
    iframe.setAttribute('src', 'https://challenges.cloudflare.com/turnstile');
    iframe.setAttribute('title', challenge);
    main.appendChild(iframe);
  }
  const submit = makeElement('button', '提交签到');
  const completeCheckin = () => {
    body.innerText = '今日已签到，不能重复签到';
    body.textContent = body.innerText;
  };
  submit.click = () => {
    submitClicks += 1;
    if (!holdSubmitResult) queueMicrotask(completeCheckin);
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
      isDefaultSelected: (node = defaultMood) => node?.getAttribute?.('aria-checked') === 'true' || /(?:^|\s)bg-primary(?:\s|$)/.test(String(node?.className || '')),
      findSubmit: () => submitReady ? submit : null,
      getState: () => initialState !== 'active' ? initialState : (/今日已签到|已经签到|今日签到已完成|already checked.?in|already signed/i.test(String(body.innerText || body.textContent || ''))
        ? 'completed'
        : 'active'),
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
  context.trustedSubmit = mockTrustedSubmitTransport(context);

  vm.runInNewContext(source, context);
  // Isolate manual-entry regressions from the separately tested page-load path.
  if (!autoStart) vm.runInNewContext('checkinAutoSubmitAttempt = `${location.href}|${CheckinState.nodeSignature(DailyCheckinPage.findDefault())}`;', context);

  return {
    document,
    context,
    get runtimeListener() {
      return runtimeListener;
    },
    get defaultClicks() {
      return defaultClicks;
    },
    get submitClicks() {
      return submitClicks;
    },
    get actionResults() {
      return actionResults;
    },
    get localCheckinSubmitInFlight() {
      return context.__getLocalCheckinSubmitInFlight?.() === true;
    },
    get checkinActionKey() {
      return context.__getCheckinActionKey?.() ?? null;
    },
    setSubmitReady(ready) {
      submitReady = ready === true;
    },
    clearCheckinPrepared() {
      context.__clearCheckinPrepared?.();
    },
    runLocalCheckinAction() {
      return context.__runCheckinAction();
    },
    renderCheckin() {
      context.__renderCheckin();
    },
    findToolbarOneClick() {
      const bar = document.getElementById('p3a-daily-checkin-helper');
      return (bar?.querySelectorAll?.('button') || []).find((node) => node.textContent === '一键签到') || null;
    },
    completeCheckin,
  };
};

const assertRemoteAccepted = (response, message) => {
  assert.equal(response?.ok, true, message);
  assert.equal(response?.accepted, true, message);
};

const sendRemoteCheckin = (harness, actionId) => new Promise((resolve) => {
  harness.runtimeListener(
    { type: 'RUN_ONE_CLICK', payload: { action: 'checkin', actionId } },
    {},
    resolve,
  );
});

{
  const harness = buildCheckinHarness({ autoStart: true, preselected: false });
  await waitFor(() => harness.submitClicks === 1 && !harness.localCheckinSubmitInFlight, { message: 'opening a captcha-free page must automatically submit and finish' });
  assert.equal(harness.defaultClicks, 1, 'automatic check-in must select the default mood once');
  harness.renderCheckin();
  assert.equal(harness.submitClicks, 1, 'completed page rerenders must not submit again');
  assert.equal(harness.actionResults.length, 0, 'local automatic check-in must not invent a remote action');
}

{
  const harness = buildCheckinHarness({ autoStart: true, submitInitiallyReady: false });
  await waitFor(() => harness.localCheckinSubmitInFlight, { message: 'automatic check-in must wait for the site button' });
  harness.setSubmitReady(true);
  await waitFor(() => harness.submitClicks === 1 && !harness.localCheckinSubmitInFlight, { message: 'automatic check-in must submit after the button becomes ready' });
  assert.equal(harness.defaultClicks, 0, 'already-selected default mood must not be toggled');
}

{
  const harness = buildCheckinHarness({ autoStart: true, holdSubmitResult: true });
  await waitFor(() => harness.submitClicks === 1, { message: 'automatic check-in must submit without a toolbar click' });
  harness.renderCheckin();
  harness.findToolbarOneClick().click();
  await harness.runLocalCheckinAction();
  const response = await sendRemoteCheckin(harness, 'remote-join-page-auto');
  assertRemoteAccepted(response, 'popup must join a page automatic check-in');
  await delay(20);
  assert.equal(harness.submitClicks, 1, 'rerender, toolbar and popup must share the automatic submission');
  harness.completeCheckin();
  await waitFor(() => harness.actionResults.some((result) => result.actionId === 'remote-join-page-auto' && result.status === 'success'), { message: 'popup must receive the automatic submission result' });
  await waitFor(() => !harness.localCheckinSubmitInFlight);
}

{
  const harness = buildCheckinHarness({ autoStart: true, challenge: 'Verify you are human' });
  await waitFor(() => harness.findToolbarOneClick() && !harness.localCheckinSubmitInFlight);
  assert.equal(harness.submitClicks, 0, 'interactive verification must block automatic submission');
  harness.renderCheckin();
  assert.equal(harness.localCheckinSubmitInFlight, false, 'rerender must not restart a blocked automatic attempt');
  assert.equal(harness.submitClicks, 0);
}

{
  const harness = buildCheckinHarness({ autoStart: true, challenge: 'Widget containing a Cloudflare security challenge' });
  await waitFor(() => harness.submitClicks === 1 && !harness.localCheckinSubmitInFlight, { message: 'passive Turnstile metadata must not block automatic check-in' });
}

{
  const harness = buildCheckinHarness({ autoStart: true, holdSubmitResult: true });
  await waitFor(() => harness.submitClicks === 1 && !harness.localCheckinSubmitInFlight, { timeoutMs: 1000, message: 'unconfirmed automatic check-in must time out' });
  harness.renderCheckin();
  await delay(20);
  assert.equal(harness.submitClicks, 1, 'timeout plus rerender must not retry automatically');
  harness.findToolbarOneClick().click();
  await waitFor(() => harness.submitClicks === 2, { message: 'manual retry must remain available after timeout' });
  harness.completeCheckin();
  await waitFor(() => !harness.localCheckinSubmitInFlight);
}

for (const initialState of ['completed', 'requires-login']) {
  const harness = buildCheckinHarness({ autoStart: true, initialState });
  await delay(10);
  assert.equal(harness.defaultClicks, 0, `${initialState} page must not select a mood`);
  assert.equal(harness.submitClicks, 0, `${initialState} page must not submit`);
}

{
  const harness = buildCheckinHarness({ autoStart: true, holdSubmitResult: true });
  const response = await sendRemoteCheckin(harness, 'remote-timeout-before-page-auto');
  assertRemoteAccepted(response, 'popup check-in arriving before page render must be accepted');
  await waitFor(() => harness.actionResults.some((result) => result.actionId === 'remote-timeout-before-page-auto' && result.reason === 'timeout'), { timeoutMs: 1000, message: 'popup check-in must report its timeout' });
  harness.renderCheckin();
  await delay(20);
  assert.equal(harness.submitClicks, 1, 'page automatic path must not resubmit after a popup timeout');
  assert.equal(harness.localCheckinSubmitInFlight, false, 'popup failure must leave automatic page submission stopped');
}

{
  const harness = buildCheckinHarness({ holdSubmitResult: true });
  await waitFor(() => typeof harness.runtimeListener === 'function', { message: 'content script must register a runtime listener' });
  await waitFor(() => harness.findToolbarOneClick(), { message: 'check-in toolbar must render before the local submit' });

  const localPromise = harness.runLocalCheckinAction();
  await waitFor(() => harness.submitClicks === 1, { message: 'local check-in must click the site submit once' });
  assert.equal(harness.localCheckinSubmitInFlight, true, 'local runCheckinAction must set localCheckinSubmitInFlight');

  const remoteResponse = await sendRemoteCheckin(harness, 'remote-join-local-checkin');
  assertRemoteAccepted(remoteResponse, 'remote check-in arriving during a local submit must be accepted');
  await delay(20);
  assert.equal(harness.submitClicks, 1, 'remote check-in must not submit again while localCheckinSubmitInFlight is true');

  harness.completeCheckin();
  await waitFor(
    () => harness.actionResults.some((result) => result.actionId === 'remote-join-local-checkin' && result.status === 'success'),
    { timeoutMs: 500, message: 'remote check-in must inherit the in-flight local submit result' },
  );
  assert.equal(harness.submitClicks, 1, 'joining a local check-in must keep a single site submit');
  assert.equal(harness.actionResults[0]?.action, 'checkin', 'joined remote result must stay on the checkin action');
  await localPromise;
}

{
  const harness = buildCheckinHarness({ holdSubmitResult: true });
  await waitFor(() => typeof harness.runtimeListener === 'function', { message: 'toolbar harness must register a runtime listener' });
  const oneClick = await waitFor(() => harness.findToolbarOneClick(), { message: 'toolbar 一键签到 must be available' });
  oneClick.click();
  await waitFor(() => harness.submitClicks === 1 && harness.checkinActionKey, { message: 'toolbar 一键签到 must submit and record checkinActionKey' });

  const remoteResponse = await sendRemoteCheckin(harness, 'remote-join-toolbar-checkin');
  assertRemoteAccepted(remoteResponse, 'remote check-in arriving after toolbar submit must be accepted');
  await delay(20);
  assert.equal(harness.submitClicks, 1, 'remote check-in must not submit again when checkinActionKey is already set');

  harness.completeCheckin();
  await waitFor(
    () => harness.actionResults.some((result) => result.actionId === 'remote-join-toolbar-checkin' && result.status === 'success'),
    { timeoutMs: 500, message: 'remote check-in must inherit the toolbar submit result even if the in-flight flag is clear' },
  );
  assert.equal(harness.submitClicks, 1, 'joining a toolbar check-in must keep a single site submit');
}

{
  const harness = buildCheckinHarness({ holdSubmitResult: true });
  await waitFor(() => typeof harness.runtimeListener === 'function', { message: 'fail-forward harness must register a runtime listener' });
  harness.setSubmitReady(false);
  const localPromise = harness.runLocalCheckinAction();
  await waitFor(() => harness.localCheckinSubmitInFlight === true, { message: 'local check-in must be in flight before a remote joins' });
  const remoteResponse = await sendRemoteCheckin(harness, 'remote-join-local-checkin-fail');
  assertRemoteAccepted(remoteResponse, 'remote check-in arriving during a failing local submit must be accepted');
  const joinedAt = Date.now();
  await waitFor(
    () => harness.actionResults.some((result) => result.actionId === 'remote-join-local-checkin-fail'),
    { timeoutMs: 400, message: 'joined remote must receive ACTION_RESULT when local check-in fails' },
  );
  const elapsedMs = Date.now() - joinedAt;
  const result = harness.actionResults.find((entry) => entry.actionId === 'remote-join-local-checkin-fail');
  assert.equal(result?.action, 'checkin', 'joined remote must keep the checkin action');
  assert.equal(result?.status, 'failed', 'joined remote must fail with the local check-in');
  assert.equal(result?.reason, 'submit-not-found', 'joined remote must reuse the local submit-not-found reason');
  assert.ok(elapsedMs < 200, `joined remote must finish well under REMOTE_RESULT_TIMEOUT_MS, took ${elapsedMs}ms`);
  await localPromise;
}

{
  const harness = buildCheckinHarness();
  await waitFor(() => harness.findToolbarOneClick(), { message: 'toolbar skip-click harness must render 一键签到' });
  const clicksBefore = harness.defaultClicks;
  harness.clearCheckinPrepared();
  harness.findToolbarOneClick().click();
  await waitFor(() => harness.submitClicks === 1, { message: 'toolbar 一键签到 must still submit when the mood is already selected' });
  assert.equal(harness.defaultClicks, clicksBefore, 'toolbar 一键签到 must not re-click an already selected default mood');
  await waitFor(() => harness.document.getElementById('p3a-daily-checkin-helper')?.children.some((node) => node.textContent === '今日已签到，不能重复签到'), { message: 'manual completion must refresh toolbar status after the in-flight flag clears' });
}

{
  const harness = buildCheckinHarness({ holdSubmitResult: true });
  const confirm = await waitFor(() => harness.document.getElementById('p3a-daily-checkin-helper')?.children.find((node) => node.textContent === '确认并签到'));
  confirm.click();
  await waitFor(() => harness.submitClicks === 1);
  confirm.click();
  harness.findToolbarOneClick().click();
  const response = await sendRemoteCheckin(harness, 'checkin-join-manual-confirm');
  assertRemoteAccepted(response, 'popup must join manual check-in confirmation');
  assert.equal(harness.submitClicks, 1, 'check-in confirmation, one-click and popup must use the same submission lock');
  harness.completeCheckin();
  await waitFor(() => harness.actionResults.some((result) => result.actionId === 'checkin-join-manual-confirm' && result.status === 'success'));
}

{
  const harness = buildCheckinHarness();
  harness.context.trustedSubmit.failWith('trusted-click-permission-required');
  await sendRemoteCheckin(harness, 'missing-click-permission');
  await waitFor(() => harness.actionResults.some((result) => result.actionId === 'missing-click-permission' && result.reason === 'trusted-click-permission-required'));
  assert.equal(harness.submitClicks, 0, 'denied browser input must not fall back to an ignored synthetic click');
  assert.equal(harness.context.DailyCheckinPage.findSubmit().getAttribute('data-p3a-submit-token'), null, 'temporary button marker must be removed after failure');
}

console.log('checkin remote submit runtime tests passed.');
