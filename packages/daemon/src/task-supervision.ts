import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { StoredEvent } from './events.js';
import { HttpError } from './errors.js';
import type { PersonalService } from './personal.js';
import { personalText } from './personal.js';
import type { PushKind, PushRecord, PushService } from './push.js';
import type { EvidenceRef, Store, TaskValidation, TodoRecord } from './store.js';
import type { ThreadManager } from './threads.js';
import { repoKeyForCwd } from './task-ledger.js';
import { isWithinWorkdirs } from './workdirs.js';

export interface SuperagentSettings {
  /** Whether cross-turn autonomous supervision actions are enabled. Default false (recommended A). */
  enabled: boolean;
  /** Whether user-started and dispatched sessions are auto-captured into the ledger. Default true (recommended A). */
  ledgerCapture: boolean;
  /** Fixed merge window in ms for consolidated decision/review pushes. Default 15000 (recommended A). */
  notifyMergeMs: number;
  /** Deterministic fallback timeout in ms if the assistant fails to triage a real pending request. Default 60000. */
  fallbackTimeoutMs: number;
}

export const DEFAULT_SUPERAGENT_SETTINGS: SuperagentSettings = {
  enabled: false,
  ledgerCapture: true,
  notifyMergeMs: 15_000,
  fallbackTimeoutMs: 60_000,
};

export type SuperviseAction =
  | 'grant'
  | 'revoke'
  | 'continue'
  | 'retry'
  | 'switch_model'
  | 'split'
  | 'answer'
  | 'verify'
  | 'reject_evidence';

export interface TaskGrant {
  matterId: string;
  origin: EvidenceRef;
  scopeHash: string;
  repos: string[];
  actions: Array<'continue' | 'retry' | 'switch_model' | 'split' | 'answer'>;
  modelPolicy: 'keep' | 'configured_fallback';
  fixedModel: string | null;
  grantedAt: string;
  revokedAt: string | null;
}

export interface RecoveryRecord {
  matterId: string;
  incidentId: string;
  grantOrigin: EvidenceRef;
  threadId: string;
  sourceTurnId: string;
  action: 'retry' | 'continue' | 'switch_model' | 'split' | 'answer' | 'reject_evidence' | 'wait';
  state: 'planned' | 'started' | 'settled' | 'cancelled';
  result: 'resolved' | 'unresolved' | 'unknown' | null;
  targetThreadId: string | null;
  notifiedKey: string | null;
  updatedAt: string;
}

export interface DecisionNoticeItem {
  key: string;
  matterId: string;
  title: string;
  kind: 'needs_user' | 'review';
  detail: string;
  recommendation?: string;
  threadId?: string | null;
}

const SETTINGS_KEY = 'superagent.settings';
const GRANTS_KEY = 'superagent.grants';
const RECOVERIES_KEY = 'superagent.recoveries';
const NOTIFIED_KEY = 'superagent.notifiedKeys';
const DEFAULT_GRANT_ACTIONS: TaskGrant['actions'] = ['continue', 'retry', 'switch_model', 'split', 'answer'];

