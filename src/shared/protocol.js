(function (global) {
  const PROTOCOL_VERSION = '1.0.0';

  const MESSAGE_TYPES = Object.freeze({
    QUESTION_STATE: 'QUESTION_STATE',
    SELECT_ANSWER: 'SELECT_ANSWER',
    PREPARE_CHECKIN: 'PREPARE_CHECKIN',
    CONFIRM_SUBMIT: 'CONFIRM_SUBMIT',
    SAVE_LEARNED_ANSWER: 'SAVE_LEARNED_ANSWER',
    LOOKUP_QUESTION: 'LOOKUP_QUESTION',
    RUN_ONE_CLICK: 'RUN_ONE_CLICK',
    CONTENT_READY: 'CONTENT_READY',
    ACTION_RESULT: 'ACTION_RESULT',
  });

  const PAGE_MATCHES = Object.freeze([
    'https://www.1point3acres.com/next/daily-question*',
    'https://www.1point3acres.com/next/daily-checkin*',
  ]);

  const PAGE_URLS = Object.freeze({
    dailyQuestion: 'https://www.1point3acres.com/next/daily-question',
    dailyCheckin: 'https://www.1point3acres.com/next/daily-checkin',
  });

  /**
   * @typedef {Object} ExtensionMessage
   * @property {string} version
   * @property {string} type
   * @property {Record<string, unknown>} payload
   * @property {Record<string, unknown>} meta
   */

  const ExtensionProtocol = Object.freeze({
    version: PROTOCOL_VERSION,
    MESSAGE_TYPES,
    PAGE_MATCHES,
    PAGE_URLS,
    createMessage(type, payload = {}, meta = {}) {
      return {
        version: PROTOCOL_VERSION,
        type,
        payload,
        meta,
      };
    },
    isKnownType(type) {
      return Object.values(MESSAGE_TYPES).includes(type);
    },
  });

  global.ExtensionProtocol = ExtensionProtocol;
})(globalThis);
