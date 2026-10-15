import { useMemo, useState } from 'react';
import type { AgentInfo, ModelOption } from '../api';
import { usageSummary, type Usage } from '../timeline';
import { EFFORT_LABELS, PERMISSION_LABELS, PERMISSION_ORDER, permissionHint } from '../permissions';
import { AgentMark, IconBolt, IconEffortGauge, IconCompress, IconRefresh, IconCheck, IconChevron, IconFolder, IconHand, IconPlus, IconShield, IconShieldAlert, IconSparkle, IconWorktree } from './icons';
import { Popover } from './Popover';
import { EffortSlider } from './EffortSlider';
import { useIsNarrow } from '../hooks';

const PERMISSION_ICON: Record<string, (p: { size?: number }) => JSX.Element> = {
  ask: IconHand,
  auto_edit: IconShield,
  full_access: IconShieldAlert,
};

interface PermissionProps {
  modes: string[];
  value: string;
  onChange: (mode: string) => void;
  /** Whether the agent can stop and ask. False changes what the middle level means. */
  canAsk: boolean;
  /** Opens the panel when this number changes. */
  openSignal?: number;
  /** Whose level this is, where it is not the thread's own: the trigger is then a quiet mark with a short word. */
  quietFor?: string;
}

/** How much the agent may do without asking. Hidden for agents that have no permission modes. */
export function PermissionPicker({ modes, value, onChange, canAsk, openSignal, quietFor }: PermissionProps) {
  const ordered = PERMISSION_ORDER.filter((m) => modes.includes(m));
  if (ordered.length === 0) return null;
  const Icon = PERMISSION_ICON[value] ?? IconShield;
  return (
    <Popover
      label="权限"
      openSignal={openSignal}
      align={quietFor === undefined ? undefined : 'end'}
      triggerClassName={quietFor === undefined ? `tool-btn keep${value === 'full_access' ? ' warn' : ''}` : 'member-model set'}
      triggerLabel={quietFor === undefined ? undefined : `${quietFor} 的权限`}
      triggerTitle={permissionHint(value, canAsk)}
      trigger={
        <>
          <Icon size={16} />
          <span>{PERMISSION_LABELS[value]?.short ?? value}</span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="pop-title">{canAsk ? '如何批准 agent 的操作？' : '允许 agent 做什么？'}</div>
          {ordered.map((m) => {
            const ItemIcon = PERMISSION_ICON[m] ?? IconShield;
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={m === value}
                className={`pop-item${m === 'full_access' ? ' warn' : ''}`}
                onClick={() => {
                  onChange(m);
                  close();
                }}
              >
                <span className="pop-item-icon">
                  <ItemIcon size={18} />
                </span>
                <span className="pop-item-text">
                  <span className="pop-item-label">{PERMISSION_LABELS[m]?.label ?? m}</span>
                  <span className="pop-item-hint">{permissionHint(m, canAsk)}</span>
                </span>
                {m === value && (
                  <span className="pop-item-check">
                    <IconCheck size={16} />
                  </span>
                )}
              </button>
            );
          })}
        </>
      )}
    </Popover>
  );
}

interface ModelProps {
  onDiagnose?: () => void;
  models: ModelOption[];
  model: string | null;
  efforts: string[];
  effort: string | null;
  onModel: (model: string | null) => void;
  onEffort: (effort: string | null) => void;
  /** Opens the panel when this number changes. */
  openSignal?: number;
  /**
   * Whose setting this is, where it is not the thread's own. The trigger is then a quiet mark that
   * only spells the choice out once one has been made, and it is there before the models are known.
   */
  quietFor?: string;
}

/** The id some agents use for "whatever you would pick yourself". */
const AGENT_DEFAULT = 'default';

/**
 * What the agent reports about a model. For null (no override) that is the agent's default: an
 * entry with the id "default" if there is one (Claude), else the entry flagged as default (pi).
 */
export function resolveModel(models: ModelOption[], id: string | null): ModelOption | undefined {
  if (id !== null) return models.find((m) => m.id === id);
  return models.find((m) => m.id === AGENT_DEFAULT) ?? models.find((m) => m.isDefault);
}

/** What the default currently points at, when the agent says. */
function defaultTarget(models: ModelOption[]): string | undefined {
  const alias = models.find((m) => m.id === AGENT_DEFAULT);
  if (alias) return alias.description || undefined;
  return models.find((m) => m.isDefault)?.label;
}

