#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../src/', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
const protocolSource = read('../src/shared/protocol.js');
const popupSource = read('../src/popup.js');

const makeMockDom = () => {
  const elements = new Map();
  const createElem = (id) => ({
    id,
    textContent: '',
    className: '',
    classList: {
      add(cls) { this.classes.add(cls); },
      remove(cls) { this.classes.delete(cls); },
      contains(cls) { return this.classes.has(cls); },
      classes: new Set(),
    },
    hidden: false,
    disabled: false,
    listeners: {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
    click() { this.listeners.click?.(); },
  });

  const ids = [
    'alert-banner',
    'alert-title',
    'alert-desc',
    'alert-action-btn',
    'run-everything',
    'run-checkin',
    'run-question',
    'overall-status-badge',
    'checkin-task-status',
    'question-task-status',
    'status-message',
  ];
  for (const id of ids) {
    elements.set(id, createElem(id));
  }

  const document = {
    getElementById: (id) => elements.get(id) || null,
    addEventListener: () => {},
  };

  return { document, elements };
};

// 1. 测试受阻原因识别与横幅渲染
{
  const { document, elements } = makeMockDom();
  const sentMessages = [];
  let closedWindow = false;
  let focusedTab = null;

  const chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        sentMessages.push(msg);
        cb({ ok: true });
      },
    },
    tabs: {
      update: async (tabId, opts) => { focusedTab = { tabId, ...opts }; return {}; },
      get: async () => ({ id: 42, windowId: 1 }),
    },
    windows: {
      update: async () => ({}),
    },
  };

  const context = {
    globalThis: {},
    document,
    chrome,
    window: { close: () => { closedWindow = true; } },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    console,
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(protocolSource, context);
  vm.runInContext(popupSource, context);

  const popup = context.__popup;
  assert.ok(popup, '__popup should be exported on globalThis');

  // 测试空状态/初始状态
  popup.render({});
  assert.equal(elements.get('alert-banner').hidden, true, 'alert banner should be hidden by default');
  assert.equal(elements.get('overall-status-badge').textContent, '就绪');
  assert.equal(elements.get('checkin-task-status').textContent, '待完成');
  assert.equal(elements.get('question-task-status').textContent, '待完成');

  // 测试验证码受阻状态
  popup.render({
    run: {
      status: 'paused',
      stage: 'question',
      lastError: 'captcha-required',
      currentTabId: 42,
    },
    actionsByTabId: {
      '42': { action: 'question', status: 'pending', lastResult: { reason: 'captcha-required' }, tabId: 42 },
    },
  });

  assert.equal(elements.get('alert-banner').hidden, false, 'alert banner should be visible when captcha required');
  assert.equal(elements.get('alert-title').textContent, '遇到验证码');
  assert.equal(elements.get('overall-status-badge').textContent, '需人工处理');
  assert.equal(elements.get('question-task-status').textContent, '需处理');

  // 测试点击“前往处理”按钮
  elements.get('alert-action-btn').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(focusedTab, { tabId: 42, active: true }, 'should focus the blocked task tab');
  assert.equal(closedWindow, true, 'popup should close after focusing task tab');

  // 测试全部完成状态（来自 actionsByTabId）
  popup.render({
    run: { status: 'idle' },
    actionsByTabId: {
      '1': { action: 'checkin', status: 'completed' },
      '2': { action: 'question', status: 'completed' },
    },
  });

  assert.equal(elements.get('alert-banner').hidden, true, 'alert banner should be hidden when completed');
  assert.equal(elements.get('overall-status-badge').textContent, '已全部完成');
  assert.equal(elements.get('checkin-task-status').textContent, '已完成');
  assert.equal(elements.get('question-task-status').textContent, '已完成');

  // 测试持久化 dailyStatus 完成状态（即使 actionsByTabId 为空/已清空）
  popup.render({
    run: { status: 'idle' },
    actionsByTabId: {},
    dailyStatus: {
      dateKey: '2026-08-18',
      checkin: { completed: true, at: 1000 },
      question: { completed: true, at: 2000 },
    },
  });

  assert.equal(elements.get('overall-status-badge').textContent, '已全部完成');
  assert.equal(elements.get('checkin-task-status').textContent, '已完成');
  assert.equal(elements.get('question-task-status').textContent, '已完成');

  popup.render({
    run: {
      status: 'paused',
      stage: 'question',
      lastError: 'timeout',
      currentTabId: 7,
    },
    actionsByTabId: {
      '7': { action: 'question', status: 'failed', lastResult: { reason: 'timeout' }, tabId: 7 },
    },
  });
  assert.equal(elements.get('alert-banner').hidden, false, 'timeout should show the blocked banner');
  assert.equal(elements.get('run-everything').disabled, false, 'paused timeout must not disable retry buttons');
  assert.equal(elements.get('run-checkin').disabled, false);
  assert.equal(elements.get('run-question').disabled, false);
}

// 2. 测试一键操作触发
{
  const { document, elements } = makeMockDom();
  const sentMessages = [];

  const chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        sentMessages.push(msg);
        cb({ ok: true });
      },
    },
    tabs: { update: async () => ({}), get: async () => ({}) },
    windows: { update: async () => ({}) },
  };

  const context = {
    globalThis: {},
    document,
    chrome,
    window: { close: () => {} },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    console,
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(protocolSource, context);
  vm.runInContext(popupSource, context);

  elements.get('run-everything').click();
  assert.equal(sentMessages.length, 2, 'should have sent GET_RUNTIME_STATE on init + RUN_ONE_CLICK');
  assert.equal(sentMessages[1].type, 'RUN_ONE_CLICK');
  assert.equal(sentMessages[1].payload.action, 'everything');
}

console.log('Popup UI unit tests passed.');
