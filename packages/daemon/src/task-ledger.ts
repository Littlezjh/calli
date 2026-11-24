import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, sep } from 'node:path';
import type { StoredEvent } from './events.js';
import { HttpError } from './errors.js';
import type { TurnEnd } from './lifecycle.js';
import type { PersonalService } from './personal.js';
import {
  urgencyOf,
  type EvidenceRef,
  type Store,
  type TaskAcceptance,
  type TaskCapture,
  type TaskValidation,
  type ThreadOpenRecord,
  type ThreadOpenSource,
  type ThreadRecord,
  type TodoRecord,
  type TodoUrgency,
} from './store.js';
import type { ThreadManager, ThreadView } from './threads.js';
import { importantOf, quadrantOf, type Quadrant } from './todo-priority.js';

export type TaskPhase =
  | 'not_started'
  | 'running'
  | 'continuing'
  | 'waiting_external'
  | 'recovering'
  | 'verifying'
  | 'needs_user'
  | 'review'
  | 'paused'
  | 'done'
  | 'unknown';

export interface TaskPriority {
  quadrant: Quadrant;
  score: number;
  urgent: boolean;
  important: boolean;
  urgencyReason: TodoUrgency['reason'];
  reasons: string[];
}

export interface TaskThreadSummary {
  id: string;
  title: string;
  repoKey: string | null;
  cwd: string;
  agent: string;
  status: 'idle' | 'running' | 'error';
  waiting: boolean;
  waitingReason: 'approval' | 'question' | 'plan' | null;
  archived: boolean;
  done: boolean;
  lastTurnId: string | null;
  superseded: boolean;
  progress: { stage: string; note: string } | null;
  updatedAt: string;
}

export interface TaskPendingRequest {
  kind: 'approval' | 'question' | 'plan';
  requestId: string;
  threadId: string;
  turnId: string;
  title: string;
  options: Array<{ id: string; label: string; kind?: string }>;
}

export interface TaskView {
  id: string;
  rev: number;
  title: string;
  owner: 'me' | 'agent';
  parentId: string | null;
  isParentGoal: boolean;
  lane: TodoRecord['lane'];
  importance: TodoRecord['importance'];
  dueAt: string | null;
  urgentUntil: string | null;
  waitingOn: string | null;
  acceptance: TaskAcceptance | null;
  capture: TaskCapture | null;
  validation: TaskValidation | null;
  threads: TaskThreadSummary[];
  deletedThreadIds: string[];
  primaryThreadId: string | null;
  phase: TaskPhase;
  priority: TaskPriority;
  reason: string;
  nextStep: string | null;
  observedAt: string;
  evidence: EvidenceRef[];
  freshness: 'current' | 'stale' | 'unavailable';
  granted: boolean;
  pendingRequests: TaskPendingRequest[];
}

export interface LedgerCoverage {
  backfilledAt: string | null;
  coveredThreads: number;
  ambiguousThreads: number;
}

export interface LedgerSnapshot {
  snapshotVersion: string;
  observedAt: string;
  totalOpen: number;
  totalDoneInRange: number;
  coverage: LedgerCoverage;
  items: TaskView[];
  nextCursor: string | null;
}

export interface ThreadSearchHit {
  id: string;
  activeSegmentId: string;
  self: boolean;
  title: string;
  repoKey: string | null;
  cwd: string;
  agent: string;
  status: ThreadRecord['status'];
  waiting: boolean;
  done: boolean;
  archived: boolean;
  updatedAt: string;
  progress: { stage: string; note: string } | null;
  firstAsk: string | null;
  lastAsk: string | null;
  lastAnswerEnd: string | null;
  matchReason: string;
  score: number;
  todos: Array<{ id: string; text: string; done: boolean; parentId: string | null }>;
}

export interface ThreadSearchResult {
  query: string | null;
  total: number;
  threads: ThreadSearchHit[];
  nextCursor: string | null;
}

export interface SuperagentTriageItem {
  id: string;
  threadId: string | null;
  title: string;
  summary: string;
  kind: 'approval' | 'needs_user' | 'review';
  urgent: boolean;
  important: boolean;
  updatedAt: string;
}

export interface SuperagentTriageView {
  items: SuperagentTriageItem[];
  total: number;
  overflowCount: number;
}

const LEDGER_STATE_KEY = 'superagent.ledgerState';
const TRIAGE_SHELVED_KEY = 'superagent.shelvedTriage';
const TRIAGE_FRESH_DIRECT_MS = 36 * 3600_000;
const TRIAGE_DEFAULT_LIMIT = 5;
const THREAD_OPEN_SOURCES: readonly ThreadOpenSource[] = [
  'sidebar',
  'search',
  'direct-link',
  'assistant-link',
  'notification',
  'handover',
  'restore',
];
const DIRECT_OPEN_SOURCES = new Set<ThreadOpenSource>(['sidebar', 'search', 'direct-link']);
const PHASE_PRIORITY: Record<TaskPhase, number> = {
  needs_user: 90,
  review: 75,
  verifying: 68,
  recovering: 62,
  running: 55,
  continuing: 48,
  waiting_external: 35,
  not_started: 30,
  unknown: 25,
  paused: 10,
  done: 0,
};
const QUADRANT_SCORE: Record<Quadrant, number> = { now: 400, plan: 300, quick: 200, later: 100 };

/** Normalizes `<repo>/.worktrees/<name>` back to `<repo>`, matching Calli's project grouping. */
export function repoKeyForCwd(cwd: string): string | null {
  if (!cwd) return null;
  const normalized = cwd.replace(/\/+$/, '');
  const marker = `${sep}.worktrees${sep}`;
  const idx = normalized.indexOf(marker);
  return idx > 0 ? normalized.slice(0, idx) : normalized || null;
}

