import type { AgentMention, Thread } from './api';

/** A segment of a chain as it is read: the thread, which part of it, and where its reading ends. */
export interface ChainEntry {
  thread: Thread;
  /** For a thread the chain came back to: its earlier part, or the part after the return. */
  part?: 'before' | 'after';
  /** Exclusive end of what is read of it (events before this seq); none when it is read to its end. */
  clip?: number;
  /** Turns the thread took on its own after it handed over, left out of the reading and named under it. */
  followups: number;
}

/** The same thread's reading position: a thread the chain came back to is two segments. */
export const entryKey = (entry: { thread: Thread; part?: 'before' | 'after' }): string => `${entry.thread.id}:${entry.part ?? 'after'}`;

/** The live continuation edges: [from, to, countsAsSuccessor]. A continuation made from a thread before it was handed back to does not make that thread a parent. */
function continueEdges(threads: Thread[]): Array<[string, string, boolean]> {
  const byId = new Map(threads.map(item => [item.id, item]));
  const edges: Array<[string, string, boolean]> = [];
  for (const item of threads) {
    const link = item.handover;
    if (link?.mode === 'continue' && !link.detached) {
      const source = byId.get(link.sourceId);
      const earlier = Boolean(source?.handback && link.sourceSeq !== undefined && link.sourceSeq < source.handback.afterSeq);
      edges.push([link.sourceId, item.id, !earlier]);
    }
    if (item.handback) edges.push([item.handback.sourceId, item.id, true]);
  }
  return edges;
}

/**
 * Follow descendants only: another branch of the same root is not this conversation's recipient. A
 * thread the chain came back to is a descendant of the one that handed over to it, and the head
 * again: what it handed over to earlier does not count as a continuation of it.
 */
export function latestHandoverThread(thread: Thread, threads: Thread[]): Thread {
  const edges = continueEdges(threads);
  const descendants = new Set([thread.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [from, to] of edges) {
      if (descendants.has(from) && !descendants.has(to)) { descendants.add(to); changed = true; }
    }
  }
  const candidates = threads.filter(item => descendants.has(item.id));
  const parents = new Set(edges.filter(([, , counts]) => counts).map(([from]) => from));
  const leaves = candidates.filter(item => !parents.has(item.id));
  // A returned thread is newer than the segments in between it came back past; the newest return wins.
  const stamp = (item: Thread) => item.handback?.at ?? item.createdAt;
  return (leaves.length ? leaves : candidates).sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.id.localeCompare(a.id))[0] ?? thread;
}

/**
 * The chain that ends at `head`, oldest first, with what is read of each. Each thread is visited at
 * most twice (a returned one has two parts), so a loop of handovers ends the walk. Stops at a
 * thread the list does not have: older ones are read one by one as the person scrolls up.
 */
export function chainEntries(head: Thread, threads: Thread[]): ChainEntry[] {
  const byId = new Map(threads.map(item => [item.id, item]));
  const visits = new Map<string, number>();
  const entries: ChainEntry[] = [];
  let clip: number | undefined;
  let followups = 0;
  for (let at: Thread | undefined = head; at;) {
    const count = visits.get(at.id) ?? 0;
    if (count >= (at.handback ? 2 : 1)) break;
    visits.set(at.id, count + 1);
    const returned = Boolean(at.handback) && count === 0;
    entries.unshift({ thread: at, ...(at.handback ? { part: returned ? 'after' as const : 'before' as const } : {}), ...(clip !== undefined ? { clip } : {}), followups });
    followups = 0;
    if (returned) {
      clip = at.handback!.sourceSeq + 1;
      at = byId.get(at.handback!.sourceId);
    } else if (at.handover && !at.handover.detached) {
      clip = at.handover.sourceSeq === undefined ? undefined : at.handover.sourceSeq + 1;
      followups = at.handover.followups ?? 0;
      at = byId.get(at.handover.sourceId);
    } else break;
  }
  return entries;
}

