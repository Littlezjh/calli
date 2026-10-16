/** What deserves the user's attention in threads they are not looking at. Pure, so it can be tested directly. */
import type { Thread } from './api';

export interface Notice {
  threadId: string;
  kind: 'waiting' | 'error';
  message: string;
  /** Label of the button that takes the user to the thread. */
  action: string;
}

const short = (title: string) => (title.length > 24 ? `${title.slice(0, 23)}…` : title);

const WAITING = {
  approval: { label: '等待批准', message: '在等你批准', action: '去批准' },
  question: { label: '等待回答', message: '有问题等你回答', action: '去回答' },
  plan: { label: '计划待确认', message: '的计划等你确认', action: '查看计划' },
  unknown: { label: '等待处理', message: '需要你处理', action: '去查看' },
} as const;

const waitingDetails = (thread: Thread) => WAITING[thread.waitingReason ?? 'unknown'];
export const waitingLabel = (thread: Thread): string => waitingDetails(thread).label;

/**
 * Compares two snapshots of the thread list and says what just happened elsewhere: a thread started
 * waiting for a response, or a turn failed. `viewingId` is the thread on
 * screen (null when the page is hidden or no thread is open); what happens there needs no notice.
 *
 * Successful completion stays quiet; unread markers and the tab count carry that state.
 * A failed turn is recognised by becoming unread, even if it ran between two snapshots.
 */
export function threadNotices(before: Thread[], after: Thread[], viewingId: string | null): Notice[] {
  const previous = new Map(before.map((t) => [t.id, t]));
  const out: Notice[] = [];
  for (const t of after) {
    const was = previous.get(t.id);
    if (!was || t.id === viewingId) continue;
    if (t.waiting && (!was.waiting || t.waitingReason !== was.waitingReason)) {
      const detail = waitingDetails(t);
      out.push({ threadId: t.id, kind: 'waiting', message: `“${short(t.title)}” ${detail.message}`, action: detail.action });
    } else if (t.unread && !was.unread && t.status === 'error') {
      out.push({ threadId: t.id, kind: 'error', message: `“${short(t.title)}” 出错了`, action: '打开' });
    }
  }
  return out;
}

/** Threads that want attention: waiting for a response, or finished and not yet looked at. */
export function attentionCount(threads: Thread[], viewingId: string | null): number {
  return threads.filter((t) => t.waiting || (t.unread && t.id !== viewingId)).length;
}

/** The browser tab title: the count goes first so it survives a narrow tab. */
export function pageTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

export type ThreadMark = 'waiting' | 'running' | 'error' | 'unread' | null;

/**
 * The one dot a thread gets in the list. Waiting for the user outranks everything else. A failure is
 * news like any other result: once the thread has been looked at, the dot goes; the error stays in the thread.
 */
export function threadMark(thread: Thread, selected: boolean): ThreadMark {
  if (thread.waiting) return 'waiting';
  if (thread.status === 'running') return 'running';
  if (thread.unread && !selected) return thread.status === 'error' ? 'error' : 'unread';
  return null;
}
