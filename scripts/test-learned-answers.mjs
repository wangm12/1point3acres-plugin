#!/usr/bin/env node
import fs from 'node:fs'; import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/shared/learned-answers.js', import.meta.url), 'utf8'); const matcher = fs.readFileSync(new URL('../src/shared/question-matcher.js', import.meta.url), 'utf8'); const context = { globalThis: {} }; vm.runInNewContext(matcher, context); vm.runInNewContext(source, context);
const L = context.globalThis.LearnedAnswers; const assert = (v, m) => { if (!v) throw new Error(m); };
assert(!L.validate({ question: '', answer: 'x' }).ok && !L.validate({ question: 'x', answer: 'x'.repeat(301) }).ok, 'bad input');
let saved = L.upsert([], { question: ' Q ', answer: 'A' }); saved = L.upsert(saved.records, { question: 'q', answer: 'B' }); assert(saved.records.length === 1 && saved.records[0].answer === 'B', 'upsert dedupe');
const many = Array.from({ length: L.MAX_RECORDS + 4 }, (_, i) => ({ question: `q${i}`, answer: 'a' })); assert(L.normalizeRecords(many).length === L.MAX_RECORDS, 'record limit');
const entries = L.toMatcherEntries([{ question: 'Q', answer: 'local' }], [{ id: 'public', question: 'Q', answers: ['public'] }]); assert(entries[0].source === L.SOURCE && entries[0].conflicts.length === 1, 'conflict preserved');
assert(L.normalizeKey('  A） Café\u00a0  ') === L.normalizeKey('a) café'), 'normalization');
const fallback = L.toMatcherEntries([{ question: 'Q?', answer: 'Local' }], [{ id: 'public', question: 'Q?', answers: ['Public'] }], 'q？', ['Public']); assert(fallback[0].id === 'public', 'invisible local fallback');
const conflicted = L.toMatcherEntries([{ question: 'Q?', answer: 'Local' }], [{ id: 'public', question: 'Q?', answers: ['Public'] }], 'q?', ['Local', 'Public']); assert(conflicted[0].source !== L.SOURCE, 'conflicting local answer must not override the public bank');
const wins = L.toMatcherEntries([{ question: 'Q?', answer: 'Local' }], [{ id: 'public-other', question: 'Other?', answers: ['Public'] }], 'q?', ['Local', 'Public']); assert(wins[0].source === L.SOURCE, 'visible non-conflicting local answer should take precedence');
console.log('learned answers tests passed.');
