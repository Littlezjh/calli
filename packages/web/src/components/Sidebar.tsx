import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { AgentInfo, HostInfo, SearchHit, Section, Thread } from '../api';
import { clockLabel } from '../timeline';
import { useLongPress, useStoredFlag, useStoredSet } from '../hooks';
import { attentionCount, threadMark } from '../notices';
import { folderName } from '../paths';
import { buildActivity, buildSidebar, handoverGroups, markTerms, projectDir, SEARCH_MIN, taggedAgents } from '../sidebar';
import { timeAgo } from '../sessions';
import { deliveredPreview } from '../timeline';
import { HostSwitcher } from './Hosts';
import { AgentMark, IconBell, IconChevron, IconClock, IconClose, IconEdit, IconFolder, IconFork, IconList, IconMore, IconPin, IconPlus, IconSearch, IconSettings, IconWorktree, IconSidebar } from './icons';

export { folderName } from '../paths';

interface Props {
  /** Puts the list away on a wide screen; the top bar then has the button to bring it back. */
  onHide?: () => void;
  threads: Thread[];
  /** Each lead thread's team members, by the lead's id: rows under the lead instead of threads of their own. */
  members?: Map<string, Thread[]>;
  sections: Section[];
  /** For the mark each row shows in place of its agent's name. */
  agents: AgentInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Starts a new thread with a directory or section pre-filled, from a group's "+". */
  onNewIn: (opts: { cwd?: string; sectionId?: string; scratch?: boolean }) => void;
  onThreadMenu: (thread: Thread, x: number, y: number) => void;
  onSectionMenu: (section: Section, x: number, y: number) => void;
  onNewSection: () => void;
  onOpenTodos: () => void;
  /** The plan page is what the main area shows. */
  todosActive?: boolean;
  onOpenSchedules: () => void;
  /** The scheduled-task page is what the main area shows. */
  schedulesActive?: boolean;
  /** The phone layout: the list is a page of its own under the conversation, laid out for thumbs. */
  compact?: boolean;
  /** Opens the settings menu, where the look, the archive, importing and signing out are. It grows up and to the left from the point given. */
  onOpenSettings: (x: number, y: number) => void;
  /** Other machines the hub shows, and the one this list is of (null: the hub's own). */
  hosts?: HostInfo[];
  hostId?: string | null;
  onHost?: (id: string | null) => void;
  /** The machine this list is of cannot be reached: its threads are over there, so there is no list. */
  hostDown?: boolean;
  /** Looks through what was said in every thread; without it the search is of titles and folders only. */
  onSearch?: (query: string) => Promise<SearchHit[]>;
  /** Opens the thread a found turn is in, at that turn. */
  onOpenHit?: (hit: SearchHit) => void;
  /** A line over the list, such as the demo's way to connect. */
  notice?: ReactNode;
}

/** Where a menu opened from a "more" button should appear: just under the button. */
function below(e: MouseEvent<HTMLElement>): [number, number] {
  const rect = e.currentTarget.getBoundingClientRect();
  return [rect.left, rect.bottom + 4];
}

/** A small "+" on a group header that starts a thread right in that group. */
function GroupAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="group-add" aria-label={label} title={label} onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}>
      <IconPlus size={14} />
    </button>
  );
}

/** The key that shows and hides the list, as Codex has it. */
export const SIDEBAR_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⇧⌘S' : 'Ctrl+Shift+S';

