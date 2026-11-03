import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Api, ThreadStats } from '../api';
import { Popover } from './Popover';
import { IconChevronRight, IconDatabase, IconGauge } from './icons';
import { t } from '../i18n';

/** 61843450 → 61.8M, 61322 → 61K, 820 → 820: token counts that fit a pill. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(value));
}

/** 6.5% → 6.5%, 99.48% → 99.5%: one decimal is enough to read a share. */
const percentLabel = (value: number): string => `${(Math.floor(value * 1000) / 10).toFixed(1)}%`;

/** 1407594 ms → 23 分 28 秒, in the shared duration wording. */
export function durationMsLabel(msValue: number): string {
  const secs = msValue / 1000;
  if (secs < 60) return t('duration.seconds', secs < 10 ? secs.toFixed(1) : String(Math.round(secs)));
  const minutes = Math.floor(secs / 60);
  if (minutes < 60) return t('duration.minutes', minutes, Math.round(secs % 60));
  return t('duration.hours', Math.floor(minutes / 60), minutes % 60, Math.round(secs % 60));
}

const speedLabel = (tokPerSec: number, approx: boolean): string => {
  const n = tokPerSec >= 10 ? String(Math.round(tokPerSec)) : tokPerSec.toFixed(1);
  return approx ? t('trace.approxTps', n) : t('trace.tps', n);
};

/**
 * The thread's session statistics. Read once when the thread opens, then at most every three
 * seconds while a turn is running, so the readings keep up with live turns without hammering
 * the daemon. Errors leave the readings out; the trace and the usage pages still explain.
 */
export function useThreadStats(api: Api, threadId: string | null, active: boolean): ThreadStats | null {
  const [stats, setStats] = useState<ThreadStats | null>(null);
  const runningRef = useRef(false);
  useEffect(() => {
    if (!threadId) return;
    let stale = false;
    runningRef.current = false;
    const read = () =>
      api.stats(threadId).then(
        (value) => { if (!stale) { runningRef.current = value.running; setStats(value); } },
        () => { if (!stale) setStats(null); },
      );
    void read();
    // A running turn keeps moving; follow it, but never faster than one read every three seconds.
    const timer = window.setInterval(() => {
      if (!document.hidden && (active || runningRef.current)) void read();
    }, 3000);
    return () => { stale = true; window.clearInterval(timer); };
  }, [api, threadId, active]);
  return stats;
}

/** A pill like the context ring's button: quiet until hovered, numbers in tabular figures. */
function StatPill({ label, icon, face, panel }: { label: string; icon: ReactNode; face: ReactNode; panel: ReactNode }) {
  return (
    <Popover label={label} triggerLabel={label} triggerClassName="stat" align="end" placement="below" trigger={<>{icon}<span>{face}</span></>}>
      {() => panel}
    </Popover>
  );
}

function StatHead({ icon, title, value }: { icon: ReactNode; title: string; value: ReactNode }) {
  return (
    <div className="pop-head-row">
      <span className="pop-title-inline">{icon}{title}</span>
      <span className="pop-value">{value}</span>
    </div>
  );
}

/** 12 轮 · 86 步 / 51 362 118 / 约 74 tok/s: the numbers a reading opens onto. */
function SessionStatsPanel({ stats, onOpenTrace }: { stats: ThreadStats; onOpenTrace?: () => void }) {
  if (!stats.timing) return null;
  const approx = stats.timing.source === 'hub';
  return (
    <>
      <StatHead icon={<IconGauge size={15} />} title={t('stats.session')} value={t('stats.turnsSteps', stats.turns, stats.steps)} />
      <dl className="pop-rows">
        <div><dt>{t('stats.modelTime')}</dt><dd>{durationMsLabel(stats.timing.modelMs)}</dd></div>
        <div><dt>{t('stats.toolTime')}</dt><dd>{durationMsLabel(stats.timing.toolMs)}</dd></div>
        {stats.timing.avgWaitMs != null && <div><dt>{t('stats.avgWait')}</dt><dd>{approx ? '≈ ' : ''}{durationMsLabel(stats.timing.avgWaitMs)}</dd></div>}
        {stats.tokPerSec != null && <div><dt>{t('stats.speed')}</dt><dd>{speedLabel(stats.tokPerSec, stats.tokPerSecApprox)}</dd></div>}
      </dl>
      {approx && <div className="pop-foot">{t('stats.approxNote')}</div>}
      {onOpenTrace && <div className="pop-rule" />}
      {onOpenTrace && (
        <button type="button" className="pop-item" onClick={onOpenTrace}>
          <IconGauge size={16} />
          <span className="pop-item-label">{t('stats.viewTrace')}</span>
          <IconChevronRight size={15} />
        </button>
      )}
    </>
  );
}

