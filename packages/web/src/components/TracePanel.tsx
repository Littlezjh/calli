import { useEffect, useMemo, useState } from 'react';
import type { AgentInfo, Api, SystemPrompt, TraceStep, TraceStepKind, TurnTrace } from '../api';
import { PanelDialog } from './Dialog';
import { IconArrowLeft, IconArrowRight, IconCheck, IconCopy, IconExternal, IconSearch } from './icons';
import { formatDateTime, formatList, formatNumber, t } from '../i18n';

interface Props {
  api: Api;
  agents: AgentInfo[];
  threadId: string;
  turnId?: string;
  onOpenThread: (id: string) => void;
  onClose: () => void;
}

type Filter = 'all' | 'system' | TraceStepKind;

const KIND_LABELS: Record<TraceStepKind | 'system', string> = {
  system: t('trace.kind.system'),
  user: t('trace.kind.user'),
  thinking: t('trace.kind.thinking'),
  assistant: t('trace.kind.assistant'),
  tool: t('trace.kind.tool'),
  request: t('trace.kind.request'),
  context: t('trace.kind.context'),
  error: t('trace.kind.error'),
};

/** The chips, in the order a turn happens. Context and errors show under "all" only: they are rare. */
const FILTERS: Filter[] = ['all', 'system', 'user', 'thinking', 'assistant', 'tool', 'request'];

const STATUS_LABELS: Record<TurnTrace['status'], string> = { running: t('status.running'), done: t('step.done'), cancelled: t('team.stopped'), error: t('status.error') };

const ms = (a: string, b: string): number => new Date(b).getTime() - new Date(a).getTime();