export function Sidebar({
  threads,
  members,
  sections,
  agents,
  selectedId,
  onSelect,
  onNew,
  onNewIn,
  onThreadMenu,
  onSectionMenu,
  onNewSection,
  onOpenTodos,
  todosActive = false,
  onOpenSchedules,
  schedulesActive = false,
  compact = false,
  onOpenSettings,
  notice,
  onHide,
  hosts = [],
  hostId = null,
  onHost,
  hostDown = false,
  onSearch,
  onOpenHit,
}: Props) {
  const [search, setSearch] = useState('');
  // What was said, looked up a moment after the typing stops. `for` is the search the hits answer.
  const [found, setFound] = useState<{ for: string; hits: SearchHit[] } | null>(null);
  const query = search.trim();
  useEffect(() => {
    if (!onSearch || query.length < SEARCH_MIN) { setFound(null); return; }
    let stale = false;
    const timer = setTimeout(() => {
      onSearch(query).then((hits) => { if (!stale) setFound({ for: query, hits }); }).catch(() => { if (!stale) setFound({ for: query, hits: [] }); });
    }, 220);
    return () => { stale = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  const [expandedHandovers, setExpandedHandovers] = useState<Set<string>>(new Set());
  // A team is open on its own while a member works or waits, or is the one on screen; a click overrides that.
  const [teamOpen, setTeamOpen] = useState<Map<string, boolean>>(new Map());
  // The search field is put away behind a button until it is asked for.
  const [searching, setSearching] = useState(false);
  const closeSearch = () => {
    setSearch('');
    setSearching(false);
  };
  // A long press on a row is the phone's right click.
  const longPress = useLongPress<Thread>(onThreadMenu);
  const [collapsed, toggle] = useStoredSet('rah.sidebar.collapsed');
  // The other way to read the list: by what is going on, not by where a thread is filed. Like Codex's "查看活动".
  const [byActivity, setByActivity] = useStoredFlag('rah.sidebar.activity');
  const model = buildSidebar(threads, sections, search);
  const activity = byActivity ? buildActivity(threads, search, new Date(), selectedId) : null;
  const wanted = attentionCount(threads, selectedId);
  // While searching, everything is expanded so matches are never hidden inside a closed group.
  const isOpen = (key: string) => Boolean(search.trim()) || !collapsed.has(key);

  const MARK_LABELS = { waiting: '等待批准', running: '运行中', error: '出错', unread: '有新结果' } as const;
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const tagged = taggedAgents(agents);

  const row = (t: Thread, title = t.title, preview = t.preview) => {
    const mark = threadMark(t, t.id === selectedId);
    const agent = agentById.get(t.agent);
    // Filed by project, the list is for scanning: a title per row, as in Codex. The latest ask
    // shows where it helps finding something, by activity and in a search. A thread that needs a
    // hand says so in every view.
    const detail = byActivity || query ? preview : null;
    const note = mark === 'waiting' ? '等待批准' : mark === 'error' ? '出错了' : null;
    return (
    <div
      key={t.id}
      className={`thread-row${t.id === selectedId ? ' active' : ''}${mark === 'unread' || mark === 'waiting' ? ' attention' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onThreadMenu(t, e.clientX, e.clientY);
      }}
      {...longPress(t)}
    >
      {/* Two accounts of one agent share a mark; which one runs the thread shows on hover and in the
          open thread's top bar, not as text on every row. */}
      <button className="thread-item" onClick={() => onSelect(t.id)} title={agent && tagged.has(agent.id) ? agent.label : undefined}>
        {t.worktree ? (
          <span className="thread-fork" role="img" aria-label={`工作树 ${t.worktree.branch}`} title={`在工作树里，分支 ${t.worktree.branch}`}>
            <IconWorktree size={13} />
          </span>
        ) : t.forkedFrom ? (
          <span className="thread-fork" role="img" aria-label="分叉">
            <IconFork size={13} />
          </span>
        ) : (
          t.schedule && (
            <span className="thread-fork" role="img" aria-label={`定时任务 ${t.schedule.name}`} title={`定时任务「${t.schedule.name}」运行`}>
              <IconClock size={13} />
            </span>
          )
        )}
        <span className="thread-text">
          <span className="thread-head">
            <span className="thread-title">{title}</span>
            {/* Beside the title, so the row stays one line like the rest. */}
            {note && <span className={`thread-note ${mark}`}>{note}</span>}
            {/* Out of its project group, a thread says where it is. */}
            {byActivity && <span className="thread-dir">{folderName(projectDir(t).cwd)}</span>}
          </span>
          {detail && <span className="thread-preview">{detail}</span>}
        </span>
        <span className="thread-meta">
          {agent?.icon ? (
            <span className="agent-mark" role="img" aria-label={agent.label} title={agent.label}>
              <AgentMark path={agent.icon} size={compact ? 13 : 12} />
            </span>
          ) : (
            // An agent without a mark, or one this hub no longer has: its name, as before.
            <span className="agent-tag">{t.agent}</span>
          )}
          {mark && <span className={`dot ${mark}`} role="img" aria-label={MARK_LABELS[mark]} title={MARK_LABELS[mark]} />}
        </span>
      </button>
      <button className="row-more" aria-label={`“${t.title}” 的更多操作`} onClick={(e) => onThreadMenu(t, ...below(e))}>
        <IconMore size={16} />
      </button>
    </div>
    );
  };

  const now = Date.now();
  /** Who in a team comes first: whoever is at work or waiting, then whoever was last heard from. */
  const busy = (t: Thread) => (t.waiting ? 2 : t.status === 'running' ? 1 : 0);
  const teamOrder = (a: Thread, b: Thread) => busy(b) - busy(a) || b.updatedAt.localeCompare(a.updatedAt);

  // Like Orca's agents under a task: the lead's row, then one line per member saying what it is doing.
  const entry = (t: Thread) => {
    const team = members?.get(t.id);
    if (!team?.length) return row(t);
    const sorted = [...team].sort(teamOrder);
    const auto = sorted.some((m) => busy(m) > 0 || m.id === selectedId);
    const open = Boolean(search.trim()) || (teamOpen.get(t.id) ?? auto);
    const working = sorted.filter((m) => m.status === 'running').length;
    const waiting = sorted.filter((m) => m.waiting).length;
    const marks = [...new Set(sorted.map((m) => threadMark(m, m.id === selectedId)).filter(Boolean))];
    const current = t.id === selectedId || sorted.some((m) => m.id === selectedId);
    return <div key={t.id} className={`handover-group team-group${open ? ' open' : ''}${current ? ' selected' : ''}`}>
      {row(t)}
      <button className="handover-toggle" aria-label={`${open ? '收起' : '展开'}智能体：${t.title}`} aria-expanded={open} onClick={() => setTeamOpen((old) => new Map(old).set(t.id, !open))}>
        <span>{sorted.length} 个智能体</span>
        {(waiting || working) > 0 && <span className="team-note">{waiting ? `${waiting} 待批准` : `${working} 运行中`}</span>}
        {!open && marks.length > 0 && <span className="handover-marks">{marks.map((mark) => <span key={mark} className={`dot ${mark}`} role="img" aria-label={MARK_LABELS[mark!]} title={MARK_LABELS[mark!]} />)}</span>}
        <IconChevron size={13} open={open} />
      </button>
      {open && <div className="handover-members">{sorted.map((m) => {
        const agent = agentById.get(m.agent);
        const mark = threadMark(m, m.id === selectedId);
        return <button
          key={m.id}
          className={`handover-member${m.id === selectedId ? ' active' : ''}`}
          aria-current={m.id === selectedId ? 'true' : undefined}
          title={m.title}
          onClick={() => onSelect(m.id)}
          onContextMenu={(e) => { e.preventDefault(); onThreadMenu(m, e.clientX, e.clientY); }}
          {...longPress(m)}
        >
          <span className={`dot ${mark ?? 'idle'}`} role="img" aria-label={mark ? MARK_LABELS[mark] : '空闲'} />
          {agent?.icon ? <span className="agent-mark" role="img" aria-label={agent.label}><AgentMark path={agent.icon} size={compact ? 14 : 13} /></span> : null}
          <span className="handover-member-name team-member-text">{deliveredPreview(m.coordination?.doing ?? '') || m.title}</span>
          <time className="handover-member-time" dateTime={m.updatedAt}>{timeAgo(m.updatedAt, now)}</time>
        </button>;
      })}</div>}
    </div>;
  };

  const groupedRows = (list: Thread[]) => handoverGroups(list).map(({ key, latest, members }) => {
    if (members.length === 1) return entry(latest);
    const storageKey = `${hostId ?? 'local'}:${key}`;
    const expanded = Boolean(search.trim()) || expandedHandovers.has(storageKey);
    const marks = [...new Set(members.filter((t) => t.id !== latest.id).map((t) => threadMark(t, t.id === selectedId)).filter(Boolean))];
    const current = members.some((t) => t.id === selectedId);
    // Like Orca's agents under a task: one card, the latest conversation on top, the chain folded below it.
    return <div key={key} className={`handover-group${expanded ? ' open' : ''}${current ? ' selected' : ''}`}>
      {row(latest, latest.title.replace(/(?:（接手）)+$/, ''))}
      <button className="handover-toggle" aria-label={`${expanded ? '收起' : '展开'}交接记录：${latest.title}`} aria-expanded={expanded} onClick={() => setExpandedHandovers((old) => {
        const next = new Set(old);
        if (next.has(storageKey)) next.delete(storageKey); else next.add(storageKey);
        return next;
      })}>
        <span>{members.length} 个会话</span>
        {!expanded && marks.length > 0 && <span className="handover-marks">{marks.map((mark) => <span key={mark} className={`dot ${mark}`} role="img" aria-label={`其他交接会话：${MARK_LABELS[mark!]}`} title={`其他交接会话：${MARK_LABELS[mark!]}`} />)}</span>}
        <IconChevron size={13} open={expanded} />
      </button>
      {expanded && <div className="handover-members">{members.map((t) => {
        const agent = agentById.get(t.agent);
        const mark = threadMark(t, t.id === selectedId);
        return <button
          key={t.id}
          className={`handover-member${t.id === selectedId ? ' active' : ''}`}
          aria-current={t.id === selectedId ? 'true' : undefined}
          onClick={() => onSelect(t.id)}
          onContextMenu={(e) => { e.preventDefault(); onThreadMenu(t, e.clientX, e.clientY); }}
          {...longPress(t)}
        >
          <span className={`dot ${mark ?? 'idle'}`} role="img" aria-label={mark ? MARK_LABELS[mark] : '空闲'} />
          {agent?.icon ? <span className="agent-mark"><AgentMark path={agent.icon} size={compact ? 14 : 13} /></span> : null}
          <span className="handover-member-name">{agent?.label ?? t.agent}</span>
          <span className="handover-member-role">{t.handover ? '接手' : '原始'}</span>
          <time className="handover-member-time" dateTime={t.updatedAt}>{timeAgo(t.updatedAt, now)}</time>
        </button>;
      })}</div>}
    </div>;
  });

  const group = (key: string, head: React.ReactNode, list: Thread[], extra?: React.ReactNode, emptyHint?: string) => (
    <section key={key} className="thread-group">
      <div className="group-head-row">
        <button className="group-head" aria-expanded={isOpen(key)} onClick={() => toggle(key)}>
          <span className="group-chevron">
            <IconChevron size={13} open={isOpen(key)} />
          </span>
          {head}
        </button>
        {extra}
      </div>
      {isOpen(key) && (list.length ? groupedRows(list) : emptyHint ? <p className="group-empty">{emptyHint}</p> : null)}
    </section>
  );

  const empty = (
    <p className="group-empty top">
      {search.trim() ? '没有标题或目录匹配的线程。' : compact ? '还没有线程。点“新线程”开始第一个。' : '还没有线程。在右边输入第一条消息就会创建。'}
    </p>
  );

  const groups = activity ? (
    <nav className="thread-groups activity" aria-label="线程，按活动">
      {activity.count === 0 && empty}
      {activity.groups.map((g) => (
        <section key={g.key} className="thread-group" aria-label={g.label}>
          <div className="group-label">{g.label}</div>
          {g.threads.map((t) => entry(t))}
        </section>
      ))}
    </nav>
  ) : (
    <nav className="thread-groups" aria-label="线程">
      {model.count === 0 && empty}

      {model.pinned.length > 0 &&
        group(
          'pinned',
          <>
            <IconPin size={13} />
            <span className="group-name">置顶</span>
          </>,
          model.pinned,
        )}

      {(model.sections.length > 0 || !search.trim()) && (
        <div className="group-label-row">
          <span className="group-label">分区</span>
          <button className="group-add" aria-label="新建分区" title="新建分区" onClick={onNewSection}>
            <IconPlus size={14} />
          </button>
        </div>
      )}
      {model.sections.map(({ section, threads: list }) =>
        group(
          `section:${section.id}`,
          <span className="group-name">{section.name}</span>,
          list,
          <span className="group-head-actions">
            <GroupAdd label={`在“${section.name}”新建线程`} onClick={() => onNewIn({ sectionId: section.id })} />
            <button
              className="row-more"
              aria-label={`分区“${section.name}”的更多操作`}
              onClick={(e) => onSectionMenu(section, ...below(e))}
            >
              <IconMore size={16} />
            </button>
          </span>,
          compact ? '长按线程，选"移到分区"' : '右键线程，选"移到分区"',
        ),
      )}
      {model.sections.length === 0 && !search.trim() && <p className="group-empty">还没有分区。</p>}

      {model.projects.length > 0 && <div className="group-label">项目</div>}
      {model.projects.map((p) =>
        group(
          `project:${p.key}`,
          <>
            <IconFolder size={13} />
            <span className="group-name" title={p.cwd}>
              {p.name}
            </span>
          </>,
          p.threads,
          <GroupAdd label={`在 ${p.name} 新建线程`} onClick={() => onNewIn({ cwd: p.cwd })} />,
        ),
      )}
      {model.scratch.length > 0 &&
        group(
          'scratch',
          <span className="group-name">不在项目中</span>,
          model.scratch,
          <GroupAdd label="新建不在项目中的线程" onClick={() => onNewIn({ scratch: true })} />,
        )}
    </nav>
  );

  const searchInput = (
    <input
      type="search"
      className="sidebar-search"
      placeholder={onSearch ? "搜索标题和对话内容" : "搜索线程"}
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      aria-label="搜索线程"
      autoFocus
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeSearch();
      }}
    />
  );

  return (
    <div className={`sidebar-inner${compact ? ' compact' : ''}`}>
      <div className="sidebar-top">
        {searching ? (
          <label className="sidebar-search-box">
            <IconSearch size={compact ? 18 : 15} />
            {searchInput}
            <button type="button" className="search-close" aria-label="关闭搜索" onClick={closeSearch}>
              <IconClose size={compact ? 16 : 14} />
            </button>
          </label>
        ) : (
          <>
            <span className="brand">Limi</span>
            <span className="sidebar-top-actions">
              {onHide && (
                <button className="round-btn sidebar-hide" aria-label="隐藏侧边栏" title={`隐藏侧边栏（${SIDEBAR_SHORTCUT}）`} onClick={onHide}>
                  <IconSidebar size={16} />
                </button>
              )}
              <button
                className={`round-btn activity-btn${byActivity ? ' on' : ''}`}
                aria-label="按活动查看"
                aria-pressed={byActivity}
                title={byActivity ? '回到按项目查看' : wanted > 0 ? `按活动查看（${wanted} 个线程有新动静）` : '按活动查看'}
                onClick={() => setByActivity(!byActivity)}
              >
                <IconBell size={compact ? 20 : 16} />
                {wanted > 0 && <span className="activity-badge" aria-hidden="true" />}
              </button>
              <button className="round-btn" aria-label="搜索线程" title="搜索线程" onClick={() => setSearching(true)}>
                <IconSearch size={compact ? 20 : 16} />
              </button>
            </span>
          </>
        )}
      </div>

      {notice}
      <div className="sidebar-scroll">
        {onHost && !search.trim() && <HostSwitcher hosts={hosts} current={hostId} onPick={onHost} />}
        {hostDown && <p className="group-empty top">这台机器现在连不上，它的线程要等连上才看得到。</p>}
        {!hostDown && !search.trim() && (
          <div className="side-nav">
            {/* On a wide screen a new thread is the first row, like Codex; a phone keeps the floating button by the thumb. */}
            {!compact && (
              <button className="side-link" onClick={onNew}>
                <IconEdit size={17} /> 新线程
              </button>
            )}
            <button className={`side-link${todosActive ? ' active' : ''}`} aria-current={todosActive ? 'page' : undefined} onClick={onOpenTodos}>
              <IconList size={compact ? 21 : 17} /> 计划
            </button>
            <button className={`side-link${schedulesActive ? ' active' : ''}`} aria-current={schedulesActive ? 'page' : undefined} onClick={onOpenSchedules}>
              <IconClock size={compact ? 21 : 17} /> 定时任务
            </button>
          </div>
        )}
        {!hostDown && groups}
        {!hostDown && onSearch && query.length >= SEARCH_MIN && (
          <section className="search-hits" aria-label="对话内容">
            <div className="search-hits-head">对话内容</div>
            {found?.for !== query ? (
              <p className="group-empty">正在搜索…</p>
            ) : found.hits.length === 0 ? (
              <p className="group-empty">对话里没有找到。</p>
            ) : (
              found.hits.map((hit) => (
                <button type="button" className={`search-hit${hit.threadId === selectedId ? ' active' : ''}`} key={`${hit.threadId}:${hit.turnId}:${hit.role}`} onClick={() => onOpenHit?.(hit)}>
                  <span className="search-hit-top">
                    <span className="thread-title">{hit.title}</span>
                    {hit.archived && <span className="search-hit-tag">已归档</span>}
                    <time dateTime={hit.ts}>{clockLabel(hit.ts)}</time>
                  </span>
                  <span className="search-hit-text">
                    <span className="search-hit-who">{hit.role === 'user' ? '我：' : '回复：'}</span>
                    {markTerms(hit.snippet, query).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : part.text))}
                  </span>
                </button>
              ))
            )}
          </section>
        )}
      </div>

      <div className="sidebar-float">
        {compact && !hostDown && (
          <button className="new-thread" onClick={onNew}>
            <IconEdit size={19} /> 新线程
          </button>
        )}
        {/* The look, the archive, importing and signing out are not everyday things: they live behind this. */}
        <button
          className="round-btn"
          aria-label="配置"
          title="配置"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenSettings(rect.right, rect.top - 8);
          }}
        >
          <IconSettings size={compact ? 20 : 17} />
        </button>
      </div>
    </div>
  );
}
