import type { LarkChannelSettings, LarkChannelStatus, LarkRealtime, MatterSignal } from './api';
import { t } from './i18n';

/** How the channel looks from the page, once what the hub reports is read together. */
export type LarkHealth = 'off' | 'no-cli' | 'no-login' | 'no-agent' | 'failed' | 'ok';
export function larkHealth(channel: LarkChannelSettings | null, status: LarkChannelStatus | null): LarkHealth {
  if (!channel?.enabled || !status) return 'off';
  // The hub's last error is a stable code; the ones a person can fix themselves get their own way out.
  if (!status.cli || status.lastError === 'cli_missing') return 'no-cli';
  if (!status.loggedIn || status.lastError === 'lark_not_logged_in' || status.lastError === 'lark_auth_failed') return 'no-login';
  if (status.lastError === 'personal agent is not configured') return 'no-agent';
  return status.lastError ? 'failed' : 'ok';
}

export const LARK_ROLES = ['boss', 'pm', 'other'] as const;
export const LARK_INTERVALS = [15, 30, 60, 120];

/** The realtime line: quiet when live, a warning when events are not coming in, nothing while it settles. */
export function realtimeLine(realtime: LarkRealtime | undefined): { text: string; warn: boolean } | null {
  switch (realtime) {
    case 'live': return { text: t('lark.realtime.live'), warn: false };
    case 'busy-elsewhere':
    case 'console-off':
    case 'unavailable':
    case 'error': return { text: t(`lark.realtime.${realtime}`), warn: true };
    default: return null;
  }
}

const FILTER_REASONS = ['deleted', 'outside-watch-scope', 'not-a-request'] as const;

/** Where a kept signal went, in words. */
export function signalDestination({ outcome, reason }: MatterSignal['disposition']): string {
  if (outcome === 'delivered') return t('desk.signal.delivered');
  if (outcome === 'router') return t('desk.signal.router');
  const known = FILTER_REASONS.find((item) => item === reason);
  return known ? t('desk.signal.filteredBecause', t(`desk.signal.reason.${known}`)) : reason ? t('desk.signal.filteredBecause', reason) : t('desk.signal.filtered');
}
