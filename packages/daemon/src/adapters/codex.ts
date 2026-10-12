import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmittedEvent } from '../events.js';
import { commandExists } from '../util.js';
import { CODEX_ICON } from './icons.js';
import { configDirectory, findSessionFile, quoteArg } from './session-location.js';
import { JsonRpcPeer } from './jsonrpc.js';
import type {
  AgentAdapter,
  AgentSession,
  AgentSessionSummary,
  ApprovalDecision,
  ApprovalRequest,
  EffortLevel,
  HistoryTurn,
  ModelOption,
  PermissionMode,
  PermissionOption,
  SlashCommand,
  StartOptions,
  TurnHooks,
  TurnInput,
  TurnResult,
} from './types.js';

/**
 * Codex, through its own `codex app-server` JSON-RPC protocol over stdio. The shape of a turn:
 * `thread/start` (or `thread/resume`) once, then `turn/start` per message, which answers at once
 * while the work streams in as notifications — items that start and complete (commands, file
 * changes, MCP calls), deltas for the agent's words and its reasoning summaries, and a
 * `turn/completed` when everything is over. Approvals arrive as JSON-RPC requests from the server.
 */

/** One hub permission level, as the pair of knobs Codex itself exposes: sandbox + approval policy. */
const CODEX_MODES: Record<PermissionMode, { sandbox: string; approvalPolicy: string }> = {
  // Codex's own three modes: Read Only, Auto, Full Access.
  ask: { sandbox: 'read-only', approvalPolicy: 'on-request' },
  auto_edit: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  full_access: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};

/** The sandbox names `turn/start` takes, unlike the kebab-case ones `thread/start` wants. */
const SANDBOX_POLICY: Record<string, { type: string }> = {
  'read-only': { type: 'readOnly' },
  'workspace-write': { type: 'workspaceWrite' },
  'danger-full-access': { type: 'dangerFullAccess' },
};

/** Effort levels a Codex model may report that the hub's picker can also offer. */
const KNOWN_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** What `turn/completed` says, mapped to the hub's stop reasons. */
function stopReasonOf(status: string): string {
  if (status === 'interrupted') return 'cancelled';
  if (status === 'failed') return 'error';
  return 'end_turn';
}

/**
 * Turns a unified diff, which is how Codex reports file updates, into the old and new text of the
 * changed region. Context lines belong to both sides; the file's untouched parts are not in the
 * diff, but the hub only shows the region, so the lines it has are all it needs.
 *
 * An added or deleted file is not a patch at all: Codex sends the file's plain content. That is
 * told apart by no line carrying a diff marker.
 */
export function parseUnifiedDiff(diff: string, kind?: string): { oldText: string | null; newText: string } {
  const text = String(diff ?? '');
  const looksLikePatch = /^(@@|--- |\+\+\+ |[-+ \\])/m.test(text);
  // An added or deleted file is not a patch at all: Codex sends the file's plain content, which
  // no line of carries a diff marker. An update always comes as a real patch.
  if ((kind === 'add' || kind === 'delete') && !looksLikePatch) {
    return kind === 'delete' ? { oldText: text, newText: '' } : { oldText: null, newText: text };
  }
  const lines = text.split('\n');
  // A trailing newline ends the last line; it is not an extra empty line.
  if (lines[lines.length - 1] === '') lines.pop();
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    // File headers (@@, ---, +++) and markers ("\ No newline") are not content.
    if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  // No old lines at all means the file is new; the hub reads that as oldText null.
  return { oldText: oldLines.length === 0 && newLines.length > 0 ? null : oldLines.join('\n'), newText: newLines.join('\n') };
}

/** A Codex file change, as the hub's diff cards expect it. */
export function codexDiff(change: any): { type: 'diff'; path: string; oldText: string | null; newText: string } | null {
  if (typeof change?.path !== 'string' || typeof change?.diff !== 'string') return null;
  const { oldText, newText } = parseUnifiedDiff(change.diff, change?.kind?.type);
  return { type: 'diff', path: change.path, oldText, newText };
}

