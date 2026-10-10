import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  durationLabel,
  groupByTurn,
  splitThinking,
  stepDurationLabel,
  stepStatusLabel,
  stepTitle,
  toMarkdown,
  turnPreviews,
  type StoredEvent,
} from '../src/timeline.js';

let seq = 0;
function ev(type: string, data: Record<string, any> = {}, turnId: string | null = 't1', ts = '2026-10-10T00:00:00.000Z'): StoredEvent {
  seq += 1;
  return { threadId: 'th', seq, turnId, type, ts, data };
}

test('user text and streamed assistant text are grouped per turn', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'hi' }),
    ev('message.delta', { text: 'Hel' }),
    ev('message.delta', { text: 'lo' }),
    ev('turn.done', { stopReason: 'end_turn' }),
  ]);
  assert.equal(tl.running, false);
  assert.deepEqual(
    tl.items.map((i) => i.kind),
    ['user', 'assistant', 'actions'],
  );
  const a = tl.items[1];
  assert.equal(a.kind === 'assistant' && a.text, 'Hello');
  assert.equal(a.kind === 'assistant' && a.done, true);
});

test('tool steps are grouped in a work item and text after tools starts a new assistant item', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'do it' }),
    ev('reasoning.delta', { text: 'thinking' }),
    ev('tool.start', { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress', input: { command: 'ls' } }),
    ev('tool.end', { id: 'a', status: 'completed', output: 'a.txt' }),
    ev('message.delta', { text: 'done' }),
    ev('turn.done', {}),
  ]);
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'work', 'assistant', 'actions']);
  const work = tl.items[1];
  assert.equal(work.kind, 'work');
  if (work.kind !== 'work') return;
  assert.equal(work.reasoning, 'thinking');
  assert.equal(work.steps.length, 1);
  assert.equal(work.steps[0].status, 'completed');
  assert.equal(work.steps[0].output, 'a.txt');
  assert.equal(work.done, true);
});

test('tool.update changes status without creating a new step', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'x' }),
    ev('tool.start', { id: 'b', title: 'read', kind: 'read' }),
    ev('tool.update', { id: 'b', status: 'in_progress', output: 'partial' }),
  ]);
  const work = tl.items[1];
  assert.equal(work.kind === 'work' && work.steps.length, 1);
  assert.equal(work.kind === 'work' && work.steps[0].output, 'partial');
  assert.equal(tl.running, true);
});

test('approval is shown and its decision is attached when resolved', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'x' }),
    ev('approval.request', { approvalId: 'ap1', title: 'Edit file', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }),
    ev('approval.resolved', { approvalId: 'ap1', decision: { optionId: 'allow' } }),
  ]);
  const item = tl.items[1];
  assert.equal(item.kind, 'approval');
  assert.deepEqual(item.kind === 'approval' && item.decision, { optionId: 'allow' });
});

test('turn.error adds an error item and clears running', () => {
  seq = 0;
  const tl = buildTimeline([ev('turn.started', { text: 'x' }), ev('turn.error', { message: 'boom' })]);
  assert.equal(tl.running, false);
  assert.equal(tl.items.at(-1)?.kind, 'error');
});

test('lastSeq tracks the highest seq seen so the stream can resume', () => {
  seq = 0;
  const tl = buildTimeline([ev('turn.started', { text: 'x' }), ev('message.delta', { text: 'y' })]);
  assert.equal(tl.lastSeq, 2);
  assert.equal(buildTimeline([]).lastSeq, 0);
});

test('durationLabel formats seconds and minutes', () => {
  assert.equal(durationLabel('2026-10-10T00:00:00Z', '2026-10-10T00:00:25Z'), '25 秒');
  assert.equal(durationLabel('2026-10-10T00:00:00Z', '2026-10-10T00:05:25Z'), '5 分 25 秒');
  assert.equal(durationLabel('2026-10-10T00:00:00Z', null), '');
});

const diff = (path: string, oldText: string | null, newText: string) => ({ type: 'diff', path, oldText, newText });

test('a finished answer gets an action row carrying its text; a running or failed turn does not', () => {
  seq = 0;
  const done = buildTimeline([ev('turn.started', { text: 'q' }), ev('message.delta', { text: 'first' }), ev('tool.start', { id: 't' }), ev('message.delta', { text: 'final answer' }), ev('turn.done', {})]);
  const actions = done.items.at(-1);
  assert.equal(actions?.kind === 'actions' && actions.text, 'final answer', 'copies the last message, not the first');

  seq = 0;
  const live = buildTimeline([ev('turn.started', { text: 'q' }), ev('message.delta', { text: 'typing' })]);
  assert.equal(live.items.some((i) => i.kind === 'actions'), false);

  seq = 0;
  const failed = buildTimeline([ev('turn.started', { text: 'q' }), ev('message.delta', { text: 'partial' }), ev('turn.error', { message: 'boom' })]);
  assert.equal(failed.items.some((i) => i.kind === 'actions'), false);
});