/** The name shown for a model id. With no override, the model the agent's default points at. */
export function modelName(models: ModelOption[], id: string | null): string {
  if (id === null) return defaultTarget(models) ?? '默认模型';
  return models.find((m) => m.id === id)?.label ?? id;
}

/** Why pictures cannot be sent with this model, or null when they can. */
export function imagesBlocked(models: ModelOption[], id: string | null): string | null {
  const option = resolveModel(models, id);
  return option?.images === false && !option.imagesVia ? `${option.label} 不能读图片，请换一个模型` : null;
}

/** How pictures reach a model that cannot read them itself, or null when it reads them (or cannot get them at all). */
export function imagesNote(models: ModelOption[], id: string | null): string | null {
  const option = resolveModel(models, id);
  return option?.images === false && option.imagesVia ? `${option.label} 不能直接看图，会用 ${option.imagesVia} 交给能看图的模型` : null;
}

/**
 * Effort levels the given model accepts. `model` null is the agent default.
 * Falls back to the agent-wide list when the agent does not report per-model levels.
 */
export function effortsForModel(models: ModelOption[], model: string | null, fallback: string[]): string[] {
  return resolveModel(models, model)?.efforts ?? fallback;
}

/**
 * Rows for the model list. If the agent lists its own default, that row stands for "no override"
 * (stored as null), so there is never a second, duplicate default row.
 */
export function modelRows(models: ModelOption[]): Array<{ value: string | null; label: string; hint?: string }> {
  const rest = models.filter((m) => m.id !== AGENT_DEFAULT).map((m) => ({ value: m.id, label: m.label, hint: m.description }));
  const target = defaultTarget(models);
  const first = target
    ? { value: null, label: '默认', hint: `当前是 ${target}` }
    : { value: null, label: '默认模型', hint: '使用 agent 自己配置的模型' };
  return [first, ...rest];
}

/** Model and thinking effort in a compact card; the model list is a second view. */
export function ModelPicker(props: ModelProps) {
  const { models, model, efforts, effort, openSignal, quietFor } = props;
  const narrow = useIsNarrow();
  if (models.length === 0 && efforts.length === 0 && quietFor === undefined) {
    return (
      <Popover
        label="模型"
        openSignal={openSignal}
        align="end"
        triggerClassName="tool-btn model-control-trigger"
        triggerLabel="模型：暂无可选模型"
        triggerTitle="暂无可选模型"
        trigger={<><span className="model-trigger-name">模型</span><IconChevron size={13} open /></>}
      >
        {close => <><div className="pop-title">暂无可选模型</div><p className="member-model-empty">还没有从这个实例读到可选模型。请检查实例的模型配置与登录状态，配置完成后刷新页面。</p>{props.onDiagnose && <button type="button" role="menuitem" className="pop-item compact" onClick={() => { close(); props.onDiagnose?.(); }}><span className="pop-item-label">检查实例</span></button>}</>}
      </Popover>
    );
  }
  const levels = effortsForModel(models, model, efforts);
  const shownEffort = effort && levels.includes(effort) ? effort : null;
  if (quietFor !== undefined) {
    const chosen = [model ? modelName(models, model) : '', shownEffort ? (EFFORT_LABELS[shownEffort] ?? shownEffort) : ''].filter(Boolean).join(' · ');
    return (
      <Popover
        label="模型与思考强度"
        align="end"
        panelClassName="model-control-panel"
        triggerClassName={`member-model${chosen ? ' set' : ''}`}
        triggerLabel={`${quietFor} 的模型与思考强度`}
        triggerTitle={chosen || '模型与思考强度：默认'}
        trigger={<><IconBolt size={14} />{chosen && <span>{chosen}</span>}</>}
      >
        {() => (models.length === 0 && efforts.length === 0 ? <p className="member-model-empty">这个实例没有可选的模型或思考强度。</p> : <ModelControl {...props} />)}
      </Popover>
    );
  }
  return (
    <Popover
      label="模型与思考强度"
      openSignal={openSignal}
      align="end"
      panelClassName="model-control-panel"
      triggerClassName={`tool-btn model-control-trigger${narrow && levels.length > 0 ? ' dial-only' : ''}`}
      triggerTitle={`${modelName(models, model)} · ${shownEffort ? (EFFORT_LABELS[shownEffort] ?? shownEffort) : '默认强度'}`}
      triggerLabel={`模型与思考强度：${modelName(models, model)} · ${shownEffort ? (EFFORT_LABELS[shownEffort] ?? shownEffort) : '默认强度'}`}
      trigger={<>
        {/* A phone has room for the dial alone; the card it opens names the model. */}
        {!(narrow && levels.length > 0) && <span className="model-trigger-name">{modelName(models, model)}</span>}
        {levels.length > 0 && <span className="model-trigger-gauge"><IconEffortGauge size={narrow ? 20 : 17} level={shownEffort ? (levels.indexOf(shownEffort) + 1) / levels.length : null} /></span>}
        {!narrow && <IconChevron size={13} open />}
      </>}
    >
      {() => <ModelControl {...props} />}
    </Popover>
  );
}