function fileChangeTitle(item: any): string {
  const paths = (item?.changes ?? []).map((c: any) => String(c?.path ?? '')).filter(Boolean);
  return paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` 等 ${paths.length} 个文件` : '');
}

/**
 * One `item/started`, as a tool.start. Returns null for items the UI does not show as a step:
 * the user's own message, agent messages and reasoning (their deltas carry the text), and the
 * internal bookkeeping items.
 */
export function mapCodexItemStart(item: any): EmittedEvent | null {
  switch (item?.type) {
    case 'commandExecution':
      return {
        type: 'tool.start',
        data: {
          id: item.id,
          title: String(item.command ?? '').split('\n')[0],
          kind: 'execute',
          status: 'in_progress',
          input: { command: item.command, cwd: item.cwd },
        },
      };
    case 'fileChange': {
      const diffs = (item.changes ?? []).map(codexDiff).filter(Boolean);
      return {
        type: 'tool.start',
        data: {
          id: item.id,
          title: fileChangeTitle(item),
          kind: 'edit',
          status: 'in_progress',
          input: { changes: (item.changes ?? []).map((c: any) => ({ path: c?.path, kind: c?.kind?.type })) },
          ...(diffs.length ? { content: diffs } : {}),
        },
      };
    }
    case 'mcpToolCall':
      return {
        type: 'tool.start',
        data: { id: item.id, title: `${item.server ?? 'mcp'} · ${item.tool ?? ''}`, kind: 'other', status: 'in_progress', input: item.arguments },
      };
    case 'webSearch':
      return { type: 'tool.start', data: { id: item.id, title: String(item.query ?? ''), kind: 'search', status: 'in_progress' } };
    case 'imageGeneration':
      return { type: 'tool.start', data: { id: item.id, title: '图片', kind: 'create', status: 'in_progress', input: { revisedPrompt: item.revisedPrompt } } };
    case 'dynamicToolCall':
      return { type: 'tool.start', data: { id: item.id, title: `${item.namespace ?? ''} · ${item.tool ?? ''}`, kind: 'other', status: 'in_progress', input: item.arguments } };
    default:
      return null;
  }
}

/** One `item/completed`, as a tool.end. The same items as above, plus the plan. */
export function mapCodexItemEnd(item: any): EmittedEvent | null {
  const base = { id: item?.id };
  switch (item?.type) {
    case 'commandExecution': {
      const failed = item.status !== 'completed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      const output = [item.aggregatedOutput, failed && typeof item.exitCode === 'number' ? `(exit ${item.exitCode})` : null]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');
      return { type: 'tool.end', data: { ...base, status: failed ? 'failed' : 'completed', ...(output ? { output } : {}) } };
    }
    case 'fileChange': {
      const diffs = (item.changes ?? []).map(codexDiff).filter(Boolean);
      return {
        type: 'tool.end',
        data: { ...base, status: item.status === 'failed' ? 'failed' : 'completed', ...(diffs.length ? { content: diffs } : {}) },
      };
    }
    case 'mcpToolCall': {
      const failed = item.status !== 'completed' || item.error;
      const output = item.error?.message ?? item.error?.toString?.() ?? null;
      return { type: 'tool.end', data: { ...base, status: failed ? 'failed' : 'completed', ...(output ? { output: String(output) } : {}) } };
    }
    case 'webSearch': {
      const results = (item.results ?? []).map((r: any) => r?.title).filter(Boolean).join('\n');
      return { type: 'tool.end', data: { ...base, status: 'completed', ...(results ? { output: results } : {}) } };
    }
    case 'imageGeneration':
      return { type: 'tool.end', data: { ...base, status: item.failure ? 'failed' : 'completed', output: item.savedPath ?? item.failure?.message ?? undefined } };
    case 'dynamicToolCall':
      return { type: 'tool.end', data: { ...base, status: item.status === 'failed' || !item.success ? 'failed' : 'completed' } };
    default:
      return null;
  }
}

