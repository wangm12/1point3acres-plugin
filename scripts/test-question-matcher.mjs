#!/usr/bin/env node
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/shared/question-matcher.js', import.meta.url), 'utf8');
const contentSource = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const context = { globalThis: {} }; vm.runInNewContext(source, context);
const { lookup, normalize } = context.globalThis.QuestionMatcher;
const assert = (value, message) => { if (!value) throw new Error(message); };
const entries = [
  { id: 'one', question: 'Which   answer?', aliases: ['Which answer？'], answers: ['A. Alpha'] },
  { id: 'many', question: 'Many?', aliases: [], answers: ['One', 'Two'] },
];
assert(lookup('Which answer？', ['Beta', 'A. Alpha'], entries).matchType === 'exact', 'exact match type failed');
assert(lookup('Which answer？', ['Beta', 'A. Alpha'], entries).optionIndex === 1, 'unique match or prefix failed');
assert(lookup('Which answer？', ['A. Alpha', 'Beta'], entries).optionIndex === 0, 'option order failed');
assert(lookup('Many?', ['答案A', '其他答案'], [{ id: 'visible-one', question: 'Many?', aliases: [], answers: ['答案A', '答案B'] }]).optionIndex === 0, 'unique visible answer should disambiguate bank answers');
assert(lookup('Many?', ['答案A', '答案B'], [{ id: 'visible-many', question: 'Many?', aliases: [], answers: ['答案A', '答案B'] }]).status === 'ambiguous', 'multiple visible answers must remain ambiguous');
assert(lookup('Many?', ['其他答案'], [{ id: 'visible-none', question: 'Many?', aliases: [], answers: ['答案A', '答案B'] }]).status === 'unmatched', 'invisible bank answers should remain unmatched');
assert(lookup('Many?', ['One', 'Two'], entries).status === 'ambiguous', 'ambiguous failed');
assert(lookup('Unknown?', ['One'], entries).status === 'unmatched', 'unmatched failed');
assert(normalize(' A.  Alpha ') === normalize('alpha'), 'A./B. normalization failed');
assert(lookup('ignored', [], entries, { completed: true }).status === 'completed', 'completed failed');
assert(lookup('ignored', [], entries, { requiresLogin: true }).status === 'requires-login', 'login failed');

// Similar question and candidate answers aggregation tests
const hideBank = [
  { id: 'q_exact_hide', question: '一亩三分地发帖可以用hide语法隐藏内容。下面哪个写法正确？', aliases: [], answers: ['柯南的名字是[hide=200]工藤新一[/hide]'] },
  { id: 'q_similar_hide_1', question: '一亩三分地发帖可以选择内容用hide进行隐藏。正确隐藏语法是：', aliases: [], answers: ['两人第一次华山论剑，争的是荣名与[hide=188]《九阴真经》[/hide]；'] },
  { id: 'q_similar_hide_2', question: '地里发帖可以隐藏内容。假如要设置200积分以上才可以看到，下面哪个语法正确？', aliases: [], answers: ['[hide=200]想要隐藏的内容[/hide]'] },
];

// Test Tier 2 fallback when exact question's answer is not visible, but similar question answer is visible
const fallbackResult = lookup('一亩三分地发帖可以用hide语法隐藏内容。下面哪个写法正确？', [
  '错误写法A',
  '[hide=200]想要隐藏的内容[/hide]',
  '错误写法B',
  '错误写法C'
], hideBank);
assert(fallbackResult.status === 'matched' && fallbackResult.matchType === 'fuzzy' && fallbackResult.optionIndex === 1, 'fuzzy similar question candidate match failed');

// Test question slight variation (not in bank aliases) matches candidate answer
const variantResult = lookup('一亩三分地发帖可以用 hide 隐藏内容，下面哪种写法是正确的？', [
  '错误写法A',
  '柯南的名字是[hide=200]工藤新一[/hide]'
], hideBank);
assert(variantResult.status === 'matched' && variantResult.matchType === 'fuzzy' && variantResult.optionIndex === 1, 'variant question fuzzy match failed');

// Test higher-similarity winner when multiple options match answers with different similarity
const weightedFuzzy = lookup('一亩三分地发帖可以用hide隐藏内容', [
  '两人第一次华山论剑，争的是荣名与[hide=188]《九阴真经》[/hide]；',
  '柯南的名字是[hide=200]工藤新一[/hide]'
], hideBank);
assert(weightedFuzzy.status === 'matched' && weightedFuzzy.matchType === 'fuzzy' && weightedFuzzy.optionIndex === 1, 'weighted fuzzy match failed');

// Test ambiguity when multiple options match answers with tied/close similarity
const tiedBank = [
  { id: 'tie_1', question: '一亩三分地每日签到选项A', aliases: [], answers: ['选项一'] },
  { id: 'tie_2', question: '一亩三分地每日签到选项B', aliases: [], answers: ['选项二'] },
];
const ambiguousFuzzy = lookup('一亩三分地每日签到选项', ['选项一', '选项二'], tiedBank);
assert(ambiguousFuzzy.status === 'ambiguous' && ambiguousFuzzy.matchType === 'fuzzy', 'ambiguous fuzzy match failed');

assert(contentSource.includes("document.getElementById(toolbarId)") && contentSource.includes("if (!bar)"), 'toolbar must be reused instead of duplicated');
assert(contentSource.includes('button.closest(`#${toolbarId}`)'), 'toolbar buttons must be excluded from page option scan');
assert(contentSource.includes("/提交答案|提交|确认答案/"), 'submit button selector must be separate from options');
console.log('question matcher tests passed.');

