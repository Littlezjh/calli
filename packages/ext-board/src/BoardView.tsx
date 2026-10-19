import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { WorkProjection } from '@rah/extension-api';
import type { ExtensionViewProps, WebHost } from '@rah/extension-api/web';
import { buildColumns, COLUMN_IDS, emptyFilters, firstColumn, parseFilters, projectName, showStaleWarning, type BoardCard, type BoardFilters, type ColumnId } from './columns';
import { t } from './i18n';

const FILTERS_KEY = 'filters.v2';
const MAX_MARKS = 3;

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
  const { reason, todo } = card;
  const report = todo.report;
  if (reason.kind === 'attention') {
    return { text: t(locale, reason.attention), tone: reason.attention === 'error' ? 'error' : 'attention', at: card.lead?.updatedAt ?? null };
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
  if (reason.kind === 'idle') {
    return { text: t(locale, reason.unread ? 'unread' : 'idle'), tone: reason.unread ? 'unread' : 'idle', at: card.lead?.updatedAt ?? null };
  }
  if (reason.kind === 'done') return { text: t(locale, 'finished'), tone: 'idle', at: todo.doneAt };
  return { text: t(locale, 'unlinked'), tone: 'idle', at: todo.createdAt };
}

function TodoCard({ card, host, now, work }: { card: BoardCard; host: WebHost; now: number; work: WorkProjection[] }) {
  const locale = host.locale();
  const { AgentMark, Icon, RelativeTime } = host.ui;
  const { todo, lead } = card;
  const reason = reasonOf(card, host, now);
  const agentLabels = new Map(host.agents().map((agent) => [agent.id, agent.label]));
  const [saving, setSaving] = useState(false);
  const agents = [...new Set(card.threads.map((thread) => thread.agent))];
  const hidden = todo.threadIds.length - Math.min(card.threads.length, MAX_MARKS);
  const note = card.reason.kind === 'report' ? todo.report?.note.trim() : '';
  const project = lead ? projectName(lead.project) : '';
  const open = () => (lead ? host.navigate.openThread(lead.id) : host.navigate.openPlan());
  const setDone = () => {
    if (saving) return;
    setSaving(true);
    host.todos.setDone(todo.id, !todo.done).catch(() => undefined).finally(() => setSaving(false));
  };

  return (
    <article className={`ext-board-card-wrap${todo.done ? ' is-done' : ''}${work.length ? ' has-work' : ''}`}>
      <button type="button" className="ext-board-card" onClick={open} title={lead ? lead.title : t(locale, 'openPlan')}>
        <span className="ext-board-card-title">{todo.text}</span>
        {note && <span className="ext-board-note">{note}</span>}
        <span className={`ext-board-reason ext-board-tone-${reason.tone}`}>
          {reason.tone !== 'idle' && <span className="ext-board-dot" aria-hidden="true" />}
          <span className="ext-board-reason-text">{reason.text}</span>
          {todo.items.total > 0 && <span className="ext-board-items" title={t(locale, 'items', todo.items.done, todo.items.total)} aria-label={t(locale, 'items', todo.items.done, todo.items.total)}>
            <Icon name="check" size={12} />{todo.items.done}/{todo.items.total}
          </span>}
        </span>
        <span className="ext-board-card-footer">
          <span className="ext-board-context">
            {agents.length > 0 && <span className="ext-board-marks">
              {agents.slice(0, MAX_MARKS).map((agent) => <span key={agent} className="ext-board-mark" title={agentLabels.get(agent) ?? agent}><AgentMark agentId={agent} size={14} label={agents.length === 1 && !project} /></span>)}
              {hidden > 0 && <span className="ext-board-more" title={t(locale, 'moreThreads', hidden)} aria-label={t(locale, 'moreThreads', hidden)}>+{hidden}</span>}
            </span>}
            {agents.length > 0 && project && <span aria-hidden="true">·</span>}
            {project && <span className="ext-board-project" title={lead?.project}>{project}</span>}
          </span>
          {reason.at && <span className="ext-board-time"><RelativeTime iso={reason.at} /></span>}
        </span>
      </button>
      <button
        type="button"
        className="ext-board-check"
        role="checkbox"
        aria-checked={todo.done}
        aria-label={`${t(locale, todo.done ? 'markUndone' : 'markDone')}: ${todo.text}`}
        title={t(locale, todo.done ? 'markUndone' : 'markDone')}
        disabled={saving}
        onClick={setDone}
      >{todo.done && <Icon name="check" size={12} />}</button>
      {work.length > 0 && <host.ui.WorkSummary items={work} />}
    </article>
  );
}

