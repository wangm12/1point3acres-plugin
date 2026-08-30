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
    versionTag: document.getElementById('version-tag'),
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
    'answer-not-visible': { title: '当前选项不匹配', desc: '题库答案不在当前页面选项中，扩展未自动提交' },
    'answer-option-ambiguous': { title: '答案多候选', desc: '存在多个可能答案，请手动确认' },
    'default-option-not-found': { title: '未找到签到选项', desc: '未识别到默认心情选项，请手动签到' },
    'question-fuzzy-match-requires-confirmation': { title: '需要人工确认答案', desc: '相似题目命中但不是精确题目，扩展未自动提交' },
    'timeout': { title: '任务超时', desc: '等待站点结果超时，请检查页面后重试' },
    'question-not-ready': { title: '题目未稳定', desc: '题目或选项未在时限内稳定，请刷新后重试' },
    'question-changed-or-unavailable': { title: '题目已变化', desc: '页面题目或选项已变化，请手动核对' },
    'site-failed': { title: '站点返回失败', desc: '官网提示提交失败，请在页面查看后重试' },
    'submit-not-found': { title: '未找到提交按钮', desc: '未识别到可用的官网提交按钮，请手动处理' },
    'action-failed': { title: '操作未完成', desc: '自动流程未能完成，请检查页面后重试' },
    'submit-timeout': { title: '提交按钮未就绪', desc: '官网提交按钮未及时可用，请手动处理' },
    'checkin-changed-or-unavailable': { title: '签到页面已变化', desc: '签到选项或按钮已变化，请手动处理' },
    'invalid-answer-index': { title: '命中答案无效', desc: '题库命中的选项已失效，请手动选择' },
  };

  const getCurrentActions = (runtimeState = {}) => {
    const dateKey = runtimeState.dailyStatus?.dateKey;
    return Object.values(runtimeState.actionsByTabId || {}).filter((record) => !dateKey || !record?.dateKey || record.dateKey === dateKey);
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
    const actions = getCurrentActions(runtimeState);
    for (const record of actions) {
      const reason = record.lastResult?.reason || record.lastResult?.status || '';
      if (BLOCKED_REASONS[reason]) {
        return { ...BLOCKED_REASONS[reason], tabId: Number.isInteger(record.tabId) ? record.tabId : tabId };
      }
    }
    return null;
  };

  const render = (runtimeState = {}) => {
    state.runtime = runtimeState;
    const run = runtimeState.run || {};
    const actions = getCurrentActions(runtimeState);
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
    const tabId = Number.isInteger(state.blockedTabId) ? state.blockedTabId : state.runtime?.run?.currentTabId;
    if (!Number.isInteger(tabId)) {
      setStatus('未找到对应任务标签页');
      return;
    }
    try {
      if (chrome?.tabs?.update) {
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (Number.isInteger(tab?.windowId) && chrome?.windows?.update) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        window.close();
      } else {
        await sendRuntimeMessage(ExtensionProtocol.MESSAGE_TYPES.FOCUS_TASK_TAB, { tabId });
        window.close();
      }
    } catch (e) {
      // The popup may expose tabs.update while still lacking permission to
      // inspect the target tab. Give the service worker a second chance,
      // since it owns the extension's tab lifecycle and has the host scope.
      try {
        if (chrome?.tabs?.update && chrome?.runtime?.sendMessage) {
          await sendRuntimeMessage(ExtensionProtocol.MESSAGE_TYPES.FOCUS_TASK_TAB, { tabId });
          window.close();
          return;
        }
      } catch {}
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

  const renderVersion = () => {
    const version = chrome?.runtime?.getManifest?.().version;
    if (version && els.versionTag) els.versionTag.textContent = `v${version}`;
  };

  els.runEverything?.addEventListener('click', () => runAction('everything'));
  els.runCheckin?.addEventListener('click', () => runAction('checkin'));
  els.runQuestion?.addEventListener('click', () => runAction('question'));
  els.alertActionBtn?.addEventListener('click', focusTaskTab);
  chrome?.storage?.onChanged?.addListener(() => refreshState());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  global.__popup = { render, getBlockedInfo, runAction, focusTaskTab, refreshState, BLOCKED_REASONS };

  renderVersion();
  render({});
  refreshState();
})(globalThis);
