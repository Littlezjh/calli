import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react';
import type { AgentInfo, Api, Schedule, ScheduleRun, Thread } from '../api';
import { PERMISSION_LABELS, PERMISSION_ORDER, startingPermission } from '../permissions';
import { folderName } from '../paths';
import { Dialog, DialogSurface } from './Dialog';
import { Menu, type MenuEntry } from './Menu';
import { Popover } from './Popover';
import { AgentMark, IconClock, IconClose, IconFolder, IconMore, IconPlay, IconPlus } from './icons';

interface Props {
  api: Api;
  /** The whole list, owned by App so it survives page switches. */
  schedules: Schedule[];
  agents: AgentInfo[];
  /** Roots for picking a directory: offered alongside the directories threads already use. */
  workdirs: string[];
  /** Bumped when the daemon says something changed, so the page reloads. */
  refreshKey: number;
  onReload: () => void;
  /** Opens the thread a run happened in, taking the page's place. */
  onOpenThread: (id: string) => void;
  onError: (e: unknown) => void;
}

/** How a schedule's frequency is picked: presets write the cron, custom writes it by hand. */
type Preset = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

const PRESET_LABELS: Record<Exclude<Preset, 'custom'>, string> = {
  minutes: '每隔几分钟',
  hourly: '每小时',
  daily: '每天',
  weekdays: '每工作日',
  weekly: '每周',
  monthly: '每月',
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad = (n: number) => String(n).padStart(2, '0');

const isCommit = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => e.key === 'Enter' && !e.nativeEvent.isComposing;

/** Reads "HH:MM"; returns null when it is not that. */
function parseTime(value: string): [number, number] | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

function cronFromPreset(preset: Preset, opts: { time: string; weekday: number; day: string; interval: string }): string | null {
  const at = parseTime(opts.time);
  if (!at) return null;
  const [h, m] = at;
  switch (preset) {
    case 'minutes': {
      const step = Number(opts.interval);
      return step >= 1 && step <= 59 ? `*/${step} * * * *` : null;
    }
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekly':
      return `${m} ${h} * * ${opts.weekday}`;
    case 'monthly': {
      const day = Number(opts.day);
      return day >= 1 && day <= 31 ? `${m} ${h} ${day} * *` : null;
    }
    default:
      return null;
  }
}

/** Which preset a stored expression is, so the form opens the way it was written. */
function presetFromCron(cron: string): { preset: Preset; time: string; weekday: number; day: string; interval: string } {
  const parts = cron.trim().split(/\s+/);
  const base = { preset: 'custom' as Preset, time: '09:00', weekday: 1, day: '1', interval: '30' };
  if (parts.length !== 5) return base;
  const [m, h, dom, mon, dow] = parts;
  if (mon !== '*' || dom !== '*' || m === '*') return base;
  const time = `${pad(Number(h))}:${pad(Number(m))}`;
  if (/^\*\/\d+$/.test(m) && h === '*' && dow === '*') return { ...base, preset: 'minutes', interval: m.slice(2) };
  const shaped = { ...base, time: parseTime(`${h}:${m}`) ? time : '09:00' };
  if (h !== '*' && dow === '*') return { ...shaped, preset: 'daily' };
  if (dow === '1-5') return { ...shaped, preset: 'weekdays' };
  if (/^\d$/.test(dow)) return { ...shaped, preset: 'weekly', weekday: Number(dow) };
  return base;
}

const RUN_LABELS: Record<ScheduleRun['status'], string> = {
  running: '运行中',
  done: '已完成',
  error: '出错',
  skipped: '跳过',
  missed: '错过',
};

/** "今天 09:02" / "10月12日 09:02", in this device's words. */
function whenLabel(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return sameDay ? `今天 ${hm}` : `${at.getMonth() + 1}月${at.getDate()}日 ${hm}`;
}

/** The next run, said shortly: "14:30" today, else with its day. */
function nextLabel(iso: string): string {
  return whenLabel(iso);
}

const STATUS_DOT: Record<ScheduleRun['status'], string> = {
  running: 'running',
  done: 'ok',
  error: 'bad',
  skipped: 'idle',
  missed: 'idle',
};

/** The frequency as the card says it: the daemon's words, or the raw expression. */
function frequencyLabel(s: Schedule): string {
  return s.description || `cron: ${s.cron}`;
}

export function SchedulesPage({ api, schedules, agents, workdirs, refreshKey, onReload, onOpenThread, onError }: Props) {
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [menu, setMenu] = useState<{ schedule: Schedule; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);

  useEffect(() => {
    if (refreshKey > 0) onReload();
    // onReload only refetches; it is not a reason to run again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
      onReload();
    } catch (e) {
      onError(e);
    }
  };

  const runNow = (s: Schedule) =>
    act(async () => {
      const out = await api.runSchedule(s.id);
      // The list comes back on its own; a skip says why it did not go.
      if (out.status === 'skipped' || out.status === 'error') onError(new Error(out.message ?? (out.status === 'skipped' ? '上一轮还没有结束' : '没有运行')));
    });

  const empty = schedules.length === 0;

  return (
    <div className="sched-page">
      <div className="sched-head">
        <div>
          <h2 className="sched-title">
            <IconClock size={18} /> 定时任务
          </h2>
          <p className="sched-sub">按设定的时间自动让 agent 在指定目录里跑一段提示词，跑完的会话和其他会话在一起。</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          <IconPlus size={15} /> 新建任务
        </button>
      </div>

      {empty && (
        <div className="sched-empty">
          <IconClock size={28} />
          <p>还没有定时任务。建一个，比如每天早上让它看一遍构建、每周写一份进展。</p>
        </div>
      )}

      <ul className="sched-list">
        {schedules.map((s) => {
          const agent = agentOf(s.agent);
          const last = s.lastRun;
          return (
            <li key={s.id} className={`sched-card${s.enabled ? '' : ' off'}`}>
              <div className="sched-main">
                <button className="sched-open" onClick={() => setEditing(s)} title="查看和编辑">
                  <span className="sched-name">
                    <span className={`sched-dot ${last ? STATUS_DOT[last.status] : 'none'}`} aria-hidden="true" />
                    {s.name}
                  </span>
                  <span className="sched-freq">
                    {agent?.icon ? (
                      <AgentMark path={agent.icon} size={13} />
                    ) : (
                      <span className="sched-agent-name">{agent?.label ?? s.agent}</span>
                    )}
                    {frequencyLabel(s)}
                    {s.mode === 'same' ? ' · 固定线程' : ''}
                    {s.timezone && s.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` · ${s.timezone}` : ''}
                  </span>
                  <span className="sched-meta">
                    {s.enabled ? (s.nextRunAt ? `下次 ${nextLabel(s.nextRunAt)}` : '没有下次运行') : '已停用'}
                    {last && ` · 上次 ${RUN_LABELS[last.status]}`}
                  </span>
                  {s.problem && <span className="sched-problem">{s.problem}</span>}
                </button>
              </div>
              <div className="sched-side">
                <button
                  className={`switch${s.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={s.enabled ? '停用这个任务' : '启用这个任务'}
                  onClick={() => act(() => api.updateSchedule(s.id, { enabled: !s.enabled }))}
                >
                  <span className="switch-knob" />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`${s.name} 的更多操作`}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenu({ schedule: s, x: rect.right - 208, y: rect.bottom + 4 });
                  }}
                >
                  <IconMore />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {menu && (
        <Menu
          label={`${menu.schedule.name} 的操作`}
          x={menu.x}
          y={menu.y}
          items={[
            { id: 'run', label: '立即运行', icon: IconPlay, onSelect: () => runNow(menu.schedule) },
            { id: 'edit', label: '编辑', icon: IconClock, onSelect: () => setEditing(menu.schedule) },
            'separator' as const,
            { id: 'delete', label: '删除', icon: IconClose, danger: true, onSelect: () => setDeleting(menu.schedule) },
          ] satisfies MenuEntry[]}
          onClose={() => setMenu(null)}
        />
      )}

      {deleting && (
        <Dialog
          title="删除定时任务"
          message={`删除「${deleting.name}」后不再自动运行。它已经建过的会话会保留。`}
          confirmLabel="删除"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={(_, __) => {
            const gone = deleting;
            setDeleting(null);
            void act(() => api.deleteSchedule(gone.id));
          }}
        />
      )}

      {editing && (
        <ScheduleEditor
          api={api}
          schedule={editing === 'new' ? null : editing}
          agents={agents}
          workdirs={workdirs}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onReload();
          }}
          onOpenThread={onOpenThread}
          onError={onError}
        />
      )}
    </div>
  );
}

/** A thread the form can bind, distilled to what choosing one needs. */
interface PickThread {
  id: string;
  title: string;
  agent: string;
  cwd: string;
}

interface EditorProps {
  api: Api;
  schedule: Schedule | null;
  agents: AgentInfo[];
  workdirs: string[];
  onCancel: () => void;
  onSaved: () => void;
  onOpenThread: (id: string) => void;
  onError: (e: unknown) => void;
}

function ScheduleEditor({ api, schedule, agents, workdirs, onCancel, onSaved, onOpenThread, onError }: EditorProps) {
  const usable = useMemo(() => agents.filter((a) => a.available || a.id === schedule?.agent), [agents, schedule?.agent]);
  const [name, setName] = useState(schedule?.name ?? '');
  const [agent, setAgent] = useState(schedule?.agent ?? usable[0]?.id ?? '');
  const [cwd, setCwd] = useState(schedule?.cwd ?? workdirs[0] ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const shape = useMemo(() => presetFromCron(schedule?.cron ?? '0 9 * * *'), [schedule?.cron]);
  const [preset, setPreset] = useState<Preset>(shape.preset);
  const [time, setTime] = useState(shape.time);
  const [weekday, setWeekday] = useState(shape.weekday);
  const [day, setDay] = useState(shape.day);
  const [interval, setIntervalValue] = useState(shape.interval);
  const [customCron, setCustomCron] = useState(preset === 'custom' ? (schedule?.cron ?? '') : '');
  const [timezone, setTimezone] = useState(schedule?.timezone ?? '');
  const [tzError, setTzError] = useState(false);
  const [catchUp, setCatchUp] = useState(schedule?.catchUp ?? false);
  const [mode, setMode] = useState<'new' | 'same'>(schedule?.mode ?? 'new');
  const [boundThread, setBoundThread] = useState<PickThread | null>(null);
  const [permission, setPermission] = useState(schedule?.permissionMode ?? '');
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ cron: string; description: string; fires: string[] } | null>(null);

  const agentInfo = agents.find((a) => a.id === agent);
  const modes = agentInfo?.capabilities.permissionModes ?? [];
  const permissionValue = modes.includes(permission) ? permission : modes.length ? startingPermission(agentInfo!.capabilities) : '';

  // The cron the form stands for right now.
  const cron = useMemo(
    () => (preset === 'custom' ? customCron.trim() : (cronFromPreset(preset, { time, weekday, day, interval }) ?? '')),
    [preset, customCron, time, weekday, day, interval],
  );

  // A custom expression is explained while it is typed: what it means, when it fires next.
  useEffect(() => {
    if (preset !== 'custom' || !cron) {
      setPreview(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api
        .previewCron(cron, timezone.trim() || undefined)
        .then((p) => {
          if (!stale) setPreview({ cron, ...p });
        })
        .catch(() => {
          if (!stale) setPreview({ cron, description: '', fires: [] });
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [api, preset, cron, timezone]);

  // Run history and the threads one can bind, fetched while the editor is open.
  useEffect(() => {
    if (!schedule) return;
    api.scheduleRuns(schedule.id).then(setRuns).catch(() => setRuns([]));
  }, [api, schedule]);
  useEffect(() => {
    api
      .threads()
      .then((t) => setThreads(t.filter((x) => !x.archivedAt)))
      .catch(() => setThreads([]));
  }, [api]);

  // A bound thread carries its own agent and directory along.
  useEffect(() => {
    if (!schedule?.threadId || !threads) return;
    const found = threads.find((t) => t.id === schedule.threadId);
    if (found) setBoundThread({ id: found.id, title: found.title, agent: found.agent, cwd: found.cwd });
    // Bound threads that are gone or archived are not offered again; the problem line says so.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, schedule?.threadId]);

  const bound = boundThread && mode === 'same' ? boundThread : null;
  const effectiveCwd = bound ? bound.cwd : cwd;
  const dirOptions = useMemo(() => {
    const dirs = new Set<string>(workdirs);
    for (const t of threads ?? []) dirs.add(t.cwd);
    return [...dirs].slice(0, 12);
  }, [workdirs, threads]);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        agent: bound ? bound.agent : agent,
        cwd: effectiveCwd,
        prompt,
        cron,
        mode,
        threadId: bound ? bound.id : null,
        timezone: timezone.trim() || null,
        catchUp,
        ...(permissionValue ? { permissionMode: permissionValue } : {}),
      };
      if (schedule) await api.updateSchedule(schedule.id, body);
      else await api.createSchedule(body as Parameters<Api['createSchedule']>[0]);
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  const canSave = cron && prompt.trim() && (bound || (cwd.trim() && agent)) && !tzError && !saving;

  return (
    <DialogSurface labelledBy="sched-editor-title" onClose={onCancel} busy={saving} className="sched-editor">
      <div className="sched-dialog-head">
        <h3 id="sched-editor-title" className="dialog-title">
          {schedule ? '编辑任务' : '新建任务'}
        </h3>
        <button className="icon-btn" aria-label="取消" onClick={onCancel}>
          <IconClose />
        </button>
      </div>

      <div className="dialog-body sched-form">
        <label className="field">
          <span className="field-label">名称</span>
          <input value={name} placeholder="从提示词取" onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="field">
          <span className="field-label">Agent</span>
          <div className="chip-row" role="radiogroup" aria-label="选择 agent">
            {usable.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`chip${agent === a.id ? ' on' : ''}`}
                role="radio"
                aria-checked={agent === a.id}
                onClick={() => setAgent(a.id)}
              >
                {a.icon ? <AgentMark path={a.icon} size={14} /> : null}
                {a.label}
                {a.account ? <span className="chip-note">{a.account}</span> : null}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">{bound ? '目录（跟随绑定的线程）' : '工作目录'}</span>
          {bound ? (
            <p className="field-static" title={bound.cwd}>
              {folderName(bound.cwd)}
            </p>
          ) : (
            <div className="field-inline">
              <input value={cwd} spellCheck={false} onChange={(e) => setCwd(e.target.value)} aria-label="工作目录" />
              <Popover label="常用目录" triggerLabel="常用目录" trigger={<IconFolder size={14} />} triggerClassName="btn-secondary" triggerTitle="常用目录">
                {(close) => (
                  <ul className="pick-list">
                    {dirOptions.map((d) => (
                      <li key={d}>
                        <button
                          onClick={() => {
                            setCwd(d);
                            close();
                          }}
                          title={d}
                        >
                          {folderName(d)}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Popover>
            </div>
          )}
        </div>

        <div className="field">
          <span className="field-label">频率</span>
          <div className="chip-row" role="radiogroup" aria-label="频率">
            {(Object.keys(PRESET_LABELS) as Array<Exclude<Preset, 'custom'>>).map((p) => (
              <button key={p} type="button" className={`chip${preset === p ? ' on' : ''}`} role="radio" aria-checked={preset === p} onClick={() => setPreset(p)}>
                {PRESET_LABELS[p]}
              </button>
            ))}
            <button type="button" className={`chip${preset === 'custom' ? ' on' : ''}`} role="radio" aria-checked={preset === 'custom'} onClick={() => setPreset('custom')}>
              自定义
            </button>
          </div>
          {preset === 'minutes' && (
            <div className="field-inline">
              <span>每</span>
              <input className="num" value={interval} inputMode="numeric" onChange={(e) => setIntervalValue(e.target.value)} aria-label="间隔分钟数" />
              <span>分钟</span>
            </div>
          )}
          {preset !== 'minutes' && preset !== 'custom' && preset !== 'hourly' && (
            <div className="field-inline">
              <input className="num time" value={time} onChange={(e) => setTime(e.target.value)} placeholder="HH:MM" aria-label="运行时间" />
              <span>运行</span>
            </div>
          )}
          {preset === 'hourly' && (
            <div className="field-inline">
              <span>每小时的</span>
              <input className="num time" value={time} onChange={(e) => setTime(e.target.value)} placeholder="HH:MM" aria-label="运行时间" />
              <span>运行</span>
            </div>
          )}
          {preset === 'weekly' && (
            <div className="chip-row">
              {WEEKDAYS.map((label, d) => (
                <button key={label} type="button" className={`chip${weekday === d ? ' on' : ''}`} onClick={() => setWeekday(d)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {preset === 'monthly' && (
            <div className="field-inline">
              <span>每月</span>
              <input className="num" value={day} inputMode="numeric" onChange={(e) => setDay(e.target.value)} aria-label="几号" />
              <span>日</span>
            </div>
          )}
          {preset === 'custom' && (
            <>
              <input value={customCron} spellCheck={false} placeholder="分 时 日 月 周，如 30 9 * * 1-5" onChange={(e) => setCustomCron(e.target.value)} aria-label="cron 表达式" />
              {preview && preview.cron === cron && (
                <p className="field-hint">
                  {preview.description || '这个表达式不太常见'}
                  {preview.fires.length > 0 && ` · 之后：${preview.fires.slice(0, 3).map(whenLabel).join('、')}`}
                </p>
              )}
            </>
          )}
          {preset === 'hourly' && parseTime(time) === null && <p className="field-hint bad">时间写成 HH:MM，比如 09:30。</p>}
          {preset !== 'custom' && preset !== 'hourly' && preset !== 'minutes' && parseTime(time) === null && <p className="field-hint bad">时间写成 HH:MM，比如 09:30。</p>}
          <label className="dialog-option" style={{ marginTop: '12px', marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={catchUp}
              onChange={(e) => setCatchUp(e.target.checked)}
            />
            <span className="dialog-option-text">
              <span>停机错过后，启动时补跑一次</span>
            </span>
          </label>
        </div>

        <label className="field">
          <span className="field-label">时区</span>
          <input
            value={timezone}
            placeholder={`留空为服务器时区（当前系统：${Intl.DateTimeFormat().resolvedOptions().timeZone}）`}
            spellCheck={false}
            onChange={(e) => {
              setTimezone(e.target.value);
              if (tzError) setTzError(false);
            }}
            onBlur={() => {
              const val = timezone.trim();
              if (val) {
                try {
                  new Intl.DateTimeFormat('en-US', { timeZone: val });
                  setTzError(false);
                } catch {
                  setTzError(true);
                }
              } else {
                setTzError(false);
              }
            }}
            aria-label="时区"
          />
          {tzError && <p className="field-hint bad">时区格式无效，请输入有效的 IANA 时区名，如 Asia/Shanghai。</p>}
        </label>

        <div className="field">
          <span className="field-label">会话</span>
          <div className="chip-row" role="radiogroup" aria-label="执行模式">
            <button type="button" className={`chip${mode === 'new' ? ' on' : ''}`} role="radio" aria-checked={mode === 'new'} onClick={() => setMode('new')}>
              每次新会话
            </button>
            <button type="button" className={`chip${mode === 'same' ? ' on' : ''}`} role="radio" aria-checked={mode === 'same'} onClick={() => setMode('same')}>
              固定会话继续
            </button>
          </div>
          {mode === 'same' && (
            <div className="field-inline">
              {bound ? (
                <>
                  <span className="field-static" title={bound.cwd}>
                    {bound.title}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setBoundThread(null);
                    }}
                  >
                    解绑
                  </button>
                </>
              ) : (
                <>
                  <span className="field-hint">首次运行时自动新建</span>
                  <Popover label="选择会话" triggerLabel="选择已有会话" trigger={<IconPlus size={14} />} triggerClassName="btn-secondary" triggerTitle="选择一个已有会话继续">
                    {(close) => (
                      <ul className="pick-list">
                        {(threads ?? []).slice(0, 30).map((t) => (
                          <li key={t.id}>
                            <button
                              title={t.cwd}
                              onClick={() => {
                                setBoundThread({ id: t.id, title: t.title, agent: t.agent, cwd: t.cwd });
                                close();
                              }}
                            >
                              {t.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Popover>
                </>
              )}
            </div>
          )}
          {mode === 'same' && <p className="field-hint">固定会话里上下文会一直累积，适合周报、巡检日志这类。</p>}
        </div>

        <label className="field">
          <span className="field-label">提示词</span>
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && isCommit(e) && e.preventDefault()} placeholder="要它做什么。写「{{date}}」会替换成当天的日期。" />
        </label>

        {modes.length > 0 && (
          <div className="field">
            <span className="field-label">权限</span>
            <div className="chip-row" role="radiogroup" aria-label="权限">
              {PERMISSION_ORDER.filter((m) => modes.includes(m)).map((m) => (
                <button key={m} type="button" className={`chip${permissionValue === m ? ' on' : ''}`} role="radio" aria-checked={permissionValue === m} onClick={() => setPermission(m)}>
                  {PERMISSION_LABELS[m].short}
                </button>
              ))}
            </div>
            <p className="field-hint">
              {permissionValue === 'full_access'
                ? '任务在无人值守时运行，选了完全访问就不再有人把关。'
                : PERMISSION_LABELS[permissionValue]?.hint ?? ''}
            </p>
          </div>
        )}

        {schedule && (
          <div className="field">
            <span className="field-label">运行记录</span>
            {runs === null || runs.length === 0 ? (
              <p className="field-hint">{runs === null ? '读取中…' : '还没有运行过。'}</p>
            ) : (
              <ul className="sched-runs">
                {runs.slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <span className={`sched-dot ${STATUS_DOT[r.status]}`} aria-hidden="true" />
                    <span className="sched-run-status">{RUN_LABELS[r.status]}</span>
                    <span className="sched-run-time">{whenLabel(r.startedAt)}</span>
                    {r.message && <span className="sched-run-message" title={r.message}>{r.message}</span>}
                    {r.threadId && (
                      <button type="button" className="link" onClick={() => onOpenThread(r.threadId!)}>
                        查看会话
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
          {schedule ? '保存修改' : '创建任务'}
        </button>
      </div>
    </DialogSurface>
  );
}
