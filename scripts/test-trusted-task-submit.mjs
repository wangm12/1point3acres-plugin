#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workerSource = fs.readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8');
const checkinUrl = 'https://www.1point3acres.com/next/daily-checkin';
const token = 'p3a-12345678-abcd';
const buildHarness = ({ action = 'checkin', granted = true, attachError = false, releaseError = false } = {}) => {
  const events = [];
  let listener;
  let attachGate = null;
  let failRelease = releaseError;
  const url = action === 'question' ? checkinUrl.replace('checkin', 'question') : checkinUrl;
  const parsed = new URL(url);
  const button = {
    textContent: action === 'question' ? '提交答案' : '提交签到',
    isConnected: true,
    disabled: false,
    parentElement: null,
    attributes: { 'data-p3a-submit-token': token },
    style: { display: 'block', visibility: 'visible', pointerEvents: 'auto' },
    rect: { left: 80, top: 130, width: 40, height: 40 },
    getAttribute(name) { return this.attributes[name] ?? null; },
    closest() { return null; },
    matches() { return true; },
    contains(hit) { return hit === this; },
    getBoundingClientRect() { return this.rect; },
  };
  const page = {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => queueMicrotask(callback),
    location: parsed,
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: (node) => node.style,
    document: {
      querySelector: (selector) => selector === `[data-p3a-submit-token="${button.attributes['data-p3a-submit-token']}"]` ? button : null,
      elementFromPoint: () => button,
    },
  };
  const sender = { id: 'test-extension', tab: { id: 12, url }, url, frameId: 0 };
  let tabUrl = url;
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {} },
    tabs: { get: async (id) => ({ id, url: tabUrl }) },
    permissions: { contains: async () => granted },
    debugger: {
      attach: async (target, version) => {
        events.push({ method: 'attach', target, version });
        if (attachError) throw new Error('another-debugger-attached');
        if (attachGate) await attachGate;
      },
      sendCommand: async (target, method, params) => {
        events.push({ method, target, params });
        if (method === 'Runtime.evaluate') {
          assert.equal(params.awaitPromise, true, 'input must wait for the renderer after scrolling');
          return { result: { value: await vm.runInNewContext(params.expression, page) } };
        }
        if (params.type === 'mouseReleased' && failRelease) {
          failRelease = false;
          throw new Error('input-send-failed');
        }
        return {};
      },
      detach: async (target) => { events.push({ method: 'detach', target }); },
    },
  };
  const context = { chrome, URL, console };
  context.globalThis = context;
  vm.createContext(context);
  context.importScripts = (...files) => files.forEach((file) => {
    vm.runInContext(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), context);
  });
  vm.runInContext(workerSource, context);
  const send = (overrides = {}, source = sender) => new Promise((resolve) => {
    listener({ type: 'CLICK_TASK_SUBMIT', payload: { action, token, ...overrides } }, source, resolve);
  });
  return { send, events, sender, button, page, setTabUrl(value) { tabUrl = value; }, holdAttach(gate) { attachGate = gate; } };
};

for (const action of ['checkin', 'question']) {
  const h = buildHarness({ action });
  assert.equal((await h.send()).ok, true);
  assert.deepEqual(h.events.map((e) => e.method), ['attach', 'Emulation.setFocusEmulationEnabled', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Emulation.setFocusEmulationEnabled', 'detach']);
  assert.equal(h.events[0].target.tabId, 12);
  assert.equal(h.events[1].params.enabled, true);
  assert.equal(h.events[3].params.type, 'mouseMoved');
  assert.equal(h.events[4].params.type, 'mousePressed');
  assert.equal(h.events[5].params.type, 'mouseReleased');
  assert.equal(h.events[4].params.x, 100);
  assert.equal(h.events[4].params.y, 150);
  assert.equal(h.events[6].params.enabled, false);
}

for (const change of [
  (h) => ({ ...h.sender, id: 'different-extension' }),
  (h) => ({ ...h.sender, frameId: 1 }),
  (h) => ({ ...h.sender, url: 'https://example.com/next/daily-checkin' }),
  (h) => ({ ...h.sender, url: checkinUrl.replace('checkin', 'question') }),
  (h) => ({ ...h.sender, tab: undefined }),
]) {
  const h = buildHarness();
  assert.equal((await h.send({}, change(h))).error, 'invalid-submit-sender');
  assert.equal(h.events.length, 0, 'invalid senders must never attach or click');
}

{
  const h = buildHarness();
  h.setTabUrl('https://example.com/next/daily-checkin');
  assert.equal((await h.send()).error, 'invalid-submit-sender');
  assert.equal(h.events.length, 0);
  assert.equal((await h.send({ token: 'x"] button' })).error, 'invalid-submit-sender');
  assert.equal((await h.send({ action: 'everything' })).error, 'invalid-submit-sender');
}

{
  const h = buildHarness({ granted: false });
  assert.equal((await h.send()).error, 'trusted-click-permission-required');
  assert.equal(h.events.length, 0, 'missing permission must not silently fall back to a DOM click');
}

for (const obstruct of [
  (h) => { h.button.disabled = true; },
  (h) => { h.button.isConnected = false; },
  (h) => { h.button.textContent = 'Verify you are human'; },
  (h) => { h.button.attributes['data-p3a-submit-token'] = 'changed-token'; },
  (h) => { h.button.style.display = 'none'; },
  (h) => { h.button.attributes['aria-hidden'] = 'true'; },
  (h) => { h.button.parentElement = { hidden: true, style: {}, getAttribute() { return null; } }; },
  (h) => { h.button.rect.width = 0; },
  (h) => { h.button.rect.top = -100; },
  (h) => { h.page.document.elementFromPoint = () => ({}); },
  (h) => { h.page.location = new URL('https://example.com/next/daily-checkin'); },
]) {
  const h = buildHarness();
  obstruct(h);
  assert.equal((await h.send()).error, 'submit-button-stale-or-unavailable');
  assert.deepEqual(h.events.map((e) => e.method), ['attach', 'Emulation.setFocusEmulationEnabled', 'Runtime.evaluate', 'Emulation.setFocusEmulationEnabled', 'detach'], 'stale/hidden/covered controls must never receive input');
}

{
  const h = buildHarness({ attachError: true });
  assert.equal((await h.send()).error, 'trusted-click-unavailable');
  assert.deepEqual(h.events.map((e) => e.method), ['attach'], 'must not detach another debugger');
}

{
  const h = buildHarness({ releaseError: true });
  assert.equal((await h.send()).error, 'trusted-click-unavailable');
  assert.deepEqual(h.events.slice(-3).map((e) => e.method), ['Input.dispatchMouseEvent', 'Emulation.setFocusEmulationEnabled', 'detach'], 'release a pressed mouse and restore focus before disconnecting on failure');
  assert.equal((await h.send()).ok, true, 'failed input must release the per-tab lock');
}

{
  const h = buildHarness();
  let resume;
  h.holdAttach(new Promise((resolve) => { resume = resolve; }));
  const first = h.send();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.send()).error, 'trusted-click-unavailable', 'concurrent requests must not double-submit');
  resume();
  assert.equal((await first).ok, true);
  assert.equal(h.events.filter((e) => e.method === 'attach').length, 1);
}

console.log('trusted task submit tests passed.');
