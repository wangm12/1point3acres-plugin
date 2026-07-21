(function (global) {
  const STORAGE_KEY = 'p3a-learned-answers-v1';
  const MAX_QUESTION_LENGTH = 500;
  const MAX_ANSWER_LENGTH = 300;
  const MAX_RECORDS = 500;
  const SOURCE = 'local-confirmed';
  const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
  const fallbackNormalize = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/(^|[^\p{L}\p{N}])([a-d])\s*[.)：:]\s*/giu, '$1')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u2000-\u206f\u3000-\u303f\uff01-\uff65]/g, '');
  function normalizeKey(value) {
    return global.QuestionMatcher?.normalize ? global.QuestionMatcher.normalize(value) : fallbackNormalize(value);
  }
  function validate(input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid-payload' };
    const question = text(input.question, MAX_QUESTION_LENGTH); const answer = text(input.answer, MAX_ANSWER_LENGTH);
    if (!question || !answer) return { ok: false, reason: 'invalid-question-or-answer' };
    return { ok: true, record: { question, answer, updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(), source: SOURCE } };
  }
  function normalizeRecords(value) {
    const list = Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : [];
    const map = new Map();
    for (const item of list) { const checked = validate(item); if (checked.ok) map.set(normalizeKey(checked.record.question), checked.record); }
    return [...map.values()].slice(-MAX_RECORDS);
  }
  function upsert(records, input) {
    const checked = validate(input); if (!checked.ok) return { ok: false, reason: checked.reason, records: normalizeRecords(records) };
    const next = normalizeRecords(records); const key = normalizeKey(checked.record.question); const index = next.findIndex((item) => normalizeKey(item.question) === key);
    if (index >= 0) next.splice(index, 1); next.push(checked.record);
    return { ok: true, record: checked.record, records: next.slice(-MAX_RECORDS) };
  }
  function toMatcherEntries(records, publicEntries = [], question, options) {
    const publicList = Array.isArray(publicEntries) ? publicEntries : [];
    const locals = normalizeRecords(records).map((record) => {
      const conflicts = publicList.filter((entry) => normalizeKey(entry.question) === normalizeKey(record.question) && (entry.answers || []).some((answer) => normalizeKey(answer) !== normalizeKey(record.answer))).map((entry) => ({ id: entry.id, answers: entry.answers || [] }));
      return { id: `learned:${normalizeKey(record.question)}`, question: record.question, answers: [record.answer], source: SOURCE, conflicts };
    });
    if (question !== undefined && Array.isArray(options)) {
      const matcher = global.QuestionMatcher?.lookup;
      const local = matcher && locals.find((entry) => matcher(question, options, [entry]).status === 'matched');
      return local ? [local] : publicList;
    }
    return locals.concat(publicList);
  }
  global.LearnedAnswers = Object.freeze({ STORAGE_KEY, MAX_QUESTION_LENGTH, MAX_ANSWER_LENGTH, MAX_RECORDS, SOURCE, normalizeKey, validate, normalizeRecords, upsert, toMatcherEntries });
})(globalThis);
