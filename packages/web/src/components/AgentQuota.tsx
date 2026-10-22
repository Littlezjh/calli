import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { Api, PlanQuota, QuotaWindow } from '../api';
import { formatDateTime, t } from '../i18n';
import { formatReset, quotaLevel } from '../quota';
import { IconClock, QuotaRing } from './icons';

type Reading = { api: Api; agent: string; quota: PlanQuota | null; loading: boolean; failed: boolean };

/** Space between chips and before the "+N" chip, in px. Matches the gap in styles.css. */
const CHIP_GAP = 10;

type Window = {
  key: string;
  /** Full period name, such as "5 hours" or "Weekly". */
  period: string;
  /** Period as short as it can be, for the one-line summary. */
  short: string;
  scope?: string;
  remaining: number;
  low: boolean;
  reset: string;
};

function periodNames(label: string): { period: string; short: string } {
  if (label === '7D') return { period: t('quota.weekly'), short: t('quota.weeklyShort') };
  const duration = /^(\d+)(H|D)$/.exec(label);
  if (!duration) return { period: label, short: label };
  const count = Number(duration[1]);
  return duration[2] === 'H'
    ? { period: t('quota.hours', count), short: t('quota.hoursShort', count) }
    : { period: t('quota.days', count), short: t('quota.daysShort', count) };
}

function windowsOf(quota: PlanQuota): Window[] {
  return quota.windows.map((w: QuotaWindow, index) => ({
    key: `${w.label}-${w.scope ?? ''}-${index}`,
    ...periodNames(w.label),
    scope: w.scope,
    remaining: Math.round(Math.max(0, Math.min(100, 100 - w.usedPercent)) * 10) / 10,
    low: quotaLevel(w.usedPercent) === 'danger',
    reset: formatReset(w),
  }));
}

/**
 * Which chips fit on one line: the most depleted windows first,
 * then the rest in order. Returns the chosen indexes in their original order.
 */
