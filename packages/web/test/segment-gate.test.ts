import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPull, gateDirection, gateNeed, noPull, pullProgress, pullReady, segmentPosition, touchPull, TOUCH_NEED, WHEEL_NEED } from '../src/segmentGate';
import { readingPath } from '../src/handover';
import type { Thread } from '../src/api';

const seg = (id: string, parent?: string) => ({ id, createdAt: id, handover: parent ? { sourceId: parent, mode: 'continue' } : null }) as Thread;

test('a pull fills toward the threshold and turns the page only when full', () => {
  let pull = addPull(noPull, 1, 100);
  assert.equal(pullReady(pull, 'wheel'), false);
  assert.ok(Math.abs(pullProgress(pull, 'wheel') - 100 / WHEEL_NEED) < 1e-9);
  pull = addPull(pull, 1, 200);
  assert.equal(pullReady(pull, 'wheel'), true);
  assert.equal(pullProgress(pull, 'wheel'), 1);
  assert.equal(gateNeed('touch'), TOUCH_NEED);
  assert.equal(pullReady({ dir: 1, amount: 100 }, 'touch'), false, 'a finger needs less than a wheel, but not this little');
  assert.equal(pullReady({ dir: 1, amount: 110 }, 'touch'), true);
});

test('pulling the other way starts over, and sign does not matter', () => {
  const down = addPull(noPull, 1, 200);
  assert.deepEqual(addPull(down, -1, -50), { dir: -1, amount: 50 });
  assert.deepEqual(addPull(noPull, 1, -30), { dir: 1, amount: 30 });
});

test('a finger past an edge counts damped and only in the direction of the turn', () => {
  assert.equal(touchPull(500, 300, 1), 120, 'dragging up 200px is 120 of pull toward the next segment');
  assert.equal(touchPull(300, 500, -1), 120);
  assert.equal(touchPull(300, 500, 1), 0, 'going back the other way gives back what was pulled');
});

test('only an edge with a segment beyond it turns the page', () => {
  const all = { atTop: true, atBottom: true, hasPrev: true, hasNext: true };
  assert.equal(gateDirection(5, all), 1);
  assert.equal(gateDirection(-5, all), -1);
  assert.equal(gateDirection(5, { ...all, atBottom: false }), 0, 'still scrolling the page');
  assert.equal(gateDirection(5, { ...all, hasNext: false }), 0, 'the latest segment has nothing below');
  assert.equal(gateDirection(-5, { ...all, hasPrev: false }), 0, 'the chain begins here');
  assert.equal(gateDirection(-5, { ...all, atTop: false }), 0, 'older messages of the segment come first');
  assert.equal(gateDirection(0, all), 0);
});

test('position in the chain is one-based and unknown outside it', () => {
  assert.deepEqual(segmentPosition(['a:after', 'b:after', 'c:after'], 'b:after'), { index: 2, total: 3 });
  assert.equal(segmentPosition(['a:after'], 'z:after'), null);
});

test('the pages of a chain run from the earliest known segment through what reading on goes into', () => {
  const a = seg('a'), b = seg('b', 'a'), c = seg('c', 'b');
  const later = (entry: { thread: Thread }) => entry.thread.id === 'a' ? { thread: b, followups: 0 } : entry.thread.id === 'b' ? { thread: c, followups: 0 } : undefined;
  assert.deepEqual(readingPath({ thread: b }, [a, b, c], later).map(e => e.thread.id), ['a', 'b', 'c']);
  assert.deepEqual(readingPath({ thread: a }, [a, b, c], later).map(e => e.thread.id), ['a', 'b', 'c']);
  assert.deepEqual(readingPath({ thread: b }, [a, b, c], later, false).map(e => e.thread.id), ['b', 'c'], 'one segment alone does not bring in the ones before it');
  assert.deepEqual(readingPath({ thread: c }, [a, b, c]).map(e => e.thread.id), ['a', 'b', 'c']);
});

test('a loop of relations does not repeat a page', () => {
  const a = seg('a', 'b'), b = seg('b', 'a');
  const loop = (entry: { thread: Thread }) => ({ thread: entry.thread.id === 'a' ? b : a, followups: 0 });
  const ids = readingPath({ thread: a }, [a, b], loop).map(e => e.thread.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a segment the list does not have still reads as the only page', () => {
  const orphan = seg('x', 'gone');
  assert.deepEqual(readingPath({ thread: orphan }, [orphan]).map(e => e.thread.id), ['x']);
});
