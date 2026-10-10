import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Todo } from '../src/api.js';
import { buildTodoBoard, linkableThreads, type TodoNode } from '../src/todos.js';

const todo = (id: string, over: Partial<Todo> = {}): Todo => ({
  id,
  text: `plan ${id}`,
  done: false,
  parentId: null,
  position: 0,
  createdAt: '2025-01-01T00:00:00Z',
  doneAt: null,
  threads: [],
  ...over,
});

test('orders plans by position and nests sub-items under their plan', () => {
  const board = buildTodoBoard([
    todo('b', { position: 2 }),
    todo('a', { position: 1 }),
    todo('a2', { parentId: 'a', position: 2 }),
    todo('a1', { parentId: 'a', position: 1 }),
    todo('orphan', { parentId: 'missing' }),
  ]);
  assert.deepEqual(board.open.map((t: TodoNode) => t.id), ['a', 'b']);
  assert.deepEqual(board.open[0].children.map((t) => t.id), ['a1', 'a2']);
});

test('sinks finished plans into a done group, most recently finished first', () => {
  const board = buildTodoBoard([
    todo('old-done', { done: true, doneAt: '2025-01-02T00:00:00Z', position: 1 }),
    todo('open', { position: 2 }),
    todo('new-done', { done: true, doneAt: '2025-01-05T00:00:00Z', position: 3 }),
    todo('undated-done', { done: true, position: 4 }),
  ]);
  assert.deepEqual(board.open.map((t) => t.id), ['open']);
  assert.deepEqual(board.done.map((t) => t.id), ['new-done', 'old-done', 'undated-done']);
});

test('linkableThreads skips threads the plan already has and keeps recency order', () => {
  // Only ids matter here; the helper takes full Thread views.
  const threads = [
    { id: 't1' },
    { id: 't2' },
    { id: 't3' },
  ] as unknown as Todo['threads'];
  const todos = [todo('p', { threads: [threads[1]] })];
  assert.deepEqual(linkableThreads(todos, 'p', threads).map((t) => t.id), ['t1', 't3']);
  // An unknown plan (race with a delete) offers everything.
  assert.equal(linkableThreads(todos, 'gone', threads).length, 3);
});
