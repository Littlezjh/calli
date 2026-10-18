import type { AgentAdapter, MemoryReader } from './adapters/types.js';
import type { MemorySource } from '@rah/extension-api';
import { createHash, randomUUID } from 'node:crypto';
import type {
  DaemonExtension,
  Envelope,
  ExtensionManifest,
  ExtensionState,
  NotificationHook,
  NotificationPayloads,
  Permission,
  ThreadSummary,
  TurnSummary,
  WaitSummary,
} from '@rah/extension-api';
import type { StoredEvent } from './events.js';
import { HttpError } from './errors.js';
import { exactGrant, type ExtensionRecord, type ExtensionStore } from './extensions.js';
import { attentionOf, turnOrigin, turnOutcome } from './lifecycle.js';
import type { ThreadView } from './threads.js';

/**
 * The daemon side of the extension host: install state, and the notification bus in-process
 * extensions listen on. Raw events never reach an extension. Each one is projected onto the
 * whitelisted summaries of @rah/extension-api first, so message text, images, tool calls, answers,
 * `preview` and queued text stay behind. Delivery is asynchronous and in order; a queue that runs
 * over is dropped and replaced by `host.resync`, and nothing is written to disk.
 */

/** Where threads and their events come from. ThreadManager is one; tests pass their own. */
export interface HostSource {
  subscribe(listener: (ev: StoredEvent) => void): () => void;
  listThreads(opts?: { archived?: boolean }): ThreadView[];
  threadView(id: string): ThreadView;
}

export interface ExtensionHostOptions {
  adapters?: ReadonlyMap<string, AgentAdapter>;
  store: ExtensionStore;
  source: HostSource;
  /** Extensions that ship with Limi (see extensions.ts, loadCatalog). */
  catalog: ExtensionManifest[];
  /** A turn's `turn.started`, for turns that began before the host was listening. */
  turnStart?: (threadId: string, turnId: string) => StoredEvent | undefined;
  /** Notifications waiting per extension before the queue is dropped for a `host.resync`. */
  queueLimit?: number;
}

/** Hooks every running extension gets, declared or not: they are about the extension and its delivery. */
const ALWAYS: ReadonlySet<NotificationHook> = new Set(['extension.activated', 'extension.deactivating', 'host.resync']);
/** Hooks that carry thread metadata: only with `events.summary`. */
const NEEDS_SUMMARY: ReadonlySet<NotificationHook> = new Set([
  'thread.created',
  'thread.changed',
  'thread.deleted',
  'turn.started',
  'turn.finished',
  'attention.raised',
  'attention.resolved',
]);
const DEFAULT_QUEUE_LIMIT = 1000;
/** Turn starts remembered for their origin until the turn ends. */
const MAX_OPEN_TURNS = 1000;

