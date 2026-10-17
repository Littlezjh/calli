import { ApiError, type Thread, type UserInputAnswer } from '../../web/src/api';
import { DemoApi, DemoError } from '../../web/src/demo/DemoApi';
import { demoData, type DemoData } from '../../web/src/demo/data';
import type { StoredEvent } from '../../web/src/timeline';
import { SCENARIOS } from './scenarios';

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

  constructor(private readonly later: Schedule = schedule) {
    const fixture = demoData();
    super(() => Promise.resolve(fixture));
    this.fixture = fixture;
    fixture.threads = fixture.threads.filter(t => SCENARIOS.some(s => s.threadId === t.id));
    fixture.sections = [];
    fixture.todos = [];
    fixture.schedules = [];
    fixture.activity = [];
    fixture.traces = {};
    for (const thread of fixture.threads) {
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
      Object.assign(thread, { status: 'idle', waiting: false, waitingReason: undefined, unread: false, sectionId: null, preview: '选择这个任务，开始体验' });
    }
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
    const events = this.fixture.events[id];
    const run = this.runs.get(id)!;
    const event: StoredEvent = { ...structuredClone(step), threadId: id, turnId: run.turnId, seq: (events.at(-1)?.seq ?? 0) + 1, ts: new Date().toISOString() };
    events.push(event);
    for (const fn of this.streams.get(id) ?? []) fn(structuredClone(event));
    if (step.type === 'turn.done') {
      run.progress = step.data.stopReason === 'cancelled' ? 'stopped' : 'completed';
      Object.assign(this.mutableThread(id), { status: 'idle', waiting: false, waitingReason: undefined, unread: true });
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
    }, step.type === 'message.delta' ? 45 : 320);
  }

  protected override async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    if (this.disposed) throw new DemoError(method !== 'GET');
    const parts = new URL(url, 'http://demo').pathname.split('/').filter(Boolean).slice(1);
    const payload = (body ?? {}) as Record<string, unknown>;
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
