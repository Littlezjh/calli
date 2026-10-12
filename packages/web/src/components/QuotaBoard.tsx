import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, Api, PlanQuota } from '../api';
import { formatReset, quotaHeadline, quotaLevel } from '../quota';
import { AgentMark } from './icons';
import { IconClose, IconInfo, IconRefresh } from './icons';

/**
 * Every agent's plan usage on one screen: each instance that can report quota gets a row with its
 * windows (a 5-hour session, a week), when that reading was taken, and a refresh of its own.
 * Reading costs a CLI run per agent on the server — the dashboard keeps to the daemon's cache and
 * a refresh button that means "ask again now" — and a failed refresh keeps the last reading up.
 */

interface Props {
  api: Api;
  agents: AgentInfo[];
  onClose: () => void;
  onError: (e: unknown) => void;
}

/** How often an open board re-reads. The daemon caches for a minute, so this stays cheap. */
const REFRESH_MS = 60_000;

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

type Reading = { quota: PlanQuota } | { failedAt: string; quota: PlanQuota | null } | null;

function QuotaRow({ api, agent, onError, refreshAll }: { api: Api; agent: AgentInfo; onError: (e: unknown) => void; refreshAll: number }) {
  const [reading, setReading] = useState<Reading>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const read = useCallback(
    async (refresh: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      try {
        setReading({ quota: await api.agentQuota(agent.id, refresh) });
      } catch (e) {
        onError(e);
        setReading((prev) => ({ failedAt: new Date().toISOString(), quota: prev && 'quota' in prev ? prev.quota : null }));
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    [api, agent.id, onError],
  );

  // Read on mount and whenever the board's refresh-all fires; the daemon's cache rides along.
  useEffect(() => {
    void read(false);
  }, [read, refreshAll]);

  const quota = reading && 'quota' in reading ? reading.quota : null;
  const failedAt = reading && 'failedAt' in reading ? reading.failedAt : null;

  return (
    <div className="quota-board-row">
      <div className="quota-board-head">
        {agent.icon ? (
          <span className="agent-mark" role="img" aria-label={agent.label}>
            <AgentMark path={agent.icon} size={14} />
          </span>
        ) : null}
        <span className="quota-board-name">{agent.label}</span>
        <button type="button" className="icon-btn" aria-label={`刷新 ${agent.label} 的额度`} onClick={() => void read(true)} disabled={loading}>
          {loading ? <IconInfo size={15} /> : <IconRefresh size={15} />}
        </button>
      </div>
      {quota === null && !loading && <p className="panel-empty">没有读到额度信息{failedAt ? '，上一次也失败了' : ''}。</p>}
      {quota !== null && quota.windows.length === 0 && <p className="panel-empty">没有读到额度信息{failedAt ? '，上一次也失败了' : ''}。</p>}
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
          <p className="quota-checked">
            刷新于 {clock(quota.checkedAt)}
            {failedAt ? ` · 上次刷新失败（${clock(failedAt)}）` : ''}
          </p>
        </>
      )}
      {quota?.note && <p className="quota-note">{quota.note}</p>}
    </div>
  );
}

export function QuotaBoard({ api, agents, onClose, onError }: Props) {
  const [refreshAll, setRefreshAll] = useState(0);
  const rows = agents.filter((a) => a.capabilities.quota);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // While the board is open, take a fresh look every minute; rows share the daemon's cache.
  useEffect(() => {
    const timer = setInterval(() => setRefreshAll((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="panel quota-panel" role="dialog" aria-modal="true" aria-labelledby="quota-board-title" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 id="quota-board-title" className="panel-title">
            <IconInfo size={20} /> 额度看板
          </h2>
          <span className="status-actions">
            <button type="button" className="text-btn strong" onClick={() => setRefreshAll((n) => n + 1)}>
              <IconRefresh size={14} /> 全部刷新
            </button>
            <button className="icon-btn" aria-label="关闭" onClick={onClose}>
              <IconClose size={18} />
            </button>
          </span>
        </header>
        <div className="panel-list quota-list">
          {rows.length === 0 && <p className="panel-empty">这台主机上还没有能报告额度的 agent。</p>}
          {rows.map((agent) => (
            <QuotaRow key={agent.id} api={api} agent={agent} onError={onError} refreshAll={refreshAll} />
          ))}
        </div>
      </div>
    </div>
  );
}
