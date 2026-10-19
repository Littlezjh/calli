import test from 'node:test';
import assert from 'node:assert/strict';
import type { AttentionKind, ThreadSummary, TodoSummary } from '@rah/extension-api';
import { buildColumns, cardFor, DONE_WINDOW_MS, emptyFilters, firstColumn, parseFilters, projectName, showStaleWarning } from '../src/columns';
import { t } from '../src/i18n';
import manifest from '../manifest.json';

const now = Date.parse('2026-10-18T12:00:00Z');
const iso = (time: number) => new Date(time).toISOString();

test('shows stale warning only when disconnected after a successful sync', () => {
  for (const state of ['live', 'reconnecting', 'offline'] as const) {
    assert.equal(showStaleWarning(state, null), false, `${state} before first sync or in demo`);
    assert.equal(showStaleWarning(state, iso(now)), state !== 'live', `${state} after sync`);
  }
});

const thread = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, title: id, agent: 'agent-1', project: '/projects/one', status: 'idle', attention: null,
  runningSince: null, unread: false, pinned: false, archived: false, scheduled: false,
  worktree: false, handover: false, teamSize: 0, createdAt: iso(now), updatedAt: iso(now), ...patch,
});
const todo = (id: string, patch: Partial<TodoSummary> = {}): TodoSummary => ({
  id, text: id, done: false, doneAt: null, createdAt: iso(now - 1000), threadIds: [],
  items: { done: 0, total: 0 }, report: null, ...patch,
});
const place = (item: TodoSummary, threads: ThreadSummary[] = []) => cardFor(item, new Map(threads.map((x) => [x.id, x])));

test('an item without linked threads has not started', () => {
  const card = place(todo('a'));
  assert.equal(card.column, 'todo');
  assert.equal(card.lead, null);
});

for (const kind of ['approval', 'question', 'plan', 'error'] satisfies AttentionKind[]) {
  test(`${kind} on a linked thread needs the person, even while another runs`, () => {
    const card = place(todo('a', { threadIds: ['run', 'wait'] }), [thread('run', { status: 'running' }), thread('wait', { attention: { kind } })]);
    assert.equal(card.column, 'waiting');
    assert.deepEqual(card.reason, { kind: 'attention', attention: kind });
    assert.equal(card.lead?.id, 'wait');
  });
}

test('waits are ordered approval, question, plan, error', () => {
  const threads = [thread('e', { attention: { kind: 'error' } }), thread('q', { attention: { kind: 'question' } })];
  assert.equal(place(todo('a', { threadIds: ['e', 'q'] }), threads).lead?.id, 'q');
});

test('a running linked thread is in progress, whatever the agent last reported', () => {
  const card = place(todo('a', { threadIds: ['t'], report: { stage: 'review', note: '', threadId: 't', at: iso(now) } }),
    [thread('t', { status: 'running', runningSince: iso(now - 60_000) })]);
  assert.equal(card.column, 'doing');
  assert.deepEqual(card.reason, { kind: 'running', since: iso(now - 60_000) });
});

test('a finished thread without a report waits to be checked, unread or not', () => {
  assert.deepEqual(place(todo('a', { threadIds: ['t'] }), [thread('t')]).reason, { kind: 'idle', unread: false });
  const unread = place(todo('a', { threadIds: ['t'] }), [thread('t', { unread: true, attention: { kind: 'unread' } })]);
  assert.equal(unread.column, 'review');
  assert.deepEqual(unread.reason, { kind: 'idle', unread: true });
});

test('the agent report moves an idle item between doing, waiting and review', () => {
  const report = (stage: 'doing' | 'review' | 'blocked') => todo('a', { threadIds: ['t'], report: { stage, note: 'n', threadId: 't', at: iso(now) } });
  assert.equal(place(report('doing'), [thread('t')]).column, 'doing');
  assert.equal(place(report('blocked'), [thread('t')]).column, 'waiting');
  assert.equal(place(report('review'), [thread('t')]).column, 'review');
  assert.equal(place(report('review'), [thread('t')]).reason.kind, 'report');
});

test('only the person makes an item done, and it stays done whatever its threads do', () => {
  const card = place(todo('a', { done: true, doneAt: iso(now), threadIds: ['t'] }), [thread('t', { attention: { kind: 'approval' } })]);
  assert.equal(card.column, 'done');
});

test('threads missing from the list count as finished work', () => {
  const card = place(todo('a', { threadIds: ['archived'] }));
  assert.equal(card.column, 'review');
  assert.equal(card.lead, null);
});

