import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  clockLabel,
  durationLabel,
  groupByTurn,
  runSummary,
  splitThinking,
  splitUserQuote,
  thinkingPreview,
  stepDurationLabel,
  stepStatusLabel,
  stepTitle,
  toMarkdown,
  turnPreviews,
  workSections,
  withQuote,
  withNotes,
  splitNotes,
  type Step,
  type StoredEvent,
} from '../src/timeline.js';

let seq = 0;
function ev(type: string, data: Record<string, any> = {}, turnId: string | null = 't1', ts = '2026-10-10T00:00:00.000Z'): StoredEvent {
  seq += 1;
  return { threadId: 'th', seq, turnId, type, ts, data };
}

test('collaboration turns expose their source and hide runtime instructions', () => {
  const tl = buildTimeline([ev('turn.started', { text: 'internal instructions', displayText: '来自审查成员的结果', coordination: { from: 'reviewer' } })]);
  const item = tl.items[0];
  assert.equal(item.kind, 'user');
  if (item.kind !== 'user') return;
  assert.equal(item.text, '来自审查成员的结果');
  assert.equal(item.coordination, true);
});

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
  assert.deepEqual(work.entries.map((e) => e.kind), ['thought', 'step'], 'what the turn did, in the order it happened');
  assert.equal(work.entries[0].kind === 'thought' && work.entries[0].thought.text, 'thinking');
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

test('the action row carries when the turn ended, unless the hub only copied the turn in', () => {
  seq = 0;
  const seen = buildTimeline([ev('turn.started', { text: 'q' }), ev('message.delta', { text: 'a' }), ev('turn.done', {}, 't1', '2026-10-10T05:11:00.000Z')]);
  const row = seen.items.at(-1);
  assert.equal(row?.kind === 'actions' && row.at, '2026-10-10T05:11:00.000Z');

  // An imported turn and one synced from the terminal were written down later than they happened.
  for (const flag of ['imported', 'fromTerminal']) {
    seq = 0;
    const copied = buildTimeline([ev('turn.started', { text: 'q', [flag]: true }), ev('message.delta', { text: 'a' }), ev('turn.done', { [flag]: true })]);
    const last = copied.items.at(-1);
    assert.equal(last?.kind, 'actions');
    assert.equal(last?.kind === 'actions' && 'at' in last, false, `${flag}: no time to show`);
  }
});

