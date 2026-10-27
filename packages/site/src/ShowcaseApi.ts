import { ApiError, type Coordination, type Thread, type UserInputAnswer } from '../../web/src/api';
import type { ExtensionState } from '@calli/extension-api';
import { BUILTIN_MANIFESTS } from '../../web/src/extensions/catalog';
import { DemoApi, DemoError } from '../../web/src/demo/DemoApi';
import { demoData, type DemoData } from '../../web/src/demo/data';
import type { StoredEvent } from '../../web/src/timeline';
import { SCENARIOS } from './scenarios';
import { zh as siteCopy } from '../../web/src/i18n/locales/site/zh';
import { handoverExample, addExamples, memoryExamples, TEAM_ID, MEMBER_IDS, MEMBER_TASKS, MEMBER_RESULTS } from './exampleData';

export type Progress = 'ready' | 'running' | 'approval' | 'question' | 'completed' | 'stopped';
type Schedule = (run: () => void, delay: number) => () => void;
type Step = Pick<StoredEvent, 'type' | 'data'>;
interface Run {
  progress: Progress;
  steps: Step[];
  turnId: string;
  cancelTimer?: () => void;
}

const schedule: Schedule = (run, delay) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};

/** A separate, memory-only client. The hub's existing read-only demo keeps its original behavior. */
export class ShowcaseApi extends DemoApi {
  private readonly fixture: DemoData;
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<() => void>();
  private readonly broadcasts = new Set<() => void>();
  private readonly streams = new Map<string, Set<(event: StoredEvent) => void>>();
  private readonly closeStreams = new Set<() => void>();
  private disposed = false;
  private readonly exampleTeam: Coordination;
  private readonly memory = memoryExamples();

