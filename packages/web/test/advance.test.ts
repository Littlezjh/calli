import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceClock, advanceStatus } from '../src/advance.js';

// The quiet line under a thread's last turn: what the hub will do on its own, and when.

const today = (hour: number, minute: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString();
};
const otherDay = (hour: number, minute: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute).toISOString();
};

test('a wait says what it waits for and when to look again', () => {
  assert.equal(advanceStatus({ reason: 'wait', attempts: 0, max: 6, nextAt: today(14, 20), what: '等 CI 跑完' }),
    '等 CI 跑完 · 14:20 再看');
  // A note that said only how long still gets a subject; a later day carries its date.
  assert.match(advanceStatus({ reason: 'wait', attempts: 3, max: 6, nextAt: otherDay(9, 5) }),
    /^等外部条件 · \d{1,2}\/\d{1,2} \d{2}:\d{2} 再看$/);
});

test('a continue counts the attempt that has not happened yet', () => {
  assert.equal(advanceStatus({ reason: 'continue', attempts: 0, max: 3, nextAt: today(14, 5) }),
    '自动继续 第 1/3 次 · 14:05');
  assert.equal(advanceStatus({ reason: 'continue', attempts: 2, max: 3, nextAt: today(15, 0) }),
    '自动继续 第 3/3 次 · 15:00');
});

test('the clock keeps today short and dates a later day', () => {
  const now = new Date(2026, 10, 14, 10, 0);
  assert.equal(advanceClock(new Date(2026, 10, 14, 14, 20).toISOString(), now), '14:20');
  assert.equal(advanceClock(new Date(2026, 10, 15, 9, 5).toISOString(), now), '11/15 09:05');
  assert.equal(advanceClock('not a date', now), '');
});
