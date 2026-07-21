#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const OUTPUT = new URL('../data/', import.meta.url);
const SOURCES = [
  ['eagleoflqj/p1a3_script/QA.js', 'https://raw.githubusercontent.com/eagleoflqj/p1a3_script/master/QA.js', 'LGPL-3.0'],
  ['VividLau/1p3a_python_script/question_list.json', 'https://raw.githubusercontent.com/VividLau/1p3a_python_script/master/question_list.json', 'WTFPL'],
  ['Hanyang-Li/BotFarmer-1point3acres/bot-farmer-local/cheat_sheet.json', 'https://raw.githubusercontent.com/Hanyang-Li/BotFarmer-1point3acres/master/bot-farmer-local/cheat_sheet.json', 'MIT (README stated)'],
  ['tingyincc/auto_1p3a/question_list.json', 'https://raw.githubusercontent.com/tingyincc/auto_1p3a/master/question_list.json', 'Not stated'],
  ['zxc2012/1p3a_signin/src/questions.py', 'https://raw.githubusercontent.com/zxc2012/1p3a_signin/master/src/questions.py', 'Not stated'],
  ['timerring/CloudCheckin/onepoint3acres/questions.py', 'https://raw.githubusercontent.com/timerring/CloudCheckin/master/onepoint3acres/questions.py', 'Not stated'],
  ['stevenxzhou/frameworks/chromeExtension/1point3acres/qa.js', 'https://raw.githubusercontent.com/stevenxzhou/frameworks/master/chromeExtension/1point3acres/qa.js', 'Not stated'],
  ['beak2825/greasyfork_archives/js_greasyfork/387976.js', 'https://raw.githubusercontent.com/beak2825/greasyfork_archives/master/js_greasyfork/387976.js', 'Not stated'],
  ['mageLi/1Point3Acres_Daily_Question/README.md', 'https://raw.githubusercontent.com/mageLi/1Point3Acres_Daily_Question/master/README.md', 'Not stated'],
  ['leowang396/1point3acres-daily-question-solutions/README.md', 'https://raw.githubusercontent.com/leowang396/1point3acres-daily-question-solutions/main/README.md', 'Not stated'],
];
const now = new Date().toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalize = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const normalizeAnswer = value => normalize(String(value));
const answerArray = value => Array.isArray(value) ? value.flatMap(answerArray).filter(Boolean) : typeof value === 'string' ? [value.trim()].filter(Boolean) : [];

