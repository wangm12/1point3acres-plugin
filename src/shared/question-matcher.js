(function (global) {
  const punctuation = /[\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u2000-\u206f\u3000-\u303f\uff01-\uff65]/g;
  function normalize(value) { return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}])([a-d])\s*[.)：:]\s*/giu, '$1').replace(/[\s\u00a0]+/g, '').replace(punctuation, ''); }

  function getNGrams(str, n = 2) {
    const s = String(str || '');
    if (s.length < n) return s ? [s] : [];
    const ngrams = [];
    for (let i = 0; i <= s.length - n; i++) ngrams.push(s.slice(i, i + n));
    return ngrams;
  }

  function calculateSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) {
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      return Math.max(0.6, ratio);
    }
    const bgA = getNGrams(a, 2);
    const bgB = getNGrams(b, 2);
    if (!bgA.length || !bgB.length) return 0;
    const mapB = new Map();
    for (const bg of bgB) mapB.set(bg, (mapB.get(bg) || 0) + 1);
    let inter = 0;
    for (const bg of bgA) {
      const count = mapB.get(bg);
      if (count > 0) { inter++; mapB.set(bg, count - 1); }
    }
    return (2 * inter) / (bgA.length + bgB.length);
  }

  function lookup(question, options, entries, state = {}) {
    if (state.requiresLogin) return { status: 'requires-login' };
    if (state.completed) return { status: 'completed' };
    const visible = Array.isArray(options) ? options : [];
    if (!question || !visible.length) return { status: 'unmatched', reason: 'no-question-or-options' };
    const text = normalize(question);
    const list = Array.isArray(entries) ? entries : [];

    // Tier 1: Exact question match
    const exactEntry = list.find((item) => [item.question, ...(item.aliases || [])].some((alias) => normalize(alias) === text));
    if (exactEntry) {
      const candidates = [...new Set((exactEntry.answers || []).map(normalize).filter(Boolean))];
      const unique = [...new Set(candidates.flatMap((answer) => visible.reduce((out, option, index) => { if (normalize(option) === answer) out.push(index); return out; }, [])))];
      // A merged bank entry may contain different answers for the same question.
      // The live option list is the disambiguation signal: one visible candidate
      // is safe to match, while multiple visible candidates still require review.
      if (unique.length === 1) return { status: 'matched', matchType: 'exact', optionIndex: unique[0], answerText: visible[unique[0]], entryId: exactEntry.id };
      if (unique.length > 1) return { status: 'ambiguous', matchType: 'exact', candidates: exactEntry.answers || [], entryId: exactEntry.id };
    }

    // Tier 2: Similar question & candidate answers aggregation
    const SIMILARITY_THRESHOLD = 0.35;
    const scoredEntries = [];
    for (const item of list) {
      const allQ = [item.question, ...(item.aliases || [])];
      let maxSim = 0;
      for (const q of allQ) {
        const sim = calculateSimilarity(text, normalize(q));
        if (sim > maxSim) maxSim = sim;
      }
      if (maxSim >= SIMILARITY_THRESHOLD) {
        scoredEntries.push({ item, similarity: maxSim });
      }
    }

    if (!scoredEntries.length) {
      return { status: 'unmatched', reason: exactEntry ? 'answer-not-visible' : 'not-in-bank', entryId: exactEntry?.id };
    }

    scoredEntries.sort((a, b) => b.similarity - a.similarity);

    const optionMatches = new Map();
    for (const { item, similarity } of scoredEntries) {
      const answers = (item.answers || []).map((ans) => ({ original: ans, norm: normalize(ans) })).filter((a) => a.norm);
      for (const { original, norm } of answers) {
        visible.forEach((option, index) => {
          if (normalize(option) === norm) {
            const prev = optionMatches.get(index);
            if (!prev || similarity > prev.similarity) {
              optionMatches.set(index, {
                optionIndex: index,
                answerText: option,
                similarity,
                entryId: item.id,
                candidateAnswer: original,
              });
            }
          }
        });
      }
    }

    const matches = [...optionMatches.values()].sort((a, b) => b.similarity - a.similarity);

    if (matches.length === 1) {
      return {
        status: 'matched',
        matchType: 'fuzzy',
        optionIndex: matches[0].optionIndex,
        answerText: matches[0].answerText,
        similarity: matches[0].similarity,
        entryId: matches[0].entryId,
      };
    }

    if (matches.length > 1) {
      const top = matches[0];
      const runnerUp = matches[1];
      if (top.similarity - runnerUp.similarity >= 0.08) {
        return {
          status: 'matched',
          matchType: 'fuzzy',
          optionIndex: top.optionIndex,
          answerText: top.answerText,
          similarity: top.similarity,
          entryId: top.entryId,
        };
      }
      return {
        status: 'ambiguous',
        matchType: 'fuzzy',
        candidates: matches.map((m) => m.candidateAnswer),
        entryId: top.entryId,
      };
    }

    return { status: 'unmatched', reason: 'answer-not-visible', entryId: exactEntry?.id || scoredEntries[0]?.item?.id };
  }

  global.QuestionMatcher = Object.freeze({ normalize, getNGrams, calculateSimilarity, lookup });
})(globalThis);

