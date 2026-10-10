import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type AgentAdapter,
  type AgentSession,
  type AgentSessionSummary,
  type ApprovalDecision,
  type ApprovalRequest,
  type EffortLevel,
  type ModelOption,
  type PermissionMode,
  type SlashCommand,
  type TurnHooks,
  type TurnInput,
} from './adapters/types.js';
import { MAX_IMAGES, sniffImageType, type AttachmentStore, type StoredAttachment } from './attachments.js';
import { HttpError } from './errors.js';
import { isWithinWorkdirs } from './workdirs.js';
import { compactDeltas, type EmittedEvent, type EventType, type StoredEvent } from './events.js';
import type { SectionRecord, Store, ThreadRecord } from './store.js';

/** A thread as the API returns it: the stored record plus values worked out from it. */
export type ThreadView = ThreadRecord & {
  /** Shell command that continues this conversation in a terminal. Null until the agent session exists. */
  resumeCommand: string | null;
  /**
   * `cwd` with symlinks resolved. Agents report file paths in this form, so the UI needs it to
   * recognise which paths are inside the thread's directory.
   */
  cwdReal: string;
  /** The agent has stopped to ask for approval and is waiting for an answer. */
  waiting: boolean;
  /** Messages sent while a turn was running. They go out, in order, as turns finish. */
  queued: Array<{ id: string; text: string; images: number }>;
  /** Turns the terminal added to this session since the hub last wrote to it. */
  terminalActivity: boolean;
};

interface QueuedTurn {
  id: string;
  text: string;
  images: unknown[];
}

/** How many messages may wait behind a running turn. */
export const MAX_QUEUED = 5;
/** The largest image file the hub will serve from a thread's directory. */
const MAX_SERVED_IMAGE_BYTES = 20 * 1024 * 1024;

/** Quotes a path for a POSIX shell, leaving plain paths readable. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A turn's identity for matching hub turns against the agent's history. */
function turnKey(text: string): string {
  return text.trim().slice(0, 200);
}

export interface AgentInfo {
  id: string;
  label: string;
  available: boolean;
  capabilities: AgentAdapter['capabilities'];
}

export { HttpError };

interface PendingApproval {
  threadId: string;
  /** The option ids the agent offered. Anything else is refused instead of being passed on. */
  optionIds: string[];
  resolve(decision: ApprovalDecision): void;
}

type Listener = (event: StoredEvent) => void;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Owns thread lifecycle: starts agent sessions, runs turns, persists every event,
 * fans events out to subscribers, and routes approval decisions back to agents.
 */
export class ThreadManager {
  private readonly sessions = new Map<string, AgentSession>();
  /** Turns in flight. `cancelRequested` covers cancels that arrive before the agent session exists. */
  private readonly running = new Map<string, { turnId: string; cancelRequested: boolean }>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly listeners = new Set<Listener>();
  /** Agent sessions being imported right now, so the same one is not imported twice in parallel. */
  private readonly importing = new Set<string>();
  /** Threads whose session is being synced right now, for the same reason. */
  private readonly syncing = new Set<string>();
  /** Messages waiting for the running turn of their thread to finish. Kept in memory only. */
  private readonly queues = new Map<string, QueuedTurn[]>();

  constructor(
    private readonly store: Store,
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly workdirs: string[],
    private readonly attachments: AttachmentStore,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get allowedWorkdirs(): string[] {
    return [...this.workdirs];
  }

  async listAgents(): Promise<AgentInfo[]> {
    const out: AgentInfo[] = [];
    for (const [id, a] of this.adapters) {
      // The key is the instance id: a second account of the same CLI must not report the
      // adapter's own name, or the picker could not tell the two apart.
      out.push({ id, label: a.label, available: await a.available(), capabilities: a.capabilities });
    }
    return out;
  }

  /** Commands for an agent. `cwd` selects project-level commands and must be an allowed workdir. */
  async listCommands(agent: string, cwd?: string): Promise<SlashCommand[]> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(404, `unknown agent: ${agent}`);
    const dir = cwd ? resolve(cwd) : undefined;
    if (dir && !isWithinWorkdirs(dir, this.workdirs)) throw new HttpError(400, 'cwd is not in the allowed workdirs');
    return adapter.commands(dir);
  }

