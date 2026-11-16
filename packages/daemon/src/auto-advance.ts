import type { Store } from './store.js';
import type { ThreadManager } from './threads.js';
import { HttpError } from './errors.js';

/**
 * 会话自动推进：a turn that ended with the agent saying where the work stands — `[进度] 等外部`
 * (waiting on CI, a deployment, another session) or `[进度] 进行中` (work remains) — arms the hub
 * to move the thread on by itself: a wakeup after the stated minutes asking it to check, doubling
 * each further wait, or a plain 「继续」 once the thread has been stable for a minute. Chains are
 * bounded (6 wakeups, 3 continues); past the bound the thread becomes the person's again. Watches
 * live in hub settings so they survive restarts, and every firing re-verifies its facts against
 * the thread's own last turn first: whoever moved the thread on — the person, a handover, an
 * archive — silently retires the watch. The switch defaults off; a thread can override it.
 */
export interface AdvanceWatch {
  agent: string;
  /** The turn whose report backs the watch; follows the chain as each wake lands. */
  turnId: string;
  reason: 'wait' | 'continue';
  /** Wake messages already sent in this chain. */
  attempts: number;
  /** For a wait: the minutes the next wait would use, doubled on each re-wait of the chain. */
  minutes?: number;
  /** What the agent said it waits for, for the wakeup's own words. */
  what?: string;
  nextAt: string;
  /** Set when the chain spent its attempts: nothing more is sent, the thread is the person's. */
  exhausted?: boolean;
  createdAt: string;
}
export interface AdvanceView { reason: 'wait' | 'continue'; attempts: number; max: number; nextAt: string | null; what?: string }
export interface AdvanceSettings { enabled: boolean }
export interface AdvanceState { enabled: boolean; source: 'thread' | 'global'; override: boolean | null }

const WATCHES_KEY = 'advance.watches';
const SETTINGS_KEY = 'advance.settings';
const OVERRIDES_KEY = 'advance.threads';
/** A wait chain wakes at most this many times; a continue chain sends at most this many 「继续」. */
export const WAIT_MAX_ATTEMPTS = 6;
export const CONTINUE_MAX_ATTEMPTS = 3;
/** The minutes an `等外部` note is clamped to: no polling bursts, no forgotten days. */
export const WAIT_MIN_MINUTES = 2;
export const WAIT_MAX_MINUTES = 240;
export const DEFAULT_WAIT_MINUTES = 10;
/** Each further wait in a chain doubles the interval, never past this. */
export const WAIT_INTERVAL_CAP_MINUTES = 60;
/** A chain older than this is stale even if its facts never changed. */
const MAX_AGE_MS = 24 * 3600_000;
/** After a wakeup is sent, when to look again if its turn never settles here (a crash, say). */
const WAKE_FALLBACK_MINUTES = 15;
const envNumber = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** The wake a wait chain sends: check what you said you were waiting for, then go on or say how long. */
export const waitWake = (what: string) => `你上一轮说在等：${what}。现在去确认一下：好了就接着做；还没好就说明还要多久。`;
/** What a continue chain sends, exactly the word the person would type. */
export const CONTINUE_TEXT = '继续';

export class AutoAdvance {
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private checking = false;