test('clockLabel says only as much of the date as is needed', () => {
  const now = new Date(2026, 9, 11, 9, 30);
  assert.equal(clockLabel(new Date(2026, 9, 11, 8, 5).toISOString(), now), '08:05');
  assert.equal(clockLabel(new Date(2026, 9, 10, 13, 11).toISOString(), now), '10月10日 13:11');
  assert.equal(clockLabel(new Date(2025, 11, 31, 23, 59).toISOString(), now), '2025年12月31日 23:59');
  assert.equal(clockLabel('not a date', now), '');
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

test('completed edits are not summed into a changes item until the turn has finished', () => {
  seq = 0;
  const events = [
    ev('turn.started', { text: 'edit then keep going' }),
    ev('tool.start', { id: 'a', kind: 'edit', content: [diff('/w/a.ts', 'x', 'y')] }),
    ev('tool.end', { id: 'a', status: 'completed' }),
    ev('message.delta', { text: 'on the way' }),
    ev('tool.start', { id: 'b', title: 'Bash', kind: 'other' }),
  ];
  // Still running: the edit is done, but the turn has not ended — no summary card, no actions row.
  const running = buildTimeline(events);
  assert.equal(running.running, true);
  assert.deepEqual(running.items.map((i) => i.kind), ['user', 'work']);
  // The same turn, ended: the card and the answer row appear.
  const done = buildTimeline([...events, ev('turn.done', {})]);
  assert.deepEqual(done.items.map((i) => i.kind), ['user', 'work', 'assistant', 'changes', 'actions']);
  const changes = done.items[3];
  assert.equal(changes.kind === 'changes' && changes.files.length, 1);
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

test('unknown context clears the previous reading and a later measurement restores it', () => {
  const events = [
    ev('usage.updated', { used: 183510, size: 258400 }),
    ev('usage.updated', { used: null, size: 258400 }),
  ];
  assert.equal(buildTimeline(events).usage, null);
  events.push(ev('usage.updated', { used: 12000, size: 258400 }));
  assert.deepEqual(buildTimeline(events).usage, { used: 12000, size: 258400 });
  for (const used of [-1, NaN, Infinity]) events.push(ev('usage.updated', { used, size: 258400 }));
  assert.deepEqual(buildTimeline(events).usage, { used: 12000, size: 258400 });
});

test('imagePathsIn finds local image files in an answer and leaves web addresses alone', () => {
  assert.deepEqual(imagePathsIn('Saved to /work/app/out/chart.png and also `docs/logo.webp`.'), ['/work/app/out/chart.png', 'docs/logo.webp']);
  assert.deepEqual(imagePathsIn('![the chart](out/chart.png "Chart")\n\n![remote](https://example.com/a.png)'), ['out/chart.png']);
  assert.deepEqual(imagePathsIn('图片在：/work/图表/结果.jpg。另一张是 ./a b.png'), ['/work/图表/结果.jpg', 'b.png']);
  assert.deepEqual(imagePathsIn('see file:///work/app/shot.jpeg\nor "~/x/y.gif"'), ['/work/app/shot.jpeg', '~/x/y.gif']);
  assert.deepEqual(imagePathsIn('saved to:\n👉 [dino.svg](file:///work/app/dino.svg)\n\nand [二](file:///work/app/a%20b/%E5%9B%BE.svg)'), ['/work/app/dino.svg', '/work/app/a b/图.svg'], 'a linked SVG, with the address decoded');
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
  const [entry] = work.entries;
  if (entry.kind !== 'thought') return assert.fail('expected a thought');
  assert.equal(entry.thought.text, 'hmm more');
  assert.equal(durationLabel(entry.thought.startedAt, entry.thought.endedAt), '3 秒');
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
  // A command is named by what it runs; the directory it steps into first says nothing in one line.
  assert.equal(stepTitle({ ...base, kind: 'execute', status: 'completed', title: 'cd /srv/app && git status --short' }), '运行了 git status --short');
  assert.equal(stepTitle({ ...base, kind: 'execute', status: 'completed', title: 'cd "/srv/my app"; ls' }), '运行了 ls');
  assert.equal(stepTitle({ ...base, kind: 'execute', status: 'completed', title: 'cd /srv/app' }), '运行了 cd /srv/app');
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

test('a turn is one work block in the order things happened, and the answer is what follows it', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'q' }, 't1', '2026-10-10T00:00:00Z'),
    ev('reasoning.delta', { text: 'plan' }, 't1', '2026-10-10T00:00:01Z'),
    ev('message.delta', { text: '先看文件，' }, 't1', '2026-10-10T00:00:02Z'),
    ev('tool.start', { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress' }, 't1', '2026-10-10T00:00:03Z'),
    ev('tool.end', { id: 'a', status: 'completed' }, 't1', '2026-10-10T00:00:04Z'),
    ev('reasoning.delta', { text: 'next' }, 't1', '2026-10-10T00:00:05Z'),
    ev('message.delta', { text: '再跑测试，' }, 't1', '2026-10-10T00:00:06Z'),
    ev('tool.start', { id: 'b', title: 'npm test', kind: 'execute', status: 'in_progress' }, 't1', '2026-10-10T00:00:07Z'),
    ev('tool.end', { id: 'b', status: 'completed' }, 't1', '2026-10-10T00:00:08Z'),
    ev('message.delta', { text: '都好。' }, 't1', '2026-10-10T00:00:09Z'),
    ev('turn.done', {}, 't1', '2026-10-10T00:00:10Z'),
  ]);
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'work', 'assistant', 'actions']);
  const [, work, answer] = tl.items;
  if (work.kind !== 'work') return assert.fail('expected work');
  // Thinking after a tool call comes after it, and what was said on the way sits where it was said.
  assert.deepEqual(
    work.entries.map((e) => (e.kind === 'thought' ? `thought:${e.thought.text}` : e.kind === 'step' ? `step:${e.step.title}` : `note:${e.text}`)),
    ['thought:plan', 'note:先看文件，', 'step:ls', 'thought:next', 'note:再跑测试，', 'step:npm test'],
  );
  assert.deepEqual(work.steps.map((s) => s.title), ['ls', 'npm test']);
  assert.equal(answer.kind === 'assistant' && answer.text, '都好。');
  // The block's time is the turn's: from the question to the end.
  assert.deepEqual([work.startedAt, work.endedAt, work.done], ['2026-10-10T00:00:00Z', '2026-10-10T00:00:10Z', true]);
});

test('while a turn runs, the text being written is outside the block until the agent does more', () => {
  seq = 0;
  const events = [
    ev('turn.started', { text: 'q' }),
    ev('tool.start', { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress' }),
    ev('tool.end', { id: 'a', status: 'completed' }),
    ev('message.delta', { text: '再跑测试，' }),
  ];
  const writing = buildTimeline(events);
  assert.equal(writing.running, true);
  assert.deepEqual(writing.items.map((i) => i.kind), ['user', 'work', 'assistant'], 'it may be the answer');
  assert.equal(writing.items.some((i) => i.kind === 'actions'), false);

  // It was a remark on the way: it becomes the block's latest entry, under the same key, so the
  // view moves the text instead of writing it again.
  const more = buildTimeline([...events, ev('tool.start', { id: 'b', title: 'npm test', kind: 'execute', status: 'in_progress' })]);
  assert.deepEqual(more.items.map((i) => i.kind), ['user', 'work']);
  const work = more.items[1];
  if (work.kind !== 'work') return assert.fail('expected work');
  assert.deepEqual(work.entries.map((e) => e.kind), ['step', 'note', 'step']);
  const said = writing.items[2];
  assert.equal(work.entries[1].kind === 'note' && work.entries[1].key, said.key);
  assert.equal(work.done, false);
});

test('a turn that says something and ends on a tool call still has an answer: its last remark', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'q' }),
    ev('message.delta', { text: '我来写文件。' }),
    ev('tool.start', { id: 'a', title: 'a.ts', kind: 'edit', status: 'in_progress' }),
    ev('tool.end', { id: 'a', status: 'completed' }),
    ev('turn.done'),
  ]);
  assert.deepEqual(tl.items.map((i) => i.kind), ['user', 'work', 'assistant', 'actions']);
  const [, work, answer] = tl.items;
  assert.deepEqual(work.kind === 'work' && work.entries.map((e) => e.kind), ['step']);
  assert.equal(answer.kind === 'assistant' && answer.text, '我来写文件。');
});

