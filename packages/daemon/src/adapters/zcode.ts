import { ZCODE_ICON } from './icons.js';
import { randomUUID } from 'node:crypto';
import { commandExists } from '../util.js';
import type { EmittedEvent } from '../events.js';
import { quoteArg } from './session-location.js';
import { ZcodeWire } from './zcode-wire.js';
import { EFFORT_LEVELS, sessionEnvironment, type AgentAdapter, type AgentSession, type EffortLevel, type ModelOption, type StartOptions, type TurnHooks, type TurnInput, type TurnResult } from './types.js';

export const ZCODE_BASIC_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];
const DELIVERY = 'desktop-continuous';
const COMMANDS = [
  { name: 'compact', description: '压缩当前会话上下文', hint: '[压缩说明]' },
  { name: 'help', description: '查看精简接入支持的命令' },
  { name: 'session', description: '查看当前会话、模型和记忆状态' },
  { name: 'usage', description: '查看会话 token 用量（非套餐剩余额度）' },
];

function selection(id: string, effort?: EffortLevel): { providerId: string; modelId: string; options?: { reasoningLevel: string } } {
  try {
    const [providerId, modelId, defaultEffort] = JSON.parse(id);
    const reasoningLevel = effort ?? defaultEffort;
    if (typeof providerId === 'string' && providerId && typeof modelId === 'string' && modelId) return { providerId, modelId, ...(typeof reasoningLevel === 'string' && reasoningLevel ? { options: { reasoningLevel } } : {}) };
  } catch { /* Invalid opaque model id. */ }
  throw new Error('无效的 zcode 模型，请从模型列表选择');
}

export function zcodeModels(snapshot: any): ModelOption[] {
  const current = snapshot?.settings?.model?.current;
  return (snapshot?.settings?.model?.available ?? []).filter((m: any) => m.ref?.providerId && m.ref?.modelId && !m.disabledReason).map((m: any) => ({
    id: JSON.stringify([m.ref.providerId, m.ref.modelId, m.reasoning?.defaultLevel ?? m.ref.options?.reasoningLevel ?? null]), label: m.label || m.ref.modelId,
    description: m.description,
    efforts: (m.reasoning?.levels ?? []).map((l: any) => l.value).filter((l: any) => EFFORT_LEVELS.includes(l)),
    images: false,
    isDefault: current?.providerId === m.ref.providerId && current?.modelId === m.ref.modelId,
  }));
}

export function mapZcodeEvent(event: any): EmittedEvent | null {
  const p = event.payload ?? {};
  if (event.type === 'model.streaming' && (p.kind === 'text_delta' || p.kind === 'reasoning_delta') && typeof p.delta === 'string') {
    return { type: p.kind === 'text_delta' ? 'message.delta' : 'reasoning.delta', data: { text: p.delta } };
  }
  if (event.type !== 'tool.updated' || !p.toolCallId) return null;
  const name = String(p.toolName ?? '');
  const kind = ({ Read: 'read', Write: 'edit', Edit: 'edit', Bash: 'execute', Grep: 'search', Glob: 'search' } as Record<string, string>)[name] ?? 'other';
  if (p.kind === 'scheduled') return { type: 'tool.start', data: { id: p.toolCallId, title: p.input?.file_path ?? p.input?.path ?? p.input?.command ?? name, kind, input: p.input, status: 'in_progress' } };
  if (p.kind === 'progress') return { type: 'tool.update', data: { id: p.toolCallId, status: 'in_progress', output: [p.stdoutTail, p.stderrTail].filter(Boolean).join('\n') } };
  if (p.kind === 'result' || p.kind === 'error') return { type: 'tool.end', data: { id: p.toolCallId, status: p.kind === 'error' || p.result?.success === false ? 'failed' : 'completed', output: p.error?.message ?? (typeof p.result?.output === 'string' ? p.result.output : JSON.stringify(p.result?.output ?? p.result ?? '')) } };
  return null;
}

export class ZcodeAdapter implements AgentAdapter {
  readonly id = 'zcode';
  readonly label = 'ZCode';
  readonly icon = ZCODE_ICON;
  readonly capabilities = {
    coordination: true, resume: true, approvals: true,
    // ZCode also treats toolAllowlist as approval exemptions, so permission tiers would mislead.
    permissionModes: [], effortLevels: EFFORT_LEVELS,
    images: false, deleteSession: false, history: false, quota: false,
    compact: true, fork: false, forkAt: false, multiAccount: false, forkInto: false,
  };
  private cachedModels: ModelOption[] | null = null;
  private modelsCheckedAt = 0;
  private probing: Promise<ModelOption[]> | null = null;
  private readonly command: string[];
  constructor(command: string[] = [], private readonly env: Record<string, string> = {}) {
    const base = command.length ? command : ['zcode'];
    this.command = base.includes('app-server') || base.includes('agent-server') ? [...base] : [...base, 'app-server'];
  }
  async available(): Promise<boolean> { return commandExists(this.command[0]); }
  commands() { return Promise.resolve(COMMANDS); }
  // Native terminal sessions do not inherit limi's runtime preferences.
  resumeCommand(id: string): string { return `zcode --resume ${quoteArg(id)}`; }
  async models(): Promise<ModelOption[]> {
    if (this.cachedModels && Date.now() - this.modelsCheckedAt < 60_000) return this.cachedModels;
    if (this.probing) return this.probing;
    this.probing = (async () => {
      const session = await this.open({ cwd: process.cwd() }, true);
      try { return this.cachedModels ?? []; } finally { await session.close(); }
    })();
    try { return await this.probing; } finally { this.probing = null; }
  }
  start(opts: StartOptions): Promise<AgentSession> { return this.open(opts, false); }
  private async open(opts: StartOptions, probe: boolean): Promise<ZcodeSession> {
    const wire = new ZcodeWire(this.command, opts.cwd, sessionEnvironment(this.env, opts.coordinationEnv));
    const session = new ZcodeSession(wire, probe);
    try {
      const snapshot = await session.open(opts);
      this.cachedModels = zcodeModels(snapshot);
      this.modelsCheckedAt = Date.now();
      return session;
    } catch (error) { wire.close(); throw error; }
  }
}