  constructor(private readonly later: Schedule = schedule, private readonly focusedThreadId?: string | null) {
    const fixture = demoData();
    super(() => Promise.resolve(fixture));
    this.fixture = fixture;
    fixture.threads = fixture.threads.filter(t => SCENARIOS.some(s => s.threadId === t.id));
    this.exampleTeam = addExamples(fixture);
    fixture.sections = [];
    fixture.todos = [];
    fixture.schedules = [];
    fixture.activity = [];
    fixture.traces = {};
    for (const thread of fixture.threads) {
      if (!SCENARIOS.some(s => s.threadId === thread.id)) continue;
      const source = fixture.events[thread.id];
      const steps: Step[] = [];
      for (const event of source) {
        if (['thread.created', 'turn.started', 'input.resolved'].includes(event.type)) continue;
        if (event.type === 'message.delta') {
          const chars = Array.from(String(event.data.text));
          for (let i = 0; i < chars.length; i += 20) steps.push({ type: event.type, data: { text: chars.slice(i, i + 20).join('') } });
        } else steps.push({ type: event.type, data: structuredClone(event.data) });
      }
      this.runs.set(thread.id, { progress: 'ready', steps, turnId: `showcase-${thread.id}` });
      fixture.events[thread.id] = source.filter(e => e.type === 'thread.created');
      Object.assign(thread, { status: 'idle', waiting: false, waitingReason: undefined, unread: false, sectionId: null, doneAt: null, report: null, preview: '选择这个任务，开始体验' });
    }
    this.runs.get(TEAM_ID)!.steps = [
      { type: 'message.delta', data: { text: '我来拆解任务和验收。Codex 负责实现，pi 独立审查，结果会回到这个主会话。' } },
      { type: 'showcase.delegate', data: {} },
      { type: 'message.delta', data: { text: '\n\n已派给两位成员。点击右上角的智能体入口，可以查看各自的任务、过程和往来消息。' } },
      { type: 'showcase.return', data: { index: 0 } },
      { type: 'message.delta', data: { text: '\n\nCodex 已返回：主题切换与偏好保存已实现。pi 正在核对验收结果。' } },
      { type: 'showcase.return', data: { index: 1 } },
      { type: 'message.delta', data: { text: '\n\n## 协作结果\n\n- **Codex 实现**：补上主题切换、系统跟随与刷新后恢复。\n- **pi 审查**：检查状态保存、键盘操作和手机布局，示例审查未发现阻塞问题。\n- **主控汇总**：两位成员的结果已汇总，等你验收。\n\n这是一段本地模拟，没有启动真实 agent 或修改文件。' } },
      { type: 'turn.done', data: { stopReason: 'end_turn' } },
    ];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  progress = (threadId: string | null): Progress => this.runs.get(threadId ?? '')?.progress ?? 'ready';

  private changed(): void {
    for (const fn of this.listeners) fn();
    for (const fn of this.broadcasts) fn();
  }

  private mutableThread(id: string): Thread {
    const thread = this.fixture.threads.find(t => t.id === id);
    if (!thread) throw new DemoError(true);
    return thread;
  }

  private emit(id: string, step: Step): void {
    if (this.disposed) return;
    if (step.type === 'showcase.delegate') {
      this.mutableThread(TEAM_ID).coordination = { rootId: TEAM_ID, children: 2, paused: false };
      this.exampleTeam.members.forEach((member, i) => {
        Object.assign(member.thread!, { status: 'running', runningSince: new Date().toISOString() });
        member.latest = { id: `sample-task-${i}`, from: TEAM_ID, to: member.id, text: MEMBER_TASKS[i], kind: 'message', state: 'running', result: '', createdAt: new Date().toISOString(), turnId: `showcase-${member.id}` };
        this.exampleTeam.messages.push(member.latest);
        this.emit(member.id, { type: 'turn.started', data: { text: MEMBER_TASKS[i] } });
        this.emit(member.id, { type: 'message.delta', data: { text: i ? '正在独立检查主题保存、键盘选择和手机布局。' : '正在补充主题选择和本地偏好恢复。' } });
      });
      this.changed();
      return;
    }
    if (step.type === 'showcase.return') {
      const i = Number(step.data.index);
      const member = this.exampleTeam.members[i];
      Object.assign(member.latest!, { state: 'returned', result: MEMBER_RESULTS[i] });
      this.emit(member.id, { type: 'message.delta', data: { text: `\n\n${MEMBER_RESULTS[i]}` } });
      this.emit(member.id, { type: 'turn.done', data: { stopReason: 'end_turn' } });
      return;
    }
    const events = this.fixture.events[id];
    const run = this.runs.get(id);
    const event: StoredEvent = { ...structuredClone(step), threadId: id, turnId: run?.turnId ?? `showcase-${id}`, seq: (events.at(-1)?.seq ?? 0) + 1, ts: new Date().toISOString() };
    events.push(event);
    for (const fn of this.streams.get(id) ?? []) fn(structuredClone(event));
    if (step.type === 'turn.done') {
      if (run) run.progress = step.data.stopReason === 'cancelled' ? 'stopped' : 'completed';
      Object.assign(this.mutableThread(id), { status: 'idle', waiting: false, waitingReason: undefined, unread: true, updatedAt: event.ts,
        report: { stage: 'review', note: step.data.stopReason === 'cancelled' ? '示例已停止，可重新体验。' : '本轮已返回，请验收结果。', at: event.ts } });
    }
    this.changed();
  }

  private advance(id: string): void {
    const run = this.runs.get(id)!;
    if (this.disposed || run.progress !== 'running') return;
    const step = run.steps.shift();
    if (!step) return;
    run.cancelTimer = this.later(() => {
      run.cancelTimer = undefined;
      if (this.disposed || run.progress !== 'running') return;
      if (step.type === 'approval.request' || step.type === 'input.request') {
        run.progress = step.type === 'approval.request' ? 'approval' : 'question';
        Object.assign(this.mutableThread(id), { waiting: true, waitingReason: run.progress === 'approval' ? 'approval' : 'question' });
      }
      this.emit(id, step);
      this.advance(id);
    }, step.type.startsWith('showcase.') ? 1400 : step.type === 'message.delta' ? 45 : 320);
  }

  protected override async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    if (this.disposed) throw new DemoError(method !== 'GET');
    const parts = new URL(url, 'http://demo').pathname.split('/').filter(Boolean).slice(1);
    const payload = (body ?? {}) as Record<string, unknown>;
    if (method === 'GET' && parts[0] === 'threads' && !parts[1] && this.focusedThreadId !== undefined) {
      return structuredClone(this.fixture.threads.filter(t => ['showcase-progress', 'showcase-blocked', 'showcase-review', 'showcase-done'].includes(t.id)
        || t.id === this.focusedThreadId || (this.focusedThreadId === TEAM_ID && MEMBER_IDS.includes(t.id)))) as T;
    }
    if (method === 'GET' && parts[0] === 'extensions' && !parts[1]) {
      return BUILTIN_MANIFESTS.map(manifest => ({ manifest, source: 'builtin', installed: true, enabled: true, granted: [...manifest.permissions], installedAt: null, updatedAt: null } satisfies ExtensionState)) as T;
    }
    if (method === 'GET' && parts[0] === 'extensions' && parts[1] === 'memory' && parts[2] === 'memory') {
      if (parts[3] === 'sources') return structuredClone(this.memory.sources) as T;
      if (parts[3] !== 'sample-codex') throw new DemoError(false);
      if (parts[4] === 'files') return structuredClone({ state: 'available', files: this.memory.files, partial: false, checkedAt: new Date().toISOString() }) as T;
      if (parts[4] === 'document') {
        const document = this.memory.documents.find(d => d.id === new URL(url, 'http://demo').searchParams.get('id'));
        if (!document) throw new DemoError(false);
        return structuredClone(document) as T;
      }
    }
    if (method === 'GET' && parts[0] === 'threads' && parts[2] === 'coordination' && [TEAM_ID, ...MEMBER_IDS].includes(parts[1])) {
      return structuredClone(this.mutableThread(TEAM_ID).coordination ? this.exampleTeam : null) as T;
    }
    if (method === 'PATCH' && parts[0] === 'threads' && parts.length === 2 && Object.keys(payload).join() === 'done' && typeof payload.done === 'boolean') {
      const thread = this.mutableThread(parts[1]);
      thread.doneAt = payload.done ? new Date().toISOString() : null;
      this.changed();
      return structuredClone(thread) as T;
    }
    if (method === 'POST' && parts[0] === 'threads' && parts[2] === 'turns') {
      const id = parts[1];
      const scenario = SCENARIOS.find(s => s.threadId === id);
      const run = this.runs.get(id);
      if (!run || !scenario || payload.text !== scenario.prompt || payload.images || payload.videos || payload.mentions) throw new DemoError(true);
      if (run.progress !== 'ready') throw new ApiError('请重新体验这个任务。', {}, 409);
      run.progress = 'running';
      Object.assign(this.mutableThread(id), { status: 'running', preview: scenario.prompt, updatedAt: new Date().toISOString() });
      this.emit(id, { type: 'turn.started', data: { text: scenario.prompt, workMode: this.mutableThread(id).workMode } });
      this.advance(id);
      return { turnId: run.turnId } as T;
    }
    if (method === 'POST' && parts[0] === 'threads' && parts[2] === 'cancel') {
      const run = this.runs.get(parts[1]);
      if (!run || !['running', 'approval', 'question'].includes(run.progress)) throw new DemoError(true);
      run.cancelTimer?.();
      if (parts[1] === TEAM_ID) for (const member of this.exampleTeam.members) {
        if (member.latest?.state === 'running') {
          member.latest.state = 'stopped';
          this.emit(member.id, { type: 'turn.done', data: { stopReason: 'cancelled' } });
        }
      }
      if (run.progress === 'approval') this.emit(parts[1], { type: 'approval.resolved', data: { approvalId: 'demo-approval', decision: { cancelled: true } } });
      if (run.progress === 'question') this.emit(parts[1], { type: 'input.resolved', data: { inputId: 'demo-question', answer: { cancelled: true } } });
      this.emit(parts[1], { type: 'turn.done', data: { stopReason: 'cancelled' } });
      return { dropped: [] } as T;
    }
    if (method === 'POST' && parts[0] === 'approvals' && parts[1] === 'demo-approval') {
      const id = 'demo-scroll-fix';
      const run = this.runs.get(id)!;
      if (run.progress !== 'approval') throw new ApiError('这个审批已经处理。', {}, 409);
      if (!payload.cancel && !['allow', 'always', 'reject'].includes(String(payload.optionId))) throw new DemoError(true);
      const allowed = !payload.cancel && payload.optionId !== 'reject';
      run.progress = 'running';
      Object.assign(this.mutableThread(id), { waiting: false, waitingReason: undefined });
      this.emit(id, { type: 'approval.resolved', data: { approvalId: 'demo-approval', decision: payload.cancel ? { cancelled: true } : { optionId: payload.optionId } } });
      run.steps.push(
        ...(allowed ? [
          { type: 'tool.start', data: { id: 'showcase-test', title: 'npm run e2e -- product-list', kind: 'execute', input: { command: 'npm run e2e -- product-list' } } },
          { type: 'tool.end', data: { id: 'showcase-test', status: 'completed', output: '示例结果：3 个测试通过，滚动位置保持稳定。' } },
        ] : []),
        { type: 'message.delta', data: { text: allowed ? '测试通过。图片加载后会重新测量行高，滚动位置保持稳定。你可以展开上面的改动看看。' : '收到，这次不运行测试。代码改动已展示在上方，测试结果尚未验证。' } },
        { type: 'turn.done', data: { stopReason: 'end_turn' } },
      );
      this.advance(id);
      return undefined as T;
    }
    if (method === 'POST' && parts[0] === 'inputs' && parts[1] === 'demo-question') {
      const id = 'demo-routes';
      const run = this.runs.get(id)!;
      if (run.progress !== 'question') throw new ApiError('这个问题已经回答。', {}, 409);
      const answer = payload as UserInputAnswer;
      const choice = 'answers' in answer ? answer.answers?.layout?.[0] : undefined;
      if (!('cancelled' in answer) && !['按文件', '集中一张表'].includes(choice ?? '')) throw new ApiError('请选择一个示例选项。', {}, 400);
      this.emit(id, { type: 'input.resolved', data: { inputId: 'demo-question', answer } });
      Object.assign(this.mutableThread(id), { waiting: false, waitingReason: undefined });
      if ('cancelled' in answer) {
        this.emit(id, { type: 'turn.done', data: { stopReason: 'cancelled' } });
      } else {
        if (choice === '集中一张表') {
          const plan = run.steps.find(s => s.type === 'plan.completed');
          if (plan) plan.data.text = '## 迁移到集中声明的路由表\n\n1. 保留一个路由入口，将 32 个接口整理为声明式配置。\n2. 按资源分组，每项明确方法、路径和处理函数。\n3. 逐组迁移，每次运行接口测试。\n4. 核对路径兼容性，更新接口说明。\n\n这是讨论方案，本轮没有修改文件。';
        }
        run.progress = 'running';
        this.changed();
        this.advance(id);
      }
      return undefined as T;
    }
    return super.send(method, url, body);
  }

