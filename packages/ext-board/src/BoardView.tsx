import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { WorkProjection } from '@rah/extension-api';
import type { ExtensionViewProps, WebHost } from '@rah/extension-api/web';
import { buildColumns, COLUMN_IDS, emptyFilters, firstColumn, parseFilters, projectName, showStaleWarning, type BoardCard, type BoardFilters, type ColumnId } from './columns';
import { t } from './i18n';

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

/** Why the card is where it is, coloured only when it asks something of the person, and since when. */
function reasonOf(card: BoardCard, host: WebHost, now: number): { text: string; tone: string; at: string | null } {
  const locale = host.locale();
  const { reason, thread } = card;
  const report = thread.report;
  if (reason.kind === 'attention') {
    return { text: t(locale, reason.attention), tone: reason.attention === 'error' ? 'error' : 'attention', at: thread.updatedAt };
  }
  if (reason.kind === 'running') {
    const start = reason.since ? Date.parse(reason.since) : NaN;
    const text = Number.isFinite(start) ? t(locale, 'runningMinutes', Math.max(0, Math.floor((now - start) / 60_000))) : t(locale, 'doing');
    return { text, tone: 'running', at: null };
  }
  if (reason.kind === 'report' && report) {
    const text = t(locale, report.stage === 'blocked' ? 'reportBlocked' : report.stage === 'doing' ? 'reportDoing' : 'reportReview');
    return { text, tone: report.stage === 'blocked' ? 'attention' : 'idle', at: report.at };
  }
  if (reason.kind === 'done') return { text: t(locale, 'finished'), tone: 'idle', at: thread.doneAt };
  const unread = reason.kind === 'idle' && reason.unread;
  return { text: t(locale, unread ? 'unread' : 'idle'), tone: unread ? 'unread' : 'idle', at: thread.updatedAt };
}

function ThreadCard({ card, host, now, work }: { card: BoardCard; host: WebHost; now: number; work: WorkProjection[] }) {
  const locale = host.locale();
  const { AgentMark, Icon, RelativeTime } = host.ui;
  const { thread } = card;
  const reason = reasonOf(card, host, now);
  const [saving, setSaving] = useState(false);
  const done = thread.doneAt !== null;
  const title = thread.title || t(locale, 'untitled');
  const note = card.reason.kind === 'report' ? thread.report?.note.trim() : '';
  const badges = [
    ...(thread.scheduled ? [{ key: 'scheduled', text: t(locale, 'scheduled'), icon: 'clock' as const }] : []),
    ...(thread.worktree ? [{ key: 'worktree', text: t(locale, 'worktree'), icon: 'worktree' as const }] : []),
    ...(thread.handover ? [{ key: 'handover', text: t(locale, 'handover'), icon: 'fork' as const }] : []),
    ...(thread.teamSize > 0 ? [{ key: 'team', text: t(locale, 'team', thread.teamSize), icon: 'team' as const }] : []),
  ];
  const setDone = () => {
    if (saving) return;
    setSaving(true);
    host.threads.setDone(thread.id, !done).catch(() => undefined).finally(() => setSaving(false));
  };

  return (
    <article className={`ext-board-card-wrap${done ? ' is-done' : ''}${work.length ? ' has-work' : ''}`}>
      <button type="button" className="ext-board-card" onClick={() => host.navigate.openThread(thread.id)}>
        <span className="ext-board-card-title">{title}</span>
        {note && <span className="ext-board-note">{note}</span>}
        <span className={`ext-board-reason ext-board-tone-${reason.tone}`}>
          {reason.tone !== 'idle' && <span className="ext-board-dot" aria-hidden="true" />}
          <span className="ext-board-reason-text">{reason.text}</span>
          {(badges.length > 0 || thread.pinned) && <span className="ext-board-badges">
            {thread.pinned && <span className="ext-board-badge" title={t(locale, 'pinned')} aria-label={t(locale, 'pinned')}><Icon name="pin" size={12} /></span>}
            {badges.map((badge) => <span className="ext-board-badge" key={badge.key} title={badge.text} aria-label={badge.text}><Icon name={badge.icon} size={12} /></span>)}
          </span>}
        </span>
        <span className="ext-board-card-footer">
          <span className="ext-board-context">
            <span className="ext-board-project" title={thread.project}>{projectName(thread.project) || t(locale, 'noProject')}</span>
            <span aria-hidden="true">·</span>
            <span className="ext-board-agent"><AgentMark agentId={thread.agent} size={12} label /></span>
          </span>
          {reason.at && <span className="ext-board-time"><RelativeTime iso={reason.at} /></span>}
        </span>
      </button>
      <button
        type="button"
        className="ext-board-check"
        role="checkbox"
        aria-checked={done}
        aria-label={`${t(locale, done ? 'markUndone' : 'markDone')}: ${title}`}
        title={t(locale, done ? 'markUndone' : 'markDone')}
        disabled={saving}
        onClick={setDone}
      >{done && <Icon name="check" size={12} />}</button>
      {work.length > 0 && <host.ui.WorkSummary items={work} />}
    </article>
  );
}

