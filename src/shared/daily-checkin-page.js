(function (global) {
  const TOOLBAR_ID = 'p3a-daily-checkin-helper';
  const LOGIN = /请先登录|请登录|登录后|login required|sign in/i;
  // The site uses the success toast as the completion signal immediately
  // after a submission. It does not always replace the check-in form with a
  // disabled "今日已签到" button, so both forms must be treated equally.
  const COMPLETE = /签到成功|签到完成|今日已签到|已经签到|今日签到已完成|already checked.?in|already signed/i;
  const COMPLETE_CONTROL = /^(?:签到成功|签到完成|今日已签到|已经签到|今日签到已完成|already checked.?in|already signed)$/i;
  const PENDING_CAPTCHA = /(?:请输入|请完成|需要|继续|通过)[^。！？\n]{0,24}(?:验证码|安全验证|人机验证)/i;
  const CHECKIN = /签到|check.?in|sign.?in/i;
  const DEFAULT = /只想签到拿米|只想签到|qdxq\s*[:=]?\s*x/i;
  const DEFAULT_MOOD = /没心情/;
  const BAD = /导航|搜索|登录|注册|我的版块|返回|首页|签到记录|已签到|提交答案|取消|menu|login|sign.?up|back|search|submit|cancel/i;
  const text = (n) => String(n?.textContent || n?.value || n?.getAttribute?.('value') || n?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
  const visible = (n) => Boolean(n && !n.hidden && n.getAttribute?.('aria-hidden') !== 'true' && (n.offsetParent !== null || n.ownerDocument?.defaultView == null));
  const inToolbar = (n) => Boolean(n?.closest?.(`#${TOOLBAR_ID}`));
  const scopeNodes = (root, selector) => Array.from(root.querySelectorAll?.(selector) || []).filter((node) => !inToolbar(node));
  const containsCheckinSignal = (node) => Boolean(node?.querySelector?.('button,[role="button"],input,[role="radio"],[role="checkbox"],label,form')) || /签到|check.?in|sign.?in/i.test(text(node));
  const taskScope = (root = global.document) => {
    const defaultControl = findDefault(root);
    const defaultScope = defaultControl?.closest?.('[data-checkin], [data-page="daily-checkin"], [class*="daily-checkin"], form, main, [role="main"]') || null;
    const directAnchors = [
      ...scopeNodes(root, '[data-checkin]'),
      ...scopeNodes(root, '[data-page="daily-checkin"]'),
      ...scopeNodes(root, '[class*="daily-checkin"]'),
      ...scopeNodes(root, 'form'),
    ];
    const candidate = [...new Set([...directAnchors.map((node) => node.closest?.('[data-checkin], [data-page="daily-checkin"], [class*="daily-checkin"], form, main, [role="main"]') || node), defaultScope].filter(Boolean))]
      .filter((node) => containsCheckinSignal(node) && node.querySelector?.('button,[role="button"],input,[role="radio"],[role="checkbox"],label,form'));
    if (candidate.length) {
      const nested = candidate.find((node) => node.tagName === 'MAIN' && node.querySelector?.('main'));
      if (nested) return nested.querySelector('main');
      return candidate.find((node) => node.querySelector?.('button,[role="button"],input,[role="radio"],[role="checkbox"],label,form')) || null;
    }
    const nestedMain = scopeNodes(root, 'main main').find((node) => containsCheckinSignal(node) && node.querySelector?.('button,[role="button"],input,[role="radio"],[role="checkbox"],label,form'));
    if (nestedMain) return nestedMain;
    const main = scopeNodes(root, 'main').find((node) => containsCheckinSignal(node) && node.querySelector?.('button,[role="button"],input,[role="radio"],[role="checkbox"],label,form'));
    if (main) return main;
    return null;
  };
  const hasCompletedControl = (root = global.document, scope = taskScope(root)) => {
    const searchRoot = scope || root;
    const controls = Array.from(searchRoot.querySelectorAll?.('button,input[type="button"],input[type="submit"],[role="button"]') || []);
    return controls.some((node) => {
      if (inToolbar(node)) return false;
      if (!node.disabled && node.getAttribute?.('aria-disabled') !== 'true') return false;
      return COMPLETE_CONTROL.test(text(node));
    });
  };
  const hasExplicitCompletionText = (body) => {
    if (!body) return false;
    if (PENDING_CAPTCHA.test(body) && /签到成功|签到完成/i.test(body) && !/今日已签到|已经签到|今日签到已完成|already checked.?in|already signed/i.test(body)) return false;
    if (/累计已签到/.test(body) && !/签到成功|签到完成|今日已签到|已经签到|今日签到已完成|already checked.?in|already signed/i.test(body.replace(/累计已签到/g, ''))) return false;
    return COMPLETE.test(body);
  };
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
    return Array.from(root.querySelectorAll?.('button,input[type="submit"],input[type="button"],[role="button"]') || []).find((n) => {
      const label = text(n).replace(/[：:!！。.]$/g, '').trim();
      return visible(n) && !inToolbar(n) && !n.disabled && ACTION.test(label);
    }) || null;
  }
  function getState(root = global.document) {
    const scope = taskScope(root);
    const scopedBody = scope ? String(scope.innerText || scope.textContent || '') : '';
    const documentBody = String(root.body?.innerText || root.body?.textContent || '');
    const body = scopedBody || documentBody;
    if (LOGIN.test(body) || (!scopedBody && LOGIN.test(documentBody))) return 'requires-login';
    // The success toast can be rendered outside the form/main selected by
    // taskScope. Check the full page as a fallback so the next workflow stage
    // is not lost when the site changes its DOM nesting.
    if (hasCompletedControl(root, scope) || hasExplicitCompletionText(scopedBody) || hasExplicitCompletionText(documentBody)) return 'completed';
    return 'active';
  }
  global.DailyCheckinPage = Object.freeze({ TOOLBAR_ID, text, isCheckinPage, findDefault, findSubmit, getState });
})(globalThis);
