import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestHandoverThread } from '../src/handover';
import type { Thread } from '../src/api';

const segment = (id: string, parent?: string) => ({ id, createdAt: id, handover: parent ? { sourceId: parent } : null }) as Thread;
test('latest handover recipient follows descendants, ignores unrelated branches and handles cycles', () => {
  const a = segment('a'), b = segment('b', 'a'), c = segment('c', 'b'), d = segment('d', 'a'), unrelated = segment('z');
  assert.equal(latestHandoverThread(a, [a, b, c, unrelated]).id, 'c');
  assert.equal(latestHandoverThread(b, [a, b, c, d, unrelated]).id, 'c');
  assert.equal(latestHandoverThread(c, [a, b, c]).id, 'c');
  assert.equal(latestHandoverThread(a, [a, { ...b, createdAt: a.createdAt }, { ...c, createdAt: a.createdAt }]).id, 'c', 'timestamps can tie; prefer a leaf');
  assert.equal(latestHandoverThread(a, []).id, 'a');
  assert.equal(latestHandoverThread(segment('a', 'c'), [segment('a', 'c'), b, c]).id, 'c');
});