function ModelControl({ models, model, efforts, effort, onModel, onEffort }: ModelProps) {
  const levels = effortsForModel(models, model, efforts);
  const [showModels, setShowModels] = useState(levels.length === 0);
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const selected = effort && levels.includes(effort) ? effort : null;
  const shown = preview === undefined ? selected : preview;
  return showModels ? (
    <>
      <div className="model-list-head">
        {levels.length > 0 && <button type="button" className="icon-btn model-back" aria-label="返回思考强度" onClick={() => setShowModels(false)}><IconChevron size={16} /></button>}
        <span>选择模型</span>
      </div>
      <div className="pop-scroll">
        {modelRows(models).map((row) => (
          <button key={row.value ?? 'default'} type="button" role="menuitemradio" aria-checked={row.value === (model === AGENT_DEFAULT ? null : model)} className="pop-item compact"
            onClick={() => { onModel(row.value); setPreview(undefined); setShowModels(false); }}>
            <span className="pop-item-text"><span className="pop-item-label">{row.label}</span><span className="pop-item-hint">{row.hint}</span></span>
            {row.value === (model === AGENT_DEFAULT ? null : model) && <span className="pop-item-check"><IconCheck size={16} /></span>}
          </button>
        ))}
      </div>
    </>
  ) : (
    <div className="effort-card">
      <div className="effort-card-head">
        <span className="effort-symbol"><IconBolt size={19} /></span>
        <div className="effort-card-heading">
          <div className="effort-value" aria-live="polite">{levels.length ? (shown ? (EFFORT_LABELS[shown] ?? shown) : '默认') : '无需设置强度'}</div>
          <button type="button" className="effort-model" disabled={models.length === 0} onClick={() => setShowModels(true)} aria-label={`切换模型，当前 ${modelName(models, model)}`}>
            <span>{modelName(models, model)}</span><IconChevron size={13} />
          </button>
        </div>
        <button type="button" className="icon-btn effort-reset" aria-label="恢复默认强度" title="恢复默认强度" disabled={selected === null} onClick={() => onEffort(null)}><IconRefresh size={18} /></button>
      </div>
      {levels.length > 0 ? <EffortSlider key={`${model ?? 'default'}:${levels.join(',')}`} levels={levels} value={selected} onChange={onEffort} onPreview={setPreview} />
        : <div className="pop-note">当前模型不提供思考强度设置。</div>}
    </div>
  );
}

/** Which agent a new thread uses. Existing threads show the agent as plain text instead. */
/** A CLI on PATH that looks like another copy of a known agent, as the picker offers it. */
export interface DiscoveredAgent {
  id: string;
  adapter: string;
  command: string;
}

/** An account of a multi-account agent already signed in on this host, as the picker offers it. */
export interface DiscoveredAccount {
  adapter: string;
  email: string;
  env: Record<string, string>;
  id: string;
  label: string;
}

interface AgentProps {
  agents: AgentInfo[];
  value: string;
  onChange: (id: string) => void;
  /** Signed-in accounts found on this host; picking one links it as a new instance. */
  accounts?: DiscoveredAccount[];
  onAddAccount?: (account: DiscoveredAccount) => Promise<void>;
}

/**
 * Agents grouped the way the picker shows them: instances of one adapter belong together, and a
 * group with several of them folds into one row that opens to the accounts. An agent whose
 * adapter is not told stands as a group of its own, the way it always listed.
 */
