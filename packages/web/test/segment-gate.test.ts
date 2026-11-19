import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankPress, dragPull, gateDirection, gateNeed, MOUSE_NEED, noPull, pageShift, pullProgress, pullReady, TOUCH_NEED } from '../src/segmentGate';
import { readingPath } from '../src/handover';
import type { Thread } from '../src/api';

const seg = (id: string, parent?: string) => ({ id, createdAt: id, handover: parent ? { sourceId: parent, mode: 'continue' } : null }) as Thread;

test('a drag past an edge counts damped and fills toward the threshold; only a full one turns the page', () => {
  assert.equal(dragPull(500, 200, 1), 150, 'a finger dragged up 300px is 150 of pull');
  assert.equal(pullReady({ dir: 1, amount: dragPull(500, 200, 1) }, 'touch'), true);
  assert.equal(pullReady({ dir: 1, amount: dragPull(500, 300, 1) }, 'touch'), false, '200px of finger is not enough');
  assert.equal(gateNeed('touch'), TOUCH_NEED);
  assert.equal(gateNeed('mouse'), MOUSE_NEED);
  assert.equal(pullReady({ dir: -1, amount: 169 }, 'mouse'), false);
  assert.equal(pullReady({ dir: -1, amount: 170 }, 'mouse'), true);
  assert.equal(pullProgress({ dir: 1, amount: 75 }, 'touch'), 0.5);
  assert.equal(pullProgress({ dir: 1, amount: 900 }, 'touch'), 1);
  assert.equal(pullProgress(noPull, 'touch'), 0);
});

test('dragging back gives back what was pulled, and the page follows with a cap', () => {
  assert.equal(dragPull(300, 500, 1), 0, 'the other way is no pull');
  assert.equal(dragPull(300, 500, -1), 100);
  assert.equal(pageShift({ dir: 1, amount: 100 }, 'touch'), -35);
  assert.equal(pageShift({ dir: -1, amount: 100 }, 'touch'), 35);
  assert.equal(pageShift({ dir: 1, amount: 1000 }, 'touch'), -TOUCH_NEED * 0.35, 'capped at the threshold');
  assert.equal(pageShift(noPull, 'mouse'), 0);
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

const node = (text: string | null, textual = false) => ({ closest: () => textual ? {} : null, childNodes: text === null ? [] : [{ nodeType: 3, textContent: text }] });
test('a mouse drag starts only on empty space, never on words or while text is selected', () => {
  assert.equal(blankPress(node(null), true), true, 'the margin beside the text, the room under a short segment');
  assert.equal(blankPress(node('  \n '), true), true, 'whitespace between elements is not text');
  assert.equal(blankPress(node('hello'), true), false, 'on words: selecting');
  assert.equal(blankPress(node(null, true), true), false, 'on code, buttons, links, fields');
  assert.equal(blankPress(node(null), false), false, 'something is selected: the drag belongs to it');
  assert.equal(blankPress(null, true), false);
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

test('opening an earlier segment preserves its handover boundary and the way into later follow-ups', () => {
  const a = seg('a'), b = seg('b', 'a'), c = seg('c', 'b');
  Object.assign(b.handover!, { sourceSeq: 40, followups: 3 });
  Object.assign(c.handover!, { sourceSeq: 70, followups: 1 });
  const later = (entry: { thread: Thread }) => entry.thread.id === 'a' ? { thread: b, followups: 0 } : entry.thread.id === 'b' ? { thread: c, followups: 0 } : undefined;
  const fromSource = readingPath({ thread: a }, [a, b, c], later);
  const fromHead = readingPath({ thread: c }, [a, b, c]);
  assert.deepEqual(fromSource, fromHead, 'every entry point reads the same bounded segments');
  assert.equal(fromSource[0].clip, 41);
  assert.equal(fromSource[0].followups, 3, 'native background turns remain available outside the chain');
  assert.equal(fromSource[1].clip, 71);
  assert.equal(fromSource[2].clip, undefined, 'the live head stays unbounded');
  assert.equal(readingPath({ thread: a }, [a, b, c], later, false)[0].clip, undefined, 'explicit standalone reading keeps all later turns');
});

test('a return supplied by laterOf clips its source even before the older thread is listed', () => {
  const a = seg('a'), b = seg('b', 'a');
  Object.assign(b.handover!, { sourceSeq: 10 });
  a.handback = { sourceId: 'b', afterSeq: 20, sourceSeq: 30, at: 'now' };
  const path = readingPath({ thread: b }, [b], entry => entry.thread.id === 'b' ? { thread: a, part: 'after', followups: 0 } : undefined);
  assert.deepEqual(path.map(entry => [entry.thread.id, entry.clip]), [['b', 31], ['a', undefined]]);
});
