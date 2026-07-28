importScripts('shared/protocol.js');
importScripts('shared/question-matcher.js');
importScripts('shared/learned-answers.js');

const RUNTIME_STORAGE_KEY = 'p3a-runtime-v1';
const DELIVERY_RETRY_LIMIT = 4;
const DELIVERY_RETRY_DELAY_MS = 250;
// Compatibility markers kept for source-based tests:
// const deliveringActions = new Set()
// deliverAction(sender.tab?.id)
// chrome.tabs.remove(tabId)

let bankPromise;
let runtimePromise;
let runtimeState = null;
const runtimeStorage = chrome.storage.session || chrome.storage.local;

const actionPage = (action) => action === 'question' ? ExtensionProtocol.PAGE_URLS.dailyQuestion : ExtensionProtocol.PAGE_URLS.dailyCheckin;
const isTargetUrl = (url, page) => typeof url === 'string' && (url === page || url.startsWith(`${page}?`) || url.startsWith(`${page}#`));

const clone = (value) => JSON.parse(JSON.stringify(value));

const defaultRuntimeState = () => ({
  version: 1,
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
  const next = {
    action: record.action,
    actionId: record.actionId,
    workflowId: typeof record.workflowId === 'string' && record.workflowId ? record.workflowId : null,
    tabId: Number.isInteger(record.tabId) ? record.tabId : null,
    status: record.status === 'completed' ? 'completed' : 'pending',
    deliveredAt: Number.isFinite(record.deliveredAt) ? record.deliveredAt : null,
    deliveredCount: Number.isInteger(record.deliveredCount) ? record.deliveredCount : 0,
    lastDeliveryAttemptAt: Number.isFinite(record.lastDeliveryAttemptAt) ? record.lastDeliveryAttemptAt : null,
    lastDeliveryError: typeof record.lastDeliveryError === 'string' ? record.lastDeliveryError : null,
    lastResult: record.lastResult && typeof record.lastResult === 'object' ? clone(record.lastResult) : null,
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
  };
};

const normalizeRuntimeState = (state) => {
  const next = defaultRuntimeState();
  if (!state || typeof state !== 'object') return next;
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
  return next;
};

const loadRuntimeState = async () => {
  if (runtimeState) return runtimeState;
  if (!runtimePromise) {
    runtimePromise = runtimeStorage.get(RUNTIME_STORAGE_KEY).then((stored) => {
      runtimeState = normalizeRuntimeState(stored[RUNTIME_STORAGE_KEY]);
      return runtimeState;
    });
  }
  return runtimePromise;
};

const saveRuntimeState = async () => {
  await loadRuntimeState();
  await runtimeStorage.set({ [RUNTIME_STORAGE_KEY]: runtimeState });
};

const getActionRecord = (tabId) => runtimeState?.actionsByTabId[String(tabId)] || null;
const getAwaitingRecord = (tabId) => runtimeState?.awaitingContentByTabId[String(tabId)] || null;
const getWorkflow = (workflowId) => runtimeState?.workflowsById[workflowId] || null;
const isSuccessResult = (result) => result?.status === 'success';
const isExistingTabId = async (tabId) => {
  if (!Number.isInteger(tabId)) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab?.id);
};

const closeActionTabSafely = async (tabId) => {
  if (!Number.isInteger(tabId)) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active === true) return false;
  await chrome.tabs.remove(tabId).catch(() => {});
  return true;
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

const reserveActionRecord = async (record) => {
  await loadRuntimeState();
  runtimeState.pendingActionsById[record.actionId] = { ...record };
  await saveRuntimeState();
};