class ZcodeSession implements AgentSession {
  agentSessionId = '';
  private preferenceRequests = 0;
  private active: { inputId: string; turnId?: string; hooks: TurnHooks; resolve(result: TurnResult): void; reject(error: Error): void; text: string; seen: Set<string> } | null = null;
  private closed = false;
  private submission: Promise<void> | null = null;
  constructor(private readonly wire: ZcodeWire, private readonly probe: boolean) {
    wire.onEvent = (method, params) => this.event(method, params);
    wire.onRequest = (method, params) => this.request(method, params);
    wire.onClosed = (error) => { this.closed = true; this.active?.reject(error); this.active = null; };
  }
  async open(opts: StartOptions): Promise<any> {
    const workspace = { workspacePath: opts.cwd, workspaceKey: opts.cwd };
    const model = opts.model ? selection(opts.model, opts.effort) : undefined;
    const thoughtLevel = opts.effort ?? model?.options?.reasoningLevel;
    const restrictions = { workspace, mcpServers: [], toolAllowlist: ZCODE_BASIC_TOOLS, dynamicWorkflowEnabled: false, offPeakToolEnabled: false };
    const snapshot = await this.wire.request(opts.resumeId ? 'session/resume' : 'session/create', opts.resumeId
      ? { ...restrictions, sessionId: opts.resumeId }
      : { ...restrictions, mode: 'build', persistence: this.probe ? 'deferred' : 'immediate', titleGenerationEnabled: false, ...(model ? { model } : {}), ...(thoughtLevel ? { thoughtLevel } : {}) });
    if (!this.preferenceRequests) throw new Error('此 zcode 未请求运行时偏好，无法保证关闭记忆，请升级 zcode');
    if (typeof snapshot?.session?.sessionId !== 'string') throw new Error('zcode 未返回会话 ID');
    this.agentSessionId = snapshot.session.sessionId;
    if (snapshot.session.target?.status === 'active' || snapshot.projection?.target?.status === 'active') {
      throw new Error('此 zcode 会话有正在运行的目标，请先在 zcode 中停止目标，或创建新会话');
    }
    if (opts.resumeId) {
      await this.wire.request('session/setMode', { sessionId: this.agentSessionId, mode: 'build' });
      if (opts.model) await this.setModel(opts.model);
    }
    if (opts.effort) await this.setEffort(opts.effort);
    if (!this.probe) await this.wire.request('session/subscribe', { sessionId: this.agentSessionId, deliveryKind: DELIVERY, includeSnapshot: false });
    return snapshot;
  }
  async setModel(model: string): Promise<boolean> {
    await this.wire.request('session/setModel', { sessionId: this.agentSessionId, model: selection(model), persistAsWorkspaceLastUsed: false }); return true;
  }
  async setEffort(effort: EffortLevel): Promise<boolean> {
    await this.wire.request('session/setThoughtLevel', { sessionId: this.agentSessionId, thoughtLevel: effort, persistAsWorkspaceLastUsed: false }); return true;
  }
  async prompt(input: TurnInput, hooks: TurnHooks): Promise<TurnResult> {
    if (this.closed) throw new Error('zcode 连接已关闭');
    if (this.active) throw new Error('zcode 已有正在运行的轮次');
    if (input.images.length) throw new Error('zcode 适配器暂不支持图片');
    const text = input.text.trim();
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    const name = match?.[1];
    const compact = name === 'compact';
    if (text.startsWith('/') && !COMMANDS.some((command) => command.name === name)) throw new Error('精简接入不执行此命令，请用 /help 查看支持的命令');
    if (name && !compact) {
      if (match?.[2]) throw new Error(`/${name} 不接受参数`);
      let response: string;
      if (name === 'help') {
        response = COMMANDS.map((command) => `/${command.name}：${command.description}`).join('\n\n');
      } else if (name === 'session') {
        const snapshot = await this.wire.request('session/read', { sessionId: this.agentSessionId, messageLimit: 1 });
        const model = snapshot?.settings?.model?.current;
        response = [`会话：${this.agentSessionId}`, `模型：${model?.providerId ?? '未知'} / ${model?.modelId ?? '未知'}`, '自动记忆：关闭', '工具范围：基础编码工具', '套餐额度：暂不支持查询，请在 zcode 或供应商端查看'].join('\n\n');
      } else {
        const usage = await this.wire.request('session/usage', { sessionId: this.agentSessionId });
        const count = (key: string) => typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key].toLocaleString('en-US') : '未知';
        response = ['当前会话累计用量', `总计：${count('totalTokens')} tokens`, `输入：${count('inputTokens')} · 输出：${count('outputTokens')}`, `推理：${count('reasoningTokens')}`, `缓存读取：${count('cacheReadTokens')} · 缓存写入：${count('cacheCreationTokens')}`, `模型请求：${count('modelRequestCount')} · 错误：${count('modelErrorCount')}`, '套餐剩余额度暂不支持查询，请在 zcode 或供应商端查看。'].join('\n\n');
      }
      hooks.emit({ type: 'message.delta', data: { text: response } });
      return { stopReason: 'end_turn' };
    }
    const inputId = randomUUID();
    return new Promise<TurnResult>((resolve, reject) => {
      const active = { inputId, hooks, resolve, reject, text: '', seen: new Set<string>() };
      this.active = active;
      this.submission = this.wire.request(compact ? 'session/compact' : 'session/send', {
        sessionId: this.agentSessionId, inputId,
        ...(compact ? { instructions: text.slice('/compact'.length).trim() } : { content: input.text }),
      }).then((result) => {
        if (compact && result?.compact?.state === 'already_running' && this.active === active) {
          this.finish({ stopReason: 'error', error: 'zcode 已在压缩，请稍后重试' });
          return;
        }
        if (compact && !result?.compact && this.active === active) {
          if (result?.response) hooks.emit({ type: 'message.delta', data: { text: result.response } });
          this.finish({ stopReason: 'end_turn' });
        }
      }).catch((error) => { if (this.active === active) { this.active = null; reject(error); } });
    });
  }
  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    // Stop must follow admission; an earlier stop can miss a not-yet-started turn.
    await this.submission;
    if (this.active !== active) return;
    await this.wire.request('session/stop', { sessionId: this.agentSessionId });
  }
  async close(): Promise<void> {
    try { if (!this.closed && this.agentSessionId) await this.wire.request('session/close', { sessionId: this.agentSessionId, ...(this.probe ? { expectedPersistence: 'deferred' } : {}) }, 5_000); }
    finally { this.wire.close(); }
  }
  private finish(result: TurnResult): void { const active = this.active; this.active = null; active?.resolve(result); }
  private event(method: string, event: any): void {
    const active = this.active;
    if (method !== 'session/event' || !active || event?.sessionId !== this.agentSessionId) return;
    if (event.eventId) { if (active.seen.has(event.eventId)) return; active.seen.add(event.eventId); }
    const p = event.payload ?? {};
    if (event.type === 'turn.started') {
      if (p.inputId !== active.inputId) return;
      active.turnId = event.turnId;
    }
    const terminal = event.type === 'turn.completed' || event.type === 'turn.failed';
    if ((!active.turnId || event.turnId !== active.turnId) && !(terminal && p.inputId === active.inputId)) return;
    const mapped = mapZcodeEvent(event);
    if (mapped) { active.hooks.emit(mapped); if (mapped.type === 'message.delta') active.text += mapped.data.text; }
    if (event.type === 'turn.completed') {
      if (!active.text && p.response) active.hooks.emit({ type: 'message.delta', data: { text: p.response } });
      this.finish(p.resultType === 'success' ? { stopReason: 'end_turn' } : p.resultType === 'cancelled' ? { stopReason: 'cancelled' } : { stopReason: 'error', error: `zcode：${p.resultType}` });
    } else if (event.type === 'turn.failed') this.finish({ stopReason: 'error', error: p.error?.message ?? 'zcode 执行失败' });
  }
  private async request(method: string, params: any): Promise<unknown> {
    if (method === 'session/requestRuntimePreferences') {
      this.preferenceRequests++;
      return { memoryEnabled: false, nativeSearchEnhancementsEnabled: false, askUserQuestionAutoResolutionEnabled: false };
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') return { headersApplied: false, errorMessage: 'limi 暂不支持 zcode 桌面账号的动态鉴权，请在 zcode 中配置 API 模型' };
    if (method !== 'interaction/requestPermission') return undefined;
    const active = this.active;
    if (!active || params?.sessionId !== this.agentSessionId) return { decision: 'deny' };
    const options = (params.options ?? []).filter((o: any) => typeof o.optionId === 'string' && o.response);
    const answer = await active.hooks.requestApproval({ title: params.reason || params.toolName || 'zcode 请求批准', options: options.map((o: any) => ({ optionId: o.optionId, name: o.name, kind: o.kind })), toolCall: { title: params.toolName, rawInput: params.input } });
    if (active !== this.active || 'cancelled' in answer) return { decision: 'deny' };
    return options.find((o: any) => o.optionId === answer.optionId)?.response ?? { decision: 'deny' };
  }
}