  /**
   * Conversations the agent already has, in directories the hub is allowed to work in.
   * `threadId` is set for those that are already a thread here (including archived ones).
   */
  async listAgentSessions(agent: string): Promise<Array<AgentSessionSummary & { threadId: string | null }>> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(404, `unknown agent: ${agent}`);
    if (!adapter.capabilities.history || !adapter.listSessions) {
      throw new HttpError(400, `${agent} has no session history to import`);
    }
    const sessions = await adapter.listSessions();
    return sessions
      // A session whose directory has since been removed cannot be continued, so it is not offered.
      .filter((s) => s.cwd && isDirectory(s.cwd) && isWithinWorkdirs(s.cwd, this.workdirs))
      .map((s) => ({ ...s, threadId: this.store.findThreadByAgentSession(agent, s.id)?.id ?? null }))
      // Newest first; sessions with no date go last.
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  /**
   * Makes a thread out of a conversation the agent already has. Its past turns are written to the
   * event log once; the thread then continues the same agent session, so the terminal and the hub
   * keep sharing it.
   */
  async importSession(input: { agent?: unknown; sessionId?: unknown }): Promise<ThreadView> {
    const agent = String(input.agent ?? '');
    const sessionId = String(input.sessionId ?? '');
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(400, `unknown agent: ${agent}`);
    const summary = (await this.listAgentSessions(agent)).find((s) => s.id === sessionId);
    if (!summary) throw new HttpError(404, 'session not found, or it is outside the allowed workdirs');
    const key = `${agent}:${sessionId}`;
    if (summary.threadId || this.importing.has(key)) throw new HttpError(409, 'this session is already a thread');
    if (!adapter.loadHistory) throw new HttpError(400, `${agent} has no session history to import`);

    this.importing.add(key);
    try {
      const turns = await adapter.loadHistory(sessionId, summary.cwd);
      const title = (summary.title || turns[0]?.text || '').split('\n')[0].trim().slice(0, 60) || '导入的会话';
      const permissionMode = 'auto_edit'; // the same default a new thread gets
      const id = randomUUID();

      // Images are files, written before the database work so a failure there leaves nothing half-done.
      const images: StoredAttachment[][] = turns.map((turn) => {
        if (turn.images.length === 0) return [];
        try {
          return this.attachments.save(id, turn.images.slice(0, MAX_IMAGES)).stored;
        } catch {
          return []; // an image the hub would not accept is left out; the text still comes across
        }
      });

      const events: StoredEvent[] = [];
      try {
        this.store.transaction(() => {
          this.store.createThread({ id, agent, cwd: summary.cwd, title, permissionMode, model: null, effort: null });
          this.store.updateThread(id, { agentSessionId: sessionId, hubTurnAt: new Date().toISOString() });
          const add = (turnId: string | null, type: EventType, data: Record<string, unknown>) =>
            events.push(this.store.appendEvent(id, turnId, type, data));
          add(null, 'thread.created', { agent, cwd: summary.cwd, imported: true });
          turns.forEach((turn, i) => {
            const turnId = randomUUID();
            add(turnId, 'turn.started', { text: turn.text, imported: true, ...(images[i].length ? { images: images[i] } : {}) });
            for (const ev of turn.events) add(turnId, ev.type, ev.data);
            add(turnId, 'turn.done', { stopReason: 'end_turn', imported: true });
          });
        });
      } catch (err) {
        this.attachments.removeThread(id);
        throw err;
      }
      for (const ev of events) for (const l of this.listeners) l(ev);
      return this.threadView(id);
    } finally {
      this.importing.delete(key);
    }
  }

  /**
   * Copies a thread into a new one that can go its own way. The agent copies its side of the
   * conversation; the hub copies the event log and the images.
   */
  async forkThread(id: string): Promise<ThreadView> {
    const thread = this.getThread(id);
    const adapter = this.adapters.get(thread.agent);
    if (!adapter?.capabilities.fork || !adapter.forkSession) throw new HttpError(400, `${thread.agent} cannot fork a conversation`);
    if (!thread.agentSessionId) throw new HttpError(400, 'there is nothing to fork yet; send a message first');
    if (this.running.has(id)) throw new HttpError(409, 'wait for the running turn to finish before forking');

    let forkedSessionId: string;
    try {
      forkedSessionId = await adapter.forkSession(thread.agentSessionId, thread.cwd);
    } catch (err) {
      throw new HttpError(502, `could not fork the ${thread.agent} session: ${err instanceof Error ? err.message : err}`);
    }

    const copyId = randomUUID();
    this.attachments.copyThread(thread.id, copyId);
    try {
      this.store.transaction(() => {
        this.store.createThread({
          id: copyId,
          agent: thread.agent,
          cwd: thread.cwd,
          title: `${thread.title}（分叉）`,
          permissionMode: thread.permissionMode,
          model: thread.model,
          effort: thread.effort,
          forkedFrom: thread.id,
        });
        this.store.updateThread(copyId, { agentSessionId: forkedSessionId, sectionId: thread.sectionId }, { touch: true });
        this.store.copyEvents(thread.id, copyId);
      });
    } catch (err) {
      this.attachments.removeThread(copyId);
      throw err;
    }
    this.emitThreadEvent(copyId, null, 'thread.updated', { forkedFrom: thread.id });
    return this.threadView(copyId);
  }

  /** Where a stored image is on disk, for the HTTP layer to stream. */
  getAttachment(threadId: string, attachmentId: string): { path: string; mimeType: string; size: number } {
    this.getThread(threadId);
    const found = this.attachments.find(threadId, attachmentId);
    if (!found) throw new HttpError(404, 'attachment not found');
    return found;
  }