test('user images are kept on the user item', () => {
  seq = 0;
  const tl = buildTimeline([ev('turn.started', { text: 'look', images: [{ id: 'a1', mimeType: 'image/png', size: 10 }] })]);
  const user = tl.items[0];
  assert.deepEqual(user.kind === 'user' && user.images.map((i) => i.id), ['a1']);
  seq = 0;
  const plain = buildTimeline([ev('turn.started', { text: 'hi' })]).items[0];
  assert.deepEqual(plain.kind === 'user' && plain.images, []);
});

test('completed edits are summed per file into one changes item at the end of the turn', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'edit' }),
    ev('tool.start', { id: 'a', title: 'Edit', kind: 'edit', status: 'pending' }),
    ev('tool.update', { id: 'a', content: [diff('/w/src/app.ts', 'a\nb', 'a\nB\nc')] }),
    ev('tool.end', { id: 'a', status: 'completed', output: 'ok' }),
    ev('tool.start', { id: 'b', title: 'Write', kind: 'edit', content: [diff('/w/new.txt', null, 'x\ny\nz')] }),
    ev('tool.end', { id: 'b', status: 'completed' }),
    ev('tool.start', { id: 'c', title: 'Edit', kind: 'edit', content: [diff('/w/src/app.ts', 'q', 'r')] }),
    ev('tool.end', { id: 'c', status: 'completed' }),
    ev('message.delta', { text: 'done' }),
    ev('turn.done', {}),
  ]);
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'work', 'assistant', 'changes', 'actions']);
  const changes = tl.items[3];
  assert.equal(changes.kind, 'changes');
  if (changes.kind !== 'changes') return;
  assert.deepEqual(changes.files.map((f) => [f.path, f.added, f.removed, f.diffs.length]), [
    ['/w/src/app.ts', 3, 2, 2],
    ['/w/new.txt', 3, 0, 1],
  ]);
  assert.deepEqual([changes.added, changes.removed], [6, 2]);
  // The step keeps its text output, and the diff is not duplicated into it.
  const work = tl.items[1];
  assert.equal(work.kind === 'work' && work.steps[0].output, 'ok');
  assert.equal(work.kind === 'work' && work.steps[0].diffs.length, 1);
});

test('edits that failed, were refused, or are still pending are not counted as changes', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'edit' }),
    ev('tool.start', { id: 'a', kind: 'edit', content: [diff('/w/a.ts', 'x', 'y')] }),
    ev('tool.end', { id: 'a', status: 'failed' }),
    ev('tool.start', { id: 'b', kind: 'edit', status: 'pending', content: [diff('/w/b.ts', 'x', 'y')] }),
  ]);
  assert.equal(tl.items.some((i) => i.kind === 'changes'), false);
});

test('each turn gets its own changes item, placed before the next user message', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'one' }, 't1'),
    ev('tool.start', { id: 'a', kind: 'edit', content: [diff('/w/a.ts', null, 'x')] }, 't1'),
    ev('tool.end', { id: 'a', status: 'completed' }, 't1'),
    ev('turn.done', {}, 't1'),
    ev('turn.started', { text: 'two' }, 't2'),
    ev('message.delta', { text: 'nothing to change' }, 't2'),
    ev('turn.done', {}, 't2'),
  ]);
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'work', 'changes', 'user', 'assistant', 'actions']);
});

test('an approval shows the diff or the command it is asking about, and marks the timeline as waiting', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'x' }),
    ev('approval.request', { approvalId: 'w', title: 'Write /w/a.txt', options: [], toolCall: { kind: 'edit', content: [diff('/w/a.txt', null, 'alpha\nbeta')] } }),
    ev('approval.request', { approvalId: 'c', title: 'Run', options: [], toolCall: { kind: 'execute', rawInput: { command: 'npm run build' } } }),
  ]);
  const [, write, run] = tl.items;
  assert.equal(write.kind === 'approval' && write.diffs[0].added, 2);
  assert.equal(write.kind === 'approval' && write.command, null);
  assert.equal(run.kind === 'approval' && run.command, 'npm run build');
  assert.equal(tl.awaitingApproval, true);

  seq = 0;
  const answered = buildTimeline([
    ev('turn.started', { text: 'x' }),
    ev('approval.request', { approvalId: 'w', title: 't', options: [], toolCall: {} }),
    ev('approval.resolved', { approvalId: 'w', decision: { optionId: 'allow' } }),
  ]);
  assert.equal(answered.awaitingApproval, false);
});

