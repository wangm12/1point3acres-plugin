const detectPageKind = (url = location.href) => {
  if (url.includes('/next/daily-question')) {
    return 'daily-question';
  }

  if (url.includes('/next/daily-checkin')) {
    return 'daily-checkin';
  }

  return 'unknown';
};

const bridge = Object.freeze({
  send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        ExtensionProtocol.createMessage(type, {
          ...payload,
          pageKind: detectPageKind(),
          url: location.href,
        }),
        (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(response);
        },
      );
    });
  },
});

const toolbarId = 'p3a-daily-question-helper';
const checkinToolbarId = DailyCheckinPage.TOOLBAR_ID;
const getQuestionToolbar = () => document.getElementById(toolbarId);
const checkinToastId = 'p3a-checkin-complete-toast';
let checkinToastTimer = null;
const showCheckinToast = (message = '签到完成') => {
  let toast = document.getElementById(checkinToastId);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = checkinToastId;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  clearTimeout(checkinToastTimer);
  checkinToastTimer = setTimeout(() => { toast.remove(); }, 3000);
};
// Kept as a narrow guard for any future content-side scans; the page adapter owns actual option discovery.
const isToolbarButton = (button) => button.closest(`#${toolbarId}`);
const legacySubmitText = /提交答案|提交|确认答案/;
const isQuestionPage = () => DailyQuestionPage.isQuestionPage(location.href);
const pendingRemoteActions = new Set();
const remoteActionTimers = new Map();
const remoteActionResults = new Map();
const remoteActionToastMessages = new Map();
const REMOTE_ACTION_TIMEOUT_MS = 5000;
// Keep the initial render and the full one-click question action within the
// same bounded five-second budget.
const QUESTION_READY_TIMEOUT_MS = 5000;
const REMOTE_ACTION_RETRY_MS = 200;
let activeRemoteActionId = null;
const REMOTE_RESULT_TIMEOUT_MS = 16000;
const CAPTCHA_GRACE_PERIOD_MS = 10000;
const REMOTE_RESULT_REPORT_MAX_RETRIES = 5;
const REMOTE_RESULT_REPORT_DELAY_MS = 200;
const REMOTE_RESULT_STORAGE_KEY = 'p3a-pending-remote-results-v1';
const QUESTION_SUBMIT_WAIT_MS = 4000;
const QUESTION_SUBMIT_POLL_MS = 100;
const CHECKIN_SUBMIT_WAIT_MS = 2000;
const CHECKIN_SUBMIT_POLL_MS = 100;
const QUESTION_LOOKUP_RESPONSE_TIMEOUT_MS = 1500;
const QUESTION_LOOKUP_RETRY_DELAY_MS = 250;
let questionStatusNode = null;
let checkinStatusNode = null;
let lastReportedPageSignature = null;
let pendingRemoteResultStore = null;
let pendingRemoteResultStorePromise = null;
const resultStorage = chrome.storage?.local || null;
const cleanTextValue = (value) => String(value?.textContent ?? value ?? '').replace(/\s+/g, ' ').trim();
const awaitResponseOrTimeout = (promise, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish(null), timeoutMs);
  Promise.resolve(promise).then(finish, () => finish(null));
});
const lookupQuestionForRender = async (question, options, timeoutMs = QUESTION_LOOKUP_RESPONSE_TIMEOUT_MS) => {
  try {
    const response = await awaitResponseOrTimeout(
      bridge.send(ExtensionProtocol.MESSAGE_TYPES.LOOKUP_QUESTION, { question, options }),
      timeoutMs,
    );
    return response?.payload || null;
  } catch {
    return null;
  }
};
const getTaskPageUrl = (url = location.href) => {
  try {
    const parsed = new URL(url, location.origin);
    if (detectPageKind(parsed.href) === 'daily-question') return `${parsed.origin}/next/daily-question`;
    if (detectPageKind(parsed.href) === 'daily-checkin') return `${parsed.origin}/next/daily-checkin`;
    return parsed.origin + parsed.pathname;
  } catch {
    return String(url || '');
  }
};
const getTabIdentity = () => {
  if (!globalThis.__p3aTabIdentity) {
    const existing = typeof window?.name === 'string' ? window.name : '';
    const match = existing.match(/(?:^|\|)p3a-tab-([a-z0-9-]+)(?:\||$)/i);
    const token = match?.[1] || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    globalThis.__p3aTabIdentity = `p3a-tab-${token}`;
    if (typeof window?.name === 'string' && !window.name.includes(globalThis.__p3aTabIdentity)) {
      window.name = window.name ? `${window.name}|${globalThis.__p3aTabIdentity}` : globalThis.__p3aTabIdentity;
    }
  }
  return globalThis.__p3aTabIdentity;
};
const getPendingRemoteResultScope = () => ({
  pageKind: detectPageKind(),
  taskUrl: getTaskPageUrl(),
  tabIdentity: getTabIdentity(),
});
const isSamePendingRemoteResultScope = (record, scope = getPendingRemoteResultScope()) => {
  if (!record || typeof record !== 'object') return false;
  if (record.pageKind !== scope.pageKind) return false;
  if (record.taskUrl !== scope.taskUrl) return false;
  return record.tabIdentity === scope.tabIdentity;
};
const loadPendingRemoteResultStore = async () => {
  if (!resultStorage?.get || !resultStorage?.set) {
    pendingRemoteResultStore = pendingRemoteResultStore || {};
    return pendingRemoteResultStore;
  }
  if (pendingRemoteResultStore) return pendingRemoteResultStore;
  if (!pendingRemoteResultStorePromise) {
    pendingRemoteResultStorePromise = resultStorage.get(REMOTE_RESULT_STORAGE_KEY).then((stored) => {
      const records = stored?.[REMOTE_RESULT_STORAGE_KEY];
      pendingRemoteResultStore = records && typeof records === 'object' ? { ...records } : {};
      return pendingRemoteResultStore;
    }).catch(() => {
      pendingRemoteResultStore = {};
      return pendingRemoteResultStore;
    }).finally(() => {
      pendingRemoteResultStorePromise = null;
    });
  }
  return pendingRemoteResultStorePromise;
};
const savePendingRemoteResultStore = async () => {
  await loadPendingRemoteResultStore();
  if (!resultStorage?.set) return;
  await resultStorage.set({ [REMOTE_RESULT_STORAGE_KEY]: pendingRemoteResultStore || {} }).catch(() => {});
};
const queuePendingRemoteResult = async (actionId, result) => {
  if (!actionId) return;
  await loadPendingRemoteResultStore();
  const scope = getPendingRemoteResultScope();
  pendingRemoteResultStore[actionId] = {
    ...result,
    actionId,
    pageKind: scope.pageKind,
    taskUrl: scope.taskUrl,
    tabIdentity: scope.tabIdentity,
    url: location.href,
    updatedAt: Date.now(),
  };
  await savePendingRemoteResultStore();
};
const clearPendingRemoteResult = async (actionId) => {
  if (!actionId) return;
  await loadPendingRemoteResultStore();
  if (!pendingRemoteResultStore[actionId]) return;
  delete pendingRemoteResultStore[actionId];
  await savePendingRemoteResultStore();
};
const getPendingRemoteResult = async (actionId) => {
  if (!actionId) return null;
  const store = await loadPendingRemoteResultStore();
  const record = store?.[actionId];
  return record && typeof record === 'object' ? { ...record } : null;
};
const detectPageState = () => {
  if (isQuestionPage()) return DailyQuestionPage.getState();
  if (isCheckinPage()) return DailyCheckinPage.getState();
  return 'unknown';
};
const getContentReadySignature = () => `${detectPageKind()}:${detectPageState()}`;
const reportContentReady = (force = false) => {
  const pageSignature = getContentReadySignature();
  if (!force && pageSignature === lastReportedPageSignature) return;
  lastReportedPageSignature = pageSignature;
  const pageState = pageSignature.slice(pageSignature.indexOf(':') + 1);
  bridge.send(ExtensionProtocol.MESSAGE_TYPES.CONTENT_READY, { pageKind: detectPageKind(), pageState }).catch(() => {});
  flushPendingRemoteResults().catch(() => {});
};
const clickVisibleQuestionSubmit = (button) => {
  // Next/React may replace the submit node after the option click. Never
  // reject a valid submission merely because the node identity changed.
  const current = DailyQuestionPage.findSubmit() || button;
  if (!current || current.disabled || !current.isConnected) throw new Error('submit-button-stale-or-unavailable');
  if (typeof current.click === 'function') { current.click(); return; }
  if (typeof current.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
    current.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return;
  }
  throw new Error('submit-button-not-clickable');
};
const reportingRemoteActions = new Set();
const finalizeDeliveredRemoteResult = async (actionId, result) => {
  if (remoteActionResults.has(actionId)) {
    remoteActionResults.set(actionId, { ...remoteActionResults.get(actionId), delivered: true });
  }
  await clearPendingRemoteResult(actionId);
  if (result?.status === 'success') {
    const toastMessage = result?.toastMessage || remoteActionToastMessages.get(actionId) || (result?.action === 'question' ? '答题完成' : '签到完成');
    showCheckinToast(toastMessage);
  }
  remoteActionToastMessages.delete(actionId);
  return true;
};
const reportRemoteResult = async (actionId, action, status, reason) => {
  if (!actionId) return false;
  const result = remoteActionResults.get(actionId);
  const pendingResult = await getPendingRemoteResult(actionId);
  const payload = pendingResult || {
    actionId,
    action,
    status,
    reason,
    toastMessage: remoteActionToastMessages.get(actionId) || (action === 'question' ? '答题完成' : '签到完成'),
  };
  if (result?.delivered === true && !pendingResult) return true;
  if (reportingRemoteActions.has(actionId)) return false;
  reportingRemoteActions.add(actionId);
  try {
    await queuePendingRemoteResult(actionId, payload);
    for (let attempt = 1; attempt <= REMOTE_RESULT_REPORT_MAX_RETRIES; attempt += 1) {
      try {
        const response = await bridge.send(ExtensionProtocol.MESSAGE_TYPES.ACTION_RESULT, {
          actionId,
          action: payload.action,
          status: payload.status,
          reason: payload.reason,
        });
        if (response?.ok === true && response?.accepted === true && (!response?.actionId || response.actionId === actionId)) {
          return finalizeDeliveredRemoteResult(actionId, payload);
        }
      } catch {}
      if (attempt < REMOTE_RESULT_REPORT_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, REMOTE_RESULT_REPORT_DELAY_MS));
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    reportingRemoteActions.delete(actionId);
  }
};
const finishRemoteAction = (actionId, action, status, reason) => {
  const toastMessage = remoteActionToastMessages.get(actionId) || (action === 'question' ? '答题完成' : '签到完成');
  if (!actionId) {
    activeRemoteActionId = null;
    if (status === 'success') showCheckinToast(toastMessage);
    return;
  }
  remoteActionResults.set(actionId, { action, status, reason, delivered: false, toastMessage });
  remoteActionTimers.delete(actionId);
  pendingRemoteActions.delete(actionId);
  if (activeRemoteActionId === actionId) activeRemoteActionId = null;
  reportRemoteResult(actionId, action, status, reason).catch(() => {});
};
const pauseRemoteAction = (actionId, action, reason) => {
  if (!actionId) {
    activeRemoteActionId = null;
    return;
  }
  remoteActionTimers.delete(actionId);
  pendingRemoteActions.delete(actionId);
  if (activeRemoteActionId === actionId) activeRemoteActionId = null;
  remoteActionToastMessages.delete(actionId);
  reportRemoteResult(actionId, action, 'login-blocked', reason).catch(() => {});
};
const CAPTCHA_TEXT_RE = /请输入验证码|请填写验证码|填写验证码|验证码|captcha|verification code|security check|请完成(?:安全)?验证|安全验证|人机验证|滑动验证|点选验证|点击倒立文字|拖动滑块|完成拼图|点击图中的|验证码已过期|请重新验证|turnstile|geetest/i;
const CAPTCHA_ERROR_RE = /验证码错误|校验失败|验证失败|安全验证失败/i;
const CAPTCHA_ATTR_RE = /captcha|verify|verification|challenge|geetest|gt[-_]?captcha|hcaptcha|recaptcha|turnstile|aliyun|yidun|tcaptcha|arkoselabs|funcaptcha|mcaptcha|dx-captcha|vaptcha/i;
const CAPTCHA_WIDGET_TAG_RE = /^(?:IFRAME|IMG|CANVAS|OBJECT|EMBED)$/i;
const CAPTCHA_WIDGET_ROLE_RE = /button|dialog|group|presentation|region/i;
const readNodeText = (node) => String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
const readNodeAttributes = (node) => {
  const names = ['id', 'class', 'name', 'role', 'title', 'aria-label', 'placeholder', 'src', 'data-testid', 'data-test', 'data-widget', 'data-captcha', 'data-sitekey'];
  return names
    .map((name) => {
      if (name === 'class') return String(node?.className || '');
      return String(node?.getAttribute?.(name) || '');
    })
    .filter(Boolean)
    .join(' ');
};
const hasShadowTree = (node) => Boolean(node?.shadowRoot && (node.shadowRoot.children?.length || node.shadowRoot.querySelector?.('*')));
const walkScopeNodes = (root, visitor) => {
  const queue = [root];
  const visited = new Set();
  while (queue.length) {
    const node = queue.shift();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    if (visitor(node) === true) return true;
    for (const child of node.children || []) queue.push(child);
    if (node.shadowRoot) queue.push(node.shadowRoot);
  }
  return false;
};
const hasConservativeCaptchaPrompt = (taskRoot) => {
  if (!taskRoot) return false;

  // 1. Check for global overlay or modal iframes attached to the document body
  if (typeof document?.querySelector === 'function') {
    const globalCaptchaEl = document.querySelector(
      'iframe[src*="captcha"], iframe[src*="geetest"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .geetest_holder, .g-recaptcha, .cf-turnstile, [class*="captcha-modal"], [class*="captcha_modal"], [id*="captcha_box"], [id*="geetest"], [class*="yidun"], [class*="tcaptcha"]'
    );
    if (globalCaptchaEl) return true;
  }

  const scopeText = readNodeText(taskRoot);
  if (CAPTCHA_ERROR_RE.test(scopeText)) return false;
  const scopeMentionsCaptcha = CAPTCHA_TEXT_RE.test(scopeText);
  let hasDirectPromptControl = false;
  let hasSuspiciousWidget = false;
  walkScopeNodes(taskRoot, (node) => {
    if (node === taskRoot) return false;
    const tagName = String(node?.tagName || '').toUpperCase();
    const attrs = readNodeAttributes(node);
    const nodeText = readNodeText(node);
    const combined = `${attrs} ${nodeText}`.trim();
    const attrHint = CAPTCHA_ATTR_RE.test(combined);
    if ((tagName === 'INPUT' || tagName === 'TEXTAREA') && (scopeMentionsCaptcha || attrHint || CAPTCHA_TEXT_RE.test(nodeText))) {
      hasDirectPromptControl = true;
      return true;
    }
    if ((tagName === 'BUTTON' || String(node?.getAttribute?.('role') || '').match(CAPTCHA_WIDGET_ROLE_RE)) && (scopeMentionsCaptcha || attrHint || CAPTCHA_TEXT_RE.test(nodeText))) {
      hasDirectPromptControl = true;
      return true;
    }
    if (attrHint || (hasShadowTree(node) && (scopeMentionsCaptcha || attrHint)) || (CAPTCHA_WIDGET_TAG_RE.test(tagName) && (scopeMentionsCaptcha || attrHint))) {
      hasSuspiciousWidget = true;
    }
    return false;
  });
  return hasDirectPromptControl || hasSuspiciousWidget;
};
const getRemoteResultScope = (action) => {
  if (action === 'question') {
    return DailyQuestionPage.findQuestionContainer(document)
      || DailyQuestionPage.findQuestion(document).node?.closest?.('main')
      || document.querySelector?.('main')
      || document.body;
  }
  const defaultNode = DailyCheckinPage.findDefault();
  return defaultNode?.closest?.('[data-checkin], [data-page="daily-checkin"], [class*="daily-checkin"], form, main')
    || document.querySelector?.('main')
    || document.body;
};
const waitForRemoteResult = (action, actionId, status) => new Promise((resolve) => {
  const started = Date.now();
  let captchaFirstSeenAt = null;

  const timer = setInterval(() => {
    const state = action === 'question' ? DailyQuestionPage.getState() : DailyCheckinPage.getState();
    const taskRoot = getRemoteResultScope(action);
    const scopedBody = String(taskRoot?.innerText || taskRoot?.textContent || '');
    // Success toasts are sometimes mounted outside the form/main returned by
    // getRemoteResultScope. Include the page text as a fallback so a genuine
    // submission cannot time out merely because the toast moved in the DOM.
    const documentBody = String(document.body?.innerText || document.body?.textContent || '');
    const body = action === 'checkin' && scopedBody !== documentBody
      ? `${scopedBody}\n${documentBody}`
      : scopedBody;

    // 1. Explicit error check: if the site explicitly says captcha error / verification failed, fail immediately
    if (CAPTCHA_ERROR_RE.test(body)) {
      clearInterval(timer); finishRemoteAction(actionId, action, 'failed', 'captcha-error'); resolve(false); return;
    }

    const successText = action === 'question'
      ? /答题成功|恭喜[\s\S]{0,20}(?:答对|回答正确)[\s\S]{0,20}(?:获得|得到|赢得)[\s\S]{0,12}(?:大米|米)|(?:已获得|已到账|到账)[\s\S]{0,12}(?:大米|米)|今日已答题|已经答过/i
      : /签到成功|签到完成|今日已签到|已经签到/i;
    const pendingCaptchaRe = /(?:请输入|请完成|需要|继续|通过)[^。！？\n]{0,24}(?:验证码|安全验证|人机验证)/i;
    const isCompleted = (state === 'completed' || successText.test(body)) && !pendingCaptchaRe.test(body);

    // 2. Success check: if already completed (and not pending captcha input), finish immediately
    if (isCompleted) {
      clearInterval(timer); finishRemoteAction(actionId, action, 'success', 'completed'); resolve(true); return;
    }

    const hasCaptchaPrompt = hasConservativeCaptchaPrompt(taskRoot);

    // 3. Cloudflare / Captcha challenge check with grace period for automatic resolution
    if (hasCaptchaPrompt) {
      if (captchaFirstSeenAt == null) {
        captchaFirstSeenAt = Date.now();
      }
      // If the challenge persists past the grace period, treat it as a true Hard Block
      if (Date.now() - captchaFirstSeenAt >= CAPTCHA_GRACE_PERIOD_MS) {
        clearInterval(timer); finishRemoteAction(actionId, action, 'failed', 'captcha-required'); resolve(false); return;
      }
      // While captcha is active and within grace period, keep polling in background
      return;
    }

    // Captcha is not active (or was auto-resolved/dismissed)
    captchaFirstSeenAt = null;

    // 4. Requires login check
    if (state === 'requires-login') {
      clearInterval(timer); pauseRemoteAction(actionId, action, 'requires-login'); resolve(false); return;
    }

    // 5. Site failed check
    if (/提交失败|操作失败|系统错误/i.test(body)) {
      clearInterval(timer); finishRemoteAction(actionId, action, 'failed', 'site-failed'); resolve(false); return;
    }

    // 6. Overall timeout check
    if (Date.now() - started >= REMOTE_RESULT_TIMEOUT_MS) {
      clearInterval(timer); finishRemoteAction(actionId, action, 'failed', 'timeout'); resolve(false);
    }
  }, 200);
});
const flushPendingRemoteResults = async () => {
  const store = await loadPendingRemoteResultStore();
  const scope = getPendingRemoteResultScope();
  const entries = Object.entries(store || {});
  for (const [actionId, result] of entries) {
    if (!result || typeof result !== 'object') {
      delete pendingRemoteResultStore[actionId];
      continue;
    }
    if (!result.actionId || result.actionId !== actionId || !result.pageKind || !result.taskUrl || !result.tabIdentity) {
      delete pendingRemoteResultStore[actionId];
      continue;
    }
    if (!isSamePendingRemoteResultScope(result, scope)) continue;
    await reportRemoteResult(actionId, result.action, result.status, result.reason);
  }
  await savePendingRemoteResultStore();
};
const waitForQuestionSubmit = async (questionKey, optionTexts, answerText) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < QUESTION_SUBMIT_WAIT_MS) {
    const questionResult = DailyQuestionPage.findQuestion();
    const currentQuestion = normalizeQuestion(questionResult.value);
    const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer());
    if (currentQuestion !== questionKey || currentOptions.map(DailyQuestionPage.clean).join('\u0001') !== optionTexts.join('\u0001')) return { ok: false, reason: 'question-changed-or-unavailable' };
    const matching = currentOptions.filter((node) => DailyQuestionPage.clean(node) === answerText);
    if (matching.length !== 1) return { ok: false, reason: 'answer-option-ambiguous' };
    const selected = DailyQuestionPage.findSelectedOption(document, currentOptions);
    const siteSubmit = DailyQuestionPage.findSubmit();
    // Require both independent site-owned signals. Extension p3a-answer-*
    // markers are deliberately ignored by findSelectedOption.
    if (selected === matching[0] && siteSubmit && !siteSubmit.disabled) return { ok: true, button: siteSubmit };
    await new Promise((resolve) => setTimeout(resolve, QUESTION_SUBMIT_POLL_MS));
  }
  return { ok: false, reason: 'submit-timeout' };
};
const waitForCheckinSubmit = async () => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CHECKIN_SUBMIT_WAIT_MS) {
    const submit = DailyCheckinPage.findSubmit();
    if (submit && !submit.disabled && submit.isConnected !== false) return submit;
    await new Promise((resolve) => setTimeout(resolve, CHECKIN_SUBMIT_POLL_MS));
  }
  return null;
};
const waitForStableQuestionSnapshot = async (startedAt, deadlineMs = REMOTE_ACTION_TIMEOUT_MS) => {
  let lastSignature = '';
  let stableCount = 0;
  let initialReadySignature = null;
  while (Date.now() - startedAt < deadlineMs) {
    const state = DailyQuestionPage.getState();
    const questionResult = DailyQuestionPage.findQuestion();
    const question = normalizeQuestion(questionResult.value);
    const questionContainer = DailyQuestionPage.findQuestionContainer();
    const optionNodes = DailyQuestionPage.findOptions(document, questionContainer);
    const optionTexts = optionNodes.map(DailyQuestionPage.clean);
    if (state === 'requires-login') return { ok: false, reason: 'requires-login' };
    if (state === 'completed') return { ok: true, completed: true };
    if (!question || !optionTexts.length) {
      lastSignature = '';
      stableCount = 0;
      await new Promise((resolve) => setTimeout(resolve, REMOTE_ACTION_RETRY_MS));
      continue;
    }
    const signature = `${question}\u0001${optionTexts.join('\u0001')}`;
    if (!initialReadySignature) {
      initialReadySignature = signature;
    } else if (signature !== initialReadySignature) {
      return { ok: false, reason: 'question-changed-or-unavailable' };
    }
    if (signature === lastSignature) stableCount += 1; else stableCount = 1;
    lastSignature = signature;
    if (stableCount >= 2) {
      return { ok: true, question, optionNodes, optionTexts, state };
    }
    await new Promise((resolve) => setTimeout(resolve, REMOTE_ACTION_RETRY_MS));
  }
  return { ok: false, reason: 'question-not-ready' };
};
const runQuestionAction = async ({ actionId = null, workflowId = null } = {}) => {
  if (actionId) {
    pendingRemoteActions.add(actionId);
    activeRemoteActionId = actionId;
    remoteActionToastMessages.set(actionId, workflowId ? '签到和答题完成' : '答题完成');
    answerActionId = actionId;
  }
  const status = questionStatusNode || { textContent: '' };
  const failRemote = actionId ? (reason) => finishRemoteAction(actionId, 'question', 'failed', reason) : () => {};
  try {
    const startedAt = Date.now();
    const questionReadyTimeoutMs = actionId ? QUESTION_READY_TIMEOUT_MS : REMOTE_ACTION_TIMEOUT_MS;
    while (Date.now() - startedAt < REMOTE_ACTION_TIMEOUT_MS) {
      const snapshot = await waitForStableQuestionSnapshot(startedAt, questionReadyTimeoutMs);
      if (!snapshot.ok) {
        if (snapshot.reason === 'requires-login') {
          pauseRemoteAction(actionId, 'question', 'requires-login');
          status.textContent = '需登录：登录后会自动继续答题';
          return;
        }
        failRemote(snapshot.reason);
        status.textContent = snapshot.reason === 'question-not-ready'
            ? '题目或选项未稳定，未提交'
            : '题目或选项已变化，未提交';
        return;
      }
      if (snapshot.completed) { finishRemoteAction(actionId, 'question', 'success', 'already-completed'); status.textContent = '已完成：今日已答题'; return; }
      const lookupResponse = await bridge.send(ExtensionProtocol.MESSAGE_TYPES.LOOKUP_QUESTION, { question: snapshot.question, options: snapshot.optionTexts }).catch(() => null);
      const result = lookupResponse?.payload;
      if (!result) {
        await new Promise((resolve) => setTimeout(resolve, REMOTE_ACTION_RETRY_MS));
        continue;
      }
      if (result.status === 'unmatched' || result.status === 'ambiguous') {
        failRemote(result.status === 'ambiguous' ? 'answer-option-ambiguous' : 'question-unmatched');
        status.textContent = result.status === 'ambiguous' ? '正确答案多候选，未提交' : '未收录：不能一键答题';
        return;
      }
      if (!Number.isInteger(result.optionIndex) || result.optionIndex < 0 || result.optionIndex >= snapshot.optionNodes.length || !snapshot.optionNodes[result.optionIndex]) {
        failRemote('invalid-answer-index');
        status.textContent = '命中答案索引无效，未提交';
        return;
      }
      const currentQuestionResult = DailyQuestionPage.findQuestion();
      const currentQuestion = normalizeQuestion(currentQuestionResult.value);
      const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer());
      const currentOptionText = currentOptions.map(DailyQuestionPage.clean);
      const lookupAnswerText = cleanTextValue(result.answerText);
      const lookupOptionTexts = snapshot.optionTexts;
      if (currentQuestion !== snapshot.question || currentOptionText.join('\u0001') !== lookupOptionTexts.join('\u0001')) {
        failRemote('question-changed-or-unavailable');
        status.textContent = '题目或选项已变化，未提交';
        return;
      }
      const matching = currentOptions.filter((node) => DailyQuestionPage.clean(node) === lookupAnswerText);
      if (matching.length !== 1) {
        failRemote('answer-option-ambiguous');
        status.textContent = '正确选项未唯一匹配，未提交';
        return;
      }
      const target = matching[0];
      const actionKey = `${actionId || 'local'}:${snapshot.question}:${lookupAnswerText}`;
      if (actionKey === answerActionKey) { failRemote('duplicate-action'); status.textContent = '已一键答题，等待站点结果'; return; }
      const selected = DailyQuestionPage.findSelectedOption(document, currentOptions);
      if (selected !== target) {
        target.click();
      }
      const submitResult = await waitForQuestionSubmit(snapshot.question, lookupOptionTexts, lookupAnswerText);
      if (!submitResult.ok) {
        if (Date.now() - startedAt >= REMOTE_ACTION_TIMEOUT_MS) {
          failRemote(submitResult.reason);
          status.textContent = submitResult.reason === 'submit-timeout' ? '站点提交按钮未及时可用，未提交' : '题目或选项已变化，未提交';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, REMOTE_ACTION_RETRY_MS));
        continue;
      }
      const siteSubmit = DailyQuestionPage.findSubmit();
      if (!siteSubmit) { failRemote('submit-not-found'); status.textContent = '官网提交按钮已消失，未提交'; return; }
      clickVisibleQuestionSubmit(siteSubmit);
      answerActionKey = actionKey;
      status.textContent = '已触发官网提交，等待结果（如有验证码请完成）';
      await waitForRemoteResult('question', actionId, status);
      answerActionKey = null;
      answerActionId = null;
      return;
    }
    failRemote('question-not-ready');
    status.textContent = '题目或选项未稳定，未提交';
    return;
  } catch {
    answerActionKey = null;
    answerActionId = null;
    failRemote('action-failed');
    status.textContent = '一键答题未完成，请重试或按站点提示手动操作';
  }
};
const runCheckinAction = async ({ actionId = null } = {}) => {
  if (actionId) {
    pendingRemoteActions.add(actionId);
    activeRemoteActionId = actionId;
    checkinActionId = actionId;
  }
  const status = checkinStatusNode || { textContent: '' };
  const failRemote = actionId ? (reason) => finishRemoteAction(actionId, 'checkin', 'failed', reason) : () => {};
  try {
    const currentState = DailyCheckinPage.getState();
    if (currentState === 'requires-login') { pauseRemoteAction(actionId, 'checkin', 'requires-login'); status.textContent = '需登录：登录后会自动继续签到'; return; }
    if (currentState === 'completed') { finishRemoteAction(actionId, 'checkin', 'success', 'already-completed'); status.textContent = '已完成：今日已签到'; return; }
    const current = DailyCheckinPage.findDefault();
    if (!current) { failRemote('default-option-not-found'); status.textContent = '未找到“没心情”默认选项，未提交'; return; }
    const signature = CheckinState.nodeSignature(current);
    const key = `${actionId || 'local'}:${location.href}:${signature}`;
    if (checkinActionKey === key) { failRemote('duplicate-action'); status.textContent = '已一键签到，等待站点结果'; return; }
    current.click();
    // Selecting a mood can cause the site to re-render the submit button.
    // Always resolve the live site-owned button after the selection event.
    const submit = await waitForCheckinSubmit();
    if (!submit) { failRemote('submit-not-found'); status.textContent = '未找到站点签到按钮，未提交'; return; }
    const latestState = DailyCheckinPage.getState();
    const latestCurrent = DailyCheckinPage.findDefault();
    const latestSignature = CheckinState.nodeSignature(latestCurrent);
    if (latestState !== 'active' || !latestCurrent || latestSignature !== signature) {
      failRemote('checkin-changed-or-unavailable');
      status.textContent = '签到页面或默认选项已变化，未提交';
      return;
    }
    checkinActionKey = key;
    submit.click();
    status.textContent = '已触发官网提交，等待结果（如有验证码请完成）';
    await waitForRemoteResult('checkin', actionId, status);
    checkinActionKey = null;
    checkinActionId = null;
  } catch {
    checkinActionKey = null;
    checkinActionId = null;
    failRemote('action-failed');
    status.textContent = '一键签到未完成，请重试或按站点提示手动操作';
  }
};
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== ExtensionProtocol.MESSAGE_TYPES.RUN_ONE_CLICK) return false;
  const action = message.payload?.action;
  const actionId = message.payload?.actionId ?? message.payload?.workflowId ?? null;
  const workflowId = message.payload?.workflowId ?? null;
  const accept = (extra = {}) => {
    sendResponse({ ok: true, accepted: true, actionId, ...extra });
    return true;
  };
  const reject = (error) => {
    sendResponse({ ok: false, accepted: false, actionId, error });
    return true;
  };
  if (!['question', 'checkin'].includes(action)) return reject('invalid-action');
  if ((action === 'question' && !isQuestionPage()) || (action === 'checkin' && !isCheckinPage())) return reject('wrong-page');
  if (!actionId) return reject('not-ready');
  if (pendingRemoteActions.has(actionId)) return accept({ duplicate: true });
  if (remoteActionResults.has(actionId)) {
    const result = remoteActionResults.get(actionId);
    reportRemoteResult(actionId, result.action, result.status, result.reason).catch(() => {});
    return accept({ duplicate: true, ...result });
  }
  pendingRemoteActions.add(actionId);
  remoteActionTimers.delete(actionId);
  if (action === 'question') {
    runQuestionAction({ actionId, workflowId }).catch(() => {});
  } else {
    runCheckinAction({ actionId }).catch(() => {});
  }
  return accept();
});
let prepared = null;
// One automatic selection attempt is allowed per question lifecycle. This is
// deliberately keyed only by the question, not by an option DOM node: React
// may replace the option nodes after the click.
let autoSelectedKey = null;
let answerActionKey = null;
let answerActionId = null;
let renderGeneration = 0;
let questionLookupRetryKey = null;
let questionLookupRetryStartedAt = 0;
const normalizeQuestion = (value) => QuestionMatcher.normalize(value);
const clearAnswerMarks = (nodes = []) => nodes.forEach((node) => {
  node.classList?.remove('p3a-answer-correct', 'p3a-answer-incorrect');
  node.removeAttribute?.('data-p3a-answer-state');
});
const markAnswerOptions = (nodes, correctIndex) => nodes.forEach((node, index) => {
  node.classList?.remove('p3a-answer-correct', 'p3a-answer-incorrect');
  const correct = index === correctIndex;
  node.classList?.add(correct ? 'p3a-answer-correct' : 'p3a-answer-incorrect');
  node.setAttribute?.('data-p3a-answer-state', correct ? 'correct' : 'incorrect');
});
const render = async () => {
  if (!isQuestionPage()) return;
  const generation = ++renderGeneration;
  let bar = getQuestionToolbar();
  if (!bar) { bar = document.createElement('section'); bar.id = toolbarId; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '每日答题助手'); document.body.appendChild(bar); }
  const status = document.createElement('span'); status.className = 'p3a-status'; status.setAttribute('aria-live', 'polite');
  const questionResult = DailyQuestionPage.findQuestion(); const optionNodes = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const question = questionResult.value; const options = optionNodes.map(DailyQuestionPage.clean); bar.replaceChildren(status);
  const state = DailyQuestionPage.getState();
  if (state === 'requires-login') { prepared = null; autoSelectedKey = null; answerActionKey = null; answerActionId = null; clearAnswerMarks(optionNodes); status.textContent = '需登录：请先登录一亩三分地'; return; }
  if (state === 'completed') { prepared = null; autoSelectedKey = null; answerActionKey = null; answerActionId = null; clearAnswerMarks(optionNodes); status.textContent = '已完成：今日已答题'; return; }
  if (!question || !options.length) { prepared = null; autoSelectedKey = null; questionLookupRetryKey = null; questionLookupRetryStartedAt = 0; clearAnswerMarks(optionNodes); status.textContent = '加载中或暂未识别到题目'; return; }
  const questionKey = normalizeQuestion(question);
  if (prepared && prepared.questionKey !== questionKey) prepared = null;
  if (answerActionKey && !answerActionKey.includes(`:${questionKey}:`)) { answerActionKey = null; answerActionId = null; }
  if (autoSelectedKey && autoSelectedKey !== questionKey) autoSelectedKey = null;
  if (questionLookupRetryKey !== questionKey) {
    questionLookupRetryKey = questionKey;
    questionLookupRetryStartedAt = Date.now();
  }
  const elapsedBeforeLookup = Date.now() - questionLookupRetryStartedAt;
  const lookupBudgetMs = Math.max(0, QUESTION_READY_TIMEOUT_MS - elapsedBeforeLookup);
  const result = lookupBudgetMs > 0
    ? await lookupQuestionForRender(question, options, Math.min(QUESTION_LOOKUP_RESPONSE_TIMEOUT_MS, lookupBudgetMs))
    : null;
  if (generation !== renderGeneration) return;
  if (!result) {
    const remainingMs = QUESTION_READY_TIMEOUT_MS - (Date.now() - questionLookupRetryStartedAt);
    if (remainingMs > 0) {
      status.textContent = '正在读取本地答案…';
      setTimeout(() => { if (isQuestionPage()) schedule(); }, Math.min(QUESTION_LOOKUP_RETRY_DELAY_MS, remainingMs));
    } else {
      status.textContent = '本地答案读取超时，请稍后重试';
    }
    return;
  }
  questionLookupRetryKey = null;
  questionLookupRetryStartedAt = 0;
  if (!result || result.status === 'unmatched' || result.status === 'ambiguous') {
    prepared = null; autoSelectedKey = null; answerActionKey = null; answerActionId = null; clearAnswerMarks(optionNodes); status.textContent = result?.status === 'ambiguous' ? '多候选：请手动选择并保存，不能一键答题' : '未收录：请手动选择并保存，不能一键答题';
    const remember = document.createElement('button'); remember.type = 'button'; remember.textContent = '记住当前答案'; remember.className = 'p3a-action';
    remember.addEventListener('click', async () => { const currentQuestionResult = DailyQuestionPage.findQuestion(); const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const selected = DailyQuestionPage.findSelectedOption(document, currentOptions); const currentQuestion = currentQuestionResult.value; if (!currentQuestion || currentQuestion !== question || currentOptions.length !== optionNodes.length || currentOptions.some((node, index) => node !== optionNodes[index]) || !selected || currentOptions.filter((node) => node === selected).length !== 1) { status.textContent = '题目或选项已变化，或没有唯一选中项，未保存'; return; } const response = await bridge.send(ExtensionProtocol.MESSAGE_TYPES.SAVE_LEARNED_ANSWER, { question: currentQuestion, answer: DailyQuestionPage.clean(selected) }).catch(() => null); status.textContent = response?.ok ? '已记住当前答案' : '保存失败，请稍后重试'; });
    bar.append(remember); return;
  }
  if (!Number.isInteger(result.optionIndex) || result.optionIndex < 0 || result.optionIndex >= optionNodes.length || !optionNodes[result.optionIndex]) { prepared = null; answerActionKey = null; answerActionId = null; clearAnswerMarks(optionNodes); status.textContent = '命中答案索引无效，不能一键答题'; return; }
  markAnswerOptions(optionNodes, result.optionIndex);
  status.textContent = result.matchType === 'fuzzy' ? `已基于相似题目自动匹配：${result.answerText}` : `已命中：${result.answerText}`;
  const select = document.createElement('button'); select.type = 'button'; select.textContent = '选中答案'; select.className = 'p3a-action';
  const remember = document.createElement('button'); remember.type = 'button'; remember.textContent = '记住当前答案'; remember.className = 'p3a-action';
  const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = '确认并提交'; submit.className = 'p3a-action'; submit.disabled = true;
  const oneClick = document.createElement('button'); oneClick.type = 'button'; oneClick.textContent = '一键答题'; oneClick.className = 'p3a-action';
  questionStatusNode = status;
  const target = optionNodes[result.optionIndex];
  const lookupOptionTexts = options;
  const lookupAnswerText = cleanTextValue(result.answerText);
  const selected = DailyQuestionPage.findSelectedOption(document, optionNodes);
  if (selected === target && (prepared?.questionKey === questionKey || autoSelectedKey === questionKey)) {
    // React may have replaced the option node after selection. Rebind the
    // prepared state to the live node so the extension submit guard remains valid.
    prepared = { questionKey, optionIndex: result.optionIndex, node: target, answer: lookupAnswerText, optionTexts: lookupOptionTexts };
    submit.disabled = false;
  }
  if (autoSelectedKey !== questionKey && selected !== target && typeof target.click === 'function') {
    autoSelectedKey = questionKey;
    try {
      target.click();
      prepared = { questionKey, optionIndex: result.optionIndex, node: target, answer: lookupAnswerText, optionTexts: lookupOptionTexts };
      submit.disabled = false;
      status.textContent = result.matchType === 'fuzzy' ? `已基于相似题目自动选中：${result.answerText}，请检查后提交` : `已自动选中：${result.answerText}，请检查后提交`;
    } catch {
      status.textContent = result.matchType === 'fuzzy' ? `已基于相似题目自动匹配：${result.answerText}，请手动选择` : `已命中：${result.answerText}，请手动选择`;
    }
  }
  select.addEventListener('click', () => { const node = optionNodes[result.optionIndex]; if (!node || typeof node.click !== 'function') return; try { node.click(); } catch { return; } prepared = { questionKey, optionIndex: result.optionIndex, node, answer: lookupAnswerText, optionTexts: lookupOptionTexts }; status.textContent = '已选中，请检查验证码后提交'; submit.disabled = false; });
  submit.addEventListener('click', () => { const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const currentQuestion = normalizeQuestion(DailyQuestionPage.findQuestion().value); const node = prepared && currentOptions[prepared.optionIndex]; const selected = DailyQuestionPage.findSelectedOption(document, currentOptions); if (!prepared || prepared.questionKey !== currentQuestion || !node || node !== prepared.node || selected !== node) { submit.disabled = true; status.textContent = '题目或选项已变化，或官网未确认选中，未提交'; return; } const button = DailyQuestionPage.findSubmit(); if (button && !button.disabled) { try { clickVisibleQuestionSubmit(button); status.textContent = '已触发官网提交，等待结果'; } catch { status.textContent = '官网提交按钮已变化，未提交，请重试'; } } else status.textContent = '未找到已启用的官网提交按钮，未提交'; });
  oneClick.addEventListener('click', () => { runQuestionAction().catch(() => {}); });
  remember.addEventListener('click', async () => { const currentQuestionResult = DailyQuestionPage.findQuestion(); const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const selected = DailyQuestionPage.findSelectedOption(document, currentOptions); const currentQuestion = currentQuestionResult.value; if (!currentQuestion || currentQuestion !== question || currentOptions.length !== optionNodes.length || currentOptions.some((node, index) => node !== optionNodes[index]) || !selected || currentOptions.filter((node) => node === selected).length !== 1) { status.textContent = '题目或选项已变化，或没有唯一选中项，未保存'; return; } const response = await bridge.send(ExtensionProtocol.MESSAGE_TYPES.SAVE_LEARNED_ANSWER, { question: currentQuestion, answer: DailyQuestionPage.clean(selected) }).catch(() => null); status.textContent = response?.ok ? '已记住当前答案' : '保存失败，请稍后重试'; }); bar.append(oneClick, select, remember, submit);
};
let checkinPrepared = null;
let checkinAutoAttempt = null;
let checkinActionKey = null;
let checkinActionId = null;
let checkinGeneration = 0;
const isCheckinPage = () => DailyCheckinPage.isCheckinPage(location.href);
const renderCheckin = () => {
  if (!isCheckinPage()) return;
  const generation = ++checkinGeneration;
  let bar = document.getElementById(checkinToolbarId);
  if (!bar) { bar = document.createElement('section'); bar.id = checkinToolbarId; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '每日签到助手'); document.body.appendChild(bar); }
  const status = document.createElement('span'); status.className = 'p3a-status'; status.setAttribute('aria-live', 'polite');
  checkinStatusNode = status;
  bar.replaceChildren(status);
  const state = DailyCheckinPage.getState();
  if (state === 'requires-login') { checkinPrepared = null; checkinAutoAttempt = null; checkinActionKey = null; status.textContent = '需登录：请先登录一亩三分地'; return; }
  if (state === 'completed') { checkinPrepared = null; checkinAutoAttempt = null; checkinActionKey = null; status.textContent = '今日已签到，不能重复签到'; return; }
  const prepare = document.createElement('button'); prepare.type = 'button'; prepare.className = 'p3a-action'; prepare.textContent = '准备签到';
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'p3a-action'; confirm.textContent = '确认并签到'; confirm.disabled = true;
  const oneClick = document.createElement('button'); oneClick.type = 'button'; oneClick.className = 'p3a-action'; oneClick.textContent = '一键签到';
  const defaultNode = DailyCheckinPage.findDefault();
  checkinPrepared = CheckinState.reconcile(checkinPrepared, location.href, defaultNode);
  if (!defaultNode) { checkinPrepared = null; checkinActionKey = null; status.textContent = '未识别“没心情”默认选项，未提交'; prepare.disabled = true; oneClick.disabled = true; bar.append(oneClick, prepare); return; }
  const defaultSignature = CheckinState.nodeSignature(defaultNode);
  const autoKey = `${location.href}|${defaultSignature}`;
  if (checkinAutoAttempt && checkinAutoAttempt !== autoKey) checkinAutoAttempt = null;
  if (!checkinAutoAttempt) {
    checkinAutoAttempt = autoKey;
    try {
      defaultNode.click();
      checkinPrepared = CheckinState.prepare(defaultNode, location.href);
      confirm.disabled = false;
      status.textContent = '已自动选择：没心情，请检查后确认签到';
    } catch {
      checkinAutoAttempt = null;
      status.textContent = '无法自动选择没心情，请手动选择';
    }
  } else if (checkinPrepared) {
    status.textContent = '已自动选择：没心情，请检查后确认签到';
  } else {
    status.textContent = '可准备默认签到';
  }
  if (checkinPrepared) confirm.disabled = false;
  prepare.addEventListener('click', () => {
    const current = DailyCheckinPage.findDefault();
    if (!current || current !== defaultNode || generation !== checkinGeneration) { status.textContent = '签到控件已变化，请重新加载页面'; return; }
    try { current.click(); } catch { status.textContent = '无法选择默认签到选项，请手动选择'; return; }
    checkinPrepared = CheckinState.prepare(current, location.href);
    confirm.disabled = false; status.textContent = '已准备，请检查后确认签到';
  });
  confirm.addEventListener('click', async () => {
    const remoteActionId = activeRemoteActionId;
    activeRemoteActionId = null;
    const current = DailyCheckinPage.findDefault();
    const submit = await waitForCheckinSubmit();
    const reconciled = CheckinState.reconcile(checkinPrepared, location.href, current);
    if (!reconciled || !submit) { checkinPrepared = null; confirm.disabled = true; status.textContent = '签到页面或控件已变化，请重新准备'; return; }
    checkinPrepared = reconciled;
    try {
      submit.click(); checkinPrepared = null; status.textContent = '已提交，请完成验证码（如有）';
      await waitForRemoteResult('checkin', remoteActionId, status);
    } catch { status.textContent = '未能点击站点签到按钮，请手动提交'; }
  });
  oneClick.addEventListener('click', async () => {
    const remoteActionId = activeRemoteActionId;
    activeRemoteActionId = null;
    const failRemote = (reason) => finishRemoteAction(remoteActionId, 'checkin', 'failed', reason);
    const currentState = DailyCheckinPage.getState();
    const current = DailyCheckinPage.findDefault();
    const signature = CheckinState.nodeSignature(current);
    const key = `${location.href}|${signature}`;
    if (currentState === 'requires-login') { failRemote('requires-login'); status.textContent = '需登录：不能一键签到'; return; }
    if (currentState === 'completed') { finishRemoteAction(remoteActionId, 'checkin', 'success', 'already-completed'); status.textContent = '今日已签到'; return; }
    if (!current) { failRemote('default-option-not-found'); status.textContent = '未找到“没心情”默认选项，未提交'; return; }
    if (key === checkinActionKey) { failRemote('duplicate-action'); status.textContent = '一键签到已执行，等待站点结果'; return; }
    try {
      if (!CheckinState.reconcile(checkinPrepared, location.href, current)) { current.click(); checkinPrepared = CheckinState.prepare(current, location.href); }
      const submit = await waitForCheckinSubmit();
      if (!submit) { failRemote('submit-not-found'); status.textContent = '未找到站点签到按钮，未提交'; return; }
      const latestState = DailyCheckinPage.getState();
      const latestCurrent = DailyCheckinPage.findDefault();
      const latestSignature = CheckinState.nodeSignature(latestCurrent);
      if (latestState !== 'active' || !latestCurrent || latestSignature !== signature) {
        failRemote('checkin-changed-or-unavailable');
        status.textContent = '签到页面或默认选项已变化，未提交';
        return;
      }
      submit.click(); checkinActionKey = key; checkinPrepared = null; status.textContent = '已提交，等待签到结果（如有验证码请完成）';
      await waitForRemoteResult('checkin', remoteActionId, status);
    } catch { checkinActionKey = null; failRemote('action-failed'); status.textContent = '一键签到未完成，请重试或按站点提示手动操作'; }
  });
  bar.append(oneClick, prepare, confirm);
};
let timer; let checkinTimer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { render().catch(() => {}); }, 180); };
const scheduleCheckin = () => { clearTimeout(checkinTimer); checkinTimer = setTimeout(renderCheckin, 180); };
const retryInitialQuestionRender = () => {
  const startedAt = Date.now();
  const retry = () => {
    if (!isQuestionPage() || Date.now() - startedAt > QUESTION_READY_TIMEOUT_MS) return;
    const state = DailyQuestionPage.getState();
    const toolbar = getQuestionToolbar();
    const hasAction = Boolean(toolbar?.querySelector?.('button'));
    const waitingForQuestionDom = !toolbar || toolbar.textContent === '加载中或暂未识别到题目';
    if (state === 'active' && !hasAction && waitingForQuestionDom) {
      reportContentReady(true);
      schedule();
      setTimeout(retry, 300);
    }
  };
  setTimeout(retry, 300);
};
if (isQuestionPage() || isCheckinPage()) {
  reportContentReady(true);
  flushPendingRemoteResults().catch(() => {});
  new MutationObserver((records) => {
    const relevant = records.some((record) => !record.target.closest?.(`#${toolbarId}, #${checkinToolbarId}, #${checkinToastId}`));
    if (!relevant) return;
    reportContentReady();
    if (isQuestionPage()) schedule();
    if (isCheckinPage()) scheduleCheckin();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  if (isQuestionPage()) { schedule(); retryInitialQuestionRender(); }
  if (isCheckinPage()) scheduleCheckin();
}
globalThis.Section1Bridge = bridge;
importScripts('shared/protocol.js');
importScripts('shared/question-matcher.js');
importScripts('shared/learned-answers.js');

const RUNTIME_STORAGE_KEY = 'p3a-runtime-v1';
const RUNTIME_FINALIZE_ALARM_PREFIX = 'p3a-runtime-finalize:';
const DELIVERY_RETRY_LIMIT = 4;
const DELIVERY_RETRY_DELAY_MS = 250;
const AUTO_RECOVERY_RETRY_LIMIT = 2;
const AUTO_RECOVERY_RETRY_DELAY_MS = 2 * 60 * 1000;

const getLosAngelesDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};
const ACTION_ICON_PATHS = Object.freeze({
  disabled: Object.freeze({
    16: 'assets/1point3acres-helper-icon-16.png',
    32: 'assets/1point3acres-helper-icon-32.png',
    48: 'assets/1point3acres-helper-icon-48.png',
    128: 'assets/1point3acres-helper-icon-128.png',
  }),
  enabled: Object.freeze({
    16: 'assets/1point3acres-helper-icon-enabled-16.png',
    32: 'assets/1point3acres-helper-icon-enabled-32.png',
    48: 'assets/1point3acres-helper-icon-enabled-48.png',
    128: 'assets/1point3acres-helper-icon-enabled-128.png',
  }),
});
const resolveActionIconPaths = (iconPaths) => {
  const runtimeGetURL = typeof chrome.runtime?.getURL === 'function' ? chrome.runtime.getURL.bind(chrome.runtime) : null;
  if (!runtimeGetURL) return iconPaths;
  return Object.fromEntries(Object.entries(iconPaths).map(([size, path]) => [size, runtimeGetURL(path)]));
};
// Compatibility markers kept for source-based tests:
// const deliveringActions = new Set()
// deliverAction(sender.tab?.id)
// chrome.tabs.remove(tabId)

let bankPromise;
let runtimePromise;
let runtimeState = null;
let autoPromise;
let autoState = null;
let startEverythingPromise = null;
let startAutoEverythingPromise = null;
const loginBlockedRefreshByTabId = new Map();
const runtimeStorage = chrome.storage.session || chrome.storage.local;
const autoStorage = chrome.storage.local;
let coordinatorTail = Promise.resolve();
const coordinatorQueue = (task) => {
  const next = coordinatorTail.then(task, task);
  coordinatorTail = next.catch(() => {});
  return next;
};

const actionPage = (action) => action === 'question' ? ExtensionProtocol.PAGE_URLS.dailyQuestion : ExtensionProtocol.PAGE_URLS.dailyCheckin;
const normalizeCoordinatorAction = (action) => action === 'everything' ? 'checkin' : action;
const isCoordinatorAction = (action) => ['checkin', 'question'].includes(action);
const isTargetUrl = (url, page) => typeof url === 'string' && (url === page || url.startsWith(`${page}?`) || url.startsWith(`${page}#`));
const isDailyTaskUrl = (url) => isTargetUrl(url, ExtensionProtocol.PAGE_URLS.dailyQuestion) || isTargetUrl(url, ExtensionProtocol.PAGE_URLS.dailyCheckin);
const getExtensionOwnedTaskTabIds = () => {
  const ids = new Set();
  const records = runtimeState?.actionsByTabId && typeof runtimeState.actionsByTabId === 'object'
    ? Object.values(runtimeState.actionsByTabId)
    : [];
  for (const record of records) {
    if (!record || record.createdByExtension !== true) continue;
    if (!['checkin', 'question'].includes(record.action)) continue;
    if (!Number.isInteger(record.tabId)) continue;
    ids.add(record.tabId);
  }
  return ids;
};
const isEligibleOriginTab = (tab, excludedTaskTabIds) => {
  if (!Number.isInteger(tab?.id) || tab.active !== true) return false;
  if (excludedTaskTabIds.has(tab.id)) return false;
  if (isDailyTaskUrl(tab.url)) return false;
  return true;
};
const findOriginActiveTab = async () => {
  if (typeof chrome.tabs?.query !== 'function') return null;
  const excludedTaskTabIds = getExtensionOwnedTaskTabIds();
  const candidates = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true },
  ];
  for (const queryInfo of candidates) {
    const tabs = await chrome.tabs.query(queryInfo).catch(() => []);
    const match = Array.isArray(tabs)
      ? tabs.find((tab) => isEligibleOriginTab(tab, excludedTaskTabIds))
      : null;
    if (match) return match;
  }
  return null;
};

