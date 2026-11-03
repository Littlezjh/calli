import { useState } from 'react';
import type { Api, MatterSignal } from '../api';
import { formatDateTime, t } from '../i18n';
import { signalDestination } from '../lark';
import { IconChevron } from './icons';

/** What has reached a matter from outside. Nothing is read until this opens. */
export function MatterSignals({ api, matterId }: { api: Api; matterId: string }) {
  const [open, setOpen] = useState(false);
  const [signals, setSignals] = useState<MatterSignal[] | null>(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    void api.matterSignals(matterId).then(value => setSignals(value.signals)).catch(e => setError(e instanceof Error ? e.message : String(e)));
  };
  const toggle = () => {
    if (!open && !signals) load();
    setOpen(on => !on);
  };
  return <div className="desk-subscriptions desk-signals">
    <button className="desk-subscriptions-toggle" aria-expanded={open} onClick={toggle}>{signals ? t('desk.signalCount', signals.length) : t('desk.signals')}<IconChevron size={13} open={open} /></button>
    {open && (error ? <p className="desk-signals-note" role="alert">{error} <button className="ghost" onClick={load}>{t('common.retry')}</button></p>
      : !signals ? <p className="desk-signals-note" role="status">{t('common.loading')}</p>
      : !signals.length ? <p className="desk-signals-note">{t('desk.noSignals')}</p>
      : <ul>{signals.map(signal => <li key={signal.key}>
        <time>{formatDateTime(signal.at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        <span className="desk-signal-summary" title={signal.summary ?? undefined}>{signal.summary || t('desk.signal.noSummary')}</span>
        <span className="desk-signal-where">{signalDestination(signal.disposition)}</span>
      </li>)}</ul>)}
  </div>;
}