test('thinkingPreview shows where a long thought has got to, not where it began', () => {
  assert.equal(thinkingPreview([]), '');
  assert.equal(thinkingPreview(['first.', 'short last.']), 'short last.');
  const long = `${'start of a long plan '.repeat(20)}and this is the end of it.`;
  const preview = thinkingPreview(['earlier', long]);
  assert.ok(preview.startsWith('…') && preview.endsWith('and this is the end of it.'));
  assert.ok(preview.length < 160);
  assert.ok(thinkingPreview(['思'.repeat(300)]).length <= 141, 'text without spaces is cut as it is');
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


const step = (id: string, kind: string, extra: Partial<Step> = {}): Step => ({ id, title: id, kind, status: 'completed', diffs: [], ...extra });

test('workSections keeps what was said apart and gathers the calls and thinking between into runs', () => {
  seq = 0;
  const tl = buildTimeline([
    ev('turn.started', { text: 'q' }),
    ev('reasoning.delta', { text: 'hmm' }),
    ev('tool.start', { id: 'a', kind: 'read' }),
    ev('tool.end', { id: 'a', status: 'completed' }),
    ev('tool.start', { id: 'b', kind: 'search' }),
    ev('tool.end', { id: 'b', status: 'completed' }),
    ev('message.delta', { text: 'found it, fixing' }),
    ev('tool.start', { id: 'c', kind: 'edit' }),
  ]);
  const work = tl.items.find((i) => i.kind === 'work');
  assert.ok(work?.kind === 'work');
  const sections = workSections(work.entries);
  assert.deepEqual(sections.map((s) => s.kind), ['run', 'note', 'run']);
  const [first, , last] = sections;
  assert.ok(first.kind === 'run' && last.kind === 'run');
  assert.deepEqual(first.entries.map((e) => e.kind), ['thought', 'step', 'step'], 'thinking stays in the run, in order');
  assert.deepEqual(first.steps.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(last.steps.map((s) => s.id), ['c']);
  // A run is still the same run when more calls join it: its key is its first entry's.
  assert.notEqual(first.key, last.key);
  assert.equal(workSections(work.entries.slice(0, 2))[0].key, first.key);
});

test('runSummary counts the calls by kind, in one line', () => {
  const summary = runSummary([step('1', 'read'), step('2', 'execute'), step('3', 'read'), step('4', 'search'), step('5', 'mcp-thing')]);
  assert.equal(summary.text, '已浏览 2 个文件，搜索 1 次，运行 1 条命令，调用 1 次工具');
  assert.equal(summary.kind, 'read', 'the kind there is most of');
  assert.equal(summary.failed, 0);
});

test('runSummary counts edited files once each, and says how many calls failed', () => {
  const d = (path: string) => ({ path, oldText: '', newText: 'x', added: 1, removed: 0 });
  const summary = runSummary([
    step('1', 'edit', { diffs: [d('a.ts')] }),
    step('2', 'edit', { diffs: [d('a.ts')] }),
    step('3', 'edit', { diffs: [d('b.ts')] }),
    step('4', 'edit'), // does not say what it wrote
    step('5', 'execute', { status: 'failed' }),
  ]);
  assert.equal(summary.text, '已编辑 3 个文件，运行 1 条命令');
  assert.equal(summary.kind, 'edit');
  assert.equal(summary.failed, 1);
  assert.equal(runSummary([]).text, '');
});

test('withQuote carries the passage as Markdown quote lines', () => {
  assert.equal(withQuote('one line', 'why?'), '> one line\n\nwhy?');
  // Several lines keep one marker each; empty ones stay empty quote lines.
  assert.equal(withQuote('first\n\nsecond', 'and this?'), '> first\n>\n> second\n\nand this?');
  // A quote alone is a whole message; so is text without one.
  assert.equal(withQuote('  only the quote  ', ''), '> only the quote');
});

test('splitUserQuote reads the leading quote back out of a sent message', () => {
  const roundTrip = splitUserQuote(withQuote('first\nsecond', 'the question'));
  assert.equal(roundTrip.quote, 'first\nsecond');
  assert.equal(roundTrip.body, 'the question');

  // Text with no quote lines up front comes back whole, body only.
  assert.deepEqual(splitUserQuote('plain message'), { quote: null, body: 'plain message' });
  // Only the leading block counts: a quote typed in the middle stays in the body.
  const inner = splitUserQuote('before\n> later');
  assert.equal(inner.quote, null);
  assert.equal(inner.body, 'before\n> later');
  // A quote-only message has no body, and surrounding whitespace is dropped.
  assert.deepEqual(splitUserQuote('> quoted'), { quote: 'quoted', body: '' });
  assert.equal(splitUserQuote('>  spaced  ').quote, 'spaced');
});

test('withNotes numbers each passage, with its comment when there is one, and splitNotes reads them back', () => {
  const sent = withNotes(
    [
      { quote: '输入 0.042 美元', comment: '这个核实了吗？' },
      { quote: 'first\n\nsecond', comment: '' },
    ],
    '  都看一下  ',
  );
  assert.equal(sent, '[注释 1]\n> 输入 0.042 美元\n评论：这个核实了吗？\n\n[注释 2]\n> first\n>\n> second\n\n都看一下');
  assert.deepEqual(splitNotes(sent), {
    notes: [
      { quote: '输入 0.042 美元', comment: '这个核实了吗？' },
      { quote: 'first\n\nsecond', comment: '' },
    ],
    body: '都看一下',
  });
  // Notes alone are a message too; a comment typed over several lines is kept on one.
  assert.equal(withNotes([{ quote: 'x', comment: 'a\n b' }], ''), '[注释 1]\n> x\n评论：a b');
  assert.deepEqual(splitNotes('[注释 1]\n> x'), { notes: [{ quote: 'x', comment: '' }], body: '' });
  // Anything else is left as it is, including the older single quote.
  assert.deepEqual(splitNotes('> quoted\n\nwhy?'), { notes: [], body: '> quoted\n\nwhy?' });
  assert.deepEqual(splitNotes('see [注释 1] above'), { notes: [], body: 'see [注释 1] above' });
});

test('a stopped turn says so, keeps what was said, and offers nothing to copy or fork from', () => {
  seq = 0;
  const tl = buildTimeline([
    // Stopped at once: only the line.
    ev('turn.started', { text: '你好' }, 't1', '2026-10-10T00:00:00.000Z'),
    ev('turn.done', { stopReason: 'cancelled' }, 't1', '2026-10-10T00:00:00.400Z'),
    // Stopped mid-answer: the line above the words so far.
    ev('turn.started', { text: 'hhh' }, 't2', '2026-10-10T00:00:01.000Z'),
    ev('message.delta', { text: '半句' }, 't2', '2026-10-10T00:00:02.000Z'),
    ev('turn.done', { stopReason: 'cancelled' }, 't2', '2026-10-10T00:00:04.000Z'),
    // Stopped while working: the work block says it.
    ev('turn.started', { text: 'run' }, 't3', '2026-10-10T00:00:05.000Z'),
    ev('tool.start', { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress' }, 't3', '2026-10-10T00:00:06.000Z'),
    ev('turn.done', { stopReason: 'cancelled' }, 't3', '2026-10-10T00:00:07.000Z'),
    // A turn that finished as usual still gets its row.
    ev('turn.started', { text: 'again' }, 't4', '2026-10-10T00:00:08.000Z'),
    ev('message.delta', { text: 'answer' }, 't4', '2026-10-10T00:00:09.000Z'),
    ev('turn.done', { stopReason: 'end_turn' }, 't4', '2026-10-10T00:00:10.000Z'),
  ]);
  assert.deepEqual(
    tl.items.map((i) => i.kind),
    ['user', 'stopped', 'user', 'stopped', 'assistant', 'user', 'work', 'user', 'assistant', 'actions'],
  );
  const work = tl.items[6];
  assert.equal(work.kind === 'work' && work.stopped, true);
  assert.equal(tl.items[4].kind === 'assistant' && tl.items[4].text, '半句');
  assert.equal(tl.items.filter((i) => i.kind === 'actions').length, 1);
});
