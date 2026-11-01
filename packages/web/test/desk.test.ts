import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDesk, byPeriod, dueLabel, laneOf, noteSections, tilt, type DeskTodo } from '../src/desk.js';

// Saturday 31 October 2026, 15:00 local time.
const NOW = new Date(2026, 9, 31, 15, 0, 0);
const at = (days: number, hours = 12) => new Date(2026, 9, 31 - days, hours).toISOString();

let n = 0;
function todo(over: Partial<DeskTodo> = {}): DeskTodo {
  n += 1;
  return { id: `t${n}`, text: `plan ${n}`, done: false, parentId: null, position: n, createdAt: at(1), doneAt: null, threads: [], ...over };
}

test('a due date says what it means now, and only a late one needs attention', () => {
  const at = (month: number, day: number, hour: number) => new Date(2026, month, day, hour).toISOString();
  assert.deepEqual(dueLabel(at(9, 29, 18), NOW), { text: '逾期 2 天', overdue: true });
  assert.deepEqual(dueLabel(at(9, 30, 23), NOW), { text: '逾期 1 天', overdue: true });
  const today = dueLabel(at(9, 31, 18), NOW);
  assert.match(today.text, /^今天 .*18/);
  assert.equal(today.overdue, false);
  assert.equal(dueLabel(at(9, 31, 9), NOW).overdue, true);
  assert.deepEqual(dueLabel(at(10, 1, 9), NOW), { text: '明天', overdue: false });
  assert.equal(dueLabel(at(10, 5, 9), NOW).overdue, false);
  assert.match(dueLabel(at(10, 5, 9), NOW).text, /11.*5/);
});

test('lanes come from what the person set, then from waiting, dates and proposals', () => {
  assert.equal(laneOf(todo({ lane: 'later', dueAt: at(1) }), NOW), 'later');
  assert.equal(laneOf(todo({ state: 'waiting' }), NOW), 'wait');
  assert.equal(laneOf(todo({ dueAt: new Date(2026, 9, 31, 23, 0).toISOString() }), NOW), 'you');
  assert.equal(laneOf(todo({ dueAt: new Date(2026, 10, 1, 9, 0).toISOString() }), NOW), 'doing');
  assert.equal(laneOf(todo({ proposals: [{ id: 'p', kind: 'done', evidence: '', threadId: 'x' }] }), NOW), 'you');
  assert.equal(laneOf(todo({ followUpPaused: true }), NOW), 'later');
  assert.equal(laneOf(todo(), NOW), 'doing');
});

test('the desk leaves out finished plans and suggestions, and puts the urgent first', () => {
  const late = todo({ dueAt: at(2) });
  const tonight = todo({ dueAt: new Date(2026, 9, 31, 18).toISOString() });
  const parent = todo();
  const child = todo({ parentId: parent.id });
  const suggestion = todo({ proposed: true, owner: 'me' });
  const finished = todo({ done: true, doneAt: new Date(2026, 9, 28, 10).toISOString() });
  const old = todo({ createdAt: at(6) });
  const desk = buildDesk([tonight, late, parent, child, suggestion, finished, old], NOW);
  assert.deepEqual(desk.lanes.you.map((p) => p.todo.id), [late.id, tonight.id]);
  assert.equal(desk.lanes.you[0].overdue, true);
  assert.equal(desk.first.length, 2);
  assert.deepEqual(desk.inbox.map((t) => t.id), [suggestion.id]);
  const parentPile = desk.lanes.doing.find((p) => p.todo.id === parent.id)!;
  assert.deepEqual(parentPile.children.map((c) => c.id), [child.id]);
  assert.equal(parentPile.cards, 1);
  assert.ok(!Object.values(desk.lanes).flat().some((p) => p.todo.id === finished.id || p.todo.id === child.id));
  assert.equal(desk.stale, 1);
});

test('the week counts what was finished each day and leaves days ahead empty', () => {
  const desk = buildDesk([
    todo({ done: true, doneAt: new Date(2026, 9, 27, 10).toISOString() }),
    todo({ done: true, doneAt: new Date(2026, 9, 27, 16).toISOString() }),
    todo({ done: true, doneAt: new Date(2026, 9, 31, 9).toISOString() }),
    todo({ done: true, doneAt: new Date(2026, 9, 24, 9).toISOString() }),
  ], NOW);
  assert.equal(desk.week[0].date, '2026-10-26');
  assert.deepEqual(desk.week.map((d) => d.done), [0, 2, 0, 0, 0, 1, null]);
  assert.equal(desk.doneThisWeek, 3);
});

test('by time, a matter goes where it last moved', () => {
  const desk = buildDesk([
    todo({ createdAt: at(0, 9) }),
    todo({ createdAt: at(1) }),
    todo({ createdAt: at(4), noteUpdatedAt: at(0, 10) }),
    todo({ createdAt: at(5) }),
  ], NOW);
  const periods = byPeriod(desk.lanes.doing, NOW);
  assert.equal(periods.today.length, 2);
  assert.equal(periods.yesterday.length, 1);
  assert.equal(periods.earlier.length, 1);
});

test('a manual touch or lane change refreshes an old matter without a note or conversation', () => {
  const touched = todo({ createdAt: at(8), updatedAt: at(0, 10) });
  const moved = todo({ createdAt: at(8), updatedAt: at(1), lane: 'wait' });
  const desk = buildDesk([touched, moved], NOW);
  assert.equal(desk.stale, 0);
  assert.equal(desk.lanes.doing[0].idleDays, 0);
  const periods = byPeriod([...desk.lanes.doing, ...desk.lanes.wait], NOW);
  assert.equal(periods.today[0].todo.id, touched.id);
  assert.equal(periods.yesterday[0].todo.id, moved.id);
});

test('note sections put the next step first and drop empty ones', () => {
  const sections = noteSections('## 欠谁什么\n老板要结论\n## 定了什么\n\n## 下一步\n发群里');
  assert.deepEqual(sections.map((s) => s.title), ['下一步', '欠谁什么']);
  assert.equal(sections[0].body, '发群里');
  assert.deepEqual(noteSections('just text'), [{ title: '', body: 'just text' }]);
});

test('tilt is steady per id and stays in range', () => {
  assert.equal(tilt('abc'), tilt('abc'));
  for (const id of ['a', 'bb', 'ccc', 'm-7f3a']) assert.ok(Math.abs(tilt(id)) <= 1.6);
});


test('a step completed today advances an old matter without changing its note', () => {
  const parent = todo({ createdAt: at(8) });
  const child = todo({ parentId: parent.id, createdAt: at(8), done: true, doneAt: at(0) });
  const desk = buildDesk([parent, child], NOW);
  assert.equal(desk.stale, 0);
  assert.equal(desk.lanes.doing[0].idleDays, 0);
  assert.equal(byPeriod(desk.lanes.doing, NOW).today[0].todo.id, parent.id);
});

test('yesterday follows the local calendar across a daylight-saving change', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const now = new Date('2026-11-02T12:00:00-05:00');
    const item = todo({ createdAt: '2026-11-01T00:15:00-04:00' });
    const desk = buildDesk([item], now);
    assert.equal(byPeriod(desk.lanes.doing, now).yesterday[0].todo.id, item.id);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
