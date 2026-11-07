import type { Api } from '../api';
import { t } from '../i18n';
import { periodName, quotaGroups, quotaLeft, quotaSlots } from '../quota';
import { useAgentQuota, useQuotaNavigation } from '../quota-reading';
import { QuotaPreview, quotaStale, quotaWindowName } from './QuotaReadout';
import { IconChevron, IconRefresh } from './icons';

/** The conversation reads only its own account, sharing the menu and board's cache. */
export function ChatQuotaPreview({ api, agent, onOpen }: { api: Api; agent: string; onOpen: () => void }) {
  const reading = useAgentQuota(api, agent);
  const windows = reading.quota?.windows ?? [];
  const primary = quotaGroups(windows)[0];
  const slots = primary ? quotaSlots(primary.windows).slice(0, 2) : [];
  const stale = quotaStale(reading);
  const attention = Boolean(reading.error || windows.some(window => (window.loadPercent ?? 0) >= 100 || window.usedPercent >= 80 && !slots.some(slot => slot.window === window)));
  const status = reading.error ? windows.length ? t('quota.cached') : t('quota.unavailable')
    : stale ? t('quota.cachedReading') : reading.loading ? t('quota.updating') : !reading.quota ? t('quota.notRead') : t('quota.empty');
  const description = windows.length ? `${stale ? `${status} · ` : ''}${windows.map(window => `${quotaWindowName(window)} ${t('quota.remaining', quotaLeft(window))}`).join(' · ')}` : status;
  return <button type="button" className={`chat-quota-preview${stale ? ' stale' : ''}`} onClick={onOpen}
    aria-label={t('quota.preview', description)} title={description} aria-haspopup="menu">
    {primary ? slots.map(({ label, window }, index) => {
      const remaining = window ? quotaLeft(window) : undefined;
      return <span key={index} className={`chat-quota-window${remaining === 0 ? ' exhausted' : remaining !== undefined && remaining <= 20 ? ' low' : ''}`}
        role={window ? 'meter' : undefined} aria-label={window ? quotaWindowName(window) : `${periodName(label)} · ${t('quota.notReported')}`}
        aria-valuemin={window ? 0 : undefined} aria-valuemax={window ? 100 : undefined} aria-valuenow={remaining}
        aria-valuetext={remaining !== undefined ? t('quota.remaining', remaining) : undefined}>
        <span className="chat-quota-number"><span>{label === '7D' ? t('quota.weeklyShort') : label.toLowerCase()}</span><span>{remaining === undefined ? t('quota.unknown') : t('quota.percent', remaining)}</span></span>
        <span className={`chat-quota-track${window ? '' : ' missing'}`} aria-hidden="true">{window && <span style={{ width: `${remaining}%` }} />}</span>
      </span>;
    }) : <span className="chat-quota-status">{status}</span>}
    {attention && <span className="chat-quota-attention" aria-label={t('quota.attention')}>!</span>}
  </button>;
}

/** Mounted inside the open thread menu, so there is no second quota panel to drill into. */
export function ChatQuotaMenu({ api, agent, label, close }: { api: Api; agent: string; label: string; close: () => void }) {
  const reading = useAgentQuota(api, agent);
  const open = useQuotaNavigation();
  return <section className="quota-menu-preview" aria-label={t('quota.quickTitle')}>
    <div className="quota-menu-head"><strong>{t('app.quota')}</strong><span>{label}{reading.quota?.plan && ` · ${reading.quota.plan.label}`}</span>
      <button type="button" role="menuitem" className="icon-btn" aria-disabled={reading.loading} aria-label={t('quota.refreshAgent', label)} onClick={() => { if (!reading.loading) void reading.refresh(); }}><IconRefresh size={14} /></button>
    </div>
    <QuotaPreview reading={reading} />
    {open && <button type="button" role="menuitem" className="quota-menu-all" onClick={() => { close(); open(); }}>{t('quota.all')}<IconChevron size={14} /></button>}
  </section>;
}