  async listModels(agent: string): Promise<ModelOption[]> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(404, `unknown agent: ${agent}`);
    return adapter.models();
  }

  listThreads(opts: { archived?: boolean } = {}): ThreadView[] {
    return this.store.listThreads(opts).map((t) => this.view(t));
  }

  threadView(id: string): ThreadView {
    return this.view(this.getThread(id));
  }

  private view(thread: ThreadRecord): ThreadView {
    const adapter = this.adapters.get(thread.agent);
    const resumeCommand =
      adapter && thread.agentSessionId
        ? `cd ${shellQuote(thread.cwd)} && ${adapter.resumeCommand(thread.agentSessionId)}`
        : null;
    let cwdReal = thread.cwd;
    try {
      cwdReal = realpathSync(thread.cwd);
    } catch {
      // The directory is gone; the stored spelling is the best there is.
    }
    let waiting = false;
    for (const p of this.approvals.values()) if (p.threadId === thread.id) waiting = true;
    const queued = (this.queues.get(thread.id) ?? []).map((q) => ({ id: q.id, text: q.text, images: q.images.length }));
    // The terminal wrote to this session after the hub last did: the UI asks before sending more.
    const terminalActivity = thread.externalAt !== null && (thread.hubTurnAt === null || thread.externalAt > thread.hubTurnAt);
    return { ...thread, resumeCommand, cwdReal, waiting, queued, terminalActivity };
  }

  /**
   * An image file the agent made or mentioned, for showing it in the thread. Only files inside the
   * thread's directory, or the agent's own folder for this session, and only real images.
   */
  getThreadImage(threadId: string, rawPath: unknown): { path: string; mimeType: string; size: number } {
    const thread = this.getThread(threadId);
    const notFound = new HttpError(404, 'no such image in this thread');
    if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096) throw new HttpError(400, 'path is required');
    const given = rawPath.startsWith('file://') ? rawPath.slice('file://'.length) : rawPath;

    const adapter = this.adapters.get(thread.agent);
    const roots = [thread.cwd, ...(thread.agentSessionId ? (adapter?.artifactDirs?.(thread.agentSessionId) ?? []) : [])];
    let real: string;
    try {
      // Symlinks are resolved first, so a link inside the directory cannot point the way out.
      real = realpathSync(isAbsolute(given) ? given : resolve(thread.cwd, given));
    } catch {
      throw notFound;
    }
    const inside = roots.some((root) => {
      try {
        const base = realpathSync(root);
        return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
      } catch {
        return false;
      }
    });
    if (!inside) throw notFound;

    const stat = statSync(real);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SERVED_IMAGE_BYTES) throw notFound;
    const head = Buffer.alloc(16);
    const fd = openSync(real, 'r');
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    const mimeType = sniffImageType(head);
    if (!mimeType) throw notFound;
    return { path: real, mimeType, size: stat.size };
  }

  listSections(): SectionRecord[] {
    return this.store.listSections();
  }

  createSection(name: unknown): SectionRecord {
    return this.store.createSection(randomUUID(), this.sectionName(name));
  }

  renameSection(id: string, name: unknown): SectionRecord {
    if (!this.store.getSection(id)) throw new HttpError(404, 'section not found');
    this.store.renameSection(id, this.sectionName(name));
    return this.store.getSection(id)!;
  }

  /** Deletes a section. Its threads stay and are listed under their project again. */
  deleteSection(id: string): void {
    if (!this.store.getSection(id)) throw new HttpError(404, 'section not found');
    this.store.deleteSection(id);
  }

  private sectionName(name: unknown): string {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value) throw new HttpError(400, 'section name is empty');
    if (value.length > 40) throw new HttpError(400, 'section name is longer than 40 characters');
    return value;
  }

  getThread(id: string): ThreadRecord {
    const t = this.store.getThread(id);
    if (!t) throw new HttpError(404, 'thread not found');
    return t;
  }

  async updateThread(
    id: string,
    updates: {
      title?: string;
      pinned?: boolean;
      permissionMode?: string;
      model?: string | null;
      effort?: string | null;
      archived?: boolean;
      sectionId?: string | null;
      unread?: boolean;
    },
  ): Promise<ThreadView> {
    const thread = this.getThread(id);
    const patch: Record<string, unknown> = {};
    if (updates.title !== undefined) patch.title = String(updates.title).trim() || thread.title;
    if (updates.pinned !== undefined) patch.pinned = Boolean(updates.pinned);
    if (updates.sectionId !== undefined) {
      if (updates.sectionId !== null && !this.store.getSection(updates.sectionId)) {
        throw new HttpError(400, 'section not found');
      }
      patch.sectionId = updates.sectionId;
    }
    if (updates.archived !== undefined) {
      if (updates.archived && this.running.has(id)) {
        throw new HttpError(409, 'stop the running turn before archiving this thread');
      }
      // Archiving stops the agent process. The record and the agent's session stay, so it can come back.
      if (updates.archived) await this.dropSession(id);
      patch.archivedAt = updates.archived ? (thread.archivedAt ?? new Date().toISOString()) : null;
    }
    if (updates.unread !== undefined) {
      if (typeof updates.unread !== 'boolean') throw new HttpError(400, 'unread must be true or false');
      patch.unread = updates.unread;
    }
    if (updates.permissionMode !== undefined) {
      const mode = this.validatePermissionMode(thread.agent, updates.permissionMode);
      patch.permissionMode = mode;
      // A live session switches now; otherwise the next session starts with the new level.
      const session = this.sessions.get(id);
      if (session?.setPermissionMode) await session.setPermissionMode(mode);
    }
    if (updates.model !== undefined) {
      if (updates.model === null) {
        // Back to the agent's own default: only a restart can do that.
        patch.model = null;
        await this.restartForChange(thread, 'model');
      } else {
        const model = await this.validateModel(thread.agent, updates.model);
        patch.model = model;
        await this.applyLive(thread, 'model', (s) => s.setModel?.(model) ?? Promise.resolve(false));
      }
    }
    // Effort is checked against the model the thread will have after this update.
    const nextModel = patch.model !== undefined ? (patch.model as string | null) : thread.model;
    if (updates.effort !== undefined) {
      if (updates.effort === null) {
        patch.effort = null;
        await this.restartForChange(thread, 'effort');
      } else {
        const effort = await this.validateEffort(thread.agent, nextModel, updates.effort);
        patch.effort = effort;
        await this.applyLive(thread, 'effort', (s) => s.setEffort?.(effort) ?? Promise.resolve(false));
      }
    } else if (patch.model !== undefined && thread.effort) {
      // The model changed but the effort was left alone: drop it if the new model cannot take it.
      const supported = await this.effortsFor(thread.agent, nextModel);
      if (!supported.includes(thread.effort as EffortLevel)) {
        patch.effort = null;
        await this.restartForChange(thread, 'effort');
      }
    }
    this.store.updateThread(id, patch as any);
    this.emitThreadEvent(id, null, 'thread.updated', {});
    return this.threadView(id);
  }

  /**
   * Applies a model or effort change. If the live session cannot change it in place, the session is
   * closed and the next turn resumes the same agent session with the new setting.
   */
  private async applyLive(
    thread: ThreadRecord,
    what: 'model' | 'effort',
    apply: (s: AgentSession) => Promise<boolean>,
  ): Promise<void> {
    const session = this.sessions.get(thread.id);
    if (!session) return;
    const inPlace = await apply(session).catch(() => false);
    if (inPlace) return;
    if (this.running.has(thread.id)) {
      throw new HttpError(409, `cannot change ${what} while a turn is running; try again after it finishes`);
    }
    await this.dropSession(thread.id);
  }

  private async restartForChange(thread: ThreadRecord, what: 'model' | 'effort'): Promise<void> {
    if (!this.sessions.has(thread.id)) return;
    if (this.running.has(thread.id)) {
      throw new HttpError(409, `cannot change ${what} while a turn is running; try again after it finishes`);
    }
    await this.dropSession(thread.id);
  }

  /**
   * Deletes a thread, its events and its images for good. A running turn must be cancelled first.
   * With `agentSession`, the agent's own copy of the conversation is removed too, where the agent
   * supports that. Without it, the conversation can still be continued from a terminal.
   */
  async deleteThread(id: string, opts: { agentSession?: boolean } = {}): Promise<void> {
    const thread = this.getThread(id);
    if (this.running.has(id)) throw new HttpError(409, 'cancel the running turn before deleting this thread');
    await this.dropSession(id);
    if (opts.agentSession && thread.agentSessionId) {
      const adapter = this.adapters.get(thread.agent);
      if (!adapter?.capabilities.deleteSession || !adapter.deleteSession) {
        throw new HttpError(400, `${thread.agent} sessions cannot be deleted from here`);
      }
      try {
        await adapter.deleteSession(thread.agentSessionId, thread.cwd);
      } catch (err) {
        // Nothing has been removed yet, so the user can retry or delete without this option.
        throw new HttpError(502, `could not delete the ${thread.agent} session: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.emitThreadEvent(id, null, 'thread.updated', {});
    this.queues.delete(id);
    this.store.deleteThread(id);
    this.attachments.removeThread(id);
  }

  /** Model ids come from the adapter's own list, so a stale or invented id is rejected early. */
  private async validateModel(agent: string, model: string): Promise<string> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(400, `unknown agent: ${agent}`);
    const options: ModelOption[] = await adapter.models();
    if (!options.some((o) => o.id === model)) throw new HttpError(400, `unknown model for ${agent}: ${model}`);
    return model;
  }

  /**
   * Effort levels a model accepts. `model` null is the agent default. When the agent does not
   * report per-model levels, the agent-wide list applies.
   */
  private async effortsFor(agent: string, model: string | null): Promise<readonly EffortLevel[]> {
    const adapter = this.adapters.get(agent);
    if (!adapter) return [];
    const option = await this.modelOption(adapter, model);
    return option?.efforts ?? adapter.capabilities.effortLevels;
  }

  /**
   * What the agent reports about a model. For `null` (no override) this is the agent's default:
   * an entry with the id "default" if the agent has one, else the entry it marks as its default.
   */
  private async modelOption(adapter: AgentAdapter, model: string | null): Promise<ModelOption | undefined> {
    const options = await adapter.models();
    if (model !== null) return options.find((o) => o.id === model);
    return options.find((o) => o.id === 'default') ?? options.find((o) => o.isDefault);
  }

  private async validateEffort(agent: string, model: string | null, effort: string): Promise<EffortLevel> {
    const supported = await this.effortsFor(agent, model);
    if (supported.length === 0) {
      throw new HttpError(400, `${model ?? agent} has no thinking effort setting`);
    }
    if (!(EFFORT_LEVELS as readonly string[]).includes(effort) || !supported.includes(effort as EffortLevel)) {
      throw new HttpError(400, `unsupported effort for ${model ?? agent}: ${effort}`);
    }
    return effort as EffortLevel;
  }

  /** Checks a permission level against what the thread's agent supports. */
  private validatePermissionMode(agent: string, mode: string): PermissionMode {
    const adapter = this.adapters.get(agent);
    const supported = adapter?.capabilities.permissionModes ?? [];
    if (supported.length === 0) throw new HttpError(400, `${agent} has no permission modes`);
    if (!(PERMISSION_MODES as readonly string[]).includes(mode) || !supported.includes(mode as PermissionMode)) {
      throw new HttpError(400, `unsupported permission mode for ${agent}: ${mode}`);
    }
    return mode as PermissionMode;
  }

  listEvents(threadId: string, afterSeq: number): StoredEvent[] {
    this.getThread(threadId);
    return this.store.listEvents(threadId, afterSeq);
  }

  /**
   * Everything after a sequence number, however much that is: what a stream replays before it
   * goes live. Stopping at a page size here would leave a hole between the replay and the live
   * events that nothing fills in later.
   */
  listEventsSince(threadId: string, afterSeq: number): StoredEvent[] {
    this.getThread(threadId);
    return compactDeltas(this.store.listEvents(threadId, afterSeq, -1));
  }

  /** How far back, in stored events, one page of history reaches before stopping at a turn's start. */
  private static readonly PAGE_BUDGET = 20_000;

  /**
   * One page of a thread's history for the view: the newest turns, or the ones just before
   * `beforeSeq`. Pages begin where a turn begins; see Store.listEventsPage.
   */
  listEventsPage(threadId: string, beforeSeq?: number): StoredEvent[] {
    this.getThread(threadId);
    return compactDeltas(this.store.listEventsPage(threadId, ThreadManager.PAGE_BUDGET, beforeSeq));
  }

  /**
   * Run once when the daemon starts. A thread still marked running was cut off when the last
   * daemon stopped without ending its turn; nothing is running now. The open turn gets an ending,
   * so the thread reads as interrupted instead of working forever.
   */
  recoverInterrupted(): void {
    for (const thread of [...this.store.listThreads(), ...this.store.listThreads({ archived: true })]) {
      if (thread.status !== 'running') continue;
      const turnId = this.store.openTurn(thread.id);
      if (turnId) {
        this.emitThreadEvent(thread.id, turnId, 'turn.error', {
          message: 'The hub restarted while this turn was running.',
          code: 'interrupted',
        });
      }
      this.store.updateThread(thread.id, { status: turnId ? 'error' : 'idle' });
    }
  }

  /** How many hub-only turns may be skipped while matching the agent's history. See syncThread. */
  private static readonly SYNC_SKIP_TOLERANCE = 3;

  /**
   * Brings a thread up to date with what the terminal did to its session: the agent's history is
   * read (without touching the conversation), matched against the turns the hub knows, and the
   * turns that are new here are appended, marked as coming from the terminal.
   *
   * Matching walks both lists from the start. A hub turn the agent never recorded (cancelled before
   * it got there) is skipped, up to a small tolerance; anything the agent has beyond that is new.
   * When the lists disagree beyond the tolerance nothing is written: better to miss an update than
   * to append a wrong one.
   */
  async syncThread(id: string): Promise<{ added: number; terminalActivity: boolean }> {
    const thread = this.getThread(id);
    const adapter = this.adapters.get(thread.agent);
    if (!thread.agentSessionId || !adapter?.capabilities.history || !adapter.loadHistory) {
      throw new HttpError(400, `this thread's session cannot be read back`);
    }
    // A running turn is writing to the same session; syncing now would race it.
    if (this.running.has(id)) return { added: 0, terminalActivity: this.view(thread).terminalActivity };
    // The UI polls and anything else may sync too; two readers would both append the same turns.
    if (this.syncing.has(id)) return { added: 0, terminalActivity: this.view(thread).terminalActivity };
    this.syncing.add(id);
    try {
      return await this.doSync(thread);
    } finally {
      this.syncing.delete(id);
    }
  }

  private async doSync(thread: ThreadRecord): Promise<{ added: number; terminalActivity: boolean }> {
    const { id } = thread;
    const adapter = this.adapters.get(thread.agent);
    if (!thread.agentSessionId || !adapter?.capabilities.history || !adapter.loadHistory) {
      throw new HttpError(400, `this thread's session cannot be read back`);
    }

    const [agentTurns, hubTexts] = await Promise.all([
      adapter.loadHistory(thread.agentSessionId, thread.cwd),
      Promise.resolve(
        // Every turn the hub has, not one page of the log: a turn missing from this list would
        // look new on the agent's side and be appended again on every sync.
        this.store.listEventsOfType(id, 'turn.started').map((ev) => turnKey(String(ev.data.text ?? ''))),
      ),
    ]);

    let ai = 0;
    let hi = 0;
    while (ai < agentTurns.length && hi < hubTexts.length) {
      if (turnKey(agentTurns[ai].text) === hubTexts[hi]) {
        ai++;
        hi++;
        continue;
      }
      // The agent's turn may sit further down the hub's list: hub turns the agent never recorded
      // (cancelled before they got there) are skipped, up to a small tolerance.
      let j = hi;
      while (j < hubTexts.length && j - hi < ThreadManager.SYNC_SKIP_TOLERANCE && turnKey(agentTurns[ai].text) !== hubTexts[j]) j++;
      if (j >= hubTexts.length || turnKey(agentTurns[ai].text) !== hubTexts[j]) {
        return { added: 0, terminalActivity: this.view(thread).terminalActivity }; // histories disagree
      }
      hi = j;
    }
    const fresh = agentTurns.slice(ai);
    if (fresh.length === 0) return { added: 0, terminalActivity: this.view(thread).terminalActivity };

    const events: StoredEvent[] = [];
    const images = fresh.map((turn) => {
      if (turn.images.length === 0) return [];
      try {
        return this.attachments.save(id, turn.images.slice(0, MAX_IMAGES)).stored;
      } catch {
        return [];
      }
    });
    this.store.transaction(() => {
      fresh.forEach((turn, i) => {
        const turnId = randomUUID();
        const add = (type: EventType, data: Record<string, unknown>) => events.push(this.store.appendEvent(id, turnId, type, data));
        add('turn.started', { text: turn.text, fromTerminal: true, ...(images[i].length ? { images: images[i] } : {}) });
        for (const ev of turn.events) add(ev.type, ev.data);
        add('turn.done', { stopReason: 'end_turn', fromTerminal: true });
      });
      this.store.updateThread(id, { externalAt: new Date().toISOString() }, { touch: true });
    });
    for (const ev of events) for (const l of this.listeners) l(ev);
    this.emitThreadEvent(id, null, 'thread.updated', {});
    return { added: fresh.length, terminalActivity: true };
  }

  async createThread(input: {
    agent: string;
    cwd: string;
    title?: string;
    permissionMode?: string;
    model?: string | null;
    effort?: string | null;
    sectionId?: string | null;
  }): Promise<ThreadView> {
    const adapter = this.adapters.get(input.agent);
    if (!adapter) throw new HttpError(400, `unknown agent: ${input.agent}`);
    const cwd = resolve(input.cwd);
    // An allowed directory or anything inside one. The directory picker offers subdirectories.
    if (!isWithinWorkdirs(cwd, this.workdirs)) throw new HttpError(400, 'cwd is not in the allowed workdirs');
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, 'cwd does not exist');
    if (input.sectionId !== undefined && input.sectionId !== null && !this.store.getSection(input.sectionId)) {
      throw new HttpError(400, 'section not found');
    }
    // Default for new threads: auto-approve edits, still ask before other actions.
    const permissionMode =
      adapter.capabilities.permissionModes.length === 0
        ? 'auto_edit'
        : this.validatePermissionMode(input.agent, input.permissionMode ?? 'auto_edit');
    const model = input.model ? await this.validateModel(input.agent, input.model) : null;
    const effort = input.effort ? await this.validateEffort(input.agent, model, input.effort) : null;
    const title = (input.title ?? '').trim() || 'New thread';
    const thread = this.store.createThread({
      id: randomUUID(),
      agent: input.agent,
      cwd,
      title,
      permissionMode,
      model,
      effort,
      ...(input.sectionId ? { sectionId: input.sectionId } : {}),
    });
    this.emitThreadEvent(thread.id, null, 'thread.created', { agent: thread.agent, cwd: thread.cwd });
    return this.view(thread);
  }

  /**
   * Starts a turn in the background and returns its id right away.
   * A turn needs text, images, or both. Images are checked and stored before anything else changes.
   *
   * With `queue`, a message sent while a turn is running waits its turn instead of being refused:
   * it goes out when the running turn (and anything queued before it) has finished.
   */
  async startTurn(
    threadId: string,
    input: { text?: unknown; images?: unknown; queue?: unknown },
  ): Promise<{ turnId: string } | { queued: true; id: string }> {
    const thread = this.getThread(threadId);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const rawImages = Array.isArray(input.images) ? input.images : [];
    if (!text && rawImages.length === 0) throw new HttpError(400, 'text is empty');
    if (thread.archivedAt) throw new HttpError(409, 'this thread is archived; restore it first');
    if (this.running.has(threadId)) {
      if (input.queue !== true) throw new HttpError(409, 'a turn is already running in this thread');
      const queue = this.queues.get(threadId) ?? [];
      if (queue.length >= MAX_QUEUED) throw new HttpError(409, `at most ${MAX_QUEUED} messages can wait in a thread`);
      this.attachments.check(rawImages); // a bad image is refused now, not when its turn comes
      const queued: QueuedTurn = { id: randomUUID(), text, images: rawImages };
      this.queues.set(threadId, [...queue, queued]);
      this.emitThreadEvent(threadId, null, 'thread.updated', {});
      return { queued: true, id: queued.id };
    }

    if (rawImages.length > 0) {
      const adapter = this.adapters.get(thread.agent);
      if (!adapter?.capabilities.images) throw new HttpError(400, `${thread.agent} does not accept images`);
      const option = await this.modelOption(adapter, thread.model);
      if (option?.images === false && !option.imagesVia) throw new HttpError(400, `${option.label} cannot read images; pick another model`);
      // The model lookup above can take a moment, so check again before claiming the thread.
      if (this.running.has(threadId)) throw new HttpError(409, 'a turn is already running in this thread');
    }
    const { stored, images } = this.attachments.save(threadId, rawImages);

    const turnId = randomUUID();
    this.running.set(threadId, { turnId, cancelRequested: false });
    this.store.updateThread(threadId, { status: 'running', hubTurnAt: new Date().toISOString() }, { touch: true });

    if (thread.title === 'New thread') {
      const title = text.split('\n')[0].slice(0, 60) || '图片';
      this.store.updateThread(threadId, { title });
    }

    this.emitThreadEvent(threadId, turnId, 'turn.started', { text, ...(stored.length ? { images: stored } : {}) });
    void this.runTurn(thread, turnId, { text, images });
    return { turnId };
  }

  /** Takes a waiting message out of the queue. */
  removeQueued(threadId: string, queuedId: string): void {
    this.getThread(threadId);
    const queue = this.queues.get(threadId) ?? [];
    if (!queue.some((q) => q.id === queuedId)) throw new HttpError(404, 'no such waiting message');
    this.setQueue(threadId, queue.filter((q) => q.id !== queuedId));
  }

  /** Interrupts the running turn so that this waiting message goes out next, ahead of the others. */
  async sendQueuedNow(threadId: string, queuedId: string): Promise<void> {
    this.getThread(threadId);
    const queue = this.queues.get(threadId) ?? [];
    const chosen = queue.find((q) => q.id === queuedId);
    if (!chosen) throw new HttpError(404, 'no such waiting message');
    this.setQueue(threadId, [chosen, ...queue.filter((q) => q !== chosen)]);
    await this.cancelTurn(threadId, { keepQueue: true });
  }

  private setQueue(threadId: string, queue: QueuedTurn[]): void {
    if (queue.length) this.queues.set(threadId, queue);
    else this.queues.delete(threadId);
    this.emitThreadEvent(threadId, null, 'thread.updated', {});
  }

  /** Sends the next waiting message, if there is one. Called whenever a turn has finished. */
  private startNextQueued(threadId: string): void {
    const queue = this.queues.get(threadId);
    if (!queue?.length) return;
    const [next, ...rest] = queue;
    if (rest.length) this.queues.set(threadId, rest);
    else this.queues.delete(threadId);
    this.startTurn(threadId, { text: next.text, images: next.images }).catch((err) => {
      // The thread was archived or deleted in the meantime, or the message is no longer acceptable.
      console.error(`could not send a queued message: ${err instanceof Error ? err.message : err}`);
      this.queues.delete(threadId);
      if (this.store.getThread(threadId)) this.emitThreadEvent(threadId, null, 'thread.updated', {});
    });
  }

  /**
   * Stops the running turn. Stopping means stopping: messages waiting behind it are not sent, they
   * are handed back (their text) so the caller can put them in front of the user again.
   */
  async cancelTurn(threadId: string, opts: { keepQueue?: boolean } = {}): Promise<{ dropped: string[] }> {
    this.getThread(threadId);
    const dropped = opts.keepQueue ? [] : (this.queues.get(threadId) ?? []).map((q) => q.text).filter(Boolean);
    if (!opts.keepQueue && this.queues.has(threadId)) this.setQueue(threadId, []);
    await this.stopTurn(threadId);
    return { dropped };
  }

  private async stopTurn(threadId: string): Promise<void> {
    const run = this.running.get(threadId);
    if (run) run.cancelRequested = true;
    for (const [approvalId, p] of this.approvals) {
      if (p.threadId === threadId) this.resolveApproval(approvalId, { cancelled: true });
    }
    const session = this.sessions.get(threadId);
    if (session) await session.cancel();
  }

  /**
   * Answers a pending approval. Returns false if there is none with this id.
   * An option the agent did not offer is an error: agents treat unknown ids as a refusal,
   * which would silently turn a mistyped "allow" into "deny".
   */
  resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const p = this.approvals.get(approvalId);
    if (!p) return false;
    if (!('cancelled' in decision) && !p.optionIds.includes(decision.optionId)) {
      throw new HttpError(400, `not one of the offered options: ${decision.optionId}`);
    }
    this.approvals.delete(approvalId);
    p.resolve(decision);
    return true;
  }

  /** Closes live agent processes. Threads and events stay in the store. */
  async shutdown(): Promise<void> {
    for (const threadId of [...this.running.keys()]) await this.cancelTurn(threadId).catch(() => undefined);
    const deadline = Date.now() + 3000;
    while (this.running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    for (const [, s] of this.sessions) await s.close().catch(() => undefined);
    this.sessions.clear();
  }

  private async runTurn(thread: ThreadRecord, turnId: string, input: TurnInput): Promise<void> {
    let finalStatus: ThreadRecord['status'] = 'idle';
    // A finished turn is something new to look at. A turn the user stopped is not.
    let unread = true;
    try {
      const session = await this.ensureSession(thread);
      if (this.running.get(thread.id)?.cancelRequested) {
        // Cancelled while the agent was starting: never send the prompt.
        unread = false;
        this.emitThreadEvent(thread.id, turnId, 'turn.done', { stopReason: 'cancelled' });
        return;
      }
      const result = await session.prompt(input, this.hooksFor(thread.id, turnId));
      if (result.stopReason === 'cancelled') unread = false;
      if (result.stopReason === 'error') {
        finalStatus = 'error';
        this.emitThreadEvent(thread.id, turnId, 'turn.error', {
          message: result.error ?? 'agent error',
          ...(result.errorCode ? { code: result.errorCode, refused: result.refused ?? [] } : {}),
        });
      } else {
        this.emitThreadEvent(thread.id, turnId, 'turn.done', { stopReason: result.stopReason });
      }
    } catch (err) {
      finalStatus = 'error';
      const message = err instanceof Error ? err.message : String(err);
      this.emitThreadEvent(thread.id, turnId, 'turn.error', { message });
      await this.dropSession(thread.id);
    } finally {
      this.running.delete(thread.id);
      // The thread may have been deleted while its last turn was winding down.
      if (this.store.getThread(thread.id)) {
        this.store.updateThread(thread.id, { status: finalStatus, ...(unread ? { unread: true } : {}) }, { touch: true });
        this.emitThreadEvent(thread.id, null, 'thread.updated', {});
        this.startNextQueued(thread.id);
      }
    }
  }

  private async ensureSession(thread: ThreadRecord): Promise<AgentSession> {
    const existing = this.sessions.get(thread.id);
    if (existing) return existing;
    const adapter = this.adapters.get(thread.agent);
    if (!adapter) throw new Error(`unknown agent: ${thread.agent}`);
    const session = await adapter.start({
      cwd: thread.cwd,
      resumeId: thread.agentSessionId ?? undefined,
      permissionMode: thread.permissionMode as PermissionMode,
      model: thread.model ?? undefined,
      effort: (thread.effort ?? undefined) as EffortLevel | undefined,
    });
    this.sessions.set(thread.id, session);
    if (session.agentSessionId !== thread.agentSessionId) {
      this.store.updateThread(thread.id, { agentSessionId: session.agentSessionId });
    }
    return session;
  }

  private async dropSession(threadId: string): Promise<void> {
    const s = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    if (s) await s.close().catch(() => undefined);
  }

  private hooksFor(threadId: string, turnId: string): TurnHooks {
    return {
      emit: (ev: EmittedEvent) => this.emitThreadEvent(threadId, turnId, ev.type, ev.data),
      requestApproval: (req: ApprovalRequest) => {
        const approvalId = randomUUID();
        this.emitThreadEvent(threadId, turnId, 'approval.request', {
          approvalId,
          title: req.title,
          options: req.options,
          toolCall: req.toolCall,
        });
        return new Promise<ApprovalDecision>((resolve) => {
          this.approvals.set(approvalId, {
            threadId,
            optionIds: req.options.map((o) => o.optionId),
            resolve: (decision) => {
              this.emitThreadEvent(threadId, turnId, 'approval.resolved', { approvalId, decision });
              resolve(decision);
            },
          });
        });
      },
    };
  }

  private emitThreadEvent(threadId: string, turnId: string | null, type: EventType, data: Record<string, unknown>): void {
    const stored = this.store.appendEvent(threadId, turnId, type, data);
    for (const l of this.listeners) l(stored);
  }
}
