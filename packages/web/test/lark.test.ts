import { test } from 'node:test';
import assert from 'node:assert/strict';
import { larkHealth, realtimeLine, signalDestination } from '../src/lark.js';

const channel = { enabled: true, people: [], chats: [], intervalMin: 30 };
const status = { cli: true, loggedIn: true, lastRunAt: null, nextRunAt: null, lastError: null, lastSignals: 0 };

test('the channel reads as off, missing, logged out, failing or fine', () => {
  assert.equal(larkHealth(null, null), 'off');
  assert.equal(larkHealth({ ...channel, enabled: false }, status), 'off');
  assert.equal(larkHealth(channel, null), 'off');
  assert.equal(larkHealth(channel, { ...status, cli: false }), 'no-cli');
  assert.equal(larkHealth(channel, { ...status, loggedIn: false }), 'no-login');
  assert.equal(larkHealth(channel, { ...status, lastError: 'cli_timeout' }), 'failed');
  assert.equal(larkHealth(channel, { ...status, lastError: 'cli_missing' }), 'no-cli');
  assert.equal(larkHealth(channel, { ...status, lastError: 'lark_auth_failed' }), 'no-login');
  assert.equal(larkHealth(channel, { ...status, lastError: 'personal agent is not configured' }), 'no-agent');
  assert.equal(larkHealth(channel, status), 'ok');
});

test('the realtime line is quiet when live, warns when events are not coming in, and is absent while it settles', () => {
  assert.deepEqual(realtimeLine('live'), { text: '实时', warn: false });
  assert.deepEqual(realtimeLine('busy-elsewhere'), { text: '事件通道被其他机器占用，10 分钟自动重试', warn: true });
  assert.deepEqual(realtimeLine('console-off'), { text: '飞书后台未开启消息事件', warn: true });
  assert.deepEqual(realtimeLine('unavailable'), { text: 'lark-cli 未登录或缺失', warn: true });
  assert.deepEqual(realtimeLine('error'), { text: '实时通道出错，自动重连中', warn: true });
  assert.equal(realtimeLine('connecting'), null);
  assert.equal(realtimeLine('off'), null);
  assert.equal(realtimeLine(undefined), null, 'an older hub says nothing about it');
});

test('a signal says where it went, and why it was filtered', () => {
  assert.equal(signalDestination({ outcome: 'delivered' }), '已直投给工作线程');
  assert.equal(signalDestination({ outcome: 'router', reason: 'legacy-seen' }), '送了助手');
  assert.equal(signalDestination({ outcome: 'filtered', reason: 'not-a-request' }), '被过滤：不是在找你');
  assert.equal(signalDestination({ outcome: 'filtered', reason: 'bot-message' }), '被过滤：bot-message', 'a reason this client has no words for still shows');
  assert.equal(signalDestination({ outcome: 'filtered' }), '被过滤');
});