test('toMarkdown writes the conversation with file changes and without tool noise', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'fix it', images: [{ id: 'a', mimeType: 'image/png' }] }),
    ev('reasoning.delta', { text: 'thinking hard' }),
    ev('tool.start', { id: 'a', kind: 'edit', content: [diff('src/a.ts', 'x', 'y')] }),
    ev('tool.end', { id: 'a', status: 'completed', output: 'tool noise' }),
    ev('message.delta', { text: 'Fixed.' }),
    ev('turn.done', {}),
  ]);
  const md = toMarkdown('My thread', tl.items);
  assert.ok(md.startsWith('# My thread\n\n## 你\n\nfix it\n\n（附 1 张图片）\n\nFixed.'), md);
  assert.ok(md.includes('**已更改 1 个文件** (+1 −1)\n- `src/a.ts` +1 −1'));
  assert.equal(md.includes('thinking hard') || md.includes('tool noise'), false);
});

test('turns imported from history show their steps without a duration; new turns are timed', () => {
  seq = 0;
  const { items, running } = buildTimeline([
    ev('thread.created', { imported: true }, null),
    ev('turn.started', { text: 'earlier question', imported: true }, 'old'),
    ev('tool.start', { id: 't1', title: 'ls', kind: 'execute', status: 'in_progress' }, 'old'),
    ev('tool.end', { id: 't1', status: 'completed', output: 'a.txt' }, 'old'),
    ev('message.delta', { text: 'earlier answer' }, 'old'),
    ev('turn.done', { stopReason: 'end_turn', imported: true }, 'old'),
    ev('turn.started', { text: 'next' }, 'new'),
    ev('reasoning.delta', { text: 'thinking' }, 'new'),
    ev('turn.done', { stopReason: 'end_turn' }, 'new'),
  ]);
  assert.equal(running, false);
  const work = items.flatMap((it) => (it.kind === 'work' ? [[it.turnId, it.timed, it.done]] : []));
  assert.deepEqual(work, [['old', false, true], ['new', true, true]]);
  // Imported answers get the same action row as any other finished answer.
  assert.ok(items.some((it) => it.kind === 'actions' && it.turnId === 'old' && it.text === 'earlier answer'));
});

test('a turn refused for lack of permission explains the way out; other errors are shown as reported', () => {
  seq = 0;
  const { items } = buildTimeline([
    ev('turn.started', { text: 'run it' }, 'a'),
    ev('turn.error', { message: 'Antigravity refused RunCommand: …', code: 'permission_refused', refused: ['RunCommand', 'WriteFile'] }, 'a'),
    ev('turn.started', { text: 'again' }, 'b'),
    ev('turn.error', { message: 'quota exceeded' }, 'b'),
  ]);
  const errors = items.flatMap((it) => (it.kind === 'error' ? [it.message] : []));
  assert.match(errors[0], /RunCommand、WriteFile/);
  assert.match(errors[0], /完全访问/);
  assert.equal(errors[1], 'quota exceeded');
});

import { imagePathsIn, usageSummary } from '../src/timeline.js';

test('a plan is one item per turn, updated in place, and does not open a work group', () => {
  seq = 0;
  const entries = (statuses: string[]) => statuses.map((status, i) => ({ content: `step ${i + 1}`, status, priority: 'medium' }));
  const { items } = buildTimeline([
    ev('turn.started', { text: 'do it' }, 'a'),
    ev('plan.updated', { entries: entries(['in_progress', 'pending']) }, 'a'),
    ev('tool.start', { id: 't', title: 'ls', kind: 'execute' }, 'a'),
    ev('plan.updated', { entries: entries(['completed', 'in_progress']) }, 'a'),
    ev('turn.done', {}, 'a'),
    ev('turn.started', { text: 'again' }, 'b'),
    ev('plan.updated', { entries: [] }, 'b'),
    ev('plan.updated', { entries: entries(['pending']) }, 'b'),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'plan', 'work', 'user', 'plan']);
  const [first, second] = items.filter((i) => i.kind === 'plan') as Array<Extract<(typeof items)[number], { kind: 'plan' }>>;
  assert.deepEqual(first.entries.map((e) => e.status), ['completed', 'in_progress'], 'the later update replaced the earlier one');
  assert.equal(first.done, true);
  assert.deepEqual([second.turnId, second.entries.length, second.done], ['b', 1, false], 'an empty plan does not make a card');
});

