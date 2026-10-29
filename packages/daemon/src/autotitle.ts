import type { DaemonExtension, Envelope, ExtensionManifest, NotificationHook } from '@calli/extension-api';
import { turnAnswer } from './coordination.js';
import { HttpError } from './errors.js';
import type { ExtensionHost } from './extension-host.js';
import type { Store } from './store.js';
import type { ThreadManager } from './threads.js';
import { askedText } from './util.js';

/**
 * The daemon side of the built-in 自动取名 extension: once a new thread's first turn ends, the agent
 * the person chose reads the start of the conversation and gives it a short title, following rules
 * the person wrote. It only renames a title that is still the one taken from the first message (or,
 * on the optional second pass, one it gave itself); a title the person set is never touched. The
 * question runs in an archived thread of its own (ThreadManager.askOnce), so the named thread's
 * agent and session are not involved.
 */

export const AUTOTITLE_ID = 'autotitle';

export interface AutoTitleSettings {
  /** The agent instance that names threads. Null: nothing is named until one is chosen. */
  agent: string | null;
  /** Its model; null for the agent's default. */
  model: string | null;
  /** The person's own naming rules, sent as written. */
  rules: string;
  /** Name when the first message is sent, or once the first turn has its answer. */
  trigger: 'sent' | 'finished';
  /** Name once more after the third turn, if the title is still an automatic one. */
  again: boolean;
}

export interface AutoTitleStatus {
  last: { threadId: string; title: string; at: string } | null;
  error: { threadId: string; message: string; at: string } | null;
}

export const DEFAULT_RULES = ['- 8 到 20 个字，和对话用同一种语言', '- 说清楚要做的事，不要客套话', '- 不加标点和引号'].join('\n');
const DEFAULTS: AutoTitleSettings = { agent: null, model: null, rules: DEFAULT_RULES, trigger: 'finished', again: false };
/** How much of the first message and of its answer the naming agent reads. */
const EXCERPT = 1500;
const MAX_TITLE = 40;
const MAX_RULES = 2000;

