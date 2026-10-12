import { useEffect, useState } from 'react';
import { ApiError, AuthError, type Api, type HostFailure, type HostInfo } from '../api';
import { HOST_STATUS, hostProblem } from '../hosts';
import { Dialog } from './Dialog';
import { IconCheck, IconChevron, IconClose, IconComputer, IconGlobe, IconPlus, IconServer, IconSettings } from './icons';
import { Popover } from './Popover';

/** ssh's own words, for whoever has to fix it. When no daemon answered there is nothing of ssh's to quote. */
const SshSaid = ({ host }: { host: Pick<HostInfo, 'code' | 'error'> }) =>
  host.error && host.code !== 'daemon_missing' ? <code className="host-error">{host.error}</code> : null;

const StatusDot = ({ status }: { status: HostInfo['status'] }) => (
  <span className={`host-dot ${status}`} role="img" aria-label={HOST_STATUS[status]} title={HOST_STATUS[status]} />
);

interface SwitcherProps {
  hosts: HostInfo[];
  /** The machine on screen; null is the hub's own. */
  current: string | null;
  onPick: (id: string | null) => void;
}

/** Chooses where a new conversation runs, next to its project rather than only in the sidebar. */
export function MachinePicker({ hosts, current, onPick, onManage }: SwitcherProps & { onManage: () => void }) {
  const selected = hosts.find((host) => host.id === current);
  const label = current ? `远程 · ${selected?.label ?? '连接中'}` : '本机';
  return (
    <Popover label="工作位置" triggerLabel="选择机器" triggerClassName="context-btn machine-trigger" triggerTitle={label}
      trigger={<>
        {current ? <IconGlobe size={15} /> : <IconComputer size={15} />}
        <span>{label}</span>
        {current && <StatusDot status={selected?.status ?? 'connecting'} />}
        <IconChevron size={12} open />
      </>}
    >
      {(close) => <>
        <div className="pop-title">工作位置</div>
        <button type="button" role="menuitemradio" aria-checked={current === null} className="pop-item compact" onClick={() => { close(); onPick(null); }}>
          <span className="pop-item-icon"><IconComputer size={17} /></span>
          <span className="pop-item-text"><span className="pop-item-label">本机</span><span className="pop-item-hint">Hub 所在机器</span></span>
          {current === null && <span className="pop-item-check"><IconCheck size={16} /></span>}
        </button>
        {hosts.length > 0 && <div className="pop-sep">远程机器</div>}
        {hosts.map((host) => <button key={host.id} type="button" role="menuitemradio" aria-checked={current === host.id} className="pop-item compact" title={host.target}
          onClick={() => { close(); onPick(host.id); }}>
          <span className="pop-item-icon"><IconGlobe size={17} /></span>
          <span className="pop-item-text"><span className="pop-item-label">{host.label}</span><span className="pop-item-hint machine-status"><StatusDot status={host.status} />{HOST_STATUS[host.status]}</span></span>
          {current === host.id && <span className="pop-item-check"><IconCheck size={16} /></span>}
        </button>)}
        <div className="pop-divider" role="separator" />
        <button type="button" role="menuitem" className="pop-item compact" onClick={() => { close(); onManage(); }}>
          <span className="pop-item-icon"><IconSettings size={17} /></span>
          <span className="pop-item-label">管理机器…</span>
        </button>
      </>}
    </Popover>
  );
}

/** Which machine the list below is of, like the row on top of Codex's phone app. Absent until a machine is added. */
export function HostSwitcher({ hosts, current, onPick }: SwitcherProps) {
  if (hosts.length === 0) return null;
  return (
    <div className="host-switch" role="tablist" aria-label="机器">
      <button type="button" role="tab" aria-selected={current === null} className={`host-chip${current === null ? ' active' : ''}`} onClick={() => onPick(null)}>
        <StatusDot status="online" />
        <span className="host-chip-name">本机</span>
      </button>
      {hosts.map((h) => (
        <button
          key={h.id}
          type="button"
          role="tab"
          aria-selected={h.id === current}
          className={`host-chip${h.id === current ? ' active' : ''}`}
          title={h.target}
          onClick={() => onPick(h.id)}
        >
          <StatusDot status={h.status} />
          <span className="host-chip-name">{h.label}</span>
        </button>
      ))}
    </div>
  );
}

/** What the main area says while the machine on screen cannot be reached. Its threads are over there, so there is nothing else to show. */
export function HostDown({ host, onRetry }: { host: HostInfo; onRetry: () => Promise<unknown> }) {
  const [trying, setTrying] = useState(false);
  const connecting = trying || host.status === 'connecting';
  return (
    <div className="empty host-down">
      <div className="host-down-body">
        <h2>{connecting ? `正在连接 ${host.label}…` : `连不上 ${host.label}`}</h2>
        {!connecting && <p>{hostProblem(host.code, host.target)}</p>}
        {!connecting && <SshSaid host={host} />}
        <button
          className="ghost"
          disabled={connecting}
          onClick={() => {
            setTrying(true);
            void onRetry().finally(() => setTrying(false));
          }}
        >
          重试
        </button>
      </div>
    </div>
  );
}