test('usage is the latest the agent reported; the summary rounds it and flags a nearly full context', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'hi' }),
    ev('usage.updated', { used: 1000, size: 200000 }),
    ev('usage.updated', { used: 52000, size: 200000, cost: { amount: 0.4231, currency: 'USD' } }),
    ev('usage.updated', { used: 5, size: 0 }),
    ev('turn.done', {}),
  ]);
  assert.deepEqual(tl.usage, { used: 52000, size: 200000, cost: { amount: 0.4231, currency: 'USD' } });
  assert.deepEqual(usageSummary(tl.usage!), { percent: 26, high: false, detail: '上下文已用 52k / 200k · $0.42' });
  assert.deepEqual(usageSummary({ used: 900_000, size: 1_000_000 }), { percent: 90, high: true, detail: '上下文已用 900k / 1.0M' });
  assert.equal(usageSummary({ used: 3_000_000, size: 1_000_000 }).percent, 100);
  assert.equal(buildTimeline([]).usage, null);
});

test('imagePathsIn finds local image files in an answer and leaves web addresses alone', () => {
  assert.deepEqual(imagePathsIn('Saved to /work/app/out/chart.png and also `docs/logo.webp`.'), ['/work/app/out/chart.png', 'docs/logo.webp']);
  assert.deepEqual(imagePathsIn('![the chart](out/chart.png "Chart")\n\n![remote](https://example.com/a.png)'), ['out/chart.png']);
  assert.deepEqual(imagePathsIn('图片在：/work/图表/结果.jpg。另一张是 ./a b.png'), ['/work/图表/结果.jpg', 'b.png']);
  assert.deepEqual(imagePathsIn('see file:///work/app/shot.jpeg\nor "~/x/y.gif"'), ['/work/app/shot.jpeg', '~/x/y.gif']);
  assert.deepEqual(imagePathsIn('https://example.com/pic.png and http://x.test/a/b.jpg'), [], 'part of a URL is not a path');
  assert.deepEqual(imagePathsIn('edit main.ts and style.css, then run npm test'), []);
  assert.deepEqual(imagePathsIn('a.png a.png A.PNG'), ['a.png', 'A.PNG'], 'each file once');
  assert.equal(imagePathsIn(Array.from({ length: 20 }, (_, i) => `shot-${i}.png`).join(' ')).length, 6, 'no more than six');
  assert.deepEqual(imagePathsIn(''), []);
});

test('fromTerminal marks a turn that arrived through sync, not from this page', () => {
  seq = 0;
  const tl = buildTimeline([ev('turn.started', { text: 'typed in a terminal', fromTerminal: true }), ev('turn.done', {})]);
  const user = tl.items[0];
  assert.equal(user.kind === 'user' && user.fromTerminal, true);
});

test('thinking timing is tracked for the "思考 · X 秒" label', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'x' }),
    ev('reasoning.delta', { text: 'hmm' }, 't1', '2026-10-10T00:00:01.000Z'),
    ev('reasoning.delta', { text: ' more' }, 't1', '2026-10-10T00:00:04.000Z'),
    ev('turn.done', {}),
  ]);
  const work = tl.items[1];
  if (work.kind !== 'work') return assert.fail('expected work');
  assert.equal(work.thinkStart, '2026-10-10T00:00:01.000Z');
  assert.equal(work.thinkEnd, '2026-10-10T00:00:04.000Z');
  assert.equal(durationLabel(work.thinkStart!, work.thinkEnd!), '3 秒');
});

test('steps carry their own timing for the duration label', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'x' }),
    ev('tool.start', { id: 'a', title: 'npm test', kind: 'execute' }, 't1', '2026-10-10T00:00:00.000Z'),
    ev('tool.end', { id: 'a', status: 'completed' }, 't1', '2026-10-10T00:00:02.500Z'),
  ]);
  const step = tl.items[1].kind === 'work' ? tl.items[1].steps[0] : null;
  assert.ok(step);
  assert.equal(step!.startedAt, '2026-10-10T00:00:00.000Z');
  assert.equal(step!.endedAt, '2026-10-10T00:00:02.500Z');
});

