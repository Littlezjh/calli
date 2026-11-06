import type { QuotaWindow } from '../api';
import { formatDateTime, t } from '../i18n';
import { formatReset, periodName, quotaLeft } from '../quota';
import type { QuotaReading } from '../quota-reading';

export const quotaWindowName = (window: QuotaWindow) => [window.scope, periodName(window.label)].filter(Boolean).join(' · ');
export const quotaStale = (reading: QuotaReading) => Boolean(reading.failedAt || reading.quota && Date.now() - Date.parse(reading.quota.checkedAt) > 60_000);

export function QuotaMeter({ window, stale = false, detail = false }: { window: QuotaWindow; stale?: boolean; detail?: boolean }) {
  const remaining = quotaLeft(window);
  return <div className={`quota-meter${stale ? ' stale' : remaining === 0 ? ' exhausted' : remaining <= 20 ? ' low' : ''}`}
    role="meter" aria-label={quotaWindowName(window)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}
    aria-valuetext={`${stale ? `${t('quota.cachedReading')} · ` : ''}${t('quota.remaining', remaining)}`}>
    <div className="quota-meter-label"><span>{quotaWindowName(window)}</span><strong className="quota-percent">{stale && <small>{t('quota.cachedReading')} · </small>}{t('quota.remaining', remaining)}</strong></div>
    <div className="quota-meter-track" aria-hidden="true"><div style={{ width: `${remaining}%` }} /></div>
    <span className="quota-meter-reset">{formatReset(window) || t('quota.resetUnknown')}</span>
    {detail && <span className="quota-meter-used">{t('quota.board.used', window.usedPercent)}</span>}
    {window.loadPercent !== undefined && (detail || window.loadPercent >= 100) && <span className={`quota-load${window.loadPercent >= 100 ? ' high' : ''}`}>{t('quota.load', window.loadPercent)}</span>}
  </div>;
}

export function QuotaReadingStatus({ reading, detail = false }: { reading: QuotaReading; detail?: boolean }) {
  const { quota, loading, error } = reading;
  const stale = quotaStale(reading);
  const constrained = quota?.windows.filter(window => window.usedPercent >= 80).length ?? 0;
  const exhausted = quota?.windows.some(window => window.usedPercent >= 100);
  const status = loading ? t('quota.updating') : error ? quota?.windows.length ? t('quota.cached') : t('quota.unavailable')
    : !quota ? t('quota.loading') : !quota.windows.length ? t('quota.empty') : stale ? t('quota.cachedReading') : '';
  return <div className={`quota-reading-status${error || constrained ? ' attention' : ''}`} role="status">
    {status && <span>{status}</span>}
    {!stale && exhausted ? <span>{t('quota.exhausted')}</span> : !stale && constrained > 0 ? <span>{t('quota.lowCount', constrained)}</span> : null}
    {detail && quota && <span>{t('quota.updatedAt', formatDateTime(new Date(quota.checkedAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>}
    {detail && error && <span className="quota-read-error">{error}</span>}
  </div>;
}

/** The same per-window detail is used in a chat quick look and the account page. */
export function QuotaWindows({ reading, detail = false }: { reading: QuotaReading; detail?: boolean }) {
  return <>
    <QuotaReadingStatus reading={reading} detail />
    {reading.quota?.windows.map((window, index) => <QuotaMeter key={`${window.label}:${window.scope ?? ''}:${index}`} window={window} stale={quotaStale(reading)} detail={detail} />)}
    {reading.quota?.note && <p className="quota-note">{reading.quota.note}</p>}
  </>;
}
