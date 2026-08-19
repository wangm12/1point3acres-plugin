#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/shared/daily-question-page.js', import.meta.url), 'utf8');
const assert = (value, message) => { if (!value) throw new Error(message); };
const makeNode = (tag, value, { classes = '', attrs = {}, parent = null, disabled = false, children = [] } = {}) => {
  const node = { tagName: tag.toUpperCase(), textContent: value, innerText: value, disabled, parentNode: parent, children, attrs, className: classes, offsetParent: {},
    getAttribute(name) { return this.attrs[name] ?? null; },
    matches(selector) { return selector.includes('[class*="question"]') ? /question|text-orange|text-lg/i.test(this.className) : false; },
    closest(selector) { if (selector.includes('#p3a-daily-question-helper') && this.attrs.toolbar) return this; if (selector.includes('main')) { let n = this; while (n) { if (n.tagName === 'MAIN') return n; n = n.parentNode; } } return null; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { const all = []; const walk = (n) => { for (const child of n.children || []) { if ((selector.includes('button') && child.tagName === 'BUTTON') || (selector.includes('[role="option"]') && child.attrs.role === 'option')) all.push(child); if ((selector.includes('[data-question-container]') && child.attrs['data-question-container']) || (selector.includes('[data-question]') && child.attrs['data-question']) || (selector.includes('[class*="daily-question"]') && /daily-question/i.test(child.className)) || (selector.includes('[aria-label*="question" i]') && /question/i.test(child.attrs['aria-label'] || '')) || (selector.includes('[role="main"]') && child.attrs.role === 'main') || (selector.trim() === 'main' && child.tagName === 'MAIN')) all.push(child); if ((/(?:h1|h2|h3|heading|question|text-orange|text-lg)/.test(selector) || selector.includes('main p')) && ['H1','H2','H3','P','DIV','SPAN'].includes(child.tagName)) all.push(child); walk(child); } }; walk(this); return all; },
  };
  Object.defineProperty(node, 'parentElement', { get() { return this.parentNode?.tagName === 'DOCUMENT' ? null : this.parentNode; } });
  for (const child of children) child.parentNode = node;
  return node;
};
const main = makeNode('main', '', { children: [] });
const outerMain = makeNode('main', '', { children: [] });
const questionScope = makeNode('section', '', { attrs: { 'data-question-container': true }, children: [] });
const question = makeNode('div', 'Which city is known as the Windy City?', { classes: 'text-orange text-lg question', children: [] });
const optionNodes = ['Chicago', 'Boston', 'Seattle', 'Austin'].map((v) => makeNode('button', v, { classes: 'cursor-pointer rounded-md px-2.5 py-1.5 bg-gray-200 hover:bg-gray-300' }));
optionNodes[0].className = 'cursor-pointer rounded-md px-2.5 py-1.5 bg-green-200 hover:bg-green-300';
const submit = makeNode('button', '提交答案', { attrs: { type: 'submit' } });
const nav = ['搜索', '返回旧版', '我的版块', '导航'].map((v) => makeNode('button', v));
const sidebarQuestion = makeNode('aside', '今日已答题', { children: [] });
questionScope.children.push(question, ...optionNodes, submit);
for (const child of questionScope.children) child.parentNode = questionScope;
main.children.push(questionScope, sidebarQuestion, ...nav);
for (const child of main.children) child.parentNode = main;
outerMain.children.push(main); main.parentNode = outerMain;
const toolbar = makeNode('section', '每日答题助手', { attrs: { toolbar: true } });
const body = makeNode('body', '', { children: [toolbar, outerMain] });
const document = { body, querySelector: (selector) => document.querySelectorAll(selector)[0] || null, querySelectorAll: (selector) => body.querySelectorAll(selector) };
const context = { globalThis: {}, document, location: { href: 'https://www.1point3acres.com/next/daily-question/' } };
vm.runInNewContext(source, context);
const page = context.globalThis.DailyQuestionPage;
assert(page.isQuestionPage(context.location.href), 'trailing slash route failed');
assert(page.findQuestion(document).value === question.textContent, 'question candidate failed');
question.textContent = '【题目】如果网暴他人，贴出别人隐私信息，以下哪些说法是正确的？';
assert(page.findQuestion(document).value === '如果网暴他人，贴出别人隐私信息，以下哪些说法是正确的？', 'full-width question prefix was not removed');
question.textContent = '题目：Which city is known as the Windy City?';
assert(page.findQuestion(document).value === 'Which city is known as the Windy City?', '题目: question prefix was not removed');
question.textContent = 'Which city is known as the Windy City?';
assert(page.findOptions(document).map((node) => node.textContent).join('|') === 'Chicago|Boston|Seattle|Austin', 'options must be scoped and exclude submit/navigation');
assert(page.findOptions(document).length === 4 && page.findOptions(document).includes(optionNodes[0]), 'selected option must remain in the option group');
assert(!page.findOptions(document).some((node) => nav.includes(node)), 'navigation buttons must not be options');
assert(page.findSubmit(document) === submit, 'submit button detection failed');
assert(page.findSelectedOption(document, optionNodes) === optionNodes[0], 'selected option detection failed');
optionNodes[0].className = 'rounded-md cursor-pointer bg-primary text-white dark:text-black'; assert(page.findSelectedOption(document, optionNodes) === optionNodes[0], 'bg-primary selected option detection failed');
optionNodes[0].className = 'cursor-pointer rounded-md'; assert(page.findSelectedOption(document, optionNodes) === null, 'unselected option false positive');
optionNodes[0].className = 'cursor-pointer rounded-md p3a-answer-correct'; assert(page.findSelectedOption(document, optionNodes) === null, 'extension marker must not imply site selection');
optionNodes[0].className = 'cursor-pointer rounded-md peer-checked:bg-primary'; assert(page.findSelectedOption(document, optionNodes) === optionNodes[0], 'peer-checked selection failed');
optionNodes[0].className = 'rounded-md cursor-pointer bg-primary'; optionNodes[1].className = 'rounded-md cursor-pointer'; submit.disabled = false;
assert(page.findSelectedOption(document, optionNodes) === optionNodes[0] && page.findSubmit(document) === submit, 'bg-primary correct selection with enabled submit must be allowed');
optionNodes[0].className = 'rounded-md cursor-pointer p3a-answer-correct'; assert(page.findSelectedOption(document, optionNodes) === null, 'p3a-answer-correct alone must not allow submission');
optionNodes[1].className = 'rounded-md cursor-pointer bg-primary'; assert(page.findSelectedOption(document, optionNodes) === optionNodes[1] && page.findSelectedOption(document, optionNodes) !== optionNodes[0], 'wrong selected option must not allow submission');
submit.disabled = true; assert(page.findSubmit(document) === null, 'disabled submit must not allow submission'); submit.disabled = false;
optionNodes[0].className = 'cursor-pointer rounded-md'; optionNodes[1].className = 'cursor-pointer rounded-md'; optionNodes[0].attrs['data-selected'] = 'true'; assert(page.findSelectedOption(document, optionNodes) === optionNodes[0], 'data-selected selection failed'); optionNodes[0].attrs['data-selected'] = null;
optionNodes[1].attrs['aria-selected'] = 'true'; assert(page.findSelectedOption(document, optionNodes) === optionNodes[1], 'aria selected detection failed');
assert(page.getState({ body: { innerText: '请登录后答题' } }) === 'requires-login', 'login state failed');
assert(page.getState({ body: { innerText: '请先登录后答题' } }) === 'requires-login', '请先登录 state failed');
assert(page.getState({ body: { innerText: '关于论坛使用的题目：论坛规则是什么？' } }) === 'active', 'forum text must not be a status');
assert(page.getState(document) === 'active', 'sidebar question noise must not flip state');
questionScope.innerText = '';
questionScope.textContent = '';
outerMain.innerText = '今日已答题';
outerMain.textContent = '今日已答题';
assert(page.getState(document) === 'active', 'empty scoped question container must not fall back to body noise');
outerMain.innerText = '';
outerMain.textContent = '';
question.textContent = '关于论坛使用的题目：论坛规则是什么？';
optionNodes[0].textContent = '论坛用户需要遵守规则';
assert(page.findQuestion(document).value === question.textContent, 'forum question was incorrectly filtered');
assert(page.findOptions(document).some((node) => node.textContent === optionNodes[0].textContent), 'forum option was incorrectly filtered');
assert(page.getState({ body: { innerText: '今日已答题' } }) === 'completed', 'completed state failed');
assert(page.getState({ body: { innerText: '恭喜你答题成功! 获得奖励 大米 1 升' } }) === 'completed', 'site answer-success state failed');
submit.disabled = true;
submit.textContent = '今日已答题';
questionScope.innerText = '今日已答题';
questionScope.textContent = '今日已答题';
assert(page.getState(document) === 'completed', 'disabled site 今日已答题 button must count as completed');
submit.disabled = false;
submit.textContent = '提交答案';
assert(page.getState({ body: { innerText: '已经答过' } }) === 'completed', '已经答过 variant must count as completed');
assert(fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8').match(/getElementById\(toolbarId\)/g)?.length === 1, 'toolbar lookup should be centralized and reusable');
const contentSource = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
assert(contentSource.includes("result.status === 'unmatched' || result.status === 'ambiguous'"), 'unmatched/ambiguous branch must be handled');
assert(contentSource.match(/textContent = '记住当前答案'/g)?.length >= 2, 'remember button must exist for matched and manual branches');
assert(contentSource.includes("currentOptions.filter((node) => node === selected).length !== 1"), 'manual save must require unique selection');
console.log('question page tests passed.');
