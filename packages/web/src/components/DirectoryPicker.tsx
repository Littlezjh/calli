import { useEffect, useState } from 'react';
import { ApiError, type Api, type ProjectDirectoryInfo, type WorkdirsConfig } from '../api';
import { folderName } from '../paths';
import { Dialog } from './Dialog';
import { IconChevron, IconFolder } from './icons';

interface DirectoryPickerProps {
  api: Api;
  roots: string[];
  selected: string;
  machine: string;
  onRootsChange: (config: WorkdirsConfig) => void;
  onManageRoots: () => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404 && error.message === 'not found') return '这台机器的服务尚不支持浏览家目录，请更新服务，或在「可用目录」中填写项目路径。';
    if (error.status === 404) return '找不到这个目录，它可能已被移动或删除。';
    if (error.status === 403) return '无法浏览这个目录：它不在浏览范围内，或当前用户没有读取权限。';
    if (/too wide/.test(error.message)) return '请进入具体项目，不能添加家目录或根目录本身。';
    if (/no such directory/.test(error.message)) return '找不到这个目录，它可能已被移动或删除。';
  }
  return error instanceof Error ? error.message : '无法读取目录，请重试。';
}

export function DirectoryPicker({ api, roots, selected, machine, onRootsChange, onManageRoots, onSelect, onClose }: DirectoryPickerProps) {
  // null shows configured roots; an empty path asks the daemon for its own home directory.
  const [at, setAt] = useState<string | null>(selected || null);
  const [info, setInfo] = useState<ProjectDirectoryInfo | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (at === null) return;
    let cancelled = false;
    const read = async () => {
      try {
        return await api.projectDirectories(at || undefined);
      } catch (e) {
        // Older daemons can still browse configured roots using their original endpoint.
        if (!(e instanceof ApiError) || e.status !== 404 || e.message !== 'not found' || !at ||
          !roots.some((root) => at === root || at.startsWith(root.replace(/\/$/, '') + '/'))) throw e;
        const old = await api.listDirectory(at);
        return {
          path: old.path,
          parent: old.parent && roots.some((root) => old.parent === root || old.parent!.startsWith(root.replace(/\/$/, '') + '/')) ? old.parent : null,
          directories: old.files.filter((f) => f.type === 'dir' && !f.name.startsWith('.') && f.name !== 'node_modules')
            .map((f) => ({ name: f.name, path: `${old.path.replace(/\/$/, '')}/${f.name}` })),
          allowed: true,
          selectable: true,
        };
      }
    };
    void read().then((value) => { if (!cancelled) setInfo(value); })
      .catch((e) => { if (!cancelled) setError(explain(e)); });
    return () => { cancelled = true; };
  }, [api, at, roots, retry]);

  const navigate = (path: string | null) => {
    setInfo(null);
    setError(null);
    setSearch('');
    setAt(path);
    setRetry((n) => n + 1);
  };
  const useDirectory = async () => {
    if (!info?.selectable || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!info.allowed) {
        try {
          onRootsChange(await api.addWorkdir(info.path));
        } catch (e) {
          // Another tab may have added this folder since the listing was loaded.
          if (!(e instanceof ApiError) || e.message !== 'already allowed') throw e;
          onRootsChange(await api.workdirs());
        }
      }
      onSelect(info.path);
      onClose();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const folders = at === null ? roots.map((path) => ({ name: folderName(path), path })) : info?.directories ?? [];
  const shown = folders.filter((folder) => folder.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  return (
    <Dialog
      title="在哪个目录里工作？"
      className="project-browser"
      confirmLabel={busy ? '正在添加…' : info && !info.allowed ? '添加并使用' : '用这个目录'}
      confirmDisabled={!info?.selectable || busy}
      onConfirm={() => void useDirectory()}
      onCancel={() => { if (!busy) onClose(); }}
    >
      <p className="project-browser-machine">{machine}</p>
      <div className="project-browser-controls" aria-busy={busy}>
        <div className="project-browser-nav">
          <button disabled={busy} type="button" className="ghost" onClick={() => navigate(null)}>可用目录</button>
          <button disabled={busy} type="button" className="ghost" onClick={() => navigate('')}>浏览家目录</button>
          {info?.parent && <button disabled={busy} type="button" className="ghost" onClick={() => navigate(info.parent)}>上一级</button>}
        </div>
        <p className="project-browser-path">{at === null ? '已添加的项目位置' : info?.path || at || '正在打开家目录…'}</p>
        <input disabled={busy} aria-label="搜索当前目录" placeholder="搜索当前目录下的文件夹" className="picker-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="project-browser-list" aria-label="文件夹">
          {at !== null && !info && !error ? <p className="project-browser-note" role="status">正在读取目录…</p> : shown.map((folder) => (
            <button disabled={busy} type="button" className="project-browser-folder" key={folder.path} onClick={() => navigate(folder.path)}>
              <IconFolder size={19} />
              <span><span>{folder.name}</span>{at === null && <small>{folder.path}</small>}</span>
              <IconChevron size={14} />
            </button>
          ))}
          {(at === null || info) && shown.length === 0 && <p className="project-browser-note">{search ? '没有匹配的文件夹' : '这里没有可浏览的子目录'}</p>}
        </div>
        {error && <div className="project-browser-error" role="alert">{error} <button disabled={busy} type="button" className="ghost" onClick={() => navigate(at)}>重试</button></div>}
        {info && !info.allowed && <p className="project-browser-note">{info.selectable ? '添加后，这个项目将出现在这台机器的可用目录中。' : '请进入具体项目文件夹，再添加并使用。'}</p>}
        <button disabled={busy} type="button" className="ghost project-browser-manage" onClick={onManageRoots}>手动添加目录…</button>
      </div>
    </Dialog>
  );
}
