import { acpUsage } from './usage.js';
import { timedUsage, type LiveUsage } from './live-usage.js';
import type { UsageSample } from '../telemetry.js';
import { cliDiagnostic, probeWithDeadline } from './diagnostics.js';
import { isCompaction, trackCompaction } from './compaction.js';
import { sessionEnvironment } from './types.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { EmittedEvent } from '../events.js';
import { textOf, commandExists } from '../util.js';
import { JsonRpcPeer } from './jsonrpc.js';
import type {
  AgentAdapter,
  AgentSession,
  AgentSessionSummary,
  ApprovalDecision,
  EffortLevel,
  HistoryTurn,
  ModelOption,
  PermissionMode,
  SlashCommand,
  StartOptions,
  TurnHooks,
  TurnInput,
  TurnResult,
} from './types.js';

/**
 * ACP (Agent Client Protocol) spoken over stdio: one long-lived process per thread, JSON-RPC in
 * both directions. Everything the protocol defines is the same for every agent, so it lives here;
 * agents differ in the mode ids they use, the id of the effort config option and what they add
 * around it (a terminal command per session, where they keep their files…). See claude.ts and
 * traex.ts for those.
 */

interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string; description?: string }>;
}

/**
 * Maps one ACP `session/update` payload to a unified event.
 * Returns null for updates the UI does not need (commands, user echoes).
 */
export function mapAcpUpdate(update: any): EmittedEvent | null {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
      return { type: 'message.delta', data: { text: textOf(update.content) } };
    case 'agent_thought_chunk':
      return { type: 'reasoning.delta', data: { text: textOf(update.content) } };
    case 'tool_call':
      return {
        type: 'tool.start',
        data: {
          id: update.toolCallId,
          title: update.title ?? '',
          kind: update.kind ?? 'other',
          status: update.status ?? 'in_progress',
          input: update.rawInput,
          content: update.content ?? [],
        },
      };
    case 'tool_call_update': {
      const done = update.status === 'completed' || update.status === 'failed';
      const data = {
        id: update.toolCallId,
        title: update.title,
        status: update.status,
        output: update.rawOutput,
        content: update.content,
      };
      return { type: done ? 'tool.end' : 'tool.update', data };
    }
    case 'plan':
      return { type: 'plan.updated', data: { entries: update.entries ?? [] } };
    case 'usage_update': {
      // How full the context window is. Without a window size there is nothing to show.
      if (typeof update.used !== 'number' || !Number.isFinite(update.used) || update.used < 0 || typeof update.size !== 'number' || !Number.isFinite(update.size) || update.size <= 0) return null;
      const cost = update.cost && typeof update.cost.amount === 'number' && Number.isFinite(update.cost.amount) && update.cost.amount >= 0 ? { amount: update.cost.amount, currency: String(update.cost.currency ?? 'USD') } : null;
      return { type: 'usage.updated', data: { used: update.used, size: update.size, ...(cost ? { cost } : {}) } };
    }
    default:
      return null;
  }
}

/** Effort levels in the agent's effort config option. "default" is not a level: it means no override. */
export function effortsFromConfig(configOptions: ConfigOption[] | undefined): EffortLevel[] {
  const option = (configOptions ?? []).find((o) => o.id === 'effort' || o.category === 'thought_level');
  return (option?.options ?? []).map((o) => o.value).filter((v) => v !== 'default') as EffortLevel[];
}

/** The id of the effort config option, which agents name differently ("effort", "reasoning_effort"). */
export function effortConfigIdOf(configOptions: ConfigOption[] | undefined): string {
  return configOptions?.find((o) => o.category === 'thought_level')?.id ?? 'effort';
}

/**
 * The fork point claude-agent-acp and TRAE CLI both read from `session/fork`'s `_meta` (JetBrains
 * Air's extension): the id of the last message to keep, which is the `messageId` their message and
 * thought chunks carry.
 */
export function airForkPoint(messageId: string): Record<string, unknown> {
  return { jetbrains: { air: { fork: { version: 1, messageId } } } };
}

/**
 * Groups the updates an agent replays when a session is loaded into past turns.
 * A user message starts a turn; everything until the next user message belongs to it.
 */