const captureOriginActiveTabId = async (fallbackTabId = null) => {
  await loadRuntimeState();
  if (Number.isInteger(runtimeState?.run?.originActiveTabId)) return runtimeState.run.originActiveTabId;
  const originActiveTab = await findOriginActiveTab();
  if (Number.isInteger(originActiveTab?.id)) return originActiveTab.id;
  return Number.isInteger(fallbackTabId) ? fallbackTabId : null;
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const showCoordinatorNotification = async (message) => {
  if (!message || !chrome.notifications?.create) return null;
  return chrome.notifications.create({
    type: 'basic',
    iconUrl: resolveActionIconPaths(ACTION_ICON_PATHS.enabled)[128],
    title: '一亩三分地助手',
    message,
  }).catch(() => null);
};
const AUTO_NON_RETRYABLE_REASONS = new Set([
  'requires-login',
  'captcha-required',
  'captcha-error',
  'question-unmatched',
  'answer-option-ambiguous',
  'default-option-not-found',
  'duplicate-action',
  'invalid-answer-index',
]);
const AUTO_RECOVERABLE_REASONS = new Set([
  'failed',
  'site-failed',
  'timeout',
  'submit-not-found',
  'question-not-ready',
  'action-failed',
  'start-failed',
  'question-changed-or-unavailable',
]);

const DAILY_STATUS_STORAGE_KEY = 'p3a-daily-status-v1';

const getInitialDailyStatus = (dateKey = getLosAngelesDateKey()) => ({
  dateKey,
  checkin: { completed: false, at: null },
  question: { completed: false, at: null },
});

const normalizeDailyStatus = (daily, todayKey = getLosAngelesDateKey()) => {
  if (!daily || typeof daily !== 'object' || daily.dateKey !== todayKey) {
    return getInitialDailyStatus(todayKey);
  }
  return {
    dateKey: todayKey,
    checkin: {
      completed: daily.checkin?.completed === true,
      at: Number.isFinite(daily.checkin?.at) ? daily.checkin.at : null,
    },
    question: {
      completed: daily.question?.completed === true,
      at: Number.isFinite(daily.question?.at) ? daily.question.at : null,
    },
  };
};

const defaultRuntimeState = (dateKey = getLosAngelesDateKey()) => ({
  version: 2,
  run: {
    runId: null,
    laDateKey: null,
    source: null,
    stage: null,
    status: 'idle',
    transition: null,
    lease: null,
    attempt: 0,
    currentTabId: null,
    originActiveTabId: null,
    currentActionId: null,
    lastError: null,
    events: [],
  },
  diagnostics: {
    legacy: { actionsByTabId: {}, workflowsById: {}, activeWorkflowId: null },
  },
  dailyStatus: getInitialDailyStatus(dateKey),
  actionsByTabId: {},
  awaitingContentByTabId: {},
  pendingActionsById: {},
  workflowsById: {},
  activeWorkflowId: null,
});

const normalizeActionRecord = (record) => {
  if (!record || typeof record !== 'object') return null;
  if (!['question', 'checkin'].includes(record.action)) return null;
  if (typeof record.actionId !== 'string' || !record.actionId) return null;
  const hasCreatedByExtension = Object.prototype.hasOwnProperty.call(record, 'createdByExtension');
  const hasReusedExistingTab = Object.prototype.hasOwnProperty.call(record, 'reusedExistingTab');
  const next = {
    action: record.action,
    actionId: record.actionId,
    workflowId: typeof record.workflowId === 'string' && record.workflowId ? record.workflowId : null,
    tabId: Number.isInteger(record.tabId) ? record.tabId : null,
    originActiveTabId: Number.isInteger(record.originActiveTabId) ? record.originActiveTabId : null,
    status: record.status === 'completed' ? 'completed' : 'pending',
    deliveredAt: Number.isFinite(record.deliveredAt) ? record.deliveredAt : null,
    deliveredCount: Number.isInteger(record.deliveredCount) ? record.deliveredCount : 0,
    lastDeliveryAttemptAt: Number.isFinite(record.lastDeliveryAttemptAt) ? record.lastDeliveryAttemptAt : null,
    lastDeliveryError: typeof record.lastDeliveryError === 'string' ? record.lastDeliveryError : null,
    lastResult: record.lastResult && typeof record.lastResult === 'object' ? clone(record.lastResult) : null,
    createdByExtension: hasCreatedByExtension ? record.createdByExtension === true : null,
    reusedExistingTab: hasReusedExistingTab ? record.reusedExistingTab === true : null,
    finalizationPending: record.finalizationPending === true,
    closeStatus: typeof record.closeStatus === 'string' ? record.closeStatus : null,
    closeSkippedReason: typeof record.closeSkippedReason === 'string' ? record.closeSkippedReason : null,
    closeSkippedDetail: typeof record.closeSkippedDetail === 'string' ? record.closeSkippedDetail : null,
    finalizationError: typeof record.finalizationError === 'string' ? record.finalizationError : null,
    finalizationAttemptAt: Number.isFinite(record.finalizationAttemptAt) ? record.finalizationAttemptAt : null,
    finalizationCompletedAt: Number.isFinite(record.finalizationCompletedAt) ? record.finalizationCompletedAt : null,
  };
  return next;
};

const normalizeWorkflow = (workflow) => {
  if (!workflow || typeof workflow !== 'object') return null;
  if (workflow.action !== 'everything') return null;
  if (!['checkin', 'question', 'done'].includes(workflow.stage)) return null;
  return {
    action: 'everything',
    stage: workflow.stage,
    createdAt: Number.isFinite(workflow.createdAt) ? workflow.createdAt : Date.now(),
    updatedAt: Number.isFinite(workflow.updatedAt) ? workflow.updatedAt : Date.now(),
    tabIds: Array.isArray(workflow.tabIds) ? workflow.tabIds.filter((id) => Number.isInteger(id)) : [],
    checkinActionId: typeof workflow.checkinActionId === 'string' ? workflow.checkinActionId : null,
    questionActionId: typeof workflow.questionActionId === 'string' ? workflow.questionActionId : null,
    closeStatus: typeof workflow.closeStatus === 'string' ? workflow.closeStatus : null,
    closeSkippedReason: typeof workflow.closeSkippedReason === 'string' ? workflow.closeSkippedReason : null,
    finalizationError: typeof workflow.finalizationError === 'string' ? workflow.finalizationError : null,
  };
};

const normalizeRuntimeState = (state) => {
  const todayKey = getLosAngelesDateKey();
  const next = defaultRuntimeState(todayKey);
  if (!state || typeof state !== 'object') return next;
  next.dailyStatus = normalizeDailyStatus(state.dailyStatus, todayKey);
  if (state.run && typeof state.run === 'object') {
    const run = state.run;
    next.run = {
      ...next.run,
      runId: typeof run.runId === 'string' ? run.runId : null,
      laDateKey: typeof run.laDateKey === 'string' ? run.laDateKey : null,
      source: run.source === 'auto' ? 'auto' : run.source === 'manual' ? 'manual' : null,
      stage: run.stage === 'question' ? 'question' : run.stage === 'checkin' ? 'checkin' : null,
      status: typeof run.status === 'string' ? run.status : 'idle',
      transition: typeof run.transition === 'string' ? run.transition : null,
      lease: run.lease && typeof run.lease === 'object' ? clone(run.lease) : null,
      attempt: Number.isInteger(run.attempt) ? run.attempt : 0,
      currentTabId: Number.isInteger(run.currentTabId) ? run.currentTabId : null,
      originActiveTabId: Number.isInteger(run.originActiveTabId) ? run.originActiveTabId : null,
      currentActionId: typeof run.currentActionId === 'string' ? run.currentActionId : null,
      lastError: typeof run.lastError === 'string' ? run.lastError : null,
      events: Array.isArray(run.events) ? run.events.slice(-30).filter((e) => e && typeof e === 'object') : [],
    };
  }
  const actions = state.actionsByTabId && typeof state.actionsByTabId === 'object' ? state.actionsByTabId : {};
  for (const [key, value] of Object.entries(actions)) {
    const tabId = Number(key);
    const record = normalizeActionRecord(value);
    if (Number.isInteger(tabId) && record) next.actionsByTabId[String(tabId)] = { ...record, tabId };
  }
  const awaiting = state.awaitingContentByTabId && typeof state.awaitingContentByTabId === 'object' ? state.awaitingContentByTabId : {};
  for (const [key, value] of Object.entries(awaiting)) {
    const tabId = Number(key);
    const record = normalizeActionRecord(value);
    if (Number.isInteger(tabId) && record) next.awaitingContentByTabId[String(tabId)] = { ...record, tabId };
  }
  const pending = state.pendingActionsById && typeof state.pendingActionsById === 'object' ? state.pendingActionsById : {};
  for (const [key, value] of Object.entries(pending)) {
    const actionId = typeof key === 'string' ? key : null;
    const record = normalizeActionRecord(value);
    if (actionId && record) next.pendingActionsById[actionId] = { ...record };
  }
  const workflows = state.workflowsById && typeof state.workflowsById === 'object' ? state.workflowsById : {};
  for (const [key, value] of Object.entries(workflows)) {
    const workflowId = typeof key === 'string' ? key : null;
    const record = normalizeWorkflow(value);
    if (workflowId && record) next.workflowsById[workflowId] = record;
  }
  next.activeWorkflowId = typeof state.activeWorkflowId === 'string' && next.workflowsById[state.activeWorkflowId] ? state.activeWorkflowId : null;
  next.diagnostics.legacy = {
    actionsByTabId: next.actionsByTabId,
    workflowsById: next.workflowsById,
    activeWorkflowId: next.activeWorkflowId,
  };
  if (!next.run.runId && next.activeWorkflowId) {
    // Historical workflow records are diagnostics only.  Do not synthesize a
    // coordinator run from legacy workflow state, otherwise startup recovery
    // can reopen tabs from stale data.
    next.diagnostics.legacy = {
      ...next.diagnostics.legacy,
      activeWorkflowId: next.activeWorkflowId,
    };
  }
  return next;
};

const markDailyTaskCompleted = async (action, dateKey = getLosAngelesDateKey(), nowMs = Date.now()) => {
  await loadRuntimeState();
  if (!runtimeState.dailyStatus || runtimeState.dailyStatus.dateKey !== dateKey) {
    runtimeState.dailyStatus = getInitialDailyStatus(dateKey);
  }
  if (action === 'checkin') {
    runtimeState.dailyStatus.checkin = { completed: true, at: nowMs };
  } else if (action === 'question') {
    runtimeState.dailyStatus.question = { completed: true, at: nowMs };
  }
  await saveRuntimeState();
  await chrome.storage.local.set({ [DAILY_STATUS_STORAGE_KEY]: runtimeState.dailyStatus }).catch(() => {});
};

const loadRuntimeState = async () => {
  if (runtimeState) {
    const todayKey = getLosAngelesDateKey();
    if (!runtimeState.dailyStatus || runtimeState.dailyStatus.dateKey !== todayKey) {
      const storedLocal = await chrome.storage.local.get(DAILY_STATUS_STORAGE_KEY).catch(() => ({}));
      runtimeState.dailyStatus = normalizeDailyStatus(storedLocal?.[DAILY_STATUS_STORAGE_KEY], todayKey);
    }
    return runtimeState;
  }
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const stored = await runtimeStorage.get(RUNTIME_STORAGE_KEY).catch(() => ({}));
      runtimeState = normalizeRuntimeState(stored[RUNTIME_STORAGE_KEY]);
      const todayKey = getLosAngelesDateKey();
      if (!runtimeState.dailyStatus?.checkin?.completed || !runtimeState.dailyStatus?.question?.completed) {
        const storedLocal = await chrome.storage.local.get(DAILY_STATUS_STORAGE_KEY).catch(() => ({}));
        const localDaily = normalizeDailyStatus(storedLocal?.[DAILY_STATUS_STORAGE_KEY], todayKey);
        runtimeState.dailyStatus = {
          dateKey: todayKey,
          checkin: {
            completed: runtimeState.dailyStatus.checkin?.completed || localDaily.checkin?.completed || false,
            at: runtimeState.dailyStatus.checkin?.at || localDaily.checkin?.at || null,
          },
          question: {
            completed: runtimeState.dailyStatus.question?.completed || localDaily.question?.completed || false,
            at: runtimeState.dailyStatus.question?.at || localDaily.question?.at || null,
          },
        };
      }
      return runtimeState;
    })();
  }
  return runtimePromise;
};

