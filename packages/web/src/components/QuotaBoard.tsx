import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentInfo, Api, PlanQuota, QuotaWindow } from '../api';
import { formatReset, periodName, quotaColumns, quotaGroups, quotaLeft, quotaLevel, quotaRows, shortReset } from '../quota';
import { AgentMark } from './icons';
import { IconClose, IconRefresh } from './icons';
import { formatDateTime, t } from '../i18n';

/**
 * Every agent's plan usage on one screen, as a table: an agent (or a model group of one) a row,
 * a window length a column, so the 5-hour and weekly windows of every agent line up. A cell is a
 * ring and what is left, with when it resets under it; a tap opens the rest (how much is used,
 * the full reset time, how busy the model is). Colour is kept for a window running out.
 * Reading costs a CLI run per agent on the server — an open board keeps to the daemon's cache, and
 * the refresh buttons mean "ask again now" — and a failed refresh keeps the last reading up.
 */

interface Props {
  api: Api;
  agents: AgentInfo[];
  /** The agent of the thread on screen; its row comes first. */
  current?: string;
  onClose: () => void;
  onError: (e: unknown) => void;
}

/** How often an open board re-reads. The daemon caches for a minute, so this stays cheap. */
const REFRESH_MS = 60_000;

const clock = (iso: string): string => {
  const at = new Date(iso);
  return formatDateTime(at, { ...(at.toDateString() !== new Date().toDateString() ? { month: 'numeric', day: 'numeric' } as const : {}), hour: '2-digit', minute: '2-digit' });
};

type Reading = { api: Api; agent: string; quota: PlanQuota | null; failedAt?: string };

/** What is left of a window, drawn the way the agent picker draws it: a ring that empties. */
function Ring({ left }: { left: number }) {
  return (
    <svg className="quota-cell-ring" width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="quota-cell-ring-track" cx="8" cy="8" r="6" fill="none" strokeWidth={2.4} />
      {left > 0 && (
        <circle className="quota-cell-ring-fill" cx="8" cy="8" r="6" fill="none" strokeWidth={2.4} strokeLinecap={left < 100 ? 'round' : 'butt'}
          pathLength={100} strokeDasharray={`${left} 100`} transform="rotate(-90 8 8)" />
      )}
    </svg>
  );
}

/** One window in its column. A window this agent does not have is a dash. */
function Cell({ window, open, onToggle }: { window?: QuotaWindow; open: boolean; onToggle: () => void }) {
  if (!window) return <span className="quota-cell quota-none" aria-hidden="true">—</span>;
  const left = quotaLeft(window);
  const low = quotaLevel(window.usedPercent) === 'danger';
  const busy = window.loadPercent !== undefined && window.loadPercent >= 100;
  return (
    <button type="button" className={`quota-cell${low ? ' low' : ''}${open ? ' open' : ''}`} aria-expanded={open}
      aria-label={t('quota.board.cell', periodName(window.label), left)} onClick={onToggle}>
      <span className="quota-cell-main">
        <Ring left={left} />
        <span className="quota-percent">{left}%</span>
        {busy && <span className="quota-busy" title={t('quota.board.busy')} />}
      </span>
      <span className="quota-cell-reset">{shortReset(window)}</span>
    </button>
  );
}

/** What a tapped cell has to say beyond its ring: used, the full reset time, the model's load. */
function CellDetail({ window }: { window: QuotaWindow }) {
  const reset = formatReset(window);
  return (
    <div className="quota-detail" role="status">
      <span className="quota-detail-name">{periodName(window.label)}{window.scope ? ` · ${window.scope}` : ''}</span>
      <span>{t('quota.board.left', quotaLeft(window))} · {t('quota.board.used', window.usedPercent)}</span>
      {reset && <span>{reset}</span>}
      {window.loadPercent !== undefined && <span className={`quota-load${window.loadPercent >= 100 ? ' high' : ''}`}>{t('quota.load', window.loadPercent)}</span>}
    </div>
  );
}