interface PanelProps {
  api: Api;
  hosts: HostInfo[];
  /** Called after machines were added, removed or retried, so the rest of the page hears of it. */
  onChanged: () => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => void;
}

/**
 * The machines this hub shows besides its own. Adding one takes only what ssh calls it: the hub
 * signs in, finds the Limi running there, and keeps a connection to it.
 */
export function HostsPanel({ api, hosts, onChanged, onClose, onError }: PanelProps) {
  const [candidates, setCandidates] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  /** The ssh name being signed in to, while that takes its seconds. */
  const [adding, setAdding] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ target: string; code?: HostFailure; error: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<HostInfo | null>(null);

  const loadCandidates = () =>
    api
      .hostCandidates()
      .then(setCandidates)
      .catch(() => undefined);

  useEffect(() => {
    void loadCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !removing) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, removing]);

  const add = async (name: string) => {
    const wanted = name.trim();
    if (!wanted || adding) return;
    setFailure(null);
    setAdding(wanted);
    try {
      await api.addHost(wanted);
      setTarget('');
      await Promise.all([onChanged(), loadCandidates()]);
    } catch (e) {
      // Shown here, where the user is looking. Only a bad token goes up.
      if (e instanceof AuthError) onError(e);
      else setFailure({ target: wanted, code: e instanceof ApiError ? (e.details.code as HostFailure | undefined) : undefined, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setAdding(null);
    }
  };

  const retry = async (host: HostInfo) => {
    setBusy(host.id);
    try {
      await api.reconnectHost(host.id);
    } catch (e) {
      if (e instanceof AuthError) onError(e);
    } finally {
      await onChanged();
      setBusy(null);
    }
  };

  const remove = async (host: HostInfo) => {
    setRemoving(null);
    setBusy(host.id);
    try {
      await api.removeHost(host.id);
      await Promise.all([onChanged(), loadCandidates()]);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <div className="dialog-scrim" onClick={onClose}>
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby="hosts-title" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 id="hosts-title" className="panel-title">
            <IconServer size={20} /> 机器
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <p className="panel-hint">把别的机器上的 Limi 接到这里，一个页面管多台。hub 用 SSH 连过去，那台机器不用开端口，也不用再输 token。</p>

        <div className="panel-list">
          {hosts.map((h) => (
            <div key={h.id} className="panel-row single host-row">
              <div className="panel-row-main">
                <div className="panel-row-title">
                  <StatusDot status={busy === h.id ? 'connecting' : h.status} /> {h.label}
                </div>
                <div className="panel-row-meta">
                  <span className="host-target">{h.target}</span>
                  <span>{HOST_STATUS[busy === h.id ? 'connecting' : h.status]}</span>
                  {h.version && <span>版本 {h.version}</span>}
                </div>
                {h.status === 'offline' && busy !== h.id && (
                  <p className="host-problem">
                    {hostProblem(h.code, h.target)}
                    <SshSaid host={h} />
                  </p>
                )}
              </div>
              {h.status !== 'online' && (
                <button className="text-btn" disabled={busy !== null} onClick={() => void retry(h)}>
                  重试
                </button>
              )}
              <button className="text-btn danger" disabled={busy !== null} onClick={() => setRemoving(h)}>
                移除
              </button>
            </div>
          ))}

          <div className="group-label host-add-label">添加机器</div>
          <form
            className="host-add"
            onSubmit={(e) => {
              e.preventDefault();
              void add(target);
            }}
          >
            <label className="panel-search host-add-field">
              <IconPlus size={16} />
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="ssh 别名，或 user@host"
                aria-label="ssh 别名，或 user@host"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={adding !== null}
              />
            </label>
            <button type="submit" className="primary" disabled={!target.trim() || adding !== null}>
              {adding !== null && adding === target.trim() ? '连接中…' : '添加'}
            </button>
          </form>
          {failure && (
            <p className="panel-error host-failure" role="alert">
              没能添加 {failure.target}：{hostProblem(failure.code, failure.target)}
              <SshSaid host={failure} />
            </p>
          )}

          {candidates.length > 0 && <p className="host-candidates-hint">hub 的 ~/.ssh/config 里有这些，点一下就加：</p>}
          {candidates.length > 0 && (
            <div className="host-candidates">
              {candidates.map((alias) => (
                <button key={alias} type="button" className="host-candidate" aria-label={`添加 ${alias}`} disabled={adding !== null} onClick={() => void add(alias)}>
                  <IconPlus size={13} />
                  <span className="host-target">{alias}</span>
                  {adding === alias && <span className="host-candidate-note">连接中…</span>}
                </button>
              ))}
            </div>
          )}
          <p className="host-foot">那台机器上要先装好并启动 Limi（scripts/install-service.sh），hub 所在的机器要能不输密码 ssh 过去。</p>
        </div>
      </div>
    </div>
    {removing && (
      <Dialog
        title={`移除 ${removing.label}？`}
        message="只是不再从这里连它。那台机器上的线程和数据都不会动，以后可以再加回来。"
        confirmLabel="移除"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove(removing)}
      />
    )}
    </>
  );
}