const saveRuntimeState = async () => {
  await loadRuntimeState();
  await runtimeStorage.set({ [RUNTIME_STORAGE_KEY]: runtimeState });
};

const getRunState = () => runtimeState?.run || defaultRuntimeState().run;
const pushRunEvent = async (type, detail = {}) => {
  await loadRuntimeState();
  const run = runtimeState.run || defaultRuntimeState().run;
  const event = { at: Date.now(), type, ...detail };
  run.events = [...(Array.isArray(run.events) ? run.events : []), event].slice(-30);
  runtimeState.run = run;
  await saveRuntimeState();
  return event;
};
const setRunError = async (error, type = 'error') => {
  await loadRuntimeState();
  runtimeState.run.lastError = typeof error === 'string' ? error : error?.message || String(error) || 'unknown-error';
  runtimeState.run.transition = type;
  await pushRunEvent(type, { error: runtimeState.run.lastError });
};
const clearLegacyTaskState = async () => {
  await loadRuntimeState();
  const currentRun = runtimeState.run ? { ...runtimeState.run } : null;
  const currentDaily = runtimeState.dailyStatus ? { ...runtimeState.dailyStatus } : null;
  runtimeState.actionsByTabId = {};
  runtimeState.awaitingContentByTabId = {};
  runtimeState.pendingActionsById = {};
  runtimeState.workflowsById = {};
  runtimeState.activeWorkflowId = null;
  if (currentDaily) {
    runtimeState.dailyStatus = currentDaily;
  }
  if (currentRun?.runId) {
    runtimeState.run = { ...defaultRuntimeState().run, ...currentRun };
  }
};
const cleanupNonActiveDailyTabs = async (activeTabId = null) => {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const keepTabIds = new Set([
    Number.isInteger(activeTabId) ? activeTabId : null,
  ].filter(Number.isInteger));
  const candidates = Array.isArray(tabs)
    ? tabs.filter((tab) => Number.isInteger(tab?.id)
      && !keepTabIds.has(tab.id)
      && isDailyTaskUrl(tab.url)
      && tab.active !== true)
    : [];
  for (const tab of candidates) {
    await chrome.tabs.remove(tab.id).catch((error) => pushRunEvent('cleanup-tab-failed', { tabId: tab.id, error: error?.message || String(error) }));
  }
};
const cleanupAllButCurrentDailyTab = async () => {
  await loadRuntimeState();
  const activeTabId = Number.isInteger(runtimeState?.run?.currentTabId) ? runtimeState.run.currentTabId : null;
  await cleanupNonActiveDailyTabs(activeTabId);
  return activeTabId;
};
const pickRecoveryTaskTab = async () => {
  const questionTab = await findReusableTaskTab(actionPage('question'));
  if (questionTab?.id != null) return { tab: questionTab, stage: 'question' };
  const checkinTab = await findReusableTaskTab(actionPage('checkin'));
  if (checkinTab?.id != null) return { tab: checkinTab, stage: 'checkin' };
  return { tab: null, stage: 'checkin' };
};
const recoverAutoCurrentRun = async ({ now = new Date(), originActiveTabId = null } = {}) => {
  await loadAutoState();
  await loadRuntimeState();
  const todayKey = getLosAngelesDateKey(now);
  const autoRun = runtimeState?.run || defaultRuntimeState().run;
  if (!autoState?.enabled) return { ok: false, reason: 'auto-disabled' };
  if (autoState.activeRunDateKey !== todayKey) return { ok: false, reason: 'not-today' };
  if (autoRun.runId) return { ok: false, reason: 'run-exists' };
  if (['login-blocked', 'completed', 'disabled', 'skipped-stale', 'skipped-legacy-history'].includes(autoState.lastRunStatus)) {
    return { ok: false, reason: 'terminal' };
  }
  if (autoState.lastRunStatus !== 'started') return { ok: false, reason: 'not-started' };
  const { tab: reusable, stage } = await pickRecoveryTaskTab();
  await cleanupNonActiveDailyTabs(reusable?.id ?? null);
  const actionId = crypto.randomUUID();
  runtimeState.run = {
    ...autoRun,
    runId: crypto.randomUUID(),
    laDateKey: todayKey,
    source: 'auto',
    stage,
    status: 'running',
    transition: 'recovered-auto-startup',
    lease: { owner: 'startup-recovery', acquiredAt: now.getTime() },
    attempt: 1,
    currentTabId: null,
    originActiveTabId: Number.isInteger(originActiveTabId) ? originActiveTabId : autoRun.originActiveTabId ?? null,
    currentActionId: actionId,
    lastError: null,
    events: Array.isArray(autoRun.events) ? autoRun.events : [],
  };
  await saveRuntimeState();
  if (reusable?.id != null) {
    runtimeState.run.currentTabId = reusable.id;
    await createCoordinatorActionRecord({
      tabId: reusable.id,
      action: stage,
      actionId,
      createdByExtension: false,
      reusedExistingTab: true,
      originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId,
    });
    await saveRuntimeState();
    await retryDeliverIfNeeded(reusable.id, { force: true }).catch((error) => setRunError(error, 'auto-recover-deliver-failed'));
    return { ok: true, tab: reusable, run: runtimeState.run, reused: true };
  }
  const page = actionPage('checkin');
  const tab = await chrome.tabs.create({ url: page, active: false });
  runtimeState.run.currentTabId = tab.id;
  await saveRuntimeState();
  await createCoordinatorActionRecord({
    tabId: tab.id,
    action: 'checkin',
    actionId,
    createdByExtension: true,
    reusedExistingTab: false,
    originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId,
  });
  return { ok: true, tab, run: runtimeState.run, reused: false };
};
const findExistingTaskTab = async (page) => {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  return Array.isArray(tabs) ? tabs.find((tab) => isTargetUrl(tab.url, page)) || null : null;
};
const findReusableTaskTab = async (page) => {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  if (!Array.isArray(tabs)) return null;
  return tabs.find((tab) => Number.isInteger(tab?.id) && isTargetUrl(tab.url, page) && tab.active === true)
    || tabs.find((tab) => Number.isInteger(tab?.id) && isTargetUrl(tab.url, page))
    || null;
};
const findUniqueExistingTaskTab = async (page) => {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const matches = Array.isArray(tabs) ? tabs.filter((tab) => Number.isInteger(tab?.id) && isTargetUrl(tab.url, page)) : [];
  return matches.length === 1 ? matches[0] : null;
};
const activateCoordinatorRun = async ({ source, stage, tabId, originActiveTabId, actionId, transition }) => {
  await loadRuntimeState();
  const todayKey = getLosAngelesDateKey(new Date());
  const run = runtimeState.run || defaultRuntimeState().run;
  if (run.runId && run.laDateKey === todayKey) {
    if (Number.isInteger(tabId) && !run.currentTabId) runtimeState.run.currentTabId = tabId;
    if (!runtimeState.run.currentActionId && actionId) runtimeState.run.currentActionId = actionId;
    return runtimeState.run;
  }
  runtimeState.run = {
    ...run,
    runId: run.runId || crypto.randomUUID(),
    laDateKey: todayKey,
    source,
    stage,
    status: 'running',
    transition,
    lease: { owner: 'coordinator', acquiredAt: Date.now() },
    attempt: (run.attempt || 0) + 1,
    currentTabId: Number.isInteger(tabId) ? tabId : null,
    originActiveTabId: Number.isInteger(originActiveTabId) ? originActiveTabId : null,
    currentActionId: actionId || null,
    lastError: null,
    events: Array.isArray(run.events) ? run.events : [],
  };
  await clearLegacyTaskState();
  await cleanupNonActiveDailyTabs(runtimeState.run.currentTabId);
  await saveRuntimeState();
  return runtimeState.run;
};

