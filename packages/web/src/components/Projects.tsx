import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type Api, type WorkdirsConfig } from '../api';
import { folderName } from '../paths';
import { IconCheck, IconChevron, IconClose, IconFolder, IconPlus, IconSearch, IconSettings } from './icons';
import { Popover } from './Popover';

/** A directory a new thread can start in, as the picker lists it. */
export interface ProjectOption {
  cwd: string;
  name: string;
}

interface PickerProps {
  /** Most recently used first; the roots that have no threads yet come after. */
  projects: ProjectOption[];
  cwd: string;
  /** Not in any project: the thread gets a scratch folder from the hub. */
  scratch: boolean;
  /** Whether the hub offers threads outside a project at all. */
  scratchAvailable: boolean;
  onPick: (cwd: string) => void;
  onScratch: () => void;
  onBrowse: () => void;
  onNewProject: () => void;
  onManageRoots: () => void;
}

/** The folder a path sits in, for the hint under a project's name. */
const parentOf = (path: string) => path.replace(/\/[^/]+\/?$/, '') || '/';

/**
 * Where a new thread works, like Codex's project menu: the projects used lately (searchable), then
 * a deeper look through the folders, a new project, no project at all, and which folders are open.
 */
export function ProjectPicker({ projects, cwd, scratch, scratchAvailable, onPick, onScratch, onBrowse, onNewProject, onManageRoots }: PickerProps) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.cwd.toLowerCase().includes(q)) : projects;
  }, [projects, query]);
  // A typed search brings up the keyboard on a phone; there the list is short enough to scroll.
  const canFocus = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches;

  return (
    <Popover
      label="在哪个项目里工作"
      triggerClassName="context-btn"
      triggerTitle={scratch ? '不在项目中' : cwd}
      trigger={
        <>
          <IconFolder size={14} />
          <span>{scratch ? '不在项目中' : folderName(cwd) || '选择项目'}</span>
          <IconChevron size={12} open />
        </>
      }
    >
      {(close) => {
        const act = (fn: () => void) => () => {
          setQuery('');
          close();
          fn();
        };
        return (
          <>
            <label className="pop-search">
              <IconSearch size={15} />
              <input autoFocus={canFocus} value={query} placeholder="搜索项目" aria-label="搜索项目" onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="pop-scroll">
              {shown.map((p) => {
                const checked = !scratch && p.cwd === cwd;
                return (
                  <button key={p.cwd} type="button" role="menuitemradio" aria-checked={checked} className="pop-item compact" title={p.cwd} onClick={act(() => onPick(p.cwd))}>
                    <span className="pop-item-icon">
                      <IconFolder size={16} />
                    </span>
                    <span className="pop-item-text">
                      <span className="pop-item-label">{p.name}</span>
                      <span className="pop-item-hint">{parentOf(p.cwd)}</span>
                    </span>
                    {checked && (
                      <span className="pop-item-check">
                        <IconCheck size={16} />
                      </span>
                    )}
                  </button>
                );
              })}
              {shown.length === 0 && <div className="pop-note">没有叫这个名字的项目。</div>}
            </div>
            <div className="pop-divider" role="separator" />
            <button type="button" role="menuitem" className="pop-item compact" onClick={act(onBrowse)}>
              <span className="pop-item-icon">
                <IconFolder size={16} />
              </span>
              <span className="pop-item-label">打开其他目录…</span>
            </button>
            <button type="button" role="menuitem" className="pop-item compact" onClick={act(onNewProject)}>
              <span className="pop-item-icon">
                <IconPlus size={16} />
              </span>
              <span className="pop-item-label">新建项目</span>
            </button>
            {scratchAvailable && (
              <button type="button" role="menuitemradio" aria-checked={scratch} className="pop-item compact" onClick={act(onScratch)}>
                <span className="pop-item-icon">
                  <IconClose size={16} />
                </span>
                <span className="pop-item-label">不在项目中工作</span>
                {scratch && (
                  <span className="pop-item-check">
                    <IconCheck size={16} />
                  </span>
                )}
              </button>
            )}
            <button type="button" role="menuitem" className="pop-item compact" onClick={act(onManageRoots)}>
              <span className="pop-item-icon">
                <IconSettings size={16} />
              </span>
              <span className="pop-item-label">可用目录…</span>
            </button>
          </>
        );
      }}
    </Popover>
  );
}

