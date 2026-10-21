import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoverHistoryKey, latestHandoverThread } from '../src/handover';
import type { Thread } from '../src/api';

const segment = (id: string, parent?: string) => ({ id, createdAt: id, handover: parent ? { sourceId: parent, mode: 'continue' } : null }) as Thread;
test('latest handover recipient follows descendants, ignores unrelated branches and handles cycles', () => {
  const a = segment('a'), b = segment('b', 'a'), c = segment('c', 'b'), d = segment('d', 'a'), unrelated = segment('z');
  assert.equal(latestHandoverThread(a, [a, b, c, unrelated]).id, 'c');
  assert.equal(latestHandoverThread(b, [a, b, c, d, unrelated]).id, 'c');
  assert.equal(latestHandoverThread(c, [a, b, c]).id, 'c');
  assert.equal(latestHandoverThread(a, [a, { ...b, createdAt: a.createdAt }, { ...c, createdAt: a.createdAt }]).id, 'c', 'timestamps can tie; prefer a leaf');
  assert.equal(latestHandoverThread(a, []).id, 'a');
  assert.equal(latestHandoverThread(segment('a', 'c'), [segment('a', 'c'), b, c]).id, 'c');
});


test('branch relations leave each conversation independent and reset loaded ancestors', () => {
  const a = segment('a'), b = segment('b', 'a'), c = segment('c', 'b');
  const key = handoverHistoryKey(c, [a, b, c]);
  b.handover!.mode = 'branch';
  assert.equal(latestHandoverThread(a, [a, b, c]).id, 'a');
  assert.equal(latestHandoverThread(b, [a, b, c]).id, 'c');
  assert.notEqual(handoverHistoryKey(c, [a, b, c]), key);
  delete b.handover!.mode;
  assert.equal(latestHandoverThread(a, [a, b, c]).id, 'a');
});
