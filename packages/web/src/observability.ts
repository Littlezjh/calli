import type { AgentInfo, ModelOption } from './api';
export interface UsageSample {
  id: string; scope: 'request' | 'turn' | 'update'; source: string; observedAt: string;
  input?: number; output?: number; total?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number;
  model?: string; provider?: string; account?: string; durationMs?: number; ttftMs?: number;
  cost?: { amount: number; currency: string; estimated: boolean }; error?: string;
}
export interface UsageReport {
  checkedAt: string; hours: number; totals: Record<string, number | null>;
  costs: Record<string, { amount: number; estimated: boolean }>;
  tpm: number | null; measuredSamples: number; sampleCount: number; turns: number; errors: number;
  rows: Array<{ threadId: string; turnId: string; title: string; agent: string; configuredModel: string | null;
    linkedAccount: string | null; startedAt: string; finishedAt: string | null; firstOutputMs: number | null;
    status: string; error: string | null; samples: UsageSample[] }>;
}
export interface AgentDiagnostic {
  agent: string; label: string; state: string; message: string; checkedAt: string;
  version?: string | null; protocol?: string | null; models: ModelOption[]; capabilities: AgentInfo['capabilities'];
}
export const numberLabel = (n: number | null | undefined): string => n == null ? '未知' : n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
export const durationLabel = (n: number | null | undefined): string => n == null ? '未知' : `${(n / 1000).toFixed(2)} 秒`;
