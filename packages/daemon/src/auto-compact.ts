import type { Store } from './store.js';
import type { ThreadManager } from './threads.js';
import type { StoredEvent } from './events.js';
import { instanceWindows, type HandoverTarget } from './auto-handover.js';
import { synthesizeBrief, turnMessage } from './handover.js';
import { HttpError } from './errors.js';

/**
 * Quota-aware context compression: when the account a thread runs on is close to its plan limit
 * (85%, say) but the handover has not moved the work yet, the thread's transcript — the hub event
 * log, readable for free — is compressed into a brief by *another* agent (a bridge to third-party
 * models, so official-account quota buys no summarizing), and the work continues in a fresh session
 * of the same account carrying that brief instead of half a million tokens of context. Without a
 * compression agent the thread is natively `/compact`ed in place, which spends one turn of the same
 * account but no relay.
 */
export interface AutoCompactSettings {
  enabled: boolean;
  /** Plan usage, in percent, at which a turn's end triggers the compaction. Below the handover threshold. */
  threshold: number;
  /** The agent that reads the transcript and writes the brief; null for a native `/compact` in place. */
  agent: string | null;
  /** A model on the compression agent; null for its default. */
  model: string | null;
  /** A transcript shorter than this is not worth a compaction, however close the quota is. */
  minChars: number;
  /** Chunks of this size are compressed in parallel; their notes are then merged into one brief. */
  chunkChars: number;
  /** The transcript is capped at this size, keeping the newest part. */
  maxChars: number;
}

export interface AutoCompactStatus {
  last?: { threadId: string; successorId?: string; native: boolean; chars: number; chunks: number; at: string };
  error?: { threadId: string; message: string; at: string };
  skipped?: { threadId: string; reason: 'transcript-too-small'; chars: number; at: string };
}

const DEFAULTS: AutoCompactSettings = { enabled: false, threshold: 85, agent: null, model: null, minChars: 240_000, chunkChars: 240_000, maxChars: 1_500_000 };

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The conversation as the hub recorded it: one user ask and its answer per turn, handover and control turns left out. */
export function transcript(events: StoredEvent[]): string {
  const byTurn = new Map<string, StoredEvent[]>();
  for (const e of events) {
    if (!e.turnId) continue;
    const list = byTurn.get(e.turnId);
    if (list) list.push(e); else byTurn.set(e.turnId, [e]);
  }
  const parts: string[] = [];
  for (const [, evs] of byTurn) {
    const start = evs.find(e => e.type === 'turn.started');
    if (!start || start.data.handover || start.data.control) continue;
    const ask = String(start.data.displayText ?? start.data.text ?? '').trim();
    if (!ask) continue;
    const answer = turnMessage(evs).trim();
    parts.push(`## 用户\n${trunc(ask, 2000)}\n## 回答\n${answer ? trunc(answer, 4000) : '（无文字输出）'}`);
  }
  return parts.join('\n\n');
}

/** Slices `text` into chunks of at most `size` chars, overlapping a little so a cut lands in both. */
export function chunkText(text: string, size: number): string[] {
  if (size < 1000) return [text];
  if (text.length <= size) return [text];
  const overlap = Math.min(2000, Math.floor(size / 10));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) out.push(text.slice(i, i + size));
  return out;
}

const compressPrompt = (index: number, of: number, body: string): string => [
  `这是同一个编码 agent 会话记录的第 ${index}/${of} 段。把它压缩成结构化笔记，供压缩上下文后继续同一个任务使用。`,
  '保留：任务目标、关键决定及原因、已完成的改动（文件路径、命令、结果）、未完成事项、用户明确提过的要求和偏好。',
  '用 Markdown 要点，具体（文件名、命令、数字），不复述寒暄、寒暄应答和失败的重复尝试。直接输出笔记，不要解释你在做什么。',
  '',
  '<记录>',
  body,
  '</记录>',
].join('\n');

