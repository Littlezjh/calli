/** What extensions see of a thread. Pure, so it can be tested directly. */
import type { ThreadSummary, TodoSummary } from '@rah/extension-api';
import type { Thread, Todo } from '../api';
import { projectDir, threadAttention } from '../sidebar';

/**
 * The whitelisted summary of a thread, as the daemon's extension host makes it, with `unread`
 * and `attention` worked out for this device: the thread on screen is never unread. Nothing that
 * may hold conversation content is copied: no `preview`, no queued messages.
 */
export function threadSummary(t: Thread, selectedId: string | null): ThreadSummary {
  return {
    id: t.id,
    title: t.title,
    agent: t.agent,
    project: projectDir(t).cwd,
    status: t.status,
    attention: threadAttention(t, selectedId),
    runningSince: t.status === 'running' ? (t.runningSince ?? null) : null,
    unread: t.unread && t.id !== selectedId,
    pinned: t.pinned,
    archived: t.archivedAt !== null,
    scheduled: Boolean(t.schedule),
    worktree: Boolean(t.worktree),
    handover: Boolean(t.handover),
    teamSize: t.coordination && t.coordination.rootId === t.id ? t.coordination.children : 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** The threads a view gets: not archived, and team members only when their lead is not listed (as in the sidebar). */
export function threadSummaries(threads: Thread[], selectedId: string | null): ThreadSummary[] {
  const ids = new Set(threads.map((t) => t.id));
  return threads
    .filter((t) => !t.archivedAt && (!t.coordination || t.coordination.rootId === t.id || !ids.has(t.coordination.rootId)))
    .map((t) => threadSummary(t, selectedId));
}

/**
 * Top-level plan items for views holding `worksource.read`, in plan-page order. Sub-items are
 * the item's checklist: they count towards `items`, and threads working on an open one, and what
 * their agents report, count for the item.
 */
export function todoSummaries(todos: Todo[]): TodoSummary[] {
  const children = new Map<string, Todo[]>();
  for (const todo of todos) if (todo.parentId) children.set(todo.parentId, [...(children.get(todo.parentId) ?? []), todo]);
  return todos.filter((todo) => !todo.parentId).map((todo) => {
    const items = children.get(todo.id) ?? [];
    const working = [todo, ...items.filter((item) => !item.done)];
    const threadIds = [...new Set(working.flatMap((item) => item.threads.map((thread) => thread.id)))];
    // The newest thing any agent said about the item or an open sub-item.
    const report = working.map((item) => item.report).reduce<Todo['report']>((best, next) => (next && (!best || next.at > best.at) ? next : best), null) ?? null;
    return {
      id: todo.id,
      text: todo.text,
      done: todo.done,
      doneAt: todo.doneAt,
      createdAt: todo.createdAt,
      threadIds,
      items: { done: items.filter((item) => item.done).length, total: items.length },
      report,
    };
  });
}
