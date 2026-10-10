import { useEffect, useState } from 'react';
import { AuthError, type AgentInfo, type AgentSession, type Api, type Thread } from '../api';
import { folderName } from '../paths';
import { filterSessions, SESSION_LIMIT, sessionTitle, timeAgo } from '../sessions';
import { IconClose, IconFolder, IconImport, IconSearch } from './icons';

interface Props {
  api: Api;
  /** Agents that can list and replay their past sessions. */
  agents: AgentInfo[];
  onImported: (thread: Thread) => void;
  /** Open a session that is already a thread here. */
  onOpen: (threadId: string) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}

type Load = { state: 'loading' } | { state: 'ready'; sessions: AgentSession[] } | { state: 'failed'; message: string };

/**
 * Conversations the agents already have, started in a terminal or anywhere else.
 * Importing one makes it a thread here; the agent session stays the same, so both sides can carry on.
 */
export function ImportPanel({ api, agents, onImported, onOpen, onClose, onError }: Props) {
  const [agent, setAgent] = useState(agents[0]?.id ?? '');
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A problem here is shown in the panel, where the user is looking. Only a bad token goes up.
  const report = (e: unknown, show: (message: string) => void) => {
    if (e instanceof AuthError) onError(e);
    else show(e instanceof Error ? e.message : String(e));
  };

  const load = (id: string) => {
    setLoads((prev) => ({ ...prev, [id]: { state: 'loading' } }));
    api
      .agentSessions(id)
      .then((sessions) => setLoads((prev) => ({ ...prev, [id]: { state: 'ready', sessions } })))
      .catch((e) => report(e, (message) => setLoads((prev) => ({ ...prev, [id]: { state: 'failed', message } }))));
  };

  // Each agent's list is read once, the first time its tab is shown.
  useEffect(() => {
    if (agent && !loads[agent]) load(agent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const importOne = async (session: AgentSession) => {
    setFailure(null);
    setImporting(session.id);
    try {
      onImported(await api.importSession(agent, session.id));
    } catch (e) {
      report(e, setFailure);
    } finally {
      setImporting(null);
    }
  };

  const current = loads[agent];
  const label = agents.find((a) => a.id === agent)?.label ?? agent;
  const all = current?.state === 'ready' ? current.sessions : [];
  const matching = filterSessions(all, search);
  const shown = matching.slice(0, SESSION_LIMIT);
  const now = Date.now();

  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby="import-title" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 id="import-title" className="panel-title">
            <IconImport size={20} /> 导入历史
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <p className="panel-hint">把在终端里聊过的会话接到这里。导入后两边是同一个会话，可以接着聊。</p>

        {agents.length > 1 && (
          <div className="segmented panel-tabs" role="tablist" aria-label="Agent">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={a.id === agent}
                className={`segment${a.id === agent ? ' active' : ''}`}
                disabled={importing !== null}
                onClick={() => {
                  setAgent(a.id);
                  setFailure(null);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        <label className="panel-search">
          <IconSearch size={16} />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索标题或目录" aria-label="搜索会话" />
        </label>

        {failure && (
          <p className="panel-error" role="alert">
            导入失败：{failure}
          </p>
        )}

        <div className="panel-list">
          {agents.length === 0 && <p className="panel-empty">现在没有可以导入历史的 agent。</p>}
          {current?.state === 'loading' && <p className="panel-empty">正在读取 {label} 的会话…</p>}
          {current?.state === 'failed' && (
            <div className="panel-empty">
              <p>读取 {label} 的会话失败：{current.message}</p>
              <button className="text-btn" onClick={() => load(agent)}>
                重试
              </button>
            </div>
          )}
          {current?.state === 'ready' && shown.length === 0 && (
            <p className="panel-empty">{all.length === 0 ? `允许的工作目录里还没有 ${label} 的会话。` : '没有匹配的会话。'}</p>
          )}
          {shown.map((s) => (
            <div key={s.id} className="panel-row single">
              <div className="panel-row-main">
                <div className="panel-row-title">{sessionTitle(s)}</div>
                <div className="panel-row-meta">
                  <span className="meta-folder" title={s.cwd}>
                    <IconFolder size={13} />
                    {folderName(s.cwd)}
                  </span>
                  {timeAgo(s.updatedAt, now) && <span>{timeAgo(s.updatedAt, now)}</span>}
                  {s.threadId && <span className="tag">已导入</span>}
                </div>
              </div>
              {s.threadId ? (
                <button className="text-btn" disabled={importing !== null} onClick={() => onOpen(s.threadId!)}>
                  打开
                </button>
              ) : (
                <button className="text-btn strong" disabled={importing !== null} onClick={() => void importOne(s)}>
                  {importing === s.id ? '导入中…' : '导入'}
                </button>
              )}
            </div>
          ))}
          {matching.length > shown.length && (
            <p className="panel-more">还有 {matching.length - shown.length} 个没有列出，用搜索缩小范围。</p>
          )}
        </div>
      </div>
    </div>
  );
}