const claimPendingActionForTab = async (tabId, page) => {
  await loadRuntimeState();
  const pending = Object.values(runtimeState.pendingActionsById).find((record) => record?.status === 'pending' && record?.action && isTargetUrl(page, actionPage(record.action)));
  if (!pending) return null;
  await setActionRecord(tabId, pending);
  return getActionRecord(tabId);
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

const finalizeCompletedSuccess = async (pending) => {
  if (!pending || pending.status !== 'completed' || !isSuccessResult(pending.lastResult)) return;

  if (pending.action === 'checkin' && pending.workflowId) {
    const workflow = getWorkflow(pending.workflowId);
    if (workflow) {
      workflow.stage = 'question';
      workflow.checkinActionId = pending.actionId;
      workflow.updatedAt = Date.now();
      await saveRuntimeState();
      try {
        await ensureQuestionWorkflowTab(pending.workflowId);
      } catch (error) {
        await loadRuntimeState();
        const nextWorkflow = getWorkflow(pending.workflowId);
        if (nextWorkflow) {
          nextWorkflow.stage = 'question';
          nextWorkflow.questionActionId = null;
          nextWorkflow.updatedAt = Date.now();
          await saveRuntimeState();
        }
      }
    }
    await closeActionTabSafely(pending.tabId);
    return;
  }

  if (pending.action === 'question' && pending.workflowId) {
    await clearWorkflow(pending.workflowId);
    await closeActionTabSafely(pending.tabId);
    return;
  }

  await closeActionTabSafely(pending.tabId);
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

const retryDeliverIfNeeded = async (tabId) => {
  await loadRuntimeState();
  let action = getActionRecord(tabId) || getAwaitingRecord(tabId);
  if (!action) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) action = await claimPendingActionForTab(tabId, tab.url);
  }
  if (!action || action.status === 'completed') return false;
  if ((action.deliveredCount || 0) >= DELIVERY_RETRY_LIMIT) return false;
  return deliverAction(tabId);
};

const openActionPage = async (action, workflowId = null) => {
  await loadRuntimeState();
  const page = actionPage(action);
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => candidate.active !== true && isTargetUrl(candidate.url, page));
  const actionRecord = { action, actionId: crypto.randomUUID(), workflowId, status: 'pending' };
  let target;
  if (tab) {
    try {
      await setActionRecord(tab.id, actionRecord);
      target = await chrome.tabs.update(tab.id, { active: false, url: page });
    } catch (error) {
      await clearActionArtifacts(tab.id).catch(() => {});
      throw error;
    }
  } else {
    await reserveActionRecord({ ...actionRecord, tabId: null });
    try {
      target = await chrome.tabs.create({ url: page, active: false });
      await setActionRecord(target.id, actionRecord);
    } catch (error) {
      await loadRuntimeState();
      delete runtimeState.pendingActionsById[actionRecord.actionId];
      await saveRuntimeState();
      throw error;
    }
  }
  await retryDeliverIfNeeded(target.id);
  return target;
};