test('not started keeps plan order; the rest put the latest change first', () => {
  const todos = [
    todo('second', { createdAt: iso(now - 1) }),
    todo('first', { createdAt: iso(now - 5) }),
    todo('old', { threadIds: ['old'] }),
    todo('new', { threadIds: ['new'] }),
  ];
  const before = structuredClone(todos);
  const columns = buildColumns(todos, [thread('old', { updatedAt: iso(now - 5000) }), thread('new')], emptyFilters(), now);
  assert.deepEqual(columns[0].cards.map((card) => card.todo.id), ['second', 'first']);
  assert.deepEqual(columns[3].cards.map((card) => card.todo.id), ['new', 'old']);
  assert.deepEqual(todos, before);
});

test('folds items done more than a day ago, keeping the column total', () => {
  const todos = [
    todo('recent', { done: true, doneAt: iso(now - 1000) }),
    todo('boundary', { done: true, doneAt: iso(now - DONE_WINDOW_MS) }),
    todo('old', { done: true, doneAt: iso(now - DONE_WINDOW_MS - 1) }),
  ];
  const done = buildColumns(todos, [], emptyFilters(), now)[4];
  assert.deepEqual(done.cards.map((card) => card.todo.id), ['recent', 'boundary']);
  assert.deepEqual([done.total, done.olderCount], [3, 1]);
  assert.equal(buildColumns(todos, [], emptyFilters(), now, true)[4].cards.length, 3);
});

test('filters match any linked thread and hide unlinked items', () => {
  const todos = [
    todo('one', { threadIds: ['a'] }),
    todo('two', { threadIds: ['b', 'c'] }),
    todo('unlinked'),
  ];
  const threads = [thread('a'), thread('b', { project: '/projects/two' }), thread('c', { agent: 'agent-2' })];
  const ids = (filters: { project: string[]; agent: string[] }) => buildColumns(todos, threads, filters, now).flatMap((column) => column.cards.map((card) => card.todo.id));
  assert.deepEqual(ids(emptyFilters()), ['unlinked', 'one', 'two']);
  assert.deepEqual(ids({ project: ['/projects/two'], agent: [] }), ['two']);
  assert.deepEqual(ids({ project: [], agent: ['agent-2'] }), ['two']);
  assert.deepEqual(ids({ project: ['/projects/one'], agent: ['agent-2'] }), ['two']);
});

test('phones open on the first column that asks something of the person', () => {
  const columns = (todos: TodoSummary[], threads: ThreadSummary[] = []) => buildColumns(todos, threads, emptyFilters(), now);
  assert.equal(firstColumn(columns([])), 'waiting');
  assert.equal(firstColumn(columns([todo('a')])), 'todo');
  assert.equal(firstColumn(columns([todo('a'), todo('b', { threadIds: ['t'] })], [thread('t')])), 'review');
  assert.equal(firstColumn(columns([todo('b', { threadIds: ['t'] })], [thread('t', { attention: { kind: 'question' } })])), 'waiting');
});

test('invalid persisted filters fall back safely and mixed values are sanitized', () => {
  for (const input of [null, '', '{bad', 'null', '42']) assert.deepEqual(parseFilters(input), emptyFilters());
  assert.deepEqual(parseFilters('{"project":["/a",1,"/a"],"agent":false}'), { project: ['/a'], agent: [] });
});

test('project labels use the final directory segment', () => {
  assert.equal(projectName('/projects/one/'), 'one');
  assert.equal(projectName('C:\\projects\\two\\'), 'two');
  assert.equal(projectName('/'), '/');
  assert.equal(projectName(''), '');
});

test('translations pass every argument and keep English plurals', () => {
  assert.equal(t('zh', 'runningMinutes', 0), '刚开始运行');
  assert.equal(t('en', 'runningMinutes', 1), 'Running for 1 minute');
  assert.equal(t('en', 'runningMinutes', 2), 'Running for 2 minutes');
  assert.equal(t('zh', 'items', 2, 5), '子项完成 2/5');
  assert.equal(t('en', 'items', 1, 1), '1 of 1 sub-item done');
  assert.equal(t('en', 'items', 2, 5), '2 of 5 sub-items done');
  assert.equal(t('en', 'older', 1), 'Show 1 earlier item');
  assert.equal(t('ja', 'title'), 'ボード');
});

test('manifest declares the board route and scoped work content permission', () => {
  assert.equal(manifest.id, 'board');
  assert.equal(manifest.apiVersion, 1);
  assert.deepEqual(manifest.permissions, ['events.summary', 'worksource.read']);
  assert.deepEqual(manifest.contributes.views, [{
    id: 'board', title: manifest.name, icon: 'board', route: '#/board', sidebar: { pinned: true },
  }]);
});