/** Codex's plan steps, as the hub's task cards expect them. */
export function planEntries(steps: any): Array<{ content: string; status: string }> {
  return (Array.isArray(steps) ? steps : [])
    .filter((s: any) => typeof s?.step === 'string' && s.step.trim())
    .map((s: any) => ({
      content: String(s.step),
      status: s.status === 'inProgress' ? 'in_progress' : s.status === 'completed' ? 'completed' : 'pending',
    }));
}

/** The model list as `model/list` reports it, in the hub's shape. */
export function codexModelOptions(models: any[]): ModelOption[] {
  return (models ?? [])
    .filter((m) => typeof m?.id === 'string' && !m?.hidden)
    .map((m): ModelOption => {
      const efforts = (m.supportedReasoningEfforts ?? [])
        .map((e: any) => e?.reasoningEffort ?? e)
        .filter((e: unknown): e is EffortLevel => typeof e === 'string' && KNOWN_EFFORTS.has(e));
      return {
        id: m.id,
        label: m.displayName || m.model || m.id,
        ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
        ...(efforts.length ? { efforts } : {}),
        ...(Array.isArray(m.inputModalities) ? { images: m.inputModalities.includes('image') } : {}),
        ...(m.isDefault ? { isDefault: true } : {}),
      };
    });
}

/**
 * Builds the hub's approval choices from the decisions Codex says it would take. "cancel" is left
 * out on purpose: cancelling the approval (or the turn) already answers it that way.
 */
export function codexApprovalOptions(available: unknown): PermissionOption[] {
  const out: PermissionOption[] = [];
  const has = (id: string) => (Array.isArray(available) ? available.some((d) => d === id || (d && typeof d === 'object' && id in (d as object))) : false);
  if (!Array.isArray(available) || has('accept')) out.push({ optionId: 'accept', name: '允许这一次', kind: 'allow_once' });
  if (has('acceptForSession')) out.push({ optionId: 'acceptForSession', name: '本会话内不再询问', kind: 'allow_always' });
  if (has('acceptWithExecpolicyAmendment')) out.push({ optionId: 'acceptWithExecpolicyAmendment', name: '允许，同类命令不再询问', kind: 'allow_always' });
  if (has('decline')) out.push({ optionId: 'decline', name: '拒绝', kind: 'reject_once' });
  return out;
}

/** The answer to send back for a hub decision, in Codex's approval-decision shape. */
export function codexApprovalDecision(decision: ApprovalDecision, params: any): { decision: unknown } {
  if ('cancelled' in decision) return { decision: 'cancel' };
  switch (decision.optionId) {
    case 'accept':
      return { decision: 'accept' };
    case 'acceptForSession':
      return { decision: 'acceptForSession' };
    case 'acceptWithExecpolicyAmendment':
      return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: params?.proposedExecpolicyAmendment ?? [] } } };
    default:
      return { decision: 'decline' };
  }
}

/**
 * Past turns of a conversation, as `thread/turns/list` reports them, in the shape a live turn
 * would have produced. The user message opens a turn; the other items become steps and text.
 */
export function turnsFromCodexHistory(turns: any[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const turn of turns ?? []) {
    // Codex forks "through" a turn it is given the id of.
    const current: HistoryTurn = { text: '', images: [], events: [], ...(typeof turn?.id === 'string' && turn.id ? { forkRef: turn.id } : {}) };
    for (const item of turn?.items ?? []) {
      if (item?.type === 'userMessage') {
        current.text = (item.content ?? [])
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => String(c.text ?? ''))
          .join('');
        continue;
      }
      if (item?.type === 'agentMessage') {
        if (item.text) current.events.push({ type: 'message.delta', data: { text: String(item.text) } });
        continue;
      }
      if (item?.type === 'reasoning') {
        const text = [...(item.summary ?? []), ...(item.content ?? [])]
          .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
          .join('')
          .trim();
        if (text) current.events.push({ type: 'reasoning.delta', data: { text } });
        continue;
      }
      if (item?.type === 'plan') {
        const entries = planEntries(
          String(item.text ?? '')
            .split('\n')
            .map((line: string) => {
              const checked = /^[-*]\s*\[x\]\s*/i.test(line);
              const step = line.replace(/^[-*]\s*(\[[ xX]\])?\s*/, '').trim();
              return { step, status: checked ? 'completed' : 'pending' };
            })
            .filter((e: any) => e.step),
        );
        if (entries.length) current.events.push({ type: 'plan.updated', data: { entries } });
        continue;
      }
      const start = mapCodexItemStart(item);
      const end = mapCodexItemEnd(item);
      if (start) current.events.push(start);
      if (end) current.events.push(end);
    }
    if (current.text || current.events.length) out.push(current);
  }
  return out;
}