/** Plan items placed by what their linked threads are doing; the person ticks them done. */
export function BoardView({ host }: ExtensionViewProps) {
  const locale = host.locale();
  const { Popover, PopoverOption, Icon, RelativeTime, EmptyState } = host.ui;
  const [work, setWork] = useState(() => host.workSources.snapshot());
  const [todos, setTodos] = useState(() => host.todos.snapshot());
  const [threads, setThreads] = useState(() => host.threads.snapshot());
  const [connection, setConnection] = useState(() => ({ state: host.connection.state(), observedAt: host.connection.observedAt() }));
  const [now, setNow] = useState(Date.now);
  const [filters, setFilters] = useState(() => readFilters(host));
  const [showOlder, setShowOlder] = useState(false);
  const [selectedColumn, setSelectedColumn] = useState<ColumnId | null>(null);
  const viewId = useId();

  useEffect(() => {
    const refreshConnection = () => setConnection({ state: host.connection.state(), observedAt: host.connection.observedAt() });
    const offThreads = host.threads.subscribe((next) => {
      setThreads(next);
      refreshConnection();
    });
    const offTodos = host.todos.subscribe(setTodos);
    const offWork = host.workSources.subscribe(setWork);
    const offConnection = host.connection.subscribe(refreshConnection);
    // Subscribe first, then read the synchronous current snapshots to close the mount gap.
    setThreads(host.threads.snapshot());
    setTodos(host.todos.snapshot());
    setWork(host.workSources.snapshot());
    refreshConnection();
    return () => { offThreads(); offTodos(); offWork(); offConnection(); };
  }, [host.threads, host.todos, host.workSources, host.connection]);

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

  const columns = buildColumns(todos, threads, filters, now, showOlder);
  const current = selectedColumn ?? firstColumn(columns);
  const empty = columns.every((column) => column.total === 0);
  const hasFilters = filters.project.length + filters.agent.length > 0;
  const linked = new Set(todos.flatMap((todo) => todo.threadIds));
  const linkedThreads = threads.filter((thread) => linked.has(thread.id));
  const projects = [...new Set([...linkedThreads.map((thread) => thread.project), ...filters.project])].sort();
  const agentLabels = new Map(host.agents().map((agent) => [agent.id, agent.label]));
  const agents = [...new Set([...linkedThreads.map((thread) => thread.agent), ...filters.agent])].sort();

  const filter = (
    key: keyof BoardFilters,
    label: string,
    selected: string[],
    options: string[],
    name: (value: string) => string,
    select: (values: string[]) => void,
  ) => <Popover
    key={key}
    label={label}
    triggerClassName={`ext-board-filter${selected.length ? ' ext-board-filter-active' : ''}`}
    triggerTitle={selected.length ? `${label} · ${t(locale, 'selected', selected.length)}` : label}
    trigger={<><span>{label}</span>{selected.length > 0 && <span className="ext-board-count">{selected.length}</span>}<Icon name="chevron" size={12} /></>}
  >
    {() => <>
      <PopoverOption selected={selected.length === 0} onSelect={() => select([])}>{t(locale, 'all')}</PopoverOption>
      {options.map((option) => <PopoverOption key={option} selected={selected.includes(option)} onSelect={() => select(toggle(selected, option))}>
        <span className="ext-board-option" title={option}>{name(option)}</span>
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
        {(projects.length > 0 || agents.length > 0) && <div className="ext-board-filters">
          {filter('project', t(locale, 'project'), filters.project, projects, (project) => projectName(project) || t(locale, 'noProject'), (project) => updateFilters({ ...filters, project }))}
          {filter('agent', t(locale, 'agent'), filters.agent, agents, (agent) => agentLabels.get(agent) ?? agent, (agent) => updateFilters({ ...filters, agent }))}
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
      {empty && <div className="ext-board-empty">
        <EmptyState text={t(locale, hasFilters ? 'filteredEmpty' : 'empty')} />
        {!hasFilters && <button type="button" className="ext-board-plan" onClick={() => host.navigate.openPlan()}>{t(locale, 'openPlan')}</button>}
      </div>}
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
            {column.cards.map((card) => <TodoCard
              key={card.todo.id}
              card={card}
              host={host}
              now={now}
              work={work.filter((item) => item.binding.threadIds.some((id) => card.todo.threadIds.includes(id)))}
            />)}
            {column.total === 0 && <p className="ext-board-column-empty">{t(locale, 'emptyColumn')}</p>}
            {column.olderCount > 0 && <button
              type="button"
              className="ext-board-older"
              aria-expanded={showOlder}
              onClick={() => setShowOlder((value) => !value)}
            >{showOlder ? t(locale, 'hideOlder') : t(locale, 'older', column.olderCount)}</button>}
          </div>
        </section>)}
      </div>}
    </div>
  );
}