function QuotaRow({ api, agent, columns, onQuota, onError, refreshAll, askAll }: {
  api: Api;
  agent: AgentInfo;
  columns: string[];
  onQuota: (agent: string, quota: PlanQuota | null) => void;
  onError: (e: unknown) => void;
  refreshAll: number;
  askAll: number;
}) {
  const [reading, setReading] = useState<Reading>(() => ({ api, agent: agent.id, quota: api.cachedAgentQuota(agent.id) }));
  const [loading, setLoading] = useState(true);
  const [refreshRow, setRefreshRow] = useState(0);
  // The cell whose detail is open, by group and column; one at a time.
  const [opened, setOpened] = useState<string | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;

  // Read on mount and on the board's minute tick, where the daemon's cache rides along;
  // the board's refresh-all button asks every agent again, like a row's own button.
  const asked = useRef({ all: askAll, row: refreshRow });
  useEffect(() => {
    let alive = true;
    const again = asked.current.all !== askAll || asked.current.row !== refreshRow;
    asked.current = { all: askAll, row: refreshRow };
    setReading({ api, agent: agent.id, quota: api.cachedAgentQuota(agent.id) });
    setLoading(true);
    void api.agentQuota(agent.id, again).then(quota => {
      if (alive) setReading({ api, agent: agent.id, quota });
    }).catch(e => {
      if (!alive) return;
      setReading({ api, agent: agent.id, quota: api.cachedAgentQuota(agent.id), failedAt: new Date().toISOString() });
      errorHandler.current(e);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, agent.id, refreshAll, askAll, refreshRow]);

  // Never show the previous machine's values while a different API client starts its request.
  const current: Pick<Reading, 'quota' | 'failedAt'> = reading.api === api && reading.agent === agent.id ? reading : { quota: api.cachedAgentQuota(agent.id) };
  const { quota, failedAt } = current;

  // The board sizes its columns from every agent's windows.
  const report = useRef(onQuota);
  report.current = onQuota;
  useEffect(() => { report.current(agent.id, quota); }, [agent.id, quota]);

  const windows = quota?.windows ?? [];
  // An agent with one window of each length shows them on its own line, beside its name; what
  // model they cover is in a cell's detail. Only windows of one length for several models (one
  // for Gemini, one for Claude) split the agent into a line per model.
  const inline = new Set(windows.map((w) => w.label)).size === windows.length;
  const groups = inline ? [{ windows }] : quotaGroups(windows);
  const cells = (group: { scope?: string; windows: QuotaWindow[] }, g: number) => columns.map((label) => {
    const key = `${g}:${label}`;
    return <Cell key={label} window={group.windows.find((w) => w.label === label)} open={opened === key} onToggle={() => setOpened(opened === key ? null : key)} />;
  });
  const detail = (g: number) => {
    if (!opened?.startsWith(`${g}:`)) return null;
    const w = groups[g]?.windows.find((v) => v.label === opened.slice(opened.indexOf(':') + 1));
    return w ? <CellDetail window={w} /> : null;
  };
  const state = loading ? t('quota.updating') : failedAt ? t('quota.board.failed') : '';

  return (
    <section className="quota-board-row" aria-label={agent.label}>
      <div className="quota-grid">
        <div className="quota-agent">
          <span className="quota-agent-name">
            {agent.icon ? (
              <span className="agent-mark" role="img" aria-label={agent.label}>
                <AgentMark path={agent.icon} size={14} />
              </span>
            ) : null}
            <span className="quota-board-name">{agent.label}</span>
            {/* Which plan the account is on, beside whose it is; the agent's own word for it on hover. */}
            {quota?.plan && <span className="quota-plan beside" title={quota.plan.id}>{quota.plan.label}</span>}
          </span>
          <span className={`quota-checked${failedAt && !loading ? ' failed' : ''}`} role="status"
            title={failedAt ? t('quota.lastFailed', clock(failedAt)) : undefined}>
            {/* On a narrow screen the name keeps its line and the plan leads the one under it, whole. */}
            {quota?.plan && <span className="quota-plan under" title={quota.plan.id}>{quota.plan.label} · </span>}
            {quota ? clock(quota.checkedAt) : ''}
            {quota && state ? ' · ' : ''}
            {state}
            <button type="button" className="quota-refresh" aria-label={t('quota.refreshAgent', agent.label)} aria-busy={loading} onClick={() => setRefreshRow(n => n + 1)} disabled={loading}>
              <IconRefresh size={12} />
            </button>
          </span>
        </div>
        {inline ? cells(groups[0], 0) : columns.map((label) => <span key={label} aria-hidden="true" />)}
      </div>
      {inline && detail(0)}
      {!inline && groups.map((group, g) => (
        <div key={group.scope ?? ''}>
          <div className="quota-grid quota-group">
            <span className="quota-scope">{group.scope}</span>
            {cells(group, g)}
          </div>
          {detail(g)}
        </div>
      ))}
      {windows.length === 0 && (
        <p className="quota-empty">{quota === null && loading ? t('quota.loading') : t('quota.noneRead', !!failedAt)}</p>
      )}
      {quota?.note && <p className="quota-note">{quota.note}</p>}
    </section>
  );
}

export function QuotaBoard({ api, agents, current, onClose, onError }: Props) {
  const [refreshAll, setRefreshAll] = useState(0);
  const [askAll, setAskAll] = useState(0);
  const rows = quotaRows(agents, current);
  // Every agent's last reading, for the columns; the cache gives a first guess so they do not jump.
  const [quotas, setQuotas] = useState<Record<string, PlanQuota | null>>(() => Object.fromEntries(rows.map((a) => [a.id, api.cachedAgentQuota(a.id)])));
  const onQuota = (agent: string, quota: PlanQuota | null) => setQuotas((prev) => (prev[agent] === quota ? prev : { ...prev, [agent]: quota }));
  const columns = quotaColumns(rows.map((a) => quotas[a.id]));
  const grid = { '--quota-grid': `minmax(0, 1fr) repeat(${Math.max(columns.length, 1)}, var(--quota-col))` } as CSSProperties;

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
          <h2 id="quota-board-title" className="panel-title">{t('quota.title')}</h2>
          <span className="status-actions">
            <button type="button" className="text-btn strong" onClick={() => setAskAll((n) => n + 1)}>
              <IconRefresh size={14} /> {t('quota.refreshAll')}
            </button>
            <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
              <IconClose size={18} />
            </button>
          </span>
        </header>
        <div className="panel-list quota-list" style={grid}>
          {rows.length === 0 && <p className="panel-empty">{t('quota.noAgents')}</p>}
          {rows.length > 0 && columns.length > 0 && (
            <div className="quota-grid quota-columns" aria-hidden="true">
              <span />
              {columns.map((label) => <span key={label}>{periodName(label)}</span>)}
            </div>
          )}
          {rows.map((agent) => (
            <QuotaRow key={agent.id} api={api} agent={agent} columns={columns} onQuota={onQuota} onError={onError} refreshAll={refreshAll} askAll={askAll} />
          ))}
        </div>
      </div>
    </div>
  );
}
