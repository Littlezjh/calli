import type { AgentInfo, ModelOption } from './api';
import { formatNumber, t } from './i18n';
export interface UsageSample {
  id: string; scope: 'request' | 'turn' | 'update'; source: string; observedAt: string;
  input?: number; output?: number; total?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number;
  model?: string; provider?: string; account?: string; durationMs?: number; ttftMs?: number;
  startedAt?: string; endedAt?: string; timing?: 'estimated';
  cost?: { amount: number; currency: string; estimated: boolean }; error?: string;
}
export interface UsageReport {
  checkedAt: string; hours: number; totals: Record<string, number | null>;
  costs: Record<string, { amount: number; estimated: boolean }>;
  costSummary?: CostSummary;
  outputTpm?: number | null; outputMeasuredSamples?: number; tpm: number | null; measuredSamples: number; sampleCount: number; turns: number; errors: number;
  /** Missing from daemons that predate the TPM chart. */
  series?: UsageSeries;
  rows: Array<{ threadId: string; turnId: string; title: string; agent: string; configuredModel: string | null;
    linkedAccount: string | null; startedAt: string; finishedAt: string | null; firstOutputMs: number | null;
    status: string; error: string | null; samples: UsageSample[] }>;
}
export interface CostRange { amount: number; maxAmount: number }
export type CostReason = 'missing_model' | 'unknown_price' | 'missing_tokens' | 'invalid_usage';
export type CostAssumption = 'configured_model' | 'cache_split' | 'cache_ttl' | 'context_tier' | 'model_alias' | 'time_tier' | 'family_fallback';
export interface PriceRates { input: number; output: number; cacheRead: number; cacheWrite?: number; cacheWriteMax?: number }
export interface CostSummary {
  totals: Record<string, CostRange>; reported: Record<string, CostRange>; estimated: Record<string, CostRange>;
  estimatedSamples: number; familySamples: number; reportedSamples: number; unpricedSamples: number; unmeasuredTurns: number;
  priceCheckedAt: string; stale: boolean;
}
export interface CostReport extends CostSummary {
  groups: Array<CostRange & { model: string | null; alias?: string; reason?: CostReason; samples: number; currency?: string; assumptions: CostAssumption[];
    price?: { model: string; currency: string; source: string; rates: PriceRates; peakRates?: PriceRates; longContext?: { above: number; rates: PriceRates } } }>;
}
/** Average TPM per clock-aligned bucket, oldest first; `agents` holds the same buckets per instance that reported usage. */
export interface UsageSeries { stepMinutes: number; estimated?: boolean; points: Array<{ at: string; tpm: number; outputTpm?: number | null }>; agents?: Array<{ agent: string; tpm: number[] | null; outputTpm?: number[] | null }> }
export interface ChartLine { id: string; label: string; color: string; dash?: string; tpm: number[] }

/** Stable colours and dash patterns keep every instance selectable, even beyond four instances. */
export function chartLines(series: UsageSeries, agents: Array<Pick<AgentInfo, 'id' | 'label'>>, metric: 'total' | 'output' = 'total'): ChartLine[] {
  const lines: ChartLine[] = [{ id: 'total', label: t('obs.total'), color: 'var(--chart-total)', tpm: series.points.map(p => (metric === 'output' ? p.outputTpm : p.tpm) ?? 0) }];
  const instances = series.agents ?? [];
  const ordered = [...agents.map(a => a.id), ...instances.map(a => a.agent).filter(id => !agents.some(a => a.id === id)).sort()];
  for (const row of instances) {
    const values = metric === 'output' ? row.outputTpm : row.tpm;
    if (!values) continue;
    const place = ordered.indexOf(row.agent);
    lines.push({ id: `agent:${row.agent}`, label: agents.find(a => a.id === row.agent)?.label ?? row.agent,
      color: `var(--chart-${place % 4 + 1})`, dash: ['', '7 3', '2 3', '8 3 2 3'][Math.floor(place / 4) % 4], tpm: values });
  }
  return lines;
}
export interface AgentDiagnostic {
  agent: string; label: string; state: string; message: string; checkedAt: string;
  version?: string | null; protocol?: string | null; models: ModelOption[]; capabilities: AgentInfo['capabilities'];
}
export const numberLabel = (n: number | null | undefined): string => n == null ? t('common.unknown') : formatNumber(n, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
/** Token counts the way rate limits are quoted (906K, 1.03M): exact digits stay in numberLabel. */
export const compactLabel = (n: number | null | undefined): string => n == null ? t('common.unknown') : compact.format(n);
export const durationLabel = (n: number | null | undefined): string => n == null ? t('common.unknown') : t('obs.seconds', (n / 1000).toFixed(2));

const pad = (n: number) => String(n).padStart(2, '0');
export const clockLabel = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const dayLabel = (d: Date): string => `${d.getMonth() + 1}/${d.getDate()}`;
/** The time span a chart point covers: "10/15 14:20–14:30". */
export function bucketLabel(at: string, stepMinutes: number): string {
  const start = new Date(at);
  const head = `${dayLabel(start)} ${clockLabel(start)}`;
  return stepMinutes > 1 ? `${head}–${clockLabel(new Date(start.getTime() + stepMinutes * 60000))}` : head;
}
export const stepLabel = (minutes: number): string =>
  minutes === 1 ? t('obs.step.minute') : minutes === 60 ? t('obs.step.hour') : minutes % 60 ? t('obs.step.minutes', minutes) : t('obs.step.hours', minutes / 60);

/** Y-axis ticks from zero that end on a round number: steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(peak: number, count = 3): number[] {
  const raw = Math.max(peak, 1) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw)!);
  return Array.from({ length: Math.ceil(Math.max(peak, 1) / step) + 1 }, (_, i) => i * step);
}

const TICK_MINUTES = [1, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880];
/** Points that land on round local times, spaced so that at most `fit` labels show. */
export function timeTicks(series: UsageSeries, fit: number): { every: number; indexes: number[] } {
  const local = series.points.map(p => {
    const d = new Date(p.at);
    return { minute: d.getHours() * 60 + d.getMinutes(), day: Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000) };
  });
  for (const every of TICK_MINUTES) {
    if (every < series.stepMinutes) continue;
    const indexes = local.flatMap((t, i) => (every < 1440 ? t.minute % every === 0 : t.minute === 0 && t.day % (every / 1440) === 0) ? [i] : []);
    if (indexes.length <= fit) return { every, indexes };
  }
  return { every: 0, indexes: [] };
}
