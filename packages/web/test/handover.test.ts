import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainEntries, handoverHistoryKey, laterSegment, latestHandoverThread, nextSegment, takeoverMention, cancellableHandover } from '../src/handover';
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

test('one local instance brought in with @ takes over only while the thread is out of plan', () => {
  const agent = { id: 'claude2', label: 'Claude Code 2', kind: 'agent' } as const;
  assert.equal(takeoverMention([agent], true, 'claude3'), agent);
  assert.equal(takeoverMention([agent], false, 'claude3'), null, 'a working lead is sent work as before');
  assert.equal(takeoverMention([agent, { id: 'pi', label: 'pi', kind: 'agent' }], true, 'claude3'), null);
  assert.equal(takeoverMention([{ id: 'm', label: 'worker', kind: 'member' }], true, 'claude3'), null);
  assert.equal(takeoverMention([{ ...agent, host: 'box' }], true, 'claude3'), null);
  assert.equal(takeoverMention([agent], true, 'claude2'), null, 'not the stranded instance itself');
  assert.equal(takeoverMention([], true), null);
});

test('reading on from an earlier segment goes through the chain toward the latest, not into another branch', () => {
  const a = segment('a'), b = segment('b', 'a'), c = segment('c', 'b'), side = segment('side', 'a'), unrelated = segment('z');
  const all = [a, b, c, side, unrelated];
  assert.equal(nextSegment(a, c, all)?.id, 'b');
  assert.equal(nextSegment(b, c, all)?.id, 'c');
  assert.equal(nextSegment(c, c, all), undefined, 'the latest has nothing after it');
  assert.equal(nextSegment(side, c, all), undefined, 'a branch that does not lead to the latest');
  assert.equal(nextSegment(unrelated, c, all), undefined);
  const loop = [segment('x', 'y'), segment('y', 'x')];
  assert.equal(nextSegment(unrelated, loop[0], [...loop, unrelated]), undefined, 'a broken cycle ends instead of spinning');
});

test('a conversation handed over to by hand follows its source only while the source has stood still', () => {
  const by = (id: string, over: Record<string, unknown> = {}, handover: Record<string, unknown> = {}) =>
    ({ id, createdAt: id, status: 'idle', handover: { sourceId: 'a', mode: 'branch', automatic: false, sourceMoved: false, ...handover }, ...over }) as unknown as Thread;
  const a = { id: 'a', createdAt: 'a', status: 'idle', handover: null } as unknown as Thread;
  const older = by('b1'), newer = by('b2');
  assert.equal(laterSegment(a, a, [a, older, newer])?.thread.id, 'b2', 'the newest conversation handed over to');
  assert.equal(laterSegment(a, a, [a, by('b', {}, { sourceMoved: true })]), undefined, 'the source went on after the handover');
  assert.equal(laterSegment(a, a, [a, by('b', {}, { sourceMoved: undefined })]), undefined, 'an older daemon does not say; stay independent');
  assert.equal(laterSegment({ ...a, status: 'running' } as Thread, a, [a, older]), undefined, 'the source is running a turn now');
  assert.equal(laterSegment(a, a, [a, by('b', {}, { detached: true })]), undefined, 'detached by the user');
  assert.equal(laterSegment(a, a, [a, by('b', {}, { automatic: true })]), undefined, 'a relay that diverged is not one by hand');
  // An automatic chain toward the latest takes precedence over a conversation started from the same source.
  const next = by('next', {}, { mode: 'continue', automatic: true });
  assert.equal(laterSegment(a, next, [a, next, older])?.thread.id, 'next');
  assert.equal(laterSegment(a, a, [a, by('other', {}, { sourceId: 'z' })]), undefined, 'handed over from another conversation');
});

test('only a handover made by hand from the dialog can be cancelled from the menu', () => {
  const link = { sourceId: 's', title: 'x', agent: 'a' };
  assert.equal(cancellableHandover({ handover: { ...link, mode: 'branch', automatic: false }, archivedAt: null }), true);
  assert.equal(cancellableHandover({ handover: { ...link, mode: 'branch', automatic: false }, archivedAt: '2026-11-14T00:00:00Z' }), false);
  assert.equal(cancellableHandover({ handover: { ...link, mode: 'continue', automatic: true, method: 'resume' }, archivedAt: null }), false);
  // An automatic handover shown as its own conversation after the source moved on is still automatic.
  assert.equal(cancellableHandover({ handover: { ...link, mode: 'branch', automatic: true, method: 'summary', sourceMoved: true }, archivedAt: null }), false);
  assert.equal(cancellableHandover({ handover: null, archivedAt: null }), false);
});

// A → B, then the work comes back to A: A's own part after the return is the head again.
const returned = () => {
  const a = { ...segment('a'), createdAt: '1', handback: { sourceId: 'b', afterSeq: 40, sourceSeq: 20, at: '9' } } as Thread;
  const b = { ...segment('b', 'a'), createdAt: '2' } as Thread;
  (b.handover as any).sourceSeq = 10; (b.handover as any).followups = 2;
  return { a, b };
};

test('a thread the chain came back to is the head again and appears twice in the chain, a loop ends', () => {
  const { a, b } = returned();
  assert.equal(latestHandoverThread(a, [a, b]).id, 'a');
  assert.equal(latestHandoverThread(b, [a, b]).id, 'a', 'from the middle the head is still the returned thread');
  const entries = chainEntries(a, [a, b]);
  assert.deepEqual(entries.map(e => `${e.thread.id}:${e.part ?? ''}`), ['a:before', 'b:', 'a:after']);
  // What each segment contributes: A up to where it handed over, B up to where the chain came back.
  assert.equal(entries[0].clip, 11);
  assert.equal(entries[1].clip, 21);
  assert.equal(entries[0].followups, 2, 'turns A took on its own after handing over');
  assert.equal(entries[2].clip, undefined);
  // The next segment after the earlier part of A is B, after B is A's later part, after that nothing.
  assert.equal(laterSegment(a, a, [a, b], 'before')?.thread.id, 'b');
  assert.equal(laterSegment(b, a, [a, b])?.part, 'after');
  assert.equal(laterSegment(a, a, [a, b], 'after'), undefined);
  // A continuation made from A after it came back makes A a parent again.
  const c = { ...segment('c', 'a'), createdAt: '3' } as Thread;
  (c.handover as any).sourceSeq = 50;
  assert.equal(latestHandoverThread(a, [a, b, c]).id, 'c');
  assert.deepEqual(chainEntries(c, [a, b, c]).map(e => `${e.thread.id}:${e.part ?? ''}`), ['a:before', 'b:', 'a:after', 'c:']);
  // Broken metadata: both ends returning to each other still ends.
  const x = { ...segment('x'), handback: { sourceId: 'y', afterSeq: 1, sourceSeq: 1, at: '1' } } as Thread;
  const y = { ...segment('y'), handback: { sourceId: 'x', afterSeq: 1, sourceSeq: 1, at: '2' } } as Thread;
  assert.ok(chainEntries(x, [x, y]).length <= 4);
});

test('the key of loaded ancestors changes when a thread is handed back to', () => {
  const { a, b } = returned();
  const key = handoverHistoryKey(b, [a, b]);
  a.handback = null;
  assert.notEqual(handoverHistoryKey(b, [a, b]), key);
});
