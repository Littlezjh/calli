import type { Store } from './store.js';
import type { ThreadManager } from './threads.js';
import type { PlanQuota, QuotaWindow } from './adapters/types.js';
import { HttpError } from './errors.js';

export interface HandoverTarget { agent: string; model?: string }
export interface HandoverSettings { enabled: boolean; threshold: number; orders: Record<string, HandoverTarget[]> }
export interface AutoHandoverView {
  enabled: boolean; source: 'thread' | 'collaboration' | 'global'; override: boolean | null;
  state?: 'checking' | 'preparing' | 'countdown' | 'stopped' | 'failed';
  target?: HandoverTarget; deadline?: string; reason?: 'near' | 'exhausted'; error?: string;
}
type Attempt = { turnId: string; cancelled: boolean; view: Partial<AutoHandoverView>; wake?: () => void };
type Block = HandoverTarget & { at: string; used?: number; resetsAt?: string };
const defaults = (): HandoverSettings => ({ enabled: false, threshold: 90, orders: {} });

/** An unknown scoped window cannot decide that a particular model is exhausted. */
export function modelWindows(quota: PlanQuota, model?: string | null): QuotaWindow[] {
  return quota.windows.filter(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
    && (!w.scope || !!model && w.modelIds?.includes(model)));
}
/** Unmapped pools can retire an instance, but cannot justify switching models within it. */
function instanceWindows(quota: PlanQuota, model?: string | null): QuotaWindow[] {
  return quota.windows.filter(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100
    && (!w.modelIds?.length || !model || w.modelIds.includes(model)));
}
export function freshQuota(quota: PlanQuota): boolean {
  const age = Date.now() - Date.parse(quota.checkedAt);
  return Number.isFinite(age) && age >= -5000 && age < 30_000;
}

