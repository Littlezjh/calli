import { useEffect, useState } from 'react';
import type { Api, PlanQuota } from '../api';
import { formatReset, quotaHeadline, quotaLevel } from '../quota';
import { IconClose, IconInfo } from './icons';

interface Props {
  api: Api;
  agentId: string;
  agentLabel: string;
  onClose: () => void;
  onError: (e: unknown) => void;
}

/** How often an open panel re-reads the plan. The daemon caches for a minute, so this stays cheap. */
const REFRESH_MS = 60_000;

/**
 * Plan usage of an agent instance: one bar per window (a 5-hour session, a week), with reset
 * times. Reading it costs a CLI run on the server, so the panel stays on what it gets and says
 * when that was; a failed refresh keeps the last answer on screen.
 */
export function QuotaPanel({ api, agentId, agentLabel, onClose, onError }: Props) {
  const [quota, setQuota] = useState<PlanQuota | null>(null);
  const [failedAt, setFailedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const read = async () => {
    setLoading(true);
    try {
      setQuota(await api.agentQuota(agentId));
      setFailedAt(null);
    } catch (e) {
      onError(e);
      setFailedAt(new Date());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void read();
    const timer = setInterval(read, REFRESH_MS);
    return () => clearInterval(timer);
    // One read per mount: the panel is opened fresh every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="panel quota-panel" role="dialog" aria-modal="true" aria-labelledby="quota-title" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 id="quota-title" className="panel-title">
            <IconInfo size={20} /> {agentLabel} 的额度
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>

        <div className="panel-list quota-list">
          {quota === null && loading && <p className="panel-empty">正在读取，{agentLabel} 要跑一下自己的命令…</p>}
          {quota !== null && quota.windows.length === 0 && (
            <p className="panel-empty">没有读到额度信息。{failedAt ? '上一次读取也失败了。' : ''}</p>
          )}
          {quota !== null && quota.windows.length > 0 && (
            <>
              <p className="quota-headline">{quotaHeadline(quota)}</p>
              {quota.windows.map((w) => (
                <div key={`${w.label}-${w.scope ?? ''}`} className="quota-row">
                  <div className="quota-row-top">
                    <span className={`quota-chip ${quotaLevel(w.usedPercent)}`}>{w.label}</span>
                    {w.scope && <span className="quota-scope">{w.scope}</span>}
                    <span className={`quota-percent ${quotaLevel(w.usedPercent)}`}>{w.usedPercent}%</span>
                  </div>
                  <div className="quota-bar">
                    <div className={`quota-bar-fill ${quotaLevel(w.usedPercent)}`} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
                  </div>
                  <div className="quota-reset">{formatReset(w)}</div>
                </div>
              ))}
              {quota.note && <p className="quota-note">{quota.note}</p>}
              <p className="quota-checked">
                检查于 {new Date(quota.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {failedAt ? ` · 上次刷新失败（${failedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}）` : ''}
              </p>
            </>
          )}
          {quota === null && !loading && <p className="panel-empty">读取失败，稍后再试。</p>}
        </div>

        <div className="status-actions">
          <button type="button" className="text-btn strong" onClick={() => void read()} disabled={loading}>
            刷新
          </button>
        </div>
      </div>
    </div>
  );
}
