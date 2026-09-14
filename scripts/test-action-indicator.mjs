#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/shared/action-indicator.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
context.globalThis = context;
vm.runInNewContext(source, context);
const { describeActionIndicator, drawIndicatorDots, BADGE_COLORS, DEFAULT_TITLE } = context.ActionIndicator;

const idle = describeActionIndicator({
  run: { status: 'idle' },
  dailyStatus: { checkin: { completed: false }, question: { completed: false } },
  actions: [],
});
assert.equal(idle.checkin, 'hidden');
assert.equal(idle.question, 'hidden');
assert.equal(idle.badgeText, '');
assert.equal(idle.title, DEFAULT_TITLE);

const runningCheckin = describeActionIndicator({
  run: { status: 'running', mode: 'everything', stage: 'checkin' },
  dailyStatus: { checkin: { completed: false }, question: { completed: false } },
  actions: [{ action: 'checkin', status: 'pending' }],
});
assert.equal(runningCheckin.checkin, 'running');
assert.equal(runningCheckin.question, 'pending');
assert.equal(runningCheckin.badgeText, '…');
assert.equal(runningCheckin.badgeColor, BADGE_COLORS.running);
assert.equal(runningCheckin.title, '正在签到…');

const runningQuestion = describeActionIndicator({
  run: { status: 'running', mode: 'everything', stage: 'question' },
  dailyStatus: { checkin: { completed: true }, question: { completed: false } },
  actions: [
    { action: 'checkin', status: 'completed' },
    { action: 'question', status: 'pending' },
  ],
});
assert.equal(runningQuestion.checkin, 'done');
assert.equal(runningQuestion.question, 'running');
assert.equal(runningQuestion.badgeText, '…');
assert.equal(runningQuestion.title, '正在答题…');

const captcha = describeActionIndicator({
  run: { status: 'paused', mode: 'everything', stage: 'checkin', lastError: 'captcha-required' },
  dailyStatus: { checkin: { completed: false }, question: { completed: false } },
  actions: [{ action: 'checkin', status: 'pending', lastResult: { reason: 'captcha-required' } }],
});
assert.equal(captcha.checkin, 'blocked');
assert.equal(captcha.question, 'pending');
assert.equal(captcha.badgeText, '!');
assert.equal(captcha.badgeColor, BADGE_COLORS.blocked);
assert.match(captcha.title, /Verify you are human/);

const login = describeActionIndicator({
  run: { status: 'paused', mode: 'question', stage: 'question', lastError: 'requires-login' },
  dailyStatus: { checkin: { completed: true }, question: { completed: false } },
  actions: [{ action: 'question', status: 'pending', lastResult: { status: 'login-blocked' } }],
});
assert.equal(login.checkin, 'hidden');
assert.equal(login.question, 'blocked');
assert.equal(login.badgeText, '!');
assert.equal(login.title, '需要登录一亩三分地');

const timeout = describeActionIndicator({
  run: { status: 'paused', mode: 'checkin', stage: 'checkin', lastError: 'timeout' },
  dailyStatus: { checkin: { completed: false }, question: { completed: false } },
  actions: [{ action: 'checkin', status: 'pending' }],
});
assert.equal(timeout.checkin, 'blocked');
assert.equal(timeout.question, 'hidden');
assert.equal(timeout.badgeText, '!');
assert.equal(timeout.title, '需要处理一亩三分地任务');

const bothDone = describeActionIndicator({
  run: { status: 'idle' },
  dailyStatus: { checkin: { completed: true }, question: { completed: true } },
  actions: [],
});
assert.equal(bothDone.checkin, 'hidden');
assert.equal(bothDone.question, 'hidden');
assert.equal(bothDone.badgeText, '');
assert.equal(bothDone.title, '今日签到和答题已完成');

const checkinOnlyDone = describeActionIndicator({
  run: { status: 'idle' },
  dailyStatus: { checkin: { completed: true }, question: { completed: false } },
  actions: [],
});
assert.equal(checkinOnlyDone.checkin, 'hidden');
assert.equal(checkinOnlyDone.question, 'hidden');
assert.equal(checkinOnlyDone.badgeText, '');
assert.equal(checkinOnlyDone.title, '今日已签到，待答题');

const starting = describeActionIndicator({
  run: { status: 'running', mode: 'everything', stage: null },
  dailyStatus: { checkin: { completed: false }, question: { completed: false } },
  actions: [],
});
assert.equal(starting.checkin, 'running');
assert.equal(starting.question, 'pending');
assert.equal(starting.badgeText, '…');
assert.equal(starting.title, '正在启动任务…');

const ctx = {
  beginPath() {},
  arc(...args) { this.calls.push(['arc', ...args]); },
  fill() { this.calls.push(['fill', this.fillStyle]); },
  fillStyle: '',
  calls: [],
};
assert.equal(drawIndicatorDots(ctx, 16, 'running', 'pending'), true);
assert.equal(ctx.calls.filter((item) => item[0] === 'arc').length, 4);

console.log('Action indicator tests passed.');
