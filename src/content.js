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
const REMOTE_ACTION_TIMEOUT_MS = 8000;
const QUESTION_READY_TIMEOUT_MS = 3000;
const REMOTE_ACTION_RETRY_MS = 200;
let activeRemoteActionId = null;
const REMOTE_RESULT_TIMEOUT_MS = 12000;
const REMOTE_RESULT_REPORT_MAX_RETRIES = 5;
const REMOTE_RESULT_REPORT_DELAY_MS = 200;
const QUESTION_SUBMIT_WAIT_MS = 4000;
const QUESTION_SUBMIT_POLL_MS = 100;
const CHECKIN_SUBMIT_WAIT_MS = 2000;
const CHECKIN_SUBMIT_POLL_MS = 100;
let questionStatusNode = null;
let checkinStatusNode = null;
const cleanTextValue = (value) => String(value?.textContent ?? value ?? '').replace(/\s+/g, ' ').trim();
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
const reportRemoteResult = async (actionId, action, status, reason) => {
  if (!actionId) return false;
  const result = remoteActionResults.get(actionId);
  if (result?.delivered === true) return true;
  if (reportingRemoteActions.has(actionId)) return false;
  reportingRemoteActions.add(actionId);
  try {
    for (let attempt = 1; attempt <= REMOTE_RESULT_REPORT_MAX_RETRIES; attempt += 1) {
      try {
        const response = await bridge.send(ExtensionProtocol.MESSAGE_TYPES.ACTION_RESULT, { actionId, action, status, reason });
        if (response?.ok === true) {
          if (remoteActionResults.has(actionId)) {
            remoteActionResults.set(actionId, { action, status, reason, delivered: true });
          }
          return true;
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
  remoteActionResults.set(actionId, { action, status, reason, delivered: false });
  remoteActionTimers.delete(actionId);
  pendingRemoteActions.delete(actionId);
  if (activeRemoteActionId === actionId) activeRemoteActionId = null;
  if (status === 'success') showCheckinToast(toastMessage);
  remoteActionToastMessages.delete(actionId);
  reportRemoteResult(actionId, action, status, reason).catch(() => {});
};
const waitForRemoteResult = (action, actionId, status) => new Promise((resolve) => {
  const started = Date.now();
  const timer = setInterval(() => {
    const state = action === 'question' ? DailyQuestionPage.getState() : DailyCheckinPage.getState();
    const body = String(document.body?.innerText || '');
    const successText = action === 'question'
      ? /答题成功|恭喜[\s\S]{0,20}(?:答对|回答正确)[\s\S]{0,20}(?:获得|得到|赢得)[\s\S]{0,12}(?:大米|米)|(?:已获得|已到账|到账)[\s\S]{0,12}(?:大米|米)|今日已答题|已经答过/i
      : /签到成功|签到完成|今日已签到|已经签到/i;
    if (state === 'completed' || successText.test(body)) {
      clearInterval(timer); finishRemoteAction(actionId, action, 'success', 'completed'); resolve(true); return;
    }
    if (state === 'requires-login' || /验证码错误|提交失败|操作失败|系统错误/i.test(body)) {
      clearInterval(timer); finishRemoteAction(actionId, action, 'failed', state === 'requires-login' ? 'requires-login' : 'site-failed'); resolve(false); return;
    }
    if (Date.now() - started >= REMOTE_RESULT_TIMEOUT_MS) {
      clearInterval(timer); finishRemoteAction(actionId, action, 'failed', 'timeout'); resolve(false);
    }
  }, 200);
});
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
  }
  const status = questionStatusNode || { textContent: '' };
  const failRemote = actionId ? (reason) => finishRemoteAction(actionId, 'question', 'failed', reason) : () => {};
  try {
    const startedAt = Date.now();
    const questionReadyTimeoutMs = actionId ? QUESTION_READY_TIMEOUT_MS : REMOTE_ACTION_TIMEOUT_MS;
    while (Date.now() - startedAt < REMOTE_ACTION_TIMEOUT_MS) {
      const snapshot = await waitForStableQuestionSnapshot(startedAt, questionReadyTimeoutMs);
      if (!snapshot.ok) {
        failRemote(snapshot.reason);
        status.textContent = snapshot.reason === 'requires-login'
          ? '需登录：不能一键答题'
          : snapshot.reason === 'question-not-ready'
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
      const actionKey = `${snapshot.question}:${lookupAnswerText}`;
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
      return;
    }
    failRemote('question-not-ready');
    status.textContent = '题目或选项未稳定，未提交';
    return;
  } catch {
    answerActionKey = null;
    failRemote('action-failed');
    status.textContent = '一键答题未完成，请重试或按站点提示手动操作';
  }
};
const runCheckinAction = async ({ actionId = null } = {}) => {
  if (actionId) {
    pendingRemoteActions.add(actionId);
    activeRemoteActionId = actionId;
  }
  const status = checkinStatusNode || { textContent: '' };
  const failRemote = actionId ? (reason) => finishRemoteAction(actionId, 'checkin', 'failed', reason) : () => {};
  try {
    const currentState = DailyCheckinPage.getState();
    if (currentState === 'requires-login') { failRemote('requires-login'); status.textContent = '需登录：不能一键签到'; return; }
    if (currentState === 'completed') { finishRemoteAction(actionId, 'checkin', 'success', 'already-completed'); status.textContent = '已完成：今日已签到'; return; }
    const current = DailyCheckinPage.findDefault();
    if (!current) { failRemote('default-option-not-found'); status.textContent = '未找到“没心情”默认选项，未提交'; return; }
    const key = `${location.href}:${CheckinState.nodeSignature(current)}`;
    if (checkinActionKey === key) { failRemote('duplicate-action'); status.textContent = '已一键签到，等待站点结果'; return; }
    current.click();
    // Selecting a mood can cause the site to re-render the submit button.
    // Always resolve the live site-owned button after the selection event.
    const submit = await waitForCheckinSubmit();
    if (!submit) { failRemote('submit-not-found'); status.textContent = '未找到站点签到按钮，未提交'; return; }
    checkinActionKey = key;
    submit.click();
    status.textContent = '已触发官网提交，等待结果（如有验证码请完成）';
    await waitForRemoteResult('checkin', actionId, status);
  } catch {
    checkinActionKey = null;
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
let renderGeneration = 0;
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
  let bar = document.getElementById(toolbarId);
  if (!bar) { bar = document.createElement('section'); bar.id = toolbarId; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '每日答题助手'); document.body.appendChild(bar); }
  const status = document.createElement('span'); status.className = 'p3a-status'; status.setAttribute('aria-live', 'polite');
  const questionResult = DailyQuestionPage.findQuestion(); const optionNodes = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const question = questionResult.value; const options = optionNodes.map(DailyQuestionPage.clean); bar.replaceChildren(status);
  const state = DailyQuestionPage.getState();
  if (state === 'requires-login') { prepared = null; autoSelectedKey = null; answerActionKey = null; clearAnswerMarks(optionNodes); status.textContent = '需登录：请先登录一亩三分地'; return; }
  if (state === 'completed') { prepared = null; autoSelectedKey = null; answerActionKey = null; clearAnswerMarks(optionNodes); status.textContent = '已完成：今日已答题'; return; }
  if (!question || !options.length) { prepared = null; autoSelectedKey = null; clearAnswerMarks(optionNodes); status.textContent = '加载中或暂未识别到题目'; return; }
  const questionKey = normalizeQuestion(question);
  if (prepared && prepared.questionKey !== questionKey) prepared = null;
  if (answerActionKey && !answerActionKey.startsWith(`${questionKey}:`)) answerActionKey = null;
  if (autoSelectedKey && autoSelectedKey !== questionKey) autoSelectedKey = null;
  const result = (await bridge.send(ExtensionProtocol.MESSAGE_TYPES.LOOKUP_QUESTION, { question, options }).catch(() => null))?.payload;
  if (generation !== renderGeneration) return;
  if (!result || result.status === 'unmatched' || result.status === 'ambiguous') {
    prepared = null; autoSelectedKey = null; answerActionKey = null; clearAnswerMarks(optionNodes); status.textContent = result?.status === 'ambiguous' ? '多候选：请手动选择并保存，不能一键答题' : '未收录：请手动选择并保存，不能一键答题';
    const remember = document.createElement('button'); remember.type = 'button'; remember.textContent = '记住当前答案'; remember.className = 'p3a-action';
    remember.addEventListener('click', async () => { const currentQuestionResult = DailyQuestionPage.findQuestion(); const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const selected = DailyQuestionPage.findSelectedOption(document, currentOptions); const currentQuestion = currentQuestionResult.value; if (!currentQuestion || currentQuestion !== question || currentOptions.length !== optionNodes.length || currentOptions.some((node, index) => node !== optionNodes[index]) || !selected || currentOptions.filter((node) => node === selected).length !== 1) { status.textContent = '题目或选项已变化，或没有唯一选中项，未保存'; return; } const response = await bridge.send(ExtensionProtocol.MESSAGE_TYPES.SAVE_LEARNED_ANSWER, { question: currentQuestion, answer: DailyQuestionPage.clean(selected) }).catch(() => null); status.textContent = response?.ok ? '已记住当前答案' : '保存失败，请稍后重试'; });
    bar.append(remember); return;
  }
  if (!Number.isInteger(result.optionIndex) || result.optionIndex < 0 || result.optionIndex >= optionNodes.length || !optionNodes[result.optionIndex]) { prepared = null; answerActionKey = null; clearAnswerMarks(optionNodes); status.textContent = '命中答案索引无效，不能一键答题'; return; }
  markAnswerOptions(optionNodes, result.optionIndex);
  status.textContent = `已命中：${result.answerText}`;
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
    try { target.click(); prepared = { questionKey, optionIndex: result.optionIndex, node: target, answer: lookupAnswerText, optionTexts: lookupOptionTexts }; submit.disabled = false; status.textContent = `已自动选中：${result.answerText}，请检查后提交`; } catch { status.textContent = `已命中：${result.answerText}，请手动选择`; }
  }
  select.addEventListener('click', () => { const node = optionNodes[result.optionIndex]; if (!node || typeof node.click !== 'function') return; try { node.click(); } catch { return; } prepared = { questionKey, optionIndex: result.optionIndex, node, answer: lookupAnswerText, optionTexts: lookupOptionTexts }; status.textContent = '已选中，请检查验证码后提交'; submit.disabled = false; });
  submit.addEventListener('click', () => { const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const currentQuestion = normalizeQuestion(DailyQuestionPage.findQuestion().value); const node = prepared && currentOptions[prepared.optionIndex]; const selected = DailyQuestionPage.findSelectedOption(document, currentOptions); if (!prepared || prepared.questionKey !== currentQuestion || !node || node !== prepared.node || selected !== node) { submit.disabled = true; status.textContent = '题目或选项已变化，或官网未确认选中，未提交'; return; } const button = DailyQuestionPage.findSubmit(); if (button && !button.disabled) { try { clickVisibleQuestionSubmit(button); status.textContent = '已触发官网提交，等待结果'; } catch { status.textContent = '官网提交按钮已变化，未提交，请重试'; } } else status.textContent = '未找到已启用的官网提交按钮，未提交'; });
  oneClick.addEventListener('click', () => { runQuestionAction().catch(() => {}); });
  remember.addEventListener('click', async () => { const currentQuestionResult = DailyQuestionPage.findQuestion(); const currentOptions = DailyQuestionPage.findOptions(document, DailyQuestionPage.findQuestionContainer()); const selected = DailyQuestionPage.findSelectedOption(document, currentOptions); const currentQuestion = currentQuestionResult.value; if (!currentQuestion || currentQuestion !== question || currentOptions.length !== optionNodes.length || currentOptions.some((node, index) => node !== optionNodes[index]) || !selected || currentOptions.filter((node) => node === selected).length !== 1) { status.textContent = '题目或选项已变化，或没有唯一选中项，未保存'; return; } const response = await bridge.send(ExtensionProtocol.MESSAGE_TYPES.SAVE_LEARNED_ANSWER, { question: currentQuestion, answer: DailyQuestionPage.clean(selected) }).catch(() => null); status.textContent = response?.ok ? '已记住当前答案' : '保存失败，请稍后重试'; }); bar.append(oneClick, select, remember, submit);
};
let checkinPrepared = null;
let checkinAutoAttempt = null;
let checkinActionKey = null;
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
    const key = `${location.href}|${CheckinState.nodeSignature(current)}`;
    if (currentState === 'requires-login') { failRemote('requires-login'); status.textContent = '需登录：不能一键签到'; return; }
    if (currentState === 'completed') { finishRemoteAction(remoteActionId, 'checkin', 'success', 'already-completed'); status.textContent = '今日已签到'; return; }
    if (!current) { failRemote('default-option-not-found'); status.textContent = '未找到“没心情”默认选项，未提交'; return; }
    if (key === checkinActionKey) { failRemote('duplicate-action'); status.textContent = '一键签到已执行，等待站点结果'; return; }
    try {
      if (!CheckinState.reconcile(checkinPrepared, location.href, current)) { current.click(); checkinPrepared = CheckinState.prepare(current, location.href); }
      const submit = await waitForCheckinSubmit();
      if (!submit) { failRemote('submit-not-found'); status.textContent = '未找到站点签到按钮，未提交'; return; }
      submit.click(); checkinActionKey = key; checkinPrepared = null; status.textContent = '已提交，等待签到结果（如有验证码请完成）';
      await waitForRemoteResult('checkin', remoteActionId, status);
    } catch { checkinActionKey = null; failRemote('action-failed'); status.textContent = '一键签到未完成，请重试或按站点提示手动操作'; }
  });
  bar.append(oneClick, prepare, confirm);
};
let timer; let checkinTimer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 180); };
const scheduleCheckin = () => { clearTimeout(checkinTimer); checkinTimer = setTimeout(renderCheckin, 180); };
if (isQuestionPage() || isCheckinPage()) {
  chrome.runtime.sendMessage(ExtensionProtocol.createMessage(ExtensionProtocol.MESSAGE_TYPES.CONTENT_READY, { pageKind: detectPageKind() })).catch?.(() => {});
  new MutationObserver((records) => {
    const relevant = records.some((record) => !record.target.closest?.(`#${toolbarId}, #${checkinToolbarId}, #${checkinToastId}`));
    if (!relevant) return;
    if (isQuestionPage()) schedule();
    if (isCheckinPage()) scheduleCheckin();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  if (isQuestionPage()) schedule();
  if (isCheckinPage()) scheduleCheckin();
}
globalThis.Section1Bridge = bridge;
