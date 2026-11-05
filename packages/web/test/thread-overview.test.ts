import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldedFrom, memberProgress, sortMembers } from '../src/components/ThreadOverview.js';
import type { Coordination, Thread } from '../src/api.js';

/** A member with as much of a thread behind it as the ordering looks at. */
const member = (name: string, thread: Partial<Thread> | null, state?: string, result = ''): Coordination['members'][number] =>
  ({ id: name, name, thread: thread === null ? null : { ...thread } as Thread, latest: state ? { state, result } as Coordination['messages'][number] : null });

test("a member's state is the word its last report ended with, read the way the conversation reads it", () => {
  assert.equal(memberProgress(member('need', { status: 'idle' }, 'returned', '深色取值等你确认。\n[进度] 需要你：确认取值')), 'need');
  assert.equal(memberProgress(member('review', { status: 'idle' }, 'returned', '核对完了，请验收。\n[进度] 待验收：接口和测试都交回')), 'review');
  assert.equal(memberProgress(member('progress', { status: 'idle' }, 'returned', '还在查。\n[进度] 进行中')), 'progress');
  // A delivery that died says so, whatever it meant to say.
  assert.equal(memberProgress(member('failed', { status: 'error' }, 'failed', '核对完了，请验收。\n[进度] 待验收：接口和测试都交回')), 'failed');
  // A report that ends without the protocol leaves the member to its own status word.
  assert.equal(memberProgress(member('plain', { status: 'idle' }, 'returned', '核对完了，接口和测试都交回，请验收。')), null);
  assert.equal(memberProgress(member('bare', null)), null);
});

test('members line up by who needs the user first, keeping their order within a rank', () => {
  const idle = member('idle', { status: 'idle' }, 'returned', '核对完了。');
  const queued = member('queued', { status: 'idle' }, 'queued');
  const running = member('running', { status: 'running' }, 'returned', '[进度] 进行中');
  const failed = member('failed', { status: 'idle' }, 'failed', '');
  const need = member('need', { status: 'idle' }, 'returned', '深色取值等你确认。\n[进度] 需要你：确认取值');
  const review = member('review', { status: 'idle' }, 'returned', '核对完了，请验收。\n[进度] 待验收：接口和测试都交回');
  // Waiting on the user no longer leads the line: what a member asked for in its own words does.
  const waiting = member('waiting', { status: 'idle', waiting: true });
  const running2 = member('running2', { status: 'running' });

  assert.deepEqual(
    sortMembers([idle, running2, queued, running, failed, waiting, review, need]).map((m) => m.name),
    ['need', 'failed', 'running2', 'running', 'queued', 'review', 'idle', 'waiting'],
  );
  // A call for the user outranks everything, even a failure or a queue.
  assert.deepEqual(sortMembers([failed, waiting, need, running]).map((m) => m.name), ['need', 'failed', 'running', 'waiting']);
  // The input keeps its order; only the answer is arranged.
  const input = [idle, need];
  sortMembers(input);
  assert.deepEqual(input.map((m) => m.name), ['idle', 'need']);
  // A member with no thread at all is simply one of the rest.
  assert.deepEqual(sortMembers([member('gone', null), need]).map((m) => m.name), ['need', 'gone']);
});

test('the folded sections a device remembers come back, and anything else unfolds everything', () => {
  const store = (value: string | null) => ({ getItem: (key: string) => key === 'calli.overview.folded' ? value : null });
  assert.deepEqual([...foldedFrom(store('["images","files"]'))].sort(), ['files', 'images']);
  assert.equal(foldedFrom(store('[]')).size, 0);
  assert.equal(foldedFrom(store(null)).size, 0);
  assert.equal(foldedFrom(store('nonsense')).size, 0);
  // Unknown sections are kept as they are written; the card only asks after its own.
  assert.equal(foldedFrom(store('["changes"]')).size, 1);
});