/** The daemon's refusals, said the way the page says things. */
function explain(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ApiError && e.status === 409) return '这里已经有同名的文件或文件夹';
  if (/plain folder name/.test(message)) return '名称里不能有斜杠，也不能以点开头';
  if (/no such directory/.test(message)) return '找不到这个目录';
  if (/absolute path/.test(message)) return '请填写以 / 开头的完整路径';
  if (/too wide/.test(message)) return '范围太大：不能添加根目录或家目录本身，请选具体的项目文件夹';
  if (/already allowed/.test(message)) return '它已经在可用目录里了';
  if (/cannot be removed here/.test(message)) return '这个目录来自 hub 的启动设置，不能在这里移除';
  return message;
}

/** Shared frame for the two dialogs here: the app's own modal, closed with Escape or a click outside. */
function Frame({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="dialog-scrim" onClick={onCancel}>
      <div className="dialog project-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="project-dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}>
            <IconClose size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface NewProjectProps {
  api: Api;
  roots: string[];
  onCreated: (path: string) => void;
  onCancel: () => void;
}

/** A new project folder in one of the roots, a git repository by default so worktrees work at once. */
export function NewProjectDialog({ api, roots, onCreated, onCancel }: NewProjectProps) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState(roots[0] ?? '');
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = async () => {
    if (!name.trim() || !parent || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.createProject({ parent, name: name.trim(), git });
      onCreated(made.path);
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title="新建项目" onCancel={onCancel}>
      <label className="project-name">
        <IconFolder size={16} />
        <input
          ref={inputRef}
          value={name}
          placeholder="项目名称"
          aria-label="项目名称"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </label>
      {roots.length > 1 && (
        <>
          <div className="project-label">放在</div>
          <div className="project-roots" role="radiogroup" aria-label="放在哪个目录">
            {roots.map((root) => (
              <button key={root} type="button" role="radio" aria-checked={root === parent} className="pop-item compact" onClick={() => setParent(root)}>
                <span className="pop-item-icon">
                  <IconFolder size={16} />
                </span>
                <span className="pop-item-text">
                  <span className="pop-item-label">{folderName(root)}</span>
                  <span className="pop-item-hint">{root}</span>
                </span>
                {root === parent && (
                  <span className="pop-item-check">
                    <IconCheck size={16} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
      <label className="dialog-option">
        <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
        <span className="dialog-option-text">
          <span>初始化为 git 仓库</span>
          <span className="dialog-option-hint">带一个空的首次提交，新线程可以直接开在工作树里</span>
        </span>
      </label>
      <p className="project-path">{name.trim() ? `会建在 ${parent.replace(/\/$/, '')}/${name.trim()}` : `会建在 ${parent}`}</p>
      {error && <p className="project-error">{error}</p>}
      <div className="dialog-actions">
        <button className="ghost" onClick={onCancel}>
          取消
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!name.trim() || busy}>
          创建项目
        </button>
      </div>
    </Frame>
  );
}

interface RootsProps {
  api: Api;
  roots: NonNullable<WorkdirsConfig['roots']>;
  onChange: (config: WorkdirsConfig) => void;
  onCancel: () => void;
}

/** Which folders the hub lets agents work in: the ones it was started with, and ones added here. */
export function RootsDialog({ api, roots, onChange, onCancel }: RootsProps) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<WorkdirsConfig>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      return true;
    } catch (e) {
      setError(explain(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (!path.trim() || busy) return;
    if (await run(() => api.addWorkdir(path.trim()))) setPath('');
  };

  return (
    <Frame title="可用目录" onCancel={onCancel}>
      <p className="dialog-message">新线程只能在这些目录和它们的子目录里开始。添加后，agent 可以读写这个目录下的所有内容。</p>
      <div className="roots-list">
        {roots.map((root) => (
          <div key={root.path} className="roots-row">
            <IconFolder size={16} />
            <span className="roots-path" title={root.path}>
              {root.path}
            </span>
            {root.removable ? (
              <button type="button" className="roots-remove" disabled={busy} onClick={() => void run(() => api.removeWorkdir(root.path))}>
                移除
              </button>
            ) : (
              <span className="roots-fixed" title="来自 hub 的启动设置（RAH_WORKDIRS）">启动设置</span>
            )}
          </div>
        ))}
      </div>
      <div className="roots-add">
        <input
          value={path}
          placeholder="/完整/路径"
          aria-label="要添加的目录"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button type="button" className="btn-primary" disabled={!path.trim() || busy} onClick={() => void add()}>
          添加
        </button>
      </div>
      {error && <p className="project-error">{error}</p>}
    </Frame>
  );
}