test('splitThinking keeps real paragraphs and unjams sentences pasted together', () => {
  const parts = splitThinking(
    'Let me look at the codebase.Let me check the tests next.\n\nNow a new paragraph.\n\nDone.',
  );
  assert.deepEqual(parts, [
    'Let me look at the codebase.',
    'Let me check the tests next.',
    'Now a new paragraph.',
    'Done.',
  ]);
});

test('splitThinking leaves common abbreviations alone', () => {
  assert.deepEqual(splitThinking('Use e.g. npm here. Then run it.'), ['Use e.g. npm here. Then run it.']);
});

test('splitThinking splits CJK sentences without spaces', () => {
  assert.deepEqual(splitThinking('先看目录。再看代码。'), ['先看目录。', '再看代码。']);
});

test('stepTitle puts a verb first and stepStatusLabel shows the state', () => {
  const base = { id: 'a', title: 'npm test', diffs: [] };
  assert.equal(stepTitle({ ...base, kind: 'execute', status: 'completed', startedAt: '2026-10-10T00:00:00.000Z', endedAt: '2026-10-10T00:00:00.900Z' }), '运行了 npm test');
  assert.equal(stepStatusLabel({ ...base, kind: 'execute', status: 'completed', startedAt: '2026-10-10T00:00:00.000Z', endedAt: '2026-10-10T00:00:00.900Z' }), '0.9 秒');
  assert.equal(stepStatusLabel({ ...base, kind: 'read', status: 'in_progress' }), '运行中');
  assert.equal(stepStatusLabel({ ...base, kind: 'other', status: 'failed' }), '失败');
  assert.equal(stepTitle({ ...base, kind: 'other', status: 'completed' }), 'npm test');
});

test('stepDurationLabel keeps one decimal for short calls', () => {
  assert.equal(stepDurationLabel('2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.400Z'), '0.4 秒');
  assert.equal(stepDurationLabel('2026-10-10T00:00:00.000Z', '2026-10-10T00:00:12.000Z'), '12 秒');
  assert.equal(stepDurationLabel('2026-10-10T00:00:00.000Z', '2026-10-10T00:01:15.000Z'), '1 分 15 秒');
  assert.equal(stepDurationLabel(undefined, '2026-10-10T00:00:00.000Z'), '');
});

test('groupByTurn splits at user items and keeps strays in their own group', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'one' }, 't1'),
    ev('message.delta', { text: 'a' }, 't1'),
    ev('turn.done', {}, 't1'),
    ev('turn.started', { text: 'two' }, 't2'),
    ev('message.delta', { text: 'b' }, 't2'),
  ]);
  const groups = groupByTurn(tl.items);
  assert.deepEqual(
    groups.map((g) => [g.turnId, g.items.map((i) => i.kind)]),
    [
      ['t1', ['user', 'assistant', 'actions']],
      ['t2', ['user', 'assistant']],
    ],
  );
});

test('turnPreviews pairs each turn with the start of its answer', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'what is pi?' }, 't1'),
    ev('message.delta', { text: 'an agent CLI' }, 't1'),
    ev('turn.done', {}, 't1'),
    ev('turn.started', { text: 'and the web?' }, 't2'),
    ev('message.delta', { text: 'a browser UI' }, 't2'),
  ]);
  const previews = turnPreviews(tl.items);
  assert.equal(previews.get('t1')?.question, 'what is pi?');
  assert.equal(previews.get('t1')?.answer, 'an agent CLI');
  assert.equal(previews.get('t2')?.answer, 'a browser UI');
});