const ensureCoordinatorRun = async ({ action, source, now = new Date() } = {}) => {
  await loadRuntimeState();
  const originActiveTabId = await captureOriginActiveTabId();
  const todayKey = getLosAngelesDateKey(now);
  const run = runtimeState.run || defaultRuntimeState().run;
  if (run.runId && run.laDateKey === todayKey) {
    if (Number.isInteger(originActiveTabId) && !Number.isInteger(run.originActiveTabId)) {
      runtimeState.run.originActiveTabId = originActiveTabId;
      await saveRuntimeState();
    }
    return runtimeState.run;
  }
  const actionId = crypto.randomUUID();
  runtimeState.run = {
    ...run,
    runId: run.runId || crypto.randomUUID(),
    laDateKey: todayKey,
    source,
    stage: action,
    status: 'running',
    transition: 'coordinator-start',
    lease: { owner: 'coordinator', acquiredAt: now.getTime() },
    attempt: (run.attempt || 0) + 1,
    currentTabId: null,
    originActiveTabId,
    currentActionId: actionId,
    lastError: null,
    events: Array.isArray(run.events) ? run.events : [],
  };
  await saveRuntimeState();
  return runtimeState.run;
};

const defaultAutoState = () => ({
  version: 1,
  enabled: false,
  plan: null,
  lastRunDateKey: null,
  lastRunStatus: null,
  lastRunAt: null,
  lastResult: null,
  retry: null,
  activeRunDateKey: null,
  activeRunStartedAt: null,
});

const loadAutoState = async () => {
  if (autoState) return autoState;
  autoState = defaultAutoState();
  return autoState;
};

const saveAutoState = async () => {};
const hasAutoAlarm = async () => false;

const scheduleRuntimeFinalization = async (pending) => {
  if (!pending?.actionId || typeof chrome.alarms?.create !== 'function') {
    const finalizationError = 'runtime-finalization-alarm-unavailable';
    await setRunError(finalizationError, 'runtime-finalization-alarm-unavailable').catch(() => {});
    await pushRunEvent('runtime-finalization-diagnostics', {
      actionId: pending?.actionId ?? null,
      tabId: pending?.tabId ?? null,
      finalizationError,
    }).catch(() => {});
    await updateFinalizationDiagnostics(pending?.tabId, pending, {
      finalizationError,
    }).catch(() => {});
    return false;
  }
  const alarmName = `${RUNTIME_FINALIZE_ALARM_PREFIX}${pending.actionId}`;
  try {
    await chrome.alarms.create(alarmName, { when: Date.now() + 1 });
    if (typeof chrome.alarms?.get === 'function') {
      const alarm = await chrome.alarms.get(alarmName);
      if (!alarm?.name) throw new Error('runtime-finalization-alarm-missing-after-create');
    }
    await updateFinalizationDiagnostics(pending.tabId, pending, {
      finalizationError: null,
      finalizationAttemptAt: Date.now(),
    }).catch(() => {});
    return true;
  } catch (error) {
    const finalizationError = 'alarm-create-failed';
    await pushRunEvent('runtime-finalization-diagnostics', {
      actionId: pending.actionId,
      tabId: pending.tabId,
      finalizationError,
    }).catch(() => {});
    await updateFinalizationDiagnostics(pending.tabId, pending, {
      finalizationError,
      finalizationAttemptAt: Date.now(),
    }).catch(() => {});
    runtimeState.run.lastError = finalizationError;
    runtimeState.run.transition = 'runtime-finalization-alarm-create-failed';
    runtimeState.run.events = [...(Array.isArray(runtimeState.run.events) ? runtimeState.run.events : []), {
      at: Date.now(),
      type: 'runtime-finalization-alarm-create-failed',
      actionId: pending.actionId,
      tabId: pending.tabId,
      error: finalizationError,
    }].slice(-30);
    await saveRuntimeState();
    return false;
  }
};

const inspectAutoAlarm = async () => ({ exists: false, matches: false, alarm: null });

const getAutoStatePayload = async () => ({
  enabled: false,
  status: 'disabled',
  todayStatus: 'disabled',
  lastResult: null,
  currentRun: null,
  runEvents: [],
  runtimeDiagnostics: collectRuntimeDiagnostics(),
});

const syncActionIcon = async (enabled) => {
  if (typeof chrome.action?.setIcon !== 'function') return false;
  const iconPaths = resolveActionIconPaths(enabled ? ACTION_ICON_PATHS.enabled : ACTION_ICON_PATHS.disabled);
  await chrome.action.setIcon({ path: iconPaths });
  return true;
};

const syncActionIconFromState = async () => {
  const state = await loadAutoState();
  await syncActionIcon(Boolean(state?.enabled));
};

// A worker can be re-evaluated without a browser restart, so onStartup is not
// guaranteed to run after the manifest restores the default toolbar icon.
syncActionIconFromState().catch(() => {});

const clearAutoAlarm = async () => {};
const setAutoState = async () => defaultAutoState();
const scheduleAutoAlarm = async () => false;
const ensurePersistedAutoAlarm = async () => false;
const resyncAutoSchedule = async () => defaultAutoState();
const disableAutoSchedule = async () => defaultAutoState();
const enableAutoSchedule = async () => defaultAutoState();
const completeAutoRun = async () => {};
const scheduleSameDayAutoRetry = async () => defaultAutoState();
const pauseAutoRunForLogin = async () => defaultAutoState();
const finalizeAutoRunFailure = async () => defaultAutoState();
const handleAutoQuestionStartupFailure = async () => false;

const persistQuestionRunFailureState = async ({ error = null, status = 'paused', transition = 'question' } = {}) => {
  runtimeState.run.status = status;
  runtimeState.run.stage = 'question';
  runtimeState.run.transition = transition;
  runtimeState.run.currentTabId = null;
  runtimeState.run.currentActionId = null;
  runtimeState.run.lastError = error?.message || error?.name || (typeof error === 'string' ? error : null);
  await saveRuntimeState().catch(() => {});
};

const consumeAutoPlanForToday = async () => ({ ok: false, reason: 'disabled' });

const getActionRecord = (tabId) => runtimeState?.actionsByTabId[String(tabId)] || null;
const getAwaitingRecord = (tabId) => runtimeState?.awaitingContentByTabId[String(tabId)] || null;
const getWorkflow = (workflowId) => runtimeState?.workflowsById[workflowId] || null;
const getActionRecordById = (actionId) => {
  if (!runtimeState || !actionId) return null;
  return runtimeState.pendingActionsById[actionId]
    || Object.values(runtimeState.actionsByTabId || {}).find((record) => record?.actionId === actionId)
    || Object.values(runtimeState.awaitingContentByTabId || {}).find((record) => record?.actionId === actionId)
    || null;
};
const isSuccessResult = (result) => result?.status === 'success';
const isExistingTabId = async (tabId) => {
  if (!Number.isInteger(tabId)) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab?.id);
};

const isTabAlreadyGone = async (tabId) => {
  if (!Number.isInteger(tabId)) return true;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return !tab?.id;
};

const waitForTabToSettleInactive = async (tabId, { attempts = 5, delayMs = 50 } = {}) => {
  if (!Number.isInteger(tabId)) return null;
  let lastTab = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    lastTab = tab;
    if (tab.active !== true) return tab;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return lastTab;
};
const waitForTabUrl = async (tabId, expectedUrl, { attempts = 8, delayMs = 75 } = {}) => {
  if (!Number.isInteger(tabId) || !expectedUrl) return null;
  let lastTab = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    lastTab = tab;
    if (isTargetUrl(tab.url, expectedUrl)) return tab;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return lastTab;
};

const canSafelyCloseActionTab = (record, pending) => Boolean(
  record
  && pending
  && record.actionId === pending.actionId
  && record.workflowId === pending.workflowId
  && record.action === pending.action
);

function collectRuntimeDiagnostics() {
  const records = [
    ...Object.values(runtimeState?.actionsByTabId || {}),
    ...Object.values(runtimeState?.awaitingContentByTabId || {}),
    ...Object.values(runtimeState?.pendingActionsById || {}),
  ];
  return records
    .filter((record, index, array) => record && array.findIndex((item) => item?.actionId === record.actionId) === index)
    .map((record) => ({
      tabId: record.tabId ?? null,
      action: record.action ?? null,
      status: record.status ?? null,
      closeStatus: record.closeStatus ?? null,
      closeSkippedReason: record.closeSkippedReason ?? null,
      closeSkippedDetail: record.closeSkippedDetail ?? null,
      finalizationError: record.finalizationError ?? null,
      finalizationPending: record.finalizationPending === true,
    }))
    .filter((record) => record.closeStatus || record.closeSkippedReason || record.finalizationError || record.finalizationPending);
}

const markFinalizationPending = async (tabId, pending, finalizationPending) => {
  if (!Number.isInteger(tabId) || !pending?.actionId) return null;
  await loadRuntimeState();
  const current = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!current || current.actionId !== pending.actionId) return null;
  const next = { ...current, finalizationPending };
  runtimeState.actionsByTabId[String(tabId)] = next;
  if (runtimeState.awaitingContentByTabId[String(tabId)]) {
    runtimeState.awaitingContentByTabId[String(tabId)] = { ...runtimeState.awaitingContentByTabId[String(tabId)], finalizationPending };
  }
  if (runtimeState.pendingActionsById[next.actionId]) {
    runtimeState.pendingActionsById[next.actionId] = { ...runtimeState.pendingActionsById[next.actionId], finalizationPending };
  }
  await saveRuntimeState();
  return next;
};

const updateFinalizationDiagnostics = async (tabId, pending, patch = {}) => {
  if (!Number.isInteger(tabId) || !pending?.actionId) return null;
  await loadRuntimeState();
  const current = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!current || current.actionId !== pending.actionId) return null;
  const next = {
    ...current,
    ...patch,
    finalizationAttemptAt: Number.isFinite(patch.finalizationAttemptAt) ? patch.finalizationAttemptAt : (Number.isFinite(current.finalizationAttemptAt) ? current.finalizationAttemptAt : Date.now()),
  };
  runtimeState.actionsByTabId[String(tabId)] = next;
  if (runtimeState.awaitingContentByTabId[String(tabId)]) {
    runtimeState.awaitingContentByTabId[String(tabId)] = { ...runtimeState.awaitingContentByTabId[String(tabId)], ...patch, finalizationAttemptAt: next.finalizationAttemptAt };
  }
  if (runtimeState.pendingActionsById[next.actionId]) {
    runtimeState.pendingActionsById[next.actionId] = { ...runtimeState.pendingActionsById[next.actionId], ...patch, finalizationAttemptAt: next.finalizationAttemptAt };
  }
  await saveRuntimeState();
  return next;
};