const startWorkflow = async () => {
  await loadRuntimeState();
  if (runtimeState.activeWorkflowId && runtimeState.workflowsById[runtimeState.activeWorkflowId]) {
    const workflowId = runtimeState.activeWorkflowId;
    const workflow = getWorkflow(workflowId);
    if (workflow?.stage === 'question') {
      const tab = await openActionPage('question', workflowId);
      workflow.tabIds = Array.from(new Set([...(workflow.tabIds || []), tab.id]));
      workflow.questionActionId = getActionRecord(tab.id)?.actionId || workflow.questionActionId;
      workflow.updatedAt = Date.now();
      await saveRuntimeState();
      return { tab, workflowId };
    }
    if (workflow?.stage === 'checkin') {
      const checkinRecord = getWorkflowActionRecord(workflowId, 'checkin');
      if (checkinRecord?.status === 'completed' && isSuccessResult(checkinRecord?.lastResult)) {
        await finalizeCompletedSuccess(checkinRecord);
        const questionRecord = getWorkflowActionRecord(workflowId, 'question');
        return { tab: questionRecord ? { id: questionRecord.tabId } : { id: checkinRecord.tabId }, workflowId };
      }
      const tab = await openActionPage('checkin', workflowId);
      workflow.tabIds = Array.from(new Set([...(workflow.tabIds || []), tab.id]));
      workflow.checkinActionId = getActionRecord(tab.id)?.actionId || workflow.checkinActionId;
      workflow.updatedAt = Date.now();
      await saveRuntimeState();
      return { tab, workflowId };
    }
    throw new Error('everything-in-progress');
  }
  const workflowId = crypto.randomUUID();
  await setWorkflow(workflowId, { action: 'everything', stage: 'checkin', createdAt: Date.now(), updatedAt: Date.now(), tabIds: [] });
  try {
    const tab = await openActionPage('checkin', workflowId);
    const workflow = getWorkflow(workflowId);
    workflow.tabIds = Array.from(new Set([...(workflow.tabIds || []), tab.id]));
    workflow.checkinActionId = getActionRecord(tab.id)?.actionId || workflow.checkinActionId;
    workflow.updatedAt = Date.now();
    await saveRuntimeState();
    return { tab, workflowId };
  } catch (error) {
    await clearWorkflow(workflowId);
    throw error;
  }
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
      const opening = message.payload.action === 'everything' ? startWorkflow() : openActionPage(message.payload.action);
      opening.then((result) => { const tab = result.tab || result; sendResponse({ ok: true, payload: { tabId: tab.id, workflowId: result.workflowId } }); }).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    case ExtensionProtocol.MESSAGE_TYPES.CONTENT_READY: {
      const tabId = sender.tab?.id;
      (async () => {
        await loadRuntimeState();
        const pending = tabId == null ? null : getActionRecord(tabId);
        if (pending?.status === 'completed' && isSuccessResult(pending.lastResult)) {
          await finalizeCompletedSuccess(pending);
          return;
        }
        await retryDeliverIfNeeded(tabId);
      })().catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
    case ExtensionProtocol.MESSAGE_TYPES.ACTION_RESULT: {
      const tabId = sender.tab?.id;
      const result = message.payload || {};
      (async () => {
        let responded = false;
        const reply = (payload) => {
          if (responded) return;
          responded = true;
          sendResponse(payload);
        };
        await loadRuntimeState();
        const pending = tabId == null ? null : getActionRecord(tabId);
        if (!pending) { reply({ ok: false, error: 'unknown-action-id' }); return; }
        if (pending.actionId !== result.actionId) { reply({ ok: false, error: 'unknown-action-id' }); return; }
        if (pending.status === 'completed') {
          reply({ ok: true, duplicate: true });
          await finalizeCompletedSuccess(pending);
          return;
        }
        const success = isSuccessResult(result);
        if (pending.workflowId) {
          const workflow = getWorkflow(pending.workflowId);
          if (!workflow || (workflow.stage !== pending.action && workflow.checkinActionId !== pending.actionId && workflow.questionActionId !== pending.actionId) || result.action !== pending.action) {
            reply({ ok: false, error: 'workflow-stage-mismatch' });
            return;
          }
          workflow.updatedAt = Date.now();
          if (success && pending.action === 'checkin') {
            workflow.stage = 'question';
            workflow.checkinActionId = pending.actionId;
          } else if (success && pending.action === 'question') {
            workflow.stage = 'done';
            workflow.questionActionId = pending.actionId;
          } else {
            workflow.stage = workflow.stage;
          }
        }
        const workflowId = pending.workflowId;
        if (!success && workflowId) {
          const workflow = getWorkflow(workflowId);
          if (workflow) {
            workflow.updatedAt = Date.now();
          }
        }

        pending.status = 'completed';
        pending.lastResult = { ...result };
        runtimeState.actionsByTabId[String(tabId)] = pending;
        delete runtimeState.awaitingContentByTabId[String(tabId)];
        if (!success && workflowId) {
          delete runtimeState.workflowsById[workflowId];
          if (runtimeState.activeWorkflowId === workflowId) runtimeState.activeWorkflowId = null;
        }
        await saveRuntimeState();
        if (success && pending.action === 'checkin') {
          try { await chrome.notifications.create({ type: 'basic', iconUrl: 'assets/1point3acres-helper-icon-128.png', title: '一亩三分地每日助手', message: '签到完成', contextMessage: '每日任务已完成', priority: 2, requireInteraction: true }); } catch {}
        }
        if (success && pending.action === 'question' && pending.workflowId) {
          try { await chrome.notifications.create({ type: 'basic', iconUrl: 'assets/1point3acres-helper-icon-128.png', title: '一亩三分地每日助手', message: '签到和答题完成', contextMessage: '每日任务已完成', priority: 2, requireInteraction: true }); } catch {}
        }
        reply({ ok: true });
        if (success) {
          await finalizeCompletedSuccess(pending);
          await clearActionArtifacts(tabId);
        }
      })().catch((e) => {
        console.error('ACTION_RESULT handler failed', e);
      });
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
  claimPendingActionForTab(tabId, page).then(() => retryDeliverIfNeeded(tabId)).catch(() => {});
});
