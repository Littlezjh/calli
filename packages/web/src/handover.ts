import type { Thread } from './api';

/** Follow descendants only: another branch of the same root is not this conversation's recipient. */
export function latestHandoverThread(thread: Thread, threads: Thread[]): Thread {
  const descendants = new Set([thread.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of threads) {
      if (item.handover && descendants.has(item.handover.sourceId) && !descendants.has(item.id)) {
        descendants.add(item.id); changed = true;
      }
    }
  }
  const candidates = threads.filter(item => descendants.has(item.id));
  const parents = new Set(candidates.map(item => item.handover?.sourceId));
  const leaves = candidates.filter(item => !parents.has(item.id));
  return (leaves.length ? leaves : candidates).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? thread;
}
