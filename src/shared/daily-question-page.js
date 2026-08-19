(function (global) {
  const TOOLBAR_ID = 'p3a-daily-question-helper';
  const BAD_TEXT = /^(?:导航|搜索|返回旧版|我的版块|优惠|热门帖子|最新优惠|登录|签到|提交|确认|返回|刷新|取消|页脚|首页|注册|下一页|上一页|分页|menu|login|check.?in|submit|cancel|refresh|sign.?up|back|search|pagination)$/i;
  const SUBMIT_TEXT = /提交答案|确认答案|提交|confirm\s*answer|submit/i;
  const STATUS = Object.freeze({
    login: /请先登录|请登录|登录后|login required|sign in/i,
    completed: /今日已答题|已经答过|今日答题已完成|答题成功|already answered/i,
  });
  const COMPLETED_CONTROL = /^(?:今日已答题|已经答过|今日答题已完成|already answered)$/i;
  const clean = (value) => String(value?.textContent ?? value ?? '').replace(/\s+/g, ' ').trim();
  const cleanQuestionText = (value) => String(value || '').replace(/^(?:【(?:题目|问题)】|(?:题目|问题)\s*[:：])\s*/u, '').trim();
  const withinToolbar = (node) => Boolean(node?.closest?.(`#${TOOLBAR_ID}`));
  const scopeNodes = (root, selector) => Array.from(root.querySelectorAll?.(selector) || []).filter((node) => !withinToolbar(node));
  const containsQuestionSignal = (node) => {
    if (!node) return false;
    return Boolean(
      node.querySelector?.('[data-question-container], [data-question], [class*="question"], [class*="daily-question"], [role="heading"], h1, h2, h3')
      || clean(node).length > 8 && /[?？]/.test(clean(node)),
    );
  };
  const taskScope = (root = global.document) => {
    const questionAnchors = [...scopeNodes(root, '[data-question-container]'), ...scopeNodes(root, '[data-question]')];
    const questionContainers = questionAnchors
      .map((node) => node.closest?.('[data-question-container], [data-question], [class*="daily-question"], main, [role="main"]') || node)
      .filter((node, index, all) => all.indexOf(node) === index);
    const questionScope = questionContainers.find((node) => containsQuestionSignal(node) && (node.querySelector?.('button,[role="option"]') || node.querySelector?.('h1,h2,h3,[role="heading"],[class*="question"]')));
    if (questionScope) return questionScope;
    const heading = scopeNodes(root, 'main h1, main h2, main h3, main [role="heading"], [class*="question"], [class*="daily-question"]')
      .map((node) => node.closest?.('[data-question-container], [data-question], [class*="daily-question"], main, [role="main"]') || node)
      .find((node) => containsQuestionSignal(node) && node.querySelector?.('button,[role="option"]'));
    if (heading) return heading;
    const nestedMain = scopeNodes(root, 'main main').find((node) => node.querySelector?.('button,[role="option"], h1,h2,h3,[role="heading"]'));
    if (nestedMain) return nestedMain;
    const main = scopeNodes(root, 'main').find((node) => containsQuestionSignal(node) && node.querySelector?.('button,[role="option"]'));
    if (main) return main;
    return null;
  };
  const isVisible = (node) => {
    if (!node || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
    const style = global.getComputedStyle?.(node);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  };
  const isQuestionPage = (url = global.location?.href || '') => /\/next\/daily-question\/?(?:[?#].*)?$/.test(url);
  const hasCompletedControl = (root = global.document, scope = taskScope(root)) => {
    const searchRoot = scope || root;
    const controls = Array.from(searchRoot.querySelectorAll?.('button,input[type="button"],input[type="submit"],[role="button"]') || []);
    return controls.some((node) => {
      if (withinToolbar(node)) return false;
      if (!node.disabled && node.getAttribute?.('aria-disabled') !== 'true') return false;
      return COMPLETED_CONTROL.test(clean(node));
    });
  };

  function scoreQuestion(node) {
    const value = clean(node);
    if (value.length < 8 || value.length > 500 || BAD_TEXT.test(value) || withinToolbar(node)) return -Infinity;
    let score = 0;
    if (node.closest?.('main')) score += 30;
    if (node.matches?.('[class*="question"], [class*="text-orange"], [class*="text-lg"], [data-question], [aria-label*="question" i]')) score += 60;
    if (node.closest?.('[data-question], [class*="question"], [class*="daily-question"]')) score += 45;
    if (/[?？]/.test(value)) score += 25;
    if (value.length >= 20) score += Math.min(20, Math.floor(value.length / 30));
    if (/^[A-D][.)：:]/i.test(value)) score -= 50;
    return score;
  }

  function findQuestionContainer(root = global.document) {
    const selectors = [
      '[data-question-container]', '[data-question]', '[class*="question"]',
      'main [class*="text-orange"]', 'main [class*="text-lg"]',
    ];
    for (const selector of selectors) {
      const node = root.querySelector?.(selector);
      if (node && scoreQuestion(node) > -Infinity) return node.closest?.('[data-question-container], [data-question], [class*="question"], main') || node;
    }
    return null;
  }

  function findQuestion(root = global.document) {
    const container = findQuestionContainer(root);
    const candidates = [];
    if (container) candidates.push(container, ...Array.from(container.querySelectorAll?.('h1,h2,h3,p,[role="heading"],span,div') || []));
    candidates.push(...Array.from(root.querySelectorAll?.('main h1,main h2,main h3,main p,main [role="heading"],main [data-question],main [class*="question"]') || []));
    const ranked = candidates.map((node) => ({ node, value: cleanQuestionText(clean(node)), score: scoreQuestion(node) }))
      .filter((item) => Number.isFinite(item.score)).sort((a, b) => b.score - a.score || b.value.length - a.value.length);
    return ranked[0] || { node: null, value: '', score: -Infinity };
  }

  function isOption(node) {
    const value = clean(node);
    return Boolean(value) && value.length <= 300 && !withinToolbar(node) && !node.disabled && node.getAttribute?.('type') !== 'submit' && !BAD_TEXT.test(value) && !SUBMIT_TEXT.test(value);
  }

  function isOptionLike(node) {
    if (!isOption(node)) return false;
    const role = node.getAttribute?.('role');
    const classes = String(node.className?.baseVal || node.className || '');
    // Selection changes the background class (for example to bg-green-200).
    // Use the stable option shape to locate the group, then return every
    // valid sibling in that group from findOptions.
    return role === 'option' || (/cursor-pointer/.test(classes) && /rounded-md/.test(classes));
  }

  function groupedFallback(nodes) {
    const groups = new Map();
    for (const node of nodes) {
      const parent = node.parentElement || node.parentNode;
      if (!parent) continue;
      const group = groups.get(parent) || [];
      group.push(node);
      groups.set(parent, group);
    }
    return [...groups.values()].filter((group) => group.length >= 2)
      .sort((a, b) => b.length - a.length)[0] || [];
  }

  function findOptions(root = global.document, container = findQuestionContainer(root)) {
    const scope = container?.querySelector?.('button,[role="option"]')
      ? container
      : container?.closest?.('main main, main, [role="main"]') || root.querySelector?.('main main, main, [role="main"], main') || root;
    const local = Array.from(scope.querySelectorAll?.('button,[role="option"]') || []).filter(isOption);
    const optionLike = local.filter(isOptionLike);
    if (optionLike.length >= 2) {
      const groups = new Map();
      for (const node of optionLike) {
        const parent = node.parentElement || node.parentNode;
        if (!parent) continue;
        const group = groups.get(parent) || [];
        group.push(node);
        groups.set(parent, group);
      }
      const group = [...groups.values()].filter((candidate) => candidate.length >= 2)
        .sort((a, b) => b.length - a.length)[0];
      if (group) {
        const parent = group[0].parentElement || group[0].parentNode;
        return local.filter((node) => (node.parentElement || node.parentNode) === parent);
      }
    }
    const fallback = groupedFallback(local);
    return fallback.length >= 2 ? fallback : [];
  }

  function findSubmit(root = global.document) {
    const scope = root.querySelector?.('main') || root;
    const buttons = Array.from(scope.querySelectorAll?.('button') || []);
    return buttons.find((node) => !withinToolbar(node) && isVisible(node) && !node.disabled && node.getAttribute?.('type') !== 'button' && SUBMIT_TEXT.test(clean(node)))
      || buttons.find((node) => !withinToolbar(node) && isVisible(node) && !node.disabled && SUBMIT_TEXT.test(clean(node))) || null;
  }
  function findSelectedOption(root = global.document, options = findOptions(root)) {
    const selected = options.filter((node) => {
      const aria = node.getAttribute?.('aria-checked') === 'true' || node.getAttribute?.('aria-selected') === 'true';
      const pressed = node.getAttribute?.('aria-pressed') === 'true';
      const checked = node.getAttribute?.('checked') !== null || node.checked === true;
      const state = ['checked', 'selected', 'active'].includes(node.getAttribute?.('data-state')) || node.getAttribute?.('data-selected') === 'true';
      const classes = String(node.className?.baseVal || node.className || '');
      // Extension p3a-answer-* markers are not site selection state.
      const stable = /(?:^|[ _:-])(?:selected|is-selected|active|checked|option--selected|peer-checked)(?:$|[ _:-])/i.test(classes)
        || /(?:^|[ _-])(?:bg-(?:green|blue)-\d+|ring-\d+)(?:$|[ _-])/i.test(classes)
        || /(?:^|\s)bg-primary(?:$|\s)/i.test(classes);
      return aria || pressed || checked || state || stable;
    });
    return selected.length === 1 ? selected[0] : null;
  }

  function getState(root = global.document) {
    const scope = taskScope(root);
    const body = scope ? String(scope.innerText || scope.textContent || '') : String(root.body?.innerText || root.body?.textContent || '');
    if (STATUS.login.test(body)) return 'requires-login';
    if (hasCompletedControl(root, scope) || STATUS.completed.test(body)) return 'completed';
    return 'active';
  }

  global.DailyQuestionPage = Object.freeze({ TOOLBAR_ID, clean, isQuestionPage, findQuestionContainer, findQuestion, findOptions, findSelectedOption, findSubmit, getState });
})(globalThis);
