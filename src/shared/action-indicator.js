(function (global) {
  const CAPTCHA_REASONS = new Set(['captcha-required', 'captcha-error']);
  const LOGIN_REASONS = new Set(['requires-login', 'login-blocked']);
  const DEFAULT_TITLE = '一亩三分地每日助手';
  const BADGE_COLORS = Object.freeze({
    running: '#2563eb',
    blocked: '#f59e0b',
    done: '#16a34a',
  });
  const DOT_COLORS = Object.freeze({
    pending: '#94a3b8',
    running: '#38bdf8',
    blocked: '#f59e0b',
    done: '#22c55e',
  });

  const actionReason = (record) => record?.lastResult?.reason || record?.lastResult?.status || '';

  const inferMode = (run, checkinRecord, questionRecord, checkinDone, questionDone) => {
    if (['everything', 'checkin', 'question'].includes(run?.mode)) return run.mode;
    if (run?.stage === 'question' && !checkinRecord && !checkinDone) return 'question';
    if (run?.stage === 'checkin' && !questionRecord && !questionDone) return 'checkin';
    return 'everything';
  };

  const describeActionIndicator = (input = {}) => {
    const run = input.run && typeof input.run === 'object' ? input.run : {};
    const dailyStatus = input.dailyStatus && typeof input.dailyStatus === 'object' ? input.dailyStatus : {};
    const actions = Array.isArray(input.actions) ? input.actions : [];
    const checkinRecord = actions.find((item) => item?.action === 'checkin') || null;
    const questionRecord = actions.find((item) => item?.action === 'question') || null;
    const checkinDone = dailyStatus.checkin?.completed === true || checkinRecord?.status === 'completed';
    const questionDone = dailyStatus.question?.completed === true || questionRecord?.status === 'completed';
    const mode = inferMode(run, checkinRecord, questionRecord, checkinDone, questionDone);
    const includeCheckin = mode !== 'question';
    const includeQuestion = mode !== 'checkin';
    const isRunning = run.status === 'running';
    const isPaused = run.status === 'paused';
    const reason = run.lastError || actionReason(run.stage === 'question' ? questionRecord : checkinRecord) || '';
    const captcha = CAPTCHA_REASONS.has(reason);
    const login = LOGIN_REASONS.has(reason);
    const blocked = isPaused === true;
    const active = isRunning || blocked;

    const stepState = (included, done, stageName) => {
      if (!included || !active) return 'hidden';
      if (done) return 'done';
      if (blocked && run.stage === stageName) return 'blocked';
      if (isRunning && (run.stage === stageName || (!run.stage && stageName === 'checkin' && includeCheckin))) return 'running';
      if (isRunning && !run.stage && stageName === 'question' && includeQuestion && !includeCheckin) return 'running';
      return 'pending';
    };

    const checkin = stepState(includeCheckin, checkinDone, 'checkin');
    const question = stepState(includeQuestion, questionDone, 'question');
    const requiredDone = (!includeCheckin || checkinDone) && (!includeQuestion || questionDone) && (checkinDone || questionDone);

    let badgeText = '';
    let badgeColor = BADGE_COLORS.running;
    let title = DEFAULT_TITLE;

    if (blocked && captcha) {
      badgeText = '!';
      badgeColor = BADGE_COLORS.blocked;
      title = '遇到验证码，请点击 Verify you are human';
    } else if (blocked && login) {
      badgeText = '!';
      badgeColor = BADGE_COLORS.blocked;
      title = '需要登录一亩三分地';
    } else if (blocked) {
      badgeText = '!';
      badgeColor = BADGE_COLORS.blocked;
      title = '需要处理一亩三分地任务';
    } else if (isRunning) {
      badgeText = '…';
      badgeColor = BADGE_COLORS.running;
      title = run.stage === 'question' ? '正在答题…' : run.stage === 'checkin' ? '正在签到…' : '正在启动任务…';
    } else if (dailyStatus.checkin?.completed === true && dailyStatus.question?.completed === true) {
      title = '今日签到和答题已完成';
    } else if (requiredDone && checkinDone && !includeQuestion) {
      title = '今日已签到';
    } else if (requiredDone && questionDone && !includeCheckin) {
      title = '今日已答题';
    } else if (checkinDone && !questionDone && includeQuestion) {
      title = '今日已签到，待答题';
    }

    return {
      enabled: input.autoEnabled === true,
      checkin,
      question,
      badgeText,
      badgeColor,
      title,
    };
  };

  const drawIndicatorDots = (ctx, size, checkin, question) => {
    if (!ctx || !Number.isFinite(size) || size <= 0) return false;
    const radius = size <= 16 ? 2.1 : size <= 32 ? 3.3 : Math.max(4, size * 0.08);
    const y = size <= 16 ? 3.3 : Math.max(5, size * 0.14);
    const slots = [
      { state: checkin, x: size * 0.28 },
      { state: question, x: size * 0.72 },
    ];
    let painted = false;
    for (const slot of slots) {
      const color = DOT_COLORS[slot.state];
      if (!color) continue;
      ctx.beginPath();
      ctx.arc(slot.x, y, radius + 0.85, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(slot.x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      painted = true;
    }
    return painted;
  };

  global.ActionIndicator = Object.freeze({
    DEFAULT_TITLE,
    BADGE_COLORS,
    DOT_COLORS,
    describeActionIndicator,
    drawIndicatorDots,
  });
})(typeof self !== 'undefined' ? self : globalThis);