const closeActionTabSafely = async (tabId, pending = null) => {
  if (!Number.isInteger(tabId)) return false;
  await loadRuntimeState();
  const record = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!canSafelyCloseActionTab(record, pending)) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'missing-record',
      closeSkippedDetail: 'no-matching-action-record',
      finalizationError: null,
    });
    return false;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'missing-tab',
      closeSkippedDetail: 'tab-no-longer-exists',
      finalizationError: null,
    });
    return false;
  }
  if (pending?.tabId != null && pending.tabId !== tabId) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'tab-id-mismatch',
      closeSkippedDetail: `pending-tab-id-${pending.tabId}`,
      finalizationError: null,
    });
    return false;
  }
  if (pending?.action && !isTargetUrl(tab.url, actionPage(pending.action))) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'url-mismatch',
      closeSkippedDetail: String(tab.url || ''),
      finalizationError: null,
    });
    return false;
  }
  await loadRuntimeState();
  const latest = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!canSafelyCloseActionTab(latest, pending)) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'missing-record',
      closeSkippedDetail: 'latest-record-mismatch',
      finalizationError: null,
    });
    return false;
  }
  const refreshedTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!refreshedTab) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'missing-record',
      closeSkippedDetail: 'tab-missing-during-final-validation',
      finalizationError: null,
    });
    return false;
  }
  if (!isTargetUrl(refreshedTab.url, actionPage(pending.action)) || !isTargetUrl(refreshedTab.url, actionPage(latest.action))) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'url-mismatch',
      closeSkippedDetail: String(refreshedTab.url || ''),
      finalizationError: null,
    });
    return false;
  }
  if (latest.actionId !== pending.actionId || latest.workflowId !== pending.workflowId || latest.action !== pending.action || latest.tabId !== tabId) {
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'missing-record',
      closeSkippedDetail: 'latest-record-changed-during-final-validation',
      finalizationError: null,
    });
    return false;
  }
  await updateFinalizationDiagnostics(tabId, pending, {
    closeStatus: 'closing',
    closeSkippedReason: null,
    closeSkippedDetail: null,
    finalizationError: null,
  });
  try {
    await chrome.tabs.remove(tabId);
    return true;
  } catch (error) {
    const finalizationError = error?.message || String(error) || 'remove-failed';
    await updateFinalizationDiagnostics(tabId, pending, {
      closeStatus: 'failed',
      closeSkippedReason: 'remove-failed',
      closeSkippedDetail: 'chrome.tabs.remove threw',
      finalizationError,
    });
    console.warn('closeActionTabSafely remove failed', tabId, finalizationError);
    return false;
  }
};

const promoteOrCreateQuestionTabAfterCloseFailure = async (pending, inheritedFinalizationError = null) => {
  if (!Number.isInteger(pending?.tabId)) return { ok: false, reason: 'missing-tab-id' };
  await loadRuntimeState();
  const latest = getActionRecord(pending.tabId) || getAwaitingRecord(pending.tabId);
  const closeStatus = typeof latest?.closeStatus === 'string' ? latest.closeStatus : null;
  const closeSkippedReason = typeof latest?.closeSkippedReason === 'string' ? latest.closeSkippedReason : null;
  const controlledCloseFailure = new Set(['active-tab', 'origin-active-tab', 'origin-restore-failed', 'remove-failed']);
  if (!latest?.createdByExtension) return { ok: false, reason: 'unowned-tab' };
  if (latest.reusedExistingTab === true) return { ok: false, reason: 'reused-existing-tab' };
  if (closeStatus !== 'skipped' && closeStatus !== 'failed') return { ok: false, reason: 'uncontrolled-close-status' };
  if (!controlledCloseFailure.has(closeSkippedReason)) return { ok: false, reason: 'uncontrolled-close-reason' };
  const questionUrl = actionPage('question');
  const currentTab = await chrome.tabs.get(pending.tabId).catch(() => null);
  if (currentTab) {
    if (!isTargetUrl(currentTab.url, actionPage('checkin'))) return { ok: false, reason: 'current-url-not-checkin' };
    await chrome.tabs.update(pending.tabId, { url: questionUrl });
    const updatedTab = await waitForTabUrl(pending.tabId, questionUrl);
    if (!updatedTab || !isTargetUrl(updatedTab.url, questionUrl)) {
      return { ok: false, reason: 'question-tab-url-did-not-settle' };
    }
    return { ok: true, tabId: pending.tabId, mode: 'updated' };
  }
  if (typeof chrome.tabs?.create !== 'function') {
    throw new Error('tabs-create-unavailable');
  }
  const questionTab = await chrome.tabs.create({ url: questionUrl, active: false });
  return { ok: true, tabId: questionTab.id, mode: 'created' };
};

const setActionRecord = async (tabId, record) => {
  await loadRuntimeState();
  const next = { ...record, tabId };
  runtimeState.actionsByTabId[String(tabId)] = next;
  delete runtimeState.awaitingContentByTabId[String(tabId)];
  if (next.actionId) delete runtimeState.pendingActionsById[next.actionId];
  await saveRuntimeState();
};

const clearTabRecord = async (tabId) => {
  await loadRuntimeState();
  const actionId = runtimeState.actionsByTabId[String(tabId)]?.actionId || runtimeState.awaitingContentByTabId[String(tabId)]?.actionId;
  delete runtimeState.actionsByTabId[String(tabId)];
  delete runtimeState.awaitingContentByTabId[String(tabId)];
  if (actionId) delete runtimeState.pendingActionsById[actionId];
  await saveRuntimeState();
};

const clearActionArtifacts = async (tabId) => {
  await clearTabRecord(tabId);
};

const clearActionArtifactsIfFinalized = async (tabId, pending) => {
  if (!Number.isInteger(tabId) || !pending?.actionId) return false;
  await loadRuntimeState();
  const current = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!current) return true;
  if (current.actionId !== pending.actionId) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (current.finalizationPending === true && tab) return false;
  if (current.action === 'question' && pending.workflowId) {
    delete runtimeState.workflowsById[pending.workflowId];
    if (runtimeState.activeWorkflowId === pending.workflowId) runtimeState.activeWorkflowId = null;
  }
  await clearTabRecord(tabId);
  return true;
};

// A completed check-in is an intermediate success, never the end of the
// one-click run. This recovery path is deliberately independent of the
// original message event: an MV3 worker can be reclaimed after the check-in
// tab disappears and before the normal finalizer creates the question tab.
const recoverCompletedCheckinToQuestion = async (pending, { isAutoRun = false, source = 'recoverCompletedActionFinalization' } = {}) => {
  if (!pending || pending.action !== 'checkin' || pending.workflowId) return false;
  const inheritedFinalizationError = typeof pending.finalizationError === 'string' && pending.finalizationError
    ? pending.finalizationError
    : null;
  await clearActionArtifactsIfFinalized(pending.tabId, pending);
  try {
    await pushRunEvent('question-tab-opening', {
      from: source,
      tabId: pending.tabId,
      actionId: pending.actionId,
      reason: 'completed-checkin-advances-to-question',
      at: Date.now(),
    });
    const originActiveTabId = await captureOriginActiveTabId();
    const questionUrl = actionPage('question');
    const existingQuestionTab = await findExistingTaskTab(questionUrl);
    const questionTab = existingQuestionTab || (typeof chrome.tabs?.create === 'function'
      ? await chrome.tabs.create({ url: questionUrl, active: false })
      : null);
    if (!questionTab) throw new Error('tabs-create-unavailable');
    const questionActionId = crypto.randomUUID();
    await createCoordinatorActionRecord({
      tabId: questionTab.id,
      action: 'question',
      actionId: questionActionId,
      workflowId: null,
      createdByExtension: true,
      reusedExistingTab: Boolean(existingQuestionTab),
      originActiveTabId,
      finalizationError: inheritedFinalizationError,
    });
    runtimeState.run.stage = 'question';
    runtimeState.run.transition = 'question';
    runtimeState.run.currentTabId = questionTab.id;
    runtimeState.run.currentActionId = questionActionId;
    runtimeState.run.lastError = null;
    await saveRuntimeState();
    try {
      await retryDeliverIfNeeded(questionTab.id, { force: true });
    } catch (error) {
      const message = error?.message || String(error) || 'question-delivery-failed';
      runtimeState.run.lastError = message;
      await pushRunEvent('question-delivery-failed', {
        from: source,
        tabId: questionTab.id,
        actionId: questionActionId,
        error: message,
        at: Date.now(),
      }).catch(() => {});
      await saveRuntimeState().catch(() => {});
    }
    await pushRunEvent('question-tab-created', {
      tabId: questionTab.id,
      actionId: questionActionId,
      originActiveTabId,
      active: false,
    }).catch(() => {});
    await updateFinalizationDiagnostics(questionTab.id, {
      action: 'question', actionId: questionActionId, workflowId: null, tabId: questionTab.id,
    }, { finalizationError: inheritedFinalizationError }).catch(() => {});
    return true;
  } catch (error) {
    const message = error?.message || String(error) || 'question-tab-create-failed';
    await pushRunEvent('question-tab-create-failed', {
      from: source,
      tabId: pending.tabId,
      actionId: pending.actionId,
      error: message,
      at: Date.now(),
    }).catch(() => {});
    await setRunError(message, 'coordinator-finalize-question-create-failed').catch(() => {});
    if (isAutoRun) {
      await loadAutoState();
      await scheduleSameDayAutoRetry({
        pending: { ...pending, action: 'question' },
        result: { status: 'failed', reason: 'question-tab-start-failed', error: message },
        now: new Date(),
      });
      runtimeState.run.status = 'running';
    } else {
      runtimeState.run.status = 'paused';
    }
    runtimeState.run.stage = 'question';
    runtimeState.run.transition = 'question';
    runtimeState.run.currentTabId = null;
    runtimeState.run.currentActionId = null;
    runtimeState.run.lastError = message;
    await saveRuntimeState().catch(() => {});
    return false;
  }
};

const recoverCompletedActionFinalization = async (pending, { now = new Date(), random = Math.random } = {}) => {
  if (!pending || pending.status !== 'completed' || !pending.finalizationPending || !isSuccessResult(pending.lastResult)) return false;
  await loadRuntimeState();
  await loadAutoState();
  const run = getRunState();
  // Recovery is driven only by the persisted current run.  Historical action
  // records must never be allowed to create tabs or complete a later run.
  if (!run.runId || run.currentActionId !== pending.actionId || run.currentTabId !== pending.tabId) return false;
  const activeWorkflow = pending.workflowId ? getWorkflow(pending.workflowId) : null;
  const isSettledAutoWorkflow = Boolean(
    pending.workflowId
    && activeWorkflow?.action === 'everything'
    && autoState?.enabled
    && !autoState.activeRunDateKey
    && ['retry-scheduled', 'login-blocked', 'failed', 'completed'].includes(autoState.lastRunStatus)
  );
  if (isSettledAutoWorkflow) return false;
  const shouldCompleteAutoRun = Boolean(autoState?.enabled && autoState.activeRunDateKey && pending.action === 'question' && (run.source === 'auto' || pending.workflowId));
  const tabExists = await chrome.tabs.get(pending.tabId).then(() => true).catch(() => false);
  const isAutoRun = run.source === 'auto' || Boolean(autoState?.enabled && autoState.activeRunDateKey && run.laDateKey === autoState.activeRunDateKey);
  if (pending.action === 'checkin' && !pending.workflowId) {
    if (tabExists) {
      const closed = await closeActionTabSafely(pending.tabId, pending);
      const missing = pending.createdByExtension === true ? await isTabAlreadyGone(pending.tabId) : false;
      if (!closed && !missing) {
        runtimeState.run.status = 'paused';
        runtimeState.run.lastError = runtimeState.actionsByTabId[String(pending.tabId)]?.finalizationError || 'finalization-failed';
        await saveRuntimeState();
        return false;
      }
    }
    return recoverCompletedCheckinToQuestion(pending, { isAutoRun });
  }
  // The tab may have been removed just before the worker restarted. Treat that
  // as a completed finalization instead of pausing the run forever.
  const finalized = tabExists ? await finalizeCompletedSuccess(pending) : true;
  if (!finalized) {
    runtimeState.run.status = 'paused';
    runtimeState.run.lastError = runtimeState.actionsByTabId[String(pending.tabId)]?.finalizationError || 'finalization-failed';
    await saveRuntimeState();
    return false;
  }
  if (pending.action === 'question' && pending.workflowId) {
    await clearActionArtifactsIfFinalized(pending.tabId, pending);
  } else {
    await clearActionArtifacts(pending.tabId);
  }
  runtimeState.run = { ...defaultRuntimeState().run, status: 'idle', events: runtimeState.run?.events || [] };
  await saveRuntimeState();
  if (shouldCompleteAutoRun) {
    await completeAutoRun({ status: 'completed', now, random });
  }
  return true;
};

const scanPendingActionDeliveries = async () => {
  await loadRuntimeState();
  const tabIds = new Set([
    ...Object.keys(runtimeState.actionsByTabId || {}),
    ...Object.keys(runtimeState.awaitingContentByTabId || {}),
  ]);
  for (const tabIdValue of tabIds) {
    const tabId = Number(tabIdValue);
    if (!Number.isInteger(tabId)) continue;
    const record = getActionRecord(tabId) || getAwaitingRecord(tabId);
    if (!record || record.status !== 'pending') continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !isTargetUrl(tab.url, actionPage(record.action))) continue;
    await retryDeliverIfNeeded(tabId).catch(() => {});
  }
};

const recoverAutoWorkflowProgress = async ({ now = new Date(), random = Math.random } = {}) => {
  await loadRuntimeState();
  await loadAutoState();
  if (!autoState.enabled || !autoState.activeRunDateKey || !runtimeState.activeWorkflowId) return false;
  const workflowId = runtimeState.activeWorkflowId;
  const workflow = getWorkflow(workflowId);
  if (!workflow || workflow.action !== 'everything') return false;
  if (workflow.stage === 'question') {
    const questionRecord = getWorkflowActionRecord(workflowId, 'question');
    if (questionRecord?.status === 'completed' && isSuccessResult(questionRecord.lastResult)) {
      return recoverCompletedActionFinalization(questionRecord, { now, random });
    }
    if (!questionRecord || questionRecord.status !== 'pending') {
      try {
        const tabId = await ensureQuestionWorkflowTab(workflowId);
        if (Number.isInteger(tabId)) return true;
      } catch (error) {
        await handleAutoQuestionStartupFailure({ workflowId, error, now, random });
        return true;
      }
    }
  }
  return false;
};

const reserveActionRecord = async (record) => {
  await loadRuntimeState();
  runtimeState.pendingActionsById[record.actionId] = { ...record };
  await saveRuntimeState();
};

const refreshLoginBlockedAction = async (tabId, action) => {
  const key = String(tabId);
  if (loginBlockedRefreshByTabId.has(key)) return loginBlockedRefreshByTabId.get(key);

  const promise = (async () => {
    const now = new Date();
    await loadRuntimeState();
    await loadAutoState();
    const current = action || getActionRecord(tabId) || getAwaitingRecord(tabId);
    if (!current || current.status === 'completed') return null;
    if (current.lastResult?.status !== 'login-blocked' && current.lastResult?.reason !== 'requires-login') return current;
    const latest = getActionRecord(tabId) || getAwaitingRecord(tabId);
    if (!latest || latest.actionId !== current.actionId) return latest || current;

    const nextActionId = crypto.randomUUID();
    const currentRunActionId = runtimeState.run?.currentActionId ?? null;
    const refreshed = {
      ...current,
      actionId: nextActionId,
      status: 'pending',
      deliveredAt: null,
      deliveredCount: 0,
      lastDeliveryAttemptAt: null,
      lastDeliveryError: null,
      lastResult: null,
    };

    delete runtimeState.pendingActionsById[current.actionId];
    runtimeState.pendingActionsById[nextActionId] = { ...refreshed };
    runtimeState.actionsByTabId[key] = { ...refreshed, tabId };
    runtimeState.awaitingContentByTabId[key] = { ...refreshed, tabId };
    if (runtimeState.run?.currentTabId === tabId && runtimeState.run?.currentActionId === current.actionId) {
      runtimeState.run.currentActionId = nextActionId;
      runtimeState.run.lastError = null;
    }

    const sameDayAutoRun = Boolean(
      autoState?.enabled
      && runtimeState.run?.source === 'auto'
      && runtimeState.run?.laDateKey
      && runtimeState.run?.laDateKey === getLosAngelesDateKey(now)
      && runtimeState.run?.currentTabId === tabId
      && currentRunActionId === current.actionId
    );
    if (sameDayAutoRun) {
      const todayKey = getLosAngelesDateKey(now);
      autoState.activeRunDateKey = todayKey;
      autoState.activeRunStartedAt = now.getTime();
      autoState.lastRunDateKey = todayKey;
      autoState.lastRunStatus = 'started';
      autoState.lastRunAt = now.getTime();
      autoState.retry = null;
      autoState.lastError = null;
      await saveAutoState();
    }

    if (refreshed.workflowId) {
      const workflow = getWorkflow(refreshed.workflowId);
      if (workflow) {
        if (workflow.checkinActionId === current.actionId) workflow.checkinActionId = nextActionId;
        if (workflow.questionActionId === current.actionId) workflow.questionActionId = nextActionId;
        workflow.stage = refreshed.action;
        workflow.updatedAt = Date.now();
      }
    }

    await saveRuntimeState();
    return getActionRecord(tabId);
  })().finally(() => {
    if (loginBlockedRefreshByTabId.get(key) === promise) loginBlockedRefreshByTabId.delete(key);
  });

  loginBlockedRefreshByTabId.set(key, promise);
  return promise;
};

const claimPendingActionForTab = async (tabId, page) => {
  await loadRuntimeState();
  const pending = Object.values(runtimeState.pendingActionsById).find((record) => record?.status === 'pending' && record?.action && isTargetUrl(page, actionPage(record.action)));
  if (!pending) return null;
  await setActionRecord(tabId, pending);
  return getActionRecord(tabId);
};

const createCoordinatorActionRecord = async ({
  tabId,
  action,
  actionId,
  workflowId = null,
  createdByExtension = true,
  reusedExistingTab = false,
  originActiveTabId = null,
  finalizationPending = false,
  closeStatus = null,
  closeSkippedReason = null,
  closeSkippedDetail = null,
  finalizationError = null,
  finalizationAttemptAt = null,
  finalizationCompletedAt = null,
}) => {
  await loadRuntimeState();
  const record = {
    action,
    actionId,
    workflowId,
    tabId,
    originActiveTabId,
    status: 'pending',
    deliveredAt: null,
    deliveredCount: 0,
    lastDeliveryAttemptAt: null,
    lastDeliveryError: null,
    lastResult: null,
    createdByExtension,
    reusedExistingTab,
    finalizationPending,
    closeStatus,
    closeSkippedReason,
    closeSkippedDetail,
    finalizationError,
    finalizationAttemptAt,
    finalizationCompletedAt,
  };
  runtimeState.actionsByTabId[String(tabId)] = { ...record };
  runtimeState.awaitingContentByTabId[String(tabId)] = { ...record };
  runtimeState.pendingActionsById[actionId] = { ...record };
  runtimeState.run.currentTabId = tabId;
  runtimeState.run.currentActionId = actionId;
  await saveRuntimeState();
  return record;
};

const openCoordinatorActionTab = async ({ action, actionId, workflowId = null, source = 'startup', manual = false, now = new Date() }) => {
  const page = actionPage(action);
  runtimeState.run.stage = action;
  runtimeState.run.transition = 'opening';
  runtimeState.run.currentTabId = null;
  runtimeState.run.currentActionId = actionId;
  await saveRuntimeState();
  await pushRunEvent('tab-opening', { action, actionId, manual, source, at: now.getTime() });
  const tab = await chrome.tabs.create({ url: page, active: false });
  await createCoordinatorActionRecord({ tabId: tab.id, action, actionId, workflowId, createdByExtension: true, reusedExistingTab: false, originActiveTabId: runtimeState.run.originActiveTabId ?? null });
  await pushRunEvent('tab-created', { tabId: tab.id, action, actionId, manual, at: now.getTime() });
  await saveRuntimeState();
  return tab;
};

const setWorkflow = async (workflowId, workflow) => {
  await loadRuntimeState();
  runtimeState.workflowsById[workflowId] = normalizeWorkflow(workflow);
  runtimeState.activeWorkflowId = workflowId;
  await saveRuntimeState();
};

const clearWorkflow = async (workflowId) => {
  await loadRuntimeState();
  delete runtimeState.workflowsById[workflowId];
  if (runtimeState.activeWorkflowId === workflowId) runtimeState.activeWorkflowId = null;
  await saveRuntimeState();
};

const getWorkflowActionRecord = (workflowId, action) => {
  if (!runtimeState) return null;
  return Object.values(runtimeState.actionsByTabId).find((record) => record?.workflowId === workflowId && record?.action === action) || null;
};

const ensureQuestionWorkflowTab = async (workflowId) => {
  await loadRuntimeState();
  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;

  const existing = getWorkflowActionRecord(workflowId, 'question');
  if (existing?.tabId != null && await isExistingTabId(existing.tabId)) {
    workflow.stage = 'question';
    workflow.tabIds = Array.from(new Set([...(workflow.tabIds || []), existing.tabId]));
    workflow.questionActionId = existing.actionId || workflow.questionActionId;
    workflow.updatedAt = Date.now();
    await saveRuntimeState();
    await retryDeliverIfNeeded(existing.tabId, { force: true }).catch(() => {});
    return existing.tabId;
  }

  const questionTab = await openActionPage('question', workflowId);
  const questionAction = getActionRecord(questionTab.id);
  workflow.stage = 'question';
  workflow.tabIds = Array.from(new Set([...(workflow.tabIds || []), questionTab.id]));
  workflow.questionActionId = questionAction?.actionId || workflow.questionActionId;
  workflow.updatedAt = Date.now();
  await saveRuntimeState();
  return questionTab.id;
};