function stripComments(text) {
  let out = '', quote = null, escaped = false;
  for (let i = 0; i < text.length; i++) { const c = text[i], n = text[i + 1];
    if (quote) { out += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if ((c === '/' && n === '/') || c === '#') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  } return out;
}
function quoted(text, start) {
  const quote = text[start]; let value = '', escaped = false;
  for (let i = start + 1; i < text.length; i++) { const c = text[i];
    if (escaped) { value += ({ n: '\n', r: '\r', t: '\t' }[c] ?? c); escaped = false; }
    else if (c === '\\') escaped = true; else if (c === quote) return { value, end: i + 1 }; else value += c;
  } return null;
}
function parseValue(text, start) {
  while (/\s/.test(text[start] ?? '')) start++;
  if (text[start] === '"' || text[start] === "'") { const q = quoted(text, start); return q && { values: [q.value], end: q.end }; }
  if (text[start] !== '[') return null;
  const values = []; let i = start + 1;
  while (i < text.length) { while (/\s|,/.test(text[i] ?? '')) i++; if (text[i] === ']') return { values, end: i + 1 }; if (text[i] !== '"' && text[i] !== "'") return null; const item = quoted(text, i); if (!item) return null; values.push(item.value); i = item.end; }
  return null;
}
export function parseObject(text) {
  const records = [], clean = stripComments(text); let i = 0;
  while (i < clean.length) { if (clean[i] !== '"' && clean[i] !== "'") { i++; continue; } const key = quoted(clean, i); if (!key) break; i = key.end; while (/\s/.test(clean[i] ?? '')) i++; if (clean[i] !== ':') continue; const value = parseValue(clean, i + 1); if (!value) { i++; continue; } const answers = value.values.map(String).map(s => s.trim()).filter(Boolean); if (key.value.trim() && answers.length) records.push({ question: key.value.trim(), answers }); i = value.end; }
  return records;
}
const parseJson = text => Object.entries(JSON.parse(text)).map(([question, answers]) => ({ question, answers: answerArray(answers) })).filter(r => r.answers.length);
export function parseMarkdown(text) {
  return parseMarkdownDetailed(text).records;
}
export function parseMarkdownDetailed(text) {
  const records = [], lines = text.split(/\r?\n/);
  let questionBlockCount = 0, recognizedBlockCount = 0;
  let question = null, answers = [];
  const flush = () => { const unique = [...new Set(answers.flatMap(answerArray))]; if (question && unique.length) records.push({ question, answers: unique }); question = null; answers = []; };
  const isImplicitQuestion = line => {
    const value = line.trim();
    if (value.length < 8 || !/[？?]$/.test(value)) return false;
    if (/^[✓✅✔]/u.test(value) || /^(?:答案|正确答案|其他答案未知|答案未知)\s*[:：]?/u.test(value)) return false;
    if (/^(?:[-*•]|[A-DＡ-Ｄ](?:[.)、]|\s+)|[①②③④⑤⑥⑦⑧⑨⑩])/u.test(value)) return false;
    if (/^#+\s|^【题目】/u.test(value)) return false;
    return true;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const explicit = line.match(/^(?:###\s*)?【题目】\s*(.+)/u);
    if (explicit) { flush(); question = explicit[1].trim(); questionBlockCount++; recognizedBlockCount++; continue; }
    if (isImplicitQuestion(line)) { flush(); question = line; questionBlockCount++; recognizedBlockCount++; continue; }
    if (!question || /其他答案未知|答案未知/u.test(line)) continue;
    const match = line.match(/(?:答案|正确答案)\s*[:：]\s*(.+)/u) || line.match(/^[✓✅✔]\s*(?:答案\s*[:：]?\s*)?(.+)/u);
    if (match) answers.push(match[1].replace(/^[✓✅✔\s]+/u, '').trim());
  }
  flush();
  return { records, questionBlockCount, recognizedBlockCount, parsedBlockCount: records.length, unrecognizedBlocks: Math.max(0, questionBlockCount - recognizedBlockCount) };
}
export const parseSource = (name, text) => name.endsWith('.json') ? parseJson(text) : name.endsWith('.md') ? parseMarkdown(text) : parseObject(text);

export function parseGithubRawUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname !== 'raw.githubusercontent.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, ref, ...path] = parts;
  return { owner, repo, ref, path: path.join('/') };
}

async function fetchSource([name, url, license]) {
  const isGithub = url.includes('raw.githubusercontent.com');
  const github = isGithub ? parseGithubRawUrl(url) : null;
  const ref = github?.ref ?? null;
  const source = { id: name, url, repositoryFile: name, ref, commit: null, commitStatus: isGithub ? 'pending' : 'not-requested', license, fetchedAt: now, status: 'failed', sha256: null, rawCount: 0, unrecognizedBlocks: 0 };
  try { const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const text = await response.text(); source.sha256 = sha256(text); const markdown = name.endsWith('.md') ? parseMarkdownDetailed(text) : null; const records = markdown?.records ?? parseSource(name, text); source.rawCount = records.length; source.unrecognizedBlocks = markdown?.unrecognizedBlocks ?? 0;
    if (github) { try { const api = `https://api.github.com/repos/${github.owner}/${github.repo}/commits?path=${encodeURIComponent(github.path)}&sha=${encodeURIComponent(github.ref)}&per_page=1`; const commitResponse = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'chrome-ext-question-bank-merger' }, signal: AbortSignal.timeout(15000) }); if (!commitResponse.ok) throw new Error(`HTTP ${commitResponse.status}`); const commits = await commitResponse.json(); if (!Array.isArray(commits) || !commits[0]?.sha) throw new Error('No commit returned'); source.commit = commits[0].sha; source.commitStatus = 'api'; } catch (error) { source.commitStatus = `api-error:${String(error.message || error)}`; } }
    source.status = 'ok'; return { source, records }; }
  catch (error) { source.error = String(error.message || error); return { source, records: [] }; }
}
export function mergeRecords(results) {
  const groups = new Map();
  for (const { source, records } of results) for (const record of records) { const question = record.question.trim(), key = normalize(question); if (!key) continue; const group = groups.get(key) ?? { id: `q_${sha256(key).slice(0, 16)}`, question, aliases: new Set(), answers: new Set(), sourceIds: new Set(), provenance: [], normalizedQuestion: key }; group.aliases.add(question); record.answers.forEach(a => group.answers.add(a)); group.sourceIds.add(source.id); group.provenance.push({ sourceId: source.id, question, answers: record.answers }); groups.set(key, group); }
  return [...groups.values()].sort((a, b) => a.normalizedQuestion.localeCompare(b.normalizedQuestion) || a.id.localeCompare(b.id)).map(g => {
    const answers = [...g.answers].sort();
    const bySource = new Map();
    for (const item of g.provenance) {
      const set = bySource.get(item.sourceId) ?? new Set();
      item.answers.forEach(answer => set.add(answer));
      bySource.set(item.sourceId, set);
    }
    const sourceAnswerSets = [...bySource.values()].map(set => [...set].map(normalizeAnswer).sort().join('\u0001'));
    const hasCrossSourceConflict = new Set(sourceAnswerSets).size > 1;
    return { id: g.id, question: g.question, aliases: [...g.aliases].filter(q => q !== g.question).sort(), answers, status: answers.length > 1 ? 'ambiguous' : 'confirmed', sourceIds: [...g.sourceIds].sort(), provenance: g.provenance, normalizedQuestion: g.normalizedQuestion, crossSourceConflict: hasCrossSourceConflict };
  });
}
export function buildReport(results, entries) {
  const conflicts = entries.filter(e => e.crossSourceConflict).map(({ id, question, answers, sourceIds }) => ({ id, question, answers, sourceIds }));
  return {
    schemaVersion: 1, generatedAt: now, sourceCount: results.length,
    successfulSources: results.filter(r => r.source.status === 'ok').length,
    failedSources: results.filter(r => r.source.status === 'failed').length,
    rawRecordCount: results.reduce((n, r) => n + r.source.rawCount, 0),
    normalizedEntryCount: entries.length,
    deduplicatedRecordCount: results.reduce((n, r) => n + r.records.length, 0) - entries.length,
    ambiguousEntryCount: entries.filter(e => e.status === 'ambiguous').length,
    conflictCount: conflicts.length,
    unrecognizedMarkdownBlocks: results.reduce((n, r) => n + r.source.unrecognizedBlocks, 0),
    unresolvedBySource: results.map(({ source }) => ({ sourceId: source.id, unrecognizedMarkdownBlocks: source.unrecognizedBlocks, status: source.status, error: source.error ?? null })),
    conflicts,
    failed: results.filter(r => r.source.status === 'failed').map(r => r.source),
  };
}
export async function generate() { const results = await Promise.all(SOURCES.map(fetchSource)), entries = mergeRecords(results), successful = results.filter(r => r.source.status === 'ok'), report = buildReport(results, entries), ambiguousEntries = entries.filter(e => e.status === 'ambiguous'); const sourceDoc = `# Question bank sources\n\nGenerated: ${now}\n\nThis data is for local use only. ` + `Commit is populated only from the GitHub commits API; API errors leave commit as null.\n\nTotal unrecognized Markdown blocks: ${report.unrecognizedMarkdownBlocks}\n\n| Source | Status | Ref | Commit | Commit status | License | SHA-256 | Records | Unrecognized blocks |\n|---|---|---|---|---|---|---|---:|---:|\n${results.map(({ source }) => `| ${source.repositoryFile} | ${source.status} | ${source.ref ?? 'n/a'} | ${source.commit ?? 'null'} | ${source.commitStatus} | ${source.license} | ${source.sha256 ?? 'n/a'} | ${source.rawCount} | ${source.unrecognizedBlocks} |`).join('\n')}\n`; await mkdir(OUTPUT, { recursive: true }); await writeFile(new URL('answer-bank.json', OUTPUT), JSON.stringify({ schemaVersion: 1, generatedAt: now, sources: results.map(r => r.source), entries }, null, 2) + '\n'); await writeFile(new URL('merge-report.json', OUTPUT), JSON.stringify(report, null, 2) + '\n'); await writeFile(new URL('SOURCES.md', OUTPUT), sourceDoc); console.log(`Merged ${entries.length} normalized entries from ${successful.length}/${results.length} sources; ${ambiguousEntries.length} ambiguous, ${report.conflictCount} cross-source conflicts.`); if (report.failedSources) { console.error(`WARNING: ${report.failedSources} source(s) failed; see data/merge-report.json.`); process.exitCode = 2; } }
if (import.meta.url === `file://${process.argv[1]}`) await generate();
