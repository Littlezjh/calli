import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { ThreadSummary } from '@rah/extension-api';
import type { ExtensionViewProps, WebHost } from '@rah/extension-api/web';
import { buildColumns, COLUMN_IDS, emptyFilters, parseFilters, projectName, showStaleWarning, type BoardFilters, type ColumnId } from './columns';
import { t } from './i18n';
import type { WorkProjection } from '@rah/extension-api';

const FILTERS_KEY = 'filters.v1';

function readFilters(host: WebHost): BoardFilters {
  try {
    return parseFilters(host.storage.get(FILTERS_KEY));
  } catch {
    return emptyFilters();
  }
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function ThreadCard({ thread, host, now, work }: { thread: ThreadSummary; host: WebHost; now: number; work: WorkProjection[] }) {
  const locale = host.locale();
  const { AgentMark, Icon, RelativeTime } = host.ui;
  const start = thread.runningSince ? Date.parse(thread.runningSince) : NaN;
  const reason = thread.attention ? t(locale, thread.attention.kind)
    : thread.status === 'running'
      ? Number.isFinite(start) ? t(locale, 'runningMinutes', Math.max(0, Math.floor((now - start) / 60_000))) : t(locale, 'running')
      : <RelativeTime iso={thread.updatedAt} />;
  const tone = thread.attention?.kind === 'error' ? 'error'
    : thread.attention?.kind === 'unread' ? 'unread'
      : thread.attention ? 'attention' : thread.status === 'running' ? 'running' : 'idle';
  const badges = [
    ...(thread.scheduled ? [{ key: 'scheduled', text: t(locale, 'scheduled'), icon: 'clock' as const }] : []),
    ...(thread.worktree ? [{ key: 'worktree', text: t(locale, 'worktree'), icon: 'worktree' as const }] : []),
    ...(thread.handover ? [{ key: 'handover', text: t(locale, 'handover'), icon: 'fork' as const }] : []),
    ...(thread.teamSize > 0 ? [{ key: 'team', text: t(locale, 'team', thread.teamSize), icon: 'team' as const }] : []),
  ];

  return (
    <article className={`ext-board-card-wrap${work.length ? ' has-work' : ''}`}><button type="button" className="ext-board-card" onClick={() => host.navigate.openThread(thread.id)}>
      <span className="ext-board-card-heading">
        <span className="ext-board-card-title">{thread.title || t(locale, 'untitled')}</span>
        {thread.pinned && <span className="ext-board-pin" title={t(locale, 'pinned')} aria-label={t(locale, 'pinned')}><Icon name="pin" size={13} /></span>}
      </span>
      <span className={`ext-board-reason ext-board-tone-${tone}`}>
        {tone !== 'idle' && <span className="ext-board-dot" aria-hidden="true" />}
        <span className="ext-board-reason-text">{reason}</span>
        {thread.attention && <span className="ext-board-time">· <RelativeTime iso={thread.updatedAt} /></span>}
      </span>
      <span className="ext-board-card-footer">
        <span className="ext-board-context">
          <span className="ext-board-project" title={thread.project}>{projectName(thread.project) || t(locale, 'noProject')}</span>
          <span aria-hidden="true">·</span>
          <span className="ext-board-agent"><AgentMark agentId={thread.agent} size={12} label /></span>
        </span>
        {badges.length > 0 && <span className="ext-board-badges">
          {badges.map((badge) => <span className="ext-board-badge" key={badge.key} title={badge.text} aria-label={badge.text}>
            <Icon name={badge.icon} size={12} />
          </span>)}
        </span>}
      </span>
    </button>{work.length > 0 && <host.ui.WorkSummary items={work} />}</article>
  );
}

/** A read-only projection of the host's thread summaries. */
export function BoardView({ host }: ExtensionViewProps) {
  const locale = host.locale();
  const { Popover, PopoverOption, Icon, RelativeTime, EmptyState } = host.ui;
  const [work, setWork] = useState(() => host.workSources.snapshot());
  useEffect(() => { const off = host.workSources.subscribe(setWork); setWork(host.workSources.snapshot()); return off; }, [host.workSources]);
  const [threads, setThreads] = useState(() => host.threads.snapshot());
  const [connection, setConnection] = useState(() => ({ state: host.connection.state(), observedAt: host.connection.observedAt() }));
  const [now, setNow] = useState(Date.now);
  const [filters, setFilters] = useState(() => readFilters(host));
  const [showOlder, setShowOlder] = useState(false);
  const [selectedColumn, setSelectedColumn] = useState<ColumnId>('attention');
  const viewId = useId();

  useEffect(() => {
    const refreshConnection = () => setConnection({ state: host.connection.state(), observedAt: host.connection.observedAt() });
    const unsubscribe = host.threads.subscribe((next) => {
      setThreads(next);
      refreshConnection();
    });
    const unsubscribeConnection = host.connection.subscribe(refreshConnection);
    // Subscribe first, then read the synchronous current snapshot to close the mount gap.
    setThreads(host.threads.snapshot());
    refreshConnection();
    return () => { unsubscribe(); unsubscribeConnection(); };
  }, [host.threads, host.connection]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const updateFilters = (next: BoardFilters) => {
    setFilters(next);
    try {
      host.storage.set(FILTERS_KEY, JSON.stringify(next));
    } catch {
      // The view remains usable when device storage is unavailable.
    }
  };

  const columns = buildColumns(threads, filters, now, showOlder);
  const empty = columns.every((column) => column.total === 0);
  const hasFilters = filters.project.length + filters.agent.length + filters.scheduled.length > 0;
  const projects = [...new Set([...threads.map((thread) => thread.project), ...filters.project])].sort();
  const agentLabels = new Map(host.agents().map((agent) => [agent.id, agent.label]));
  const agents = [...new Set([...threads.map((thread) => thread.agent), ...filters.agent])].sort();

  const filter = <T extends string | boolean,>(
    key: keyof BoardFilters,
    label: string,
    selected: T[],
    options: T[],
    name: (value: T) => string,
    select: (values: T[]) => void,
  ) => <Popover
    key={key}
    label={label}
    triggerClassName={`ext-board-filter${selected.length ? ' ext-board-filter-active' : ''}`}
    triggerTitle={selected.length ? `${label} · ${t(locale, 'selected', selected.length)}` : label}
    trigger={<><span>{label}</span>{selected.length > 0 && <span className="ext-board-count">{selected.length}</span>}<Icon name="chevron" size={12} /></>}
  >
    {() => <>
      <PopoverOption selected={selected.length === 0} onSelect={() => select([])}>{t(locale, 'all')}</PopoverOption>
      {options.map((option) => <PopoverOption key={String(option)} selected={selected.includes(option)} onSelect={() => select(toggle(selected, option))}>
        <span className="ext-board-option" title={typeof option === 'string' ? option : undefined}>{name(option)}</span>
      </PopoverOption>)}
    </>}
  </Popover>;

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, current: ColumnId) => {
    const index = COLUMN_IDS.indexOf(current);
    const next = event.key === 'ArrowRight' ? (index + 1) % COLUMN_IDS.length
      : event.key === 'ArrowLeft' ? (index + COLUMN_IDS.length - 1) % COLUMN_IDS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? COLUMN_IDS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setSelectedColumn(COLUMN_IDS[next]);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className={`ext-board-page${host.narrow ? ' ext-board-narrow' : ''}`}>
      <header className="ext-board-head">
        <div className="ext-board-heading">
          <h1 className="ext-board-title">{t(locale, 'title')}</h1>
          {showStaleWarning(connection.state, connection.observedAt) && <span className="ext-board-stale" role="status"
            title={connection.observedAt ? `${t(locale, 'lastSynced')} · ${connection.observedAt}` : t(locale, 'neverSynced')}
          >
            {t(locale, 'stale')} · {connection.observedAt
              ? <RelativeTime iso={connection.observedAt} />
              : t(locale, 'neverSynced')}
          </span>}
        </div>
        <div className="ext-board-filters">
          {filter('project', t(locale, 'project'), filters.project, projects, (project) => projectName(project) || t(locale, 'noProject'), (project) => updateFilters({ ...filters, project }))}
          {filter('agent', t(locale, 'agent'), filters.agent, agents, (agent) => agentLabels.get(agent) ?? agent, (agent) => updateFilters({ ...filters, agent }))}
          {filter('scheduled', t(locale, 'scheduledFilter'), filters.scheduled, [true, false], (scheduled) => t(locale, scheduled ? 'scheduled' : 'notScheduled'), (scheduled) => updateFilters({ ...filters, scheduled }))}
          {hasFilters && <button type="button" className="ext-board-clear" onClick={() => updateFilters(emptyFilters())}>{t(locale, 'clearFilters')}</button>}
        </div>
      </header>
      {host.narrow && <div className="ext-board-tabs" role="tablist" aria-label={t(locale, 'columns')}>
        {columns.map((column) => <button
          type="button"
          role="tab"
          className="ext-board-tab"
          key={column.id}
          id={`${viewId}-tab-${column.id}`}
          aria-controls={`${viewId}-panel-${column.id}`}
          aria-selected={selectedColumn === column.id}
          tabIndex={selectedColumn === column.id ? 0 : -1}
          onClick={() => setSelectedColumn(column.id)}
          onKeyDown={(event) => moveTab(event, column.id)}
        >{t(locale, column.id)} <span className="ext-board-count">{column.total}</span></button>)}
      </div>}
      {empty && <div className="ext-board-empty"><EmptyState text={t(locale, hasFilters ? 'filteredEmpty' : 'empty')} /></div>}
      <div className="ext-board-columns">
        {columns.map((column) => <section
          key={column.id}
          id={`${viewId}-panel-${column.id}`}
          className="ext-board-column"
          hidden={(host.narrow && selectedColumn !== column.id) || (empty && !host.narrow)}
          role={host.narrow ? 'tabpanel' : undefined}
          aria-labelledby={host.narrow ? `${viewId}-tab-${column.id}` : `${viewId}-heading-${column.id}`}
          tabIndex={host.narrow ? 0 : undefined}
        >
          {!host.narrow && <h2 className="ext-board-column-title" id={`${viewId}-heading-${column.id}`}>
            <span className={`ext-board-dot ext-board-tone-${column.id}`} aria-hidden="true" />
            {t(locale, column.id)}<span className="ext-board-count">{column.total}</span>
          </h2>}
          <div className="ext-board-cards">
            {column.threads.map((thread) => <ThreadCard work={work.filter(p => p.binding.threadIds.includes(thread.id))} key={thread.id} thread={thread} host={host} now={now} />)}
            {!empty && column.total === 0 && <p className="ext-board-column-empty">{t(locale, 'emptyColumn')}</p>}
            {column.olderCount > 0 && <button
              type="button"
              className="ext-board-older"
              aria-expanded={showOlder}
              onClick={() => setShowOlder((value) => !value)}
            >{showOlder ? t(locale, 'hideOlder') : t(locale, 'older', column.olderCount)}</button>}
          </div>
        </section>)}
      </div>
    </div>
  );
}