const promoteCheckinTabToQuestion = async (pending) => {
  if (!pending || pending.action !== 'checkin' || !pending.workflowId || !Number.isInteger(pending.tabId)) return null;
  await loadRuntimeState();
  const workflow = getWorkflow(pending.workflowId);
  const current = getActionRecord(pending.tabId) || getAwaitingRecord(pending.tabId);
  if (!workflow || !current || current.actionId !== pending.actionId) return null;
  const currentTab = await chrome.tabs.get(pending.tabId).catch(() => null);
  const isExtensionOwnedTab = current.createdByExtension === true && current.reusedExistingTab !== true;
  const isActiveUserTab = currentTab?.active === true;
  // A tab opened by the extension can be promoted after a close failure. A
  // user-owned tab is promoted only while it is already active: this keeps
  // the user's current tab in place without silently rewriting a background
  // tab that the workflow merely reused.
  if (!isExtensionOwnedTab && !isActiveUserTab) return null;

  const preserveUserTab = !isExtensionOwnedTab;

  const inheritedFinalizationError = typeof pending.finalizationError === 'string' && pending.finalizationError ? pending.finalizationError : null;
  const nextActionId = crypto.randomUUID();
  const nextRecord = {
    action: 'question',
    actionId: nextActionId,
    workflowId: pending.workflowId,
    tabId: pending.tabId,
    originActiveTabId: current.originActiveTabId ?? null,
    status: 'pending',
    deliveredAt: null,
    deliveredCount: 0,
    lastDeliveryAttemptAt: null,
    lastDeliveryError: null,
    lastResult: null,
    createdByExtension: preserveUserTab ? false : true,
    reusedExistingTab: preserveUserTab,
    finalizationPending: false,
    closeStatus: null,
    closeSkippedReason: null,
    closeSkippedDetail: null,
    finalizationError: inheritedFinalizationError,
    finalizationAttemptAt: null,
    finalizationCompletedAt: null,
  };

  const questionUrl = actionPage('question');
  await chrome.tabs.update(pending.tabId, { url: questionUrl });
  const updatedTab = await waitForTabUrl(pending.tabId, questionUrl);
  if (!updatedTab || !isTargetUrl(updatedTab.url, questionUrl)) {
    await updateFinalizationDiagnostics(pending.tabId, pending, {
      closeStatus: 'skipped',
      closeSkippedReason: 'question-promotion-failed',
      closeSkippedDetail: String(updatedTab?.url || ''),
      finalizationError: 'question-tab-url-did-not-settle',
    });
    return null;
  }
  delete runtimeState.pendingActionsById[current.actionId];
  runtimeState.actionsByTabId[String(pending.tabId)] = { ...nextRecord };
  runtimeState.awaitingContentByTabId[String(pending.tabId)] = { ...nextRecord };
  runtimeState.pendingActionsById[nextActionId] = { ...nextRecord };
  workflow.stage = 'question';
  workflow.checkinActionId = current.actionId;
  workflow.questionActionId = nextActionId;
  workflow.finalizationError = inheritedFinalizationError;
  workflow.tabIds = Array.from(new Set([...(workflow.tabIds || []), pending.tabId]));
  workflow.updatedAt = Date.now();
  await saveRuntimeState();
  await retryDeliverIfNeeded(pending.tabId, { force: true }).catch(() => {});
  return pending.tabId;
};

const finalizeCompletedSuccess = async (pending) => {
  if (!pending || pending.status !== 'completed' || !isSuccessResult(pending.lastResult)) return;
  let completed = false;
  const canAssumeOwnedByExtension = pending.createdByExtension === true;
  const isExplicitlyNonOwned = pending.createdByExtension === false || pending.reusedExistingTab === true;
  const inheritedFinalizationError = typeof pending.finalizationError === 'string' && pending.finalizationError
    ? pending.finalizationError
    : null;

  if (pending.action === 'checkin' && pending.workflowId) {
    try {
      await notifyCheckinCompletedOnce(pending.workflowId);
      const closed = await closeActionTabSafely(pending.tabId, pending);
      const missing = canAssumeOwnedByExtension ? await isTabAlreadyGone(pending.tabId) : false;
      completed = closed || missing;
      let nextQuestionTabId = null;
      if (completed) {
        await clearActionArtifactsIfFinalized(pending.tabId, pending);
        await loadRuntimeState();
        const workflow = getWorkflow(pending.workflowId);
        if (workflow) {
          workflow.finalizationError = inheritedFinalizationError;
          workflow.updatedAt = Date.now();
          await saveRuntimeState();
        }
        nextQuestionTabId = await ensureQuestionWorkflowTab(pending.workflowId);
      } else {
        nextQuestionTabId = await promoteCheckinTabToQuestion(pending);
        if (!Number.isInteger(nextQuestionTabId)) {
          nextQuestionTabId = await ensureQuestionWorkflowTab(pending.workflowId);
        }
      }
      if (Number.isInteger(nextQuestionTabId)) {
        await loadRuntimeState();
        const workflow = getWorkflow(pending.workflowId);
        if (workflow) {
          workflow.stage = 'question';
          workflow.checkinActionId = pending.actionId;
          workflow.finalizationError = inheritedFinalizationError;
          workflow.updatedAt = Date.now();
          await saveRuntimeState();
        }
        const questionRecord = getActionRecord(nextQuestionTabId) || getAwaitingRecord(nextQuestionTabId);
        if (questionRecord && questionRecord.workflowId === pending.workflowId) {
          if (runtimeState?.run?.runId && runtimeState.run.currentTabId === pending.tabId && runtimeState.run.currentActionId === pending.actionId) {
            runtimeState.run.stage = 'question';
            runtimeState.run.transition = 'question';
            runtimeState.run.currentTabId = nextQuestionTabId;
            runtimeState.run.currentActionId = questionRecord.actionId;
            runtimeState.run.lastError = null;
            await saveRuntimeState();
          }
          const nextQuestionRecord = {
            ...questionRecord,
            finalizationError: inheritedFinalizationError,
          };
          runtimeState.actionsByTabId[String(nextQuestionTabId)] = nextQuestionRecord;
          if (runtimeState.awaitingContentByTabId[String(nextQuestionTabId)]) {
            runtimeState.awaitingContentByTabId[String(nextQuestionTabId)] = { ...runtimeState.awaitingContentByTabId[String(nextQuestionTabId)], finalizationError: inheritedFinalizationError };
          }
          if (runtimeState.pendingActionsById[nextQuestionRecord.actionId]) {
            runtimeState.pendingActionsById[nextQuestionRecord.actionId] = { ...runtimeState.pendingActionsById[nextQuestionRecord.actionId], finalizationError: inheritedFinalizationError };
          }
          await saveRuntimeState();
        }
        await retryDeliverIfNeeded(nextQuestionTabId, { force: true }).catch(() => {});
      }
    } catch (error) {
      await loadRuntimeState();
      const nextWorkflow = getWorkflow(pending.workflowId);
      if (nextWorkflow) {
        nextWorkflow.stage = 'question';
        nextWorkflow.questionActionId = null;
        nextWorkflow.finalizationError = error?.message || String(error) || 'checkin-finalization-failed';
        nextWorkflow.updatedAt = Date.now();
        await saveRuntimeState();
      }
      await persistQuestionRunFailureState({ error, status: 'paused', transition: 'question' });
      await handleAutoQuestionStartupFailure({ workflowId: pending.workflowId, error, now: new Date(), random: Math.random });
    }
    return completed;
  }

  if (pending.action === 'question' && pending.workflowId) {
    const closed = await closeActionTabSafely(pending.tabId, pending);
    const missing = canAssumeOwnedByExtension ? await isTabAlreadyGone(pending.tabId) : false;
    completed = closed || missing;
    // Workflow tabs are explicitly owned by the one-click flow even when
    // the flow reused a tab that was already open. Only retain a reused tab
    // when closing it actually failed (for example, the browser rejected the
    // close); a successful close is a completed finalization.
    if (isExplicitlyNonOwned && !closed) completed = false;
    if (completed) await clearActionArtifactsIfFinalized(pending.tabId, pending);
    return completed;
  }

  const closed = await closeActionTabSafely(pending.tabId, pending);
  const missing = canAssumeOwnedByExtension ? await isTabAlreadyGone(pending.tabId) : false;
  completed = closed || missing;
  if (completed) await clearActionArtifactsIfFinalized(pending.tabId, pending);
  return completed;
};

const reconcileCompletedCheckinFinalization = async (workflowId) => {
  const checkinRecord = getWorkflowActionRecord(workflowId, 'checkin');
  if (!checkinRecord?.finalizationPending || checkinRecord.status !== 'completed' || !isSuccessResult(checkinRecord.lastResult)) return false;
  const finalized = await finalizeCompletedSuccess(checkinRecord);
  if (finalized) await clearActionArtifacts(checkinRecord.tabId);
  return finalized;
};

const notifyCheckinCompletedOnce = async (workflowId) => {
  if (!workflowId) return false;
  await loadRuntimeState();
  const workflow = getWorkflow(workflowId);
  if (!workflow || workflow.checkinNotifiedAt) return false;
  workflow.checkinNotifiedAt = Date.now();
  workflow.updatedAt = Date.now();
  await saveRuntimeState();
  await showCoordinatorNotification('签到完成');
  return true;
};

const deliverAction = async (tabId) => {
  await loadRuntimeState();
  const action = getActionRecord(tabId);
  if (!action || action.status === 'completed') return false;
  const now = Date.now();
  const awaiting = getAwaitingRecord(tabId);
  const deliveryCount = (action.deliveredCount || 0) + 1;
  const updated = { ...action, deliveredCount: deliveryCount, lastDeliveryAttemptAt: now };
  runtimeState.actionsByTabId[String(tabId)] = updated;
  if (awaiting) runtimeState.awaitingContentByTabId[String(tabId)] = { ...awaiting, deliveredCount: deliveryCount, lastDeliveryAttemptAt: now };
  await saveRuntimeState();
  try {
    const ack = await chrome.tabs.sendMessage(tabId, ExtensionProtocol.createMessage(ExtensionProtocol.MESSAGE_TYPES.RUN_ONE_CLICK, updated));
    if (!ack || ack.ok !== true || ack.accepted !== true || ack.actionId !== action.actionId) throw new Error('missing-ack');
    updated.deliveredAt = now;
    updated.lastDeliveryError = null;
    runtimeState.actionsByTabId[String(tabId)] = updated;
    delete runtimeState.awaitingContentByTabId[String(tabId)];
    await saveRuntimeState();
    return true;
  } catch (error) {
    updated.lastDeliveryError = error?.message || 'sendMessage-failed';
    runtimeState.actionsByTabId[String(tabId)] = updated;
    runtimeState.awaitingContentByTabId[String(tabId)] = { ...updated };
    await saveRuntimeState();
    return false;
  }
};

const retryDeliverIfNeeded = async (tabId, { force = false, pageState = null, manual = false } = {}) => {
  await loadRuntimeState();
  let action = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!action) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) action = await claimPendingActionForTab(tabId, tab.url);
  }
  if (!action || action.status === 'completed') return false;
  const loginBlocked = action.lastResult?.status === 'login-blocked' || action.lastResult?.reason === 'requires-login';
  if (loginBlocked && !force && (pageState == null || pageState === 'requires-login')) return false;
  if (loginBlocked && (force || (pageState && pageState !== 'requires-login'))) {
    action = await refreshLoginBlockedAction(tabId, action);
    if (!action) return false;
  }
  if ((action.deliveredCount || 0) >= DELIVERY_RETRY_LIMIT) {
    if (!manual) return false;
    action = { ...action, deliveredCount: 0, lastDeliveryAttemptAt: null, lastDeliveryError: null };
    runtimeState.actionsByTabId[String(tabId)] = action;
    if (runtimeState.awaitingContentByTabId[String(tabId)]) {
      runtimeState.awaitingContentByTabId[String(tabId)] = { ...runtimeState.awaitingContentByTabId[String(tabId)], deliveredCount: 0, lastDeliveryAttemptAt: null, lastDeliveryError: null };
    }
    await saveRuntimeState();
  }
  return deliverAction(tabId);
};

const openActionPage = async (action, workflowId = null) => {
  await loadRuntimeState();
  const page = actionPage(action);
  const originActiveTabId = await captureOriginActiveTabId();
  const actionRecord = {
    action,
    actionId: crypto.randomUUID(),
    workflowId,
    status: 'pending',
    createdByExtension: true,
    reusedExistingTab: false,
    originActiveTabId,
  };
  let target;
  await reserveActionRecord({ ...actionRecord, tabId: null });
  try {
    if (typeof chrome.tabs?.create !== 'function') throw new Error('tabs-create-unavailable');
    target = await chrome.tabs.create({ url: page, active: false });
    await setActionRecord(target.id, actionRecord);
  } catch (error) {
    await loadRuntimeState();
    delete runtimeState.pendingActionsById[actionRecord.actionId];
    await saveRuntimeState();
    throw error;
  }
  await retryDeliverIfNeeded(target.id);
  return target;
};

const coordinatorStart = async ({ action, source, manual = false, now = new Date() } = {}) => coordinatorQueue(async () => {
  const requestAction = normalizeCoordinatorAction(action);
  if (!isCoordinatorAction(requestAction)) throw new Error('unknown-action');
  await loadRuntimeState();
  const originActiveTabId = await captureOriginActiveTabId();
  await cleanupAllButCurrentDailyTab();
  await loadRuntimeState();
  const todayKey = getLosAngelesDateKey(now);
  const existingRun = runtimeState.run?.runId && runtimeState.run.laDateKey === todayKey ? runtimeState.run : null;
  const effectiveAction = existingRun?.stage && isCoordinatorAction(existingRun.stage) ? existingRun.stage : requestAction;
  const run = existingRun || await ensureCoordinatorRun({ action: effectiveAction, source, now });
  if (Number.isInteger(originActiveTabId) && !Number.isInteger(runtimeState.run.originActiveTabId)) {
    runtimeState.run.originActiveTabId = originActiveTabId;
    await saveRuntimeState();
  }
  const page = actionPage(effectiveAction);
  const current = Number.isInteger(runtimeState.run.currentTabId) ? await chrome.tabs.get(runtimeState.run.currentTabId).catch(() => null) : null;
  const currentRecord = Number.isInteger(runtimeState.run.currentTabId)
    ? getActionRecord(runtimeState.run.currentTabId) || getAwaitingRecord(runtimeState.run.currentTabId)
    : null;
  if (
    !current?.id
    && currentRecord?.action === 'checkin'
    && currentRecord.status === 'completed'
    && currentRecord.finalizationPending === true
    && isSuccessResult(currentRecord.lastResult)
    && runtimeState.run.currentActionId === currentRecord.actionId
  ) {
    // A just-closed check-in tab has a durable tabs.onRemoved handoff in
    // flight. Do not start another check-in if the user clicks the popup
    // again before that event creates the question tab.
    recoverRemovedCompletedCheckin(currentRecord.tabId).catch((error) => setRunError(error, 'start-during-removed-checkin-transition-failed'));
    return { tab: { id: currentRecord.tabId }, run: runtimeState.run, transitionPending: true };
  }
  if (current?.id && isTargetUrl(current.url, page)) {
    const actionId = runtimeState.run.currentActionId || crypto.randomUUID();
    runtimeState.run.stage = effectiveAction;
    runtimeState.run.transition = 'reconcile';
    if (!runtimeState.run.currentActionId) runtimeState.run.currentActionId = actionId;
    await saveRuntimeState();
    if (!getActionRecord(current.id) && !getAwaitingRecord(current.id)) {
      await createCoordinatorActionRecord({ tabId: current.id, action: effectiveAction, actionId, createdByExtension: true, reusedExistingTab: true, originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId });
    }
    await retryDeliverIfNeeded(current.id, { force: true, manual }).catch((error) => setRunError(error, 'deliver-current-failed'));
    return { tab: { id: current.id }, run: runtimeState.run };
  }
  if (current?.id && runtimeState.run.stage === 'question' && isTargetUrl(current.url, ExtensionProtocol.PAGE_URLS.dailyCheckin)) {
    const actionId = runtimeState.run.currentActionId || crypto.randomUUID();
    runtimeState.run.currentTabId = current.id;
    runtimeState.run.currentActionId = actionId;
    runtimeState.run.transition = 'reconcile';
    await saveRuntimeState();
    const updateChange = current.active === true ? { url: page } : { url: page, active: false };
    await chrome.tabs.update(current.id, updateChange);
    if (!getActionRecord(current.id) && !getAwaitingRecord(current.id)) {
      await createCoordinatorActionRecord({ tabId: current.id, action: effectiveAction, actionId, createdByExtension: true, reusedExistingTab: true, originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId });
    }
    await retryDeliverIfNeeded(current.id, { force: true, manual }).catch((error) => setRunError(error, 'deliver-current-failed'));
    return { tab: { id: current.id }, run: runtimeState.run };
  }
  const existing = await findExistingTaskTab(page);
  if (existing?.id != null) {
    const actionId = runtimeState.run.currentActionId || crypto.randomUUID();
    runtimeState.run.currentTabId = existing.id;
    runtimeState.run.stage = effectiveAction;
    runtimeState.run.currentActionId = actionId;
    runtimeState.run.transition = 'reconcile';
    if (Number.isInteger(originActiveTabId) && !Number.isInteger(runtimeState.run.originActiveTabId)) runtimeState.run.originActiveTabId = originActiveTabId;
    await saveRuntimeState();
    await createCoordinatorActionRecord({ tabId: existing.id, action: effectiveAction, actionId, createdByExtension: false, reusedExistingTab: true, originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId });
    await retryDeliverIfNeeded(existing.id, { force: true, manual }).catch((error) => setRunError(error, 'deliver-reused-failed'));
    return { tab: { id: existing.id }, run: runtimeState.run };
  }
  const actionId = crypto.randomUUID();
  runtimeState.run.currentActionId = actionId;
  runtimeState.run.currentTabId = null;
  runtimeState.run.stage = effectiveAction;
  runtimeState.run.transition = 'opening';
  if (Number.isInteger(originActiveTabId) && !Number.isInteger(runtimeState.run.originActiveTabId)) runtimeState.run.originActiveTabId = originActiveTabId;
  await saveRuntimeState();
  await pushRunEvent('tab-opening', { action: effectiveAction, actionId, manual, source, at: now.getTime() });
  const tab = await chrome.tabs.create({ url: page, active: false });
  await createCoordinatorActionRecord({ tabId: tab.id, action: effectiveAction, actionId, createdByExtension: true, reusedExistingTab: false, originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId });
  await pushRunEvent('tab-created', { tabId: tab.id, action: effectiveAction, actionId, manual, at: now.getTime() });
  await saveRuntimeState();
  return { tab, run: runtimeState.run };
});

const coordinatorContentReady = async ({ tabId, pageState } = {}) => coordinatorQueue(async () => {
  await loadRuntimeState();
  const run = getRunState();
  const record = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!run.runId || run.currentTabId !== tabId || !record || run.currentActionId !== record.actionId) return { ok: true, accepted: false, ignored: true };
  await pushRunEvent('content-ready', { tabId, pageState });
  const loginBlocked = record.lastResult?.status === 'login-blocked' || record.lastResult?.reason === 'requires-login';
  if (loginBlocked && pageState !== 'requires-login') {
    const refreshed = await refreshLoginBlockedAction(tabId, record);
    if (refreshed && refreshed.actionId !== record.actionId) {
      runtimeState.run.currentActionId = refreshed.actionId;
      runtimeState.run.currentTabId = tabId;
      runtimeState.run.lastError = null;
      await saveRuntimeState();
      await retryDeliverIfNeeded(tabId, { force: true, pageState }).catch((error) => setRunError(error, 'content-ready-refresh-deliver-failed'));
      return { ok: true, refreshed: true };
    }
  }
  if (!record.deliveredAt || record.lastDeliveryError) {
    const ack = await chrome.tabs.sendMessage(tabId, ExtensionProtocol.createMessage(ExtensionProtocol.MESSAGE_TYPES.RUN_ONE_CLICK, {
      action: record.action,
      actionId: record.actionId,
      workflowId: record.workflowId || null,
      runId: run.runId,
    })).catch((error) => ({ ok: false, error: error?.message || String(error) }));
    if (ack?.ok === true && ack?.accepted === true && ack?.actionId === record.actionId) {
      const next = { ...record, deliveredAt: Date.now(), deliveredCount: (record.deliveredCount || 0) + 1, lastDeliveryError: null };
      runtimeState.actionsByTabId[String(tabId)] = next;
      runtimeState.awaitingContentByTabId[String(tabId)] = next;
      await saveRuntimeState();
    } else {
      const next = {
        ...record,
        lastDeliveryError: ack?.error || 'missing-ack',
        lastDeliveryAttemptAt: Date.now(),
      };
      runtimeState.actionsByTabId[String(tabId)] = next;
      runtimeState.awaitingContentByTabId[String(tabId)] = next;
      runtimeState.run.lastError = next.lastDeliveryError;
      await saveRuntimeState();
    }
  }
  return { ok: true };
});

