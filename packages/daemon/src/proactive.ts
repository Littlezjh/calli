import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter } from './adapters/types.js';
import { turnAnswer } from './coordination.js';
import { HttpError } from './errors.js';
import type { StoredEvent } from './events.js';
import { turnOutcome } from './lifecycle.js';
import type { PersonalService } from './personal.js';
import { ProactiveSandbox, type SandboxChanges } from './proactive-sandbox.js';
import { urgencyOf, type Store, type TodoRecord } from './store.js';
import type { ThreadManager } from './threads.js';
import { isWithinWorkdirs } from './workdirs.js';

export type ProactiveMode = 'off' | 'observe' | 'auto';
const MODES: ProactiveMode[] = ['off', 'observe', 'auto'];
export interface ProactiveSettings {
  mode: ProactiveMode;
  repos: string[];
  /** Read-only compatibility for clients of the old switch: on whenever proactive may act at all. */
  enabled: boolean;
}
export interface ProactiveRun {
  id: string;
  matterId: string;
  kind: 'prepare' | 'sandbox';
  repo?: string;
  branch?: string;
  /** Empty while setting up, when setup fails before a worker can be created, or for an observation. */
  threadId: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'observed' | 'approved' | 'ready' | 'merged' | 'discarded' | 'reverted' | 'failed';
  summary?: string;
  /** Why a sandbox round ended silently: failed tests or nothing reviewable. An observation needs no reason. */
  discardReason?: string;
  testReport?: string;
  files?: SandboxChanges['files'];
}
const SETTINGS = 'personalProactiveSettings';
/** Shared with the review's watchdog, which reads the same record. */
export const PROACTIVE_RUNS_KEY = 'personalProactiveRuns';
const RUNS = PROACTIVE_RUNS_KEY;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** What a worker's "## 测试结果" section must say to count as a failure; anything else passes. */
const TEST_FAILED = /失败|failed|not ok/i;
const exec = promisify(execFile);
const localDay = (now: Date) => `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
const minutes = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Time-sensitive preparation only; a pin alone does not invent a deadline or a meeting. */
export function preparationCandidate(todo: TodoRecord, note: string, now: Date): boolean {
  if (todo.done || todo.state === 'done' || todo.proposed || note.includes('已备好')) return false;
  const meeting = todo.source?.type === 'lark-calendar' && Boolean(todo.source.at)
    && localDay(new Date(todo.source.at!)) === localDay(now);
  const soon = Boolean(todo.dueAt) && Date.parse(todo.dueAt!) <= now.getTime() + 48 * HOUR;
  return (todo.importance === 'high' || urgencyOf(todo, now).urgent || meeting) && (soon || meeting);
}

const dayLabel = (due: Date, now: Date) => {
  if (localDay(due) === localDay(now)) return '今天';
  if (localDay(due) === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return '明天';
  return `${due.getFullYear()}-${due.getMonth() + 1}-${due.getDate()} `;
};

/** Why this matter is worth preparing for, in plain words a person can judge at a glance. */
function prepareReasons(todo: TodoRecord, now: Date): string[] {
  const meeting = todo.source?.type === 'lark-calendar' && Boolean(todo.source.at)
    && localDay(new Date(todo.source.at!)) === localDay(now);
  const reasons: string[] = [];
  if (todo.importance === 'high') reasons.push('重要');
  if (todo.dueAt) reasons.push(`${dayLabel(new Date(todo.dueAt), now)}截止`);
  else if (urgencyOf(todo, now).urgent) reasons.push('紧急');
  if (meeting) reasons.push('今天有日程');
  return reasons;
}

/** What would be done and why, assembled from the same rules that picked the candidate; no model call. */
function observationSummary(todo: TodoRecord, kind: ProactiveRun['kind'], repo: string | undefined, now: Date): string {
  if (kind === 'sandbox') return `会在 ${repo!.split('/').pop()} 的沙盒里继续「${todo.text}」：你之前开始过这件事`;
  return `会为「${todo.text}」提前准备材料：${prepareReasons(todo, now).join('，')}`;
}

/** One shared scheduler drives this service; only a worker's ending reads its answer and files. */
export class ProactiveService {
  private ticking = false;
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly turns = new Map<string, string>();
  private readonly acting = new Set<string>();

  constructor(private readonly store: Store, private readonly manager: ThreadManager,
    private readonly personal: PersonalService, private readonly adapters: Map<string, AgentAdapter>,
    private readonly sandbox = new ProactiveSandbox()) {
    manager.subscribe(event => this.onEvent(event));
  }

  /** Legacy stored switches ({ enabled }) migrate on read: on meant acting, so it becomes auto. */
  settings(): ProactiveSettings {
    const stored = this.store.hubSetting<{ mode?: ProactiveMode; enabled?: boolean; repos?: string[] }>(SETTINGS, {});
    const mode = stored.mode ?? (stored.enabled === true ? 'auto' : 'off');
    return { mode, repos: stored.repos ?? [], enabled: mode !== 'off' };
  }
  runs(matterId?: string): ProactiveRun[] {
    const runs = this.store.hubSetting<ProactiveRun[]>(RUNS, []);
    return matterId === undefined ? runs : runs.filter(run => run.matterId === matterId);
  }
  /** Matters a person can still look into: a discarded run left nothing behind, so it does not light the desk. */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const run of this.runs()) if (run.status !== 'discarded') counts[run.matterId] = (counts[run.matterId] ?? 0) + 1;
    return counts;
  }

  /** A person's verdict on an observation: kept as feedback, never a trigger to execute. */
  approve(id: string): ProactiveRun {
    const run = this.get(id);
    if (run.status !== 'observed') throw new HttpError(409, '只有观察记录可以标记');
    return this.update(id, { status: 'approved' });
  }

  async save(input: Record<string, unknown>): Promise<ProactiveSettings> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请提供主动行动设置对象');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, '主动行动开关必须是开或关');
    if (input.mode !== undefined && !MODES.includes(input.mode as ProactiveMode)) throw new HttpError(400, '主动行动模式必须是 off、observe 或 auto');
    if (input.repos !== undefined && (!Array.isArray(input.repos) || input.repos.some(repo => typeof repo !== 'string' || !isAbsolute(repo)))) {
      throw new HttpError(400, '允许的仓库必须是绝对路径列表');
    }
    let repos: string[] | undefined;
    if (input.repos !== undefined) {
      repos = [];
      for (const path of input.repos as string[]) {
        let repo: string;
        try { repo = realpathSync(path); if (!statSync(repo).isDirectory()) throw new Error(); }
        catch { throw new HttpError(400, `仓库目录不存在：${path}`); }
        if (!isWithinWorkdirs(repo, this.manager.allowedWorkdirs)) throw new HttpError(403, `仓库不在允许的工作目录内：${path}`);
        let root: string;
        try { root = realpathSync((await exec('git', ['rev-parse', '--show-toplevel'], { cwd: repo })).stdout.trim()); }
        catch { throw new HttpError(400, `目录不是可用的 git 仓库：${path}`); }
        if (repo !== root) throw new HttpError(400, `请选择 git 仓库根目录：${root}`);
        if (!repos.includes(repo)) repos.push(repo);
      }
    }
    // Read the current settings only after git validation awaited I/O, so a concurrent patch survives.
    const current = this.settings();
    // An old client turning the switch on lands in observe first; an explicit mode wins over it.
    const mode: ProactiveMode = input.mode !== undefined ? input.mode as ProactiveMode
      : input.enabled !== undefined ? (input.enabled ? 'observe' : 'off') : current.mode;
    const repos0 = repos ?? current.repos;
    this.store.saveHubSetting(SETTINGS, { mode, repos: repos0 });
    return { mode, repos: repos0, enabled: mode !== 'off' };
  }

  private saveRun(run: ProactiveRun): void {
    const runs = this.runs();
    const index = runs.findIndex(candidate => candidate.id === run.id);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    this.store.saveHubSetting(RUNS, runs.slice(-200));
    this.manager.broadcastTodo();
  }
  private update(id: string, patch: Partial<ProactiveRun>): ProactiveRun {
    const run = { ...this.get(id), ...patch };
    this.saveRun(run);
    return run;
  }
  private get(id: string): ProactiveRun {
    const run = this.runs().find(candidate => candidate.id === id);
    if (!run) throw new HttpError(404, '找不到这次主动行动记录');
    return run;
  }

  /** A dead worker cannot remain "running" forever after a restart or missed ending. */
  recover(now = new Date()): void {
    if (this.ticking) return;
    for (const run of this.runs()) {
      if (run.status !== 'running' || this.finishing.has(run.id) || this.store.getThread(run.threadId)?.status === 'running') continue;
      this.turns.delete(run.id);
      this.update(run.id, { status: 'failed', endedAt: now.toISOString(), summary: '主动行动被中断，工作线程已结束；请查看线程后重试' });
    }
  }

  private busy(): boolean {
    return [...this.store.listThreads(), ...this.store.listThreads({ archived: true })].some(thread => thread.status === 'running');
  }
  private quiet(now: Date): boolean {
    // This is exactly the source used by PersonalBriefSchedule, including user edits.
    const quiet = this.personal.review.status().quietHours;
    const start = minutes(quiet.start), end = minutes(quiet.end), current = now.getHours() * 60 + now.getMinutes();
    return start !== end && (start < end ? current >= start && current < end : current >= start || current < end);
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.recover(now);
    const settings = this.settings();
    if (settings.mode === 'off' || this.quiet(now) || this.busy() || this.finishing.size || this.acting.size) return;
    const runs = this.runs();
    if (runs.some(run => now.getTime() - Date.parse(run.startedAt) < HOUR)) return;
    // Observations keep the hour honest but are free: they never consume a daily limit.
    const today = runs.filter(run => !['observed', 'approved'].includes(run.status) && localDay(new Date(run.startedAt)) === localDay(now));
    const todos = this.store.listTodos().filter(todo => !todo.done && todo.state !== 'done' && !todo.proposed
      && !runs.some(run => run.matterId === todo.id && run.status === 'running'));
    let candidate: { todo: TodoRecord; kind: ProactiveRun['kind']; repo?: string } | undefined;
    if (today.filter(run => run.kind === 'prepare').length < 5) {
      const todo = todos.find(todo => !runs.some(run => run.matterId === todo.id && run.kind === 'prepare' && run.status === 'ready')
        && preparationCandidate(todo, this.store.todoNote(todo.id).text, now));
      if (todo) candidate = { todo, kind: 'prepare' };
    }
    if (!candidate && today.filter(run => run.kind === 'sandbox').length < 2) {
      for (const todo of todos) {
        // A merged result remains available for withdrawal; do not silently mutate its branch.
        if (runs.some(run => run.matterId === todo.id && run.kind === 'sandbox' && ['ready', 'merged'].includes(run.status))) continue;
        const repo = settings.repos.find(repo => isWithinWorkdirs(repo, this.manager.allowedWorkdirs)
          && this.store.todoThreadIds(todo.id).some(id => {
            const thread = this.store.getThread(id);
            return thread && !runs.some(run => run.threadId === id) && isWithinWorkdirs(thread.cwd, [repo]);
          }));
        if (repo) { candidate = { todo, kind: 'sandbox', repo }; break; }
      }
    }
    if (!candidate) return;
    if (settings.mode === 'observe') { this.observe(candidate, now); return; }
    this.ticking = true;
    try { await this.start(candidate.todo, candidate.kind, now, candidate.repo); }
    finally { this.ticking = false; }
  }

  /** Record what would be done and why, start nothing; one record per matter and kind per day. */
  private observe(candidate: { todo: TodoRecord; kind: ProactiveRun['kind']; repo?: string }, now: Date): void {
    const { todo, kind, repo } = candidate;
    if (this.runs().some(run => run.matterId === todo.id && run.kind === kind && ['observed', 'approved'].includes(run.status)
      && now.getTime() - Date.parse(run.startedAt) < DAY)) return;
    this.saveRun({ id: randomUUID(), matterId: todo.id, kind, ...(repo ? { repo } : {}), threadId: '',
      startedAt: now.toISOString(), status: 'observed', summary: observationSummary(todo, kind, repo, now) });
  }

  private async start(todo: TodoRecord, kind: ProactiveRun['kind'], now: Date, repo?: string): Promise<void> {
    const run: ProactiveRun = { id: randomUUID(), matterId: todo.id, kind, ...(repo ? { repo } : {}), threadId: '', startedAt: now.toISOString(), status: 'running' };
    this.saveRun(run);
    let createdThreadId = '';
    try {
      const settings = await this.personal.resolvedSettings();
      const adapter = settings.agent ? this.adapters.get(settings.agent) : undefined;
      if (!adapter) throw new HttpError(409, '没有可用的私人 agent，请先在私人设置选择');
      const artifacts = kind === 'prepare' ? await this.personal.artifacts(todo.id) : undefined;
      const sandbox = repo ? await this.sandbox.prepare(repo, todo.id) : undefined;
      if (sandbox) this.update(run.id, { branch: sandbox.branch });
      // Settings and threads may change while preparing git or discovering the agent.
      if (this.settings().mode === 'off' || repo && !this.settings().repos.includes(repo)) throw new HttpError(409, '主动行动已关闭或该仓库已移出允许列表');
      if (this.busy()) throw new HttpError(409, '有工作线程正在运行，本次主动行动未启动');
      const thread = await this.manager.createThread({ agent: settings.agent!, cwd: sandbox?.root ?? settings.directory,
        title: todo.text, permissionMode: adapter.capabilities.defaultPermissionMode, ...(settings.model ? { model: settings.model } : {}) });
      this.update(run.id, { threadId: thread.id });
      createdThreadId = thread.id;
      const note = this.store.todoNote(todo.id).text || '尚未写入。';
      const prompt = kind === 'prepare'
        ? `由 Calli 发起的提前准备。\n事项：${todo.text}\nID：${todo.id}\n材料目录：${artifacts}\n接续说明：\n${note}\n\n按接续说明提前备好回复草稿、会前提纲或其他值得准备的材料，只写材料目录下的文件。这个目录中的 artifacts 是本轮唯一允许直接写入的事项材料，matter.md 仍只由 Calli 管理。\n先用 calli todo show ${todo.id} 读取最新 rev；产出写入 ${artifacts}/<名称>.md，再用 calli todo update ${todo.id} --rev N --note-file FILE 在接续说明记一句「已备好 X」，保留原有说明。\n不发消息、不推送、不删除、不改外部仓库，不做任何对外动作。不要自行 git 提交，Calli 会为材料留底。没有值得准备的材料就安静结束，不凑内容、不通知。结束回复只写材料摘要。`
        : `由 Calli 发起的沙盒动手。\n事项：${todo.text}\nID：${todo.id}\n接续说明：\n${note}\n\n这是独立 worktree 沙盒；只按接续说明推进已由人开始的工作。每个提交必须带 git trailer：\nCalli-Proactive: ${todo.id}\n\n跑该仓库测试；只改当前沙盒，不动主工作区、不推送远端、不发消息、不做其他对外动作。只在此沙盒提交改动。不要查看其他 agent 会话，也不要修改它们的目录或配置。结束回复按「## 改动摘要」「## 测试结果」两段写清实际改动、执行的测试和结果；没有运行测试也要写清原因。`;
      await this.manager.startTurn(thread.id, { text: prompt, scheduled: true, proactive: true }, undefined, false, undefined, turnId => {
        if (this.busy()) throw new HttpError(409, '有工作线程正在运行，本次主动行动未启动');
        if (this.settings().mode === 'off' || repo && !this.settings().repos.includes(repo)) throw new HttpError(409, '主动行动设置已改变，本次未启动');
        this.personal.linkWorkThread(todo.id, thread.id, todo.rev);
        this.turns.set(run.id, turnId);
      });
    } catch (error) {
      this.turns.delete(run.id);
      // A thread whose turn never started is an empty shell on the matter; remove it, as delegate does.
      if (createdThreadId && !this.store.listEventsOfType(createdThreadId, 'turn.started').length) await this.manager.deleteThread(createdThreadId).catch(() => undefined);
      this.update(run.id, { status: 'failed', endedAt: new Date().toISOString(), summary: message(error) });
    }
  }

  private onEvent(event: StoredEvent): void {
    const outcome = turnOutcome(event);
    if (!outcome || outcome.imported || outcome.fromTerminal || !event.turnId) return;
    const run = this.runs().find(run => run.status === 'running' && run.threadId === event.threadId && this.turns.get(run.id) === event.turnId);
    if (!run || this.finishing.has(run.id)) return;
    // Reserve synchronously so a tick cannot mistake an asynchronously collected result for a crash.
    const finish = Promise.resolve().then(() => this.finish(run, event)).catch(error => {
      this.update(run.id, { status: 'failed', endedAt: event.ts, summary: message(error) });
    }).finally(() => { this.finishing.delete(run.id); this.turns.delete(run.id); });
    this.finishing.set(run.id, finish);
  }

  private async finish(run: ProactiveRun, event: StoredEvent): Promise<void> {
    const outcome = turnOutcome(event)!;
    if (outcome.outcome !== 'ok') {
      this.update(run.id, { status: 'failed', endedAt: event.ts, summary: outcome.message ?? '主动行动已停止，尚未备好可审阅的结果' });
      return;
    }
    const answer = turnAnswer(this.store.voiceAnswerEvents(run.threadId, event.turnId!), event.turnId!).trim();
    if (run.kind === 'prepare' && this.store.getThread(run.threadId)?.cwd !== this.personal.directory()) {
      throw new HttpError(409, '私人目录已改变，材料仍在原工作线程目录中，尚未自动提交');
    }
    const files = run.kind === 'prepare' ? await this.personal.commitArtifacts(run.matterId) : (await this.sandbox.changes(run.repo!, run.matterId)).files;
    const testReport = run.kind === 'sandbox' ? answer.match(/(?:^|\n)## 测试结果\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() || '工作线程未报告测试结果' : undefined;
    const summary = answer.replace(/(?:^|\n)## 测试结果[\s\S]*$/, '').replace(/^## 改动摘要\s*/, '').trim().slice(0, 4000);
    const extras = testReport ? { testReport: testReport.slice(0, 4000) } : {};
    // A silent trial: failing tests or nothing reviewable ends quietly — an audit record, no card, no notice.
    if (run.kind === 'sandbox' && (!files.length || (testReport && TEST_FAILED.test(testReport)))) {
      this.update(run.id, { status: 'discarded', endedAt: event.ts, files, summary, discardReason: files.length ? '测试未通过' : '没有可审阅的改动', ...extras });
      return;
    }
    // A quiet no-op leaves an audit record, but never a misleading ready card or notification.
    this.update(run.id, { status: files.length ? 'ready' : 'discarded', endedAt: event.ts, files, summary, ...extras });
    if (files.length) {
      const title = this.store.getTodo(run.matterId)?.text ?? run.matterId;
      this.manager.notice(run.threadId, `${run.kind === 'prepare' ? '已备好材料' : '已在沙盒做好'}：${title}`, false, true);
    }
  }

  /** Waits for file/git collection before closing the store; no extra polling loop or timer. */
  async flush(): Promise<void> { await Promise.all([...this.finishing.values()]); }

  async diff(id: string): Promise<SandboxChanges> {
    const run = this.get(id);
    if (run.kind !== 'sandbox' || !run.repo) throw new HttpError(400, '这次行动是准备材料，没有代码沙盒');
    if (run.status === 'discarded') throw new HttpError(409, '沙盒已丢弃，无法再读取改动');
    try { return await this.sandbox.changes(run.repo, run.matterId); }
    catch (error) { throw new HttpError(409, message(error)); }
  }

  async act(id: string, action: 'merge' | 'discard' | 'revert'): Promise<ProactiveRun> {
    const run = this.get(id);
    if (run.kind !== 'sandbox' || !run.repo) throw new HttpError(400, '这次行动是准备材料，没有代码沙盒');
    const allowed = action === 'revert' ? run.status === 'merged' : action === 'discard' ? ['ready', 'failed'].includes(run.status) : run.status === 'ready';
    if (!allowed) throw new HttpError(409, action === 'revert' ? '只有已合入的主动行动才能撤回' : '当前状态不能执行此操作，请刷新后查看');
    if (this.store.getThread(run.threadId)?.status === 'running') throw new HttpError(409, '沙盒工作线程仍在运行，请等它结束后再操作');
    if (this.acting.has(run.repo)) throw new HttpError(409, '这个仓库正在处理另一项操作，请稍后重试');
    if (!isWithinWorkdirs(run.repo, this.manager.allowedWorkdirs)) throw new HttpError(403, '仓库已不在允许的工作目录内');
    this.acting.add(run.repo);
    try {
      await this.sandbox[action](run.repo, run.matterId);
      return this.update(run.id, { status: action === 'merge' ? 'merged' : action === 'discard' ? 'discarded' : 'reverted' });
    } catch (error) { throw new HttpError(409, message(error)); }
    finally { this.acting.delete(run.repo); }
  }
}
