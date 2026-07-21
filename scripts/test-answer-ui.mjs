import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/content.css', import.meta.url), 'utf8');

assert.match(source, /if \(autoSelectedKey !== questionKey && selected !== target && typeof target\.click === 'function'\)/, 'auto click must be guarded by questionKey and manual selection');
assert.match(source, /autoSelectedKey = questionKey;/, 'guard must be recorded before auto click');
assert.match(source, /prepared = \{ questionKey, optionIndex: result\.optionIndex, node: target, answer: lookupAnswerText, optionTexts: lookupOptionTexts \};/, 'prepared must rebind to the live selected node');
assert.match(source, /if \(selected === target && \(prepared\?\.questionKey === questionKey \|\| autoSelectedKey === questionKey\)\)/, 'node replacement must rebind only for the same question');
assert.match(source, /const waitForStableQuestionSnapshot = async/, 'remote direct submission must wait for a stable snapshot');
assert.match(source, /const lookupResponse = await bridge\.send\(ExtensionProtocol\.MESSAGE_TYPES\.LOOKUP_QUESTION/, 'remote direct submission must re-query lookup at execution time');
assert.match(source, /const target = matching\[0\];/, 'remote direct submission must use fresh current options');
assert.match(source, /clickVisibleQuestionSubmit\(siteSubmit\)/, 'remote direct submission must click the live site submit button');
assert.match(source, /clearAnswerMarks\(optionNodes\)/, 'non-match states must clear marks');
assert.match(source, /result\.status === 'unmatched' \|\| result\.status === 'ambiguous'/, 'ambiguous and unmatched must not auto-select');
assert.match(source, /result\.optionIndex < 0 \|\| result\.optionIndex >= optionNodes\.length/, 'invalid indexes must clear marks and stop');
assert.doesNotMatch(source, /if \(autoSelectedKey !== questionKey[\s\S]{0,500}findSubmit\(\)/, 'auto path must not call site submit');
assert.match(css, /p3a-answer-correct::after[\s\S]*content:\s*["']✓/);
assert.match(css, /p3a-answer-incorrect::after[\s\S]*content:\s*["']✕/);
const markerCode = source.slice(source.indexOf('const clearAnswerMarks'), source.indexOf('const render ='));
assert.doesNotMatch(markerCode, /textContent\s*(?:\+=|=)/, 'markers must not modify option textContent');
console.log('answer UI tests passed.');