/** First non-heading content line under `## 下一步` in a matter's continuation note. */
export function extractNextStep(note: string): string | null {
  if (!note.trim()) return null;
  const lines = note.split(/\r?\n/).map(line => line.trim());
  const next = lines.findIndex(line => /^##\s+下一步(?:\s+#+)?$/.test(line));
  if (next < 0) return null;
  const rest = lines.slice(next + 1);
  const end = rest.findIndex(line => /^#{1,2}(?:\s|$)/.test(line));
  const found = (end < 0 ? rest : rest.slice(0, end)).find(line => line && !/^#{1,6}(?:\s|$)/.test(line));
  return found ?? null;
}

export function computePriority(todo: TodoRecord, phase: TaskPhase, now = new Date()): TaskPriority {
  const urgency = urgencyOf(todo, now);
  const important = importantOf(todo);
  const quadrant = quadrantOf({ importance: todo.importance, owner: todo.owner, dueAt: todo.dueAt, urgency });
  const reasons: string[] = [];
  if (todo.importance === 'high') reasons.push('高重要度');
  else if (important) reasons.push('个人截止承诺');
  if (urgency.reason === 'overdue') reasons.push('已逾期');
  else if (urgency.reason === 'due-soon') reasons.push('48 小时内截止');
  else if (urgency.reason === 'pinned') reasons.push('已标记紧急');
  if (phase === 'needs_user') reasons.push('需要你拍板');
  else if (phase === 'review') reasons.push('证据齐备待验收');
  else if (phase === 'recovering') reasons.push('自动恢复中');
  else if (phase === 'verifying') reasons.push('验收核对中');
  const dueBonus = urgency.reason === 'overdue' ? 50 : urgency.reason === 'due-soon' ? 25 : urgency.reason === 'pinned' ? 20 : 0;
  const score = (phase === 'done' ? 0 : QUADRANT_SCORE[quadrant]) + PHASE_PRIORITY[phase] + dueBonus;
  return { quadrant, score, urgent: urgency.urgent, important, urgencyReason: urgency.reason, reasons };
}

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/[\s,，、/]+/).filter(Boolean))].slice(0, 8);
}

/**
 * Unified task ledger over existing `todos + todo_threads + todo_notes`.
 * Auto-captures user-started & dispatched work threads, maintains priority triage,
 * and powers full-history thread lookup without 3-day / 7-day blind spots.
 */
export class TaskLedger {
  private unsubscribe?: () => void;
  private readonly snapshots = new Map<string, { version: string; observedAt: string; items: TaskView[]; totalOpen: number; totalDoneInRange: number; coverage: LedgerCoverage }>();