  constructor(
    private readonly store: Store,
    private readonly manager: ThreadManager,
    /** One reported minute, in ms — tests shrink it instead of waiting them out. */
    private readonly minuteMs: number = envNumber('CALLI_ADVANCE_MINUTE_MS', 60_000),
    /** How long a thread reporting 进行中 must stay quiet before 「继续」 goes out. */
    private readonly continueMs: number = envNumber('CALLI_ADVANCE_CONTINUE_MS', 60_000),
    private readonly tickMs: number = envNumber('CALLI_ADVANCE_TICK_MS', 15_000),
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

  private watches(): Record<string, AdvanceWatch> { return this.store.hubSetting(WATCHES_KEY, {}); }
  private save(watches: Record<string, AdvanceWatch>): void { this.store.saveHubSetting(WATCHES_KEY, watches); }

  settings(): AdvanceSettings { return { enabled: this.store.hubSetting<Partial<AdvanceSettings>>(SETTINGS_KEY, { enabled: false }).enabled === true }; }

  configure(input: unknown): AdvanceSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as AdvanceSettings).enabled !== 'boolean')
      throw new HttpError(400, 'invalid advance settings');
    const settings = { enabled: (input as AdvanceSettings).enabled };
    this.store.saveHubSetting(SETTINGS_KEY, settings);
    if (!settings.enabled) this.save({});
    this.manager.notifyHandover();
    return settings;
  }

  state(id: string): AdvanceState {
    const overrides = this.store.hubSetting<Record<string, boolean>>(OVERRIDES_KEY, {});
    const override = overrides[id] ?? null;
    return { enabled: override ?? this.settings().enabled, source: override !== null ? 'thread' : 'global', override };
  }

  setOverride(id: string, enabled: unknown): AdvanceState {
    this.manager.getThread(id);
    if (enabled !== null && typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean or null');
    const overrides = this.store.hubSetting<Record<string, boolean>>(OVERRIDES_KEY, {});
    if (enabled === null) delete overrides[id]; else overrides[id] = enabled;
    this.store.saveHubSetting(OVERRIDES_KEY, overrides);
    if (!this.state(id).enabled) this.drop(id);
    this.manager.notifyHandover(id);
    return this.state(id);
  }

  view(id: string): AdvanceView | null {
    const w = this.watches()[id];
    if (!w) return null;
    return { reason: w.reason, attempts: w.attempts, max: w.reason === 'wait' ? WAIT_MAX_ATTEMPTS : CONTINUE_MAX_ATTEMPTS,
      nextAt: w.exhausted ? null : w.nextAt, ...(w.what !== undefined ? { what: w.what } : {}) };
  }

  /** The person's cancel of the line under the last turn; arming itself is automatic only. */
  drop(id: string): void {
    const watches = this.watches();
    if (!watches[id]) return;
    delete watches[id];
    this.save(watches);
    this.manager.notifyHandover(id);
  }

  /**
   * A thread no watch may sit on: the assistant's own conversation, a collaboration's (the lead
   * runs it and member results wake it), or one the proactive machinery opened for itself.
   */
  private eligible(id: string): boolean {
    if (this.manager.personal.router.status().threadId === id) return false;
    if (this.manager.coordination?.metadata(id)) return false;
    return !this.manager.personal.proactive.runs().some(run => run.kind !== 'advance' && run.threadId === id);
  }

  /**
   * Called where a turn settled. The thread's own report decides: 等外部 arms (or continues) a wait
   * chain, 进行中 a continue chain, anything else — or no report from this very turn — retires the
   * watch: the person, a handover or a cancelled turn moved the thread on.
   */
  settled(id: string, turnId: string): void {
    const watches = this.watches();
    const existing = watches[id];
    const retire = () => { if (existing) { delete watches[id]; this.save(watches); this.manager.notifyHandover(id); } };
    const thread = this.store.getThread(id);
    if (!thread || thread.archivedAt || this.closed) { retire(); return; }
    const events = this.store.listTurnEvents(id, turnId);
    const start = events.find(e => e.type === 'turn.started');
    const end = events.find(e => e.type === 'turn.done');
    // Only a plain turn the agent finished counts. Not an import, the terminal, a background
    // question, a control, a handover's own summary — and never one the person stopped.
    if (!start || !end || end.data.stopReason === 'cancelled'
      || start.data.imported || start.data.fromTerminal || start.data.background || start.data.control || start.data.handover) { retire(); return; }
    if (!this.eligible(id) || !this.state(id).enabled) { retire(); return; }
    const view = this.manager.threadView(id);
    // Still busy — a native takeover kept it running, or something waits on the person or behind
    // the turn — is not a thread the hub should move on by itself.
    if (view.status === 'running' || view.waiting || view.queued.length) { retire(); return; }
    // The report must be this turn's own word; a stale one from before it retires the watch.
    const report = thread.report;
    if (!report || report.by === 'user' || report.at < start.ts || report.stage !== 'doing') { retire(); return; }
    // A wakeup this hub sent continues its chain; anything else — the person, a queue release —
    // ends the old chain, and the qualifying report arms a fresh one in its place.
    const reason: AdvanceWatch['reason'] = report.wait ? 'wait' : 'continue';
    const chain = existing && typeof (start.data.coordination as { advance?: unknown } | undefined)?.advance === 'string' && existing.reason === reason ? existing : null;
    if (existing && !chain) { delete watches[id]; this.manager.notifyHandover(id); }
    const max = reason === 'wait' ? WAIT_MAX_ATTEMPTS : CONTINUE_MAX_ATTEMPTS;
    const watch: AdvanceWatch = chain ?? {
      agent: thread.agent, turnId, reason, attempts: 0, nextAt: new Date().toISOString(), createdAt: new Date().toISOString(),
      ...(report.wait ? { what: report.wait.what } : {}),
    };
    if (Date.now() - Date.parse(watch.createdAt) > MAX_AGE_MS) { retire(); return; }
    if (watch.attempts >= max) {
      // The chain spent its wakeups: nothing more is sent, and the thread shows as the person's.
      watches[id] = { ...watch, turnId, exhausted: true, nextAt: new Date(Date.now() + MAX_AGE_MS).toISOString() };
      this.save(watches);
      this.manager.notifyHandover(id);
      return;
    }
    if (report.wait) {
      // A fresh estimate the agent just gave wins; without one the chain doubles, capped at an hour.
      const base = report.wait.minutes ?? (chain ? Math.min((chain.minutes ?? DEFAULT_WAIT_MINUTES) * 2, WAIT_INTERVAL_CAP_MINUTES) : DEFAULT_WAIT_MINUTES);
      watch.minutes = Math.max(WAIT_MIN_MINUTES, Math.min(WAIT_MAX_MINUTES, base));
      watch.what = report.wait.what;
      watch.nextAt = new Date(Date.now() + watch.minutes * this.minuteMs).toISOString();
    } else {
      watch.nextAt = new Date(Date.now() + this.continueMs).toISOString();
    }
    watch.turnId = turnId;
    delete watch.exhausted;
    watches[id] = watch;
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
      for (const [id] of due) {
        const watches = this.watches();
        const w = watches[id];
        if (!w) continue;
        // A chain that spent its attempts is swept once its last timestamp passes.
        if (w.exhausted) { this.drop(id); continue; }
        const thread = this.store.getThread(id);
        if (!thread || thread.archivedAt || !this.manager.hasAgent(w.agent) || !this.state(id).enabled
          || Date.now() - Date.parse(w.createdAt) > MAX_AGE_MS) { this.drop(id); continue; }
        const view = this.manager.threadView(id);
        if (view.status === 'running') {
          // Our own wakeup at work: let it land — its settle re-arms or retires the watch. Anything
          // else running means the person or a queue moved the thread on; the advance is moot.
          const running = this.store.listTurns(id).at(-1)?.turnId ?? null;
          const started = running ? this.store.listTurnEvents(id, running).find(e => e.type === 'turn.started') : undefined;
          if (typeof (started?.data.coordination as { advance?: unknown } | undefined)?.advance === 'string') this.postpone(id);
          else this.drop(id);
          continue;
        }
        // An approval or a question waits on the person; so does anything queued behind the turn.
        if (view.waiting || view.queued.length) { this.drop(id); continue; }
        // Truth is the thread's own last turn: still the one whose report armed the watch, and
        // still saying what the watch is about.
        const last = this.store.listTurns(id).at(-1)?.turnId ?? null;
        const start = last === w.turnId ? this.store.listTurnEvents(id, w.turnId).find(e => e.type === 'turn.started') : undefined;
        const report = thread.report;
        if (last !== w.turnId || !start || !report || report.by === 'user' || report.at < start.ts
          || report.stage !== 'doing' || Boolean(report.wait) !== (w.reason === 'wait')) { this.drop(id); continue; }
        const max = w.reason === 'wait' ? WAIT_MAX_ATTEMPTS : CONTINUE_MAX_ATTEMPTS;
        if (w.attempts >= max) {
          // A settle that never ran (a crash between wake and landing) can leave a spent chain here.
          watches[id] = { ...w, exhausted: true, nextAt: new Date(Date.now() + MAX_AGE_MS).toISOString() };
          this.save(watches);
          this.manager.notifyHandover(id);
          continue;
        }
        // Count this attempt and keep a safety next check before sending, so a daemon that dies
        // mid-turn leaves a watch that still fires rather than one stuck in the past.
        const previous = w.turnId;
        w.attempts += 1;
        w.nextAt = new Date(Date.now() + (w.reason === 'wait'
          ? Math.min(w.minutes ?? DEFAULT_WAIT_MINUTES, WAIT_INTERVAL_CAP_MINUTES) * this.minuteMs
          : WAKE_FALLBACK_MINUTES * this.minuteMs)).toISOString();
        this.save(watches);
        try {
          const turnId = await this.manager.sendAdvanceWake(id, w.reason === 'wait' ? waitWake(w.what ?? '') : CONTINUE_TEXT, previous);
          // A wake that ended before this line ran has already settled the watch (re-armed or
          // retired it); writing the copy from before the send would bring back a stale one.
          const now = this.watches();
          if (now[id]?.turnId === previous) { now[id] = { ...now[id], turnId }; this.save(now); }
        } catch (error) {
          this.drop(id);
          const message = error instanceof Error ? error.message : String(error);
          try { this.manager.notice(id, `自动推进没有发出去：${message.slice(0, 200)}`); } catch { /* the thread went away */ }
        }
      }
    } finally { this.checking = false; }
  }

  private postpone(id: string): void {
    const watches = this.watches();
    const w = watches[id];
    if (!w) return;
    w.nextAt = new Date(Date.now() + 60_000).toISOString();
    this.save(watches);
    this.manager.notifyHandover(id);
  }
}