/**
 * Commands the adapter answers itself, the way the pi adapter does. Codex's other slash commands
 * are features of its terminal UI, not of app-server; the hub offers its own panels for those.
 */
export const CODEX_LOCAL_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Compact the conversation history of this thread', kind: 'command' },
];

/** A live Codex thread: one process, one thread id, any number of turns. */
class CodexSession implements AgentSession {
  private hooks: TurnHooks | null = null;
  private turn: { id: string; resolve(r: TurnResult): void; error?: string } | null = null;
  /** Command output streamed so far, so each update carries the whole text like other agents do. */
  private readonly outputSoFar = new Map<string, string>();
  /** File changes by item id, for approval cards that need to show the patch. */
  private readonly fileChanges = new Map<string, any[]>();
  /** Settings that only `turn/start` can change, sent with the next turn. */
  private overrides: { model?: string; effort?: EffortLevel; approvalPolicy?: string; sandboxPolicy?: { type: string } } = {};

  constructor(
    readonly agentSessionId: string,
    private readonly peer: JsonRpcPeer,
  ) {}

  /** Called by the peer for every notification. Ignores anything about another thread. */
  onNotification(method: string, params: any): void {
    if (params?.threadId !== undefined && params.threadId !== this.agentSessionId) return;
    switch (method) {
      case 'item/started': {
        if (params?.item?.type === 'fileChange') this.fileChanges.set(params.item.id, params.item.changes ?? []);
        if (params?.item?.type === 'plan') break; // the structured turn/plan/updated is used instead
        const ev = mapCodexItemStart(params?.item);
        if (ev) this.emit(ev);
        break;
      }
      case 'item/completed': {
        if (params?.item?.type === 'fileChange') this.fileChanges.set(params.item.id, params.item.changes ?? []);
        const ev = mapCodexItemEnd(params?.item);
        if (ev) this.emit(ev);
        break;
      }
      case 'item/agentMessage/delta':
        if (params?.delta) this.emit({ type: 'message.delta', data: { text: String(params.delta) } });
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (params?.delta) this.emit({ type: 'reasoning.delta', data: { text: String(params.delta) } });
        break;
      case 'item/commandExecution/outputDelta': {
        const soFar = this.outputSoFar.get(params.itemId) ?? '';
        const text = soFar + String(params.delta ?? '');
        this.outputSoFar.set(params.itemId, text);
        this.emit({ type: 'tool.update', data: { id: params.itemId, status: 'in_progress', output: text } });
        break;
      }
      case 'item/fileChange/patchUpdated': {
        if (Array.isArray(params?.changes)) this.fileChanges.set(params.itemId, params.changes);
        const diffs = params.changes.map(codexDiff).filter(Boolean);
        if (diffs.length) this.emit({ type: 'tool.update', data: { id: params.itemId, status: 'in_progress', content: diffs } });
        break;
      }
      case 'turn/plan/updated': {
        const entries = planEntries(params?.plan);
        if (entries.length) this.emit({ type: 'plan.updated', data: { entries } });
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params?.tokenUsage;
        // `total` accumulates billed tokens across requests; `last` measures the active context.
        const used = usage?.last?.totalTokens;
        const size = usage?.modelContextWindow;
        if (typeof used === 'number' && Number.isFinite(used) && used >= 0 && typeof size === 'number' && Number.isFinite(size) && size > 0) {
          this.emit({ type: 'usage.updated', data: { used, size } });
        }
        break;
      }
      case 'error':
        // A failed turn also gets turn/completed; a retry does not end it, so only the last counts.
        if (this.turn && params?.turnId === this.turn.id && !params?.willRetry && params?.error?.message) {
          this.turn.error = String(params.error.message);
        }
        break;
      case 'turn/completed': {
        const turn = this.turn;
        if (!turn || params?.turn?.id !== turn.id) break;
        if (params.turn.status === 'failed') turn.error ??= params.turn.error?.message ? String(params.turn.error.message) : 'Codex turn failed';
        this.finishTurn(stopReasonOf(String(params.turn.status ?? 'completed')));
        break;
      }
      default:
        break; // thread bookkeeping, MCP startup, rate limits: nothing the thread view needs
    }
  }