/** 850ms, 4.2s, 3m 05s — a duration read at a glance. */
function durationLabel(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return minutes < 60 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** 1.2K, 34K, 1.1M: token counts in the space of a chip. */
function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

const clock = (ts: string): string => {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return formatDateTime(date, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};

/** What a step's folded line says: a tool's title, a request's model, a text's first words. */
function summaryOf(step: TraceStep): string {
  if (step.kind === 'tool') return step.title && step.title !== step.tool ? step.title : step.input?.replace(/\s+/g, ' ') ?? '';
  if (step.kind === 'request') {
    const used = step.tokens ?? {};
    const parts = [step.model ?? t('obs.scope.request')];
    if (used.input !== undefined) parts.push(t('trace.input', tokens(used.input)));
    if (used.output !== undefined) parts.push(t('trace.output', tokens(used.output)));
    if (used.cacheRead) parts.push(t('trace.cache', tokens(used.cacheRead)));
    return parts.join(' · ');
  }
  return (step.text ?? '').replace(/\s+/g, ' ').trim();
}

/** A tool's name as people say it: `mcp__github__create_issue` is github's create_issue. */
function toolName(step: TraceStep): string {
  const name = step.tool ?? t('trace.kind.tool');
  if (step.server && name.startsWith('mcp__')) return `${step.server} · ${name.split('__').slice(2).join('__')}`;
  if (step.server) return `${step.server} · ${name}`;
  return name;
}

function matches(step: TraceStep, query: string): boolean {
  if (!query) return true;
  return [step.text, step.tool, step.title, step.input, step.output, step.model, step.server].some((v) => v?.toLowerCase().includes(query));
}

/**
 * One turn, step by step, the way a tracing tool shows a run: what it ran with and how long it
 * took up top, then every step in order — the system prompt, the ask, the thinking, each tool call
 * and model request, the answer — each folded to one line and opened to read in full. Filtered by
 * kind and searched within; stepped to the turn before or after without closing.
 */
export function TracePanel({ api, agents, threadId, turnId: initialTurn, onOpenThread, onClose }: Props) {
  const [turnId, setTurnId] = useState(initialTurn);
  const [trace, setTrace] = useState<TurnTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // Keys of steps opened by hand; the ask is open from the start, it is what the page is about.
  const [open, setOpen] = useState<Set<string>>(new Set(['1']));
  const [system, setSystem] = useState<{ prompt?: SystemPrompt; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const running = trace?.status === 'running';
  useEffect(() => {
    let stale = false;
    const read = () =>
      api.trace(threadId, turnId).then(
        (value) => {
          if (stale) return;
          setTrace(value);
          setError(null);
        },
        (e) => !stale && setError(e instanceof Error ? e.message : String(e)),
      );
    void read();
    // A running turn keeps growing; read it again while the panel is open on it.
    const timer = running ? window.setInterval(() => !document.hidden && void read(), 3000) : undefined;
    return () => {
      stale = true;
      if (timer) window.clearInterval(timer);
    };
  }, [api, threadId, turnId, running]);

  // A new turn starts folded again, its ask open.
  useEffect(() => {
    setOpen(new Set(['1']));
  }, [turnId]);

  const agent = agents.find((a) => a.id === trace?.agent);
  const canReadSystem = Boolean(agent?.capabilities.systemPrompt);

  const toggle = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (key === 'system' && !system) {
      setSystem({});
      api.systemPrompt(threadId).then(
        (prompt) => setSystem({ prompt }),
        (e) => setSystem({ error: e instanceof Error ? e.message : String(e) }),
      );
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: (trace?.steps.length ?? 0) + (canReadSystem ? 1 : 0), system: canReadSystem ? 1 : 0 };
    for (const s of trace?.steps ?? []) c[s.kind] = (c[s.kind] ?? 0) + 1;
    return c;
  }, [trace, canReadSystem]);

  const q = query.trim().toLowerCase();
  const showSystem = canReadSystem && (filter === 'all' || filter === 'system') && (!q || Boolean(system?.prompt?.text.toLowerCase().includes(q)));
  const steps = (trace?.steps ?? [])
    .map((step, i) => ({ step, key: String(i + 1) }))
    .filter(({ step }) => (filter === 'all' || step.kind === filter) && matches(step, q));

  const at = trace ? trace.turns.findIndex((t) => t.turnId === trace.turnId) : -1;
  const go = (offset: number) => {
    const next = trace?.turns[at + offset];
    if (next) setTurnId(next.turnId);
  };

  const copySystem = async () => {
    if (!system?.prompt) return;
    try {
      await navigator.clipboard.writeText(system.prompt.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Not a secure context: the text stays selectable.
    }
  };

  const duration = trace ? ms(trace.startedAt, trace.endedAt ?? new Date().toISOString()) : 0;

  return (
    <PanelDialog title={t('trace.title')} className="trace-panel" onClose={onClose}>
      {error && !trace && <p className="trace-empty" role="alert">{error}</p>}
      {!error && !trace && <p className="trace-empty">{t('activity.reading')}</p>}
      {trace && (
        <div className="trace-body">
          <div className="trace-head">
            <div className="trace-title-row">
              <button type="button" className="trace-thread" onClick={() => onOpenThread(trace.threadId)} title={t('trace.openThread')}>
                <span>{trace.title}</span>
                <IconExternal size={13} />
              </button>
              <span className={`trace-status ${trace.status}`}>{STATUS_LABELS[trace.status]}</span>
              <div className="trace-nav" role="group" aria-label={t('trace.switchTurn')}>
                <button type="button" className="icon-btn" aria-label={t('trace.prev')} disabled={at <= 0} onClick={() => go(-1)}>
                  <IconArrowLeft size={15} />
                </button>
                <span className="trace-nav-pos">
                  {t('trace.position', at + 1, trace.turns.length)}
                </span>
                <button type="button" className="icon-btn" aria-label={t('trace.next')} disabled={at < 0 || at >= trace.turns.length - 1} onClick={() => go(1)}>
                  <IconArrowRight size={15} />
                </button>
              </div>
            </div>
            <dl className="trace-meta">
              <div>
                <dt>Agent</dt>
                <dd>{agent?.label ?? trace.agent}</dd>
              </div>
              <div>
                <dt>{t('statusPanel.model')}</dt>
                <dd>{formatList(trace.models) || t('obs.nativeDefault')}</dd>
              </div>
              <div>
                <dt>{t('trace.started')}</dt>
                <dd>{clock(trace.startedAt)}</dd>
              </div>
              <div>
                <dt>{t('trace.duration')}</dt>
                <dd>{durationLabel(duration)}{running ? ` · ${t('trace.inProgress')}` : ''}</dd>
              </div>
              <div>
                <dt>{t('trace.kind.tool')}</dt>
                <dd>
                  {t('trace.times', trace.totals.tools)}{trace.totals.mcp ? ` · MCP ${trace.totals.mcp}` : ''}
                </dd>
              </div>
              <div>
                <dt>{t('obs.scope.request')}</dt>
                <dd>
                  {trace.totals.requests ? `${t('trace.times', trace.totals.requests)} · ${t('trace.input', tokens(trace.totals.input))} · ${t('trace.output', tokens(trace.totals.output))}` : t('obs.notReported')}
                </dd>
              </div>
              <div className="wide">
                <dt>{t('statusPanel.directory')}</dt>
                <dd title={trace.cwd}>{trace.cwd}</dd>
              </div>
            </dl>
          </div>
          {/* Pinned while the steps scroll under it, so the filters are always at hand. */}
          <div className="trace-tools">
              <div className="trace-filters" role="group" aria-label={t('trace.filter')}>
                {FILTERS.filter((f) => f === 'all' || counts[f]).map((f) => (
                  <button key={f} type="button" className={`trace-filter${filter === f ? ' active' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {f !== 'all' && <span className={`trace-dot ${f}`} />}
                    {f === 'all' ? t('trace.all') : KIND_LABELS[f]}
                    <span className="trace-filter-count">{counts[f] ?? 0}</span>
                  </button>
                ))}
              </div>
              <label className="trace-search">
                <IconSearch size={14} />
                <input type="search" value={query} placeholder={t('trace.search')} aria-label={t('trace.search')} onChange={(e) => setQuery(e.target.value)} />
              </label>
          </div>

          <ol className="trace-steps">
            {showSystem && (
              <li className={`trace-step system${open.has('system') ? ' open' : ''}`}>
                <button type="button" className="trace-step-head" aria-expanded={open.has('system')} onClick={() => toggle('system')}>
                  <span className="trace-dot system" />
                  <span className="trace-kind">{t('trace.kind.system')}</span>
                  <span className="trace-summary">{system?.prompt ? t('trace.systemSummary', formatNumber(system.prompt.text.length), system.prompt.source) : t('trace.systemHint')}</span>
                </button>
                {open.has('system') && (
                  <div className="trace-step-body">
                    {system?.error ? (
                      <p className="trace-note error">{system.error}</p>
                    ) : !system?.prompt ? (
                      <p className="trace-note">{t('activity.reading')}</p>
                    ) : (
                      <>
                        <button type="button" className="trace-copy" onClick={copySystem}>
                          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                          {copied ? t('common.copied') : t('activity.copyAll')}
                        </button>
                        <pre className="trace-text">{system.prompt.text}</pre>
                      </>
                    )}
                  </div>
                )}
              </li>
            )}
            {steps.map(({ step, key }) => {
              const isOpen = open.has(key) || (q !== '' && step.kind !== 'request');
              const took = step.endTs ? ms(step.ts, step.endTs) : NaN;
              const failed = step.kind === 'tool' && (step.status === 'failed' || step.status === 'error');
              const expandable = step.kind !== 'request';
              const head = (
                <>
                  <span className={`trace-dot ${step.kind}`} />
                  <span className="trace-kind">{KIND_LABELS[step.kind]}</span>
                  {step.kind === 'tool' && <span className={`trace-tool${step.server ? ' mcp' : ''}`}>{toolName(step)}</span>}
                  <span className="trace-summary">{summaryOf(step)}</span>
                  <span className="trace-time">
                    +{durationLabel(Math.max(0, ms(trace.startedAt, step.ts)))}
                    {took >= 100 && step.kind !== 'user' ? <em>{durationLabel(took)}</em> : null}
                  </span>
                </>
              );
              return (
                <li key={key} className={`trace-step ${step.kind}${isOpen ? ' open' : ''}${failed ? ' failed' : ''}`}>
                  {/* A request has nothing more to show than its line; it is a row, not a button. */}
                  {expandable ? (
                    <button type="button" className="trace-step-head" aria-expanded={isOpen} onClick={() => toggle(key)}>
                      {head}
                    </button>
                  ) : (
                    <div className="trace-step-head">{head}</div>
                  )}
                  {isOpen && expandable && (
                    <div className="trace-step-body">
                      {step.kind === 'tool' ? (
                        <>
                          {step.input && (
                            <>
                              <p className="trace-label">{t('obs.input')}</p>
                              <pre className="trace-text code">{step.input}</pre>
                            </>
                          )}
                          <p className="trace-label">
                            {t('obs.output')}{step.status ? ` · ${step.status === 'completed' ? t('step.done') : failed ? t('team.failed') : step.status}` : ''}
                          </p>
                          {step.output ? <pre className="trace-text code">{step.output}</pre> : <p className="trace-note">{step.endTs ? t('trace.noOutput') : t('trace.stillRunning')}</p>}
                        </>
                      ) : (
                        <pre className="trace-text">{step.text}</pre>
                      )}
                      {step.cut && <p className="trace-note">{t('trace.cut')}</p>}
                    </div>
                  )}
                </li>
              );
            })}
            {steps.length === 0 && !showSystem && <li className="trace-empty">{q ? t('trace.noMatch') : t('trace.noSteps')}</li>}
          </ol>
        </div>
      )}
    </PanelDialog>
  );
}