test('a tool call after text opens a new work group below it, in stream order', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'q' }, 't1', '2026-10-10T00:00:00Z'),
    ev('message.delta', { text: '先看文件，' }, 't1', '2026-10-10T00:00:01Z'),
    ev('tool.start', { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress' }, 't1', '2026-10-10T00:00:02Z'),
    ev('tool.end', { id: 'a', status: 'completed' }, 't1', '2026-10-10T00:00:03Z'),
    ev('message.delta', { text: '再跑测试，' }, 't1', '2026-10-10T00:00:04Z'),
    ev('tool.start', { id: 'b', title: 'npm test', kind: 'execute', status: 'in_progress' }, 't1', '2026-10-10T00:00:05Z'),
    ev('tool.end', { id: 'b', status: 'completed' }, 't1', '2026-10-10T00:00:06Z'),
    ev('message.delta', { text: '都好。' }, 't1', '2026-10-10T00:00:07Z'),
    ev('turn.done', {}, 't1', '2026-10-10T00:00:08Z'),
  ]);
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'assistant', 'work', 'assistant', 'work', 'assistant', 'actions']);
  const [, t1, w1, t2, w2, t3] = tl.items;
  assert.equal(t1.kind === 'assistant' && t1.text, '先看文件，');
  assert.equal(w1.kind === 'work' && w1.steps[0].title, 'ls');
  assert.equal(t2.kind === 'assistant' && t2.text, '再跑测试，');
  assert.equal(w2.kind === 'work' && w2.steps[0].title, 'npm test');
  assert.equal(t3.kind === 'assistant' && t3.text, '都好。');
  // Finished turn: the first group carries the whole turn's duration, later ones are just done.
  assert.equal(w1.kind === 'work' && w1.firstInTurn, true);
  assert.equal(w1.kind === 'work' && w1.endedAt, '2026-10-10T00:00:08Z');
  assert.equal(w2.kind === 'work' && !w2.firstInTurn, true);
  assert.equal(w1.kind === 'work' && w1.active, false);
});

test('while a turn runs, the newest work group is the active one and earlier ones hand over', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'q' }),
    ev('message.delta', { text: '先看文件，' }),
    ev('tool.start', { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress' }),
    ev('tool.end', { id: 'a', status: 'completed' }),
    ev('message.delta', { text: '再跑测试，' }),
    ev('tool.start', { id: 'b', title: 'npm test', kind: 'execute', status: 'in_progress' }),
  ]);
  assert.equal(tl.running, true);
  const [, , w1, , w2] = tl.items;
  assert.equal(w1.kind === 'work' && w1.active, false, 'the group before the text is done being written');
  assert.equal(w1.kind === 'work' && w1.done, false, 'it only collapses when the whole turn ends');
  assert.equal(w2.kind === 'work' && w2.active, true, 'the group being written to is the working one');
  assert.equal(tl.items.some((i) => i.kind === 'actions'), false);
});

test('a tool that finishes after text began still updates the row it started in', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'q' }),
    ev('tool.start', { id: 'a', title: 'npm test', kind: 'execute', status: 'in_progress' }),
    ev('message.delta', { text: '测试在跑，' }),
    ev('tool.update', { id: 'a', output: 'half' }),
    ev('tool.end', { id: 'a', status: 'completed', output: '12 passed' }, 't1', '2026-10-10T00:00:09Z'),
    ev('message.delta', { text: '跑完了。' }),
    ev('turn.done'),
  ]);
  // The late result opens no group of its own and does not cut the text in two.
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'work', 'assistant', 'actions']);
  const [, work, text] = tl.items;
  assert.ok(work.kind === 'work');
  assert.deepEqual([work.steps[0].status, work.steps[0].output, work.steps[0].endedAt], ['completed', '12 passed', '2026-10-10T00:00:09Z']);
  assert.equal(text.kind === 'assistant' && text.text, '测试在跑，跑完了。');
});

test('a tool result whose call is not in the loaded events is left out', () => {
  seq = 0;
  const tl = buildTimeline([ev('turn.started', { text: 'q' }), ev('tool.end', { id: 'gone', status: 'completed' }), ev('message.delta', { text: 'ok' })]);
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'assistant']);
});

test('a turn that never got its ending is closed where the next one starts', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'cut off' }, 't1'),
    ev('tool.start', { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress' }, 't1'),
    ev('message.delta', { text: 'half' }, 't1'),
    ev('turn.started', { text: 'next' }, 't2'),
    ev('message.delta', { text: 'answer' }, 't2'),
    ev('turn.done', {}, 't2'),
  ]);
  assert.equal(tl.running, false);
  const cut = tl.items.filter((i) => i.turnId === 't1' && (i.kind === 'work' || i.kind === 'assistant'));
  assert.equal(cut.length, 2);
  assert.ok(cut.every((i) => (i.kind === 'work' || i.kind === 'assistant') && i.done), 'nothing of the cut-off turn still reads as working');
  assert.equal(tl.items.some((i) => i.kind === 'actions' && i.turnId === 't1'), false, 'it did not finish, so it gets no action row');
});

test('a turn the hub restart interrupted says so in plain words', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'q' }),
    ev('turn.error', { message: 'The hub restarted while this turn was running.', code: 'interrupted' }),
  ]);
  const error = tl.items.find((i) => i.kind === 'error');
  assert.match(error?.kind === 'error' ? error.message : '', /重启.*中断/);
  assert.equal(tl.running, false);
});