const mergePrompt = (notes: string[]): string => [
  '以下是同一个会话分段压缩后的笔记。合并去重成一份总摘要，小节：',
  '## 任务 / ## 已完成 / ## 未完成·下一步 / ## 改过的文件 / ## 验证情况 / ## 用户要求与注意事项',
  '保留所有具体信息（文件名、命令、数字），删除重复。直接输出摘要。',
  '',
  ...notes.map((n, i) => `<段${i + 1}>\n${n}\n</段${i + 1}>`),
].join('\n\n');

export class AutoCompact {
  constructor(private store: Store, private manager: ThreadManager) {}

  settings(): AutoCompactSettings {
    return { ...DEFAULTS, ...this.store.hubSetting<Partial<AutoCompactSettings>>('autocompact.settings', {}) };
  }

  configure(input: unknown): AutoCompactSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid auto-compact settings');
    const v = input as Partial<AutoCompactSettings>;
    const int = (x: unknown, min: number, max: number): number => {
      if (!Number.isSafeInteger(x) || (x as number) < min || (x as number) > max) throw new HttpError(400, 'invalid auto-compact settings');
      return x as number;
    };
    if (typeof v.enabled !== 'boolean') throw new HttpError(400, 'invalid auto-compact settings');
    const threshold = int(v.threshold, 50, 98);
    const agent = v.agent === null || v.agent === undefined ? null : v.agent;
    if (agent !== null && (typeof agent !== 'string' || !this.manager.hasAgent(agent))) throw new HttpError(400, 'invalid auto-compact settings');
    if (v.model !== null && v.model !== undefined && (typeof v.model !== 'string' || !v.model || v.model.length > 200)) throw new HttpError(400, 'invalid auto-compact settings');
    const minChars = v.minChars === undefined ? DEFAULTS.minChars : int(v.minChars, 100, 5_000_000);
    const chunkChars = v.chunkChars === undefined ? DEFAULTS.chunkChars : int(v.chunkChars, 20_000, 1_000_000);
    const maxChars = v.maxChars === undefined ? DEFAULTS.maxChars : int(v.maxChars, 100_000, 10_000_000);
    if (chunkChars > maxChars) throw new HttpError(400, 'invalid auto-compact settings');
    const handover = this.manager.autoHandover.settings();
    if (v.enabled && handover.enabled && threshold >= handover.threshold) {
      throw new HttpError(400, `auto-compact must fire before the handover threshold (${handover.threshold}), got ${threshold}`);
    }
    const settings: AutoCompactSettings = { enabled: v.enabled, threshold, agent, model: (v.model || null) as string | null, minChars, chunkChars, maxChars };
    this.store.saveHubSetting('autocompact.settings', settings);
    return settings;
  }

  status(): AutoCompactStatus { return this.store.hubSetting<AutoCompactStatus>('autocompact.status', {}); }
  private report(status: AutoCompactStatus): void { this.store.saveHubSetting('autocompact.status', status); }

  /** One compaction per session: after it the work sits in a fresh (native) or successor (brief) session. */
  private done(): Record<string, boolean> { return this.store.hubSetting('autocompact.done', {}); }
  private markDone(threadId: string, sessionId: string): void {
    const done = this.done();
    done[`${threadId}:${sessionId}`] = true;
    this.store.saveHubSetting('autocompact.done', done);
  }

  /**
   * After a turn ended: compact when the account is near its plan limit and the conversation is
   * long, unless the handover is already moving the work. Returns true when something was started.
   */
  async settled(threadId: string, turnId: string): Promise<boolean> {
    const settings = this.settings();
    if (!settings.enabled) return false;
    const thread = this.store.getThread(threadId);
    if (!thread || thread.archivedAt || !thread.agentSessionId) return false;
    if (this.done()[`${threadId}:${thread.agentSessionId}`]) return false;
    const events = this.store.listEvents(threadId, 0, -1);
    const turnEvents = events.filter(e => e.turnId === turnId);
    const start = turnEvents.find(e => e.type === 'turn.started');
    const end = turnEvents.find(e => e.type === 'turn.done' || e.type === 'turn.error');
    // A failed turn is the handover's business; a compaction needs a healthy account to continue in.
    if (!start || start.data.handover || start.data.control || !end || end.type !== 'turn.done' || end.data.stopReason === 'cancelled') return false;
    if (this.busy(threadId)) return false;
    // A reading up to a few minutes old decides as well as a fresh one, and a probe that fails must
    // not silently shelve the compaction: the account is still running down either way.
    const quota = await this.manager.decisionQuota(thread.agent);
    if (!quota) return false;
    const model = await this.manager.handoverModel(thread.agent, thread.model);
    if (!instanceWindows(quota, model).some(w => w.usedPercent >= settings.threshold)) return false;
    const text = transcript(events);
    if (text.length < settings.minChars) {
      this.report({ ...this.status(), skipped: { threadId, reason: 'transcript-too-small', chars: text.length, at: new Date().toISOString() } });
      return false;
    }
    try {
      if (!settings.agent) {
        // No compression agent: spend one turn of the same account on its own native compaction.
        this.markDone(threadId, thread.agentSessionId);
        await this.manager.startTurn(threadId, { text: '/compact' });
        this.report({ ...this.status(), last: { threadId, native: true, chars: text.length, chunks: 1, at: new Date().toISOString() } });
        return true;
      }
      const brief = await this.compress(threadId, thread.cwd, text, settings);
      // The account may have answered a queued message while the compressor was reading; the relay
      // needs an idle thread, and a busy one keeps its context for the next attempt.
      if (this.busy(threadId)) return false;
      const target: HandoverTarget = { agent: thread.agent, ...(model ? { model } : {}) };
      const successor = await this.manager.executeAutoHandover(threadId, target, brief, null);
      this.markDone(threadId, thread.agentSessionId);
      this.report({ ...this.status(), last: { threadId, successorId: successor.id, native: false, chars: text.length, chunks: chunkText(text.length > settings.maxChars ? text.slice(text.length - settings.maxChars) : text, settings.chunkChars).length, at: new Date().toISOString() } });
      return true;
    } catch (error) {
      this.report({ ...this.status(), error: { threadId, message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() } });
      return false;
    }
  }

  private busy(threadId: string): boolean {
    return this.manager.threadView(threadId).waiting || this.manager.getThread(threadId).status === 'running'
      || this.manager.autoHandover.held(threadId) || this.manager.autoHandover.queuePaused(threadId);
  }

  private async compress(threadId: string, cwd: string, text: string, settings: AutoCompactSettings): Promise<string> {
    const agents = await this.manager.listAgents();
    const compressor = agents.find(a => a.id === settings.agent && a.available && !a.hidden);
    if (!compressor) throw new HttpError(409, `compression agent unavailable: ${settings.agent}`);
    const body = text.length > settings.maxChars ? `（更早的记录已截断）\n${text.slice(text.length - settings.maxChars)}` : text;
    const chunks = chunkText(body, settings.chunkChars);
    const ask = (prompt: string): Promise<string> => this.manager.askOnce(settings.agent!, prompt,
      { model: settings.model, title: `自动压缩 · ${threadId.slice(0, 8)}`, timeoutMs: 300_000 });
    const notes = await Promise.all(chunks.map((c, i) => ask(compressPrompt(i + 1, chunks.length, c))));
    const compressed = (chunks.length > 1 ? await ask(mergePrompt(notes)) : notes[0]).trim();
    if (!compressed) throw new HttpError(502, 'the compression agent returned nothing');
    const facts = synthesizeBrief(this.store.listEvents(threadId, 0, -1));
    return [
      '# 上下文压缩',
      '',
      `线程 ${threadId} 的上下文已由 ${compressor.label}${settings.model ? ` · ${settings.model}` : ''} 压缩；你继续的是同一个任务，不是新任务。`,
      `工作目录 ${cwd}。先运行 git status、git diff 对齐现状，再从「未完成·下一步」继续。`,
      '',
      compressed,
      ...(facts ? ['', facts] : []),
    ].join('\n');
  }
}