/** Owns the between-turn reservation, independently of connected browsers. */
export class AutoHandover {
  private attempts = new Map<string, Attempt>();
  private notices = new Map<string, Partial<AutoHandoverView>>();
  private closed = false;
  constructor(private store: Store, private manager: ThreadManager, readonly delayMs = 5000) {}
  settings(): HandoverSettings { return this.store.hubSetting('handover.settings', defaults()); }
  configure(input: unknown): HandoverSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid handover settings');
    const v = input as HandoverSettings;
    if (typeof v.enabled !== 'boolean' || !Number.isFinite(v.threshold) || v.threshold < 1 || v.threshold > 99
      || !v.orders || typeof v.orders !== 'object' || Array.isArray(v.orders)) throw new HttpError(400, 'invalid handover settings');
    const orders: HandoverSettings['orders'] = {};
    for (const [id, targets] of Object.entries(v.orders)) {
      if (!this.manager.hasAgent(id) || !Array.isArray(targets) || targets.length > 50) throw new HttpError(400, 'invalid handover order');
      const seen = new Set<string>();
      orders[id] = targets.map(t => {
        if (!t || typeof t.agent !== 'string' || !this.manager.hasAgent(t.agent)
          || t.model !== undefined && (typeof t.model !== 'string' || !t.model || t.model.length > 200)) throw new HttpError(400, 'invalid handover target');
        const key = JSON.stringify([t.agent, t.model]);
        if (seen.has(key)) throw new HttpError(400, 'duplicate handover target');
        seen.add(key);
        return { agent: t.agent, ...(t.model ? { model: t.model } : {}) };
      });
    }
    const settings = { enabled: v.enabled, threshold: v.threshold, orders };
    this.store.saveHubSetting('handover.settings', settings);
    for (const id of this.attempts.keys()) if (!this.view(id).enabled) this.cancel(id);
    this.manager.notifyHandover();
    return settings;
  }
  view(id: string): AutoHandoverView {
    const overrides = this.store.hubSetting<Record<string, boolean>>('handover.threads', {});
    const override = overrides[id] ?? null;
    const team = this.manager.coordination?.autoHandover(id);
    return { enabled: override ?? team ?? this.settings().enabled,
      source: override !== null ? 'thread' : team !== undefined ? 'collaboration' : 'global', override,
      ...this.notices.get(id), ...this.attempts.get(id)?.view };
  }
  setOverride(id: string, enabled: unknown): AutoHandoverView {
    this.manager.getThread(id);
    if (enabled !== null && typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean or null');
    const overrides = this.store.hubSetting<Record<string, boolean>>('handover.threads', {});
    if (enabled === null) delete overrides[id]; else overrides[id] = enabled;
    this.store.saveHubSetting('handover.threads', overrides);
    if (!this.view(id).enabled) this.cancel(id);
    this.manager.notifyHandover(id);
    return this.view(id);
  }
  inherit(source: string, target: string): void {
    const overrides = this.store.hubSetting<Record<string, boolean>>('handover.threads', {});
    if (overrides[source] !== undefined) { overrides[target] = overrides[source]; this.store.saveHubSetting('handover.threads', overrides); }
  }
  queuePaused(id: string): boolean { return this.held(id) || ['stopped', 'failed'].includes(this.notices.get(id)?.state ?? ''); }
  held(id: string): boolean { return this.attempts.has(id); }
  reserve(id: string, turnId: string): void {
    if (!this.closed && this.view(id).enabled && !this.held(id)) {
      this.notices.delete(id);
      this.attempts.set(id, { turnId, cancelled: false, view: { state: 'checking' } });
    }
  }
  cancel(id: string): void {
    const attempt = this.attempts.get(id);
    if (attempt) {
      attempt.cancelled = true;
      if (attempt.view.state === 'preparing') void this.manager.cancelHandoverSummary(id);
      attempt.view = {}; attempt.wake?.();
    }
    this.notices.delete(id);
    this.manager.notifyHandover(id);
  }
  close(): void { this.closed = true; for (const id of this.attempts.keys()) this.cancel(id); }
  private blocked(): Block[] { return this.store.hubSetting('handover.blocks', []); }
  private block(t: HandoverTarget, quota: PlanQuota | null): void {
    const blocks = this.blocked().filter(b => b.agent !== t.agent || b.model !== t.model);
    const windows = quota ? instanceWindows(quota, t.model) : [];
    const limiting = windows.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0];
    blocks.push({ ...t, at: new Date().toISOString(), ...(limiting ? { used: limiting.usedPercent, resetsAt: limiting.resetsAt } : {}) });
    this.store.saveHubSetting('handover.blocks', blocks);
  }
  private recover(t: HandoverTarget, quota: PlanQuota): void {
    const windows = instanceWindows(quota, t.model);
    if (!windows.length || windows.some(w => w.usedPercent >= this.settings().threshold)) return;
    this.store.saveHubSetting('handover.blocks', this.blocked().filter(b => {
      if (b.agent !== t.agent || b.model && b.model !== t.model) return true;
      // A hard quota error outranks an unchanged, optimistically low quota reading.
      return b.used !== undefined && b.used < this.settings().threshold
        && Math.max(...windows.map(w => w.usedPercent)) >= b.used
        && (!b.resetsAt || Date.parse(b.resetsAt) > Date.now());
    }));
  }
  private isBlocked(t: HandoverTarget): boolean { return this.blocked().some(b => b.agent === t.agent && (!b.model || !t.model || b.model === t.model)); }
  private async quota(agent: string): Promise<PlanQuota | null> {
    try { const q = await this.manager.agentQuota(agent, true); return freshQuota(q) ? q : null; } catch { return null; }
  }
  async targets(id: string): Promise<HandoverTarget[]> {
    const thread = this.manager.getThread(id);
    const agents = await this.manager.listAgents();
    const kind = agents.find(a => a.id === thread.agent)?.adapter;
    const order = this.settings().orders[thread.agent] ?? agents.filter(a => a.id !== thread.agent)
      .sort((a, b) => Number(b.adapter === kind) - Number(a.adapter === kind)).map(a => ({ agent: a.id }));
    const model = await this.manager.handoverModel(thread.agent, thread.model);
    const out: HandoverTarget[] = [];
    for (const target of order) {
      const agent = agents.find(a => a.id === target.agent && a.available);
      if (!agent) continue;
      // An unattended handover must not broaden the source conversation's permissions.
      if (thread.permissionMode !== 'full_access' && !agent.capabilities.permissionModes.includes(thread.permissionMode as 'ask' | 'auto_edit')) continue;
      const targetModel = await this.manager.handoverModel(target.agent, target.model);
      if (target.model && !targetModel || target.agent === thread.agent && (!target.model || targetModel === model)) continue;
      const concrete = { agent: target.agent, ...(targetModel ? { model: targetModel } : {}) };
      const quota = await this.quota(target.agent);
      if (quota) this.recover(concrete, quota);
      if (this.isBlocked(concrete)) continue;
      const windows = quota ? instanceWindows(quota, targetModel) : [];
      // Switching within an instance needs positive evidence of an independent, healthy model pool.
      if (target.agent === thread.agent && (!quota || !model || !targetModel || !quota.windows.some(w => w.modelIds?.includes(model))
        || !quota.windows.some(w => w.modelIds?.includes(targetModel)))) continue;
      if (windows.some(w => w.usedPercent >= this.settings().threshold)) continue;
      out.push(target);
      break;
    }
    return out;
  }
  async settled(id: string, turnId: string): Promise<void> {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.turnId !== turnId) return;
    let transferred = false;
    let retry = false;
    try {
      const events = this.store.listTurnEvents(id, turnId);
      const start = events.find(e => e.type === 'turn.started');
      const end = events.find(e => e.type === 'turn.done' || e.type === 'turn.error');
      if (!start || start.data.handover || start.data.control || !end || end.data.stopReason === 'cancelled') return;
      if (this.manager.threadView(id).waiting || this.manager.getThread(id).status === 'running') return;
      const thread = this.manager.getThread(id);
      const model = await this.manager.handoverModel(thread.agent, thread.model);
      const source = { agent: thread.agent, ...(model ? { model } : {}) };
      const quota = await this.quota(thread.agent);
      if (quota) this.recover(source, quota);
      const episodeKey = JSON.stringify([id, model]);
      const episodes = this.store.hubSetting<Record<string, boolean>>('handover.episodes', {});
      if (!this.isBlocked(source) && episodes[episodeKey]) { delete episodes[episodeKey]; this.store.saveHubSetting('handover.episodes', episodes); }
      const exhausted = end.data.code === 'plan_exhausted';
      const near = quota && instanceWindows(quota, model).some(w => w.usedPercent >= this.settings().threshold);
      if (!exhausted && (!near || end.type !== 'turn.done')) return;
      if (episodes[episodeKey]) return;
      episodes[episodeKey] = true; this.store.saveHubSetting('handover.episodes', episodes);
      const mapped = quota?.windows.some(w => w.modelIds?.includes(model!));
      this.block(mapped ? source : { agent: thread.agent }, quota);
      if (attempt.cancelled || !this.view(id).enabled || this.closed) return;
      const target = (await this.targets(id))[0];
      if (!target) { this.notices.set(id, { state: 'stopped', reason: exhausted ? 'exhausted' : 'near' }); return; }
      attempt.view = { state: 'preparing', target, reason: exhausted ? 'exhausted' : 'near' };
      this.manager.notifyHandover(id);
      const switchModel = target.agent === thread.agent && !!target.model && this.manager.canSwitchHandoverModel(thread.agent);
      const summary = switchModel ? null : await this.manager.autoHandoverSummary(id, target.agent, exhausted);
      if (attempt.cancelled || !this.view(id).enabled || this.closed) return;
      attempt.view = { ...attempt.view, state: 'countdown', deadline: new Date(Date.now() + this.delayMs).toISOString() };
      this.manager.notifyHandover(id);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, this.delayMs);
        attempt.wake = () => { clearTimeout(timer); resolve(); };
      });
      if (attempt.cancelled || !this.view(id).enabled || this.closed || this.manager.threadView(id).waiting || this.manager.getThread(id).archivedAt) return;
      // Availability and quota may have changed while the summary was being written.
      if (!(await this.targets(id)).some(t => t.agent === target.agent && t.model === target.model)) {
        this.notices.set(id, { state: 'stopped', reason: attempt.view.reason }); return;
      }
      if (attempt.cancelled) return;
      if (switchModel) {
        await this.manager.updateThread(id, { model: target.model });
        this.manager.recordHandoverModel(id, target.model!, model, attempt.view.reason!);
        retry = exhausted;
      } else {
        await this.manager.executeAutoHandover(id, target, summary!, exhausted ? turnId : null);
        transferred = true;
      }
    } catch (error) {
      this.notices.set(id, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.attempts.delete(id);
      this.manager.coordination?.handoverSettled(id, transferred || retry);
      this.manager.notifyHandover(id);
    }
    if (retry) {
      try { await this.manager.retryAutoHandoverTurn(id, turnId); }
      catch (error) { this.notices.set(id, { state: 'failed', error: String(error) }); this.manager.notifyHandover(id); }
    }
  }
}