/** The first line of what the agent said, without quotes or a "标题：" label, at most MAX_TITLE characters. */
export function cleanTitle(answer: string): string {
  const line = answer.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const unlabelled = line.replace(/^(?:标题|題名|タイトル|title)\s*[:：]\s*/i, '');
  const unquoted = unlabelled.replace(/^[「『“"'‘《【]+/, '').replace(/[」』”"'’》】]+$/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim();
  return [...unquoted].slice(0, MAX_TITLE).join('').trim();
}

/** What the naming agent is asked. The person's rules go in as written; the last line is the hub's own. */
export function namingPrompt(rules: string, question: string, answer: string | null): string {
  const cut = (text: string) => (text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text);
  return [
    '给下面这段对话起一个线程标题。',
    '',
    '规则：',
    rules.trim() || DEFAULT_RULES,
    '',
    '对话开头：',
    `用户：${cut(question)}`,
    ...(answer ? [`回复：${cut(answer)}`] : []),
    '',
    '只输出标题本身，一行，不要解释，不要用工具。',
  ].join('\n');
}

export class AutoTitle implements DaemonExtension {
  readonly manifest: ExtensionManifest;
  /** One naming at a time, in the order asked; a thread already waiting is not asked twice. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Set<string>();

  constructor(
    manifest: ExtensionManifest,
    private readonly manager: ThreadManager,
    private readonly store: Store,
    private readonly host: Pick<ExtensionHost, 'allows'>,
  ) {
    this.manifest = manifest;
  }

  settings(): AutoTitleSettings {
    return { ...DEFAULTS, ...this.store.hubSetting<Partial<AutoTitleSettings>>('autotitle', {}) };
  }

  configure(patch: unknown): AutoTitleSettings {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'expected an object');
    const next = this.settings();
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (key === 'agent' || key === 'model') {
        if (value !== null && typeof value !== 'string') throw new HttpError(400, `${key} must be a string or null`);
        if (key === 'agent' && value !== null && !this.manager.hasAgent(value as string)) throw new HttpError(400, `unknown agent: ${value}`);
        next[key] = (value as string | null) || null;
        // Another agent's models are its own.
        if (key === 'agent' && !('model' in (patch as object))) next.model = null;
      } else if (key === 'rules') {
        if (typeof value !== 'string' || value.length > MAX_RULES) throw new HttpError(400, `rules must be text of at most ${MAX_RULES} characters`);
        next.rules = value;
      } else if (key === 'trigger') {
        if (value !== 'sent' && value !== 'finished') throw new HttpError(400, 'trigger must be sent or finished');
        next.trigger = value;
      } else if (key === 'again') {
        if (typeof value !== 'boolean') throw new HttpError(400, 'again must be true or false');
        next.again = value;
      } else throw new HttpError(400, `unknown setting: ${key}`);
    }
    this.store.saveHubSetting('autotitle', next);
    return next;
  }

  status(): AutoTitleStatus {
    return this.store.hubSetting<AutoTitleStatus>('autotitle.status', { last: null, error: null });
  }

  /** Whether the extension may act now: installed, enabled, and holding what renaming needs. */
  private allowed(): boolean {
    return ['events.summary', 'transcript.read', 'threads.rename', 'agents.ask'].every(p => this.host.allows(AUTOTITLE_ID, p as never));
  }

  notify<T extends NotificationHook>(event: Envelope<T>): void {
    if (event.hook !== 'turn.started' && event.hook !== 'turn.finished') return;
    const { turn } = (event as Envelope<'turn.started' | 'turn.finished'>).data;
    const origin = turn.origin;
    if (origin.initiator !== 'user' || origin.imported || origin.fromTerminal || origin.control) return;
    const settings = this.settings();
    if (!settings.agent || !this.allowed()) return;
    const index = this.userTurns(turn.threadId).findIndex(t => t.turnId === turn.turnId) + 1;
    let wanted = false;
    if (event.hook === 'turn.started') wanted = settings.trigger === 'sent' && index === 1;
    else if (turn.outcome === 'ok') wanted = (settings.trigger === 'finished' && index === 1) || (settings.again && index === 3);
    if (!wanted || !this.renamable(turn.threadId, index === 3)) return;
    void this.queue(turn.threadId, true).catch(() => undefined);
  }

  /**
   * Whether an automatic pass may rename this thread: its title is still the hub's default (or, on
   * the second pass, the extension's own), and it is a conversation of the person's, not a team
   * member, a scheduled run, a borrowed task or an archived thread.
   */
  private renamable(threadId: string, second: boolean): boolean {
    const by = this.manager.titleBy(threadId);
    if (by !== 'default' && !(second && by === 'auto')) return false;
    try {
      const view = this.manager.threadView(threadId);
      if (view.archivedAt || view.schedule || view.handover) return false;
      if (view.coordination && view.coordination.rootId !== view.id) return false;
    } catch { return false; }
    return !this.manager.borrowing?.owns(threadId);
  }

  /** Names a thread now: for the person's 「重新取名」, or to try the rules (`apply: false`). */
  async name(threadId: string, opts: { apply: boolean }): Promise<{ title: string }> {
    if (!this.allowed()) throw new HttpError(403, '自动取名扩展未安装、已停用或缺少权限');
    if (!this.settings().agent) throw new HttpError(409, '先在自动取名的设置里选一个取名用的 agent');
    return this.queue(threadId, false, opts.apply);
  }

  private queue(threadId: string, automatic: boolean, apply = true): Promise<{ title: string }> {
    if (automatic && this.waiting.has(threadId)) return Promise.resolve({ title: '' });
    if (automatic) this.waiting.add(threadId);
    const run = this.chain.then(() => this.run(threadId, automatic, apply));
    this.chain = run.catch(() => undefined).finally(() => { if (automatic) this.waiting.delete(threadId); });
    return run;
  }

  private async run(threadId: string, automatic: boolean, apply: boolean): Promise<{ title: string }> {
    const settings = this.settings();
    const first = this.userTurns(threadId)[0];
    if (!first) throw new HttpError(409, '这个线程还没有对话');
    const answer = turnAnswer(this.store.listEvents(threadId, 0, -1), first.turnId).trim() || null;
    try {
      const reply = await this.manager.askOnce(settings.agent!, namingPrompt(settings.rules, first.text, answer), {
        model: settings.model, title: `${this.manifest.name.zh} · ${threadId.slice(0, 8)}`,
      });
      const title = cleanTitle(reply);
      if (!title) throw new HttpError(502, '取名的 agent 没有给出标题');
      if (apply) {
        // The person may have renamed it while the agent was thinking.
        if (automatic && !this.renamable(threadId, true)) return { title };
        this.manager.autoRename(threadId, title);
        this.store.saveHubSetting('autotitle.status', { ...this.status(), last: { threadId, title, at: new Date().toISOString() } });
      }
      return { title };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.saveHubSetting('autotitle.status', { ...this.status(), error: { threadId, message, at: new Date().toISOString() } });
      throw err;
    }
  }

  /** The person's own turns in a thread, oldest first, with what each one asked. */
  private userTurns(threadId: string): { turnId: string; text: string }[] {
    return this.store.listEventsOfType(threadId, 'turn.started')
      .filter(e => e.turnId && !e.data.imported && !e.data.fromTerminal && !e.data.control && !e.data.handover && !e.data.voiceSummary)
      .map(e => ({ turnId: e.turnId!, text: askedText(String(e.data.displayText ?? e.data.text ?? '')).trim() }));
  }
}
