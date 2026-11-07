import type { Api } from '../api';
import { t } from '../i18n';
import { useAgentQuota, useQuotaNavigation } from '../quota-reading';
import { QuotaPreview } from './QuotaReadout';
import { IconChevron, IconRefresh } from './icons';

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
