import type { PlanQuota, QuotaWindow } from './api';
import { formatDate, t } from './i18n';

/** Colour class for a bar: calm under half, warning past it, danger when nearly full. */
export function quotaLevel(usedPercent: number): 'ok' | 'warn' | 'danger' {
  return usedPercent >= 80 ? 'danger' : usedPercent >= 50 ? 'warn' : 'ok';
}

/**
 * When a window resets, as a short local-time note: "Resets 14:40" while it is today,
 * "Resets Oct 12 07:00" otherwise. Empty when unknown.
 */
export function formatReset(window: QuotaWindow, now = new Date()): string {
  if (!window.resetsAt) return '';
  const at = new Date(window.resetsAt);
  if (Number.isNaN(at.getTime())) return '';
  const sameDay = at.toDateString() === now.toDateString();
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return t('quota.resets', sameDay ? hm : `${formatDate(at, { month: 'short', day: 'numeric' })} ${hm}`);
}

/** The board's rows: agents that report quota, with the one in use moved to the top. */
export function quotaRows<T extends { id: string; capabilities: { quota: boolean } }>(agents: T[], current?: string): T[] {
  const rows = agents.filter((a) => a.capabilities.quota);
  return [...rows.filter((a) => a.id === current), ...rows.filter((a) => a.id !== current)];
}

/** What the panel headline says: the most-used window's level, so the user sees the worst first. */
export function quotaHeadline(quota: PlanQuota): string {
  if (quota.windows.length === 0) return t('quota.none');
  const worst = quota.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return t('quota.worst', worst.usedPercent);
}
