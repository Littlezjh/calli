import { useState, type MouseEvent } from 'react';
import type { AgentInfo, Section, Thread } from '../api';
import { useLongPress, useStoredFlag, useStoredSet } from '../hooks';
import { attentionCount, threadMark } from '../notices';
import { folderName } from '../paths';
import { buildActivity, buildSidebar, projectDir, taggedAgents } from '../sidebar';
import { AgentMark, IconBell, IconChevron, IconClose, IconEdit, IconFolder, IconFork, IconList, IconMore, IconPin, IconPlus, IconSearch, IconSettings, IconWorktree, IconSidebar } from './icons';

export { folderName } from '../paths';

interface Props {
  /** Puts the list away on a wide screen; the top bar then has the button to bring it back. */
  onHide?: () => void;
  threads: Thread[];
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
  /** The phone layout: the list is a page of its own under the conversation, laid out for thumbs. */
  compact?: boolean;
  /** Opens the settings menu, where the look, the archive, importing and signing out are. It grows up and to the left from the point given. */
  onOpenSettings: (x: number, y: number) => void;
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
  compact = false,
  onOpenSettings,
  onHide,
}: Props) {
  const [search, setSearch] = useState('');
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

  const row = (t: Thread) => {
    const mark = threadMark(t, t.id === selectedId);
    const agent = agentById.get(t.agent);
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
        ) : (
          t.forkedFrom && (
            <span className="thread-fork" role="img" aria-label="分叉">
              <IconFork size={13} />
            </span>
          )
        )}
        <span className="thread-text">
          <span className="thread-head">
            <span className="thread-title">{t.title}</span>
            {/* Out of its project group, a thread says where it is. */}
            {byActivity && <span className="thread-dir">{folderName(projectDir(t).cwd)}</span>}
          </span>
          {t.preview && <span className="thread-preview">{t.preview}</span>}
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
      {isOpen(key) && (list.length ? list.map(row) : emptyHint ? <p className="group-empty">{emptyHint}</p> : null)}
    </section>
  );

  const empty = (
    <p className="group-empty top">
      {search.trim() ? '没有找到匹配的线程。' : compact ? '还没有线程。点“新线程”开始第一个。' : '还没有线程。在右边输入第一条消息就会创建。'}
    </p>
  );

  const groups = activity ? (
    <nav className="thread-groups activity" aria-label="线程，按活动">
      {activity.count === 0 && empty}
      {activity.groups.map((g) => (
        <section key={g.key} className="thread-group" aria-label={g.label}>
          <div className="group-label">{g.label}</div>
          {g.threads.map(row)}
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
      placeholder="搜索线程"
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
            <span className="brand">Agent Hub</span>
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

      <div className="sidebar-scroll">
        {!search.trim() && (
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
          </div>
        )}
        {groups}
      </div>

      <div className="sidebar-float">
        {compact && (
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
