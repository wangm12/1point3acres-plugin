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
assert(contentSource.includes("document.getElementById(toolbarId)") && contentSource.includes("if (!bar)"), 'toolbar must be reused instead of duplicated');
assert(contentSource.includes('button.closest(`#${toolbarId}`)'), 'toolbar buttons must be excluded from page option scan');
assert(contentSource.includes("/提交答案|提交|确认答案/"), 'submit button selector must be separate from options');
console.log('question matcher tests passed.');
