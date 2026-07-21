import assert from 'node:assert/strict';
import { buildReport, mergeRecords, parseGithubRawUrl, parseMarkdownDetailed, parseSource } from './merge-bank.mjs';

assert.deepEqual(parseGithubRawUrl('https://raw.githubusercontent.com/owner/repo/master/path/to/file.js'), {
  owner: 'owner', repo: 'repo', ref: 'master', path: 'path/to/file.js',
});
assert.deepEqual(parseGithubRawUrl('https://raw.githubusercontent.com/owner/repo/main/question_list.json'), {
  owner: 'owner', repo: 'repo', ref: 'main', path: 'question_list.json',
});
assert.equal(parseGithubRawUrl('https://example.com/owner/repo/main/file.js'), null);

assert.equal(parseSource('fixture.js', `const QA = {\n  "JS question?": "yes",\n};`).length, 1);
assert.deepEqual(parseSource('fixture.py', `QA = {\n  'Python question': ['one', 'two'], # comment\n}`).at(0).answers, ['one', 'two']);
assert.deepEqual(parseSource('fixture.js', `QA = {\n  "multi": [\n    "first",\n    "https://example.com/a//b", // comment\n  ],\n  "url": "https://example.com/x//y",\n}`).map(r => r.answers), [['first', 'https://example.com/a//b'], ['https://example.com/x//y']]);
assert.deepEqual(parseSource('fixture.json', JSON.stringify({ 'JSON question': ['answer'] })).at(0).answers, ['answer']);
assert.deepEqual(parseSource('fixture.md', '### 【题目】 Markdown question\n✓ Alpha\n✅ Beta\n其他答案未知').at(0).answers, ['Alpha', 'Beta']);
assert.equal(parseSource('fixture.md', '### 【题目】 No answer\n其他答案未知').length, 0);
const noAnswerMarkdown = parseMarkdownDetailed('### 【题目】 No answer\n其他答案未知');
assert.equal(noAnswerMarkdown.questionBlockCount, 1);
assert.equal(noAnswerMarkdown.recognizedBlockCount, 1);
assert.equal(noAnswerMarkdown.unrecognizedBlocks, 0);
const implicitMarkdown = parseSource('fixture.md', [
  '### 【题目】 下面哪所大学所在城市不是波士顿？',
  '✓ MIT',
  '下面哪个说法错误？',
  '✓ 芝加哥是美国著名的雨城',
].join('\n'));
assert.deepEqual(implicitMarkdown, [
  { question: '下面哪所大学所在城市不是波士顿？', answers: ['MIT'] },
  { question: '下面哪个说法错误？', answers: ['芝加哥是美国著名的雨城'] },
]);

const sources = [
  { source: { id: 'js', status: 'ok' }, records: [{ question: 'Apollo 11?', answers: ['1969'] }, { question: '多选题', answers: ['A', 'B'] }] },
  { source: { id: 'python', status: 'ok' }, records: [{ question: ' apollo　11！', answers: ['1969'] }, { question: '多选题', answers: ['C'] }] },
];
const entries = mergeRecords(sources);
assert.equal(entries.length, 2);
const apollo = entries.find(e => e.normalizedQuestion === 'apollo11');
assert.equal(apollo.status, 'confirmed');
assert.deepEqual(apollo.answers, ['1969']);
const multi = entries.find(e => e.question === '多选题');
assert.equal(multi.status, 'ambiguous');
assert.deepEqual(multi.answers, ['A', 'B', 'C']);
assert.equal(multi.crossSourceConflict, true);
assert.deepEqual(multi.sourceIds, ['js', 'python']);
assert.equal(multi.provenance.length, 2);

const report = buildReport([
  { source: { id: 'markdown', status: 'ok', rawCount: 2, unrecognizedBlocks: 1 }, records: [{ question: 'one', answers: ['A'] }, { question: 'two', answers: ['B'] }] },
  { source: { id: 'failed', status: 'failed', rawCount: 0, unrecognizedBlocks: 0, error: 'offline' }, records: [] },
], entries);
assert.equal(report.ambiguousEntryCount, 1);
assert.equal(report.conflictCount, 1);
assert.equal(report.unrecognizedMarkdownBlocks, 1);
assert.deepEqual(report.unresolvedBySource[0], { sourceId: 'markdown', unrecognizedMarkdownBlocks: 1, status: 'ok', error: null });
assert.equal(report.failedSources, 1);
assert.equal(report.schemaVersion, 1);
assert.ok(report.rawRecordCount >= report.normalizedEntryCount);
assert.ok(report.deduplicatedRecordCount >= 0);
assert.ok(report.unrecognizedMarkdownBlocks >= 0);
assert.equal(report.unrecognizedMarkdownBlocks, report.unresolvedBySource.reduce((sum, source) => sum + source.unrecognizedMarkdownBlocks, 0));
assert.equal(report.sourceCount, report.successfulSources + report.failedSources);

const sameSourceMulti = mergeRecords([{
  source: { id: 'single', status: 'ok' },
  records: [{ question: 'same source multi', answers: ['A', 'B'] }],
}]).at(0);
assert.equal(sameSourceMulti.status, 'ambiguous');
assert.equal(sameSourceMulti.crossSourceConflict, false);

const sameAnswersAcrossSources = mergeRecords([
  { source: { id: 'one', status: 'ok' }, records: [{ question: 'same answer', answers: ['A'] }] },
  { source: { id: 'two', status: 'ok' }, records: [{ question: 'same answer', answers: ['A'] }] },
]).at(0);
assert.equal(sameAnswersAcrossSources.status, 'confirmed');
assert.equal(sameAnswersAcrossSources.crossSourceConflict, false);
const normalizedSameAnswers = mergeRecords([
  { source: { id: 'one', status: 'ok' }, records: [{ question: 'case answer', answers: ['Tubi'] }] },
  { source: { id: 'two', status: 'ok' }, records: [{ question: 'case answer', answers: ['tubi'] }] },
]).at(0);
assert.deepEqual(normalizedSameAnswers.answers, ['Tubi', 'tubi']);
assert.equal(normalizedSameAnswers.crossSourceConflict, false);
const differentAnswers = mergeRecords([
  { source: { id: 'one', status: 'ok' }, records: [{ question: 'different answer', answers: ['Tubi'] }] },
  { source: { id: 'two', status: 'ok' }, records: [{ question: 'different answer', answers: ['Apple'] }] },
]).at(0);
assert.equal(differentAnswers.crossSourceConflict, true);
const noLicenseSource = { source: { id: 'unlicensed', status: 'ok', license: 'Not stated' }, records: [{ question: 'No license', answers: ['answer'] }] };
assert.equal(noLicenseSource.source.license, 'Not stated');
assert.equal('commit' in noLicenseSource.source, false);
assert.equal('commitStatus' in noLicenseSource.source, false);
const generatedSource = { id: 'generated', status: 'ok', commit: null, commitStatus: 'api-unavailable' };
assert.equal(generatedSource.commit, null);
assert.equal(generatedSource.commitStatus, 'api-unavailable');
console.log('merge-bank tests passed.');
