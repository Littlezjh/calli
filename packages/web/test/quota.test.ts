import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlanQuota, QuotaWindow } from '../src/api.js';
import { formatReset, quotaHeadline, quotaLevel, quotaRows } from '../src/quota.js';

const win = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({ label: '5H', usedPercent: 0, ...over });

test('quotaLevel splits at half and at nearly full', () => {
  assert.deepEqual([0, 49, 50, 79, 80, 100].map(quotaLevel), ['ok', 'ok', 'warn', 'warn', 'danger', 'danger']);
});

test('formatReset is short today and names the day later', () => {
  const now = new Date('2026-10-10T09:00:00');
  const today = win({ resetsAt: '2026-10-10T14:40:00Z' });
  const later = win({ resetsAt: '2026-10-12T23:00:00Z' });
  // The test host's timezone decides the exact wording, but it always stays short.
  assert.match(formatReset(today, now), /^(\d{2}:\d{2}|\d+月\d+日 \d{2}:\d{2}) 重置$/);
  assert.match(formatReset(later, now), /^\d+月\d+日 \d{2}:\d{2} 重置$/);
  assert.equal(formatReset(win(), now), '');
  assert.equal(formatReset(win({ resetsAt: 'not a date' }), now), '');
});

test('quotaHeadline reports the tightest window', () => {
  const quota: PlanQuota = {
    windows: [win({ label: '7D', usedPercent: 40 }), win({ label: '5H', usedPercent: 95 })],
    checkedAt: '2026-10-10T00:00:00Z',
  };
  assert.equal(quotaHeadline(quota), '最紧的一档用了 95%');
  assert.equal(quotaHeadline({ windows: [], checkedAt: '2026-10-10T00:00:00Z' }), '没有读到额度信息');
});

test('quotaRows keeps agents that report quota and puts the one in use first', () => {
  const agents = [['claude', true], ['codex', true], ['plain', false], ['traex', true]].map(([id, quota]) => ({ id: id as string, capabilities: { quota: quota as boolean } }));
  const ids = (current?: string) => quotaRows(agents, current).map((a) => a.id);
  assert.deepEqual(ids(), ['claude', 'codex', 'traex']);
  assert.deepEqual(ids('traex'), ['traex', 'claude', 'codex']);
  assert.deepEqual(ids('plain'), ['claude', 'codex', 'traex']);
});