  override stream<T>(path: string, onEvent: (event: T) => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposed) return Promise.resolve();
    const url = new URL(path, 'http://demo');
    const id = /^\/api\/threads\/([^/]+)\/stream$/.exec(url.pathname)?.[1];
    return new Promise(resolve => {
      const global = () => onEvent({} as T);
      const listener = (event: StoredEvent) => onEvent(event as T);
      const listeners = id ? (this.streams.get(id) ?? new Set()) : null;
      if (id && listeners) {
        this.streams.set(id, listeners);
        listeners.add(listener);
        for (const event of this.fixture.events[id] ?? []) {
          if (event.seq > Number(url.searchParams.get('after') ?? 0)) listener(structuredClone(event));
        }
      } else if (url.pathname === '/api/stream') this.broadcasts.add(global);
      const close = () => {
        listeners?.delete(listener);
        this.broadcasts.delete(global);
        signal.removeEventListener('abort', close);
        this.closeStreams.delete(close);
        resolve();
      };
      this.closeStreams.add(close);
      signal.addEventListener('abort', close, { once: true });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) run.cancelTimer?.();
    for (const close of this.closeStreams) close();
    this.listeners.clear();
    this.broadcasts.clear();
    this.streams.clear();
  }
}

export type HandoverBranch = 'account' | 'model';
export type HandoverPhase = 'ready' | 'finishing' | 'preparing' | 'countdown' | 'completed' | 'cancelled';
export interface HandoverSnapshot {
  branch: HandoverBranch;
  phase: HandoverPhase;
  source: Thread;
  current: Thread;
  sourceEvents: StoredEvent[];
  nextEvents: StoredEvent[];
}

