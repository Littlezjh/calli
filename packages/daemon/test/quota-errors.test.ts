import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgyAdapter } from '../src/adapters/agy.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { glmQuotaExhausted, individualQuotaExhausted, quotaResetFrom } from '../src/adapters/quota-errors.js';
import { transientError } from '../src/proactive-advance.js';

/** The real strings the hub's own event log has recorded; see docs/auto-handover.md, 套餐耗尽证据. */
const GLM_PI = '429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-11-10 13:27:57 重置。"}';
const GLM_PI_WEEKLY = '429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-11-13 10:27:21 重置。"}';
const GLM_PI_UPSTREAM = 'insufficient_quota: upstream error: Your requests have exceeded the quota. (code=4008)';
const GLM_CLAUDE = 'Internal error: API Error: Request rejected (429) · ZCode: [1308][已达到 5 小时的使用上限。您的限额将在 2026-11-10 18:12:44 重置。][20261110142517c6e4a0023783416e]';
const INDIVIDUAL = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h45m44s.';

test('glm and individual quota exhaustion match only the plan wording', () => {
  for (const msg of [GLM_PI, GLM_PI_WEEKLY, GLM_PI_UPSTREAM, GLM_CLAUDE]) assert.equal(glmQuotaExhausted(msg), true, msg);
  assert.equal(individualQuotaExhausted(INDIVIDUAL), true);
  // Rate limits and other trouble stay transient failures, not a plan running out.
  for (const msg of [
    '429: {"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容"}',
    'stream disconnected before completion: We\'re sorry, your requests have exceeded the rate limit. Please wait and try again later',
    'exceeded retry limit, last status: 429 Too Many Requests',
    'API error (attempt 2): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server',
  ]) assert.equal(glmQuotaExhausted(msg), false, msg);
});

test('adapters classify the quota errors their gateways really ship', () => {
  const pi = new PiRpcAdapter([]);
  const agy = new AgyAdapter([]);
  const claude = new ClaudeAcpAdapter(['nonexistent-acp-for-quota-test']);
  assert.equal(pi.planExhausted(GLM_PI), true);
  assert.equal(pi.planExhausted(GLM_PI_UPSTREAM), true);
  assert.equal(pi.planExhausted('Request timed out.'), false);
  assert.equal(claude.planExhausted(GLM_CLAUDE), true);
  assert.equal(claude.planExhausted(INDIVIDUAL), true);
  assert.equal(claude.planExhausted("Internal error: You've hit your session limit · resets 5pm (UTC)"), true);
  assert.equal(claude.planExhausted('Authentication required'), false);
  assert.equal(agy.planExhausted(INDIVIDUAL), true);
  assert.equal(agy.planExhausted('You have exhausted your quota on this model.'), true);
  assert.equal(agy.planExhausted('agent executor error: generating and executing: tModel: model is empty'), false);
});

test('reset times come out of the quota messages themselves', () => {
  // The sample messages promise resets in their own past now; pin the reading time inside their window.
  const now = new Date('2026-11-10T02:00:00Z');
  // GLM datetimes are Beijing wall clock: 13:27:57 CST is 05:27:57 UTC.
  assert.equal(quotaResetFrom(GLM_PI, now), '2026-11-10T05:27:57.000Z');
  assert.equal(quotaResetFrom(GLM_CLAUDE, now), '2026-11-10T10:12:44.000Z');
  assert.equal(quotaResetFrom(INDIVIDUAL, now), '2026-11-10T06:45:44.000Z');
  assert.equal(quotaResetFrom("Internal error: You've hit your session limit · resets 5pm (UTC)", now), null);
  assert.equal(quotaResetFrom('Resets in 0h0m0s', now), null);
  assert.equal(quotaResetFrom('Resets in 900h0m0s', now), null);
});

test('transient failures keep excluding plan exhaustion, in wording and in code', () => {
  for (const msg of [GLM_PI, GLM_PI_WEEKLY, GLM_CLAUDE]) {
    assert.equal(transientError(null, msg), false, msg);
    assert.equal(transientError('plan_exhausted', msg), false);
  }
  for (const msg of [
    'API error (attempt 2): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server',
    'Selected model is at capacity. Please try a different model.',
    'We\'re sorry, the request queue size is exceed. Please wait and try again later.',
    'stream disconnected before completion: An error occurred while processing your request. You can retry your request',
    'Request timed out.',
    'Connection error.',
    'Internal error: upstream connection reset (request 23417)',
    'ZCode: connection lost mid-reply',
    'exceeded retry limit, last status: 429 Too Many Requests',
    'stream disconnected before completion: We\'re sorry, your requests have exceeded the rate limit. Please wait and try again later',
  ]) assert.equal(transientError(null, msg), true, msg);
  // Not transient: crashes, restarts, auth, permission and the coded failures.
  for (const [code, msg] of [['interrupted', 'The hub restarted while this turn was running.'], [null, 'codex app-server exited'],
    [null, 'Authentication required'], ['permission_refused', 'Antigravity refused RunCommand'], [null, 'terminated']]) {
    assert.equal(transientError(code, msg), false, `${code} ${msg}`);
  }
});

test('a gateway tells its model pools apart by provider prefix', () => {
  const claude = new ClaudeAcpAdapter(['nonexistent-acp-for-quota-test']);
  const pools = claude.separateModelPools!.bind(claude);
  // zcode/... rides the Coding Plan; deepseek/..., relay/... and the bridges bill elsewhere.
  assert.equal(pools('zcode/GLM-5.3', 'deepseek/deepseek-flash'), true);
  assert.equal(pools('zcode/GLM-5.3', 'relay/opensource/deepseek_v4_1_flash'), true);
  assert.equal(pools('zcode/GLM-5.3', 'traex-bridge/GPT-6.1-Sol'), true);
  // Two plan models share one pool; ids without a prefix say nothing about pools.
  assert.equal(pools('zcode/GLM-5.3', 'zcode/GLM-5.3-Flash'), false);
  assert.equal(pools('default', 'big'), false);
  assert.equal(pools('zcode/GLM-5.3', 'default'), false);
});
