import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import Markdown from 'react-markdown';
import { Api, type AgentInfo, type HostInfo, type SkillDetail, type SkillEntry, type SkillInstallOutcome, type SkillsListing, type SkillPayload } from '../api';
import { copyText } from '../clipboard';
import { useIsNarrow } from '../hooks';
import { Dialog, DialogSurface } from './Dialog';
import { Menu, type MenuEntry } from './Menu';
import { AgentMark, IconCheck, IconClose, IconCopy, IconInfo, IconMore, IconPlus, IconRefresh, IconRestore, IconSearch, IconTrash } from './icons';

/**
 * The skills of every agent on every machine, in one view: a row per skill, a column per machine,
 * and in each cell the marks of the agents that can use it there. A skill nowhere on a machine
 * offers to travel: the sync dialog picks a source (the newest copy, by default) and target
 * agents, and moves a packed copy through the same API the page reads. Nothing is written unless
 * a copy is asked for, and only into agent skill folders.
 */

interface Props {
  /** The client of the machine on screen. */
  api: Api;
  /** To open one client per other machine, through the hub's proxy. */
  token: string;
  /** The machine on screen: one of the hub's others, or null for the hub's own. */
  hostId: string | null;
  hosts: HostInfo[];
  /** The agents of the machine on screen, for their marks. */
  agents: AgentInfo[];
  onError: (e: unknown) => void;
}

/** One machine's column: what it holds, and the marks to draw it with. */
interface MachineColumn {
  /** A host id, or null for the hub's own machine. */
  id: string | null;
  label: string;
  agents: AgentInfo[];
  listing: SkillsListing | null;
  error: string | null;
}

/** A skill row: where it is, machine by machine. */
interface SkillRow {
  name: string;
  description: string;
  places: Array<{ machine: MachineColumn; entry: SkillEntry }>;
}

const PLACE_KEY = '\u0000';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "14:05" today, "3月12日" before that: enough to tell copies apart. */
function when(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `${at.getMonth() + 1}月${at.getDate()}日`;
}

/** The mark of an agent, with its name for hover and screen readers. */
function Mark({ agent, size = 16 }: { agent: AgentInfo; size?: number }) {
  return (
    <span className="skill-mark" title={agent.label} aria-label={agent.label}>
      {agent.icon ? <AgentMark path={agent.icon} size={size} /> : <span className="skill-mark-name">{agent.label}</span>}
    </span>
  );
}

/** Every agent that can see the skill through one machine's folders. */
function marksFor(column: MachineColumn, agents: string[]): JSX.Element[] {
  return agents
    .map((id) => column.agents.find((a) => a.id === id))
    .filter((a): a is AgentInfo => Boolean(a))
    .map((agent, i) => <Mark key={`${agent.id}-${i}`} agent={agent} />);
}

