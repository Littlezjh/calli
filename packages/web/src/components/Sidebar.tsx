import { useState, type MouseEvent } from 'react';
import type { Section, Thread } from '../api';
import { useLongPress, useStoredSet } from '../hooks';
import { threadMark } from '../notices';
import { buildSidebar } from '../sidebar';
import { IconArchive, IconChevron, IconClose, IconEdit, IconFolder, IconFork, IconImport, IconList, IconMore, IconPin, IconPlus, IconSearch, IconSettings } from './icons';

export { folderName } from '../paths';

interface Props {
  threads: Thread[];
  sections: Section[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Starts a new thread with a directory or section pre-filled, from a group's "+". */
  onNewIn: (opts: { cwd?: string; sectionId?: string }) => void;
  onSignOut: () => void;
  onThreadMenu: (thread: Thread, x: number, y: number) => void;
  onSectionMenu: (section: Section, x: number, y: number) => void;
  onNewSection: () => void;
  onOpenArchive: () => void;
  onOpenTodos: () => void;
  /** Missing when no agent can list its past sessions. */
  onOpenImport?: () => void;
  /** The phone layout: the list is a page of its own under the conversation, laid out for thumbs. */
  compact?: boolean;
  /** Opens the settings menu of the phone layout, where the archive, importing and signing out are. */
  onOpenSettings?: (x: number, y: number) => void;
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

export function Sidebar({
  threads,
  sections,
  selectedId,
  onSelect,
  onNew,
  onNewIn,
  onSignOut,
  onThreadMenu,
  onSectionMenu,
  onNewSection,
  onOpenArchive,
  onOpenTodos,
  onOpenImport,
  compact = false,
  onOpenSettings,
}: Props) {
  const [search, setSearch] = useState('');
  // The phone layout keeps the search field put away behind a button until it is asked for.
  const [searching, setSearching] = useState(false);
  // A long press on a row is the phone's right click.
  const longPress = useLongPress<Thread>(onThreadMenu);
  const [collapsed, toggle] = useStoredSet('rah.sidebar.collapsed');
  const model = buildSidebar(threads, sections, search);
  // While searching, everything is expanded so matches are never hidden inside a closed group.
  const isOpen = (key: string) => Boolean(search.trim()) || !collapsed.has(key);

  const MARK_LABELS = { waiting: '等待批准', running: '运行中', error: '出错', unread: '有新结果' } as const;

  const row = (t: Thread) => {
    const mark = threadMark(t, t.id === selectedId);
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
      <button className="thread-item" onClick={() => onSelect(t.id)}>
        {t.forkedFrom && (
          <span className="thread-fork" role="img" aria-label="分叉">
            <IconFork size={13} />
          </span>
        )}
        <span className="thread-title">{t.title}</span>
        <span className="thread-meta">
          <span className="agent-tag">{t.agent}</span>
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

  const groups = (
    <nav className="thread-groups" aria-label="线程">
      {model.count === 0 && (
        <p className="group-empty top">
          {search.trim() ? '没有找到匹配的线程。' : compact ? '还没有线程。点“新线程”开始第一个。' : '还没有线程。在右边输入第一条消息就会创建。'}
        </p>
      )}

      {model.pinned.length > 0 &&
        group(
          'pinned',
          <>
            <IconPin size={14} />
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
            <IconFolder size={15} />
            <span className="group-name" title={p.cwd}>
              {p.name}
            </span>
          </>,
          p.threads,
          <GroupAdd label={`在 ${p.name} 新建线程`} onClick={() => onNewIn({ cwd: p.cwd })} />,
        ),
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
      autoFocus={compact}
    />
  );

  if (compact) {
    return (
      <div className="sidebar-inner compact">
        <div className="sidebar-top">
          {searching ? (
            <label className="sidebar-search-box">
              <IconSearch size={18} />
              {searchInput}
              <button
                type="button"
                className="search-close"
                aria-label="关闭搜索"
                onClick={() => {
                  setSearch('');
                  setSearching(false);
                }}
              >
                <IconClose size={16} />
              </button>
            </label>
          ) : (
            <>
              <span className="brand">Agent Hub</span>
              <button className="round-btn" aria-label="搜索线程" onClick={() => setSearching(true)}>
                <IconSearch size={20} />
              </button>
            </>
          )}
        </div>

        <div className="sidebar-scroll">
          {!search.trim() && (
            <div className="side-nav">
              <button className="side-link" onClick={onOpenTodos}>
                <IconList size={21} /> 计划
              </button>
            </div>
          )}
          {groups}
        </div>

        <div className="sidebar-float">
          <button className="new-thread" onClick={onNew}>
            <IconEdit size={19} /> 新线程
          </button>
          {/* The archive, importing and signing out are not everyday things: they live behind this. */}
          <button className="round-btn" aria-label="配置" title="配置" onClick={(e) => onOpenSettings?.(...below(e))}>
            <IconSettings size={20} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar-inner">
      <div className="sidebar-top">
        <span className="brand">Agent Hub</span>
        <label className="sidebar-search-box">
          <IconSearch size={15} />
          {searchInput}
        </label>
      </div>
      <button className="new-thread" onClick={onNew}>
        <IconEdit size={16} /> 新线程
      </button>

      {groups}

      <div className="sidebar-foot">
        <button className="foot-link" onClick={onOpenTodos}>
          <IconList size={16} /> 计划
        </button>
        <button className="foot-link" onClick={onOpenArchive}>
          <IconArchive size={16} /> 已归档
        </button>
        {onOpenImport && (
          <button className="foot-link" onClick={onOpenImport}>
            <IconImport size={16} /> 导入历史
          </button>
        )}
        <button className="link-btn" onClick={onSignOut}>
          退出
        </button>
      </div>
    </div>
  );
}
