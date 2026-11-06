import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoFold, choicesFrom, initialMemberRows, memberProgress, missingImages, previewable, ROWS,
  shownImages, sortMembers, type FoldLine,
} from '../src/components/ThreadOverview.js';
import type { Coordination, OutputFile, Thread } from '../src/api.js';

/** A member with as much of a thread behind it as the ordering looks at. */
const member = (name: string, thread: Partial<Thread> | null, state?: string, result = ''): Coordination['members'][number] =>
  ({ id: name, name, thread: thread === null ? null : { ...thread } as Thread, latest: state ? { state, result } as Coordination['messages'][number] : null });

const file = (path: string, missing?: true): OutputFile => ({ path, turnId: 't1', at: '2026-01-01T00:00:00Z', ...(missing ? { missing } : {}) });

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

test('the first rows are the members worth seeing: need, failed, running; otherwise the first three', () => {
  const need = member('need', { status: 'idle' }, 'returned', '[进度] 需要你：看这里');
  const failed = member('failed', { status: 'idle' }, 'failed');
  const running = member('running', { status: 'running' });
  const review = member('review', { status: 'idle' }, 'returned', '[进度] 待验收');
  const idle = member('idle', { status: 'idle' }, 'returned', '好了。');
  // The attention rows are shown before anything else, and the rest wait behind "show more".
  assert.equal(initialMemberRows([review, idle, need, failed, running]), 3);
  // Nothing asks for the user: three rows, or everything when there is less.
  assert.equal(initialMemberRows([review, idle, review]), ROWS);
  assert.equal(initialMemberRows([review, idle]), 2);
  assert.equal(initialMemberRows([]), 0);
  // A member already reporting progress is not an attention row; a running thread is.
  assert.equal(initialMemberRows([member('p', { status: 'idle' }, 'returned', '[进度] 进行中'), running]), 1);
});

test('the height budget folds from the last group up, leaving the agents and the user’s choices alone', () => {
  const groups: FoldLine[] = [
    { id: 'agents', openLines: 4, keep: true },
    { id: 'plan', openLines: 4 },
    { id: 'changes', openLines: 8 },
    { id: 'images', openLines: 4 },
    { id: 'files', openLines: 3 },
  ];
  // Room for everything: nothing folds.
  assert.deepEqual(autoFold(groups, 30), { agents: true, plan: true, changes: true, images: true, files: true });
  // Too tall: files go first, then images, then changes, until the lines fit.
  assert.deepEqual(autoFold(groups, 12), { agents: true, plan: true, changes: false, images: false, files: false });
  // A group the user unfolded by hand is never folded by the budget; the next one up gives way.
  assert.deepEqual(autoFold(groups, 12, { changes: false }), { agents: true, plan: false, changes: true, images: false, files: false });
  // A group the user folded stays folded, and counts as its one title line.
  assert.deepEqual(autoFold(groups, 30, { plan: true }), { agents: true, plan: false, changes: true, images: true, files: true });
  // The agents are never folded by the budget, however little room is left.
  assert.deepEqual(autoFold(groups, 1), { agents: true, plan: false, changes: false, images: false, files: false });
  // "Show more" in a section pins it open too.
  assert.deepEqual(autoFold(groups, 12, {}, new Set(['changes'])), { agents: true, plan: false, changes: true, images: false, files: false });
  // A folded group already saves its lines whatever the budget is.
  assert.deepEqual(autoFold([{ id: 'agents', openLines: 2, keep: true }, { id: 'files', openLines: 2 }], 3, { files: true }), { agents: true, files: false });
});

test('the fold choices a device remembers come back as a map; an older page’s list still counts as folded', () => {
  assert.deepEqual(choicesFrom('["images","files"]'), { images: true, files: true });
  assert.deepEqual(choicesFrom('{"plan":false,"changes":true}'), { plan: false, changes: true });
  assert.deepEqual(choicesFrom('[]'), {});
  assert.deepEqual(choicesFrom(null), {});
  assert.deepEqual(choicesFrom('nonsense'), {});
  // A value that is not a choice is ignored rather than guessed at.
  assert.deepEqual(choicesFrom('{"plan":"yes","files":true}'), { files: true });
});

test('missing pictures leave the grid, and a page or a drawing still on disk can be previewed', () => {
  const images = [file('shots/a.png'), file('shots/b.svg', true), file('shots/c.jpg')];
  assert.deepEqual(shownImages(images).map((image) => image.path), ['shots/a.png', 'shots/c.jpg']);
  assert.deepEqual(missingImages(images).map((image) => image.path), ['shots/b.svg']);
  assert.equal(previewable(file('docs/page.html')), true);
  assert.equal(previewable(file('docs/page.htm')), true);
  assert.equal(previewable(file('icons/logo.SVG')), true);
  assert.equal(previewable(file('src/main.ts')), false);
  // Gone from the disk is gone from the preview too.
  assert.equal(previewable(file('docs/page.html', true)), false);
});
