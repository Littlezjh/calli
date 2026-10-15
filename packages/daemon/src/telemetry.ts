import type { DatabaseSync } from 'node:sqlite';
import type { StoredEvent } from './events.js';

/** Never infer billable tokens from context size, character counts, or a historical replay. */
export interface UsageSample {
  id: string;
  scope: 'request' | 'turn' | 'update';
  source: string;
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  model?: string;
  provider?: string;
  account?: string;
  durationMs?: number;
  ttftMs?: number;
  cost?: { amount: number; currency: string; estimated: boolean };
  error?: string;
}

export function cleanSample(data: Record<string, unknown>): UsageSample | null {
  if (typeof data.id !== 'string' || !data.id || !['request', 'turn', 'update'].includes(String(data.scope))) return null;
  const out: UsageSample = { id: data.id.slice(0, 200), scope: data.scope as UsageSample['scope'], source: String(data.source ?? 'native').slice(0, 80) };
  for (const key of ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'reasoning', 'durationMs', 'ttftMs'] as const) {
    const n = data[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  for (const key of ['model', 'provider', 'account', 'error'] as const) {
    if (typeof data[key] === 'string') out[key] = data[key].slice(0, key === 'error' ? 500 : 200);
  }
  const cost = data.cost as UsageSample['cost'];
  if (cost && typeof cost.amount === 'number' && Number.isFinite(cost.amount) && cost.amount >= 0 && /^[A-Z]{3}$/.test(cost.currency)) {
    out.cost = { amount: cost.amount, currency: cost.currency, estimated: cost.estimated === true };
  }
  return out;
}

export class Telemetry {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_turns (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        agent TEXT NOT NULL, configured_model TEXT, linked_account TEXT,
        first_output_ms REAL, status TEXT NOT NULL, error TEXT,
        PRIMARY KEY(thread_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS telemetry_samples (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, sample_id TEXT NOT NULL,
        ts TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(thread_id, turn_id, sample_id),
        FOREIGN KEY(thread_id, turn_id) REFERENCES telemetry_turns(thread_id, turn_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS telemetry_time ON telemetry_turns(started_at);
      CREATE INDEX IF NOT EXISTS telemetry_sample_time ON telemetry_samples(ts);
    `);
  }

  observe(event: StoredEvent): void {
    const { threadId, turnId, ts, type, data } = event;
    if (!turnId || data.imported || data.fromTerminal) return;
    if (type === 'turn.started') {
      this.db.prepare(`INSERT OR IGNORE INTO telemetry_turns(thread_id,turn_id,started_at,agent,configured_model,linked_account,status)
        SELECT id,?,?,agent,model,?,'running' FROM threads WHERE id=?`).run(turnId, ts, typeof data.linkedAccount === 'string' ? data.linkedAccount : null, threadId);
    } else if ((type === 'message.delta' || type === 'reasoning.delta') && typeof data.text === 'string' && data.text.length) {
      this.db.prepare(`UPDATE telemetry_turns SET first_output_ms=MAX(0,(julianday(?) - julianday(started_at))*86400000)
        WHERE thread_id=? AND turn_id=? AND first_output_ms IS NULL`).run(ts, threadId, turnId);
    } else if (type === 'turn.done' || type === 'turn.error') {
      this.db.prepare('UPDATE telemetry_turns SET finished_at=?,status=?,error=? WHERE thread_id=? AND turn_id=?')
        .run(ts, type === 'turn.error' ? 'error' : data.stopReason === 'cancelled' ? 'cancelled' : 'done',
          type === 'turn.error' ? String(data.message ?? '执行失败').slice(0, 500) : null, threadId, turnId);
    } else if (type === 'usage.sample') {
      const sample = cleanSample(data);
      if (!sample) return;
      this.db.prepare(`INSERT OR IGNORE INTO telemetry_samples(thread_id,turn_id,sample_id,ts,data)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM telemetry_turns WHERE thread_id=? AND turn_id=?)`)
        .run(threadId, turnId, sample.id, ts, JSON.stringify(sample), threadId, turnId);
    }
  }

  read(hours = 24, agent = '', now = Date.now()) {
    const since = new Date(now - hours * 3600000).toISOString();
    const until = new Date(now).toISOString();
    const minute = new Date(now - 60000).toISOString();
    const turns = this.db.prepare(`SELECT t.*,h.title FROM telemetry_turns t JOIN threads h ON h.id=t.thread_id
      WHERE t.started_at>=? AND t.started_at<=? AND (?='' OR t.agent=?) ORDER BY t.started_at DESC LIMIT 100`)
      .all(since, until, agent, agent) as any[];
    const samples = this.db.prepare(`SELECT s.*,t.agent FROM telemetry_samples s JOIN telemetry_turns t USING(thread_id,turn_id)
      WHERE s.ts>=? AND s.ts<=? AND (?='' OR t.agent=?) ORDER BY s.ts DESC`)
      .all(since, until, agent, agent) as any[];
    const totals: Record<string, number | null> = { input: null, output: null, total: null, cacheRead: null, cacheWrite: null, reasoning: null };
    const costs: Record<string, { amount: number; estimated: boolean }> = {};
    let tpm = 0, measured = 0;
    for (const row of samples) {
      const sample = JSON.parse(row.data) as UsageSample;
      for (const key of Object.keys(totals)) {
        const value = sample[key as keyof UsageSample];
        if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
      }
      if (sample.total !== undefined) { measured++; if (row.ts > minute) tpm += sample.total; }
      if (sample.cost) {
        const previous = costs[sample.cost.currency] ?? { amount: 0, estimated: false };
        costs[sample.cost.currency] = { amount: previous.amount + sample.cost.amount, estimated: previous.estimated || sample.cost.estimated };
      }
    }
    const counts = this.db.prepare(`SELECT COUNT(*) AS turns,SUM(status='error') AS errors FROM telemetry_turns
      WHERE started_at>=? AND started_at<=? AND (?='' OR agent=?)`).get(since, until, agent, agent) as { turns: number; errors: number | null };
    const rows = turns.map(row => ({
      threadId: row.thread_id as string, turnId: row.turn_id as string, title: row.title as string, agent: row.agent as string,
      configuredModel: row.configured_model as string | null, linkedAccount: row.linked_account as string | null,
      startedAt: row.started_at as string, finishedAt: row.finished_at as string | null,
      firstOutputMs: row.first_output_ms as number | null, status: row.status as string, error: row.error as string | null,
      samples: samples.filter(s => s.thread_id === row.thread_id && s.turn_id === row.turn_id).map(s => ({ ...JSON.parse(s.data) as UsageSample, observedAt: s.ts as string })),
    }));
    return { checkedAt: until, hours, totals, costs, tpm: measured ? tpm : null, measuredSamples: measured,
      sampleCount: samples.length, turns: counts.turns, errors: counts.errors ?? 0, rows };
  }
}