/** Computes a scope hash anchored on user-established goal, explicit acceptance, and fixed constraints. */
export function scopeHashOf(
  todo: Pick<TodoRecord, 'text' | 'acceptance'>,
  options: { repos?: string[]; modelPolicy?: TaskGrant['modelPolicy']; fixedModel?: string | null } = {},
): string {
  const explicitAcceptance = todo.acceptance && !todo.acceptance.inferred ? todo.acceptance.text.trim() : null;
  const payload = {
    text: todo.text.trim(),
    acceptance: explicitAcceptance,
    repos: [...(options.repos ?? [])].sort(),
    modelPolicy: options.modelPolicy ?? 'configured_fallback',
    fixedModel: options.fixedModel ?? null,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/**
 * Persistent task grants, bounded recovery ("推到底"), evidence verification,
 * scoped native confirmation answering, and fixed-window notification merging.
 */
export class TaskSupervision {
  private push: PushService | null = null;
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingNotices: DecisionNoticeItem[] = [];
  private readonly fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly manager: ThreadManager,
    private readonly personal: PersonalService,
  ) {}

  attachPush(push: PushService): void {
    this.push = push;
  }

  dispose(): void {
    this.closed = true;
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    this.mergeTimer = null;
    for (const timer of this.fallbackTimers.values()) clearTimeout(timer);
    this.fallbackTimers.clear();
    this.pendingNotices = [];
  }

  settings(): SuperagentSettings {
    const stored = this.store.hubSetting<Partial<SuperagentSettings>>(SETTINGS_KEY, {});
    return {
      enabled: stored.enabled === true,
      ledgerCapture: stored.ledgerCapture !== false,
      notifyMergeMs: typeof stored.notifyMergeMs === 'number' && Number.isFinite(stored.notifyMergeMs) ? stored.notifyMergeMs : DEFAULT_SUPERAGENT_SETTINGS.notifyMergeMs,
      fallbackTimeoutMs: typeof stored.fallbackTimeoutMs === 'number' && Number.isFinite(stored.fallbackTimeoutMs) ? stored.fallbackTimeoutMs : DEFAULT_SUPERAGENT_SETTINGS.fallbackTimeoutMs,
    };
  }

  saveSettings(input: Record<string, unknown>): SuperagentSettings {
    const next = { ...this.settings() };
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'superagent.enabled must be a boolean');
      next.enabled = input.enabled;
    }
    if (input.ledgerCapture !== undefined) {
      if (typeof input.ledgerCapture !== 'boolean') throw new HttpError(400, 'superagent.ledgerCapture must be a boolean');
      next.ledgerCapture = input.ledgerCapture;
    }
    if (input.notifyMergeMs !== undefined) {
      const ms = Number(input.notifyMergeMs);
      if (!Number.isInteger(ms) || ms < 0 || ms > 300_000) throw new HttpError(400, 'superagent.notifyMergeMs must be an integer between 0 and 300000');
      next.notifyMergeMs = ms;
    }
    if (input.fallbackTimeoutMs !== undefined) {
      const ms = Number(input.fallbackTimeoutMs);
      if (!Number.isInteger(ms) || ms < 1000 || ms > 300_000) throw new HttpError(400, 'superagent.fallbackTimeoutMs must be an integer between 1000 and 300000');
      next.fallbackTimeoutMs = ms;
    }
    this.store.saveHubSetting(SETTINGS_KEY, next);
    return next;
  }

  scopeHash(todo: TodoRecord): string {
    const existing = this.grants()[todo.id];
    return scopeHashOf(todo, existing ? { repos: existing.repos, modelPolicy: existing.modelPolicy, fixedModel: existing.fixedModel } : {});
  }

  private grants(): Record<string, TaskGrant> {
    return this.store.hubSetting<Record<string, TaskGrant>>(GRANTS_KEY, {});
  }

  private saveGrants(grants: Record<string, TaskGrant>): void {
    this.store.saveHubSetting(GRANTS_KEY, grants);
  }

  private recoveries(): Record<string, RecoveryRecord> {
    return this.store.hubSetting<Record<string, RecoveryRecord>>(RECOVERIES_KEY, {});
  }

  private saveRecoveries(records: Record<string, RecoveryRecord>): void {
    this.store.saveHubSetting(RECOVERIES_KEY, records);
  }

  private notifiedKeys(): Record<string, { at: string; result: PushRecord['result'] }> {
    return this.store.hubSetting<Record<string, { at: string; result: PushRecord['result'] }>>(NOTIFIED_KEY, {});
  }

  listGrants(): TaskGrant[] {
    return Object.values(this.grants()).filter(g => !g.revokedAt);
  }

  activeGrant(matterId: string): TaskGrant | null {
    const grant = this.grants()[matterId];
    if (!grant || grant.revokedAt) return null;
    const todo = this.store.getTodo(matterId);
    if (!todo || todo.done || todo.state === 'done' || todo.lane === 'later') return null;
    const currentHash = scopeHashOf(todo, { repos: grant.repos, modelPolicy: grant.modelPolicy, fixedModel: grant.fixedModel });
    if (grant.scopeHash !== currentHash) return null;
    return grant;
  }

  grant(
    matterId: string,
    origin: EvidenceRef,
    options: { repos?: string[]; actions?: TaskGrant['actions']; modelPolicy?: TaskGrant['modelPolicy']; fixedModel?: string | null } = {},
  ): TaskGrant {
    const todo = this.store.getTodo(matterId);
    if (!todo) throw new HttpError(404, 'todo not found');
    if (todo.done || todo.state === 'done' || todo.proposed) throw new HttpError(409, 'cannot grant supervision on a done or unaccepted proposal');
    const repos = options.repos?.length
      ? [...new Set(options.repos)]
      : [...new Set(this.store.todoThreadIds(matterId)
          .map(id => this.store.getThread(id))
          .filter((t): t is NonNullable<typeof t> => Boolean(t))
          .map(t => repoKeyForCwd(t.worktree?.of ?? t.cwd) ?? t.cwd))];
    const modelPolicy = options.modelPolicy ?? (options.fixedModel ? 'keep' : 'configured_fallback');
    const fixedModel = options.fixedModel ?? null;
    const record: TaskGrant = {
      matterId,
      origin,
      scopeHash: scopeHashOf(todo, { repos, modelPolicy, fixedModel }),
      repos,
      actions: options.actions?.length ? [...new Set(options.actions)] : [...DEFAULT_GRANT_ACTIONS],
      modelPolicy,
      fixedModel,
      grantedAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.store.transaction(() => {
      const map = this.grants();
      map[matterId] = record;
      this.saveGrants(map);
    });
    return record;
  }

  revoke(matterId: string): { matterId: string; revoked: boolean } {
    const map = this.grants();
    const existing = map[matterId];
    if (!existing || existing.revokedAt) return { matterId, revoked: false };
    map[matterId] = { ...existing, revokedAt: new Date().toISOString() };
    this.saveGrants(map);
    return { matterId, revoked: true };
  }

  activeRecovery(matterId: string): RecoveryRecord | null {
    return Object.values(this.recoveries())
      .filter(r => r.matterId === matterId && (r.state === 'planned' || r.state === 'started'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  listRecoveries(matterId?: string): RecoveryRecord[] {
    return Object.values(this.recoveries()).filter(r => !matterId || r.matterId === matterId);
  }

  /** Settles active recovery records for a matter (or specific recovery thread) once its turn finishes or verification passes. */
  settleRecoveryForThread(matterId: string, threadId: string | null, result: 'resolved' | 'unresolved' = 'resolved'): void {
    const map = this.recoveries();
    let changed = false;
    const now = new Date().toISOString();
    for (const [key, rec] of Object.entries(map)) {
      if (rec.matterId !== matterId) continue;
      if (rec.state !== 'planned' && rec.state !== 'started') continue;
      if (threadId !== null && rec.targetThreadId !== threadId && rec.threadId !== threadId) continue;
      map[key] = { ...rec, state: 'settled', result, updatedAt: now };
      changed = true;
    }
    if (changed) this.saveRecoveries(map);
  }

  /**
   * Assistant-only supervision command (`calli todo supervise ID --action ...`).
   * All target threads, permissions, options, and evidence references are resolved & verified server-side.
   */
  async supervise(owner: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.personal.router.status().threadId !== owner) {
      throw new HttpError(403, 'supervise is only available to the assistant');
    }
    const matterId = personalText(input.id, 200).trim();
    const action = String(input.action ?? '') as SuperviseAction;
    const validActions: SuperviseAction[] = ['grant', 'revoke', 'continue', 'retry', 'switch_model', 'split', 'answer', 'verify', 'reject_evidence'];
    if (!validActions.includes(action)) throw new HttpError(400, `invalid supervise action: ${action}`);
    const todo = this.store.getTodo(matterId);
    if (!todo) throw new HttpError(404, 'todo not found');

    // Explicit grant / revoke require an active trusted human turn.
    if (action === 'grant' || action === 'revoke') {
      const turnId = this.personal.router.humanTurn(owner);
      if (!turnId) throw new HttpError(403, `${action} requires an active human-initiated turn`);
      if (action === 'revoke') return this.revoke(matterId);
      const start = this.store.listTurnEvents(owner, turnId).find(e => e.type === 'turn.started');
      const origin: EvidenceRef = { threadId: owner, turnId, seq: start?.seq ?? 0 };
      const modelPolicy = input.modelPolicy === 'keep' ? 'keep' : 'configured_fallback';
      const fixedModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
      const grant = this.grant(matterId, origin, { modelPolicy, fixedModel });
      return { action: 'grant', grant };
    }

    // Evidence verification and read-only gap recording.
    if (action === 'verify') {
      return this.verifyEvidence(todo, input);
    }
    if (action === 'reject_evidence') {
      return this.rejectEvidence(owner, todo, input);
    }

    // All autonomous execution actions require superagent.enabled + active TaskGrant.
    const grant = this.requireAutonomousGrant(todo, action);
    const target = this.resolveTargetThread(owner, todo, typeof input.threadId === 'string' ? input.threadId : undefined);
    const incidentId = this.resolveIncidentId(target.id, input);

    if (action === 'answer') {
      return this.answerPendingRequest(todo, grant, target.id, incidentId, input);
    }

    // Single-owner coordination: do not stack another retry on top of AutoRetry or AutoHandover.
    if (action === 'retry' || action === 'continue') {
      const view = this.manager.threadView(target.id);
      if (view.autoRetry) {
        return { action, status: 'deferred', handledBy: 'auto_retry', threadId: target.id, nextAt: view.autoRetry.nextAt };
      }
      if (view.autoHandover?.resume) {
        return { action, status: 'deferred', handledBy: 'auto_handover', threadId: target.id };
      }
    }

    const recoveryKey = `${matterId}:${incidentId}`;
    this.assertIncidentBudget(recoveryKey);

    if (action === 'switch_model') {
      return this.switchModelAndRetry(todo, grant, target.id, incidentId, recoveryKey, input);
    }
    if (action === 'split') {
      return this.splitRecoveryStep(todo, grant, target.id, incidentId, recoveryKey, input);
    }

    // `retry` or `continue`: send a single bounded recovery turn to the matter's active work thread.
    const prompt = typeof input.task === 'string' && input.task.trim()
      ? personalText(input.task, 16_000).trim()
      : action === 'retry'
        ? `继续完成任务「${todo.text}」：先核对上一轮失败原因并换用稳妥路径完成，补齐验收证据。`
        : `继续推进任务「${todo.text}」并补齐验收证据。`;
    const recovery = this.recordRecovery(recoveryKey, {
      matterId,
      incidentId,
      grantOrigin: grant.origin,
      threadId: target.id,
      sourceTurnId: this.lastTurnId(target.id) ?? '',
      action,
      state: 'planned',
      result: null,
      targetThreadId: target.id,
      notifiedKey: null,
      updatedAt: new Date().toISOString(),
    });
    try {
      await this.manager.startTurn(target.id, {
        text: `${prompt}\n\n由助手按任务授权督办推进。只处理原任务范围，不推远端、不给别人发消息、不删除、不付款。结尾写 [进度] 状态及验证证据。`,
        displayText: `助手督办（${action === 'retry' ? '重试' : '继续'}）：${prompt.slice(0, 120)}`,
        queue: true,
      }, undefined, false, undefined, undefined, { assistantSay: randomUUID() });
      this.updateRecovery(recoveryKey, { state: 'started', result: 'resolved' });
      return { action, status: 'started', threadId: target.id, incidentId, recovery };
    } catch (error) {
      this.updateRecovery(recoveryKey, { state: 'settled', result: 'unresolved' });
      throw error;
    }
  }

  private requireAutonomousGrant(todo: TodoRecord, action: 'continue' | 'retry' | 'switch_model' | 'split' | 'answer'): TaskGrant {
    if (!this.settings().enabled) {
      throw new HttpError(403, 'superagent autonomous supervision is disabled; enable it in assistant settings first');
    }
    const grant = this.activeGrant(todo.id);
    if (!grant) {
      throw new HttpError(403, 'no active supervision grant for this matter (or goal scope changed)');
    }
    if (!grant.actions.includes(action)) {
      throw new HttpError(403, `action ${action} is not permitted by this matter's grant`);
    }
    return grant;
  }

  private resolveTargetThread(owner: string, todo: TodoRecord, requestedThreadId?: string) {
    const linkedIds = this.store.todoThreadIds(todo.id);
    if (requestedThreadId && !linkedIds.includes(requestedThreadId)) {
      throw new HttpError(403, 'target thread is not linked to this matter');
    }
    const candidates = (requestedThreadId ? [requestedThreadId] : linkedIds)
      .map(id => this.store.getThread(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t && !t.archivedAt && t.id !== owner && !this.personal.ledger.isInternalThread(t.id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const target = candidates[0];
    if (!target) throw new HttpError(409, 'no active work thread is linked to this matter');
    if (!isWithinWorkdirs(target.cwd, this.manager.allowedWorkdirs)) {
      throw new HttpError(403, 'target thread directory is outside allowed workdirs');
    }
    return target;
  }

  private lastTurnId(threadId: string): string | null {
    return this.store.recentLifecycle(threadId, 1)[0]?.turnId ?? null;
  }

  private resolveIncidentId(threadId: string, input: Record<string, unknown>): string {
    if (typeof input.incidentId === 'string' && input.incidentId.trim()) return input.incidentId.trim().slice(0, 120);
    if (typeof input.requestId === 'string' && input.requestId.trim()) return `req:${input.requestId.trim()}`;
    return `turn:${this.lastTurnId(threadId) ?? 'latest'}`;
  }

  private assertIncidentBudget(recoveryKey: string): void {
    const existing = this.recoveries()[recoveryKey];
    if (existing && (existing.state === 'planned' || existing.state === 'started' || existing.state === 'settled')) {
      throw new HttpError(409, 'recovery limit reached for this incident (at most 1 assistant recovery per incident)');
    }
  }

  private recordRecovery(key: string, record: RecoveryRecord): RecoveryRecord {
    const map = this.recoveries();
    map[key] = record;
    this.saveRecoveries(map);
    return record;
  }

  private updateRecovery(key: string, patch: Partial<RecoveryRecord>): void {
    const map = this.recoveries();
    if (!map[key]) return;
    map[key] = { ...map[key], ...patch, updatedAt: new Date().toISOString() };
    this.saveRecoveries(map);
  }

  private async switchModelAndRetry(
    todo: TodoRecord,
    grant: TaskGrant,
    threadId: string,
    incidentId: string,
    recoveryKey: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (grant.modelPolicy === 'keep') {
      throw new HttpError(403, 'model switching is refused because this task has a fixed model policy');
    }
    const model = personalText(input.model, 200).trim();
    const thread = this.store.getThread(threadId)!;
    const availableModels = await this.manager.listModels(thread.agent);
    if (availableModels.length > 0 && !availableModels.some(m => m.id === model)) {
      throw new HttpError(400, `model ${model} is not in the configured models for ${thread.agent}`);
    }
    this.recordRecovery(recoveryKey, {
      matterId: todo.id,
      incidentId,
      grantOrigin: grant.origin,
      threadId,
      sourceTurnId: this.lastTurnId(threadId) ?? '',
      action: 'switch_model',
      state: 'planned',
      result: null,
      targetThreadId: threadId,
      notifiedKey: null,
      updatedAt: new Date().toISOString(),
    });
    try {
      await this.manager.updateThread(threadId, { model });
      const prompt = typeof input.task === 'string' && input.task.trim()
        ? personalText(input.task, 16_000).trim()
        : `已切换模型为 ${model}，请继续完成任务「${todo.text}」并补齐验收证据。`;
      await this.manager.startTurn(threadId, {
        text: `${prompt}\n\n由助手按任务授权换模重试。只处理原任务范围，不推远端、不给别人发消息、不删除、不付款。`,
        displayText: `助手督办（换模 ${model}）：${prompt.slice(0, 120)}`,
        queue: true,
      }, undefined, false, undefined, undefined, { assistantSay: randomUUID() });
      this.updateRecovery(recoveryKey, { state: 'started', result: 'resolved' });
      return { action: 'switch_model', status: 'started', threadId, model, incidentId };
    } catch (error) {
      this.updateRecovery(recoveryKey, { state: 'settled', result: 'unresolved' });
      throw error;
    }
  }

  private async splitRecoveryStep(
    todo: TodoRecord,
    grant: TaskGrant,
    sourceThreadId: string,
    incidentId: string,
    recoveryKey: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const source = this.store.getThread(sourceThreadId)!;
    // Prevent concurrent writes to the same directory by another running thread of this matter.
    const sameCwdRunning = this.store.todoThreadIds(todo.id)
      .map(id => this.store.getThread(id))
      .some(t => t && !t.archivedAt && t.status === 'running' && t.cwd === source.cwd);
    if (sameCwdRunning) {
      throw new HttpError(409, 'cannot split a recovery step while another thread for this matter is still running in the same directory');
    }
    const task = personalText(input.task, 16_000).trim();
    const title = typeof input.title === 'string' && input.title.trim() ? personalText(input.title, 120).trim() : `${todo.text} · 拆步`;
    this.recordRecovery(recoveryKey, {
      matterId: todo.id,
      incidentId,
      grantOrigin: grant.origin,
      threadId: sourceThreadId,
      sourceTurnId: this.lastTurnId(sourceThreadId) ?? '',
      action: 'split',
      state: 'planned',
      result: null,
      targetThreadId: null,
      notifiedKey: null,
      updatedAt: new Date().toISOString(),
    });
    const created = await this.manager.createThread({
      agent: source.agent,
      cwd: source.cwd,
      title,
      permissionMode: source.permissionMode,
      ...(source.model ? { model: source.model } : {}),
    });
    try {
      this.store.linkTodoThread(todo.id, created.id);
      await this.manager.startTurn(created.id, {
        text: `${task}\n\n这是从任务「${todo.text}」（ID: ${todo.id}）拆出的恢复子步骤。只完成这一步并给出可验证证据，不推远端、不给别人发消息、不删除、不付款。`,
        displayText: `助手拆步：${task.slice(0, 120)}`,
        queue: true,
      }, undefined, false, undefined, undefined, { assistantSay: randomUUID() });
      this.updateRecovery(recoveryKey, { state: 'started', result: 'resolved', targetThreadId: created.id });
      return { action: 'split', status: 'started', sourceThreadId, threadId: created.id, incidentId };
    } catch (error) {
      this.updateRecovery(recoveryKey, { state: 'settled', result: 'unresolved' });
      throw error;
    }
  }

  private async answerPendingRequest(
    todo: TodoRecord,
    grant: TaskGrant,
    threadId: string,
    incidentId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestId = personalText(input.requestId, 200).trim();
    const reason = personalText(input.reason ?? '依据用户原话和任务范围代选', 500).trim();
    const recoveryKey = `${todo.id}:${incidentId}`;

    // 1. Check pending native approvals on this linked thread.
    const approval = this.manager.pendingApprovals(threadId).find(a => a.approvalId === requestId);
    if (approval) {
      const optionId = personalText(input.optionId, 200).trim();
      const option = approval.options.find(o => o.optionId === optionId);
      if (!option) throw new HttpError(400, `option ${optionId} is not offered by this approval request`);
      // Hard safety boundary: never auto-select scope-expanding `allow_always` options.
      if (option.kind === 'allow_always') {
        throw new HttpError(403, 'autonomous supervision cannot pick allow_always; pick a single-use option or ask the user');
      }
      this.recordRecovery(recoveryKey, {
        matterId: todo.id,
        incidentId,
        grantOrigin: grant.origin,
        threadId,
        sourceTurnId: approval.turnId,
        action: 'answer',
        state: 'planned',
        result: null,
        targetThreadId: threadId,
        notifiedKey: null,
        updatedAt: new Date().toISOString(),
      });
      const resolved = this.manager.resolveApproval(requestId, { optionId });
      this.clearFallbackTimer(requestId);
      this.updateRecovery(recoveryKey, { state: 'settled', result: resolved ? 'resolved' : 'unknown' });
      return { action: 'answer', kind: 'approval', requestId, optionId, resolved, reason };
    }

    // 2. Check pending native user-input / plan requests on this linked thread.
    const pendingInput = this.manager.pendingInputs(threadId).find(i => i.inputId === requestId);
    if (pendingInput) {
      const answers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
        ? input.answers as Record<string, string[]>
        : typeof input.optionId === 'string' && pendingInput.request.questions.length === 1
          ? { [pendingInput.request.questions[0].id]: [input.optionId] }
          : null;
      if (!answers) throw new HttpError(400, 'answers (or optionId for a single-question prompt) is required');
      this.recordRecovery(recoveryKey, {
        matterId: todo.id,
        incidentId,
        grantOrigin: grant.origin,
        threadId,
        sourceTurnId: pendingInput.turnId,
        action: 'answer',
        state: 'planned',
        result: null,
        targetThreadId: threadId,
        notifiedKey: null,
        updatedAt: new Date().toISOString(),
      });
      const resolved = this.manager.inputs.answer(requestId, { answers }, false);
      this.clearFallbackTimer(requestId);
      this.updateRecovery(recoveryKey, { state: 'settled', result: resolved ? 'resolved' : 'unknown' });
      return { action: 'answer', kind: pendingInput.request.kind ?? 'question', requestId, resolved, reason };
    }

    return { action: 'answer', requestId, resolved: false, reason: 'request is no longer pending (already answered or expired)' };
  }

  /**
   * Server-side evidence verification: every reference must actually exist and belong to
   * this matter's linked threads or allowed directories. Cannot mark passed without refs.
   */
  private verifyEvidence(todo: TodoRecord, input: Record<string, unknown>): Record<string, unknown> {
    const rawRefs = Array.isArray(input.refs) ? input.refs.filter((r): r is string => typeof r === 'string' && r.trim().length > 0) : [];
    if (!rawRefs.length) throw new HttpError(400, 'verify requires at least one concrete evidence reference in refs');

    const linkedIds = new Set(this.store.todoThreadIds(todo.id));
    const allowedRoots = [...this.manager.allowedWorkdirs, this.personal.directory()];
    const verifiedRefs: string[] = [];
    for (const ref of rawRefs.slice(0, 20)) {
      const trimmed = ref.trim();
      if (trimmed.startsWith('thread:')) {
        const [, tid] = trimmed.split(':');
        if (!tid || !linkedIds.has(tid) || !this.store.getThread(tid)) {
          throw new HttpError(400, `evidence reference does not belong to a linked thread of this matter: ${trimmed}`);
        }
        verifiedRefs.push(trimmed);
      } else if (trimmed.startsWith('turn:')) {
        const [, tid, turnId] = trimmed.split(':');
        if (!tid || !turnId || !linkedIds.has(tid) || !this.store.listTurnEvents(tid, turnId).length) {
          throw new HttpError(400, `evidence turn reference not found in linked thread: ${trimmed}`);
        }
        verifiedRefs.push(trimmed);
      } else if (isAbsolute(trimmed)) {
        if (!existsSync(trimmed)) throw new HttpError(400, `evidence file does not exist: ${trimmed}`);
        const real = realpathSync(trimmed);
        if (!isWithinWorkdirs(real, allowedRoots)) {
          throw new HttpError(403, `evidence file is outside allowed directories: ${trimmed}`);
        }
        verifiedRefs.push(real);
      } else {
        throw new HttpError(400, `evidence ref must be an existing absolute file path, thread:<id>, or turn:<threadId>:<turnId>: ${trimmed}`);
      }
    }

    const sourceTurnId = typeof input.sourceTurnId === 'string' && input.sourceTurnId.trim()
      ? input.sourceTurnId.trim()
      : (this.store.todoThreadIds(todo.id).map(id => this.lastTurnId(id)).find(Boolean) ?? 'verified');
    const validation: TaskValidation = {
      state: 'passed',
      scopeHash: this.scopeHash(todo),
      sourceTurnId,
      checkedAt: new Date().toISOString(),
      refs: verifiedRefs,
      gaps: [],
      ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim().slice(0, 300) } : {}),
    };
    const updated = this.store.updateTodo(todo.id, { validation }, todo.rev);
    this.settleRecoveryForThread(todo.id, null, 'resolved');
    this.manager.broadcastTodo();

    if (this.settings().enabled) {
      this.queueDecisionNotice({
        key: `review:${todo.id}:${sourceTurnId}`,
        matterId: todo.id,
        title: todo.text,
        kind: 'review',
        detail: `验收证据已核对通过（${verifiedRefs.length} 项证据），请你验收确认`,
        recommendation: '回复「通过」确认完成，或说明修改意见',
        threadId: this.personal.ledger.taskView(updated).primaryThreadId,
      });
    }
    return { action: 'verify', validation, todo: updated };
  }

  /**
   * Records missing or failed evidence. When superagent.enabled + granted + within incident budget,
   * automatically kicks back to the work thread to fill the exact gaps; otherwise records read-only gaps.
   */
  private async rejectEvidence(owner: string, todo: TodoRecord, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = input.state === 'failed' ? 'failed' : 'missing';
    const gaps = Array.isArray(input.gaps)
      ? input.gaps.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map(g => g.trim().slice(0, 300))
      : typeof input.reason === 'string' && input.reason.trim()
        ? [input.reason.trim().slice(0, 300)]
        : [];
    if (!gaps.length) throw new HttpError(400, 'reject_evidence requires concrete gaps');

    const sourceTurnId = typeof input.sourceTurnId === 'string' && input.sourceTurnId.trim()
      ? input.sourceTurnId.trim()
      : (this.store.todoThreadIds(todo.id).map(id => this.lastTurnId(id)).find(Boolean) ?? 'unverified');
    const validation: TaskValidation = {
      state,
      scopeHash: this.scopeHash(todo),
      sourceTurnId,
      checkedAt: new Date().toISOString(),
      refs: [],
      gaps,
      ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim().slice(0, 300) } : {}),
    };
    const updated = this.store.updateTodo(todo.id, { validation }, todo.rev);
    this.manager.broadcastTodo();

    // Only auto-kickback if autonomous supervision is enabled, granted, and within incident budget.
    const grant = this.settings().enabled ? this.activeGrant(todo.id) : null;
    if (!grant) {
      return { action: 'reject_evidence', kickedBack: false, validation, todo: updated };
    }

    const target = this.resolveTargetThread(owner, updated);
    const incidentId = `evidence:${sourceTurnId}`;
    const recoveryKey = `${todo.id}:${incidentId}`;
    if (this.recoveries()[recoveryKey]) {
      return { action: 'reject_evidence', kickedBack: false, reason: 'incident recovery already used', validation, todo: updated };
    }
    this.recordRecovery(recoveryKey, {
      matterId: todo.id,
      incidentId,
      grantOrigin: grant.origin,
      threadId: target.id,
      sourceTurnId,
      action: 'reject_evidence',
      state: 'planned',
      result: null,
      targetThreadId: target.id,
      notifiedKey: null,
      updatedAt: new Date().toISOString(),
    });
    const gapText = gaps.map((g, i) => `${i + 1}. ${g}`).join('\n');
    try {
      await this.manager.startTurn(target.id, {
        text: `验收核对未通过，以下证据缺失或未满足标准，请直接补齐后回报：\n${gapText}\n\n只补齐原任务「${todo.text}」的验收证据，不推远端、不给别人发消息、不删除、不付款。`,
        displayText: `助手打回补证据：${gaps[0]}`,
        queue: true,
      }, undefined, false, undefined, undefined, { assistantSay: randomUUID() });
      this.updateRecovery(recoveryKey, { state: 'started', result: 'resolved' });
      return { action: 'reject_evidence', kickedBack: true, threadId: target.id, validation, todo: updated };
    } catch (error) {
      this.updateRecovery(recoveryKey, { state: 'settled', result: 'unresolved' });
      throw error;
    }
  }

  /**
   * Called by PushService before enqueuing a raw worker event push.
   * When superagent is off, ALWAYS returns false (preserving existing push path 100%).
   * When superagent is on, defers raw pushes for ledger-tracked tasks so supervision can
   * self-handle or merge pushes, with a deterministic 60s fallback for real pending requests.
   */
  shouldDeferRawPush(threadId: string, kind: PushKind, event: StoredEvent): boolean {
    const settings = this.settings();
    if (!settings.enabled || this.closed) return false;
    // Never defer the assistant's own notices or briefs.
    if (this.personal.router.status().threadId === threadId) return false;
    const todos = this.personal.ledger.linkedTodos(threadId).filter(t => !t.done && t.state !== 'done');
    if (!todos.length) return false;

    const granted = todos.some(t => Boolean(this.activeGrant(t.id)));
    if (kind === 'failure') {
      // Granted tasks let supervision self-handle before paging the person.
      return granted;
    }
    if (kind === 'approval' || kind === 'question' || kind === 'plan') {
      const requestId = String(event.data.approvalId ?? event.data.inputId ?? `${threadId}:${event.seq}`);
      const todo = todos[0];
      this.armFallback(requestId, todo, threadId, kind, String(event.data.title ?? '等待确认'));
      return true;
    }
    if (kind === 'notice' && granted) return true;
    return false;
  }

  private armFallback(requestId: string, todo: TodoRecord, threadId: string, kind: 'approval' | 'question' | 'plan', title: string): void {
    if (this.fallbackTimers.has(requestId)) return;
    const ms = this.settings().fallbackTimeoutMs;
    const timer = setTimeout(() => {
      this.fallbackTimers.delete(requestId);
      if (this.closed) return;
      // Only fire deterministic fallback if the native request is STILL genuinely pending.
      const stillPending = this.manager.pendingApprovals(threadId).some(a => a.approvalId === requestId)
        || this.manager.pendingInputs(threadId).some(i => i.inputId === requestId);
      if (!stillPending) return;
      this.queueDecisionNotice({
        key: `fallback:${requestId}`,
        matterId: todo.id,
        title: todo.text,
        kind: 'needs_user',
        detail: `${kind === 'approval' ? '等待批准' : kind === 'plan' ? '计划待确认' : '等你回答'}：${title}（助手超时未分流，兜底提醒）`,
        threadId,
      });
      this.flushNotifications();
    }, ms);
    timer.unref?.();
    this.fallbackTimers.set(requestId, timer);
  }

  clearFallbackTimer(requestId: string): void {
    const timer = this.fallbackTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.fallbackTimers.delete(requestId);
    }
  }

  /**
   * Queues a genuine user-decision or verified-review item into a fixed (non-extending) merge window.
   * Deduplicated persistently by `item.key` so restarts and late reports never send duplicates.
   */
  queueDecisionNotice(item: DecisionNoticeItem): boolean {
    if (this.closed) return false;
    const notified = this.notifiedKeys();
    if (notified[item.key]?.result === 'sent') return false;
    if (this.pendingNotices.some(n => n.key === item.key)) return false;
    this.pendingNotices.push(item);

    const mergeMs = this.settings().notifyMergeMs;
    if (mergeMs === 0) {
      this.flushNotifications();
      return true;
    }
    // Fixed window: once armed by the first item, subsequent arrivals join the batch without extending the timer.
    if (!this.mergeTimer) {
      this.mergeTimer = setTimeout(() => {
        this.mergeTimer = null;
        this.flushNotifications();
      }, mergeMs);
      this.mergeTimer.unref?.();
    }
    return true;
  }

  /** Sends all buffered decision/review notices as ONE consolidated push and records delivery state. */
  flushNotifications(): PushRecord | null {
    if (this.mergeTimer) {
      clearTimeout(this.mergeTimer);
      this.mergeTimer = null;
    }
    if (!this.pendingNotices.length) return null;
    const batch = this.pendingNotices.splice(0);
    const key = batch.map(b => b.key).sort().join('|');
    const title = batch.length === 1 ? batch[0].title : `${batch.length} 件待你处理`;
    const body = batch.map((item, idx) => {
      const tag = item.kind === 'review' ? '待验收' : '需拍板';
      const rec = item.recommendation ? `；建议：${item.recommendation}` : '';
      return `${batch.length > 1 ? `${idx + 1}. ` : ''}[${tag}] ${item.title}：${item.detail}${rec}`;
    }).join('\n');

    const routerId = this.personal.router.status().threadId;
    const record = this.push?.sendSuperagentBatch(key, title, body, routerId) ?? null;
    if (record) {
      const notified = this.notifiedKeys();
      const now = new Date().toISOString();
      for (const item of batch) notified[item.key] = { at: now, result: record.result };
      // Keep the most recent 500 dedupe keys.
      const entries = Object.entries(notified);
      const trimmed = entries.length > 500 ? Object.fromEntries(entries.slice(-500)) : notified;
      this.store.saveHubSetting(NOTIFIED_KEY, trimmed);
    }
    return record;
  }
}
