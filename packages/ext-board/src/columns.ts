import type { ThreadSummary } from '@rah/extension-api';
import type { ConnectionState } from '@rah/extension-api/web';

export function showStaleWarning(state: ConnectionState, observedAt: string | null): boolean {
  return state !== 'live' && observedAt !== null;
}

export const COLUMN_IDS = ['attention', 'running', 'idle'] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];
export const IDLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface BoardFilters {
  project: string[];
  agent: string[];
  scheduled: boolean[];
}

export interface BoardColumn {
  id: ColumnId;
  threads: ThreadSummary[];
  olderCount: number;
  total: number;
}

export function emptyFilters(): BoardFilters {
  return { project: [], agent: [], scheduled: [] };
}

export function columnFor(thread: ThreadSummary): ColumnId {
  if (thread.attention !== null) return 'attention';
  return thread.status === 'running' ? 'running' : 'idle';
}

export function matchesFilters(thread: ThreadSummary, filters: BoardFilters): boolean {
  return (filters.project.length === 0 || filters.project.includes(thread.project))
    && (filters.agent.length === 0 || filters.agent.includes(thread.agent))
    && (filters.scheduled.length === 0 || filters.scheduled.includes(thread.scheduled));
}

function timestamp(iso: string): number {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}

/** The host owns attention; the board only groups its published judgement. */
export function buildColumns(
  threads: readonly ThreadSummary[],
  filters: BoardFilters,
  now: number,
  showOlder = false,
): BoardColumn[] {
  const groups: Record<ColumnId, ThreadSummary[]> = { attention: [], running: [], idle: [] };
  for (const thread of threads) {
    if (!thread.archived && matchesFilters(thread, filters)) groups[columnFor(thread)].push(thread);
  }
  return COLUMN_IDS.map((id) => {
    const sorted = groups[id].sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.id.localeCompare(b.id));
    const isOlder = (thread: ThreadSummary) => id === 'idle' && timestamp(thread.updatedAt) < now - IDLE_WINDOW_MS;
    return {
      id,
      threads: showOlder ? sorted : sorted.filter((thread) => !isOlder(thread)),
      olderCount: sorted.filter(isOlder).length,
      total: sorted.length,
    };
  });
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
      project: strings(object.project),
      agent: strings(object.agent),
      scheduled: Array.isArray(object.scheduled)
        ? [...new Set(object.scheduled.filter((item): item is boolean => typeof item === 'boolean'))] : [],
    };
  } catch {
    return emptyFilters();
  }
}
