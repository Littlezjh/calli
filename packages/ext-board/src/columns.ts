import type { AttentionKind, ThreadSummary, TodoSummary } from '@rah/extension-api';
import type { ConnectionState } from '@rah/extension-api/web';

export function showStaleWarning(state: ConnectionState, observedAt: string | null): boolean {
  return state !== 'live' && observedAt !== null;
}

export const COLUMN_IDS = ['todo', 'doing', 'waiting', 'review', 'done'] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];
/** Done items stay in view this long; older ones fold behind one row. */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BoardFilters {
  project: string[];
  agent: string[];
}

/** Why a card sits in its column, so the card can say it in one line. */
export type CardReason =
  | { kind: 'unlinked' }
  | { kind: 'running'; since: string | null }
  | { kind: 'attention'; attention: Exclude<AttentionKind, 'unread'> }
  | { kind: 'report' }
  | { kind: 'idle'; unread: boolean }
  | { kind: 'done' };

export interface BoardCard {
  todo: TodoSummary;
  column: ColumnId;
  reason: CardReason;
  /** Linked threads the thread list carries. */
  threads: ThreadSummary[];
  /** The thread that put the card in its column, opened when the card is clicked. */
  lead: ThreadSummary | null;
  /** When the card last changed, for ordering. */
  activeAt: number;
}

export interface BoardColumn {
  id: ColumnId;
  cards: BoardCard[];
  olderCount: number;
  total: number;
}

export function emptyFilters(): BoardFilters {
  return { project: [], agent: [] };
}

function timestamp(iso: string | null | undefined): number {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(time) ? time : 0;
}

const WAIT_ORDER: Exclude<AttentionKind, 'unread'>[] = ['approval', 'question', 'plan', 'error'];
const newest = (threads: ThreadSummary[]) => threads.reduce<ThreadSummary | null>(
  (best, thread) => (!best || timestamp(thread.updatedAt) > timestamp(best.updatedAt) ? thread : best), null);

/**
 * Where a plan item goes, checked in order: ticked by the person; a linked thread waits for the
 * person; one is running; nothing linked yet; otherwise the agent's latest report decides, and
 * without one a finished thread waits to be checked. Agents can move a card between doing,
 * waiting and review, never to done.
 */
export function cardFor(todo: TodoSummary, threadsById: ReadonlyMap<string, ThreadSummary>): BoardCard {
  const threads = todo.threadIds.map((id) => threadsById.get(id)).filter((thread): thread is ThreadSummary => thread !== undefined);
  const reported = todo.report ? threads.find((thread) => thread.id === todo.report?.threadId) ?? null : null;
  const card = (column: ColumnId, reason: CardReason, lead: ThreadSummary | null): BoardCard => ({
    todo, column, reason, threads, lead,
    activeAt: column === 'done' ? timestamp(todo.doneAt)
      : Math.max(timestamp(lead?.updatedAt), timestamp(todo.report?.at), timestamp(todo.createdAt)),
  });
  if (todo.done) return card('done', { kind: 'done' }, reported ?? newest(threads));
  for (const kind of WAIT_ORDER) {
    const waiting = threads.find((thread) => thread.attention?.kind === kind);
    if (waiting) return card('waiting', { kind: 'attention', attention: kind }, waiting);
  }
  const running = threads.find((thread) => thread.status === 'running');
  if (running) return card('doing', { kind: 'running', since: running.runningSince }, running);
  if (todo.threadIds.length === 0) return card('todo', { kind: 'unlinked' }, null);
  const lead = reported ?? newest(threads);
  if (todo.report?.stage === 'blocked') return card('waiting', { kind: 'report' }, lead);
  if (todo.report?.stage === 'doing') return card('doing', { kind: 'report' }, lead);
  if (todo.report) return card('review', { kind: 'report' }, lead);
  return card('review', { kind: 'idle', unread: threads.some((thread) => thread.unread) }, lead);
}

export function matchesFilters(card: BoardCard, filters: BoardFilters): boolean {
  return (filters.project.length === 0 || card.threads.some((thread) => filters.project.includes(thread.project)))
    && (filters.agent.length === 0 || card.threads.some((thread) => filters.agent.includes(thread.agent)));
}

/** The host owns attention and the plan; the board only places what they publish. */
export function buildColumns(
  todos: readonly TodoSummary[],
  threads: readonly ThreadSummary[],
  filters: BoardFilters,
  now: number,
  showOlder = false,
): BoardColumn[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const groups: Record<ColumnId, BoardCard[]> = { todo: [], doing: [], waiting: [], review: [], done: [] };
  for (const todo of todos) {
    const card = cardFor(todo, byId);
    if (matchesFilters(card, filters)) groups[card.column].push(card);
  }
  return COLUMN_IDS.map((id) => {
    // Not started keeps the plan page's order; the rest put what moved last first.
    const sorted = id === 'todo' ? groups[id] : [...groups[id]].sort((a, b) => b.activeAt - a.activeAt || a.todo.id.localeCompare(b.todo.id));
    const isOlder = (card: BoardCard) => id === 'done' && timestamp(card.todo.doneAt) < now - DONE_WINDOW_MS;
    return {
      id,
      cards: showOlder ? sorted : sorted.filter((card) => !isOlder(card)),
      olderCount: sorted.filter(isOlder).length,
      total: sorted.length,
    };
  });
}

/** On phones one column shows at a time: the first that asks something of the person. */
export function firstColumn(columns: readonly BoardColumn[]): ColumnId {
  for (const id of ['waiting', 'review', 'doing', 'todo'] as const) {
    if (columns.find((column) => column.id === id)?.total) return id;
  }
  return 'waiting';
}

export function projectName(project: string): string {
  return project.split(/[\\/]/).filter(Boolean).at(-1) ?? project;
}

/** Untrusted persisted preferences must never prevent the view from opening. */
export function parseFilters(value: string | null): BoardFilters {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    if (!parsed || typeof parsed !== 'object') return emptyFilters();
    const object = parsed as Record<string, unknown>;
    const strings = (input: unknown) => Array.isArray(input)
      ? [...new Set(input.filter((item): item is string => typeof item === 'string'))] : [];
    return { project: strings(object.project), agent: strings(object.agent) };
  } catch {
    return emptyFilters();
  }
}
