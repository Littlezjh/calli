import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Section, Thread } from '../src/api.js';
import { buildActivity, buildSidebar, taggedAgents } from '../src/sidebar.js';

let clock = 0;
function thread(id: string, over: Partial<Thread> = {}): Thread {
  clock += 1;
  return {
    id,
    agent: 'claude',
    cwd: '/work/code',
    title: id,
    agentSessionId: null,
    preview: null,
    status: 'idle',
    pinned: false,
    permissionMode: 'auto_edit',
    model: null,
    effort: null,
    archivedAt: null,
    sectionId: null,
    forkedFrom: null,
    unread: false,
    terminalActivity: false,
    waiting: false,
    queued: [],
    resumeCommand: null,
    createdAt: '2026-01-01T00:00:00Z',
    // Later calls are older, like the server's newest-first order.
    updatedAt: new Date(Date.UTC(2026, 0, 1) - clock * 1000).toISOString(),
    ...over,
    // Unless a test says otherwise, the directory is not reached through a symlink.
    cwdReal: over.cwdReal ?? over.cwd ?? '/work/code',
  };
}
const sections: Section[] = [
  { id: 's2', name: '调研', position: 2 },
  { id: 's1', name: '支付重构', position: 1 },
];
const ids = (list: Thread[]) => list.map((t) => t.id);

test('each thread appears once: pinned first, then its section, then its project', () => {
  const model = buildSidebar(
    [thread('a', { pinned: true, sectionId: 's1' }), thread('b', { sectionId: 's1' }), thread('c'), thread('d', { cwd: '/work/other' })],
    sections,
    '',
  );
  assert.deepEqual(ids(model.pinned), ['a']);
  assert.deepEqual(model.sections.map((s) => [s.section.name, ids(s.threads)]), [['支付重构', ['b']], ['调研', []]]);
  assert.deepEqual(model.projects.map((p) => [p.name, ids(p.threads)]), [['code', ['c']], ['other', ['d']]]);
  assert.equal(model.count, 4);
});

test('sections follow their position; empty ones stay visible so threads can be filed into them', () => {
  const model = buildSidebar([], sections, '');
  assert.deepEqual(model.sections.map((s) => s.section.id), ['s1', 's2']);
});

test('a thread whose section no longer exists goes back under its project', () => {
  const model = buildSidebar([thread('x', { sectionId: 'deleted' })], sections, '');
  assert.deepEqual(model.projects.map((p) => ids(p.threads)), [['x']]);
});

test('projects are ordered by their most recent thread', () => {
  const newest = thread('n', { cwd: '/work/b' });
  const older = thread('o', { cwd: '/work/a' });
  assert.deepEqual(buildSidebar([newest, older], [], '').projects.map((p) => p.name), ['b', 'a']);
  assert.deepEqual(buildSidebar([older, newest], [], '').projects.map((p) => p.name), ['b', 'a']);
});

test('search matches title or directory, ignores case, and hides sections with no match', () => {
  const list = [thread('Fix Login', { sectionId: 's1' }), thread('other'), thread('z', { cwd: '/work/LOGIN-service' })];
  const model = buildSidebar(list, sections, ' login ');
  assert.deepEqual(model.sections.map((s) => s.section.name), ['支付重构']);
  assert.deepEqual(model.projects.map((p) => p.name), ['LOGIN-service']);
  assert.equal(model.count, 2);
  assert.equal(buildSidebar(list, sections, 'nothing').count, 0);
});

test('one folder reached by two spellings is one project', () => {
  // The newer thread came from the agent, which reports the directory with symlinks resolved.
  const imported = thread('imported', { cwd: '/data/home/me/code', cwdReal: '/data/home/me/code' });
  const older = thread('older', { cwd: '/home/me/code', cwdReal: '/data/home/me/code' });
  const elsewhere = thread('elsewhere', { cwd: '/home/me/code-old', cwdReal: '/data/home/me/code-old' });
  const model = buildSidebar([imported, older, elsewhere], [], '');
  assert.deepEqual(model.projects.map((p) => [p.name, ids(p.threads)]), [['code', ['imported', 'older']], ['code-old', ['elsewhere']]]);
  assert.equal(model.projects[0].key, '/data/home/me/code');
  assert.equal(model.projects[0].cwd, '/data/home/me/code', 'the group shows the spelling of its most recent thread');
});

test('a mark several agents share gets the name only on the agents after its first one', () => {
  // Two accounts of one CLI, another agent, and one from a daemon that sends no marks.
  const agents = [{ id: 'claude', icon: 'M0 0h1' }, { id: 'claude-2', icon: 'M0 0h1' }, { id: 'pi', icon: 'M2 2h1' }, {}, {}];
  assert.deepEqual([...taggedAgents(agents)], ['claude-2']);
  assert.equal(taggedAgents([{ id: 'claude', icon: 'M0 0h1' }, { id: 'pi', icon: 'M2 2h1' }]).size, 0);
});

test('by activity: what wants attention or is at work comes first, the rest by the day it last moved', () => {
  // Local times, so the days fall the same in any time zone.
  const now = new Date(2026, 9, 12, 15, 0);
  const at = (daysAgo: number, hour = 12) => new Date(2026, 9, 12 - daysAgo, hour).toISOString();
  const list = [
    thread('pinned-old', { pinned: true, sectionId: 's1', updatedAt: at(40) }),
    thread('running', { status: 'running', updatedAt: at(0, 14) }),
    thread('today-late', { updatedAt: at(0, 13) }),
    thread('unread-old', { unread: true, updatedAt: at(3) }),
    thread('today-early', { updatedAt: at(0, 1) }),
    thread('yesterday', { updatedAt: at(1, 23) }),
    thread('waiting', { status: 'running', waiting: true, updatedAt: at(0, 9) }),
    thread('week', { updatedAt: at(7) }),
    thread('unread-new', { unread: true, status: 'error', updatedAt: at(0, 10) }),
    thread('month', { updatedAt: at(8) }),
    thread('failed-and-seen', { status: 'error', updatedAt: at(2) }),
  ];
  const model = buildActivity(list, '', now, null);
  assert.deepEqual(model.groups.map((g) => [g.label, ids(g.threads)]), [
    ['优先级', ['waiting', 'unread-new', 'unread-old', 'running']],
    ['今天', ['today-late', 'today-early']],
    ['昨天', ['yesterday']],
    ['过去 7 天', ['failed-and-seen', 'week']],
    ['过去 30 天', ['month']],
    ['更早', ['pinned-old']],
  ]);
  assert.equal(model.count, list.length);

  // The thread on screen is being read: its unread mark does not hold it at the top.
  const reading = buildActivity(list, '', now, 'unread-old');
  assert.deepEqual(ids(reading.groups[0].threads), ['waiting', 'unread-new', 'running']);
  assert.deepEqual(ids(reading.groups.find((g) => g.key === 'week')!.threads), ['failed-and-seen', 'unread-old', 'week']);

  const found = buildActivity(list, 'UNREAD', now, null);
  assert.deepEqual(found.groups.map((g) => [g.label, ids(g.threads)]), [['优先级', ['unread-new', 'unread-old']]]);
  assert.equal(found.count, 2);
  assert.deepEqual(buildActivity([], '', now, null), { groups: [], count: 0 });
});
