import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../src/shared/checkin-state.js', import.meta.url), 'utf8');
const sandbox = { globalThis: null }; sandbox.globalThis = sandbox; vm.runInNewContext(source, sandbox);
const pageSource = fs.readFileSync(new URL('../src/shared/daily-checkin-page.js', import.meta.url), 'utf8');
vm.runInNewContext(pageSource, sandbox);
const node = (text, value = 'x') => ({ textContent: text, getAttribute(name) { return name === 'value' ? value : ''; } });
const oldNode = node('只想签到拿米');
const prepared = sandbox.CheckinState.prepare(oldNode, 'https://www.1point3acres.com/next/daily-checkin');
const repaintedNode = node('只想签到拿米');
assert(sandbox.CheckinState.reconcile(prepared, prepared.href, repaintedNode));
assert(sandbox.CheckinState.canConfirm(prepared, prepared.href, repaintedNode, {}));
assert.equal(sandbox.CheckinState.reconcile(prepared, prepared.href, node('其他签到')), null);
assert.equal(sandbox.CheckinState.reconcile(prepared, `${prepared.href}/changed`, repaintedNode), null);
assert(pageSource.includes('taskScope'), 'checkin state detection must scope to task region');
const makeNode = (tag, value, { attrs = {}, children = [] } = {}) => {
  const node = { tagName: tag.toUpperCase(), textContent: value, innerText: value, attrs, children, hidden: false, offsetParent: {},
    getAttribute(name) { return this.attrs[name] ?? null; },
    closest(selector) { if (selector.includes('form') && this.attrs.form) return this.formNode || null; if (selector.includes('main')) { let n = this; while (n) { if (n.tagName === 'MAIN') return n; n = n.parentNode; } } return null; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { const all = []; const walk = (n) => { for (const child of n.children || []) { if ((selector.includes('button') && child.tagName === 'BUTTON') || (selector.includes('[role="button"]') && child.attrs.role === 'button') || (selector.includes('[data-checkin]') && child.attrs['data-checkin']) || (selector.includes('[data-page="daily-checkin"]') && child.attrs['data-page'] === 'daily-checkin') || (selector.includes('[class*="daily-checkin"]') && /daily-checkin/i.test(child.attrs.className || '')) || (selector.includes('form') && child.tagName === 'FORM') || (selector.trim() === 'main' && child.tagName === 'MAIN')) all.push(child); walk(child); } }; walk(this); return all; },
  };
  for (const child of children) child.parentNode = node;
  return node;
};
const checkinMain = makeNode('main', '', { children: [] });
const outerMain = makeNode('main', '', { children: [] });
const taskContainer = makeNode('section', '只想签到拿米', { attrs: { 'data-checkin': true }, children: [] });
const defaultButton = makeNode('button', '没心情', { attrs: { role: 'button' }, children: [] });
const sidebarNoise = makeNode('aside', '已经签到', { children: [] });
taskContainer.children.push(defaultButton); defaultButton.parentNode = taskContainer;
checkinMain.children.push(taskContainer, sidebarNoise); taskContainer.parentNode = checkinMain; sidebarNoise.parentNode = checkinMain;
outerMain.children.push(checkinMain); checkinMain.parentNode = outerMain;
const checkinBody = makeNode('body', '', { children: [outerMain] });
const checkinDocument = { body: checkinBody, querySelector: (selector) => checkinBody.querySelector(selector), querySelectorAll: (selector) => checkinBody.querySelectorAll(selector) };
assert(sandbox.DailyCheckinPage.getState(checkinDocument) === 'active', 'sidebar check-in noise must not flip state');
taskContainer.innerText = '';
taskContainer.textContent = '';
outerMain.innerText = '已经签到';
outerMain.textContent = '已经签到';
assert(sandbox.DailyCheckinPage.getState(checkinDocument) === 'active', 'empty scoped check-in container must not fall back to body noise');
taskContainer.innerText = '您累计已签到 20 天';
taskContainer.textContent = '您累计已签到 20 天';
defaultButton.disabled = true;
defaultButton.textContent = '今日已签到';
defaultButton.innerText = '今日已签到';
assert(sandbox.DailyCheckinPage.getState(checkinDocument) === 'completed', 'disabled site 今日已签到 button must count as completed');
defaultButton.disabled = false;
defaultButton.textContent = '没心情';
defaultButton.innerText = '没心情';
taskContainer.innerText = '您累计已签到 20 天';
taskContainer.textContent = '您累计已签到 20 天';
assert(sandbox.DailyCheckinPage.getState(checkinDocument) === 'active', '累计已签到 alone must not count as completed');
console.log('checkin state tests passed.');