export function SkillsPage({ api, token, hostId, hosts, agents, onError }: Props) {
  const narrow = useIsNarrow();
  const loadGeneration = useRef(0);
  const [columns, setColumns] = useState<MachineColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<{ row: SkillRow; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<{ row: SkillRow; column: MachineColumn } | null>(null);
  const [sync, setSync] = useState<{ row: SkillRow } | null>(null);
  const [removing, setRemoving] = useState<{ row: SkillRow; column: MachineColumn; entry: SkillEntry; path: string } | null>(null);

  /** The client of any machine: the one on screen, or one opened through the hub's proxy. */
  const clientFor = useCallback(
    (id: string | null): Api => (id === (hostId ?? null) ? api : new Api(token, '', id)),
    [api, token, hostId],
  );

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    // Keep the hub and offline machines visible even while viewing a remote machine.
    const wanted: Array<{ id: string | null; label: string }> = [
      { id: hostId ?? null, label: hostId ? (hosts.find((h) => h.id === hostId)?.label ?? hostId) : '本机' },
      ...(hostId ? [{ id: null, label: '本机' }] : []),
      ...hosts.filter((h) => h.id !== hostId).map((h) => ({ id: h.id, label: h.label })),
    ];
    setColumns((prev) =>
      wanted.map((w) => {
        const old = prev.find((c) => c.id === w.id);
        return { id: w.id, label: w.label, agents: old?.agents ?? (w.id === (hostId ?? null) ? agents : []), listing: old?.listing ?? null, error: old?.error ?? null };
      }),
    );
    setLoading(true);
    await Promise.all(
      wanted.map(async (w) => {
        const client = clientFor(w.id);
        try {
          const listing = await client.skills();
          let agentList: AgentInfo[] = w.id === (hostId ?? null) ? agents : [];
          if (w.id !== (hostId ?? null)) {
            try {
              agentList = await client.agents();
            } catch {
              // The marks are nice to have; the folders say what the column shows either way.
            }
          }
          if (generation !== loadGeneration.current) return;
          setColumns((prev) => prev.map((c) => (c.id === w.id ? { ...c, agents: agentList, listing, error: null } : c)));
        } catch (e) {
          if (generation !== loadGeneration.current) return;
          setColumns((prev) => prev.map((c) => (c.id === w.id ? { ...c, listing: null, error: e instanceof Error ? e.message : String(e) } : c)));
        }
      }),
    );
    if (generation === loadGeneration.current) setLoading(false);
  }, [clientFor, hostId, hosts, agents]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo<SkillRow[]>(() => {
    const names = new Set<string>();
    for (const column of columns) for (const entry of column.listing?.skills ?? []) names.add(entry.name);
    const want = search.trim().toLowerCase();
    const out: SkillRow[] = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const places = columns.flatMap((machine) => {
        const entry = machine.listing?.skills.find((s) => s.name === name);
        return entry ? [{ machine, entry }] : [];
      });
      if (places.length === 0) continue;
      if (want && !name.toLowerCase().includes(want) && !places.some((p) => p.entry.description.toLowerCase().includes(want))) continue;
      out.push({ name, description: places.map((p) => p.entry.description).find((d) => d) ?? '', places });
    }
    return out;
  }, [columns, search]);

  const gridStyle = { '--cols': String(Math.max(columns.length, 1)), ...(columns.length <= 1 ? { gridTemplateColumns: 'minmax(0, 1fr) 34px' } : {}) } as CSSProperties;
  const single = columns.length <= 1;
  /** Copies of this skill that are not the same everywhere: worth pointing at. */
  const differs = (row: SkillRow): boolean => new Set(row.places.flatMap((p) => p.entry.locations.map((l) => l.digest))).size > 1;

  const openMenu = (row: SkillRow) => (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ row, x: rect.right - 220, y: rect.bottom + 4 });
  };

  const menuItems = (row: SkillRow): MenuEntry[] => [
    { id: 'view', label: '查看说明', icon: IconInfo, onSelect: () => setPreview({ row, column: row.places[0].machine }) },
    { id: 'sync', label: '同步到…', icon: IconRestore, onSelect: () => setSync({ row }) },
    'separator',
    ...row.places.flatMap((p) =>
      p.entry.locations.map((location) => ({
        id: `remove:${p.machine.id ?? ''}:${location.path}`,
        label:
          p.entry.locations.length > 1
            ? `删除（${p.machine.label} · ${when(location.mtime)}）`
            : `删除（${p.machine.label}）`,
        icon: IconTrash,
        danger: true,
        onSelect: () => setRemoving({ row, column: p.machine, entry: p.entry, path: location.path }),
      })),
    ),
    'separator',
    {
      id: 'copy',
      label: '复制名称',
      icon: IconCopy,
      onSelect: () => {
        void copyText(row.name);
      },
    },
  ];

  return (
    <div className="skills-page">
      <header className="skills-head">
        <h1 className="skills-title">技能</h1>
        <p className="skills-hint">查看各台机器、各个 agent 的全局技能，选择来源与目标同步。</p>
        <div className="skills-tools">
          <label className="skills-search">
            <IconSearch size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索技能" aria-label="搜索技能" />
            {search && (
              <button className="icon-btn" aria-label="清除搜索" onClick={() => setSearch('')}>
                <IconClose size={14} />
              </button>
            )}
          </label>
          <button className="icon-btn" aria-label="重新读取" title="重新读取" onClick={() => void load()}>
            <IconRefresh size={17} />
          </button>
        </div>
      </header>

      {columns.length > 1 && (
        <div className="skills-grid skills-grid-head" style={gridStyle} role="row">
          <div className="skills-cell skills-cell-name" />
          {columns.map((c) => (
            <div key={c.id ?? 'local'} className="skills-cell skills-cell-machine" role="columnheader">
              {c.label}
              {c.listing === null && c.error && <span className="skills-machine-error" title={c.error}>连不上</span>}
            </div>
          ))}
        </div>
      )}

      <div className="skills-list">
        {columns.filter((c) => c.error).map((c) => <p className="skill-sync-error" key={c.id ?? 'local'}>{c.label}：读取失败，点击重新读取重试。</p>)}
        {rows.length === 0 && (
          <div className="panel-empty">{loading ? '正在读取各台机器的技能…' : search ? '没有匹配的技能。' : '这台机器上还没有技能。装好之后再回来看。'}</div>
        )}
        {rows.map((row) => (
          <div key={row.name} className="skills-grid skills-row" style={gridStyle} role="row">
            <button
              type="button"
              className="skills-cell skills-cell-name"
              role="cell"
              onClick={() => setPreview({ row, column: row.places[0].machine })}
              title="查看说明"
            >
              <span className="skills-name-col">
                <span className="skills-name">
                  {row.name}
                  {differs(row) && <span className="skills-differs" title="各处的副本内容不一样">版本不同</span>}
                </span>
                {row.description && <span className="skills-desc">{row.description}</span>}
                <span className="skills-meta">
                  {row.places[0].entry.fileCount} 个文件 · {bytes(row.places[0].entry.sizeBytes)}
                </span>
              </span>
              {single && row.places[0] && (
                <span className="skill-marks" title={`装在这台机器，${row.places[0].entry.agents.length} 个 agent 可用`}>
                  {marksFor(row.places[0].machine, row.places[0].entry.agents)}
                </span>
              )}
            </button>
            {!single &&
              columns.map((column) => {
                const place = row.places.find((p) => p.machine === column);
                return (
                  <div key={column.id ?? 'local'} className="skills-cell skills-cell-machine" role="cell">
                    {place ? (
                      <span className="skill-marks" title={`装在 ${column.label}`}>{marksFor(column, place.entry.agents)}</span>
                    ) : (
                      <button type="button" className="skill-add" disabled={!column.listing} title={`同步到 ${column.label}`} onClick={() => setSync({ row })}>
                        <IconPlus size={11} /> 同步
                      </button>
                    )}
                  </div>
                );
              })}
            <button type="button" className="row-more" aria-label={`${row.name} 的操作`} onClick={openMenu(row)}>
              <IconMore size={15} />
            </button>
            {narrow && !single && (
              <div className="skills-mobile-machines">
                {columns.map((column) => {
                  const place = row.places.find((p) => p.machine === column);
                  return (
                    <span key={column.id ?? 'local'} className={`skills-mobile-machine${place ? '' : ' empty'}`}>
                      <span className="skills-mobile-label">{column.label}</span>
                      {place ? marksFor(column, place.entry.agents) : <button type="button" className="skill-add" disabled={!column.listing} onClick={() => setSync({ row })}><IconPlus size={11} /> 同步</button>}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {menu && <Menu label={`${menu.row.name} 的操作`} x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {preview && <SkillPreview column={preview.column} row={preview.row} clientFor={clientFor} onClose={() => setPreview(null)} onError={onError} />}
      {sync && <SkillSync row={sync.row} columns={columns} clientFor={clientFor} onClose={() => setSync(null)} onDone={load} onError={onError} />}
      {removing && (
        <Dialog
          title={`删除技能 ${removing.row.name}？`}
          message={`从 ${removing.column.label} 的 ${removing.path} 移除。agent 下次启动就看不到它了；其他机器不受影响。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void clientFor(target.column.id)
              .skillRemove(target.row.name, target.path)
              .then(load)
              .catch(onError);
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/** The SKILL.md of one copy, read where it stands. */
function SkillPreview({ row, column, clientFor, onClose, onError }: { row: SkillRow; column: MachineColumn; clientFor: (id: string | null) => Api; onClose: () => void; onError: (e: unknown) => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    clientFor(column.id)
      .skillDetail(row.name, row.places.find((p) => p.machine === column)?.entry.locations[0].path ?? null)
      .then((d) => !stale && setDetail(d))
      .catch((e) => {
        if (stale) return;
        setError(e instanceof Error ? e.message : String(e));
        onError(e);
      });
    return () => {
      stale = true;
    };
  }, [clientFor, column, row, onError]);

  const place = row.places.find((p) => p.machine === column);
  return (
    <DialogSurface className="skill-dialog" labelledBy="skill-preview-title" onClose={onClose}>
        <div className="skill-dialog-head">
          <h2 id="skill-preview-title" className="skill-dialog-title">
            {row.name}
          </h2>
          {place && <span className="skill-marks">{marksFor(column, place.entry.agents)}</span>}
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        {place && (
          <p className="skill-dialog-meta">
            {column.label} · {place.entry.locations[0].path} · {place.entry.fileCount} 个文件 · {bytes(place.entry.sizeBytes)} · 更新于 {when(place.entry.locations[0].mtime)}
          </p>
        )}
        <div className="skill-dialog-body">
          {error && <div className="panel-empty">读不到说明：{error}</div>}
          {!error && !detail && <div className="panel-empty">读取中…</div>}
          {detail && <div className="markdown skill-md">{detail.skillMd ? <Markdown>{detail.skillMd}</Markdown> : <p className="panel-empty">这个技能没有写说明。</p>}</div>}
        </div>
    </DialogSurface>
  );
}

/** One target of a sync: a machine and an agent on it, keyed for the checkbox set. */
interface SyncTarget {
  key: string;
  machine: MachineColumn;
  agent: AgentInfo;
  hasSkill: boolean;
}

type SyncPhase = { running: true } | { done: Map<string, SkillInstallOutcome & { machineId: string | null }> };

const isRunning = (phase: SyncPhase | null): boolean => phase !== null && 'running' in phase;
const doneOf = (phase: SyncPhase | null): Map<string, SkillInstallOutcome & { machineId: string | null }> | null =>
  phase !== null && !('running' in phase) ? phase.done : null;

/**
 * Moves one skill: a source picked among its copies (the newest by default) and target agents on
 * any machine. The copy goes through the same API the page reads — fetched from the source
 * machine, written by each target machine's own daemon — and only ever into skill folders.
 */
function SkillSync({
  row,
  columns,
  clientFor,
  onClose,
  onDone,
  onError,
}: {
  row: SkillRow;
  columns: MachineColumn[];
  clientFor: (id: string | null) => Api;
  onClose: () => void;
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  // One source per copy: the machine and the folder it sits in.
  const sources = useMemo(
    () =>
      row.places.flatMap((p) =>
        p.entry.locations
          .filter((l) => l.agents.length > 0)
          .map((l) => ({ machine: p.machine, entry: p.entry, place: l })),
      ),
    [row],
  );
  const newest = useMemo(() => sources.reduce((best, s) => (!best || s.place.mtime > best.place.mtime ? s : best), sources[0]), [sources]);
  const [source, setSource] = useState(() => newest);

  const targets = useMemo<SyncTarget[]>(
    () =>
      columns.flatMap((machine) => {
        // Installing is only writing files, so an agent offers itself as a target by reading a
        // skills folder at all — whether its CLI happens to answer right now is not the point.
        const withDirs = new Set(machine.listing?.locations.filter((l) => l.scope === 'personal').flatMap((l) => l.agents) ?? []);
        return machine.agents
          .filter((a) => withDirs.has(a.id))
          .map((agent) => ({
            key: `${machine.id ?? ''}${PLACE_KEY}${agent.id}`,
            machine,
            agent,
            hasSkill: row.places.some((p) => p.machine.id === machine.id && p.entry.agents.includes(agent.id)),
          }));
      }),
    [columns, row],
  );

  const [checked, setChecked] = useState<Set<string>>(() => {
    // Select only agents that do not already see this skill.
    const out = new Set<string>();
    for (const target of targets) {
      if (target.hasSkill) continue;
      out.add(target.key);
    }
    return out;
  });
  const [phase, setPhase] = useState<SyncPhase | null>(null);
  const busy = isRunning(phase);

  const toggle = (key: string) => {
    if (busy) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Runs the copy. `overwritten` narrows a retry to the targets that said "exists". */
  const run = async (overwritten?: Set<string>) => {
    const keys = [...checked].filter((k) => !overwritten || overwritten.has(k));
    const byMachine = new Map<string | null, string[]>();
    for (const key of keys) {
      const [machineId, ...rest] = key.split(PLACE_KEY);
      const agent = rest.join(PLACE_KEY);
      const list = byMachine.get(machineId || null) ?? [];
      list.push(agent);
      byMachine.set(machineId || null, list);
    }
    setPhase({ running: true });
    let payload: SkillPayload;
    try {
      payload = await clientFor(source.machine.id).skillExport(row.name, source.place.path);
    } catch (e) {
      setPhase(null);
      onError(e);
      return;
    }
    const results = new Map<string, SkillInstallOutcome & { machineId: string | null }>(overwritten ? doneOf(phase) ?? [] : []);
    for (const [machineId, agentIds] of byMachine) {
      try {
        const outcomes = await clientFor(machineId).skillInstall({ skill: payload, targets: agentIds, overwrite: Boolean(overwritten) });
        for (const outcome of outcomes) results.set(`${machineId ?? ''}${PLACE_KEY}${outcome.agent}`, { ...outcome, machineId });
      } catch (e) {
        onError(e);
        for (const agent of agentIds) results.set(`${machineId ?? ''}${PLACE_KEY}${agent}`, { agent, dir: '', status: 'error', error: e instanceof Error ? e.message : String(e), machineId });
      }
    }
    setPhase({ done: results });
    onDone();
  };

  const label = (outcome: SkillInstallOutcome | undefined): { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' } => {
    switch (outcome?.status) {
      case 'installed':
        return { text: '已装上', tone: 'ok' };
      case 'same':
        return { text: '已是这个版本', tone: 'none' };
      case 'exists':
        return { text: '版本不同', tone: 'warn' };
      case 'no_dir':
        return { text: '不支持', tone: 'bad' };
      case 'error':
        return { text: '失败', tone: 'bad' };
      default:
        return { text: '', tone: 'none' };
    }
  };

  const done = doneOf(phase);
  const existsKeys = done ? new Set([...done.values()].filter((o) => o.status === 'exists').map((o) => `${o.machineId ?? ''}${PLACE_KEY}${o.agent}`)) : null;

  return (
    <DialogSurface className="skill-dialog skill-sync" labelledBy="skill-sync-title" onClose={onClose} busy={busy}>
        <div className="skill-dialog-head">
          <h2 id="skill-sync-title" className="skill-dialog-title">
            同步「{row.name}」
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose} disabled={busy}>
            <IconClose size={16} />
          </button>
        </div>

        <div className="skill-sync-scroll">
          <div className="skill-sync-group">
            <div className="skill-sync-label">从哪里复制</div>
            {sources.map((s) => (
              <label key={`${s.machine.id ?? ''}:${s.place.path}`} className={`skill-source${source === s ? ' picked' : ''}`}>
                <input
                  type="radio"
                  name={`skill-source-${row.name}`}
                  checked={source === s}
                  disabled={busy || Boolean(done)}
                  onChange={() => setSource(s)}
                />
                <span className="skill-source-marks">{marksFor(s.machine, s.place.agents)}</span>
                <span className="skill-source-text">
                  <span className="skill-source-machine">{s.machine.label}</span>
                  <span className="skill-source-path" title={s.place.path}>
                    {s.place.path} · {bytes(s.place.sizeBytes)} · {when(s.place.mtime)}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="skill-sync-group">
            <div className="skill-sync-label">装到哪些 agent</div>
            {columns.map((column) => {
              const reachable = column.listing !== null;
              const chips = targets.filter((t) => t.machine === column);
              return (
                <div key={column.id ?? 'local'} className="skill-target-row">
                  <span className="skill-target-machine">{column.label}</span>
                  <span className="skill-target-agents">
                    {!reachable && <span className="skill-target-none">连不上，稍后再试</span>}
                    {reachable && chips.map((t) => {
                      const outcome = done?.get(t.key);
                      const state = label(outcome);
                      return (
                        <button
                          key={t.key}
                          type="button"
                          className={`skill-target${checked.has(t.key) ? ' on' : ''}${outcome ? ` ${state.tone}` : ''}`}
                          disabled={busy || Boolean(done)}
                          aria-pressed={checked.has(t.key)}
                          title={t.hasSkill ? '这个 agent 已有此技能；版本不同时会先询问是否覆盖' : '这个 agent 尚未安装'}
                          onClick={() => toggle(t.key)}
                        >
                          {t.agent.icon ? <AgentMark path={t.agent.icon} size={13} /> : null}
                          <span className="skill-target-name">{t.agent.label}</span>
                          {outcome ? (
                            state.tone === 'ok' ? <IconCheck size={12} /> : <span className={`skill-target-state ${state.tone}`}>{state.text}</span>
                          ) : null}
                        </button>
                      );
                    })}
                    {reachable && chips.length === 0 && <span className="skill-target-none">没有可装的 agent</span>}
                  </span>
                </div>
              );
            })}
          </div>

          {done && (
            <div className="skill-sync-results">
              {[...done.values()].filter((o) => o.status === 'error' || o.status === 'no_dir').map((o) => (
                <p key={`err:${o.machineId}:${o.agent}`} className="skill-sync-error">
                  {o.agent}：{o.error ?? '装不上'}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-actions skill-sync-actions">
          {existsKeys && existsKeys.size > 0 ? (
            <>
              <button className="ghost" onClick={onClose}>
                关闭
              </button>
              <button className="primary" onClick={() => void run(existsKeys)}>
                覆盖 {existsKeys.size} 处
              </button>
            </>
          ) : done ? (
            <button className="primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <>
              <button className="ghost" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button className="primary" disabled={busy || checked.size === 0} onClick={() => void run()}>
                {busy ? '同步中…' : `同步到 ${checked.size} 个 agent`}
              </button>
            </>
          )}
        </div>
    </DialogSurface>
  );
}