export function turnsFromAcpReplay(updates: any[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | null = null;
  let lastUserMessageId: unknown;
  for (const update of updates) {
    // What the agent said or thought carries the id of the message it is part of. The last one
    // in a turn is where a copy that ends with this turn stops.
    if (current && (update?.sessionUpdate === 'agent_message_chunk' || update?.sessionUpdate === 'agent_thought_chunk')) {
      if (typeof update.messageId === 'string' && update.messageId) current.forkRef = update.messageId;
    }
    if (update?.sessionUpdate === 'user_message_chunk') {
      // Chunks of one message arrive one after another, before anything from the agent.
      const continues = current !== null && current.events.length === 0;
      if (!continues || !current) {
        current = { text: '', images: [], events: [] };
        turns.push(current);
      } else if (update.messageId !== lastUserMessageId && current.text) {
        current.text += '\n\n';
      }
      lastUserMessageId = update.messageId;
      const content = update.content;
      if (content?.type === 'text') current.text += String(content.text ?? '');
      else if (content?.type === 'image' && typeof content.data === 'string') {
        current.images.push({ data: content.data, mimeType: String(content.mimeType ?? 'image/png') });
      }
      continue;
    }
    if (!current) continue; // nothing before the first user message is part of the conversation
    const ev = mapAcpUpdate(update);
    // Usage describes the session as it is now, not a past turn.
    if (ev && ev.type !== 'usage.updated') current.events.push(ev);
  }
  return turns;
}

/** Reads the model list out of the `model` config option the agent returns with a session. */
export function modelsFromConfig(configOptions: ConfigOption[] | undefined): ModelOption[] {
  const option = (configOptions ?? []).find((o) => o.id === 'model' || o.category === 'model');
  return (option?.options ?? []).map((o) => ({
    id: o.value,
    label: o.name,
    description: o.description || undefined,
    ...(option?.currentValue === o.value ? { isDefault: true } : {}),
  }));
}

/** A live ACP session bound to one thread. */
export class AcpSession implements AgentSession {
  private submission: Promise<void> = Promise.resolve();
  waitForSubmission(): Promise<void> { return this.submission; }
  private usageId = 0;
  private costReading: { amount: number; currency: string } | null = null;
  private costReported = false;
  private costBefore: { amount: number; currency: string } | null = null;
  controlGoal?: AgentSession['controlGoal'];
  private hooks: TurnHooks | null = null;

  constructor(
    readonly agentSessionId: string,
    private readonly peer: JsonRpcPeer,
    /** Mode ids this adapter maps to, per hub permission level. Used to pick a supported mode. */
    private readonly modeIds: Record<PermissionMode, readonly string[]>,
    /** Mode ids the session itself offers, from session/new. Empty when the agent does not say. */
    private readonly offeredModes: readonly string[],
    /** The config option this agent uses for effort ("effort", "reasoning_effort"). */
    private readonly effortConfigId: string = 'effort',
    private readonly liveUsage?: (emit: (sample: UsageSample) => void) => LiveUsage | undefined,
  ) {}

  /** Called by the peer for every session/update notification. */
  onUpdate(update: unknown): void {
    if (!this.hooks) return; // replay during session/load, or stray updates
    const value = update as any;
    if (value?.sessionUpdate === 'usage_update' && typeof value.cost?.amount === 'number' && Number.isFinite(value.cost.amount) && value.cost.amount >= 0) {
      this.costReported = true;
      this.costReading = { amount: value.cost.amount, currency: String(value.cost.currency ?? 'USD') };
    }
    const ev = mapAcpUpdate(update);
    if (ev) this.hooks.emit(ev);
  }

  /** Called by the peer for session/request_permission. */
  async onPermission(params: any): Promise<unknown> {
    if (!this.hooks) return { outcome: { outcome: 'cancelled' } };
    const decision: ApprovalDecision = await this.hooks.requestApproval({
      title: params?.toolCall?.title ?? 'Permission requested',
      options: (params?.options ?? []).map((o: any) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
      toolCall: params?.toolCall ?? {},
    });
    if ('cancelled' in decision) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: decision.optionId } };
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const wanted = this.modeIds[mode];
    // Prefer a mode the session lists; if the list is unknown, try them in order.
    const candidates = this.offeredModes.length ? wanted.filter((id) => this.offeredModes.includes(id)) : wanted;
    let lastError: unknown = new Error(`the agent offers no mode for permission level: ${mode}`);
    for (const modeId of candidates) {
      try {
        await this.peer.request('session/set_mode', { sessionId: this.agentSessionId, modeId });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  protected async setConfig(configId: string, value: string): Promise<any> {
    return this.peer.request('session/set_config_option', { sessionId: this.agentSessionId, configId, value });
  }

  /**
   * Selects a model and reports which effort levels it then offers.
   * Returns null when the agent refuses the model, which means this account cannot use it.
   */
  async probeModel(model: string): Promise<EffortLevel[] | null> {
    try {
      const res = await this.setConfig('model', model);
      return effortsFromConfig(res?.configOptions);
    } catch {
      return null;
    }
  }

  async setModel(model: string): Promise<boolean> {
    await this.setConfig('model', model);
    return true;
  }

  async setEffort(effort: EffortLevel): Promise<boolean> {
    await this.setConfig(this.effortConfigId, effort);
    return true;
  }

  async prompt(input: TurnInput, hooks: TurnHooks): Promise<TurnResult> {
    return isCompaction(input.text) ? trackCompaction(hooks, () => this.promptInternal(input, hooks)) : this.promptInternal(input, hooks);
  }

  private async promptInternal(input: TurnInput, hooks: TurnHooks): Promise<TurnResult> {
    const start = Date.now();
    const emit = (sample: UsageSample) => hooks.emit({ type: 'usage.sample', data: { ...sample } });
    const live = this.liveUsage?.(emit);
    let submitted!: () => void;
    this.submission = new Promise(resolve => { submitted = resolve; });
    let samples: UsageSample[] = [];
    this.hooks = hooks;
    this.costBefore = this.costReading;
    this.costReported = false;
    try {
      await live?.start();
      const response = this.peer.request('session/prompt', {
        sessionId: this.agentSessionId,
        prompt: [
          ...input.images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
          ...(input.text ? [{ type: 'text', text: input.text }] : []),
        ],
      });
      submitted();
      const res = await response;
      const cost = this.costReported && this.costReading && this.costBefore && this.costReading.currency === this.costBefore.currency && this.costReading.amount >= this.costBefore.amount
        ? { amount: this.costReading.amount - this.costBefore.amount, currency: this.costReading.currency, estimated: true } : undefined;
      samples = acpUsage(res, `prompt-${++this.usageId}`, cost);
      const stop = String(res?.stopReason ?? 'end_turn');
      return { stopReason: stop === 'cancelled' ? 'cancelled' : 'end_turn' };
    } catch (err) {
      return { stopReason: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      submitted();
      await live?.stop();
      for (const sample of samples) {
        const remainder = live ? live.ledger.remainder(sample) : sample;
        if (remainder) emit(timedUsage(remainder, start));
      }
      this.hooks = null;
    }
  }

  async cancel(): Promise<void> {
    await this.submission;
    this.peer.notify('session/cancel', { sessionId: this.agentSessionId });
  }

  async close(): Promise<void> {
    this.peer.close();
  }
}

/** Everything an ACP agent has in common. The agent-specific parts are the abstract members. */
export abstract class AcpAdapter implements AgentAdapter {
  protected liveUsage(_id: string, _cwd: string, _emit: (sample: UsageSample) => void): LiveUsage | undefined { return undefined; }
  /** Optional protocol extensions supplied by a concrete adapter. */
  protected configureSession(_session: AcpSession, _peer: JsonRpcPeer): void {}
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly capabilities: AgentAdapter['capabilities'];
  /** The command that continues this session in a terminal, from the thread's directory. */
  abstract resumeCommand(agentSessionId: string): string;
  /** Agent-side mode ids for each hub permission level, in order of preference. */
  protected abstract readonly modeIds: Record<PermissionMode, readonly string[]>;

  /** Commands as last announced by a session in each directory. Project commands differ per directory. */
  protected readonly commandsByCwd = new Map<string, SlashCommand[]>();
  protected latestCommands: SlashCommand[] = [];
  private modelProbe: Promise<ModelOption[]> | null = null;

  constructor(
    readonly command: string[],
    /** Extra environment for this agent instance, such as a second account's config directory. */
    protected readonly env: Record<string, string> = {},
  ) {}

  diagnose() { return cliDiagnostic(this.command, this.env, 'ACP 1'); }

  async available(): Promise<boolean> {
    return commandExists(this.command[0]);
  }

  /**
   * The model list comes from the agent itself, so it tracks whatever is installed. One
   * short-lived session is opened, no prompt is sent; subclasses may probe the models further.
   * The result is cached; a failed probe is retried on the next call.
   */
  models(refresh = false): Promise<ModelOption[]> {
    if (refresh) this.modelProbe = null;
    this.modelProbe ??= this.readModels().catch((err) => {
      this.modelProbe = null;
      throw err;
    });
    return this.modelProbe;
  }

  private async readModels(): Promise<ModelOption[]> {
    const { session, configOptions } = await this.open({ cwd: tmpdir() }, true);
    try {
      return await probeWithDeadline(async () => this.refineModels(modelsFromConfig(configOptions), session), () => session.close());
    } finally {
      await session.close();
    }
  }

  /** Reworks the model list the agent reported, such as by probing each model. */
  protected refineModels(models: ModelOption[], session: AcpSession): Promise<ModelOption[]> | ModelOption[] {
    void session;
    return models;
  }

  /**
   * Commands for a directory if a session there has announced them. Otherwise the list from the
   * model probe, which runs outside any project and so holds only the user's own commands.
   */
  async commands(cwd?: string): Promise<SlashCommand[]> {
    return this.extraCommands((cwd && this.commandsByCwd.get(cwd)) || this.commandsByCwd.get(tmpdir()) || this.latestCommands);
  }

  /** Adds commands the agent answers without announcing them. */
  protected extraCommands(listed: SlashCommand[]): SlashCommand[] {
    return listed;
  }

  /**
   * Runs one job against a short-lived agent process that never becomes a thread's session:
   * listing, reading history, forking, deleting. `updates` collects what the agent replays.
   */
  protected async withAgent<T>(cwd: string, job: (peer: JsonRpcPeer, updates: any[]) => Promise<T>): Promise<T> {
    const [bin, ...args] = this.command;
    const child = spawn(bin, args, { cwd: existsSync(cwd) ? cwd : tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.env } });
    const updates: any[] = [];
    const peer = new JsonRpcPeer(
      child,
      {
        onNotification: (method, params: any) => {
          if (method === 'session/update') updates.push(params?.update);
        },
        onRequest: async () => undefined,
      },
      `${this.id}-acp`,
    );
    try {
      await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      return await job(peer, updates);
    } finally {
      peer.close();
    }
  }

  /** Asks the agent to drop its own copy of a session. */
  async deleteSession(agentSessionId: string, cwd: string): Promise<void> {
    await this.withAgent(cwd, (peer) => peer.request('session/delete', { sessionId: agentSessionId }));
  }

  /** Every session the agent has on record, newest first as it lists them. */
  async listSessions(): Promise<AgentSessionSummary[]> {
    return this.withAgent(tmpdir(), async (peer) => {
      const out: AgentSessionSummary[] = [];
      let cursor: string | undefined;
      // Pages are followed until the agent stops giving a cursor; the cap is only a guard against a loop.
      for (let page = 0; page < 50; page++) {
        const res = await peer.request('session/list', cursor ? { cursor } : {});
        for (const s of res?.sessions ?? []) {
          out.push({ id: String(s.sessionId), cwd: String(s.cwd ?? ''), title: String(s.title ?? ''), updatedAt: s.updatedAt ?? null });
        }
        cursor = res?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return out;
    });
  }

  /**
   * Loading a session makes the agent replay its history as updates, all of them before it answers
   * the load request. Nothing is sent to the model and the session is not changed.
   */
  async loadHistory(agentSessionId: string, cwd: string): Promise<HistoryTurn[]> {
    return this.withAgent(cwd, async (peer, updates) => {
      await peer.request('session/load', { sessionId: agentSessionId, cwd, mcpServers: [] });
      return turnsFromAcpReplay(updates);
    });
  }

  /**
   * How this agent is told where a copy stops, as the `_meta` of `session/fork`. ACP itself has no
   * field for it, so each agent has its own; the default is that there is no way. See airForkPoint
   * for the one Claude and TRAE CLI share.
   */
  protected forkPointMeta(_forkRef: string): Record<string, unknown> | undefined {
    return undefined;
  }

  async forkSession(agentSessionId: string, cwd: string, forkRef?: string, intoCwd?: string): Promise<string> {
    const meta = forkRef ? this.forkPointMeta(forkRef) : undefined;
    if (forkRef && !meta) throw new Error('this agent can only copy a whole conversation');
    // The copy is asked for from where it will run, so the agent files it under that directory.
    const where = intoCwd ?? cwd;
    return this.withAgent(where, async (peer) => {
      const res = await peer.request('session/fork', { sessionId: agentSessionId, cwd: where, mcpServers: [], ...(meta ? { _meta: meta } : {}) });
      if (!res?.sessionId) throw new Error('the agent did not return a session id for the fork');
      return String(res.sessionId);
    });
  }

  async start(opts: StartOptions): Promise<AgentSession> {
    return (await this.open(opts)).session;
  }

  /** Starts a session and also returns the config options the agent reported for it. */
  protected async open(opts: StartOptions, probe = false): Promise<{ session: AcpSession; configOptions: ConfigOption[] }> {
    const [bin, ...args] = this.command;
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: sessionEnvironment(this.env, opts.coordinationEnv) });

    // The session object is created after the peer, but the peer's handlers need it.
    // Route through a holder so both can reference each other without a cycle at construction.
    const holder: { session: AcpSession | null } = { session: null };
    const peer = new JsonRpcPeer(
      child,
      {
        onNotification: (method, params: any) => {
          if (method !== 'session/update') return;
          // Commands can arrive before the session object exists, so the adapter keeps them itself.
          if (params?.update?.sessionUpdate === 'available_commands_update') {
            const list: SlashCommand[] = (params.update.availableCommands ?? []).map((c: any) => ({
              name: String(c.name).replace(/^\//, ''),
              description: c.description ?? '',
              ...(c.input?.hint ? { hint: String(c.input.hint) } : {}),
            }));
            this.commandsByCwd.set(opts.cwd, list);
            this.latestCommands = list;
            return;
          }
          holder.session?.onUpdate(params?.update);
        },
        onRequest: async (method, params) => {
          if (method === 'session/request_permission') return holder.session?.onPermission(params);
          return undefined; // fs/* and terminal/* are not advertised, so the agent should not call them
        },
      },
      `${this.id}-acp`,
    );

    let timedOut = false;
    const timer = probe ? setTimeout(() => { timedOut = true; peer.close(); }, 30000) : undefined;
    try {
      await peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });

      let sessionId: string;
      let info: any;
      if (opts.resumeId) {
        info = await peer.request('session/load', { sessionId: opts.resumeId, cwd: opts.cwd, mcpServers: [] });
        sessionId = opts.resumeId;
      } else {
        info = await peer.request('session/new', { cwd: opts.cwd, mcpServers: [] });
        sessionId = info.sessionId as string;
      }

      const offeredModes: string[] = (info?.modes?.availableModes ?? []).map((m: any) => m.id);
      const configOptions: ConfigOption[] = info?.configOptions ?? [];

      const session = new AcpSession(sessionId, peer, this.modeIds, offeredModes, effortConfigIdOf(configOptions), emit => this.liveUsage(sessionId, opts.cwd, emit));
      this.configureSession(session, peer);
      holder.session = session;
      if (opts.permissionMode && opts.permissionMode !== 'ask') await session.setPermissionMode(opts.permissionMode);
      if (opts.model) await session.setModel(opts.model);
      if (opts.effort) await session.setEffort(opts.effort);
      return { session, configOptions };
    } catch (err) {
      peer.close();
      throw timedOut ? new Error('模型读取超时') : err;
    } finally { clearTimeout(timer); }
  }
}