/** The whitelisted view of a thread. Anything that may hold conversation content is left out. */
export function threadSummary(view: ThreadView): ThreadSummary {
  return {
    id: view.id,
    title: view.title,
    agent: view.agent,
    project: view.worktree ? view.worktree.of : view.cwd,
    status: view.status,
    attention: attentionOf(view),
    runningSince: view.status === 'running' ? (view.runningSince ?? null) : null,
    unread: view.unread,
    pinned: view.pinned,
    archived: view.archivedAt !== null,
    scheduled: Boolean(view.schedule),
    worktree: Boolean(view.worktree),
    handover: Boolean(view.handover),
    teamSize: view.coordination && view.coordination.rootId === view.id ? view.coordination.children : 0,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}


interface Subscriber {
  id: string;
  impl: DaemonExtension;
  hooks: Set<NotificationHook>;
  summary: boolean;
  queue: Envelope[];
  scheduled: boolean;
  active: boolean;
}

export class ExtensionHost {
  /** Changes every daemon start: extensions that see a new one re-read their state. */
  readonly generation = randomUUID();
  private readonly adapters: ReadonlyMap<string, AgentAdapter>;
  private readonly store: ExtensionStore;
  private readonly source: HostSource;
  private readonly catalog: ExtensionManifest[];
  private readonly turnStart?: ExtensionHostOptions['turnStart'];
  private readonly queueLimit: number;
  private readonly memoryAccessVersions = new Map<string, number>();
  private readonly implementations = new Map<string, DaemonExtension>();
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly listeners = new Set<() => void>();
  /** The last summary each thread was announced with, to say which fields changed. */
  private readonly announced = new Map<string, ThreadSummary>();
  private readonly openTurns = new Map<string, { origin: TurnSummary['origin']; startedAt: string }>();
  /** What each open question asked for, a question or a plan to confirm, by input id. */
  private readonly inputKinds = new Map<string, WaitSummary['kind']>();
  private unsubscribe: (() => void) | null = null;

  constructor(opts: ExtensionHostOptions) {
    this.adapters = opts.adapters ?? new Map();
    this.store = opts.store;
    this.source = opts.source;
    this.catalog = opts.catalog;
    this.turnStart = opts.turnStart;
    this.queueLimit = Math.max(2, opts.queueLimit ?? DEFAULT_QUEUE_LIMIT);
  }

  /** Starts listening, wakes the enabled extensions and tells them the machine is ready. Once, after restart recovery. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.source.subscribe((ev) => this.onEvent(ev));
    for (const manifest of this.catalog) this.sync(manifest.id);
    for (const sub of this.subscribers.values()) this.enqueue(sub, 'machine.ready', { generation: this.generation }, 0);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const id of [...this.subscribers.keys()]) this.deactivate(id, 'stopping');
  }

  /** The daemon-side part of a built-in extension. View-only extensions have none. */
  register(impl: DaemonExtension): void {
    this.implementations.set(impl.manifest.id, impl);
    if (this.unsubscribe) this.sync(impl.manifest.id);
  }

  /** The catalog with this machine's state, for `GET /api/extensions`. */
  list(): ExtensionState[] {
    const records = new Map(this.store.list().map((r) => [r.id, r]));
    return this.catalog.map((m) => this.state(m, records.get(m.id) ?? null));
  }

  /** Called with no arguments whenever an extension is installed, removed, enabled or disabled. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Installs with exactly the permissions the manifest asks for; anything else is refused. */
  install(id: string, granted: unknown): ExtensionState {
    const manifest = this.manifest(id);
    const grant = exactGrant(manifest, granted);
    if (!grant) throw new HttpError(400, '授予的权限须与扩展声明的权限完全一致');
    const record = this.store.install(id, manifest.version, grant);
    this.bumpMemoryAccess(id);
    this.sync(id);
    this.changed();
    return this.state(manifest, record);
  }

  uninstall(id: string): void {
    this.manifest(id);
    this.bumpMemoryAccess(id);
    this.deactivate(id, 'uninstalled');
    if (this.store.remove(id)) this.changed();
  }

  setEnabled(id: string, enabled: unknown): ExtensionState {
    const manifest = this.manifest(id);
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled 须为布尔值');
    const record = this.store.get(id);
    if (!record) throw new HttpError(409, '扩展尚未安装');
    if (enabled && !exactGrant(manifest, record.granted)) throw new HttpError(409, '扩展需要的权限有变化，请重新安装以确认');
    const updated = this.store.setEnabled(id, enabled)!;
    this.bumpMemoryAccess(id);
    if (enabled) this.sync(id);
    else this.deactivate(id, 'disabled');
    this.changed();
    return this.state(manifest, updated);
  }

  // ---------------------------------------------------------------- host API (v1)

  /** `threads.list`: current state only, no history. Needs `events.summary`. */
  threadsList(extensionId: string, opts: { archived?: boolean } = {}): { generation: string; threads: ThreadSummary[] } {
    this.require(extensionId, 'events.summary');
    return { generation: this.generation, threads: this.source.listThreads({ archived: opts.archived === true }).map(threadSummary) };
  }

  /** `threads.get`. Needs `events.summary`. */
  threadsGet(extensionId: string, threadId: string): ThreadSummary | null {
    this.require(extensionId, 'events.summary');
    try {
      return threadSummary(this.source.threadView(threadId));
    } catch {
      return null;
    }
  }

  private bumpMemoryAccess(id: string): void {
    this.memoryAccessVersions.set(id, (this.memoryAccessVersions.get(id) ?? 0) + 1);
  }

  private memoryVersion(id: string): number {
    this.require(id, 'memory.read');
    return this.memoryAccessVersions.get(id) ?? 0;
  }

  private checkMemoryVersion(id: string, version: number): void {
    if (this.memoryVersion(id) !== version) throw new HttpError(403, 'Memory permission changed');
  }

  private async memoryProviders(): Promise<Array<{ source: MemorySource; reader: MemoryReader }>> {
    const sources = new Map<string, { source: MemorySource; reader: MemoryReader }>();
    for (const [agentId, adapter] of this.adapters) {
      if (!adapter.capabilities.memory || !adapter.memoryReader) continue;
      const reader = adapter.memoryReader();
      const id = createHash('sha256').update(await reader.root()).digest('hex').slice(0, 32);
      let group = sources.get(id);
      if (!group) {
        group = { source: { id, agents: [] }, reader };
        sources.set(id, group);
      }
      group.source.agents.push({ id: agentId, label: adapter.label });
    }
    return [...sources.values()];
  }

  async memorySources(extensionId: string): Promise<MemorySource[]> {
    const version = this.memoryVersion(extensionId);
    const sources = await this.memoryProviders();
    this.checkMemoryVersion(extensionId, version);
    return sources.map(({ source }) => source);
  }

  async memoryList(extensionId: string, sourceId: string) {
    const version = this.memoryVersion(extensionId);
    const provider = (await this.memoryProviders()).find(p => p.source.id === sourceId);
    if (!provider) throw new HttpError(404, 'Memory source not found');
    const result = await provider.reader.list();
    this.checkMemoryVersion(extensionId, version);
    return result;
  }

  async memoryRead(extensionId: string, sourceId: string, fileId: string) {
    const version = this.memoryVersion(extensionId);
    const provider = (await this.memoryProviders()).find(p => p.source.id === sourceId);
    if (!provider) throw new HttpError(404, 'Memory source not found');
    const result = await provider.reader.read(fileId);
    this.checkMemoryVersion(extensionId, version);
    return result;
  }

  // ---------------------------------------------------------------- internals

  private manifest(id: string): ExtensionManifest {
    const manifest = this.catalog.find((m) => m.id === id);
    if (!manifest) throw new HttpError(404, `没有名为 ${id} 的扩展`);
    return manifest;
  }

  private state(manifest: ExtensionManifest, record: ExtensionRecord | null): ExtensionState {
    return {
      manifest,
      source: 'builtin',
      installed: record !== null,
      // A grant made for an older version that asked for less does not switch the new one on.
      enabled: record !== null && record.enabled && Boolean(exactGrant(manifest, record.granted)),
      granted: record?.granted ?? [],
      installedAt: record?.installedAt ?? null,
      updatedAt: record?.updatedAt ?? null,
    };
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  private require(extensionId: string, permission: Permission): void {
    const record = this.store.get(extensionId);
    const manifest = this.catalog.find((m) => m.id === extensionId);
    if (!record || !manifest || !this.state(manifest, record).enabled || !manifest.permissions.includes(permission) || !record.granted.includes(permission)) {
      throw new HttpError(403, `扩展 ${extensionId} 没有 ${permission} 权限`);
    }
  }

  /** Brings one extension's subscription in line with its stored state. */
  private sync(id: string): void {
    const manifest = this.catalog.find((m) => m.id === id);
    const record = this.store.get(id);
    const impl = this.implementations.get(id);
    const on = Boolean(manifest && impl && record && this.state(manifest, record).enabled);
    if (!on) {
      this.deactivate(id, 'disabled');
      return;
    }
    if (this.subscribers.has(id) || !this.unsubscribe) return;
    const sub: Subscriber = {
      id,
      impl: impl!,
      hooks: new Set(manifest!.subscribes ?? []),
      summary: record!.granted.includes('events.summary'),
      queue: [],
      scheduled: false,
      active: true,
    };
    this.subscribers.set(id, sub);
    // Anything announced before this subscriber existed is unknown to it.
    if (sub.summary) this.announced.clear();
    this.enqueue(sub, 'extension.activated', { extensionId: id, generation: this.generation }, 0);
  }

  /** Stops delivery at once. The goodbye is best effort; queued notifications are dropped. */
  private deactivate(id: string, reason: NotificationPayloads['extension.deactivating']['reason']): void {
    const sub = this.subscribers.get(id);
    if (!sub) return;
    this.subscribers.delete(id);
    sub.active = false;
    sub.queue = [];
    try {
      sub.impl.notify?.(this.envelope('extension.deactivating', { extensionId: id, reason }, 0));
    } catch (err) {
      console.error(`[ext ${id}] deactivating:`, err);
    }
  }

  private accepts(sub: Subscriber, hook: NotificationHook): boolean {
    if (ALWAYS.has(hook)) return true;
    if (!sub.hooks.has(hook)) return false;
    return !NEEDS_SUMMARY.has(hook) || sub.summary;
  }

  private envelope<T extends NotificationHook>(hook: T, data: NotificationPayloads[T], seq: number): Envelope<T> {
    return { hook, generation: this.generation, seq, ts: new Date().toISOString(), data };
  }

  private enqueue<T extends NotificationHook>(sub: Subscriber, hook: T, data: NotificationPayloads[T], seq: number): void {
    if (!sub.active || !this.accepts(sub, hook)) return;
    if (sub.queue.length >= this.queueLimit) {
      // Dropped, not delivered late: the extension re-reads the current state instead.
      sub.queue = [this.envelope('host.resync', { reason: 'overflow' }, 0)];
    }
    sub.queue.push(this.envelope(hook, data, seq) as unknown as Envelope);
    if (sub.scheduled) return;
    sub.scheduled = true;
    setImmediate(() => this.drain(sub));
  }

  private drain(sub: Subscriber): void {
    sub.scheduled = false;
    while (sub.active && sub.queue.length) {
      const env = sub.queue.shift()!;
      try {
        sub.impl.notify?.(env);
      } catch (err) {
        console.error(`[ext ${sub.id}] ${env.hook}:`, err);
      }
    }
  }

  private publish<T extends NotificationHook>(hook: T, data: NotificationPayloads[T], seq: number): void {
    for (const sub of this.subscribers.values()) this.enqueue(sub, hook, data, seq);
  }

  private wanted(hook: NotificationHook): boolean {
    for (const sub of this.subscribers.values()) if (this.accepts(sub, hook)) return true;
    return false;
  }

  private origin(ev: StoredEvent): { origin: TurnSummary['origin']; startedAt: string } {
    const open = ev.turnId ? this.openTurns.get(ev.turnId) : undefined;
    if (open) return open;
    const started = ev.turnId ? this.turnStart?.(ev.threadId, ev.turnId) : undefined;
    if (started) return { origin: turnOrigin(started), startedAt: started.ts };
    // A turn that never had a start of its own is history the host cannot place.
    return { origin: { initiator: 'unknown', imported: ev.data.imported === true, fromTerminal: ev.data.fromTerminal === true, control: false }, startedAt: ev.ts };
  }

  /** Announces a thread's summary when it differs from the last one, with the fields that did. */
  private announce(threadId: string, seq: number, created?: NotificationPayloads['thread.created']['origin']): void {
    if (!this.wanted(created ? 'thread.created' : 'thread.changed')) return;
    let thread: ThreadSummary;
    try {
      thread = threadSummary(this.source.threadView(threadId));
    } catch {
      this.announced.delete(threadId); // deleted meanwhile
      return;
    }
    const before = this.announced.get(threadId);
    this.announced.set(threadId, thread);
    if (created) {
      this.publish('thread.created', { thread, origin: created }, seq);
      return;
    }
    const fields = before
      ? (Object.keys(thread) as (keyof ThreadSummary)[]).filter((k) => JSON.stringify(thread[k]) !== JSON.stringify(before[k]))
      : [];
    if (before && fields.length === 0) return;
    this.publish('thread.changed', { thread, fields }, seq);
  }

  /** The wait an approval or input event is about: kind and id, nothing of what was asked or answered. */
  private waitOf(ev: StoredEvent): WaitSummary | null {
    if (ev.type === 'approval.request' || ev.type === 'approval.resolved') {
      const id = ev.data.approvalId;
      return typeof id === 'string' ? { threadId: ev.threadId, turnId: ev.turnId, kind: 'approval', id } : null;
    }
    const id = ev.data.inputId;
    if (typeof id !== 'string') return null;
    // A resolution does not repeat the kind: it is the one the request was made with.
    const kind = ev.type === 'input.request' ? (ev.data.kind === 'plan' ? 'plan' : 'question') : (this.inputKinds.get(id) ?? 'question');
    return { threadId: ev.threadId, turnId: ev.turnId, kind, id };
  }

  private onEvent(ev: StoredEvent): void {
    // Kept whether or not anyone listens, so an extension enabled mid-turn still learns its origin.
    if (ev.type === 'turn.started' && ev.turnId) {
      this.openTurns.set(ev.turnId, { origin: turnOrigin(ev), startedAt: ev.ts });
      if (this.openTurns.size > MAX_OPEN_TURNS) this.openTurns.delete(this.openTurns.keys().next().value as string);
    }
    if (ev.type === 'input.request' && typeof ev.data.inputId === 'string') {
      this.inputKinds.set(ev.data.inputId, ev.data.kind === 'plan' ? 'plan' : 'question');
      if (this.inputKinds.size > MAX_OPEN_TURNS) this.inputKinds.delete(this.inputKinds.keys().next().value as string);
    }
    const ended = turnOutcome(ev);
    const placed = ended ? this.origin(ev) : null;
    if (ended && ev.turnId) this.openTurns.delete(ev.turnId);
    if (!this.subscribers.size) {
      this.announced.clear();
      return;
    }
    const turnId = ev.turnId;
    switch (ev.type) {
      case 'thread.created':
        this.announce(ev.threadId, ev.seq, ev.data.imported === true ? 'import' : 'new');
        return;
      case 'thread.updated':
        this.announce(ev.threadId, ev.seq);
        return;
      case 'turn.started':
        if (turnId) {
          const open = this.openTurns.get(turnId)!;
          this.publish('turn.started', { turn: { threadId: ev.threadId, turnId, origin: open.origin, startedAt: open.startedAt } }, ev.seq);
        }
        this.announce(ev.threadId, ev.seq);
        return;
      case 'turn.done':
      case 'turn.error':
        if (turnId && ended && placed) {
          this.publish('turn.finished', {
            turn: {
              threadId: ev.threadId,
              turnId,
              origin: placed.origin,
              startedAt: placed.startedAt,
              finishedAt: ev.ts,
              outcome: ended.outcome,
              ...(ended.code ? { code: ended.code } : {}),
            },
          }, ev.seq);
        }
        this.announce(ev.threadId, ev.seq);
        return;
      case 'approval.request':
      case 'input.request': {
        const wait = this.waitOf(ev);
        if (wait) this.publish('attention.raised', { wait }, ev.seq);
        this.announce(ev.threadId, ev.seq);
        return;
      }
      case 'approval.resolved':
      case 'input.resolved': {
        const wait = this.waitOf(ev);
        if (wait) this.publish('attention.resolved', { wait, how: resolution(ev) }, ev.seq);
        if (wait && wait.kind !== 'approval') this.inputKinds.delete(wait.id);
        this.announce(ev.threadId, ev.seq);
        return;
      }
    }
  }
}

function resolution(ev: StoredEvent): NotificationPayloads['attention.resolved']['how'] {
  if (ev.type === 'input.resolved' && ev.data.reason === 'ended') return 'turn-ended';
  const outcome = (ev.type === 'approval.resolved' ? ev.data.decision : ev.data.answer) as { cancelled?: unknown } | undefined;
  return outcome?.cancelled === true ? 'cancelled' : 'answered';
}
