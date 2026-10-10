import type { Todo } from './api';

/** A plan with its sub-items. Children keep done ones in place: they strike through where they are. */
export interface TodoNode extends Todo {
  children: TodoNode[];
}

/** The plan list in display order: open plans first, then the recently finished ones. */
export interface TodoBoard {
  open: TodoNode[];
  /** Finished plans with their sub-items, most recently finished first. */
  done: TodoNode[];
}

/**
 * Shapes what the server returns into what the panel shows:
 * - sub-items nested under their plan, both levels ordered by `position`
 * - finished plans sink to the bottom group, newest first
 */
export function buildTodoBoard(todos: Todo[]): TodoBoard {
  const byParent = new Map<string, Todo[]>();
  for (const t of todos) {
    if (!t.parentId) continue;
    const list = byParent.get(t.parentId);
    if (list) list.push(t);
    else byParent.set(t.parentId, [t]);
  }
  for (const list of byParent.values()) list.sort(byPosition);

  const topLevel = todos.filter((t) => !t.parentId).sort(byPosition);
  const node = (t: Todo): TodoNode => ({ ...t, children: (byParent.get(t.id) ?? []).map(node) });
  return {
    open: topLevel.filter((t) => !t.done).map(node),
    done: topLevel.filter((t) => t.done).map(node).sort(byFinished),
  };
}

const byPosition = (a: Todo, b: Todo): number => a.position - b.position || a.createdAt.localeCompare(b.createdAt);

const byFinished = (a: Todo, b: Todo): number =>
  (b.doneAt ?? b.createdAt).localeCompare(a.doneAt ?? a.createdAt);

/** Threads that can still be linked to a plan: not linked yet, most recently active first. */
export function linkableThreads(todos: Todo[], todoId: string, threads: Todo['threads']): Todo['threads'] {
  const todo = todos.find((t) => t.id === todoId);
  const linked = new Set(todo?.threads.map((t) => t.id) ?? []);
  return threads.filter((t) => !linked.has(t.id));
}