  /** Called by the peer when Codex asks something. Approvals go to the user; the rest is refused. */
  async onRequest(method: string, params: any): Promise<unknown> {
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      return undefined; // answered with "method not supported", which Codex treats as declined
    }
    const isCommand = method === 'item/commandExecution/requestApproval';
    const options = codexApprovalOptions(params?.availableDecisions);
    const req: ApprovalRequest = {
      title: isCommand ? '运行命令' : '修改文件',
      options,
      toolCall: isCommand
        ? { kind: 'command', command: params?.command, cwd: params?.cwd, rawInput: { command: params?.command } }
        : { kind: 'fileChange', changes: this.fileChanges.get(params?.itemId) ?? [], content: (this.fileChanges.get(params?.itemId) ?? []).map(codexDiff).filter(Boolean) },
    };
    const decision = this.hooks ? await this.hooks.requestApproval(req) : ({ cancelled: true } as ApprovalDecision);
    return codexApprovalDecision(decision, params);
  }

  private emit(ev: EmittedEvent): void {
    if (this.hooks) this.hooks.emit(ev);
  }

  private finishTurn(stopReason: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.hooks = null;
    this.outputSoFar.clear();
    turn.resolve({ stopReason, ...(stopReason === 'error' && turn.error ? { error: turn.error } : {}) });
  }

  /** The settings the thread carries, sent with the next turn so the live session picks them up. */
  private turnOverrides(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.overrides.model) out.model = this.overrides.model;
    if (this.overrides.effort) out.effort = this.overrides.effort;
    if (this.overrides.approvalPolicy) out.approvalPolicy = this.overrides.approvalPolicy;
    if (this.overrides.sandboxPolicy) out.sandboxPolicy = this.overrides.sandboxPolicy;
    return out;
  }

  async prompt(input: TurnInput, hooks: TurnHooks): Promise<TurnResult> {
    if (this.turn) throw new Error('a turn is already running');
    this.hooks = hooks;

    // The one command the adapter answers itself.
    if (/^\/compact\b/.test(input.text.trim()) && input.images.length === 0) {
      try {
        await this.peer.request('thread/compact/start', { threadId: this.agentSessionId });
        hooks.emit({ type: 'message.delta', data: { text: '已开始压缩上下文。' } });
        return { stopReason: 'end_turn' };
      } catch (err) {
        this.hooks = null;
        return { stopReason: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    }

    let resolveTurn!: (r: TurnResult) => void;
    const result = new Promise<TurnResult>((resolve) => {
      resolveTurn = resolve;
    });
    try {
      const res = await this.peer.request('turn/start', {
        threadId: this.agentSessionId,
        input: [
          ...(input.text ? [{ type: 'text', text: input.text }] : []),
          ...input.images.filter((img) => typeof img.path === 'string').map((img) => ({ type: 'localImage', path: img.path })),
        ],
        ...this.turnOverrides(),
      });
      this.turn = { id: String(res?.turn?.id ?? ''), resolve: resolveTurn };
      if (!this.turn.id) throw new Error('Codex did not return a turn id');
    } catch (err) {
      this.hooks = null;
      const message = err instanceof Error ? err.message : String(err);
      return { stopReason: 'error', error: message };
    }
    return result;
  }

  /** Model, effort and permission level all ride along with the next turn, so they apply in place. */
  async setModel(model: string): Promise<boolean> {
    this.overrides.model = model;
    return true;
  }

  async setEffort(effort: EffortLevel): Promise<boolean> {
    this.overrides.effort = effort;
    return true;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const codex = CODEX_MODES[mode];
    this.overrides.approvalPolicy = codex.approvalPolicy;
    this.overrides.sandboxPolicy = SANDBOX_POLICY[codex.sandbox];
  }

  async cancel(): Promise<void> {
    if (!this.turn) return;
    await this.peer.request('turn/interrupt', { threadId: this.agentSessionId, turnId: this.turn.id }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.peer.close();
  }

  /** The peer is gone: a running turn can only end as an error now. */
  onClosed(): void {
    if (this.turn) {
      this.turn.error ??= 'codex app-server exited';
      this.finishTurn('error');
    }
  }
}

/** How long a model probe is reused, so several threads opening at once start one process. */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly icon = CODEX_ICON;
  readonly capabilities = {
    resume: true,
    approvals: true,
    permissionModes: ['ask', 'auto_edit', 'full_access'] as const,
    // The widest set; each model says which of these it really takes.
    effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const,
    images: true,
    deleteSession: true,
    history: true,
    fork: true,
    forkAt: true,
    multiAccount: false,
    // A thread is resumed with the directory to work in, whatever directory it was made in.
    forkInto: true,
    // Its app-server has no usage request yet.
    quota: false,
  };

  private modelProbe: Promise<ModelOption[]> | null = null;

  constructor(
    private readonly command: string[],
    /** Extra environment for this agent instance. */
    private readonly env: Record<string, string> = {},
  ) {}

  async available(): Promise<boolean> {
    return commandExists(this.command[0]);
  }

  /** The models this account offers, from one short-lived server that opens no thread. */
  models(): Promise<ModelOption[]> {
    this.modelProbe ??= this.readModels().catch((err) => {
      this.modelProbe = null;
      throw err;
    });
    return this.modelProbe;
  }

  private async readModels(): Promise<ModelOption[]> {
    return this.withServer(async (peer) => {
      const models: any[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await peer.request('model/list', cursor ? { cursor } : {});
        models.push(...(res?.data ?? []));
        cursor = res?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return codexModelOptions(models);
    });
  }

  commands(): Promise<SlashCommand[]> {
    return Promise.resolve(CODEX_LOCAL_COMMANDS);
  }

  resumeCommand(agentSessionId: string): string {
    return `codex resume ${agentSessionId}`;
  }

  async sessionLocation(agentSessionId: string | null, cwd: string) {
    const configDir = configDirectory(this.env, 'CODEX_HOME', ['.codex'], cwd);
    const matches = (name: string, id: string) => name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`);
    const sessionPath = await findSessionFile(join(configDir, 'sessions'), agentSessionId, 3, matches)
      ?? await findSessionFile(join(configDir, 'archived_sessions'), agentSessionId, 3, matches);
    return { configDir, sessionPath, ...(agentSessionId ? { resumeCommand: `env CODEX_HOME=${quoteArg(configDir)} codex resume ${quoteArg(agentSessionId)}` } : {}) };
  }

  async deleteSession(agentSessionId: string): Promise<void> {
    await this.withServer((peer) => peer.request('thread/delete', { threadId: agentSessionId }));
  }

  /** Every conversation Codex has on record, newest first. */
  async listSessions(): Promise<AgentSessionSummary[]> {
    return this.withServer(async (peer) => {
      const out: AgentSessionSummary[] = [];
      let cursor: string | undefined;
      // Without sourceKinds, Codex hides sessions that did not come from its own UIs; `codex exec`
      // runs are conversations too. Sub-agent scratch threads stay out.
      const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
      for (let page = 0; page < 50; page++) {
        const res = await peer.request('thread/list', { limit: 100, sourceKinds, ...(cursor ? { cursor } : {}) });
        for (const t of res?.data ?? []) {
          const title = [t?.name, t?.preview].find((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0);
          out.push({
            id: String(t?.id ?? ''),
            cwd: String(t?.cwd ?? ''),
            title: (title ?? '').slice(0, 80),
            updatedAt: typeof t?.updatedAt === 'number' ? new Date(t.updatedAt * 1000).toISOString() : null,
          });
        }
        cursor = res?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return out;
    });
  }

  /** Reads a conversation's turns. Reading does not open the thread, so it cannot change it. */
  async loadHistory(agentSessionId: string): Promise<HistoryTurn[]> {
    return this.withServer(async (peer) => {
      const turns: any[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 200; page++) {
        const res = await peer.request('thread/turns/list', {
          threadId: agentSessionId,
          itemsView: 'full',
          sortDirection: 'asc',
          ...(cursor ? { cursor } : {}),
        });
        turns.push(...(res?.data ?? []));
        cursor = res?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return turnsFromCodexHistory(turns);
    });
  }

  async forkSession(agentSessionId: string, _cwd?: string, forkRef?: string, intoCwd?: string): Promise<string> {
    return this.withServer(async (peer) => {
      const res = await peer.request('thread/fork', {
        threadId: agentSessionId,
        // Turns after this one are left out of the copy.
        ...(forkRef ? { lastTurnId: forkRef } : {}),
        // Where the copy will work, so its own record says so too. Resuming passes it again.
        ...(intoCwd ? { cwd: intoCwd } : {}),
        ephemeral: false,
        excludeTurns: true,
      });
      const id = res?.thread?.id;
      if (!id) throw new Error('Codex did not return a thread id for the fork');
      return String(id);
    });
  }

  async start(opts: StartOptions): Promise<AgentSession> {
    const [bin, ...args] = this.command;
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.env } });

    const holder: { session: CodexSession | null } = { session: null };
    const peer = new JsonRpcPeer(
      child,
      {
        onNotification: (method, params) => holder.session?.onNotification(method, params),
        onRequest: async (method, params) => holder.session?.onRequest(method, params),
        onClosed: () => holder.session?.onClosed(),
      },
      'codex',
    );

    try {
      await peer.request('initialize', { clientInfo: { name: 'remote-agent-hub', title: 'Remote Agent Hub', version: '0.1.0' } });
      peer.notify('initialized', {});

      const mode = opts.permissionMode ? CODEX_MODES[opts.permissionMode] : null;
      let threadId: string;
      if (opts.resumeId) {
        const res = await peer.request('thread/resume', {
          threadId: opts.resumeId,
          cwd: opts.cwd,
          excludeTurns: true,
          ...(mode ? { sandbox: mode.sandbox, approvalPolicy: mode.approvalPolicy } : {}),
        });
        threadId = String(res?.thread?.id ?? opts.resumeId);
      } else {
        const res = await peer.request('thread/start', {
          cwd: opts.cwd,
          ...(mode ? { sandbox: mode.sandbox, approvalPolicy: mode.approvalPolicy } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        });
        threadId = String(res?.thread?.id ?? '');
        if (!threadId) throw new Error('Codex did not return a thread id');
      }

      const session = new CodexSession(threadId, peer);
      holder.session = session;
      // Effort has no place on thread/start; model and mode still ride with the next turn so a
      // resumed thread switches over even where thread/resume kept its old settings.
      if (opts.model) await session.setModel(opts.model);
      if (opts.effort) await session.setEffort(opts.effort);
      if (opts.permissionMode) await session.setPermissionMode(opts.permissionMode);
      return session;
    } catch (err) {
      peer.close();
      throw err;
    }
  }

  /**
   * Runs one job against a short-lived server that never becomes a thread's session: listing,
   * reading history, forking, deleting. Started outside any project, so it opens no thread.
   */
  private async withServer<T>(job: (peer: JsonRpcPeer) => Promise<T>): Promise<T> {
    const [bin, ...args] = this.command;
    const child = spawn(bin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.env } });
    const peer = new JsonRpcPeer(child, { onNotification: () => undefined, onRequest: async () => undefined }, 'codex');
    try {
      await peer.request('initialize', { clientInfo: { name: 'remote-agent-hub', title: 'Remote Agent Hub', version: '0.1.0' } });
      peer.notify('initialized', {});
      return await job(peer);
    } finally {
      peer.close();
    }
  }
}
