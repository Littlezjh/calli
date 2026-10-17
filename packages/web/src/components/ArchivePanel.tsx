import { useEffect, useState } from 'react';
import type { AgentInfo, Api, Thread } from '../api';
import { folderName } from '../paths';
import { IconArchive, IconClose, IconSearch } from './icons';
import { formatDate, t } from '../i18n';

interface Props {
  api: Api;
  agents: AgentInfo[];
  /** Changes whenever a thread was archived, restored or deleted elsewhere, so the list reloads. */
  refreshKey: number;
  onRestore: (thread: Thread) => void;
  onDelete: (thread: Thread) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}

function archivedOn(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return t('archive.archivedOn', formatDate(iso, { month: 'short', day: 'numeric' }));
}

/** Archived threads: out of the sidebar, still on disk, one tap from coming back. */
export function ArchivePanel({ api, agents, refreshKey, onRestore, onDelete, onClose, onError }: Props) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .threads({ archived: true })
      .then((list) => alive && setThreads(list))
      .catch((e) => alive && onError(e));
    return () => {
      alive = false;
    };
    // onError only reports; it is not a reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, refreshKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const query = search.trim().toLowerCase();
  const shown = (threads ?? []).filter((t) => !query || t.title.toLowerCase().includes(query) || t.cwd.toLowerCase().includes(query));
  const label = (id: string) => agents.find((a) => a.id === id)?.label ?? id;

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby="archive-title" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 id="archive-title" className="panel-title">
            <IconArchive size={20} /> {t('archive.title')}
          </h2>
          <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <p className="panel-hint">{t('archive.hint')}</p>
        <label className="panel-search">
          <IconSearch size={16} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('archive.search')}
            aria-label={t('archive.search')}
          />
        </label>

        <div className="panel-list">
          {threads === null && <p className="panel-empty">{t('common.loading')}</p>}
          {threads !== null && shown.length === 0 && (
            <p className="panel-empty">{threads.length === 0 ? t('archive.empty') : t('archive.noMatch')}</p>
          )}
          {shown.map((thread) => (
            <div key={thread.id} className="panel-row">
              <div className="panel-row-main">
                <div className="panel-row-title">{thread.title}</div>
                <div className="panel-row-meta">
                  <span className="tag">{label(thread.agent)}</span>
                  <span>{folderName(thread.cwd)}</span>
                  <span>{archivedOn(thread.archivedAt)}</span>
                </div>
              </div>
              <button className="text-btn" onClick={() => onRestore(thread)}>
                {t('archive.restore')}
              </button>
              <button className="text-btn danger" onClick={() => onDelete(thread)}>
                {t('archive.delete')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