/**
 * The segments read as pages, oldest first: what leads up to `current` that the list knows of, then
 * what reading on from it goes into. A loop of relations ends the walk instead of repeating a page.
 */
export function readingPath(current: { thread: Thread; part?: 'before' | 'after' }, threads: Thread[], laterOf?: (entry: { thread: Thread; part?: 'before' | 'after' }) => ChainEntry | undefined, earlier = true): ChainEntry[] {
  const own: ChainEntry = { thread: current.thread, ...(current.part ? { part: current.part } : {}), followups: 0 };
  const path = earlier ? chainEntries(current.thread, threads) : [];
  if (!path.length || entryKey(path[path.length - 1]) !== entryKey(own)) path.push(own);
  const seen = new Set(path.map(entryKey));
  for (let at = path[path.length - 1], next = laterOf?.(at); next && !seen.has(entryKey(next)) && path.length < 200; at = next, next = laterOf?.(at)) {
    seen.add(entryKey(next)); path.push(next);
  }
  return path;
}

/** The entry after `entry` on the way to `head`: what reading on from it goes into. */
export function nextEntry(entry: { thread: Thread; part?: 'before' | 'after' }, head: Thread, threads: Thread[]): ChainEntry | undefined {
  const entries = chainEntries(head, threads);
  const at = entries.findIndex(item => entryKey(item) === entryKey(entry));
  return at >= 0 ? entries[at + 1] : undefined;
}

/**
 * The segment after `from` on the way to the chain's `latest` one: what reading an earlier segment
 * goes on into. Branches that do not lead to `latest` are not part of the way.
 */
export function nextSegment(from: Thread, latest: Thread, threads: Thread[]): Thread | undefined {
  return nextEntry({ thread: from, part: from.handback ? 'before' : undefined }, latest, threads)?.thread;
}

/**
 * What reading `from` goes on into: the next segment of its automatic chain toward `latest`, else
 * the newest conversation it was handed to by hand. A hand-over only counts while `from` has stood
 * still since: once it has had a turn of its own, or is running one, the two are separate
 * conversations and the successor does not follow it.
 */
export function laterSegment(from: Thread, latest: Thread, threads: Thread[], part?: 'before' | 'after'): ChainEntry | undefined {
  const chained = nextEntry({ thread: from, part: part ?? (from.handback ? 'after' : undefined) }, latest, threads);
  if (chained || from.status === 'running') return chained;
  const manual = threads
    .filter(item => item.handover?.sourceId === from.id && !item.handover.automatic && !item.handover.detached && item.handover.sourceMoved === false)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return manual ? { thread: manual, followups: 0 } : undefined;
}

/** Reset loaded ancestors when the daemon changes a relation anywhere on the visible path. */
export function handoverHistoryKey(thread: Thread | undefined, threads: Thread[]): string {
  const seen = new Set<string>();
  const path: string[] = [];
  while (thread && !seen.has(thread.id)) {
    seen.add(thread.id); path.push(`${thread.id}:${thread.handover?.mode ?? ''}:${thread.handback?.afterSeq ?? ''}`);
    thread = thread.handover?.mode === 'continue' ? threads.find(t => t.id === thread!.handover!.sourceId) : undefined;
  }
  return path.join('/');
}

/**
 * While the thread's own agent is out of plan, bringing one other local instance in with @ hands it
 * the thread instead of asking the stranded agent to send it work.
 */
export function takeoverMention(mentions: AgentMention[], exhausted: boolean, current?: string): AgentMention | null {
  const [only] = mentions;
  return exhausted && mentions.length === 1 && only.kind === 'agent' && !only.host && only.id !== current ? only : null;
}

/**
 * A handover made by hand from the dialog: a separate conversation with no method of its own.
 * Automatic ones (resume or summary) have their own undo in the chain record.
 */
export function cancellableHandover(thread: Pick<Thread, 'handover' | 'archivedAt'>): boolean {
  const link = thread.handover;
  return Boolean(link && !thread.archivedAt && link.mode === 'branch' && !link.method && !link.automatic && !link.detached);
}