  constructor(
    private readonly store: Store,
    private readonly manager: ThreadManager,
    private readonly personal: PersonalService,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.manager.subscribe(event => this.onEvent(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  coverage(): LedgerCoverage {
    return this.store.hubSetting<LedgerCoverage>(LEDGER_STATE_KEY, {
      backfilledAt: null,
      coveredThreads: 0,
      ambiguousThreads: 0,
    });
  }

  /** Whether this thread is internal hub/assistant plumbing rather than a user or work task. */
  isInternalThread(threadId: string): boolean {
    if (this.personal.router.status().threadId === threadId) return true;
    const routerState = this.store.hubSetting<{ threadId?: string | null; retiring?: string[] }>('personalRouter', {});
    if (routerState.threadId === threadId || routerState.retiring?.includes(threadId)) return true;
    if (this.store.isRouterThread(threadId) || this.store.isReviewThread(threadId)) return true;
    if (this.store.summaryThreadIds().has(threadId) || this.store.quietRunThreadIds().has(threadId)) return true;
    const runs = this.personal.proactive.runs();
    if (runs.some(run => (run.kind === 'prepare' || run.kind === 'sandbox') && run.threadId === threadId)) return true;
    return false;
  }

  /** Every known thread on this daemon, including archived sessions. */
  private allKnownThreads(): ThreadRecord[] {
    return [...this.store.listThreads({ archived: false }), ...this.store.listThreads({ archived: true })];
  }

  /** Resolves a thread to the active segment at the tip of its automatic handover chain. */
  activeSegmentId(threadId: string): string {
    const all = this.allKnownThreads();
    const bySource = new Map<string, ThreadRecord[]>();
    for (const t of all) {
      if (t.handover && !t.handover.detached && (t.handover.mode ?? 'continue') === 'continue') {
        const list = bySource.get(t.handover.sourceId) ?? [];
        list.push(t);
        bySource.set(t.handover.sourceId, list);
      }
    }
    let current = threadId;
    const seen = new Set<string>([current]);
    while (true) {
      const next = (bySource.get(current) ?? [])
        .filter(t => !t.archivedAt && !seen.has(t.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!next) return current;
      seen.add(next.id);
      current = next.id;
    }
  }

  /** Returns todos currently linked to `threadId`. */
  linkedTodos(threadId: string): TodoRecord[] {
    return this.store.listTodos().filter(todo => this.store.todoThreadIds(todo.id).includes(threadId));
  }

  private onEvent(event: StoredEvent): void {
    try {
      if (!this.personal.supervision.settings().ledgerCapture) return;
      if (event.type === 'turn.started') {
        if (event.data.background || event.data.control || event.data.review || event.data.scheduled) return;
        if (event.data.imported || event.data.fromTerminal) return;
        const dispatch = typeof event.data.dispatchRunId === 'string' && Boolean(event.data.dispatchRunId);
        const human = event.data.userOrigin === 'person' || event.data.fromUser === true;
        if (!dispatch && !human) return;
        this.captureThread(event.threadId, {
          kind: dispatch ? 'dispatch' : 'direct',
          turnId: event.turnId ?? undefined,
          seq: event.seq,
        });
      }
    } catch (error) {
      console.error(`[task-ledger] event error: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Ensures a work/user thread is tracked in the ledger. Never overwrites human-set
   * titles, importance, due dates, or grants; never creates tasks for internal/empty threads.
   */
  captureThread(
    threadId: string,
    trigger: { kind?: 'direct' | 'dispatch' | 'manual'; turnId?: string; seq?: number; matterId?: string; createIfDone?: boolean } = {},
  ): TodoRecord | null {
    const thread = this.store.getThread(threadId);
    if (!thread || this.isInternalThread(threadId)) return null;

    // Collaboration sub-members roll up to their collaboration root's matter.
    const team = this.manager.coordination?.metadata(threadId);
    if (team && team.rootId !== threadId) {
      const rootTodos = this.linkedTodos(team.rootId);
      if (rootTodos.length) {
        for (const todo of rootTodos) {
          if (!this.store.todoThreadIds(todo.id).includes(threadId)) this.store.linkTodoThread(todo.id, threadId);
        }
        return rootTodos[0];
      }
      return null;
    }

    const ref: EvidenceRef | null = trigger.turnId && trigger.seq !== undefined
      ? { threadId, turnId: trigger.turnId, seq: trigger.seq }
      : null;
    const repoKey = repoKeyForCwd(thread.worktree?.of ?? thread.cwd);

    // 1. Explicit matter link takes top priority.
    if (trigger.matterId) {
      const target = this.store.getTodo(trigger.matterId);
      if (target) {
        this.attachThreadToTodo(target, thread, trigger.kind ?? 'dispatch', repoKey, ref);
        return this.store.getTodo(target.id);
      }
    }

    // 2. Existing todo_threads links.
    const existing = this.linkedTodos(threadId);
    if (existing.length) {
      for (const todo of existing) {
        const nextCapture: TaskCapture = {
          kind: todo.capture?.kind ?? trigger.kind ?? 'direct',
          primaryThreadId: this.activeSegmentId(threadId),
          repoKey: todo.capture?.repoKey ?? repoKey,
          indexedThrough: ref ?? todo.capture?.indexedThrough ?? null,
        };
        if (JSON.stringify(todo.capture) !== JSON.stringify(nextCapture)) {
          this.store.updateTodo(todo.id, { capture: nextCapture }, todo.rev);
        }
      }
      return this.store.getTodo(existing[0].id);
    }

    // 3. Handover chain inheritance: attach successor segment to source thread's matter.
    if (thread.handover?.sourceId) {
      const inherited = this.linkedTodos(thread.handover.sourceId);
      if (inherited.length) {
        for (const todo of inherited) {
          this.attachThreadToTodo(todo, thread, todo.capture?.kind ?? trigger.kind ?? 'direct', repoKey, ref);
        }
        return this.store.getTodo(inherited[0].id);
      }
    }

    // 4. Do not create brand-new open tasks for already-done or archived threads during backfill.
    if (!trigger.createIfDone && (thread.doneAt || thread.archivedAt)) return null;

    // Derive a clean title from thread title or first user ask (never empty).
    const summary = this.store.threadTextSummary(threadId);
    const titleCandidate = thread.title && thread.title !== 'New thread'
      ? thread.title
      : summary.firstAsk?.split('\n')[0]?.trim() || thread.title || '未命名会话';
    const title = [...titleCandidate].slice(0, 120).join('');

    const capture: TaskCapture = {
      kind: trigger.kind ?? 'direct',
      primaryThreadId: threadId,
      repoKey,
      indexedThrough: ref,
    };

    const created = this.store.transaction(() => {
      const todo = this.store.createTodo(randomUUID(), title, null, {
        owner: 'agent',
        capture,
      });
      this.store.linkTodoThread(todo.id, threadId);
      return todo;
    });
    this.manager.broadcastTodo();
    return created;
  }

  private attachThreadToTodo(
    todo: TodoRecord,
    thread: ThreadRecord,
    kind: TaskCapture['kind'],
    repoKey: string | null,
    ref: EvidenceRef | null,
  ): void {
    this.store.transaction(() => {
      this.store.linkTodoThread(todo.id, thread.id);
      const nextCapture: TaskCapture = {
        kind: todo.capture?.kind ?? kind,
        primaryThreadId: this.activeSegmentId(thread.id),
        repoKey: todo.capture?.repoKey ?? repoKey,
        indexedThrough: ref ?? todo.capture?.indexedThrough ?? null,
      };
      this.store.updateTodo(todo.id, { capture: nextCapture }, todo.rev);
    });
    this.manager.broadcastTodo();
  }

  /** Called by WorkerReports after a turn settles so validation enters `pending` when claiming review. */
  onTurnSettled(threadId: string, turnId: string | null, outcome: TurnEnd): void {
    if (!this.personal.supervision.settings().ledgerCapture) return;
    const thread = this.store.getThread(threadId);
    if (!thread || this.isInternalThread(threadId)) return;
    const todos = this.linkedTodos(threadId);
    if (!todos.length) return;
    if (!turnId || outcome.outcome === 'cancelled' || outcome.outcome === 'interrupted') return;
    const report = thread.report;
    const claimsReview = report?.by !== 'user' && report?.stage === 'review';
    for (const todo of todos) {
      this.personal.supervision.settleRecoveryForThread(todo.id, threadId, outcome.outcome === 'ok' ? 'resolved' : 'unresolved');
      if (todo.done || todo.state === 'done') continue;
      if (claimsReview) {
        const scopeHash = this.personal.supervision.scopeHash(todo);
        // A fresh review turn invalidates any older validation pass and marks evidence check pending.
        if (todo.validation?.sourceTurnId !== turnId || todo.validation.state !== 'passed' || todo.validation.scopeHash !== scopeHash) {
          this.store.updateTodo(todo.id, {
            validation: {
              state: 'pending',
              scopeHash,
              sourceTurnId: turnId,
              checkedAt: null,
              refs: [],
              gaps: [],
            },
          }, todo.rev);
        }
      }
    }
  }

  /**
   * Read-only startup/on-demand reconciliation across ALL known threads (no 3-day/7-day window).
   * Registers unlinked open user threads; keeps done/archived threads searchable without creating open items.
   */
  backfill(): LedgerCoverage {
    if (!this.personal.supervision.settings().ledgerCapture) return this.coverage();
    const threads = this.allKnownThreads();
    let covered = 0;
    let ambiguous = 0;
    for (const thread of threads) {
      if (this.isInternalThread(thread.id)) continue;
      covered++;
      if (thread.archivedAt || thread.doneAt) continue;
      const lifecycle = this.store.recentLifecycle(thread.id, 2);
      const start = lifecycle.find(e => e.type === 'turn.started');
      if (!start) continue;
      if (start.data.background || start.data.control || start.data.review || start.data.scheduled) continue;
      if (start.data.imported || start.data.fromTerminal) {
        // Imported / terminal sessions stay searchable; only flag ambiguous if unlinked & active.
        if (!this.linkedTodos(thread.id).length) ambiguous++;
        continue;
      }
      if (!this.linkedTodos(thread.id).length) {
        this.captureThread(thread.id, { kind: 'direct', turnId: start.turnId ?? undefined, seq: start.seq });
      }
    }
    const state: LedgerCoverage = {
      backfilledAt: new Date().toISOString(),
      coveredThreads: covered,
      ambiguousThreads: ambiguous,
    };
    this.store.saveHubSetting(LEDGER_STATE_KEY, state);
    return state;
  }

  /** Builds a single unified TaskView with phase, priority triage, threads, and pending requests. */
  taskView(todo: TodoRecord, now = new Date(), allTodos?: readonly TodoRecord[]): TaskView {
    const todos = allTodos ?? this.store.listTodos();
    const isParentGoal = todos.some(other => other.parentId === todo.id && !other.done && other.state !== 'done');
    const linkedIds = this.store.todoThreadIds(todo.id);
    const deletedThreadIds: string[] = [];
    const views: ThreadView[] = [];
    for (const id of linkedIds) {
      if (!this.store.getThread(id)) deletedThreadIds.push(id);
      else views.push(this.manager.threadView(id));
    }

    // Identify handover-superseded segments within this matter's linked threads.
    const linkedSet = new Set(views.map(v => v.id));
    const superseded = new Set<string>();
    for (const v of views) {
      if (v.handover && !v.handover.detached && v.handover.automatic && linkedSet.has(v.handover.sourceId)) {
        superseded.add(v.handover.sourceId);
      }
    }

    const pendingRequests: TaskPendingRequest[] = [];
    const threads: TaskThreadSummary[] = views.map(v => {
      const isSuperseded = superseded.has(v.id);
      const lifecycle = this.store.recentLifecycle(v.id, 1);
      const lastTurnId = lifecycle[0]?.turnId ?? null;
      if (!v.archivedAt && !isSuperseded) {
        for (const approval of this.manager.pendingApprovals(v.id)) {
          pendingRequests.push({
            kind: 'approval',
            requestId: approval.approvalId,
            threadId: v.id,
            turnId: approval.turnId,
            title: approval.title,
            options: approval.options.map(o => ({ id: o.optionId, label: o.name, kind: o.kind })),
          });
        }
        for (const input of this.manager.pendingInputs(v.id)) {
          pendingRequests.push({
            kind: input.request.kind === 'plan' ? 'plan' : 'question',
            requestId: input.inputId,
            threadId: v.id,
            turnId: input.turnId,
            title: input.request.title ?? input.request.questions[0]?.question ?? '需要回答',
            options: input.request.questions.flatMap(q => q.options.map(o => ({ id: o.value, label: o.label }))),
          });
        }
      }
      return {
        id: v.id,
        title: v.title,
        repoKey: repoKeyForCwd(v.worktree?.of ?? v.cwd),
        cwd: v.cwd,
        agent: v.agent,
        status: v.status,
        waiting: v.waiting,
        waitingReason: v.waitingReason,
        archived: Boolean(v.archivedAt),
        done: Boolean(v.doneAt),
        lastTurnId,
        superseded: isSuperseded,
        progress: v.report ? { stage: v.report.stage, note: v.report.note } : null,
        updatedAt: v.updatedAt,
      };
    });

    const activeThreads = threads.filter(t => !t.archived && !t.superseded && !this.isInternalThread(t.id));
    const activeViews = views.filter(v => !v.archivedAt && !superseded.has(v.id) && !this.isInternalThread(v.id));
    const primaryThreadId = activeThreads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id
      ?? (todo.capture?.primaryThreadId && this.store.getThread(todo.capture.primaryThreadId) ? todo.capture.primaryThreadId : null);

    const { phase, reason, freshness } = this.derivePhase(todo, activeViews, pendingRequests, deletedThreadIds);
    const note = this.store.todoNote(todo.id);
    const nextStep = extractNextStep(note.text);
    const priority = computePriority(todo, phase, now);
    const evidence: EvidenceRef[] = [];
    if (todo.acceptance?.source) evidence.push(todo.acceptance.source);
    if (todo.capture?.indexedThrough) evidence.push(todo.capture.indexedThrough);
    const grant = this.personal.supervision.activeGrant(todo.id);

    return {
      id: todo.id,
      rev: todo.rev,
      title: todo.text,
      owner: todo.owner,
      parentId: todo.parentId,
      isParentGoal,
      lane: todo.lane,
      importance: todo.importance,
      dueAt: todo.dueAt,
      urgentUntil: todo.urgentUntil,
      waitingOn: todo.waitingOn,
      acceptance: todo.acceptance,
      capture: todo.capture,
      validation: todo.validation,
      threads,
      deletedThreadIds,
      primaryThreadId,
      phase,
      priority,
      reason,
      nextStep,
      observedAt: now.toISOString(),
      evidence,
      freshness,
      granted: Boolean(grant),
      pendingRequests,
    };
  }

  private derivePhase(
    todo: TodoRecord,
    activeViews: ThreadView[],
    pendingRequests: TaskPendingRequest[],
    deletedThreadIds: string[],
  ): { phase: TaskPhase; reason: string; freshness: 'current' | 'stale' | 'unavailable' } {
    if (todo.done || todo.state === 'done') return { phase: 'done', reason: '已确认完成', freshness: 'current' };
    if (todo.lane === 'later') return { phase: 'paused', reason: '已搁置/暂停', freshness: 'current' };

    const proposals = this.store.todoProposals(todo.id);
    const runs = this.personal.proactive.runs(todo.id);
    const openDoneProposal = proposals.some(p => p.kind === 'done' && p.state === 'open');
    const readyRun = runs.some(r => r.status === 'ready');
    const askingRun = runs.find(r => r.status === 'asking' && r.kind === 'dispatch');
    const activeRecovery = this.personal.supervision.activeRecovery(todo.id);

    // 1. Real user-decision boundary wins even when another parallel thread is running.
    if (pendingRequests.length > 0) {
      return { phase: 'needs_user', reason: `待处理请求：${pendingRequests[0].title}`, freshness: 'current' };
    }
    if (todo.state === 'waiting' && todo.waitingOn?.startsWith('等你')) {
      return { phase: 'needs_user', reason: todo.waitingOn, freshness: 'current' };
    }
    if (askingRun) {
      return { phase: 'needs_user', reason: askingRun.question?.text ?? askingRun.line ?? '等待你确认', freshness: 'current' };
    }
    if (activeViews.some(v => v.report?.by !== 'user' && v.report?.stage === 'blocked')) {
      const blocked = activeViews.find(v => v.report?.by !== 'user' && v.report?.stage === 'blocked')!;
      return { phase: 'needs_user', reason: blocked.report?.note || '工作会话回报需要你决策', freshness: 'current' };
    }

    // 2. Active recovery (AutoRetry, quota resume, or supervision recovery).
    if (activeViews.some(v => Boolean(v.autoRetry) || Boolean(v.autoHandover?.resume))) {
      const recovering = activeViews.find(v => Boolean(v.autoRetry) || Boolean(v.autoHandover?.resume))!;
      return {
        phase: 'recovering',
        reason: recovering.autoRetry ? `自动重试第 ${recovering.autoRetry.attempts + 1}/${recovering.autoRetry.max} 次` : '额度恢复守候中',
        freshness: 'current',
      };
    }
    if (activeRecovery && (activeRecovery.state === 'planned' || activeRecovery.state === 'started')) {
      return { phase: 'recovering', reason: `助手正在恢复（${activeRecovery.action}）`, freshness: 'current' };
    }

    // 3. Running work session.
    if (activeViews.some(v => v.status === 'running')) {
      return { phase: 'running', reason: '工作会话运行中', freshness: 'current' };
    }

    // 4. Failed thread without an active retry watch.
    const failed = activeViews.find(v => v.status === 'error');
    if (failed) {
      return {
        phase: 'needs_user',
        reason: failed.failure?.message ? `会话出错停下：${failed.failure.message.slice(0, 120)}` : '会话出错停下',
        freshness: 'current',
      };
    }

    // 5. External waiting (matter waiting on someone else, or auto-advance wait watch, or progress wait).
    const waitingAdvance = activeViews.find(v => v.advance?.reason === 'wait' && v.advance.nextAt);
    if (waitingAdvance) {
      return { phase: 'waiting_external', reason: `等待外部：${waitingAdvance.advance?.what ?? '外部条件'}`, freshness: 'current' };
    }
    const waitingReport = activeViews.find(v => v.report?.by !== 'user' && v.report?.stage === 'doing' && Boolean(v.report.wait));
    if (waitingReport) {
      return { phase: 'waiting_external', reason: `等待外部：${waitingReport.report?.wait?.what ?? waitingReport.report?.note ?? ''}`, freshness: 'current' };
    }
    if (todo.state === 'waiting') {
      return { phase: 'waiting_external', reason: todo.waitingOn ? `等待：${todo.waitingOn}` : '等待外部进展', freshness: 'current' };
    }

    // 6. Verification & Review: only verified-passed evidence enters `review`.
    const claimsReview = openDoneProposal || readyRun || activeViews.some(v => v.report?.by !== 'user' && v.report?.stage === 'review');
    const currentScope = this.personal.supervision.scopeHash(todo);
    if (todo.validation && todo.validation.scopeHash === currentScope) {
      if (todo.validation.state === 'passed') {
        return { phase: 'review', reason: '验收证据已核对通过，等待你验收确认', freshness: 'current' };
      }
      if (todo.validation.state === 'pending') {
        return { phase: 'verifying', reason: '工作会话已交回，验收证据核对中', freshness: 'current' };
      }
      if (todo.validation.state === 'missing' || todo.validation.state === 'failed') {
        return {
          phase: 'continuing',
          reason: todo.validation.gaps.length ? `待补证据：${todo.validation.gaps[0]}` : '验收未通过，待继续完善',
          freshness: 'current',
        };
      }
    }
    if (claimsReview) {
      return { phase: 'verifying', reason: '有待审结果，尚未核对验收证据', freshness: 'current' };
    }

    // 7. Continuing (idle thread with `进行中` or auto-advance continue watch).
    if (activeViews.some(v => v.advance?.reason === 'continue' || (v.report?.by !== 'user' && v.report?.stage === 'doing'))) {
      const doing = activeViews.find(v => v.report?.by !== 'user' && v.report?.stage === 'doing');
      return { phase: 'continuing', reason: doing?.report?.note || '进行中，等待下一轮继续', freshness: 'current' };
    }

    // 8. Not started vs deleted vs unknown.
    if (!activeViews.length) {
      if (deletedThreadIds.length) return { phase: 'unknown', reason: '关联会话已删除，状态待核对', freshness: 'unavailable' };
      return { phase: 'not_started', reason: '尚未开始（暂无执行会话）', freshness: 'current' };
    }

    // Check if all active sessions are imported/terminal without recent hub turns.
    const latest = activeViews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!latest.hubTurnAt && latest.externalAt) {
      return { phase: 'unknown', reason: '来自外部/终端同步，最新状态待核对', freshness: 'stale' };
    }
    if (activeViews.every(v => Boolean(v.doneAt))) {
      return { phase: 'verifying', reason: '关联会话已标记完成，待核对并确认事项', freshness: 'current' };
    }
    return { phase: 'continuing', reason: '已有工作会话，当前空闲未结', freshness: 'current' };
  }

  /**
   * Produces a full, consistent, priority-sorted ledger snapshot with cursor pagination.
   * Unfinished tasks are NEVER excluded by age; `includeDoneSince` only scopes completed tasks.
   */
  snapshot(options: { includeDoneSince?: string; cursor?: string; limit?: number; phase?: TaskPhase; now?: Date } = {}): LedgerSnapshot {
    const limit = options.limit === undefined ? 60 : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be 1–200');
    if (options.includeDoneSince !== undefined) {
      if (typeof options.includeDoneSince !== 'string' || !Number.isFinite(Date.parse(options.includeDoneSince))) {
        throw new HttpError(400, 'includeDoneSince must be ISO 8601');
      }
    }

    if (options.cursor) {
      const [version, rawOffset] = options.cursor.split(':');
      const offset = Number(rawOffset);
      const cached = this.snapshots.get(version);
      if (!cached || !Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'invalid or expired ledger cursor');
      const page = cached.items.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        snapshotVersion: cached.version,
        observedAt: cached.observedAt,
        totalOpen: cached.totalOpen,
        totalDoneInRange: cached.totalDoneInRange,
        coverage: cached.coverage,
        items: page,
        nextCursor: nextOffset < cached.items.length ? `${cached.version}:${nextOffset}` : null,
      };
    }

    const now = options.now ?? new Date();
    const allTodos = this.store.listTodos();
    // Unaccepted external suggestions (proposed === true) do not count as active accepted commitments.
    const accepted = allTodos.filter(todo => !todo.proposed);
    const openTodos = accepted.filter(todo => !todo.done && todo.state !== 'done');
    const doneSinceMs = options.includeDoneSince ? Date.parse(options.includeDoneSince) : null;
    const doneTodos = doneSinceMs !== null
      ? accepted.filter(todo => (todo.done || todo.state === 'done') && todo.doneAt && Date.parse(todo.doneAt) >= doneSinceMs)
      : [];

    const openViews = openTodos
      .map(todo => this.taskView(todo, now, allTodos))
      .sort((a, b) => b.priority.score - a.priority.score || b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
    const doneViews = doneTodos
      .map(todo => this.taskView(todo, now, allTodos))
      .sort((a, b) => (b.threads[0]?.updatedAt ?? '').localeCompare(a.threads[0]?.updatedAt ?? ''));

    // Count active execution items without double-counting parent goals alongside their open children.
    const totalOpen = openViews.filter(v => !v.isParentGoal).length;
    let combined = [...openViews, ...doneViews];
    if (options.phase) combined = combined.filter(v => v.phase === options.phase);

    const version = randomUUID().slice(0, 12);
    const observedAt = now.toISOString();
    const coverage = this.coverage();
    this.snapshots.set(version, { version, observedAt, items: combined, totalOpen, totalDoneInRange: doneViews.length, coverage });
    if (this.snapshots.size > 16) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest) this.snapshots.delete(oldest);
    }

    const page = combined.slice(0, limit);
    return {
      snapshotVersion: version,
      observedAt,
      totalOpen,
      totalDoneInRange: doneViews.length,
      coverage,
      items: page,
      nextCursor: page.length < combined.length ? `${version}:${page.length}` : null,
    };
  }

  private triageSignature(view: TaskView, targetThreadId: string | null): string {
    if (view.pendingRequests.length > 0) {
      return `req:${view.pendingRequests.map(r => r.requestId).join(',')}`;
    }
    const active = view.threads
      .filter(t => !t.archived && !t.superseded)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const turnRef = (targetThreadId ? this.store.recentLifecycle(targetThreadId, 1)[0]?.turnId : null) ?? active?.lastTurnId ?? String(view.rev);
    return `turn:${targetThreadId ?? active?.id ?? view.id}:${turnRef}:${view.phase}`;
  }

  /**
   * High-signal SuperAgent triage funnel for the Assistant home chip:
   * deduplicates by handover chain, drops stale/casual/paused/superseded noise,
   * suppresses recoverable errors under active supervision, and caps at Top 5.
   */
  triage(options: { limit?: number; now?: Date } = {}): SuperagentTriageView {
    const limit = options.limit === undefined ? TRIAGE_DEFAULT_LIMIT : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new HttpError(400, 'limit must be 1–20');
    const now = options.now ?? new Date();
    const shelved = this.store.hubSetting<Record<string, string>>(TRIAGE_SHELVED_KEY, {});
    const supervisionOn = this.personal.supervision.settings().enabled;
    const allTodos = this.store.listTodos();
    const openTodos = allTodos.filter(todo => !todo.proposed && !todo.done && todo.state !== 'done' && todo.lane !== 'later');

    const candidates: Array<SuperagentTriageItem & { score: number }> = [];
    const seenThreads = new Set<string>();

    const views = openTodos
      .map(todo => this.taskView(todo, now, allTodos))
      .filter(view => !view.isParentGoal && (view.phase === 'needs_user' || view.phase === 'review'))
      .sort((a, b) => (b.pendingRequests.length > 0 ? 1 : 0) - (a.pendingRequests.length > 0 ? 1 : 0)
        || b.priority.score - a.priority.score
        || (b.threads[0]?.updatedAt ?? b.observedAt).localeCompare(a.threads[0]?.updatedAt ?? a.observedAt));

    for (const view of views) {
      // Explicit `dispatch` proposals already render their own Start/Decline card in AssistantPanel.
      if (this.personal.proactive.runs(view.id).some(r => r.status === 'asking' && r.kind === 'dispatch')) continue;
      const rawThreadId = view.pendingRequests[0]?.threadId ?? view.primaryThreadId;
      const targetThreadId = rawThreadId ? this.activeSegmentId(rawThreadId) : null;
      if (targetThreadId && this.isInternalThread(targetThreadId)) continue;

      // If the tip of the handover chain moved past this older blocked segment, or is already done/archived/running unblocked, skip.
      const tip = targetThreadId ? this.manager.threadView(targetThreadId) : null;
      if (tip) {
        if (tip.archivedAt || tip.doneAt) continue;
        if (tip.status === 'running' && view.pendingRequests.length === 0 && !tip.waiting) continue;
        if (rawThreadId && targetThreadId !== rawThreadId && view.pendingRequests.length === 0) {
          const tipBlocked = tip.status === 'error' || (tip.report?.by !== 'user' && tip.report?.stage === 'blocked');
          if (!tipBlocked && view.phase !== 'review') continue;
        }
      }

      const signature = this.triageSignature(view, targetThreadId);
      if (shelved[view.id] === signature) continue;

      // Under active SuperAgent supervision, unretried runtime errors belong to SuperAgent recovery first, not user nagging.
      if (supervisionOn && view.granted && view.pendingRequests.length === 0 && tip?.status === 'error') {
        const hasAttempted = this.personal.supervision.listRecoveries(view.id).some(r => r.threadId === tip.id);
        if (!hasAttempted) continue;
      }

      const rawTitle = (tip?.title && tip.title !== 'New thread' ? tip.title : view.title)
        .replace(/(?:（接手）)+$/gu, '')
        .trim();
      if (!rawTitle || /^(?:🏓|.*PingPong|.*Pong reply test|LESSONS 每晚复盘)/iu.test(rawTitle)) continue;

      const rawSummary = (view.pendingRequests[0]?.title ?? tip?.report?.note ?? view.reason)
        .replace(/^\[进度\]\s*(?:需要你|待验收|进行中|等外部)\s*[：:]\s*/u, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!rawSummary) continue;

      if (view.pendingRequests.length === 0) {
        if (/^(?:已暂停|暂停开发|暂不处理|下轮\s*\d+|下周.*跟进|\d+\s*月\s*\d+\s*日.*跟进)/u.test(rawSummary)) continue;
        if (/(?:想听听你.*怎么样|要不要我帮你看看.*好不好读)/u.test(rawSummary)) continue;
      }

      const updatedAt = tip?.updatedAt ?? view.threads[0]?.updatedAt ?? view.observedAt;
      const explicitCommitment = view.pendingRequests.length > 0
        || view.phase === 'review'
        || view.importance === 'high'
        || view.priority.urgent
        || view.owner === 'me'
        || view.lane === 'you'
        || view.capture?.kind === 'dispatch';
      if (!explicitCommitment && now.getTime() - Date.parse(updatedAt) > TRIAGE_FRESH_DIRECT_MS) continue;

      if (targetThreadId) {
        if (seenThreads.has(targetThreadId)) continue;
        seenThreads.add(targetThreadId);
      }

      const kind: SuperagentTriageItem['kind'] = view.pendingRequests.length > 0
        ? 'approval'
        : view.phase === 'review'
          ? 'review'
          : 'needs_user';

      candidates.push({
        id: view.id,
        threadId: targetThreadId,
        title: [...rawTitle].slice(0, 48).join(''),
        summary: [...rawSummary].slice(0, 110).join(''),
        kind,
        urgent: view.priority.urgent || kind === 'approval',
        important: view.priority.important,
        updatedAt,
        score: view.priority.score + (kind === 'approval' ? 200 : 0),
      });
    }

    candidates.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    const items = candidates.slice(0, limit).map(({ score: _score, ...item }) => item);
    return {
      items,
      total: candidates.length,
      overflowCount: Math.max(0, candidates.length - items.length),
    };
  }

  /**
   * Shelves a triage item from the Assistant home chip without marking the task done in the ledger.
   * If a brand-new turn or approval arrives later, its new signature will surface normally.
   */
  shelveTriage(matterId: string): { id: string; shelved: boolean } {
    const todo = this.store.getTodo(matterId);
    if (!todo) throw new HttpError(404, 'todo not found');
    const view = this.taskView(todo);
    const rawThreadId = view.pendingRequests[0]?.threadId ?? view.primaryThreadId;
    const targetThreadId = rawThreadId ? this.activeSegmentId(rawThreadId) : null;
    const signature = this.triageSignature(view, targetThreadId);
    const map = this.store.hubSetting<Record<string, string>>(TRIAGE_SHELVED_KEY, {});
    const entries = Object.entries(map).slice(-300);
    const next = Object.fromEntries([...entries, [matterId, signature]]);
    this.store.saveHubSetting(TRIAGE_SHELVED_KEY, next);
    for (const run of this.personal.proactive.runs()) {
      if (run.status === 'asking' && run.kind !== 'dispatch' && (run.matterId === matterId || (targetThreadId && run.threadId === targetThreadId))) {
        this.personal.proactive.dismiss(run.id);
      }
    }
    return { id: matterId, shelved: true };
  }

  /**
   * Full-corpus thread search across all known sessions (including self-started, done, archived,
   * and handover chains) with deterministic scoring and cursor pagination.
   */
  searchThreads(input: Record<string, unknown>, owner?: string): ThreadSearchResult {
    const query = typeof input.query === 'string' && input.query.trim() ? input.query.trim() : null;
    const limit = input.limit === undefined ? 30 : Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be 1–200');
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'invalid cursor');

    const skip = new Set([...this.store.summaryThreadIds(), ...this.store.quietRunThreadIds()]);
    if (owner) skip.delete(owner);

    const linked = new Map<string, Array<{ id: string; text: string; done: boolean; parentId: string | null; acceptance: string; notePreview: string }>>();
    for (const todo of this.store.listTodos()) {
      for (const id of this.store.todoThreadIds(todo.id)) {
        linked.set(id, [...(linked.get(id) ?? []), {
          id: todo.id,
          text: todo.text,
          done: todo.done,
          parentId: todo.parentId,
          acceptance: todo.acceptance?.text ?? '',
          notePreview: todo.notePreview ?? '',
        }]);
      }
    }

    const terms = query ? tokenizeQuery(query) : [];
    const textHits = terms.length ? this.store.matchingTurnTextThreads(terms) : new Map<string, number>();
    let home = '';
    try { home = realpathSync(homedir()); } catch { home = homedir(); }
    const display = (path: string) => path === home ? '~' : path.startsWith(home + sep) ? '~' + path.slice(home.length) : path;

    const hits: ThreadSearchHit[] = [];
    for (const thread of this.allKnownThreads()) {
      if (skip.has(thread.id)) continue;
      if (thread.id !== owner && (this.store.isReviewThread(thread.id) || this.store.isRouterThread(thread.id))) continue;

      const repoKey = repoKeyForCwd(thread.worktree?.of ?? thread.cwd);
      const repoName = repoKey ? basename(repoKey) : '';
      const todoItems = linked.get(thread.id) ?? [];
      const summary = this.store.threadTextSummary(thread.id);
      const progressNote = thread.report?.note ?? '';

      let score = 0;
      const reasons: string[] = [];
      if (terms.length) {
        const titleLower = thread.title.toLowerCase();
        const repoLower = `${repoName} ${repoKey ?? ''} ${thread.cwd}`.toLowerCase();
        const askLower = `${summary.firstAsk ?? ''} ${summary.lastAsk ?? ''}`.toLowerCase();
        const answerLower = `${summary.lastAnswer ?? ''} ${progressNote}`.toLowerCase();
        const matterLower = todoItems.map(t => `${t.text} ${t.acceptance} ${t.notePreview}`).join(' ').toLowerCase();

        let matchedTerms = 0;
        for (const term of terms) {
          let termHit = false;
          if (titleLower.includes(term)) { score += 40; termHit = true; if (!reasons.includes('标题匹配')) reasons.push('标题匹配'); }
          if (repoLower.includes(term)) { score += 28; termHit = true; if (!reasons.includes('仓库/目录匹配')) reasons.push('仓库/目录匹配'); }
          if (matterLower.includes(term)) { score += 26; termHit = true; if (!reasons.includes('任务账本匹配')) reasons.push('任务账本匹配'); }
          if (askLower.includes(term)) { score += 22; termHit = true; if (!reasons.includes('用户原话匹配')) reasons.push('用户原话匹配'); }
          if (answerLower.includes(term)) { score += 12; termHit = true; if (!reasons.includes('回答/进度匹配')) reasons.push('回答/进度匹配'); }
          if (!termHit && (textHits.get(thread.id) ?? 0) > 0) {
            score += 10;
            termHit = true;
            if (!reasons.includes('历史对话匹配')) reasons.push('历史对话匹配');
          }
          if (termHit) matchedTerms++;
        }
        if (matchedTerms === 0) continue;
        // Full term coverage gets a strong boost so multi-word queries rank exact hits first.
        if (matchedTerms === terms.length) score += 30;
        if (!thread.archivedAt && !thread.doneAt) score += 5;
      } else {
        score = 1;
        reasons.push('最近活跃');
      }

      const view = this.manager.threadView(thread.id);
      const activeId = this.activeSegmentId(thread.id);
      // Prefer the active tip segment slightly over superseded handover predecessors on equal match.
      if (activeId === thread.id) score += 4;
      hits.push({
        id: thread.id,
        activeSegmentId: activeId,
        self: thread.id === owner,
        title: view.title,
        repoKey: repoKey ? display(repoKey) : null,
        cwd: display(view.cwd),
        agent: view.agent,
        status: view.status,
        waiting: view.waiting,
        done: Boolean(view.doneAt),
        archived: Boolean(view.archivedAt),
        updatedAt: view.updatedAt,
        progress: view.report ? { stage: view.report.stage, note: view.report.note } : null,
        firstAsk: summary.firstAsk,
        lastAsk: summary.lastAsk,
        lastAnswerEnd: summary.lastAnswer,
        matchReason: reasons.join('、') || '全量索引',
        score,
        todos: todoItems.map(({ id, text, done, parentId }) => ({ id, text, done, parentId })),
      });
    }

    hits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    const page = hits.slice(offset, offset + limit);
    return {
      query,
      total: hits.length,
      threads: page,
      nextCursor: offset + page.length < hits.length ? String(offset + page.length) : null,
    };
  }

  /** Records a user thread-open event for SuperAgent adoption metrics (Criterion 5). */
  recordThreadOpen(input: Record<string, unknown>): ThreadOpenRecord {
    const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
    if (!threadId || threadId.length > 200) throw new HttpError(400, 'threadId is required');
    const source = input.source as ThreadOpenSource;
    if (!THREAD_OPEN_SOURCES.includes(source)) throw new HttpError(400, 'invalid thread open source');
    const userInitiated = input.userInitiated !== false;
    const record: ThreadOpenRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      logicalThreadId: this.activeSegmentId(threadId),
      source,
      userInitiated,
    };
    this.store.saveThreadOpen(record);
    return record;
  }

  /** Summarizes direct non-assistant session opens per active day for Criterion 5 tracking. */
  threadOpenMetrics(days = 14) {
    const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
    const since = new Date(Date.now() - safeDays * 86400_000).toISOString();
    const routerId = this.personal.router.status().threadId;
    const records = this.store.listThreadOpens(since).filter(r => r.userInitiated && r.logicalThreadId !== routerId);
    const byDay = new Map<string, { directOpens: number; assistantLinkOpens: number; totalOpens: number; uniqueThreads: Set<string> }>();
    for (const r of records) {
      const day = r.at.slice(0, 10);
      const bucket = byDay.get(day) ?? { directOpens: 0, assistantLinkOpens: 0, totalOpens: 0, uniqueThreads: new Set<string>() };
      bucket.totalOpens++;
      if (DIRECT_OPEN_SOURCES.has(r.source)) bucket.directOpens++;
      if (r.source === 'assistant-link') bucket.assistantLinkOpens++;
      bucket.uniqueThreads.add(r.logicalThreadId);
      byDay.set(day, bucket);
    }
    const daily = [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, b]) => ({ day, directOpens: b.directOpens, assistantLinkOpens: b.assistantLinkOpens, totalOpens: b.totalOpens, uniqueThreads: b.uniqueThreads.size }));
    const activeDays = daily.length;
    const totalDirect = daily.reduce((sum, d) => sum + d.directOpens, 0);
    return {
      since,
      days: safeDays,
      activeDays,
      directOpensPerActiveDay: activeDays ? Number((totalDirect / activeDays).toFixed(2)) : 0,
      totalDirectOpens: totalDirect,
      daily,
    };
  }
}
