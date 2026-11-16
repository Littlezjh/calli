import type { Store } from './store.js';
import type { ThreadManager } from './threads.js';
import { transientError } from './proactive-advance.js';

/**
 * 临时错误自动重试：a turn that died of a transient provider failure — no capacity on the server,
 * a dropped connection, a rate limit — is resent by the daemon a few times with growing spacing,
 * so a busy server delays the work instead of stopping it. Always on, visible on the error card
 * and cancellable there; when the attempts run out the thread stays failed for the person, where
 * the proactive scan may still ask about it. Watches live in hub settings, so they survive
 * restarts, and every firing verifies its facts against the thread's own last turn first: whoever
 * moved the thread on — the person, a queue release, a handover — silently retires the watch.
 */
export interface RetryWatch {
  agent: string;
  /** The turn whose ask is being resent; follows the chain as each attempt fails anew. */
  failedTurn: string;
  /** Automatic resends already made for this chain of failures. */
  attempts: number;
  nextAt: string;
  createdAt: string;
}
export interface RetryView { attempts: number; max: number; nextAt: string }

const RETRIES_KEY = 'retry.watches';
/** Spacing between the automatic attempts: soon, then giving the server time to recover. */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** The whole chain gets this many automatic resends and no more than this long to get them. */
export const RETRY_MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 2 * 3600_000;
const envNumber = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export class AutoRetry {
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private checking = false;

  constructor(
    private readonly store: Store,
    private readonly manager: ThreadManager,
    private readonly tickMs: number = envNumber('CALLI_RETRY_TICK_MS', 15_000),
    private readonly backoffMs: number[] = RETRY_BACKOFF_MS,
    private readonly maxAttempts: number = RETRY_MAX_ATTEMPTS,
  ) {}

  /** The daemon owns the loop; tests drive `check()` directly instead. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check().catch(() => undefined), this.tickMs);
    this.timer.unref?.();
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private watches(): Record<string, RetryWatch> { return this.store.hubSetting(RETRIES_KEY, {}); }
  private save(watches: Record<string, RetryWatch>): void { this.store.saveHubSetting(RETRIES_KEY, watches); }

  view(id: string): RetryView | null {
    const w = this.watches()[id];
    return w ? { attempts: w.attempts, max: this.maxAttempts, nextAt: w.nextAt } : null;
  }

  drop(id: string): void {
    const watches = this.watches();
    if (!watches[id]) return;
    delete watches[id];
    this.save(watches);
    this.manager.notifyHandover(id);
  }

  /** Called where a turn settled on an error the classifier calls transient and nothing else took over. */
  parked(id: string, turnId: string): void {
    const thread = this.store.getThread(id);
    if (!thread || thread.archivedAt) return;
    const watches = this.watches();
    const existing = watches[id];
    // The chain counts its attempts across resends: each failed attempt lands here again with
    // the same watch, until the count or the age says the server is not coming back.
    const attempts = existing?.attempts ?? 0;
    const age = existing ? Date.now() - Date.parse(existing.createdAt) : 0;
    if (existing && (attempts >= this.maxAttempts || age > MAX_AGE_MS)) { this.drop(id); return; }
    watches[id] = {
      agent: thread.agent,
      failedTurn: turnId,
      attempts,
      nextAt: new Date(Date.now() + this.backoffMs[Math.min(attempts, this.backoffMs.length - 1)]).toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.save(watches);
    this.manager.notifyHandover(id);
  }

  /** One pass over due watches. The interval calls it; tests call it directly. */
  async check(): Promise<void> {
    if (this.closed || this.checking) return;
    const due = Object.entries(this.watches()).filter(([, w]) => Date.parse(w.nextAt) <= Date.now());
    if (!due.length) return;
    this.checking = true;
    try {
      for (const [id, watch] of due) {
        const thread = this.store.getThread(id);
        if (!thread || thread.archivedAt || !this.manager.hasAgent(watch.agent)) { this.drop(id); continue; }
        const view = this.manager.threadView(id);
        if (view.status === 'running') {
          // Our own resend at work: let it land — its failure re-arms the chain with the attempt
          // counted, its success retires the watch on the next pass. Anything else running means
          // the person or a queue moved the thread on; the retry is moot.
          const running = this.store.listTurns(id).at(-1)?.turnId ?? null;
          const started = running ? this.store.listTurnEvents(id, running).find(e => e.type === 'turn.started') : undefined;
          const source = started?.data.coordination as { retry?: unknown } | undefined;
          if (source && typeof source.retry === 'string' && source.retry === watch.failedTurn) this.postpone(id, Date.now() + 60_000);
          else this.drop(id);
          continue;
        }
        // An approval or a question waits on the person; come back once it cleared.
        if (view.waiting) { this.postpone(id, Date.now() + 15 * 60_000); continue; }
        // Truth is the thread's own last turn: still the same transient failure, still retriable.
        const last = this.store.listTurns(id).at(-1)?.turnId ?? null;
        const events = last ? this.store.listTurnEvents(id, last) : [];
        const start = events.find(e => e.type === 'turn.started');
        const failed = events.find(e => e.type === 'turn.error');
        const code = typeof failed?.data.code === 'string' ? failed.data.code : null;
        if (!start || !failed || !transientError(code, String(failed.data.message ?? ''))
          || start.data.handover || start.data.control || start.data.imported || start.data.fromTerminal) { this.drop(id); continue; }
        // Count this attempt and keep a safety next check before sending, so a daemon that dies
        // mid-turn leaves a watch that still fires rather than one stuck in the past.
        const watches = this.watches();
        const w = watches[id];
        if (!w) continue;
        w.attempts += 1;
        w.failedTurn = last!;
        w.nextAt = new Date(Date.now() + this.backoffMs[Math.min(w.attempts, this.backoffMs.length - 1)]).toISOString();
        this.save(watches);
        this.manager.recordTurnRetry(id, w.attempts, this.maxAttempts);
        try { await this.manager.retryAutoHandoverTurn(id, last!); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.drop(id);
          try { this.manager.notice(id, `自动重试没有发出去：${message.slice(0, 200)}`); } catch { /* the thread went away */ }
        }
      }
    } finally { this.checking = false; }
  }

  private postpone(id: string, at: number): void {
    const watches = this.watches();
    const w = watches[id];
    if (!w) return;
    const age = Date.now() - Date.parse(w.createdAt);
    if (age > MAX_AGE_MS) { this.drop(id); return; }
    w.nextAt = new Date(Math.max(at, Date.now() + 60_000)).toISOString();
    this.save(watches);
    this.manager.notifyHandover(id);
  }
}
