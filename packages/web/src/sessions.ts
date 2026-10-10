/** What the import panel shows. Pure, so it can be tested directly. */
import type { AgentSession } from './api';
import { folderName } from './paths';

/** How many sessions the panel lists at once; searching narrows down the rest. */
export const SESSION_LIMIT = 100;

/** Sessions whose title or directory contains the search text, in the order given. */
export function filterSessions(sessions: AgentSession[], search: string): AgentSession[] {
  const query = search.trim().toLowerCase();
  if (!query) return sessions;
  return sessions.filter((s) => s.title.toLowerCase().includes(query) || s.cwd.toLowerCase().includes(query));
}

export function sessionTitle(session: AgentSession): string {
  return session.title.trim() || `${folderName(session.cwd)} 里的未命名会话`;
}

/** "3 小时前" for recent times, a date for older ones, nothing when the time is unknown. */
export function timeAgo(iso: string | null, now: number): string {
  const then = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const d = new Date(then);
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${d.getFullYear()}年${date}`;
}