const coordinatorActionResult = async ({ tabId, result, source } = {}) => coordinatorQueue(async () => {
  await loadRuntimeState();
  await loadAutoState().catch(() => {});
  const run = getRunState();
  const record = getActionRecord(tabId) || getAwaitingRecord(tabId);
  const autoRun = run.source === 'auto' || Boolean(autoState?.enabled && autoState.activeRunDateKey && run.laDateKey === autoState.activeRunDateKey);
  const workflow = record?.workflowId ? getWorkflow(record.workflowId) : null;
  if ((!run.runId || run.currentTabId !== tabId || !record || run.currentActionId !== record.actionId) && record && result?.actionId === record.actionId) {
    runtimeState.run = {
      ...defaultRuntimeState().run,
      runId: run.runId || workflow?.workflowId || record.workflowId || record.actionId || `recovered-${tabId}`,
      laDateKey: run.laDateKey || getLosAngelesDateKey(new Date()),
      source: run.source || 'manual',
      stage: record.action === 'question' ? 'question' : 'checkin',
      status: 'running',
      transition: 'running',
      currentTabId: tabId,
      originActiveTabId: Number.isInteger(record.originActiveTabId) ? record.originActiveTabId : null,
      currentActionId: record.actionId,
      lease: { owner: 'coordinator', acquiredAt: Date.now() },
      attempt: Number.isInteger(run.attempt) ? run.attempt : 1,
      lastError: null,
      events: Array.isArray(run.events) ? run.events : [],
    };
    if (record.workflowId) runtimeState.activeWorkflowId = record.workflowId;
    await saveRuntimeState();
  }
  const activeRun = getRunState();
  if (!activeRun.runId || activeRun.currentTabId !== tabId || !record || activeRun.currentActionId !== record.actionId) return { ok: true, accepted: false, error: 'unknown-run' };
  if (result?.runId && result.runId !== activeRun.runId) return { ok: false, accepted: false, error: 'run-id-mismatch' };
  if (result?.action && result.action !== record.action) return { ok: false, accepted: false, error: 'workflow-stage-mismatch' };
  if (result?.actionId && result.actionId !== record.actionId) return { ok: false, accepted: false, error: 'action-id-mismatch' };
  if (record.status === 'completed' && isSuccessResult(record.lastResult) && isSuccessResult(result)) {
    return {
      ok: true,
      accepted: true,
      ignored: true,
      finalize: {
        kind: record.action === 'question' ? 'question-success' : 'checkin-success',
        tabId,
        actionId: record.actionId,
        runId: activeRun.runId,
        stage: record.action,
        workflowId: record.workflowId,
        createdByExtension: record.createdByExtension === true,
        reusedExistingTab: record.reusedExistingTab === true,
      },
    };
  }
  if (record.status === 'completed' && record.lastResult?.status === 'success' && result?.status !== 'success') return { ok: true, accepted: true, ignored: true };
  const success = isSuccessResult(result);
  const status = result?.status || 'failed';
  const reason = result?.reason || null;
  runtimeState.run.transition = 'finalizing';
  if (!success) runtimeState.run.lastError = reason || status;
  await pushRunEvent('action-result', { tabId, status, reason, action: result?.action, source });
  const retainedStatuses = new Set(['login-blocked', 'captcha-required', 'captcha-error', 'question-unmatched', 'answer-option-ambiguous', 'default-option-not-found']);
  const retainedReasons = new Set(['requires-login', 'captcha-required', 'captcha-error', 'question-unmatched', 'answer-option-ambiguous', 'default-option-not-found']);
  if (!success) {
    const nextRecord = {
      ...record,
      status: (status === 'login-blocked' || reason === 'requires-login' || retainedStatuses.has(status) || retainedReasons.has(reason)) ? 'pending' : 'failed',
      lastResult: { ...result, status, reason },
      lastDeliveryError: null,
      lastDeliveryAttemptAt: Date.now(),
    };
    runtimeState.actionsByTabId[String(tabId)] = nextRecord;
    if (runtimeState.awaitingContentByTabId[String(tabId)]) runtimeState.awaitingContentByTabId[String(tabId)] = { ...runtimeState.awaitingContentByTabId[String(tabId)], ...nextRecord };
    if (runtimeState.pendingActionsById[nextRecord.actionId]) runtimeState.pendingActionsById[nextRecord.actionId] = { ...runtimeState.pendingActionsById[nextRecord.actionId], ...nextRecord };
    await saveRuntimeState();
  }
  if (result?.action === 'checkin' && success) {
    runtimeState.actionsByTabId[String(tabId)] = { ...record, status: 'completed', lastResult: { ...result }, finalizationPending: true };
    runtimeState.run.stage = 'checkin';
    runtimeState.run.currentTabId = tabId;
    runtimeState.run.currentActionId = record.actionId;
    await markDailyTaskCompleted('checkin');
    await saveRuntimeState();
    const finalizationScheduled = await scheduleRuntimeFinalization({ ...record, tabId, status: 'completed', lastResult: { ...result }, finalizationPending: true }).catch(() => false);
    if (autoRun) {
      await loadAutoState();
      autoState.lastResult = createAutoResultDetails({ pending: record, status: 'completed', reason: null, phase: 'checkin', now: new Date(), retryable: false, willRetry: false, message: 'checkin 成功' });
      await saveAutoState();
    }
    return { ok: true, accepted: true, finalizationScheduled, finalize: { kind: 'checkin-success', tabId, actionId: record.actionId, runId: activeRun.runId, stage: 'checkin', workflowId: record.workflowId, createdByExtension: record.createdByExtension === true, reusedExistingTab: record.reusedExistingTab === true } };
  }
  if (success && result?.action === 'question') {
    runtimeState.actionsByTabId[String(tabId)] = { ...record, status: 'completed', lastResult: { ...result }, finalizationPending: true };
    runtimeState.run.status = 'running';
    await markDailyTaskCompleted('question');
    await saveRuntimeState();
    const finalizationScheduled = await scheduleRuntimeFinalization({ ...record, tabId, status: 'completed', lastResult: { ...result }, finalizationPending: true }).catch(() => false);
    if (autoRun) {
      await loadAutoState();
      autoState.lastRunStatus = 'completed';
      autoState.lastRunAt = Date.now();
      autoState.lastResult = createAutoResultDetails({ pending: record, status: 'completed', reason: null, phase: 'question', now: new Date(), retryable: false, willRetry: false, message: '今日已完成' });
      await saveAutoState();
    }
    return { ok: true, accepted: true, finalizationScheduled, finalize: { kind: 'question-success', tabId, actionId: record.actionId, runId: activeRun.runId, stage: 'question', workflowId: record.workflowId, createdByExtension: record.createdByExtension === true, reusedExistingTab: record.reusedExistingTab === true } };
  }
  if (['login-blocked', 'captcha-required', 'captcha-error', 'question-unmatched', 'answer-option-ambiguous', 'default-option-not-found'].includes(status) || ['requires-login', 'captcha-required', 'captcha-error', 'question-unmatched', 'answer-option-ambiguous', 'default-option-not-found'].includes(reason)) {
    runtimeState.run.status = 'running';
    runtimeState.run.lastError = reason || status;
    runtimeState.run.currentTabId = tabId;
    await saveRuntimeState();
    if (typeof chrome.tabs?.update === 'function') {
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
      chrome.tabs.get(tabId).then((t) => {
        if (t?.windowId && typeof chrome.windows?.update === 'function') {
          chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
      }).catch(() => {});
    }
    if (typeof chrome.action?.setBadgeText === 'function') {
      chrome.action.setBadgeText({ text: '!' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }).catch(() => {});
    }
    const alertMsg = (reason === 'requires-login' || status === 'login-blocked')
      ? '一亩三分地账号需要登录，已为您打开页面'
      : (reason === 'captcha-required' || reason === 'captcha-error' || status === 'captcha-required')
        ? '一亩三分地每日任务遇到验证码，请手动完成'
        : '一亩三分地每日任务需要人工处理，已为您打开页面';
    await showCoordinatorNotification(alertMsg);
    if (autoRun) {
      await loadAutoState();
      const failure = { ...result, status, reason };
      if (status === 'login-blocked' || reason === 'requires-login') {
        await pauseAutoRunForLogin({ pending: record, result: failure, now: new Date() });
      } else {
        const classification = classifyAutoFailure(failure, record);
        if (classification.retryable) {
          const currentCount = Number.isInteger(autoState?.retry?.count) ? autoState.retry.count : 0;
          if (currentCount < AUTO_RECOVERY_RETRY_LIMIT) {
            await scheduleSameDayAutoRetry({ pending: record, result: failure, now: new Date() });
          } else {
            await finalizeAutoRunFailure({ pending: record, result: failure, now: new Date() });
          }
        } else {
          await finalizeAutoRunFailure({ pending: record, result: failure, now: new Date() });
        }
      }
    }
    return { ok: true, accepted: true, retained: true };
  }
  runtimeState.run.lastError = reason || status;
  await saveRuntimeState();
  if (autoRun) {
    await loadAutoState();
    const failure = { ...result, status, reason };
    const classification = classifyAutoFailure(failure, record);
    if (classification.retryable) {
      const currentCount = Number.isInteger(autoState?.retry?.count) ? autoState.retry.count : 0;
      if (currentCount < AUTO_RECOVERY_RETRY_LIMIT) {
        await scheduleSameDayAutoRetry({ pending: record, result: failure, now: new Date() });
      } else {
        await finalizeAutoRunFailure({ pending: record, result: failure, now: new Date() });
      }
    } else if (classification.pause === 'login') {
      await pauseAutoRunForLogin({ pending: record, result: failure, now: new Date() });
    } else {
      await finalizeAutoRunFailure({ pending: record, result: failure, now: new Date() });
    }
  }
  return { ok: true, accepted: true };
});

const coordinatorFinalize = async (finalize = null) => coordinatorQueue(async () => {
  await loadRuntimeState();
  await loadAutoState().catch(() => {});
  if (!finalize?.kind) return { ok: true, skipped: true };
  const run = getRunState();
  const isAutoRun = run.source === 'auto' || Boolean(autoState?.enabled && autoState.activeRunDateKey && run.laDateKey === autoState.activeRunDateKey);
  if (!run.runId || finalize.runId && finalize.runId !== run.runId) return { ok: true, ignored: true };
  if (finalize.actionId && run.currentActionId !== finalize.actionId) return { ok: true, ignored: true };
  if (finalize.kind === 'checkin-success') {
    if (run.currentTabId !== finalize.tabId || run.stage !== 'checkin') return { ok: true, ignored: true };
    try {
      const pending = { ...runtimeState.actionsByTabId[String(finalize.tabId)], tabId: finalize.tabId, workflowId: finalize.workflowId, actionId: finalize.actionId, action: 'checkin', status: 'completed', lastResult: { action: 'checkin', status: 'success' } };
      if (finalize.workflowId) {
        const finalized = await finalizeCompletedSuccess(pending);
        if (finalized) return { ok: true, completed: true };
      } else {
        const inheritedFinalizationError = typeof pending.finalizationError === 'string' && pending.finalizationError ? pending.finalizationError : null;
        await updateFinalizationDiagnostics(pending.tabId, pending, {
          finalizationError: inheritedFinalizationError,
          finalizationAttemptAt: Date.now(),
        }).catch(() => {});
        const closed = await closeActionTabSafely(pending.tabId, pending);
        const missing = pending.createdByExtension === true ? await isTabAlreadyGone(pending.tabId) : false;
        const completed = closed || missing;
        if (completed) {
          if (!isAutoRun) {
            await clearActionArtifactsIfFinalized(pending.tabId, pending);
          }
          try {
            await pushRunEvent('question-tab-opening', {
              from: 'coordinatorFinalize',
              tabId: pending.tabId,
              actionId: pending.actionId,
              reason: 'completed-checkin-advances-to-question',
              at: Date.now(),
            });
            const originActiveTabId = await captureOriginActiveTabId();
            const questionUrl = actionPage('question');
            // Re-check the single controlled tab invariant after the close
            // transition. Another CONTENT_READY/recovery event may already
            // have created the question page while this worker was yielding.
            const existingQuestionTab = await findExistingTaskTab(questionUrl);
            const questionTab = existingQuestionTab || (typeof chrome.tabs?.create === 'function'
              ? await chrome.tabs.create({ url: questionUrl, active: false })
              : null);
            if (!questionTab) throw new Error('tabs-create-unavailable');
            const questionActionId = crypto.randomUUID();
            await createCoordinatorActionRecord({
              tabId: questionTab.id,
              action: 'question',
              actionId: questionActionId,
              workflowId: null,
              createdByExtension: true,
              reusedExistingTab: Boolean(existingQuestionTab),
              originActiveTabId,
              finalizationError: inheritedFinalizationError,
            });
            runtimeState.run.stage = 'question';
            runtimeState.run.transition = 'question';
            runtimeState.run.currentTabId = questionTab.id;
            runtimeState.run.currentActionId = questionActionId;
            await saveRuntimeState();
            try {
              await retryDeliverIfNeeded(questionTab.id, { force: true });
            } catch (error) {
              const message = error?.message || String(error) || 'question-delivery-failed';
              runtimeState.run.lastError = message;
              await pushRunEvent('question-delivery-failed', {
                from: 'coordinatorFinalize',
                tabId: questionTab.id,
                actionId: questionActionId,
                error: message,
                at: Date.now(),
              }).catch(() => {});
              await saveRuntimeState().catch(() => {});
            }
            await pushRunEvent('question-tab-created', {
              tabId: questionTab.id,
              actionId: questionActionId,
              originActiveTabId,
              active: false,
            }).catch(() => {});
            await updateFinalizationDiagnostics(questionTab.id, { action: 'question', actionId: questionActionId, workflowId: null, tabId: questionTab.id }, { finalizationError: inheritedFinalizationError }).catch(() => {});
            return { ok: true, completed: true };
          } catch (error) {
            const message = error?.message || String(error) || 'question-tab-create-failed';
            await pushRunEvent('question-tab-create-failed', {
              from: 'coordinatorFinalize',
              tabId: pending.tabId,
              actionId: pending.actionId,
              error: message,
              at: Date.now(),
            }).catch(() => {});
            await setRunError(message, 'coordinator-finalize-question-create-failed').catch(() => {});
            if (isAutoRun) {
              await loadAutoState();
              await scheduleSameDayAutoRetry({
                pending: { ...pending, action: 'question' },
                result: { status: 'failed', reason: 'question-tab-start-failed', error: message },
                now: new Date(),
              });
              runtimeState.run.status = 'running';
              runtimeState.run.stage = 'question';
              runtimeState.run.transition = 'question';
              runtimeState.run.currentTabId = null;
              runtimeState.run.currentActionId = null;
              runtimeState.run.lastError = message;
              await saveRuntimeState().catch(() => {});
              return { ok: true, retained: true, retryScheduled: true };
            }
            runtimeState.run.status = 'paused';
            runtimeState.run.stage = 'question';
            runtimeState.run.transition = 'question';
            runtimeState.run.currentTabId = null;
            runtimeState.run.currentActionId = null;
            runtimeState.run.lastError = message;
            await saveRuntimeState().catch(() => {});
            return { ok: true, paused: true, reason: 'question-tab-create-failed' };
          }
        }
        if (pending.createdByExtension === true) {
          const recovered = await promoteOrCreateQuestionTabAfterCloseFailure(pending, inheritedFinalizationError);
          if (recovered.ok) {
            const nextActionId = crypto.randomUUID();
            await createCoordinatorActionRecord({
              tabId: recovered.tabId,
              action: 'question',
              actionId: nextActionId,
              workflowId: null,
              createdByExtension: true,
              reusedExistingTab: false,
              originActiveTabId: pending.originActiveTabId ?? runtimeState.run.originActiveTabId ?? null,
              finalizationError: inheritedFinalizationError,
            });
            runtimeState.run.stage = 'question';
            runtimeState.run.transition = 'question';
            runtimeState.run.currentTabId = recovered.tabId;
            runtimeState.run.currentActionId = nextActionId;
            await saveRuntimeState();
            await retryDeliverIfNeeded(recovered.tabId, { force: true }).catch(() => {});
            return { ok: true, completed: true };
          }
        }
        // A successful check-in must always advance the one-click run. A
        // reused/active tab can legitimately refuse to close (or the browser
        // can report a transient remove failure); in that case keep the
        // existing tab and create a separate question tab instead of pausing
        // the run at the completed check-in page.
        const recovered = await recoverCompletedCheckinToQuestion(pending, {
          isAutoRun,
          source: 'coordinatorFinalize-close-failed',
        });
        if (recovered) return { ok: true, completed: true, transitionPending: true };
      }
    } catch (error) {
      await setRunError(error, 'checkin-finalize-failed');
    }
    if (run.stage === 'checkin') {
      await persistQuestionRunFailureState({ error: run.lastError ? new Error(run.lastError) : null, status: 'paused', transition: 'question' });
    }
    runtimeState.run.status = 'paused';
    await saveRuntimeState();
    return { ok: true, retained: true };
  }
  if (finalize.kind === 'question-success') {
    if (run.currentTabId !== finalize.tabId || run.stage !== 'question') return { ok: true, ignored: true };
    const pending = { ...runtimeState.actionsByTabId[String(finalize.tabId)], tabId: finalize.tabId, workflowId: finalize.workflowId, actionId: finalize.actionId, action: 'question', status: 'completed', lastResult: { action: 'question', status: 'success' } };
    const closed = await closeActionTabSafely(finalize.tabId, pending);
    const current = await chrome.tabs.get(finalize.tabId).catch(() => null);
    const closeSkippedReason = runtimeState.actionsByTabId[String(finalize.tabId)]?.closeSkippedReason || runtimeState.awaitingContentByTabId[String(finalize.tabId)]?.closeSkippedReason || null;
    const retainReasons = new Set(['active-tab', 'origin-active-tab', 'origin-restore-failed']);
    if (!closed && current?.id && retainReasons.has(closeSkippedReason)) {
      runtimeState.run.status = 'paused';
      await saveRuntimeState();
      return { ok: true, retained: true };
    }
    if (closed || !current) {
      if (isAutoRun) {
        await completeAutoRun({ status: 'completed', now: new Date() });
      }
      await clearLegacyTaskState();
      runtimeState.run = { ...defaultRuntimeState().run, status: 'idle', events: run.events };
      await saveRuntimeState();
      if (typeof chrome.action?.setBadgeText === 'function') {
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
      }
      await showCoordinatorNotification('签到和答题完成');
      return { ok: true, completed: true };
    }
    runtimeState.run.status = 'paused';
    runtimeState.run.lastError = closeSkippedReason || runtimeState.run.lastError || 'question-finalization-retained';
    await saveRuntimeState();
    return { ok: true, retained: true };
  }
  return { ok: true, skipped: true };
});

const recoverRemovedCompletedCheckin = async (tabId) => {
  if (!Number.isInteger(tabId)) return false;
  await loadRuntimeState();
  const run = getRunState();
  const record = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (
    !run.runId
    || run.currentTabId !== tabId
    || !record
    || record.action !== 'checkin'
    || record.status !== 'completed'
    || record.finalizationPending !== true
    || !isSuccessResult(record.lastResult)
    || run.currentActionId !== record.actionId
  ) return false;
  const result = await coordinatorFinalize({
    kind: 'checkin-success',
    tabId,
    actionId: record.actionId,
    runId: run.runId,
    stage: 'checkin',
    workflowId: record.workflowId,
    createdByExtension: record.createdByExtension === true,
    reusedExistingTab: record.reusedExistingTab === true,
  });
  return result?.completed === true || result?.transitionPending === true;
};

const reconcileCoordinator = async ({ now = new Date(), source = 'startup' } = {}) => coordinatorQueue(async () => {
  await loadRuntimeState();
  await loadAutoState().catch(() => {});
  const originActiveTabId = await captureOriginActiveTabId();
  const run = getRunState();
  const todayKey = getLosAngelesDateKey(now);
  if (!run.runId && autoState?.enabled && autoState.activeRunDateKey === todayKey && autoState.lastRunStatus === 'started') {
    const recovered = await recoverAutoCurrentRun({ now, originActiveTabId }).catch((error) => {
      setRunError(error, 'auto-recover-startup-failed');
      return { ok: false, error };
    });
    if (recovered?.ok) {
      return { ok: true, run: runtimeState.run, source, recovered: true };
    }
  }
  const sameDay = run.runId && run.laDateKey === todayKey;
  const currentTabId = Number.isInteger(run.currentTabId) ? run.currentTabId : null;
  if (run.runId && run.laDateKey !== todayKey) {
    runtimeState.run = {
      ...defaultRuntimeState().run,
      runId: null,
      laDateKey: null,
      source: null,
      stage: null,
      status: 'idle',
      transition: null,
      lease: null,
      attempt: 0,
      currentTabId: null,
      originActiveTabId: null,
      currentActionId: null,
      lastError: null,
      events: run.events,
    };
    await saveRuntimeState();
  }
  await cleanupNonActiveDailyTabs(sameDay ? currentTabId : null);
  if (!sameDay) return { ok: true, run: runtimeState.run, source };
  const current = currentTabId != null ? await chrome.tabs.get(currentTabId).catch(() => null) : null;
  const record = currentTabId != null ? getActionRecord(currentTabId) || getAwaitingRecord(currentTabId) : null;
  if (record?.status === 'completed' && record.finalizationPending && isSuccessResult(record.lastResult) && run.currentActionId === record.actionId && (current?.id || record.action === 'question' || record.action === 'checkin')) {
    const finalized = await recoverCompletedActionFinalization(record, { now }).catch((error) => {
      setRunError(error, 'reconcile-finalize-failed');
      return false;
    });
    if (!finalized) {
      runtimeState.run.status = 'paused';
      runtimeState.run.lastError = runtimeState.run.lastError || runtimeState.actionsByTabId[String(currentTabId)]?.finalizationError || 'finalization-failed';
      await saveRuntimeState();
    }
    return { ok: true, run: runtimeState.run, source };
  }
  if (current?.id && record && run.currentActionId === record.actionId) {
    await retryDeliverIfNeeded(currentTabId, { force: true }).catch((error) => setRunError(error, 'reconcile-deliver-failed'));
    return { ok: true, run: runtimeState.run, source };
  }
  const page = actionPage(run.stage || 'checkin');
  const reusable = await findExistingTaskTab(page);
  if (reusable?.id != null) {
    const actionId = run.currentActionId || crypto.randomUUID();
    runtimeState.run.stage = run.stage || 'checkin';
    runtimeState.run.transition = 'reconcile';
    runtimeState.run.currentTabId = reusable.id;
    runtimeState.run.currentActionId = actionId;
    if (Number.isInteger(originActiveTabId) && !Number.isInteger(runtimeState.run.originActiveTabId)) runtimeState.run.originActiveTabId = originActiveTabId;
    await saveRuntimeState();
    if (!getActionRecord(reusable.id) && !getAwaitingRecord(reusable.id)) {
      await createCoordinatorActionRecord({ tabId: reusable.id, action: runtimeState.run.stage, actionId, createdByExtension: false, reusedExistingTab: true, originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId });
    }
    return { ok: true, run: runtimeState.run, source };
  }
  const actionId = run.currentActionId || crypto.randomUUID();
  runtimeState.run.stage = run.stage || 'checkin';
  runtimeState.run.transition = 'opening';
  runtimeState.run.currentTabId = null;
  runtimeState.run.currentActionId = actionId;
  if (Number.isInteger(originActiveTabId) && !Number.isInteger(runtimeState.run.originActiveTabId)) runtimeState.run.originActiveTabId = originActiveTabId;
  await saveRuntimeState();
  const tab = await chrome.tabs.create({ url: page, active: false });
  await createCoordinatorActionRecord({ tabId: tab.id, action: runtimeState.run.stage, actionId, createdByExtension: true, reusedExistingTab: false, originActiveTabId: runtimeState.run.originActiveTabId ?? originActiveTabId });
  return { ok: true, tab, run: runtimeState.run, source };
});

const startEverythingWorkflow = async ({ manual = false } = {}) => {
  if (startEverythingPromise) return startEverythingPromise;
  startEverythingPromise = (async () => {
    // Legacy entrypoints must route through the current coordinator so that
    // only daily-run-v2 owns tab creation / switching. Historical workflow
    // records are diagnostic-only and must not reopen tabs here.
    return coordinatorStart({ action: 'everything', source: manual ? 'manual' : 'runtime', manual });
  })().finally(() => { startEverythingPromise = null; });
  return startEverythingPromise;
};

const startAutoEverythingWorkflow = async ({ now = new Date(), random = Math.random } = {}) => {
  if (startAutoEverythingPromise) return startAutoEverythingPromise;
  startAutoEverythingPromise = (async () => {
    await consumeAutoPlanForToday({ now });
    try {
      return await startEverythingWorkflow();
    } catch (error) {
      const currentCount = Number.isInteger(autoState?.retry?.count) ? autoState.retry.count : 0;
      if (currentCount < AUTO_RECOVERY_RETRY_LIMIT) {
        await scheduleSameDayAutoRetry({ pending: { action: 'start' }, result: { status: 'start-failed', reason: 'start-failed' }, now });
      } else {
        await finalizeAutoRunFailure({ pending: { action: 'start' }, result: { status: 'start-failed', reason: 'start-failed' }, now, random });
      }
      throw error;
    }
  })().finally(() => { startAutoEverythingPromise = null; });
  return startAutoEverythingPromise;
};

const reconcileRuntimeState = async ({ now = new Date() } = {}) => {
  // Legacy callers must use the single current-run recovery path. Historical
  // action records are diagnostic data only and must never reopen tabs.
  return reconcileCoordinator({ now, source: 'legacy-recovery' });
};

const reconcileAutoRuntime = async ({ now = new Date(), random = Math.random, force = false, fromAlarm = false } = {}) => {
  await loadAutoState();
  if (!autoState.enabled) return autoState;
  const alarmInspection = fromAlarm ? { exists: true, matches: true } : await inspectAutoAlarm();
  if (!autoState.plan || autoState.alarmFailedAt || force || (!fromAlarm && (!alarmInspection.exists || !alarmInspection.matches))) {
    await resyncAutoSchedule({ now, random, force: true });
  }
  return autoState;
};

function loadBank() {
  if (!bankPromise) bankPromise = fetch(chrome.runtime.getURL('data/answer-bank.json')).then((r) => { if (!r.ok) throw new Error(`题库读取失败（${r.status}）`); return r.json(); }).catch((e) => { bankPromise = null; throw e; });
  return bankPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !ExtensionProtocol.isKnownType(message.type)) return false;

  switch (message.type) {
    case ExtensionProtocol.MESSAGE_TYPES.RUN_ONE_CLICK: {
      if (!['question', 'checkin', 'everything'].includes(message.payload?.action)) { sendResponse({ ok: false, error: 'unknown-action' }); return false; }
      const opening = coordinatorStart({ action: message.payload.action, source: message.payload.action === 'everything' ? 'manual' : 'manual', manual: true });
      opening.then((result) => { const tab = result.tab || result; sendResponse({ ok: true, payload: { tabId: tab.id, runId: result.run?.runId || null } }); }).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.GET_RUNTIME_STATE: {
      loadRuntimeState().then(() => {
        sendResponse({ ok: true, payload: runtimeState });
      }).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.FOCUS_TASK_TAB: {
      const tabId = message.payload?.tabId || runtimeState?.run?.currentTabId;
      if (Number.isInteger(tabId)) {
        chrome.tabs?.get(tabId).then((tab) => {
          chrome.tabs?.update(tabId, { active: true }).catch(() => {});
          if (Number.isInteger(tab?.windowId) && typeof chrome.windows?.update === 'function') {
            chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          }
          sendResponse({ ok: true, payload: { tabId } });
        }).catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      sendResponse({ ok: false, error: 'no-tab-id' });
      return false;
    }
    case ExtensionProtocol.MESSAGE_TYPES.AUTO_SCHEDULE_GET:
    case ExtensionProtocol.MESSAGE_TYPES.AUTO_SCHEDULE_STATE: {
      (async () => {
        await loadAutoState();
        await ensurePersistedAutoAlarm();
        sendResponse({ ok: true, payload: await getAutoStatePayload() });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.AUTO_SCHEDULE_ENABLE: {
      (async () => {
        await enableAutoSchedule();
        await loadAutoState();
        sendResponse({ ok: true, payload: await getAutoStatePayload() });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.AUTO_SCHEDULE_DISABLE: {
      (async () => {
        await disableAutoSchedule();
        await loadAutoState();
        sendResponse({ ok: true, payload: await getAutoStatePayload() });
      })().catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.CONTENT_READY: {
      const tabId = sender.tab?.id;
      const pageState = typeof message.payload?.pageState === 'string' ? message.payload.pageState : null;
      const pageKind = typeof message.payload?.pageKind === 'string' ? message.payload.pageKind : null;
      coordinatorContentReady({ tabId, pageState }).then(async (readyReply) => {
        let reply = readyReply;
        const observedAction = pageKind === 'daily-question'
          ? 'question'
          : pageKind === 'daily-checkin'
            ? 'checkin'
            : null;
        // A workflow may be waiting for the user to finish a captcha or a
        // manually selected answer. Once the site itself renders a completed
        // state, promote only that managed action to success so its task tab
        // follows the same close path as an automatic submission.
        if (pageState === 'completed' && observedAction) {
          reply = await coordinatorActionResult({
            tabId,
            result: { action: observedAction, status: 'success', reason: 'observed-completed' },
            source: 'content-ready-observed-completed',
          });
        }
        sendResponse(reply || { ok: true });
        if (reply?.accepted === true && reply?.finalize) {
          coordinatorFinalize(reply.finalize).catch((e) => setRunError(e, 'content-ready-finalize-failed'));
        }
      }).catch((e) => sendResponse({ ok: false, accepted: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.ACTION_RESULT: {
      const tabId = sender.tab?.id;
      const result = message.payload || {};
      coordinatorActionResult({ tabId, result, source: sender?.id ? 'content-script' : 'runtime' }).then((reply) => {
        sendResponse(reply);
        if (reply?.accepted === true && reply?.finalize) {
          coordinatorFinalize(reply.finalize).catch((e) => setRunError(e, 'coordinator-finalize-failed'));
        }
      }).catch((e) => sendResponse({ ok: false, accepted: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.LOOKUP_QUESTION:
      Promise.all([loadBank(), chrome.storage.local.get(LearnedAnswers.STORAGE_KEY)]).then(([bank, stored]) => { const question = message.payload?.question; const options = message.payload?.options; const records = LearnedAnswers.normalizeRecords(stored[LearnedAnswers.STORAGE_KEY]); const entries = LearnedAnswers.toMatcherEntries(records, bank.entries, question, options); const result = QuestionMatcher.lookup(question, options, entries); sendResponse({ ok: true, payload: { ...result, ...(result.status === 'matched' ? { source: entries[0]?.source || 'public' } : {}) } }); }).catch((e) => sendResponse({ ok: false, error: e.message, payload: { status: 'unmatched', reason: 'lookup-error' } }));
      return true;
    case ExtensionProtocol.MESSAGE_TYPES.QUESTION_STATE:
      sendResponse({ ok: true, type: message.type, payload: message.payload ?? {} });
      return false;
    case ExtensionProtocol.MESSAGE_TYPES.SAVE_LEARNED_ANSWER: {
      const result = LearnedAnswers.upsert([], message.payload);
      if (!result.ok) { sendResponse({ ok: false, error: result.reason }); return false; }
      chrome.storage.local.get(LearnedAnswers.STORAGE_KEY).then((stored) => { const saved = LearnedAnswers.upsert(stored[LearnedAnswers.STORAGE_KEY], result.record); if (!saved.ok) throw new Error(saved.reason); return chrome.storage.local.set({ [LearnedAnswers.STORAGE_KEY]: saved.records }).then(() => sendResponse({ ok: true, payload: { saved: saved.record } })); }).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    default:
      return false;
  }
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && changeInfo.url == null) return;
  const page = tab?.url || changeInfo.url;
  if (!isTargetUrl(page, ExtensionProtocol.PAGE_URLS.dailyQuestion) && !isTargetUrl(page, ExtensionProtocol.PAGE_URLS.dailyCheckin)) return;
  coordinatorContentReady({ tabId, pageState: 'updated' }).catch((error) => setRunError(error, 'updated-content-ready-failed'));
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  recoverRemovedCompletedCheckin(tabId).catch((error) => setRunError(error, 'removed-checkin-transition-failed'));
});

chrome.runtime?.onStartup?.addListener(() => (async () => {
  try {
    await reconcileCoordinator({ source: 'startup' });
    await reconcileAutoRuntime({ source: 'startup' });
  } catch (error) {
    await setRunError(error, 'startup-failed');
    await loadAutoState().catch(() => {});
    if (autoState) {
      autoState.lastError = error?.message || String(error);
      await saveAutoState().catch(() => {});
    }
  }
})());

chrome.runtime?.onInstalled?.addListener(() => {
  (async () => {
    try {
      await reconcileCoordinator({ source: 'installed' });
      await reconcileAutoRuntime({ source: 'installed' });
    } catch (error) {
      await setRunError(error, 'installed-failed');
      await loadAutoState().catch(() => {});
      if (autoState) {
        autoState.lastError = error?.message || String(error);
        await saveAutoState().catch(() => {});
      }
    }
  })().catch((e) => setRunError(e, 'installed-failed'));
});

chrome.storage?.onChanged?.addListener(() => {});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (typeof alarm?.name === 'string' && alarm.name.startsWith(RUNTIME_FINALIZE_ALARM_PREFIX)) {
    coordinatorQueue(async () => {
      await loadRuntimeState();
      const actionId = alarm.name.slice(RUNTIME_FINALIZE_ALARM_PREFIX.length);
      const run = getRunState();
      const record = Number.isInteger(run.currentTabId) && run.currentActionId === actionId
        ? getActionRecord(run.currentTabId) || getAwaitingRecord(run.currentTabId)
        : null;
      if (!record || record.status !== 'completed' || !record.finalizationPending || !isSuccessResult(record.lastResult)) return;
      await recoverCompletedActionFinalization(record, { now: new Date() }).catch((error) => setRunError(error, 'runtime-finalize-failed'));
    }).catch((error) => setRunError(error, 'runtime-finalize-failed'));
  }
});
(function (global) {
  const els = {
    alertBanner: document.getElementById('alert-banner'),
    alertTitle: document.getElementById('alert-title'),
    alertDesc: document.getElementById('alert-desc'),
    alertActionBtn: document.getElementById('alert-action-btn'),
    runEverything: document.getElementById('run-everything'),
    runCheckin: document.getElementById('run-checkin'),
    runQuestion: document.getElementById('run-question'),
    overallStatusBadge: document.getElementById('overall-status-badge'),
    checkinTaskStatus: document.getElementById('checkin-task-status'),
    questionTaskStatus: document.getElementById('question-task-status'),
    statusMessage: document.getElementById('status-message'),
  };

  const state = {
    loading: false,
    pendingAction: false,
    runtime: null,
    blockedTabId: null,
  };

  const BLOCKED_REASONS = {
    'requires-login': { title: '需要登录', desc: '一亩三分地账号未登录，请前往网页登录' },
    'login-blocked': { title: '需要登录', desc: '一亩三分地账号未登录，请前往网页登录' },
    'captcha-required': { title: '遇到验证码', desc: '页面出现人机验证，请前往手动完成验证' },
    'captcha-error': { title: '验证码异常', desc: '验证码未能自动通过，请前往手动完成' },
    'question-unmatched': { title: '题目未收录', desc: '当前题目未在题库中，请手动选择答案' },
    'answer-option-ambiguous': { title: '答案多候选', desc: '存在多个可能答案，请手动确认' },
    'default-option-not-found': { title: '未找到签到选项', desc: '未识别到默认心情选项，请手动签到' },
  };

  const setStatus = (message) => {
    if (els.statusMessage) {
      els.statusMessage.textContent = message || '点击上方按钮一键自动完成今日任务';
    }
  };

  const sendRuntimeMessage = (type, payload = {}) => new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      return reject(new Error('runtime-unavailable'));
    }
    chrome.runtime.sendMessage(
      ExtensionProtocol.createMessage(type, payload),
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message || '通信失败'));
        if (response && response.ok === false) return reject(new Error(response.error || '请求失败'));
        resolve(response?.payload || response || {});
      },
    );
  });

  const getBlockedInfo = (runtimeState) => {
    const run = runtimeState?.run || {};
    const lastError = run.lastError || '';
    const tabId = run.currentTabId;
    if (BLOCKED_REASONS[lastError]) {
      return { ...BLOCKED_REASONS[lastError], tabId };
    }
    const actions = Object.values(runtimeState?.actionsByTabId || {});
    for (const record of actions) {
      const reason = record.lastResult?.reason || record.lastResult?.status || '';
      if (BLOCKED_REASONS[reason]) {
        return { ...BLOCKED_REASONS[reason], tabId: record.tabId || tabId };
      }
    }
    return null;
  };

  const render = (runtimeState = {}) => {
    state.runtime = runtimeState;
    const run = runtimeState.run || {};
    const actions = Object.values(runtimeState.actionsByTabId || {});
    const dailyStatus = runtimeState.dailyStatus || {};

    const checkinRecord = actions.find((a) => a.action === 'checkin');
    const questionRecord = actions.find((a) => a.action === 'question');

    const isCheckinDone = Boolean(dailyStatus.checkin?.completed || checkinRecord?.status === 'completed');
    const isQuestionDone = Boolean(dailyStatus.question?.completed || questionRecord?.status === 'completed');

    // 1. 检查任务受阻情况
    const blockedInfo = getBlockedInfo(runtimeState);
    if (blockedInfo && els.alertBanner) {
      state.blockedTabId = blockedInfo.tabId;
      els.alertTitle.textContent = blockedInfo.title;
      els.alertDesc.textContent = blockedInfo.desc;
      els.alertBanner.hidden = false;
    } else if (els.alertBanner) {
      state.blockedTabId = null;
      els.alertBanner.hidden = true;
    }

    // 2. 渲染各任务状态
    const isRunning = run.status === 'running' || state.pendingAction;

    const renderTaskBadge = (node, isDone, record, isCurrentStage) => {
      if (!node) return;
      node.className = 'task-badge';
      if (isDone) {
        node.classList.add('badge-done');
        node.textContent = '已完成';
      } else if (isRunning && isCurrentStage) {
        node.classList.add('badge-running');
        node.textContent = '执行中';
      } else if (record?.status === 'failed' || (isCurrentStage && blockedInfo)) {
        node.classList.add('badge-error');
        node.textContent = '需处理';
      } else {
        node.classList.add('badge-pending');
        node.textContent = '待完成';
      }
    };

    renderTaskBadge(els.checkinTaskStatus, isCheckinDone, checkinRecord, run.stage === 'checkin');
    renderTaskBadge(els.questionTaskStatus, isQuestionDone, questionRecord, run.stage === 'question');

    // 3. 总体状态 Badge 与引导文案
    if (els.overallStatusBadge) {
      els.overallStatusBadge.className = 'badge';
      if (isCheckinDone && isQuestionDone) {
        els.overallStatusBadge.classList.add('badge-done');
        els.overallStatusBadge.textContent = '已全部完成';
        if (!state.pendingAction) {
          setStatus('今日签到与答题已全部搞定 🎉');
        }
      } else if (isRunning) {
        els.overallStatusBadge.classList.add('badge-running');
        els.overallStatusBadge.textContent = '执行中…';
      } else if (blockedInfo) {
        els.overallStatusBadge.classList.add('badge-error');
        els.overallStatusBadge.textContent = '需人工处理';
      } else if (isCheckinDone || isQuestionDone) {
        els.overallStatusBadge.classList.add('badge-done');
        els.overallStatusBadge.textContent = isCheckinDone ? '签到已完成' : '答题已完成';
      } else {
        els.overallStatusBadge.textContent = '就绪';
      }
    }

    // 4. 按钮状态同步
    const disabled = state.pendingAction || run.status === 'running';
    if (els.runEverything) els.runEverything.disabled = disabled;
    if (els.runCheckin) els.runCheckin.disabled = disabled;
    if (els.runQuestion) els.runQuestion.disabled = disabled;
  };

  const focusTaskTab = async () => {
    const tabId = state.blockedTabId || state.runtime?.run?.currentTabId;
    if (!Number.isInteger(tabId)) {
      setStatus('未找到对应任务标签页');
      return;
    }
    try {
      if (chrome?.tabs?.update) {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.windowId && chrome?.windows?.update) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        window.close();
      } else {
        await sendRuntimeMessage(ExtensionProtocol.MESSAGE_TYPES.FOCUS_TASK_TAB, { tabId });
        window.close();
      }
    } catch (e) {
      setStatus(`跳转标签页失败: ${e.message}`);
    }
  };

  const runAction = async (action) => {
    if (state.pendingAction) return;
    state.pendingAction = true;
    const labelMap = { everything: '一键签到 & 答题', checkin: '签到', question: '答题' };
    const label = labelMap[action] || action;
    setStatus(`正在启动${label}…`);
    render(state.runtime || {});

    try {
      const response = await sendRuntimeMessage(ExtensionProtocol.MESSAGE_TYPES.RUN_ONE_CLICK, { action });
      setStatus(`已触发${label}，后台执行中…`);
      // 成功触发后关闭弹窗，让后台静默执行
      if (response && (response.ok !== false)) {
        setTimeout(() => { window.close(); }, 300);
      }
    } catch (error) {
      setStatus(`启动失败: ${error.message}`);
    } finally {
      state.pendingAction = false;
      render(state.runtime || {});
    }
  };

  const refreshState = async () => {
    if (state.loading) return;
    state.loading = true;
    try {
      const runtimeState = await sendRuntimeMessage(ExtensionProtocol.MESSAGE_TYPES.GET_RUNTIME_STATE);
      render(runtimeState);
    } catch {
      try {
        const stored = await chrome?.storage?.local?.get?.(['p3a-daily-status-v1', 'p3a-runtime-v1']);
        render({
          ...(stored?.['p3a-runtime-v1'] || {}),
          dailyStatus: stored?.['p3a-daily-status-v1'] || {},
        });
      } catch {
        render({});
      }
    } finally {
      state.loading = false;
    }
  };

  els.runEverything?.addEventListener('click', () => runAction('everything'));
  els.runCheckin?.addEventListener('click', () => runAction('checkin'));
  els.runQuestion?.addEventListener('click', () => runAction('question'));
  els.alertActionBtn?.addEventListener('click', focusTaskTab);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  global.__popup = { render, getBlockedInfo, runAction, focusTaskTab, refreshState, BLOCKED_REASONS };

  render({});
  refreshState();
})(globalThis);

