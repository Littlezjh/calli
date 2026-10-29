import type { AttentionKind, ThreadSummary } from '@calli/extension-api';
import { parseTitleTags, validTag } from './tags';
import type { ConnectionState } from '@calli/extension-api/web';

export function showStaleWarning(state: ConnectionState, observedAt: string | null): boolean {
  return state !== 'live' && observedAt !== null;
}

export const COLUMN_IDS = ['doing', 'waiting', 'review', 'done'] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];
/** Threads waiting to be checked stay in view this long after they last moved; older ones fold. */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Done threads stay in view this long; older ones fold. */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BoardFilters {
  tags: string[];
  project: string[];
  agent: string[];
  scheduled: boolean[];
}

/** Why a card sits in its column, so the card can say it in one line. */
export type CardReason =
  | { kind: 'running'; since: string | null }
  | { kind: 'attention'; attention: Exclude<AttentionKind, 'unread'> }
  | { kind: 'report' }
  | { kind: 'idle'; unread: boolean }
  | { kind: 'done' };

export interface BoardCard {
  thread: ThreadSummary;
  column: ColumnId;
  reason: CardReason;
}

export interface BoardColumn {
  id: ColumnId;
  cards: BoardCard[];
  olderCount: number;
  total: number;
}

export function emptyFilters(): BoardFilters {
  return { tags: [], project: [], agent: [], scheduled: [] };
}

function timestamp(iso: string | null | undefined): number {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Where a thread goes, checked in order: marked done by the person; waiting for the person;
 * running; otherwise the agent's latest progress line decides, and without one a finished turn
 * waits to be checked. Agents can move a card between doing, waiting and review, never to done.
 */
export function cardFor(thread: ThreadSummary): BoardCard {
  const card = (column: ColumnId, reason: CardReason): BoardCard => ({ thread, column, reason });
  if (thread.doneAt) return card('done', { kind: 'done' });
  const attention = thread.attention?.kind;
  if (attention && attention !== 'unread') return card('waiting', { kind: 'attention', attention });
  if (thread.status === 'running') return card('doing', { kind: 'running', since: thread.runningSince });
  if (thread.report?.stage === 'blocked') return card('waiting', { kind: 'report' });
  if (thread.report?.stage === 'doing') return card('doing', { kind: 'report' });
  if (thread.report) return card('review', { kind: 'report' });
  return card('review', { kind: 'idle', unread: thread.unread });
}

/** When the card last moved: done cards by when they were marked. */
export function activeAt(card: BoardCard): number {
  return card.column === 'done' ? timestamp(card.thread.doneAt) : Math.max(timestamp(card.thread.updatedAt), timestamp(card.thread.report?.at));
}

export function matchesFilters(thread: ThreadSummary, filters: BoardFilters): boolean {
  return (filters.tags.length === 0 || parseTitleTags(thread.title).tags.some(tag => filters.tags.some(value => value.toLowerCase() === tag.toLowerCase())))
    && (filters.project.length === 0 || filters.project.includes(thread.project))
    && (filters.agent.length === 0 || filters.agent.includes(thread.agent))
    && (filters.scheduled.length === 0 || filters.scheduled.includes(thread.scheduled));
}

/** The host owns attention and the thread state; the board only places what it publishes. */
export function buildColumns(
  threads: readonly ThreadSummary[],
  filters: BoardFilters,
  now: number,
  expanded: ReadonlySet<ColumnId> = new Set(),
): BoardColumn[] {
  const groups: Record<ColumnId, BoardCard[]> = { doing: [], waiting: [], review: [], done: [] };
  for (const thread of threads) {
    if (!thread.archived && matchesFilters(thread, filters)) {
      const card = cardFor(thread);
      groups[card.column].push(card);
    }
  }
  return COLUMN_IDS.map((id) => {
    const sorted = [...groups[id]].sort((a, b) => Number(b.thread.pinned) - Number(a.thread.pinned)
      || activeAt(b) - activeAt(a) || a.thread.id.localeCompare(b.thread.id));
    const window = id === 'done' ? DONE_WINDOW_MS : id === 'review' ? REVIEW_WINDOW_MS : Infinity;
    const isOlder = (card: BoardCard) => activeAt(card) < now - window;
    return {
      id,
      cards: expanded.has(id) ? sorted : sorted.filter((card) => !isOlder(card)),
      olderCount: sorted.filter(isOlder).length,
      total: sorted.length,
    };
  });
}

/** On phones one column shows at a time: the first that asks something of the person. */
export function firstColumn(columns: readonly BoardColumn[]): ColumnId {
  for (const id of ['waiting', 'review', 'doing'] as const) {
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
    return {
      tags: [...new Set(strings(object.tags).map(tag => tag.trim()).filter(validTag).map(tag => tag.toLowerCase()))],
      project: strings(object.project),
      agent: strings(object.agent),
      scheduled: Array.isArray(object.scheduled)
        ? [...new Set(object.scheduled.filter((item): item is boolean => typeof item === 'boolean'))] : [],
    };
  } catch {
    return emptyFilters();
  }
}