function pickVisible(windows: Window[], widths: number[], plusWidth: number, room: number): number[] {
  const order = [...windows.keys()].sort((a, b) =>
    windows[a].low && windows[b].low ? windows[a].remaining - windows[b].remaining || a - b
      : windows[a].low === windows[b].low ? a - b : windows[a].low ? -1 : 1);
  const chosen: number[] = [];
  let used = 0;
  for (const i of order) {
    const next = used + (chosen.length ? CHIP_GAP : 0) + widths[i];
    const rest = windows.length - chosen.length - 1;
    if (next + (rest > 0 ? CHIP_GAP + plusWidth : 0) > room) continue;
    chosen.push(i);
    used = next;
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * An account's quota inside the agent picker: one quiet line of rings, more on demand.
 * Mounted only inside an open picker. Each visible account shares the API's quota cache.
 * Sits beside the account's select button, never inside it, so opening details never picks the account.
 */
export function AgentQuota({ api, agent }: { api: Api; agent: string }) {
  const [reading, setReading] = useState<Reading>(() => ({ api, agent, quota: api.cachedAgentQuota(agent), loading: true, failed: false }));
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    let alive = true;
    setPinned(false);
    setPreview(false);
    const read = async () => {
      setReading({ api, agent, quota: api.cachedAgentQuota(agent), loading: true, failed: false });
      try {
        const quota = await api.agentQuota(agent);
        if (alive) setReading({ api, agent, quota, loading: false, failed: false });
      } catch {
        if (alive) setReading({ api, agent, quota: api.cachedAgentQuota(agent), loading: false, failed: true });
      }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, agent]);

  // A host switch must never show the previous host's account values, even for one render.
  const { quota, loading, failed } = reading.api === api && reading.agent === agent
    ? reading : { quota: api.cachedAgentQuota(agent), loading: true, failed: false };

  if (!quota?.windows.length) return <div className="agent-quota">
    <span className="agent-quota-note">{loading ? t('quota.loading') : failed ? t('quota.unavailable') : t('quota.none')}</span>
  </div>;

  const windows = windowsOf(quota);
  const stale = failed || Date.now() - Date.parse(quota.checkedAt) > 60_000;
  const updated = t('quota.updatedAt', formatDateTime(new Date(quota.checkedAt), {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }));
  const status = failed ? `${t('quota.cached')} · ${updated}` : loading ? `${t('quota.updating')} · ${updated}` : updated;
  return <QuotaView windows={windows} stale={stale} status={status}
    pinned={pinned} setPinned={setPinned} preview={preview} setPreview={setPreview} />;
}

function QuotaView({ windows, stale, status, pinned, setPinned, preview, setPreview }: {
  windows: Window[]; stale: boolean; status: string;
  pinned: boolean; setPinned: (v: boolean) => void; preview: boolean; setPreview: (v: boolean) => void;
}) {
  const detailsId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>();
  const [room, setRoom] = useState<number | null>(null);
  const [widths, setWidths] = useState<{ chips: number[]; plus: number } | null>(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);

  // Two periods of one name (a weekly window per model pool) need telling apart. The first pool
  // is the account's main one and stays unnamed; any later pool with a repeated period carries its name.
  const counts = new Map<string, number>();
  for (const w of windows) counts.set(w.short, (counts.get(w.short) ?? 0) + 1);
  const mainPool = windows[0]?.scope;
  const ambiguous = (w: Window) => (counts.get(w.short) ?? 0) > 1 && !!w.scope && w.scope !== mainPool;
  const signature = windows.map((w) => `${w.short}|${ambiguous(w) ? w.scope : ''}|${w.remaining}|${w.low}`).join(';');

  // Measure every chip once per content, off-screen, then fit whole chips into the line.
  useLayoutEffect(() => {
    const box = measureRef.current;
    if (!box) return;
    const nodes = [...box.children] as HTMLElement[];
    setWidths({ chips: nodes.slice(0, -1).map((n) => Math.ceil(n.getBoundingClientRect().width)), plus: Math.ceil(nodes[nodes.length - 1].getBoundingClientRect().width) });
  }, [signature]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // The summary's own side padding (2 × 6px) is not room for chips.
    const update = () => {
      const cs = getComputedStyle(el);
      setRoom(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 12);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visible = widths && room !== null
    ? pickVisible(windows, widths.chips, widths.plus, room - (stale ? 21 : 0))
    : windows.map((_, i) => i);
  const hidden = windows.length - visible.length;

  const label = [
    ...windows.map((w) => [w.period, w.scope, t('quota.remaining', w.remaining)].filter(Boolean).join(' ')),
    stale ? t('quota.cachedReading') : '',
    t('quota.showDetails'),
  ].filter(Boolean).join(' · ');

  const chip = (w: Window) => <span key={w.key} className={`agent-quota-chip${w.low ? ' low' : ''}`}>
    <QuotaRing remaining={w.remaining} size={14} />
    <span className="agent-quota-label">{w.short}</span>
    {ambiguous(w) && <span className="agent-quota-scope">{w.scope}</span>}
    <span className="agent-quota-percent">{w.remaining}%</span>
  </span>;

  return <div className={`agent-quota${stale ? ' stale' : ''}`} ref={rootRef}
    onPointerEnter={() => clearTimeout(previewTimer.current)}
    onPointerLeave={(e) => {
      if (e.pointerType === 'mouse') previewTimer.current = setTimeout(() => setPreview(false), 150);
    }}
    onKeyDown={(e) => {
      // Escape folds the details first; the picker closes on the next one.
      if (e.key === 'Escape' && (pinned || preview)) { e.stopPropagation(); setPinned(false); setPreview(false); }
    }}>
    <span className="agent-quota-measure" ref={measureRef} aria-hidden="true">
      {windows.map(chip)}
      <span className="agent-quota-more">+{windows.length}</span>
    </span>
    <button ref={summaryRef} type="button" className="agent-quota-summary"
      aria-expanded={pinned} aria-controls={pinned ? detailsId : undefined} aria-label={label}
      aria-describedby={preview && !pinned ? `${detailsId}-preview` : undefined}
      onClick={() => { setPinned(!pinned); setPreview(false); }}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse' && !pinned) setPreview(true); }}
      onFocus={(e) => { if (!pinned && e.currentTarget.matches(':focus-visible')) setPreview(true); }}
      onBlur={() => setPreview(false)}>
      {visible.map((i) => chip(windows[i]))}
      {hidden > 0 && <span className={`agent-quota-more${windows.some((w, i) => w.low && !visible.includes(i)) ? ' low' : ''}`}>+{hidden}</span>}
      {stale && <span className="agent-quota-stale"><IconClock size={11} /></span>}
    </button>
    {pinned && <QuotaDetails id={detailsId} windows={windows} status={status} />}
    {preview && !pinned && <QuotaPreview id={`${detailsId}-preview`} anchor={summaryRef}><QuotaDetails windows={windows} status={status} /></QuotaPreview>}
  </div>;
}

/** Every window with its pool, what is left and when it resets, then how fresh the reading is. */
function QuotaDetails({ id, windows, status }: { id?: string; windows: Window[]; status: string }) {
  const pools = [...new Set(windows.map((w) => w.scope ?? ''))];
  return <div className="agent-quota-details" id={id}>
    {pools.map((pool) => <div className="agent-quota-pool" key={pool}>
      {pool && <div className="agent-quota-pool-name">{pool}</div>}
      {windows.filter((w) => (w.scope ?? '') === pool).map((w) => <div key={w.key} className={`agent-quota-row${w.low ? ' low' : ''}`}
        role="meter" aria-label={[w.period, w.scope].filter(Boolean).join(' · ')}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.remaining} aria-valuetext={t('quota.remaining', w.remaining)}>
        <QuotaRing remaining={w.remaining} size={14} />
        <span className="agent-quota-period">{w.period}</span>
        <span className="agent-quota-left">{t('quota.remaining', w.remaining)}</span>
        <span className="agent-quota-reset">{w.reset}</span>
      </div>)}
    </div>)}
    <div className="agent-quota-status">{status}</div>
  </div>;
}

/**
 * The details as a card that floats beside the picker while the pointer or keyboard focus rests
 * on the summary. A short leave delay lets the pointer cross the gap to read or scroll the card.
 */
function QuotaPreview({ id, anchor, children }: { id: string; anchor: RefObject<HTMLElement>; children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const at = anchor.current, card = cardRef.current;
    if (!at || !card) return;
    const position = () => {
      const a = at.getBoundingClientRect();
      const panel = at.closest('.pop-panel')?.getBoundingClientRect() ?? a;
      const w = card.offsetWidth, h = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, edge = 8;
      const clampY = (y: number) => Math.max(edge, Math.min(y, vh - h - edge));
      const clampX = (x: number) => Math.max(edge, Math.min(x, vw - w - edge));
      if (panel.right + 8 + w <= vw - edge) setStyle({ left: panel.right + 8, top: clampY(a.top - 10) });
      else if (panel.left - 8 - w >= edge) setStyle({ left: panel.left - 8 - w, top: clampY(a.top - 10) });
      else setStyle({ left: clampX(a.left - 8), top: a.bottom + 6 + h <= vh - edge ? a.bottom + 6 : clampY(a.top - 6 - h) });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(card);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [anchor]);
  return <div className="agent-quota-preview" id={id} role="tooltip" ref={cardRef} style={style}>{children}</div>;
}
