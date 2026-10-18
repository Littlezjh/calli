import test from 'node:test';
import assert from 'node:assert/strict';
import type { AttentionKind, ThreadSummary } from '@rah/extension-api';
import { buildColumns, columnFor, emptyFilters, IDLE_WINDOW_MS, parseFilters, projectName, showStaleWarning } from '../src/columns';
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

for (const kind of ['approval', 'question', 'plan', 'error', 'unread'] satisfies AttentionKind[]) {
  test(`${kind} belongs to attention even while running`, () => {
    const item = thread(kind, { attention: { kind }, status: 'running' });
    assert.equal(columnFor(item), 'attention');
    const columns = buildColumns([item], emptyFilters(), now);
    assert.deepEqual(columns.map((column) => column.total), [1, 0, 0]);
  });
}

test('running without attention belongs to running', () => {
  assert.equal(columnFor(thread('running', { status: 'running' })), 'running');
});

test('idle without attention belongs to idle', () => {
  assert.equal(columnFor(thread('idle')), 'idle');
});

test('does not infer attention from status or unread flags', () => {
  assert.equal(columnFor(thread('error', { status: 'error' })), 'idle');
  assert.equal(columnFor(thread('unread', { unread: true })), 'idle');
});

test('sorts pinned first and then newest first without changing the input', () => {
  const items = [
    thread('older', { updatedAt: iso(now - 2000) }),
    thread('newest'),
    thread('pinned-old', { pinned: true, updatedAt: iso(now - 5000) }),
    thread('pinned-new', { pinned: true, updatedAt: iso(now - 1000) }),
  ];
  const before = structuredClone(items);
  const columns = buildColumns(items, emptyFilters(), now);
  assert.deepEqual(columns[2].threads.map((item) => item.id), ['pinned-new', 'pinned-old', 'newest', 'older']);
  assert.deepEqual(items, before);
});

test('folds only idle threads older than 30 days, including old pins', () => {
  const older = iso(now - IDLE_WINDOW_MS - 1);
  const items = [
    thread('recent'),
    thread('boundary', { updatedAt: iso(now - IDLE_WINDOW_MS) }),
    thread('old', { updatedAt: older }),
    thread('old-pin', { updatedAt: older, pinned: true }),
    thread('old-attention', { updatedAt: older, attention: { kind: 'question' } }),
    thread('old-running', { updatedAt: older, status: 'running' }),
  ];
  const columns = buildColumns(items, emptyFilters(), now);
  assert.deepEqual(columns.map((column) => column.total), [1, 1, 4]);
  assert.deepEqual(columns.map((column) => column.olderCount), [0, 0, 2]);
  assert.deepEqual(columns[2].threads.map((item) => item.id), ['recent', 'boundary']);
  const expanded = buildColumns(items, emptyFilters(), now, true)[2];
  assert.deepEqual(expanded.threads.map((item) => item.id), ['old-pin', 'recent', 'boundary', 'old']);
  assert.equal(expanded.olderCount, 2);
});

test('an entirely folded idle column retains its total', () => {
  const columns = buildColumns([thread('old', { updatedAt: iso(now - IDLE_WINDOW_MS - 1) })], emptyFilters(), now);
  assert.equal(columns[2].threads.length, 0);
  assert.equal(columns[2].total, 1);
  assert.equal(columns[2].olderCount, 1);
});

test('combines project, instance and schedule filters with OR within each selection', () => {
  const items = [
    thread('match-one', { scheduled: true }),
    thread('match-two', { project: '/projects/two', agent: 'agent-2', scheduled: true }),
    thread('other-project', { project: '/projects/three', scheduled: true }),
    thread('other-agent', { agent: 'agent-3', scheduled: true }),
    thread('not-scheduled'),
  ];
  const filters = { project: ['/projects/one', '/projects/two'], agent: ['agent-1', 'agent-2'], scheduled: [true] };
  const ids = (scheduled: boolean[]) => buildColumns(items, { ...filters, scheduled }, now)[2].threads.map((item) => item.id);
  assert.deepEqual(ids([true]), ['match-one', 'match-two']);
  assert.deepEqual(ids([false]), ['not-scheduled']);
  assert.deepEqual(ids([true, false]), ['match-one', 'match-two', 'not-scheduled']);
  assert.deepEqual(ids([]), ids([true, false]));
  assert.equal(buildColumns(items, emptyFilters(), now)[2].total, 5);
  assert.ok(buildColumns(items, { ...filters, project: ['missing'] }, now).every((column) => column.total === 0));
});

test('excludes archived threads and counts older threads after filtering', () => {
  const items = [
    thread('archived', { archived: true, attention: { kind: 'approval' } }),
    thread('old', { updatedAt: iso(now - IDLE_WINDOW_MS - 1), scheduled: true }),
    thread('old-excluded', { updatedAt: iso(now - IDLE_WINDOW_MS - 1) }),
  ];
  const columns = buildColumns(items, { ...emptyFilters(), scheduled: [true] }, now);
  assert.deepEqual(columns.map((column) => column.total), [0, 0, 1]);
  assert.equal(columns[2].olderCount, 1);
});

test('invalid persisted filters fall back safely and mixed values are sanitized', () => {
  for (const input of [null, '', '{bad', 'null', '42']) assert.deepEqual(parseFilters(input), emptyFilters());
  assert.deepEqual(parseFilters('{"project":["/a",1,"/a"],"agent":false,"scheduled":[true,"false",false,true]}'), {
    project: ['/a'], agent: [], scheduled: [true, false],
  });
});

test('project labels use the final directory segment', () => {
  assert.equal(projectName('/projects/one/'), 'one');
  assert.equal(projectName('C:\\projects\\two\\'), 'two');
  assert.equal(projectName('/'), '/');
  assert.equal(projectName(''), '');
});

test('translations preserve numeric messages and English plurals', () => {
  assert.equal(t('zh', 'runningMinutes', 0), '刚开始运行');
  assert.equal(t('en', 'runningMinutes', 0), 'Just started');
  assert.equal(t('ja', 'runningMinutes', 0), '開始したばかり');
  assert.equal(t('zh', 'runningMinutes', 1), '已运行 1 分钟');
  assert.equal(t('ja', 'runningMinutes', 1), '1 分間実行中');
  assert.equal(t('en', 'runningMinutes', 1), 'Running for 1 minute');
  assert.equal(t('en', 'runningMinutes', 2), 'Running for 2 minutes');
  assert.equal(t('zh', 'team', 3), '协作 3 人');
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
