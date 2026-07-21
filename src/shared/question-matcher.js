(function (global) {
  const punctuation = /[\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u2000-\u206f\u3000-\u303f\uff01-\uff65]/g;
  function normalize(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}])([a-d])\s*[.)：:]\s*/giu, '$1').replace(/[\s\u00a0]+/g, '').replace(punctuation, ''); }
  function lookup(question, options, entries, state = {}) {
    if (state.requiresLogin) return { status: 'requires-login' };
    if (state.completed) return { status: 'completed' };
    const visible = Array.isArray(options) ? options : [];
    if (!question || !visible.length) return { status: 'unmatched', reason: 'no-question-or-options' };
    const text = normalize(question);
    const entry = (Array.isArray(entries) ? entries : []).find((item) => [item.question, ...(item.aliases || [])].some((alias) => normalize(alias) === text));
    if (!entry) return { status: 'unmatched', reason: 'not-in-bank' };
    const candidates = [...new Set((entry.answers || []).map(normalize).filter(Boolean))];
    const unique = [...new Set(candidates.flatMap((answer) => visible.reduce((out, option, index) => { if (normalize(option) === answer) out.push(index); return out; }, [])))];
    if (unique.length === 1 && candidates.length === 1) return { status: 'matched', optionIndex: unique[0], answerText: visible[unique[0]], entryId: entry.id };
    if (unique.length > 1 || candidates.length > 1) return { status: 'ambiguous', candidates: entry.answers || [], entryId: entry.id };
    return { status: 'unmatched', reason: 'answer-not-visible', entryId: entry.id };
  }
  global.QuestionMatcher = Object.freeze({ normalize, lookup });
})(globalThis);
