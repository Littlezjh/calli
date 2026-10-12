import { useState } from 'react';
import type { AgentInfo, ModelOption } from '../api';
import { usageSummary, type Usage } from '../timeline';
import { EFFORT_LABELS, PERMISSION_LABELS, PERMISSION_ORDER, permissionHint } from '../permissions';
import { AgentMark, IconCheck, IconChevron, IconFolder, IconHand, IconPlus, IconShield, IconShieldAlert, IconSparkle, IconWorktree } from './icons';
import { Popover } from './Popover';

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
}

/** How much the agent may do without asking. Hidden for agents that have no permission modes. */
export function PermissionPicker({ modes, value, onChange, canAsk, openSignal }: PermissionProps) {
  const ordered = PERMISSION_ORDER.filter((m) => modes.includes(m));
  if (ordered.length === 0) return null;
  const Icon = PERMISSION_ICON[value] ?? IconShield;
  return (
    <Popover
      label="权限"
      openSignal={openSignal}
      triggerClassName={`tool-btn keep${value === 'full_access' ? ' warn' : ''}`}
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
  models: ModelOption[];
  model: string | null;
  efforts: string[];
  effort: string | null;
  onModel: (model: string | null) => void;
  onEffort: (effort: string | null) => void;
  /** Opens the panel when this number changes. */
  openSignal?: number;
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

/** Model and thinking effort in one panel, like the model control in Codex. */
export function ModelPicker({ models, model, efforts, effort, onModel, onEffort, openSignal }: ModelProps) {
  if (models.length === 0 && efforts.length === 0) return null;
  // Effort follows the model: some models take fewer levels, some take none.
  const levels = effortsForModel(models, model, efforts);
  const shownEffort = effort && levels.includes(effort) ? effort : null;
  return (
    <Popover
      label="模型与思考强度"
      openSignal={openSignal}
      align="end"
      triggerClassName="tool-btn"
      trigger={
        <>
          <span>{modelName(models, model)}</span>
          {shownEffort && <span className="tool-btn-sub">{EFFORT_LABELS[shownEffort] ?? shownEffort}</span>}
          <IconChevron size={13} open />
        </>
      }
    >
      {(close) => (
        <>
          {efforts.length > 0 && (
            <>
              <div className="pop-title">思考强度</div>
              {levels.length > 0 ? (
                <div className="segmented" role="radiogroup" aria-label="思考强度">
                  {[null, ...levels].map((level) => (
                    <button
                      key={level ?? 'default'}
                      type="button"
                      role="radio"
                      aria-checked={shownEffort === level}
                      className={`segment${shownEffort === level ? ' active' : ''}`}
                      onClick={() => onEffort(level)}
                    >
                      {level === null ? '默认' : (EFFORT_LABELS[level] ?? level)}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="pop-note">{modelName(models, model)} 没有思考强度设置。</div>
              )}
            </>
          )}
          {models.length > 0 && (
            <>
              <div className="pop-title">模型</div>
              <div className="pop-scroll">
                {modelRows(models).map((row) => {
                  // A thread saved with the literal "default" id is the same as no override.
                  const checked = row.value === (model === AGENT_DEFAULT ? null : model);
                  return (
                    <button
                      key={row.value ?? 'default'}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      className="pop-item compact"
                      onClick={() => {
                        onModel(row.value);
                        close();
                      }}
                    >
                      <span className="pop-item-text">
                        <span className="pop-item-label">{row.label}</span>
                        <span className="pop-item-hint">{row.hint}</span>
                      </span>
                      {checked && (
                        <span className="pop-item-check">
                          <IconCheck size={16} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </Popover>
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
  /** Extra CLIs found on this host; picking one adds it as a new instance. */
  discovered?: DiscoveredAgent[];
  onAdd?: (agent: DiscoveredAgent) => Promise<void>;
  /** Signed-in accounts found on this host; picking one links it as a new instance. */
  accounts?: DiscoveredAccount[];
  onAddAccount?: (account: DiscoveredAccount) => Promise<void>;
}

export function AgentPicker({ agents, value, onChange, discovered = [], onAdd, accounts = [], onAddAccount }: AgentProps) {
  const current = agents.find((a) => a.id === value);
  const [adding, setAdding] = useState<string | null>(null);
  // The marks the thread list shows in place of names are introduced here, next to the names.
  const marks = agents.some((a) => a.icon);
  return (
    <Popover
      label="Agent"
      triggerClassName="context-btn"
      trigger={
        <>
          {current?.icon && <AgentMark path={current.icon} size={14} />}
          <span>{current?.label ?? value}</span>
          <IconChevron size={12} open />
        </>
      }
    >
      {(close) => (
        <>
          <div className="pop-title">用哪个 agent？</div>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitemradio"
              aria-checked={a.id === value}
              className="pop-item compact"
              disabled={!a.available}
              onClick={() => {
                onChange(a.id);
                close();
              }}
            >
              {marks && <span className="pop-item-icon">{a.icon && <AgentMark path={a.icon} size={16} />}</span>}
              <span className="pop-item-text">
                <span className="pop-item-label">{a.label}</span>
                {!a.available && <span className="pop-item-hint">这台主机上没有找到</span>}
              </span>
              {a.id === value && (
                <span className="pop-item-check">
                  <IconCheck size={16} />
                </span>
              )}
            </button>
          ))}
          {onAdd && discovered.length > 0 && (
            <>
              <div className="pop-sep">在这台主机上发现</div>
              {discovered.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="pop-item compact"
                  disabled={adding !== null}
                  onClick={async () => {
                    setAdding(d.id);
                    try {
                      await onAdd(d);
                      onChange(d.id);
                      close();
                    } finally {
                      setAdding(null);
                    }
                  }}
                >
                  {marks && <span className="pop-item-icon" />}
                  <span className="pop-item-text">
                    <span className="pop-item-label">{d.id}</span>
                    <span className="pop-item-hint">添加后作为新 agent 使用</span>
                  </span>
                  <span className="pop-item-check">
                    {adding === d.id ? <IconSparkle size={13} /> : <IconPlus size={14} />}
                  </span>
                </button>
              ))}
            </>
          )}
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
export function UsageMeter({ usage }: { usage: Usage }) {
  const { percent, high, detail } = usageSummary(usage);
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
          <span>{percent}%</span>
        </>
      }
    >
      {() => (
        <>
          <div className="pop-title">上下文</div>
          <div className="pop-note">
            {detail}
            {high && '。快满了，agent 可能很快会自动压缩前面的内容。'}
          </div>
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
      triggerClassName="context-btn"
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