/** Conversations placed by what they are doing and what their agents report; the person marks them done. */
export function BoardView({ host }: ExtensionViewProps) {
  const locale = host.locale();
  const { Popover, PopoverOption, Icon, RelativeTime, EmptyState } = host.ui;
  const [work, setWork] = useState(() => host.workSources.snapshot());
  const [threads, setThreads] = useState(() => host.threads.snapshot());
  const [connection, setConnection] = useState(() => ({ state: host.connection.state(), observedAt: host.connection.observedAt() }));
  const [now, setNow] = useState(Date.now);
  const [filters, setFilters] = useState(() => readFilters(host));
  const [expanded, setExpanded] = useState<ReadonlySet<ColumnId>>(new Set());
  const [selectedColumn, setSelectedColumn] = useState<ColumnId | null>(null);
  const viewId = useId();

  useEffect(() => {
    const refreshConnection = () => setConnection({ state: host.connection.state(), observedAt: host.connection.observedAt() });
    const offThreads = host.threads.subscribe((next) => {
      setThreads(next);
      refreshConnection();
    });
    const offWork = host.workSources.subscribe(setWork);
    const offConnection = host.connection.subscribe(refreshConnection);
    // Subscribe first, then read the synchronous current snapshots to close the mount gap.
    setThreads(host.threads.snapshot());
    setWork(host.workSources.snapshot());
    refreshConnection();
    return () => { offThreads(); offWork(); offConnection(); };
  }, [host.threads, host.workSources, host.connection]);

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

  const columns = buildColumns(threads, filters, now, expanded);
  const current = selectedColumn ?? firstColumn(columns);
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

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, id: ColumnId) => {
    const index = COLUMN_IDS.indexOf(id);
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
        {threads.length > 0 && <div className="ext-board-filters">
          {filter('project', t(locale, 'project'), filters.project, projects, (project) => projectName(project) || t(locale, 'noProject'), (project) => updateFilters({ ...filters, project }))}
          {filter('agent', t(locale, 'agent'), filters.agent, agents, (agent) => agentLabels.get(agent) ?? agent, (agent) => updateFilters({ ...filters, agent }))}
          {filter('scheduled', t(locale, 'scheduledFilter'), filters.scheduled, [true, false], (scheduled) => t(locale, scheduled ? 'scheduled' : 'notScheduled'), (scheduled) => updateFilters({ ...filters, scheduled }))}
          {hasFilters && <button type="button" className="ext-board-clear" onClick={() => updateFilters(emptyFilters())}>{t(locale, 'clearFilters')}</button>}
        </div>}
      </header>
      {host.narrow && !empty && <div className="ext-board-tabs" role="tablist" aria-label={t(locale, 'columns')}>
        {columns.map((column) => <button
          type="button"
          role="tab"
          className="ext-board-tab"
          key={column.id}
          id={`${viewId}-tab-${column.id}`}
          aria-controls={`${viewId}-panel-${column.id}`}
          aria-selected={current === column.id}
          tabIndex={current === column.id ? 0 : -1}
          onClick={() => setSelectedColumn(column.id)}
          onKeyDown={(event) => moveTab(event, column.id)}
        >{t(locale, column.id)} <span className="ext-board-count">{column.total}</span></button>)}
      </div>}
      {empty && <div className="ext-board-empty"><EmptyState text={t(locale, hasFilters ? 'filteredEmpty' : 'empty')} /></div>}
      {!empty && <div className="ext-board-columns">
        {columns.map((column) => <section
          key={column.id}
          id={`${viewId}-panel-${column.id}`}
          className="ext-board-column"
          hidden={host.narrow && current !== column.id}
          role={host.narrow ? 'tabpanel' : undefined}
          aria-labelledby={host.narrow ? `${viewId}-tab-${column.id}` : `${viewId}-heading-${column.id}`}
          tabIndex={host.narrow ? 0 : undefined}
        >
          {!host.narrow && <h2 className="ext-board-column-title" id={`${viewId}-heading-${column.id}`}>
            <span className={`ext-board-dot ext-board-tone-${column.id}`} aria-hidden="true" />
            {t(locale, column.id)}<span className="ext-board-count">{column.total}</span>
          </h2>}
          <div className="ext-board-cards">
            {column.cards.map((card) => <ThreadCard
              key={card.thread.id}
              card={card}
              host={host}
              now={now}
              work={work.filter((item) => item.binding.threadIds.includes(card.thread.id))}
            />)}
            {column.total === 0 && <p className="ext-board-column-empty">{t(locale, 'emptyColumn')}</p>}
            {column.olderCount > 0 && <button
              type="button"
              className="ext-board-older"
              aria-expanded={expanded.has(column.id)}
              onClick={() => setExpanded((value) => { const next = new Set(value); if (!next.delete(column.id)) next.add(column.id); return next; })}
            >{expanded.has(column.id) ? t(locale, 'hideOlder') : t(locale, column.id === 'done' ? 'olderDone' : 'olderReview', column.olderCount)}</button>}
          </div>
        </section>)}
      </div>}
    </div>
  );
}
