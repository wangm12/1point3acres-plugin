(function (global) {
  const TOOLBAR_ID = 'p3a-daily-checkin-helper';
  const LOGIN = /请先登录|请登录|登录后|login required|sign in/i;
  const COMPLETE = /今日已签到|已经签到|今日签到已完成|already checked.?in|already signed/i;
  const CHECKIN = /签到|check.?in|sign.?in/i;
  const DEFAULT = /只想签到拿米|只想签到|qdxq\s*[:=]?\s*x/i;
  const DEFAULT_MOOD = /没心情/;
  const BAD = /导航|搜索|登录|注册|我的版块|返回|首页|签到记录|已签到|提交答案|取消|menu|login|sign.?up|back|search|submit|cancel/i;
  const text = (n) => String(n?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = (n) => Boolean(n && !n.hidden && n.getAttribute?.('aria-hidden') !== 'true' && (n.offsetParent !== null || n.ownerDocument?.defaultView == null));
  const inToolbar = (n) => Boolean(n?.closest?.(`#${TOOLBAR_ID}`));
  const isCheckinPage = (url = global.location?.href || '') => /\/next\/daily-checkin\/?(?:[?#].*)?$/.test(url);
  const semanticDefault = (n) => {
    if (!visible(n) || inToolbar(n) || n.disabled) return false;
    const isButton = String(n.tagName || n.tag || '').toLowerCase() === 'button' || String(n.getAttribute?.('role') || '').toLowerCase() === 'button';
    if (isButton && DEFAULT_MOOD.test(text(n))) return true;
    const value = [text(n), n.getAttribute?.('data-value'), n.getAttribute?.('data-qdxq'), n.getAttribute?.('value'), n.getAttribute?.('aria-label')].filter(Boolean).join(' ');
    const qdxq = /qdxq/i.test([n.getAttribute?.('name'), n.getAttribute?.('id'), n.getAttribute?.('data-qdxq')].filter(Boolean).join(' '));
    return (DEFAULT.test(value) || (qdxq && /^x$/i.test(String(n.getAttribute?.('value') || n.getAttribute?.('data-value') || '')))) && !BAD.test(text(n).replace(/只想签到拿米|只想签到/g, ''));
  };
  function findDefault(root = global.document) {
    const nodes = Array.from(root.querySelectorAll?.('button,input,label,[role="button"],[role="radio"]') || []);
    return nodes.find(semanticDefault) || null;
  }
  function findSubmit(root = global.document) {
    const ACTION = /^(?:签到|立即签到|确认签到|提交签到|check\s*in|sign\s*in)$/i;
    return Array.from(root.querySelectorAll?.('button,[role="button"]') || []).find((n) => {
      const label = text(n).replace(/[：:!！。.]$/g, '').trim();
      return visible(n) && !inToolbar(n) && !n.disabled && ACTION.test(label);
    }) || null;
  }
  function getState(root = global.document) {
    const body = String(root.body?.innerText || root.body?.textContent || '');
    if (LOGIN.test(body)) return 'requires-login';
    if (COMPLETE.test(body)) return 'completed';
    return 'active';
  }
  global.DailyCheckinPage = Object.freeze({ TOOLBAR_ID, text, isCheckinPage, findDefault, findSubmit, getState });
})(globalThis);