export function agentGroups(agents: AgentInfo[]): AgentInfo[][] {
  const groups = new Map<string, AgentInfo[]>();
  for (const a of agents) {
    const key = a.adapter ?? `_${a.id}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.values()];
}

/** One group's name: the shortest label in it, which for a pair like "Claude Code" and
 * "Claude Code 2" is the adapter's own name. */
function groupLabel(group: AgentInfo[]): string {
  return group.reduce((short, a) => (a.label.length < short.length ? a.label : short), group[0].label);
}

export function AgentPicker({ agents, value, onChange, accounts = [], onAddAccount }: AgentProps) {
  const current = agents.find((a) => a.id === value);
  const [adding, setAdding] = useState<string | null>(null);
  /** The group whose accounts are on screen, drilled in from the list of agents. */
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const groups = useMemo(() => agentGroups(agents), [agents]);
  const drilled = groups.find((g) => g.some((a) => a.id === openGroup)) ?? null;
  // The marks the thread list shows in place of names are introduced here, next to the names.
  const marks = agents.some((a) => a.icon);
  return (
    <Popover
      label="Agent"
      triggerClassName={`context-btn agent-btn${current?.icon ? ' has-mark' : ''}`}
      trigger={
        <>
          {current?.icon && <AgentMark path={current.icon} size={14} />}
          <span>{current?.label ?? value}</span>
          <IconChevron size={12} open />
        </>
      }
    >
      {(close) =>
        drilled ? (
          <>
            <button type="button" className="pop-back" onClick={() => setOpenGroup(null)}>
              <IconChevron size={12} /> {groupLabel(drilled)}
            </button>
            {drilled.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={a.id === value}
                className="pop-item compact"
                disabled={!a.available}
                onClick={() => {
                  onChange(a.id);
                  setOpenGroup(null);
                  close();
                }}
              >
                {marks && <span className="pop-item-icon">{a.icon && <AgentMark path={a.icon} size={16} />}</span>}
                <span className="pop-item-text">
                  <span className="pop-item-label">{a.label}</span>
                  {a.account ? (
                    <span className="pop-item-hint">{a.account}</span>
                  ) : (
                    !a.available && <span className="pop-item-hint">这台主机上没有找到</span>
                  )}
                </span>
                {a.id === value && (
                  <span className="pop-item-check">
                    <IconCheck size={16} />
                  </span>
                )}
              </button>
            ))}
          </>
        ) : (
          <>
          <div className="pop-title">用哪个 agent？</div>
          {groups.map((group) => {
            const solo = group.length === 1 ? group[0] : null;
            if (solo)
              return (
                <button
                  key={solo.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={solo.id === value}
                  className="pop-item compact"
                  disabled={!solo.available}
                  onClick={() => {
                    onChange(solo.id);
                    close();
                  }}
                >
                  {marks && <span className="pop-item-icon">{solo.icon && <AgentMark path={solo.icon} size={16} />}</span>}
                  <span className="pop-item-text">
                    <span className="pop-item-label">{solo.label}</span>
                    {!solo.available && <span className="pop-item-hint">这台主机上没有找到</span>}
                  </span>
                  {solo.id === value && (
                    <span className="pop-item-check">
                      <IconCheck size={16} />
                    </span>
                  )}
                </button>
              );
            // Several accounts of one agent: the row stands for the agent, says which account is
            // in use, and opens to the choice.
            const active = group.find((a) => a.id === value) ?? group[0];
            return (
              <button
                key={active.id}
                type="button"
                className="pop-item compact"
                onClick={() => setOpenGroup(active.id)}
              >
                {marks && <span className="pop-item-icon">{active.icon && <AgentMark path={active.icon} size={16} />}</span>}
                <span className="pop-item-text">
                  <span className="pop-item-label">{groupLabel(group)}</span>
                  <span className="pop-item-hint">{active.account ?? active.label}</span>
                </span>
                <span className="pop-item-check">
                  <IconChevron size={13} />
                </span>
              </button>
            );
          })}
          {onAddAccount && accounts.length > 0 && (
            <>
              <div className="pop-sep">已登录的账号</div>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="pop-item compact"
                  disabled={adding !== null}
                  onClick={async () => {
                    setAdding(a.id);
                    try {
                      await onAddAccount(a);
                      onChange(a.id);
                      close();
                    } finally {
                      setAdding(null);
                    }
                  }}
                >
                  <span className="pop-item-text">
                    <span className="pop-item-label">{a.email}</span>
                    <span className="pop-item-hint">{a.label} · 添加后用这个账号</span>
                  </span>
                  <span className="pop-item-check">
                    {adding === a.id ? <IconSparkle size={13} /> : <IconPlus size={14} />}
                  </span>
                </button>
              ))}
            </>
          )}
        </>
      )}
    </Popover>
  );
}

/** How full the agent's context window is: a small ring that opens to the numbers. */
export function UsageMeter({ usage, onCompact, running, compactDisabled, compactQueued }: {
  usage: Usage | null;
  onCompact?: () => Promise<void>;
  running?: boolean;
  compactDisabled?: boolean;
  compactQueued?: boolean;
}) {
  const [compacting, setCompacting] = useState(false);
  const { percent, high, detail } = usage ? usageSummary(usage)
    : { percent: 0, high: false, detail: '暂未获取上下文用量，下一次响应后更新。' };
  // A ring of radius 6 has a circumference of about 37.7; the dash shows the used share of it.
  const circumference = 2 * Math.PI * 6;
  return (
    <Popover
      label="上下文用量"
      align="end"
      triggerClassName={`usage${high ? ' high' : ''}`}
      trigger={
        <>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="usage-track" cx="8" cy="8" r="6" fill="none" strokeWidth="2.2" />
            <circle
              className="usage-fill"
              cx="8"
              cy="8"
              r="6"
              fill="none"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span>{usage ? `${percent}%` : '上下文'}</span>
        </>
      }
    >
      {(close) => (
        <>
          <div className="pop-title">上下文</div>
          <div className="pop-note">
            {detail}
            {high && '。快满了，agent 可能很快会自动压缩前面的内容。'}
          </div>
          {onCompact && <button type="button" className="pop-item compact context-compact" disabled={compacting || compactDisabled || compactQueued}
            onClick={async () => {
              setCompacting(true);
              try { await onCompact(); close(); } catch { /* The caller displays the error. */ }
              finally { setCompacting(false); }
            }}>
            <span className="pop-item-icon"><IconCompress size={17} /></span>
            <span className="pop-item-text"><span className="pop-item-label">{compacting ? '正在提交…' : compactQueued ? '已排队压缩' : '压缩'}</span>
              <span className="pop-item-hint">{compactDisabled ? '消息队列已满' : running ? '本轮结束后压缩，保留当前草稿' : '精简较早的对话，释放上下文'}</span>
            </span>
          </button>}
        </>
      )}
    </Popover>
  );
}

interface WorkspaceProps {
  /** The branch the directory is on, or null when HEAD is detached. */
  branch: string | null;
  /** Files there that differ from the last commit; they come along into a worktree. */
  changes: number;
  worktree: boolean;
  onChange: (worktree: boolean) => void;
}

/**
 * Where a new thread works: in the directory itself, or in a new git worktree of it under
 * `.worktrees/`. Offered only when the directory is in a repository, so it is not there otherwise.
 */
export function WorkspacePicker({ branch, changes, worktree, onChange }: WorkspaceProps) {
  const from = branch ? `从 ${branch} ` : '从当前提交';
  const rows = [
    { value: false, icon: <IconFolder size={16} />, label: '当前目录', hint: '直接在这个目录里改' },
    {
      value: true,
      icon: <IconWorktree size={16} />,
      label: '新工作树',
      hint: `${from}新开一个分支，放在 .worktrees 下${changes > 0 ? `，带上 ${changes} 个没提交的改动` : ''}`,
    },
  ];
  return (
    <Popover
      label="在哪里工作"
      triggerClassName="context-btn workspace-btn"
      triggerTitle={worktree ? '在新工作树里开始' : '在当前目录里开始'}
      trigger={
        <>
          {worktree ? <IconWorktree size={14} /> : <IconFolder size={14} />}
          <span>{worktree ? '新工作树' : '当前目录'}</span>
          <IconChevron size={12} open />
        </>
      }
    >
      {(close) =>
        rows.map((row) => (
          <button
            key={String(row.value)}
            type="button"
            role="menuitemradio"
            aria-checked={worktree === row.value}
            className="pop-item"
            onClick={() => {
              onChange(row.value);
              close();
            }}
          >
            <span className="pop-item-icon">{row.icon}</span>
            <span className="pop-item-text">
              <span className="pop-item-label">{row.label}</span>
              <span className="pop-item-hint">{row.hint}</span>
            </span>
            {worktree === row.value && (
              <span className="pop-item-check">
                <IconCheck size={16} />
              </span>
            )}
          </button>
        ))
      }
    </Popover>
  );
}