function TokenStatsPanel({ stats }: { stats: ThreadStats }) {
  const tokens = stats.tokens;
  if (!tokens) return null;
  const hit = tokens.input ? (tokens.cacheRead != null ? tokens.cacheRead / tokens.input : null) : null;
  const total = tokens.input != null ? tokens.input + (tokens.output ?? 0) : null;
  const n = (value: number | null | undefined) => (value != null ? value.toLocaleString('en-US') : null);
  return (
    <>
      <StatHead icon={<IconDatabase size={15} />} title={t('stats.tokens')} value={n(total)} />
      <dl className="pop-rows">
        {hit != null && <div><dt>{t('stats.hit')}</dt><dd>{percentLabel(hit)}</dd></div>}
        {tokens.input != null && tokens.cacheRead != null && tokens.cacheWrite != null
          && <div><dt>{t('stats.uncached')}</dt><dd>{n(tokens.input - tokens.cacheRead - tokens.cacheWrite)}</dd></div>}
        {tokens.cacheRead != null && <div><dt>{t('stats.cacheRead')}</dt><dd>{n(tokens.cacheRead)}</dd></div>}
        {tokens.cacheWrite != null && <div><dt>{t('stats.cacheWrite')}</dt><dd>{n(tokens.cacheWrite)}</dd></div>}
        {tokens.output != null && (
          <div>
            <dt>{t('stats.output')}</dt>
            <dd>{n(tokens.output)}{tokens.reasoning ? <span className="pop-sub">{t('stats.inclReasoning', n(tokens.reasoning)!)}</span> : null}
            </dd>
          </div>
        )}
      </dl>
      {tokens.turnsWithout > 0 && <div className="pop-foot">{t('stats.turnsWithout', tokens.turnsWithout)}</div>}
    </>
  );
}

/**
 * The two top-bar readings: session statistics and token usage, each opening its detail. Hidden
 * until something has been measured — a brand-new thread shows no readings, unknown fields are
 * left out rather than drawn as zero. Kept out of a phone's top bar by the caller.
 */
export function StatReadings({ api, threadId, active, onOpenTrace }: {
  api: Api;
  threadId: string;
  active: boolean;
  /** Opens the thread's trace panel; absent inside the trace panel itself, where this is already there. */
  onOpenTrace?: () => void;
}) {
  const stats = useThreadStats(api, threadId, active);
  if (!stats || (stats.timing === null && stats.tokens === null)) return null;
  const session = stats.timing ? <SessionStatsPanel stats={stats} onOpenTrace={onOpenTrace} /> : null;
  const tokens = stats.tokens ? <TokenStatsPanel stats={stats} /> : null;
  const tps = stats.tokPerSec != null ? speedLabel(stats.tokPerSec, stats.tokPerSecApprox) : null;
  const hit = stats.tokens?.input ? (stats.tokens.cacheRead != null ? percentLabel(stats.tokens.cacheRead / stats.tokens.input) : null) : null;
  const total = stats.tokens?.input != null ? compactTokens(stats.tokens.input + (stats.tokens.output ?? 0)) : null;
  return (
    <div className="stats-top" data-testid="session-stats">
      {stats.timing && (
        <StatPill
          label={t('stats.session')}
          icon={<IconGauge size={15} />}
          face={<>{t('stats.turnsShort', stats.turns)}<span className="stat-dot"> · </span>{tps}</>}
          panel={session}
        />
      )}
      {stats.tokens && total != null && (
        <StatPill
          label={t('stats.tokens')}
          icon={<IconDatabase size={15} />}
          face={<>{total} tok{hit ? <><span className="stat-dot"> · </span>{t('stats.hitShort')} {hit}</> : null}</>}
          panel={tokens}
        />
      )}
    </div>
  );
}