/** A bounded local playback: no daemon, model calls or visitor account data. */
export class HandoverShowcaseApi extends DemoApi {
  private readonly listeners = new Set<() => void>();
  private cancelTimer?: () => void;
  private disposed = false;
  private value: HandoverSnapshot;
  private summaryReady = false;
  private readonly example = handoverExample();
  constructor(private readonly later: Schedule = schedule) {
    super();
    this.value = this.initial('account');
  }
  private initial(branch: HandoverBranch): HandoverSnapshot {
    const source = structuredClone(this.example.source);
    source.title = siteCopy.handoverThread;
    return { branch, phase: 'ready', source, current: source, sourceEvents: [], nextEvents: [] };
  }
  snapshot = (): HandoverSnapshot => this.value;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<HandoverSnapshot>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    for (const fn of this.listeners) fn();
  }
  reset(branch: HandoverBranch = this.value.branch) {
    this.cancelTimer?.();
    this.summaryReady = false;
    this.update(this.initial(branch));
  }
  private event(type: string, data: StoredEvent['data'], turnId: string, next = false) {
    const key = next ? 'nextEvents' : 'sourceEvents';
    const events = this.value[key];
    this.update({ [key]: [...events, { type, data, turnId, seq: events.length + 1, ts: new Date().toISOString(), threadId: next ? this.value.current.id : this.value.source.id }] });
  }
  private after(delay: number, fn: () => void) {
    this.cancelTimer = this.later(() => { this.cancelTimer = undefined; if (!this.disposed) fn(); }, delay);
  }
  start() {
    if (this.disposed || this.value.phase !== 'ready') return;
    this.update({ phase: 'finishing' });
    this.event('turn.started', { text: siteCopy.handoverTask }, 'sample-work');
    this.after(900, () => {
      this.event('message.delta', { text: siteCopy.handoverFirstReply }, 'sample-work');
      this.event('turn.done', { stopReason: 'end_turn' }, 'sample-work');
      if (this.value.branch === 'model') { this.countdown(); return; }
      this.update({ phase: 'preparing', current: { ...this.value.source, autoHandover: { ...this.value.source.autoHandover!, state: 'preparing' } } });
      this.event('history.handover', { target: 'Claude Code 2', done: false, version: 1 }, 'sample-summary');
      this.after(1600, () => {
        this.event('history.handover', { target: 'Claude Code 2', done: true, version: 2 }, 'sample-summary');
        this.countdown();
      });
    });
  }
  private countdown() {
    this.summaryReady = this.value.branch === 'account';
    this.update({ phase: 'countdown', current: { ...this.value.source, autoHandover: {
      ...this.value.source.autoHandover!, state: 'countdown', reason: 'near', deadline: new Date(Date.now() + 5000).toISOString(),
      target: this.value.branch === 'model' ? { agent: 'claude', model: 'Sonnet' } : { agent: 'sample-claude-2' },
    } } });
    this.after(5000, () => {
      const model = this.value.branch === 'model';
      this.update({ phase: 'completed', current: { ...(model ? this.value.source : this.example.successor), title: siteCopy.handoverThread, model: model ? 'Sonnet' : 'Opus', autoHandover: { enabled: true, source: 'thread', override: true } } });
      if (model) this.event('handover.model', { model: 'Sonnet', previous: 'Opus', reason: 'near' }, 'sample-continue', true);
      this.event('turn.started', { text: '', handoverCollapsed: true }, 'sample-continue', true);
      this.event('message.delta', { text: model ? siteCopy.handoverModelReply : siteCopy.handoverNextReply }, 'sample-continue', true);
      this.event('turn.done', { stopReason: 'end_turn' }, 'sample-continue', true);
    });
  }
  override async cancelAutoHandover(id: string) {
    if (id !== this.value.current.id || !['preparing', 'countdown'].includes(this.value.phase)) throw new DemoError(true);
    this.cancelTimer?.();
    if (this.value.phase === 'preparing') this.event('history.handover', { target: 'Claude Code 2', done: true, version: 2 }, 'sample-summary');
    this.update({ phase: 'cancelled', current: this.value.source });
    return this.value.current.autoHandover!;
  }
  override async historySummary(id: string, turn: string) {
    if (id !== this.value.source.id || turn !== 'sample-summary' || !this.value.sourceEvents.some(e => e.type === 'history.handover')) throw new DemoError(false);
    return { prompt: siteCopy.handoverSummaryPrompt, text: this.summaryReady ? siteCopy.handoverSummaryText : '', snapshotSeq: this.value.sourceEvents.length, nextOffset: null };
  }
  dispose() { this.disposed = true; this.cancelTimer?.(); this.listeners.clear(); }
}
