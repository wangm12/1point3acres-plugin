// Simulates the worker's browser-input transport for content-script fixtures.
// Button click counters belong to the fake site, not to the content script.
export const mockTrustedSubmitTransport = (context) => {
  const requests = [];
  let failure = null;
  const runtime = context.chrome.runtime;
  const originalSend = runtime.sendMessage.bind(runtime);
  context.ExtensionProtocol.MESSAGE_TYPES.CLICK_TASK_SUBMIT = 'CLICK_TASK_SUBMIT';
  runtime.sendMessage = (message, callback) => {
    if (message.type !== 'CLICK_TASK_SUBMIT') return originalSend(message, callback);
    requests.push(message.payload);
    const page = message.payload.action === 'question' ? context.DailyQuestionPage : context.DailyCheckinPage;
    const button = page.findSubmit();
    const response = failure ? { ok: false, error: failure }
      : !button || button.getAttribute('data-p3a-submit-token') !== message.payload.token
        ? { ok: false, error: 'submit-button-stale-or-unavailable' } : { ok: true };
    if (response.ok) button.click();
    if (typeof callback === 'function') queueMicrotask(() => callback(response));
    return Promise.resolve(response);
  };
  return { requests, failWith(error) { failure = error; } };
};
