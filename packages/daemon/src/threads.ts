import { AutoHandover, type AutoHandoverView, type HandoverTarget } from './auto-handover.js';
import type { VoiceTransport } from './voice-sessions.js';
import { VoiceConversation } from './voice-conversation.js';
import { UserInputs } from './user-input.js';
import type { SystemPrompt, WorkMode } from './adapters/types.js';
import { diagnosticFailure } from './adapters/diagnostics.js';
import { turnAnswer, type CoordinationManager, type CoordinationSetup } from './coordination.js';
import { parseProgress, progressInstructions } from './progress-report.js';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
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
  type PlanQuota,
  type SlashCommand,
  type TurnHooks,
  type TurnInput,
} from './adapters/types.js';
import { findFiles, listDir, readText, type Listing, type TextFile } from './browse.js';
import { referencedFile } from './artifacts.js';
import { MAX_IMAGES, sniffImageType, sniffSvg, type AttachmentStore, type StoredAttachment, type StoredVideo } from './attachments.js';
import { HttpError } from './errors.js';
import { handoverContext, handoverPrompt, synthesizeHandover, turnMessage } from './handover.js';
import { McpManager } from './mcp.js';
import { SkillsManager } from './skills.js';
import { isWithinWorkdirs, Workdirs } from './workdirs.js';
import { coalesceToolEvents, compactDeltas, type EmittedEvent, type EventType, type StoredEvent } from './events.js';
import type { SearchHit, SectionRecord, Store, ThreadRecord, ThreadWorktree, TodoRecord } from './store.js';
import { buildTrace, type TurnTrace } from './trace.js';
import { askedText } from './util.js';
import { addWorktree, countChanges, findCheckout, initRepository, removeWorktree, samePath, worktreeLeftovers, type Checkout, type Worktree } from './worktrees.js';

/** Why a copy cannot get a worktree of its own, said to whoever asked for one anyway. */
const WORKTREE_REFUSALS = {
  agent: 'this agent cannot continue a copy in another directory',
  not_git: 'the directory is not in a git repository with a commit to start a worktree from',
  outside_workdirs: 'the repository is outside the allowed workdirs, so a worktree in it would be too',
} as const;

/** What forking a thread can offer besides a copy in the same directory. */
export interface ForkOptions {
  worktree: {
    available: boolean;
    /** Why not, when it is not: the agent cannot move a copy, the directory is not in a git repository, or the repository lies outside the allowed directories. */
    reason?: 'agent' | 'not_git' | 'outside_workdirs';
    /** The branch the thread's directory is on. Null when HEAD is detached. */
    branch?: string | null;
    /** How many files there differ from the last commit. They come along. */
    changes?: number;
  };
}

/** A thread as the API returns it: the stored record plus values worked out from it. */
export type ThreadView = Omit<ThreadRecord, 'worktree' | 'handover'> & {
  handover?: (NonNullable<ThreadRecord['handover']> & { automatic: boolean }) | null;
  autoHandover?: AutoHandoverView;
  /** `doing`, on a member: its latest task while it works, the opening of its answer once it has returned. */
  coordination?: { retired?: boolean; rootId: string; children: number; paused: boolean; doing?: string; team?: { name: string; status: import('./teams.js').TaskStatus; role: string; error?: string } };
  /** Working in the hub's scratch area: a thread that is in no project. */
  scratch: boolean;
  /** `of` is how the directory was spelled when the worktree was made; `ofReal` has symlinks resolved, like `cwdReal`. */
  worktree: (ThreadWorktree & { ofReal: string }) | null;
  /** Shell command that continues this conversation in a terminal. Null until the agent session exists. */
  resumeCommand: string | null;
  /**
   * `cwd` with symlinks resolved. Agents report file paths in this form, so the UI needs it to
   * recognise which paths are inside the thread's directory.
   */
  cwdReal: string;
  /** The agent is waiting for the user to respond. */
  waiting: boolean;
  waitingReason: 'approval' | 'question' | 'plan' | null;
  /** Messages sent while a turn was running. They go out, in order, as turns finish. */
  queued: Array<{ id: string; text: string; images: number; videos: number; targets?: string[]; error?: string }>;
  /** Turns the terminal added to this session since the hub last wrote to it. */
  terminalActivity: boolean;
  /** When the running turn started; null while nothing runs. */
  runningSince: string | null;
};

interface QueuedTurn {
  collaboration?: CoordinationSetup;
  error?: string;
  workMode?: WorkMode;
  mentions?: unknown[];
  id: string;
  text: string;
  images: unknown[];
  videos: string[];
}

/** How many messages may wait behind a running turn. */
export const MAX_QUEUED = 5;
/** The largest image file the hub will serve from a thread's directory. */
const MAX_SERVED_IMAGE_BYTES = 20 * 1024 * 1024;
/** An SVG is text, and the page holds it whole to show it; a drawing is far smaller than this. */
const MAX_SERVED_SVG_BYTES = 5 * 1024 * 1024;
/** How much of a file is read to tell what it is. An SVG may open with a declaration and a comment. */
const SNIFF_BYTES = 4096;
/** How long a plan-usage answer is reused. The probes spawn a CLI; a minute is fresh enough. */
const QUOTA_TTL_MS = 60_000;

/** Quotes a path for a POSIX shell, leaving plain paths readable. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A turn's identity for matching hub turns against the agent's history. */
function turnKey(text: string): string {
  return text.trim().slice(0, 200);
}

/**
 * Pairs the agent's turns with the hub's, walking both lists from the start. A hub turn the agent
 * never recorded (cancelled before it got there) is skipped, up to `tolerance` in a row. Returns,
 * for each hub turn, which agent turn it is (-1 for none), and the first agent turn the hub does
 * not have. Null when the two histories disagree beyond the tolerance.
 */
export function matchTurns(agentKeys: string[], hubKeys: string[], tolerance: number): { hubToAgent: number[]; agentNext: number } | null {
  const hubToAgent = hubKeys.map(() => -1);
  let ai = 0;
  let hi = 0;
  while (ai < agentKeys.length && hi < hubKeys.length) {
    let j = hi;
    while (j < hubKeys.length && j - hi < tolerance && agentKeys[ai] !== hubKeys[j]) j++;
    if (j >= hubKeys.length || agentKeys[ai] !== hubKeys[j]) return null;
    hubToAgent[j] = ai;
    ai++;
    hi = j + 1;
  }
  return { hubToAgent, agentNext: ai };
}

export interface AgentInfo {
  id: string;
  label: string;
  /** The agent's mark, when its adapter has one. Instances of one adapter share it. */
  icon?: string;
  /** Which adapter this instance is: instances of one adapter group together in the picker. */
  adapter?: string;
  /** The account this instance runs as, when it is a linked second login (an email). */
  account?: string | null;
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
  coordination?: CoordinationManager;
  borrowing?: import('./borrowing.js').BorrowingService;

  /** Drop an idle process so runtime-only connection context takes effect on resume. */
  async refreshRuntime(id: string): Promise<void> {
    if (this.running.has(id)) throw new HttpError(409, '请等待当前轮结束后启用协作');
    await this.dropSession(id);
  }

  notifyCoordination(id: string): void {
    if (this.store.getThread(id)) this.emitThreadEvent(id, null, 'thread.updated', {});
  }
  private readonly sessionAdapters = new Map<string, AgentAdapter>();
  private readonly sessionStarts = new Map<string, Promise<AgentSession>>();
  private readonly nativeIdle = new Map<string, Set<() => void>>();
  private readonly nativeTurns = new Map<string, Map<string, string>>();
  private readonly sessions = new Map<string, AgentSession>();
  /** Turns in flight. `cancelRequested` covers cancels that arrive before the agent session exists. */
  private readonly running = new Map<string, { turnId: string; cancelRequested: boolean; since: string }>();
  readonly inputs = new UserInputs((thread, turn, type, data) => this.emitThreadEvent(thread, turn, type, data));
  private readonly dispatchingQueues = new Set<string>();
  private readonly startingTurns = new Map<string, Promise<unknown>>();
  private readonly changingModes = new Set<string>();
  /** Turns that asked the agent for a `[进度]` line, read back when they end. */
  private readonly reportTurns = new Set<string>();
  /** Whether an enabled extension holds `progress.report`. Wired by the daemon's entry point. */
  progressWanted: () => boolean = () => false;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly listeners = new Set<Listener>();
  /** Agent sessions being imported right now, so the same one is not imported twice in parallel. */
  private readonly importing = new Set<string>();
  /** Read-only checks are cached per instance and share in-flight probes. */
  private readonly diagnosticCache = new Map<string, { at: number; pending: boolean; value: Promise<unknown> }>();
  /** Plan-usage reads in flight or fresh, per agent: the probes spawn a CLI, so they are shared. */
  private readonly quotaCache = new Map<string, { at: number; value: Promise<PlanQuota> }>();
  /** Threads whose session is being synced right now, for the same reason. */
  private readonly syncing = new Set<string>();
  /** Messages waiting for the running turn of their thread to finish. Kept in memory only. */
  private readonly queues = new Map<string, QueuedTurn[]>();

  /** Where threads may work; directories can be added from the page while the hub runs. */
  readonly dirs: Workdirs;
  readonly autoHandover: AutoHandover;
  private readonly settlingHandovers = new Set<Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly adapters: Map<string, AgentAdapter>,
    workdirs: string[] | Workdirs,
    private readonly attachments: AttachmentStore,
    /** What each instance is beyond its adapter: its adapter kind and linked account. */
    private readonly agentMeta: () => Array<{ id: string; adapter?: string; account?: string }> = () => [],
  ) {
    this.dirs = Array.isArray(workdirs) ? new Workdirs(workdirs) : workdirs;
    this.autoHandover = new AutoHandover(store, this);
    this.skills = new SkillsManager(this.adapters);
    this.mcp = new McpManager(this.adapters, store.mcpEntries);
  }

  /** The skills every agent instance on this machine can reach. Read-mostly, by the skills page. */
  readonly skills: SkillsManager;

  /** The MCP servers of every agent instance on this machine, and the one-entry writes the page asks for. */
  readonly mcp: McpManager;

  /** Every directory a thread may work in right now, the scratch area included. */
  private get workdirs(): string[] {
    return this.dirs.all();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The roots people pick projects from (not the scratch area). */
  get allowedWorkdirs(): string[] {
    return this.dirs.roots();
  }

  async listAgents(): Promise<AgentInfo[]> {
    const out: AgentInfo[] = [];
    const meta = new Map(this.agentMeta().map((m) => [m.id, m]));
    for (const [id, a] of this.adapters) {
      // The key is the instance id: a second account of the same CLI must not report the
      // adapter's own name, or the picker could not tell the two apart.
      const m = meta.get(id);
      out.push({
        id,
        label: a.label,
        icon: a.icon,
        ...(m?.adapter ? { adapter: m.adapter } : {}),
        ...(m?.account ? { account: m.account } : {}),
        available: await a.available(),
        capabilities: a.capabilities,
      });
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
   * Plan usage of an agent instance. The probe costs a CLI run (claude's takes seconds), so the
   * answer is reused for a minute and concurrent callers share one run.
   */
  agentQuota(agent: string, refresh = false): Promise<PlanQuota> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(404, `unknown agent: ${agent}`);
    if (!adapter.capabilities.quota || !adapter.fetchQuota) throw new HttpError(400, `${agent} has no plan usage to read`);
    const hit = this.quotaCache.get(agent);
    if (!refresh && hit && Date.now() - hit.at < QUOTA_TTL_MS) return hit.value;
    const value = adapter.fetchQuota().catch((err) => {
      // A failed probe is not worth caching; the next caller can try again right away.
      if (this.quotaCache.get(agent)?.value === value) this.quotaCache.delete(agent);
      throw err;
    });
    this.quotaCache.set(agent, { at: Date.now(), value });
    return value;
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
    const allowed = new Map<string, boolean>();
    const workdirs = this.workdirs;
    return sessions
      // A session whose directory has since been removed cannot be continued, so it is not offered.
      .filter((s) => {
        if (!allowed.has(s.cwd)) allowed.set(s.cwd, !!s.cwd && isWithinWorkdirs(s.cwd, workdirs) && isDirectory(s.cwd));
        return allowed.get(s.cwd);
      })
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
    if (!adapter.capabilities.history) throw new HttpError(400, `${agent} has no session history to import`);
    const summary = adapter.getSession
      ? await adapter.getSession(sessionId)
      : (await this.listAgentSessions(agent)).find((s) => s.id === sessionId);
    if (!summary || summary.id !== sessionId || !summary.cwd || !isWithinWorkdirs(summary.cwd, this.workdirs) || !isDirectory(summary.cwd)) {
      throw new HttpError(404, 'session not found, or it is outside the allowed workdirs');
    }
    const key = `${agent}:${sessionId}`;
    if (this.store.findThreadByAgentSession(agent, sessionId) || this.importing.has(key)) throw new HttpError(409, 'this session is already a thread');
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
   * conversation; the hub copies the event log and the images. With `turnId` the copy ends where
   * that turn ended, on both sides; without it, or when that turn is the last, it is the whole thread.
   */
  async forkThread(id: string, opts: { turnId?: string; worktree?: boolean } = {}): Promise<ThreadView> {
    const thread = this.getThread(id);
    const adapter = this.adapters.get(thread.agent);
    if (!adapter?.capabilities.fork || !adapter.forkSession) throw new HttpError(400, `${thread.agent} cannot fork a conversation`);
    if (!thread.agentSessionId) throw new HttpError(400, 'there is nothing to fork yet; send a message first');
    if (this.running.has(id)) throw new HttpError(409, 'wait for the running turn to finish before forking');

    // Where the hub's copy stops, and which of its turns that is. Null: the whole thread.
    let cut: { upToSeq: number; hubIndex: number; hubKeys: string[] } | null = null;
    if (opts.turnId) {
      const starts = this.store.listEventsOfType(id, 'turn.started');
      const hubIndex = starts.findIndex((ev) => ev.turnId === opts.turnId);
      if (hubIndex < 0) throw new HttpError(404, 'no such turn in this thread');
      // A turn the user stopped is not a place to go on from: the agent may not have kept it at all.
      const end = this.store.listEventsOfType(id, 'turn.done').find((ev) => ev.turnId === opts.turnId);
      if (end?.data.stopReason === 'cancelled') throw new HttpError(409, 'this turn was stopped, so a copy cannot end there');
      if (hubIndex < starts.length - 1) {
        cut = { upToSeq: starts[hubIndex + 1].seq - 1, hubIndex, hubKeys: starts.map((ev) => turnKey(String(ev.data.text ?? ''))) };
      }
    }

    const copyId = randomUUID();
    // Where the copy runs. In place, it shares whatever worktree its source stands in.
    let cwd = thread.cwd;
    let worktree = thread.worktree;
    let added: { main: string; tree: Worktree } | null = null;
    const undoWorktree = async () => {
      if (added) await removeWorktree(added.main, added.tree).catch(() => undefined);
    };

    let forkedSessionId: string;
    try {
      const forkRef = cut ? await this.agentForkRef(thread, adapter, cut.hubIndex, cut.hubKeys) : undefined;
      if (opts.worktree) {
        const plan = await this.worktreePlan(thread);
        if (!plan.checkout) throw new HttpError(400, WORKTREE_REFUSALS[plan.reason]);
        const tree = await addWorktree(plan.checkout, copyId.slice(0, 8)).catch((err) => {
          throw new HttpError(500, `could not add a git worktree: ${err instanceof Error ? err.message : err}`);
        });
        added = { main: plan.checkout.main, tree };
        cwd = plan.checkout.prefix ? join(tree.root, plan.checkout.prefix) : tree.root;
        // `.worktrees` could be a link to somewhere else; where it really is still has to be allowed.
        if (!isWithinWorkdirs(cwd, this.workdirs)) throw new HttpError(400, WORKTREE_REFUSALS.outside_workdirs);
        worktree = { root: tree.root, branch: tree.branch, of: thread.worktree?.of ?? thread.cwd };
      }
      forkedSessionId = await adapter.forkSession(thread.agentSessionId, thread.cwd, forkRef, added ? cwd : undefined);
    } catch (err) {
      await undoWorktree();
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `could not fork the ${thread.agent} session: ${err instanceof Error ? err.message : err}`);
    }

    this.attachments.copyThread(thread.id, copyId);
    try {
      this.store.transaction(() => {
        this.store.createThread({
          id: copyId,
          agent: thread.agent,
          cwd,
          title: `${thread.title}（分叉）`,
          permissionMode: thread.permissionMode,
          workMode: thread.workMode,
          speed: thread.speed,
          model: thread.model,
          effort: thread.effort,
          forkedFrom: thread.id,
          worktree,
        });
        this.store.updateThread(copyId, { agentSessionId: forkedSessionId, sectionId: thread.sectionId }, { touch: true });
        this.store.copyEvents(thread.id, copyId, cut?.upToSeq);
      });
    } catch (err) {
      this.attachments.removeThread(copyId);
      await undoWorktree();
      throw err;
    }
    // The last event of the copy: what comes before it was copied, what comes after is its own.
    this.emitThreadEvent(copyId, null, 'thread.updated', { forkedFrom: thread.id, ...(added ? { worktree: { branch: added.tree.branch } } : {}) });
    return this.threadView(copyId);
  }

  /** What forking this thread can offer. Asked when the user reaches for the fork button, not before. */
  async forkOptions(id: string): Promise<ForkOptions> {
    const plan = await this.worktreePlan(this.getThread(id));
    if (!plan.checkout) return { worktree: { available: false, reason: plan.reason } };
    return {
      worktree: {
        available: true,
        branch: plan.checkout.branch,
        changes: await countChanges(plan.checkout.top).catch(() => 0),
      },
    };
  }

  /** Whether a copy of this thread could get a worktree of its own, and where its directory stands in git. */
  private async worktreePlan(
    thread: ThreadRecord,
  ): Promise<{ checkout: Checkout; reason?: undefined } | { checkout: null; reason: NonNullable<ForkOptions['worktree']['reason']> }> {
    if (!this.adapters.get(thread.agent)?.capabilities.forkInto) return { checkout: null, reason: 'agent' };
    return this.checkoutFor(thread.cwd);
  }

  /** Where a directory stands in git, when a worktree can be added to its repository. */
  private async checkoutFor(cwd: string): Promise<{ checkout: Checkout; reason?: undefined } | { checkout: null; reason: 'not_git' | 'outside_workdirs' }> {
    const checkout = existsSync(cwd) ? await findCheckout(cwd) : null;
    if (!checkout) return { checkout: null, reason: 'not_git' };
    // Worktrees go under the repository's own directory, so that is what has to be allowed.
    if (!isWithinWorkdirs(checkout.main, this.workdirs)) return { checkout: null, reason: 'outside_workdirs' };
    return { checkout };
  }

  /**
   * What the agent needs to stop its copy where one of the hub's turns ended. The agent numbers
   * and names its turns its own way, so its history is read and lined up with the hub's by what
   * was asked in each turn. Undefined when the agent has nothing after that turn: then its whole
   * conversation is the copy.
   */
  private async agentForkRef(thread: ThreadRecord, adapter: AgentAdapter, hubIndex: number, hubKeys: string[]): Promise<string | undefined> {
    if (!adapter.capabilities.forkAt || !adapter.loadHistory || !thread.agentSessionId) {
      throw new HttpError(400, `${thread.agent} can only fork a whole conversation`);
    }
    const agentTurns = await adapter.loadHistory(thread.agentSessionId, thread.cwd);
    const matched = matchTurns(agentTurns.map((t) => turnKey(t.text)), hubKeys, ThreadManager.SYNC_SKIP_TOLERANCE);
    const agentIndex = matched?.hubToAgent[hubIndex] ?? -1;
    if (agentIndex < 0) throw new HttpError(409, `this turn is not in ${thread.agent}'s own history, so a copy cannot stop there`);
    if (agentIndex === agentTurns.length - 1) return undefined;
    const ref = agentTurns[agentIndex].forkRef;
    if (!ref) throw new HttpError(409, `${thread.agent} cannot stop a copy at this turn`);
    return ref;
  }

  /** Where a stored image is on disk, for the HTTP layer to stream. */
  getAttachment(threadId: string, attachmentId: string): { path: string; mimeType: string; size: number } {
    this.getThread(threadId);
    const found = this.attachments.find(threadId, attachmentId);
    if (!found) throw new HttpError(404, 'attachment not found');
    return found;
  }

  async saveVideo(threadId: string, source: AsyncIterable<Uint8Array>, name: string): Promise<StoredVideo> {
    const thread = this.getThread(threadId);
    if (thread.archivedAt) throw new HttpError(409, 'this thread is archived');
    return this.attachments.saveVideo(threadId, source, name);
  }

  usageReport(hours: number, agent: string) { return this.store.telemetry.read(hours, agent); }
  usageCosts(hours: number, agent: string) { return this.store.telemetry.costReport(hours, agent); }
  usageDaily(agent: string, timeZone?: string) { return this.store.telemetry.daily(agent, timeZone); }

  activityReport(days: number, agent: string) { return this.store.activity.read(days, agent); }

  /** One turn of a thread as a trace, the last turn when none is named. */
  turnTrace(threadId: string, turnId?: string): TurnTrace {
    const thread = this.getThread(threadId);
    const turns = this.store.listTurns(threadId);
    const turn = turnId ? turns.find((t) => t.turnId === turnId) : turns[turns.length - 1];
    if (!turn) throw new HttpError(404, '这个线程没有这一轮');
    const trace = buildTrace(this.store.turnEvents(threadId, turn.turnId));
    return {
      threadId,
      turnId: turn.turnId,
      title: thread.title,
      agent: thread.agent,
      cwd: thread.cwd,
      models: trace.models.length ? trace.models : thread.model ? [thread.model] : [],
      // A turn that never ended and is not the one running now was cut off.
      status: trace.status === 'running' && (thread.status !== 'running' || turn !== turns[turns.length - 1]) ? 'cancelled' : trace.status,
      startedAt: turn.ts,
      endedAt: trace.endedAt,
      steps: trace.steps,
      totals: trace.totals,
      turns: turns.map((t) => ({ turnId: t.turnId, ts: t.ts })),
    };
  }

  /**
   * The whole prompt a thread's conversation runs with, from the agent's own session file. Reading
   * it starts nothing and writes nothing; an agent that does not persist its prompt says so.
   */
  async threadSystemPrompt(threadId: string): Promise<SystemPrompt> {
    const thread = this.getThread(threadId);
    if (!thread) throw new HttpError(404, 'no such thread');
    const adapter = this.adapters.get(thread.agent);
    if (!adapter?.capabilities.systemPrompt || !adapter.readSystemPrompt) {
      throw new HttpError(400, `${thread.agent} 的会话文件不保存系统提示词`);
    }
    if (!thread.agentSessionId) throw new HttpError(400, '这个线程还没有会话');
    const prompt = await adapter.readSystemPrompt(thread.agentSessionId, thread.cwd);
    if (!prompt) throw new HttpError(404, '会话文件里没有系统提示词');
    return prompt;
  }

  agentDiagnostic(agent: string, refresh = false): Promise<unknown> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(404, '未知 agent 实例');
    const hit = this.diagnosticCache.get(agent);
    if (hit && (hit.pending || (!refresh && Date.now() - hit.at < 60000))) return hit.value;
    const entry = { at: Date.now(), pending: true, value: Promise.resolve<unknown>(null) };
    entry.value = (async () => {
      const base = { agent, label: adapter.label, capabilities: adapter.capabilities };
      try {
        if (!await adapter.available()) return { ...base, checkedAt: new Date().toISOString(), state: 'missing', message: '没有找到 CLI，请检查该实例的命令和 PATH。', version: null, protocol: null, models: [] };
        const runtime = await adapter.diagnose?.().catch(() => null);
        try {
          const models = await adapter.models(refresh);
          return { ...base, ...runtime, checkedAt: new Date().toISOString(), state: models.length ? 'ready' : 'empty',
            message: models.length ? '模型读取成功。登录有效性以实际请求结果为准。' : 'CLI 可启动，但未返回可选模型。请检查原生 CLI 的登录、模型配置和套餐。', models };
        } catch (error) { return { ...base, ...runtime, checkedAt: new Date().toISOString(), ...diagnosticFailure(error), models: [] }; }
      } catch (error) { return { ...base, checkedAt: new Date().toISOString(), ...diagnosticFailure(error), models: [] }; }
    })().finally(() => { entry.pending = false; });
    this.diagnosticCache.set(agent, entry);
    return entry.value;
  }

  async listModels(agent: string): Promise<ModelOption[]> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new HttpError(404, `unknown agent: ${agent}`);
    return adapter.models();
  }

  /** Turns of any thread, archived ones too, in which the words were said. */
  search(query: unknown): SearchHit[] {
    return typeof query === 'string' ? this.store.searchText(query.slice(0, 200)) : [];
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
    let waitingReason: ThreadView['waitingReason'] = this.inputs.waitingReason(thread.id);
    for (const p of this.approvals.values()) if (p.threadId === thread.id) { waitingReason = 'approval'; break; }
    const waiting = waitingReason !== null;
    const queued = (this.queues.get(thread.id) ?? []).map((q) => ({ id: q.id, text: q.text, images: q.images.length, videos: q.videos.length,
      ...(q.mentions?.length ? { targets: q.mentions.map(m => {
        const value = m as { label?: unknown; id?: unknown };
        return typeof value.label === 'string' ? value.label : String(value.id ?? '');
      }) } : {}), ...(q.error ? { error: q.error } : {}) }));
    // The terminal wrote to this session after the hub last did: the UI asks before sending more.
    const terminalActivity = thread.externalAt !== null && (thread.hubTurnAt === null || thread.externalAt > thread.hubTurnAt);
    let worktree: ThreadView['worktree'] = null;
    if (thread.worktree) {
      let ofReal = thread.worktree.of;
      try {
        ofReal = realpathSync(thread.worktree.of);
      } catch {
        // As above.
      }
      worktree = { ...thread.worktree, ofReal };
    }
    const scratch = this.dirs.scratchRoot !== null && isWithinWorkdirs(thread.cwd, [this.dirs.scratchRoot]);
    const runningSince = this.running.get(thread.id)?.since ?? null;
    return { ...thread, handover: thread.handover ? { ...thread.handover, mode: this.store.handoverMode(thread)!, automatic: thread.handover.mode === 'continue' } : null, autoHandover: this.autoHandover.view(thread.id), worktree, resumeCommand, cwdReal, waiting, waitingReason, queued, terminalActivity, scratch, runningSince, coordination: this.coordination?.metadata(thread.id) };
  }

  /**
   * Where a path the page asked about really is, if the thread may show it: inside the thread's
   * directory, or the agent's own folder for this session. Symlinks are resolved first, so a link
   * inside cannot point the way out. Anything else is "not found", whether it exists or not.
   * `root` is the real path of the folder it was found in, which the file browser counts from.
   */
  resolveInThread(threadId: string, rawPath: unknown, notFound: HttpError): { real: string; root: string } {
    const thread = this.getThread(threadId);
    if (rawPath !== undefined && rawPath !== null && typeof rawPath !== 'string') throw new HttpError(400, 'path must be a string');
    if (typeof rawPath === 'string' && rawPath.length > 4096) throw new HttpError(400, 'path is too long');
    const given = !rawPath ? thread.cwd : rawPath.startsWith('file://') ? rawPath.slice('file://'.length) : rawPath;

    const adapter = this.adapters.get(thread.agent);
    const roots = [thread.cwd, ...(thread.agentSessionId ? (adapter?.artifactDirs?.(thread.agentSessionId) ?? []) : [])];
    let real: string;
    try {
      real = realpathSync(isAbsolute(given) ? given : resolve(thread.cwd, given));
    } catch {
      throw notFound;
    }
    for (const root of roots) {
      let base: string;
      try {
        base = realpathSync(root);
      } catch {
        continue;
      }
      if (real === base || real.startsWith(base.endsWith(sep) ? base : base + sep)) return { real, root: base };
    }
    throw notFound;
  }

  /**
   * An image file the agent made or mentioned, for showing it in the thread. Only files the thread
   * may show (see resolveReadableFile), and only real images: one of the four bitmap formats, or an SVG.
   */
  getThreadImage(threadId: string, rawPath: unknown): { path: string; mimeType: string; size: number } {
    const notFound = new HttpError(404, 'no such image in this thread');
    if (typeof rawPath !== 'string' || !rawPath) throw new HttpError(400, 'path is required');
    const { real } = this.resolveReadableFile(threadId, rawPath, notFound);

    const stat = statSync(real);
    if (!stat.isFile()) throw notFound;
    // There, but not something to show as a picture: the page says so instead of "not found".
    const notImage = new HttpError(415, 'not an image this hub shows');
    if (stat.size === 0 || stat.size > MAX_SERVED_IMAGE_BYTES) throw notImage;
    let head = Buffer.alloc(SNIFF_BYTES);
    const fd = openSync(real, 'r');
    try {
      head = head.subarray(0, readSync(fd, head, 0, head.length, 0));
    } finally {
      closeSync(fd);
    }
    const mimeType = sniffImageType(head) ?? (sniffSvg(head) && stat.size <= MAX_SERVED_SVG_BYTES ? 'image/svg+xml' : null);
    if (!mimeType) throw notImage;
    return { path: real, mimeType, size: stat.size };
  }

  /** One folder of the thread's directory, for the file browser. No path: the thread's directory itself. */
  async listThreadDir(threadId: string, rawPath: unknown): Promise<{ root: string; path: string } & Listing> {
    const { real, root } = this.resolveInThread(threadId, rawPath, new HttpError(404, 'no such folder in this thread'));
    if (!statSync(real).isDirectory()) throw new HttpError(404, 'no such folder in this thread');
    return { root, path: real, ...(await listDir(real)) };
  }

  /** Files under the thread's directory whose path matches a search, relative to it. */
  async findThreadFiles(threadId: string, query: unknown): Promise<{ root: string; paths: string[]; truncated: boolean }> {
    if (typeof query !== 'string' || query.length > 200) throw new HttpError(400, 'q must be a short string');
    const { real } = this.resolveInThread(threadId, null, new HttpError(404, 'the thread directory is gone'));
    return { root: real, ...(await findFiles(real, query)) };
  }

  /** A text file in the thread's directory, for the file viewer. A binary one comes back without text. */
  /** One file of the thread's directory (or an artifact dir), resolved and checked, for previews. */
  threadFile(threadId: string, rawPath: unknown): { real: string; rel: string } {
    const notFound = new HttpError(404, 'no such file in this thread');
    const { real, root } = this.resolveInThread(threadId, rawPath, notFound);
    if (!statSync(real).isFile()) throw notFound;
    return { real, rel: real === root ? '' : real.slice(root.length + 1) };
  }

  readThreadText(threadId: string, rawPath: unknown): { root: string; path: string } & TextFile {
    const notFound = new HttpError(404, 'no such file in this thread');
    if (typeof rawPath !== 'string' || !rawPath) throw new HttpError(400, 'path is required');
    const { real, root } = this.resolveReadableFile(threadId, rawPath, notFound);
    if (!statSync(real).isFile()) throw notFound;
    return { root, path: real, ...readText(real) };
  }

  /**
   * Beyond the thread's directory, any file this thread's completed answers name by absolute path
   * is readable on its own. A file that is not there is 404; one that is but was never named, 403,
   * so the page can tell a missing file from one it may not show.
   */
  private resolveReadableFile(threadId: string, rawPath: string, notFound: HttpError): { real: string; root: string } {
    try {
      return this.resolveInThread(threadId, rawPath, notFound);
    } catch (error) {
      if (error !== notFound) throw error;
    }
    let given = rawPath;
    if (/^file:\/\//i.test(given)) {
      given = given.slice(7);
      try { given = decodeURIComponent(given); } catch { /* A literal percent sign. */ }
    }
    const path = resolve(this.getThread(threadId).cwd, given);
    const real = referencedFile(path);
    if (!real) throw notFound;
    if (!isAbsolute(given) || !this.store.referencesFile(threadId, path)) throw new HttpError(403, 'no answer in this thread names this file');
    // Keep the browser rooted in the project; the grant is only for this file, not its folder.
    return { real, root: this.threadView(threadId).cwdReal };
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

  // ---------- Plan page (todos) ----------

  /** Todos with their linked threads as full views, so chips can show agent, title and state. */
  listTodos(): Array<TodoRecord & { threads: ThreadView[] }> {
    return this.store.listTodos().map((todo) => ({
      ...todo,
      threads: this.store
        .todoThreadIds(todo.id)
        .map((id) => this.store.getThread(id))
        .filter((t): t is ThreadRecord => t !== null)
        .map((t) => this.view(t)),
    }));
  }

  createTodo(text: unknown, parentId?: unknown): TodoRecord {
    const parent = parentId == null ? null : this.todoParent(parentId);
    const todo = this.store.createTodo(randomUUID(), this.todoText(text), parent?.id ?? null);
    this.broadcastTodo();
    return todo;
  }

  updateTodo(id: string, patch: { text?: unknown; done?: unknown }): TodoRecord {
    if (!this.store.getTodo(id)) throw new HttpError(404, 'todo not found');
    const next: { text?: string; done?: boolean } = {};
    if (patch.text !== undefined) next.text = this.todoText(patch.text);
    if (patch.done !== undefined) {
      if (typeof patch.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
      next.done = patch.done;
    }
    const todo = this.store.updateTodo(id, next);
    this.broadcastTodo();
    return todo;
  }

  deleteTodo(id: string): void {
    if (!this.store.getTodo(id)) throw new HttpError(404, 'todo not found');
    this.store.deleteTodo(id);
    this.broadcastTodo();
  }

  /**
   * Moves an item: reordering among its siblings, a plan becoming a sub-item of another (Tab), or a
   * sub-item coming back to the top level (Shift+Tab). Still one level: a plan with sub-items of its
   * own cannot go under another.
   */
  moveTodo(id: string, target: { parentId?: unknown; before?: unknown }): void {
    const todo = this.store.getTodo(id);
    if (!todo) throw new HttpError(404, 'todo not found');
    const parent = target.parentId == null ? null : this.todoParent(target.parentId);
    if (parent?.id === id) throw new HttpError(400, '不能放到自己下面');
    if (parent && this.store.listTodos().some((t) => t.parentId === id)) throw new HttpError(400, '有子项的计划不能变成子项');
    let before: string | null = null;
    if (target.before != null) {
      if (typeof target.before !== 'string') throw new HttpError(400, 'before must be a string');
      const sibling = this.store.getTodo(target.before);
      if (!sibling || sibling.parentId !== (parent?.id ?? null)) throw new HttpError(400, 'before is not in that list');
      if (sibling.id !== id) before = sibling.id;
    }
    this.store.moveTodo(id, parent?.id ?? null, before);
    this.broadcastTodo();
  }

  linkTodoThread(id: string, threadId: unknown): void {
    if (!this.store.getTodo(id)) throw new HttpError(404, 'todo not found');
    this.getThread(this.threadId(threadId));
    this.store.linkTodoThread(id, this.threadId(threadId));
    this.broadcastTodo();
  }

  unlinkTodoThread(id: string, threadId: unknown): void {
    if (!this.store.getTodo(id)) throw new HttpError(404, 'todo not found');
    this.store.unlinkTodoThread(id, this.threadId(threadId));
    this.broadcastTodo();
  }

  /** A todo's parent must exist and be top level: plans have children, children do not. */
  private todoParent(parentId: unknown): TodoRecord {
    if (typeof parentId !== 'string') throw new HttpError(400, 'parentId must be a string');
    const parent = this.store.getTodo(parentId);
    if (!parent) throw new HttpError(404, 'todo not found');
    if (parent.parentId) throw new HttpError(400, '子项下不能再建子项');
    return parent;
  }

  private todoText(text: unknown): string {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) throw new HttpError(400, 'todo text is empty');
    if (value.length > 300) throw new HttpError(400, 'todo text is longer than 300 characters');
    return value;
  }

  private threadId(threadId: unknown): string {
    if (typeof threadId !== 'string' || !threadId) throw new HttpError(400, 'threadId is required');
    return threadId;
  }

  /** Plan-page changes are not thread events: they go to listeners only, without an event log. */
  private broadcastTodo(): void {
    const ev: StoredEvent = { threadId: '', seq: 0, turnId: null, type: 'todo.updated', ts: new Date().toISOString(), data: {} };
    for (const l of this.listeners) l(ev);
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
      workMode?: WorkMode;
      speed?: string | null;
      permissionMode?: string;
      model?: string | null;
      effort?: string | null;
      archived?: boolean;
      sectionId?: string | null;
      unread?: boolean;
      done?: boolean;
    },
  ): Promise<ThreadView> {
    const thread = this.getThread(id);
    const patch: Record<string, unknown> = {};
    if (updates.done !== undefined) {
      if (typeof updates.done !== 'boolean') throw new HttpError(400, 'done must be true or false');
      // The person's word; whatever the agent said before no longer stands.
      this.store.setThreadProgress(id, { doneAt: updates.done ? (thread.doneAt ?? new Date().toISOString()) : null, report: null });
    }
    if (updates.speed !== undefined) {
      patch.speed = updates.speed === null ? (thread.speed ? 'default' : null) : await this.validateSpeed(thread.agent, updates.model === undefined ? thread.model : updates.model, updates.speed);
    } else if (updates.model !== undefined && thread.speed) {
      const adapter = this.adapters.get(thread.agent)!;
      const option = await this.modelOption(adapter, updates.model);
      if (!option?.speeds?.some(s => s.id === thread.speed)) patch.speed = 'default';
    }
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
    if (updates.workMode !== undefined) {
      const mode = this.validateWorkMode(thread.agent, updates.workMode);
      if (this.running.has(id) || this.changingModes.has(id)) throw new HttpError(409, '请等待当前轮结束后切换模式');
      if (updates.permissionMode !== undefined || updates.model !== undefined || updates.effort !== undefined || updates.speed !== undefined) throw new HttpError(400, '请单独修改工作模式');
      this.changingModes.add(id);
      try {
        const session = this.sessions.get(id);
        if (session?.setWorkMode) await session.setWorkMode(mode);
        else if (session) await this.dropSession(id);
        this.store.updateThread(id, { workMode: mode });
      } finally { this.changingModes.delete(id); }
      patch.workMode = mode;
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
    if (patch.speed !== undefined) {
      await this.applyLive(thread, 'speed', s => s.setSpeed?.(patch.speed as string | null) ?? Promise.resolve(false));
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
    what: 'model' | 'effort' | 'speed',
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
   *
   * With `worktree`, the git worktree the thread stands in goes too, branch included. Work that
   * exists nowhere else (files not committed, commits no other branch has) stops this unless
   * `force` says the user has seen the count and means it.
   */
  async deleteThread(id: string, opts: { agentSession?: boolean; worktree?: boolean; force?: boolean } = {}): Promise<void> {
    const thread = this.getThread(id);
    if (this.running.has(id)) throw new HttpError(409, 'cancel the running turn before deleting this thread');
    if (this.coordination?.metadata(id)) throw new HttpError(409, '协作线程请先归档，保留成员关系与消息记录');
    let doomed: { main: string; tree: ThreadWorktree } | null = null;
    if (opts.worktree) {
      const tree = thread.worktree;
      if (!tree) throw new HttpError(400, 'this thread has no worktree');
      const others = [...this.store.listThreads(), ...this.store.listThreads({ archived: true })];
      if (others.some((t) => t.id !== id && t.worktree && samePath(t.worktree.root, tree.root))) {
        throw new HttpError(409, 'another thread still runs in this worktree', { code: 'worktree_shared' });
      }
      // `<repository>/.worktrees/<name>`: the repository is two levels up.
      const main = dirname(dirname(tree.root));
      const left = await worktreeLeftovers(main, tree);
      if ((left.changes > 0 || left.commits > 0) && !opts.force) {
        throw new HttpError(409, 'the worktree holds work that exists nowhere else', { code: 'worktree_dirty', ...left });
      }
      doomed = { main, tree };
    }
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
    if (doomed) {
      try {
        await removeWorktree(doomed.main, doomed.tree);
      } catch (err) {
        throw new HttpError(502, `could not remove the worktree: ${err instanceof Error ? err.message : err}`);
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

  private async validateSpeed(agent: string, model: string | null, speed: unknown): Promise<string> {
    const adapter = this.adapters.get(agent);
    const option = adapter?.capabilities.speed ? await this.modelOption(adapter, model) : undefined;
    if (adapter?.capabilities.speed && speed === 'default') return speed;
    if (typeof speed !== 'string' || !option?.speeds?.some(s => s.id === speed)) throw new HttpError(400, '当前模型不支持此速度');
    return speed;
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

  history(threadId: string) {
    this.getThread(threadId);
    return this.store.history;
  }

  /**
   * Everything after a sequence number, however much that is: what a stream replays before it
   * goes live. Stopping at a page size here would leave a hole between the replay and the live
   * events that nothing fills in later.
   */
  listEventsSince(threadId: string, afterSeq: number): StoredEvent[] {
    this.getThread(threadId);
    return compactDeltas(coalesceToolEvents(this.store.iterateEvents(threadId, afterSeq)));
  }

  /** How far back, in stored events, one page of history reaches before stopping at a turn's start. */
  private static readonly PAGE_BUDGET = 2_000;

  /**
   * One page of a thread's history for the view: the newest turns, or the ones just before
   * `beforeSeq`. Pages begin where a turn begins; see Store.listEventsPage.
   */
  listEventsPage(threadId: string, beforeSeq?: number): StoredEvent[] {
    this.getThread(threadId);
    return compactDeltas(coalesceToolEvents(this.store.iterateEventsPage(threadId, ThreadManager.PAGE_BUDGET, beforeSeq)));
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

    const matched = matchTurns(agentTurns.map((t) => turnKey(t.text)), hubTexts, ThreadManager.SYNC_SKIP_TOLERANCE);
    if (!matched) return { added: 0, terminalActivity: this.view(thread).terminalActivity }; // histories disagree
    const fresh = agentTurns.slice(matched.agentNext);
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

  private validateWorkMode(agent: string, value: unknown): WorkMode {
    if (value !== 'execute' && value !== 'plan') throw new HttpError(400, '工作模式无效');
    if (value === 'plan' && !this.adapters.get(agent)?.capabilities.workModes?.includes('plan')) throw new HttpError(400, '此智能体不支持计划模式');
    return value;
  }

  async createThread(input: {
    workMode?: WorkMode;
    speed?: string | null;
    agent: string;
    cwd: string;
    title?: string;
    permissionMode?: string;
    model?: string | null;
    effort?: string | null;
    sectionId?: string | null;
    /** Start in a new git worktree of the directory's repository, under `.worktrees/`. */
    worktree?: boolean;
    /** In no project: the thread gets a fresh folder of its own in the hub's scratch area; `cwd` is ignored. */
    scratch?: boolean;
    /** The scheduled task that starts this thread, if any: shown as its badge. */
    schedule?: { id: string; name: string } | null;
  }, inheritedWorktree?: ThreadWorktree | null, handover?: ThreadRecord['handover']): Promise<ThreadView> {
    const adapter = this.adapters.get(input.agent);
    if (!adapter) throw new HttpError(400, `unknown agent: ${input.agent}`);
    const id = randomUUID();
    let cwd: string;
    if (input.scratch === true) {
      if (!this.dirs.scratchRoot) throw new HttpError(400, 'this hub has no scratch area for threads outside a project');
      cwd = join(this.dirs.scratchRoot, `${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`);
      mkdirSync(cwd, { recursive: true });
    } else {
      cwd = resolve(input.cwd);
    }
    // An allowed directory or anything inside one. The directory picker offers subdirectories.
    if (!isWithinWorkdirs(cwd, this.workdirs)) throw new HttpError(400, 'cwd is not in the allowed workdirs');
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, 'cwd does not exist');
    if (input.sectionId !== undefined && input.sectionId !== null && !this.store.getSection(input.sectionId)) {
      throw new HttpError(400, 'section not found');
    }
    // Default for new threads: the agent's own, else auto-approve edits and still ask before other actions.
    const permissionMode =
      adapter.capabilities.permissionModes.length === 0
        ? 'auto_edit'
        : this.validatePermissionMode(input.agent, input.permissionMode ?? adapter.capabilities.defaultPermissionMode ?? 'auto_edit');
    const workMode = this.validateWorkMode(input.agent, input.workMode ?? 'execute');
    const model = input.model ? await this.validateModel(input.agent, input.model) : null;
    const effort = input.effort ? await this.validateEffort(input.agent, model, input.effort) : null;
    const speed = input.speed == null ? null : await this.validateSpeed(input.agent, model, input.speed);
    const title = (input.title ?? '').trim() || 'New thread';
    // A new thread has no conversation to move, so any agent can start in a worktree.
    let added: { main: string; tree: Worktree; cwd: string } | null = null;
    if (input.worktree === true) {
      const plan = await this.checkoutFor(cwd);
      if (!plan.checkout) throw new HttpError(400, WORKTREE_REFUSALS[plan.reason]);
      const tree = await addWorktree(plan.checkout, id.slice(0, 8)).catch((err) => {
        throw new HttpError(500, `could not add a git worktree: ${err instanceof Error ? err.message : err}`);
      });
      added = { main: plan.checkout.main, tree, cwd: plan.checkout.prefix ? join(tree.root, plan.checkout.prefix) : tree.root };
      // `.worktrees` could be a link to somewhere else; where it really is still has to be allowed.
      if (!isWithinWorkdirs(added.cwd, this.workdirs)) {
        await removeWorktree(added.main, tree).catch(() => undefined);
        throw new HttpError(400, WORKTREE_REFUSALS.outside_workdirs);
      }
    }
    let thread: ThreadRecord;
    try {
      thread = this.store.createThread({
        id,
        agent: input.agent,
        cwd: added?.cwd ?? cwd,
        title,
        permissionMode,
        workMode,
        speed,
        model,
        effort,
        handover,
        schedule: input.schedule ?? null,
        ...(input.sectionId ? { sectionId: input.sectionId } : {}),
        ...(added ? { worktree: { root: added.tree.root, branch: added.tree.branch, of: cwd } } : inheritedWorktree ? { worktree: inheritedWorktree } : {}),
      });
    } catch (err) {
      if (added) await removeWorktree(added.main, added.tree).catch(() => undefined);
      throw err;
    }
    this.emitThreadEvent(thread.id, null, 'thread.created', { agent: thread.agent, cwd: thread.cwd });
    return this.view(thread);
  }

  /** A fresh conversation in the source's exact directory, sharing its existing worktree. No agent is started. */
  async createHandoverThread(threadId: string, agent: string, model?: string, mode?: unknown): Promise<ThreadView> {
    const source = this.getThread(threadId);
    if (mode !== undefined && mode !== 'continue' && mode !== 'branch') throw new HttpError(400, 'invalid handover mode');
    const selected = mode ?? 'branch';
    return this.createThread({
      agent,
      cwd: source.cwd,
      title: `${source.title}（接手）`,
      model,
      sectionId: source.sectionId,
    }, source.worktree, { sourceId: source.id, title: source.title, agent: source.agent, mode: selected,
      sourceSeq: this.store.history.latest(source.id) });
  }

  /** The project roots, each with whether it was added from the page and so can be removed there. */
  workdirsConfig(): { workdirs: string[]; roots: Array<{ path: string; removable: boolean }>; scratch: boolean } {
    return { workdirs: this.dirs.roots(), roots: this.dirs.describe(), scratch: this.dirs.scratchRoot !== null };
  }

  addWorkdir(path: unknown): ReturnType<ThreadManager['workdirsConfig']> {
    try {
      this.dirs.add(typeof path === 'string' ? path.trim() : '');
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return this.workdirsConfig();
  }

  removeWorkdir(path: unknown): ReturnType<ThreadManager['workdirsConfig']> {
    try {
      this.dirs.remove(typeof path === 'string' ? path : '');
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return this.workdirsConfig();
  }

  /**
   * A new project: a folder named `name` in `parent` (inside a project root), made a git repository
   * with one empty commit when `git` is set, so a thread can start in a worktree of it at once.
   */
  async createProject(input: { parent?: unknown; name?: unknown; git?: unknown }): Promise<{ path: string; git: boolean }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100 || /[\\/\0]/.test(name) || name.startsWith('.')) {
      throw new HttpError(400, 'a project name is a plain folder name: no slashes, not starting with a dot');
    }
    const parent = typeof input.parent === 'string' && input.parent ? resolve(input.parent) : '';
    if (!parent || !isWithinWorkdirs(parent, this.dirs.roots())) throw new HttpError(400, 'parent is not in the allowed workdirs');
    if (!isDirectory(parent)) throw new HttpError(400, 'parent does not exist');
    const path = join(parent, name);
    if (existsSync(path)) throw new HttpError(409, 'a file or folder with this name is already there', { code: 'exists' });
    mkdirSync(path);
    const git = input.git === true;
    if (git) {
      await initRepository(path).catch((err) => {
        throw new HttpError(500, `the folder was made, but git init failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    return { path, git };
  }

  /**
   * Whether a new thread in `cwd` could start in a worktree of its own, asked when a directory is
   * picked for one. The same answer as for forking, minus the agent: a new thread has nothing to move.
   */
  async worktreeOptions(cwdInput: unknown): Promise<ForkOptions['worktree']> {
    if (typeof cwdInput !== 'string' || !cwdInput) throw new HttpError(400, 'cwd is required');
    const cwd = resolve(cwdInput);
    if (!isWithinWorkdirs(cwd, this.workdirs)) throw new HttpError(400, 'cwd is not in the allowed workdirs');
    const plan = await this.checkoutFor(cwd);
    if (!plan.checkout) return { available: false, reason: plan.reason };
    return { available: true, branch: plan.checkout.branch, changes: await countChanges(plan.checkout.top).catch(() => 0) };
  }

  /**
   * Starts a turn in the background and returns its id right away.
   * A turn needs text, images, or both. Images are checked and stored before anything else changes.
   *
   * With `queue`, a message sent while a turn is running waits its turn instead of being refused:
   * it goes out when the running turn (and anything queued before it) has finished.
   */
  startTurn(
    threadId: string,
    input: Parameters<ThreadManager['startTurnReady']>[1],
    delivery?: Parameters<ThreadManager['startTurnReady']>[2],
    fromQueue = false,
  ): Promise<{ turnId: string } | { queued: true; id: string }> {
    // Setup may await discovery or an idle runtime refresh. Keep competing sends in order.
    const previous = this.startingTurns.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.startTurnReady(threadId, input, delivery, fromQueue));
    this.startingTurns.set(threadId, next);
    const clean = () => {
      if (this.startingTurns.get(threadId) === next) this.startingTurns.delete(threadId);
      this.startNextQueued(threadId);
    };
    void next.then(clean, clean);
    return next;
  }

  private async startTurnReady(
    threadId: string,
    input: { workMode?: unknown; text?: unknown; images?: unknown; videos?: unknown; queue?: unknown; mentions?: unknown; collaboration?: CoordinationSetup; handoverFrom?: string; autoContinuation?: boolean; handover?: unknown; scheduled?: unknown },
    delivery?: { turnId: string; source: Record<string, unknown>; displayText: string; claim: () => void },
    fromQueue = false,
  ): Promise<{ turnId: string } | { queued: true; id: string }> {
    const thread = this.getThread(threadId);
    if (this.changingModes.has(threadId)) throw new HttpError(409, '模式正在切换，请稍后发送');
    if (input.workMode !== undefined) thread.workMode = this.validateWorkMode(thread.agent, input.workMode);
    const originalText = typeof input.text === 'string' ? input.text.trim() : '';
    if (thread.workMode === 'plan' && /^\/goal(?:\s|$)/.test(originalText) && !['/goal', '/goal pause', '/goal clear'].includes(originalText)) throw new HttpError(409, '请切到执行模式后启动目标');
    const mentions = Array.isArray(input.mentions) && input.mentions.length ? input.mentions : undefined;
    if ((mentions || input.collaboration) && !this.coordination) throw new HttpError(400, '协作不可用');
    let rawText = await this.coordination?.previewMentions(threadId, originalText, mentions, input.collaboration) ?? originalText;
    const rawImages = Array.isArray(input.images) ? input.images : [];
    const storedVideos = this.attachments.videos(threadId, input.videos);
    const videoIds = storedVideos.map(v => v.id);
    if (storedVideos.length && /^\/\S+/.test(rawText)) throw new HttpError(400, '视频请随普通消息发送，不能附在斜杠命令后');
    if (!rawText && rawImages.length === 0 && !storedVideos.length) throw new HttpError(400, 'text is empty');
    if (thread.archivedAt) throw new HttpError(409, 'this thread is archived; restore it first');
    if (this.running.has(threadId) || this.autoHandover.held(threadId) && !input.handover && !input.autoContinuation || !fromQueue && this.queues.get(threadId)?.some(q => !q.error)) {
      const goalAction = originalText === '/goal' ? 'show' : originalText === '/goal pause' ? 'pause' : originalText === '/goal clear' ? 'clear' : null;
      const adapter = this.adapters.get(thread.agent);
      const session = this.sessions.get(threadId);
      if (this.running.has(threadId) && !delivery && goalAction && !rawImages.length && !mentions && adapter?.capabilities.goal?.controls.includes(goalAction)) {
        if (!session?.controlGoal) throw new HttpError(409, '智能体正在启动，请稍后重试目标操作。');
        // A control must not wait behind the work it is supposed to stop. It has its own
        // transcript entry, but does not claim or release the running turn's lock/hooks.
        const turnId = randomUUID();
        // Marked, so whoever reads turn endings can tell an answer to a control from finished work.
        this.emitThreadEvent(threadId, turnId, 'turn.started', { text: originalText, control: true });
        if (goalAction === 'pause') {
          for (const [id, approval] of this.approvals) {
            if (approval.threadId === threadId) this.resolveApproval(id, { cancelled: true });
          }
        }
        void session.controlGoal(goalAction).then((text) => {
          if (!this.store.getThread(threadId)) return;
          this.emitThreadEvent(threadId, turnId, 'message.delta', { text });
          this.emitThreadEvent(threadId, turnId, 'turn.done', { stopReason: 'end_turn' });
        }).catch((error) => {
          if (this.store.getThread(threadId)) this.emitThreadEvent(threadId, turnId, 'turn.error', { message: String(error) });
        });
        return { turnId };
      }
      if (input.queue !== true) throw new HttpError(409, 'a turn is already running in this thread');
      const queue = this.queues.get(threadId) ?? [];
      if (queue.length >= MAX_QUEUED) throw new HttpError(409, `at most ${MAX_QUEUED} messages can wait in a thread`);
      this.attachments.check(rawImages); // a bad image is refused now, not when its turn comes
      const queued: QueuedTurn = { workMode: thread.workMode ?? 'execute', id: randomUUID(), text: originalText, images: rawImages, videos: videoIds, ...(mentions ? { mentions } : {}), ...(input.collaboration ? { collaboration: input.collaboration } : {}) };
      this.queues.set(threadId, [...queue, queued]);
      this.emitThreadEvent(threadId, null, 'thread.updated', {});
      return { queued: true, id: queued.id };
    }

    if ((mentions || input.collaboration) && !this.coordination?.metadata(threadId)) {
      if (!this.coordination) throw new HttpError(400, '协作不可用');
      await this.coordination.enable(threadId, input.collaboration);
    }
    rawText = this.coordination?.mentionText(threadId, originalText, mentions) ?? originalText;
    // Slash commands have their own argument grammar; hidden instructions become unwanted arguments.
    const slashCommand = /^\/\S+/.test(rawText);
    const coordinated = slashCommand ? rawText : rawText ? (this.coordination?.instructions(input.handoverFrom ?? threadId, rawText) ?? rawText) : '';
    const discoverable = slashCommand || !rawText ? coordinated : (this.borrowing?.instructions(threadId, coordinated) ?? coordinated);
    // With the board's consent, the agent is asked to say where the work stands; read back at the end.
    const askProgress = !slashCommand && Boolean(rawText) && this.progressWanted();
    const text = askProgress ? progressInstructions(discoverable) : discoverable;

    if (rawImages.length > 0) {
      const adapter = this.adapters.get(thread.agent);
      if (!adapter?.capabilities.images) throw new HttpError(400, `${thread.agent} does not accept images`);
      const option = await this.modelOption(adapter, thread.model);
      if (option?.images === false && !option.imagesVia) throw new HttpError(400, `${option.label} cannot read images; pick another model`);
      // The model lookup above can take a moment, so check again before claiming the thread.
      if (this.running.has(threadId)) throw new HttpError(409, 'a turn is already running in this thread');
      if (this.changingModes.has(threadId) || input.workMode === undefined && this.getThread(threadId).workMode !== thread.workMode) throw new HttpError(409, '工作模式已变化，请重新发送');
    }
    const { stored, images } = this.attachments.save(threadId, rawImages);
    const promptText = text + this.attachments.videoNote(threadId, storedVideos);

    const turnId = delivery?.turnId ?? randomUUID();
    if (askProgress) this.reportTurns.add(turnId);
    try {
      this.store.transaction(() => {
        delivery?.claim();
        // New work reopens a thread the person had marked done.
        if (thread.doneAt && !slashCommand) this.store.setThreadProgress(threadId, { doneAt: null });
        this.running.set(threadId, { turnId, cancelRequested: false, since: new Date().toISOString() });
        this.store.updateThread(threadId, { status: 'running', workMode: thread.workMode ?? 'execute', hubTurnAt: new Date().toISOString() }, { touch: true });
        if (thread.title === 'New thread') {
          const title = askedText(rawText).split('\n')[0].slice(0, 60) || (storedVideos.length ? '视频' : '图片');
          this.store.updateThread(threadId, { title });
        }
        this.emitThreadEvent(threadId, turnId, 'turn.started', {
          text: promptText,
          speed: thread.speed,
          workMode: thread.workMode ?? 'execute',
          ...(delivery ? { coordination: delivery.source } : {}),
          ...(promptText !== rawText ? { displayText: delivery?.displayText ?? rawText.split('\n\n[指定协作对象]')[0] } : {}),
          ...(stored.length ? { images: stored } : {}),
          ...(storedVideos.length ? { videos: storedVideos } : {}),
          ...(typeof input.handover === 'string' && input.handover ? { handover: input.handover, handoverLabel: this.adapters.get(input.handover)?.label ?? input.handover } : {}),
          ...(input.scheduled === true ? { scheduled: true } : {}),
        });
      });
    } catch (err) { this.running.delete(threadId); this.reportTurns.delete(turnId); throw err; }
    void this.runTurn(thread, turnId, { text: promptText, images });
    return { turnId };
  }

  /**
   * Asks this thread's agent to write a handover summary for another agent, in its own session:
   * it knows its own context best. The turn runs like any other and streams into the thread.
   */
  async startHandover(threadId: string, target: string, allowSame = false): Promise<{ turnId: string }> {
    const thread = this.getThread(threadId);
    const successor = this.adapters.get(target);
    if (!successor) throw new HttpError(404, `no such agent: ${target}`);
    if (!allowSame && target === thread.agent) throw new HttpError(400, 'the successor must be another agent');
    const started = await this.startTurn(threadId, { text: handoverPrompt(successor.label), handover: target }, undefined, true);
    if (!('turnId' in started)) throw new HttpError(409, 'a turn is already running in this thread');
    return started;
  }

  /** Session coordinates without reading history or starting an agent. */
  async handoverLocation(threadId: string) {
    const thread = this.getThread(threadId);
    const adapter = this.adapters.get(thread.agent);
    const location = await adapter?.sessionLocation?.(thread.agentSessionId, thread.cwd);
    return { threadId, agent: thread.agent, agentLabel: adapter?.label ?? thread.agent,
      adapter: adapter?.id ?? null, sessionId: thread.agentSessionId, cwd: thread.cwd,
      sessionPath: location?.sessionPath ?? null, title: thread.title, status: thread.status };
  }

  /**
   * The handover summary: what the agent wrote in its handover turn, or — when the turn failed or
   * none was run — one the hub synthesizes from the event log, which holds the whole process.
   */
  async handoverSummary(
    threadId: string,
    turnId: string | null,
    target?: string,
  ): Promise<{ pending: true } | { summary: string; source: 'agent' | 'log' }> {
    const thread = this.threadView(threadId);
    const events = this.listEventsSince(threadId, 0);
    const adapter = this.adapters.get(thread.agent);
    const location = await adapter?.sessionLocation?.(thread.agentSessionId, thread.cwd);
    const checkout = await findCheckout(thread.cwd);
    const context = handoverContext({
      threadId,
      title: thread.title,
      agentId: thread.agent,
      agentLabel: adapter?.label ?? thread.agent,
      adapter: adapter?.id ?? '未知',
      cwd: thread.cwd,
      cwdReal: thread.cwdReal,
      worktree: checkout && !samePath(checkout.top, checkout.main)
        ? { root: checkout.top, branch: checkout.branch, main: checkout.main }
        : thread.worktree ? { root: thread.worktree.root, branch: thread.worktree.branch, main: thread.worktree.of } : null,
      sessionId: thread.agentSessionId,
      ...location,
      resumeCommand: location?.resumeCommand ? `cd ${shellQuote(thread.cwd)} && ${location.resumeCommand}` : thread.resumeCommand,
    });
    if (turnId) {
      const turnEvents = events.filter((e) => e.turnId === turnId);
      if (turnEvents.length === 0) throw new HttpError(404, 'no such turn');
      if (!turnEvents.some((e) => e.type === 'turn.done' || e.type === 'turn.error')) return { pending: true };
      const written = turnMessage(turnEvents).trim();
      if (written && !turnEvents.some(e => e.type === 'turn.error' || e.type === 'turn.done' && e.data.stopReason === 'cancelled')) return { summary: `${context}\n\n${written}`, source: 'agent' };
    }
    const successor = (target ? this.adapters.get(target)?.label ?? target : '另一个 agent');
    const from = this.adapters.get(thread.agent)?.label ?? thread.agent;
    return { summary: `${context}\n\n${synthesizeHandover(events, { title: thread.title, from, target: successor })}`, source: 'log' };
  }

  hasAgent(id: string): boolean { return this.adapters.has(id); }
  canSwitchHandoverModel(id: string): boolean { return this.adapters.get(id)?.capabilities.modelSwitch === true; }
  async handoverModel(agent: string, model?: string | null): Promise<string | undefined> {
    try {
      const models = await this.adapters.get(agent)?.models() ?? [];
      return model ? models.find(m => m.id === model)?.id : models.find(m => m.isDefault)?.id;
    } catch { return model || undefined; }
  }
  notifyHandover(id?: string): void {
    if (id) { if (this.store.getThread(id)) this.emitThreadEvent(id, null, 'thread.updated', {}); }
    else for (const listener of this.listeners) listener({ threadId: '', seq: 0, turnId: null, type: 'handover.updated', ts: new Date().toISOString(), data: {} });
  }
  recordHandoverModel(id: string, model: string, previous: string | undefined, reason: string): void {
    this.emitThreadEvent(id, null, 'handover.model', { model, previous, reason });
  }
  async cancelHandoverSummary(id: string): Promise<void> {
    const run = this.running.get(id);
    if (run && this.store.listTurnEvents(id, run.turnId).some(e => e.type === 'turn.started' && e.data.handover)) await this.stopTurn(id).catch(() => undefined);
  }
  async autoHandoverSummary(id: string, target: string, exhausted: boolean): Promise<string> {
    let summaryTurn: string | null = null;
    if (!exhausted) {
      try {
        const started = await this.startHandover(id, target, true);
        summaryTurn = started.turnId;
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); off(); resolve(); };
          const off = this.subscribe(e => { if (e.threadId === id && e.type === 'thread.updated' && !this.running.has(id)) finish(); });
          const timer = setTimeout(() => { void this.stopTurn(id); finish(); }, 60_000);
          if (!this.running.has(id)) finish();
        });
        if (this.running.has(id)) throw new HttpError(409, 'handover summary did not stop');
      } catch (error) {
        if (this.running.has(id)) throw error;
        summaryTurn = null;
      }
    }
    const result = await this.handoverSummary(id, summaryTurn, target);
    if ('summary' in result) return result.summary;
    const fallback = await this.handoverSummary(id, null, target);
    if ('summary' in fallback) return fallback.summary;
    throw new HttpError(409, 'handover summary unavailable');
  }
  async retryAutoHandoverTurn(id: string, failedTurn: string): Promise<void> {
    const failed = this.store.listTurnEvents(id, failedTurn).find(e => e.type === 'turn.started');
    if (!failed) throw new HttpError(409, 'failed turn not found');
    const images = ((failed.data.images ?? []) as Array<{ id: string }>).map(img => {
      const file = this.attachments.find(id, img.id);
      if (!file) throw new HttpError(409, 'handover attachment unavailable');
      return { data: readFileSync(file.path).toString('base64') };
    });
    const text = String(failed.data.displayText ?? failed.data.text ?? '');
    const turnId = randomUUID();
    await this.startTurn(id, { text, images, videos: ((failed.data.videos ?? []) as Array<{ id: string }>).map(v => v.id), autoContinuation: true }, {
      turnId, source: { retry: failedTurn }, displayText: text,
      claim: () => this.coordination?.retryHandoverTurn(id, failedTurn, turnId),
    }, true);
  }

  async executeAutoHandover(id: string, target: HandoverTarget, summary: string, failedTurn: string | null): Promise<void> {
    const source = this.getThread(id);
    const successor = await this.createHandoverThread(id, target.agent, target.model, 'continue');
    this.autoHandover.inherit(id, successor.id);
    const adapter = this.adapters.get(target.agent)!;
    // Preserve the user's execution and permission choices when the successor supports them.
    if (adapter.capabilities.permissionModes.includes(source.permissionMode as PermissionMode)) await this.updateThread(successor.id, { permissionMode: source.permissionMode });
    if (adapter.capabilities.workModes?.includes(source.workMode ?? 'execute')) await this.updateThread(successor.id, { workMode: source.workMode ?? 'execute' });
    this.attachments.copyThread(id, successor.id);
    const failed = failedTurn ? this.store.listTurnEvents(id, failedTurn).find(e => e.type === 'turn.started') : undefined;
    const images = ((failed?.data.images ?? []) as Array<{ id: string }>).map(img => {
      const file = this.attachments.find(id, img.id);
      if (!file) throw new HttpError(409, 'handover attachment unavailable');
      return { mimeType: file.mimeType, data: readFileSync(file.path).toString('base64') };
    });
    const videos = ((failed?.data.videos ?? []) as Array<{ id: string }>).map(v => v.id);
    const retry = failed ? String(failed.data.displayText ?? failed.data.text ?? '') : '';
    const turnId = randomUUID();
    const text = summary + (retry ? '\n\n## 继续未完成的这一轮\n\n' + retry : '');
    // Reserve the mailbox identity in the same synchronous claim as the first successor turn.
    await this.startTurn(successor.id, { text, images, videos, handoverFrom: id }, {
      turnId, source: { handover: id }, displayText: text,
      claim: () => this.coordination?.replaceHandoverMember(id, successor.id, turnId),
    });
    const queue = this.queues.get(id) ?? [];
    this.attachments.copyThread(id, successor.id);
    this.setQueue(id, []);
    if (queue.length) this.setQueue(successor.id, [...(this.queues.get(successor.id) ?? []), ...queue]);
    this.startNextQueued(successor.id);
  }

  /** Takes a waiting message out of the queue and hands it back, so the page can edit and resend it. */
  removeQueued(threadId: string, queuedId: string): { text: string; images: unknown[]; videos?: StoredVideo[]; mentions?: unknown[] } {
    this.getThread(threadId);
    const queue = this.queues.get(threadId) ?? [];
    const taken = queue.find((q) => q.id === queuedId);
    if (!taken) throw new HttpError(404, 'no such waiting message');
    const videos = this.attachments.videos(threadId, taken.videos);
    this.setQueue(threadId, queue.filter((q) => q.id !== queuedId));
    this.startNextQueued(threadId);
    return { text: taken.text, images: taken.images, ...(videos.length ? { videos } : {}), ...(taken.mentions ? { mentions: taken.mentions } : {}) };
  }

  /** Interrupts the running turn so that this waiting message goes out next, ahead of the others. */
  async sendQueuedNow(threadId: string, queuedId: string): Promise<void> {
    this.getThread(threadId);
    const queue = this.queues.get(threadId) ?? [];
    const chosen = queue.find((q) => q.id === queuedId);
    if (!chosen) throw new HttpError(404, 'no such waiting message');
    delete chosen.error;
    this.setQueue(threadId, [chosen, ...queue.filter((q) => q !== chosen)]);
    if (this.running.has(threadId)) await this.cancelTurn(threadId, { keepQueue: true });
    else this.startNextQueued(threadId);
  }

  private setQueue(threadId: string, queue: QueuedTurn[]): void {
    if (queue.length) this.queues.set(threadId, queue);
    else this.queues.delete(threadId);
    this.emitThreadEvent(threadId, null, 'thread.updated', {});
  }

  /** Sends the next waiting message, if there is one. Called whenever a turn has finished. */
  private startNextQueued(threadId: string): void {
    if (this.autoHandover.queuePaused(threadId) || this.running.has(threadId) || this.startingTurns.has(threadId) || this.dispatchingQueues.has(threadId)) return;
    const queue = this.queues.get(threadId);
    const next = queue?.find(q => !q.error);
    if (!queue || !next) return;
    const rest = queue.filter(q => q !== next);
    this.dispatchingQueues.add(threadId);
    if (rest.length) this.queues.set(threadId, rest);
    else this.queues.delete(threadId);
    this.startTurn(threadId, { workMode: next.workMode, text: next.text, images: next.images, videos: next.videos, mentions: next.mentions, collaboration: next.collaboration }, undefined, true).catch((err) => {
      // The thread was archived or deleted in the meantime, or the message is no longer acceptable.
      console.error(`could not send a queued message: ${err instanceof Error ? err.message : err}`);
      if (this.store.getThread(threadId)) this.setQueue(threadId, [
        { ...next, error: err instanceof Error ? err.message : String(err) }, ...(this.queues.get(threadId) ?? []),
      ]);
    }).finally(() => {
      this.dispatchingQueues.delete(threadId);
      this.startNextQueued(threadId);
    });
  }

  /**
   * Stops the running turn. Stopping means stopping: messages waiting behind it are not sent, they
   * are handed back (their text) so the caller can put them in front of the user again.
   */
  async cancelTurn(threadId: string, opts: { keepQueue?: boolean } = {}): Promise<{ dropped: string[]; mentions?: unknown[] }> {
    this.getThread(threadId);
    if (!opts.keepQueue) await this.coordination?.beforeStop(threadId);
    const mentions = opts.keepQueue ? [] : (this.queues.get(threadId) ?? []).flatMap(q => q.mentions ?? []);
    const dropped = opts.keepQueue ? [] : (this.queues.get(threadId) ?? []).map((q) => q.text).filter(Boolean);
    if (!opts.keepQueue && this.queues.has(threadId)) this.setQueue(threadId, []);
    await this.stopTurn(threadId);
    return { dropped, ...(mentions.length ? { mentions } : {}) };
  }

  private async stopTurn(threadId: string): Promise<void> {
    const run = this.running.get(threadId);
    if (run) run.cancelRequested = true;
    this.inputs.cancel(threadId, undefined, true);
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
    this.autoHandover.close();
    this.coordination?.suspendAll();
    for (const threadId of [...this.running.keys()]) await this.cancelTurn(threadId).catch(() => undefined);
    const deadline = Date.now() + 3000;
    while (this.running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await Promise.allSettled([...this.settlingHandovers]);
    for (const [, s] of this.sessions) await s.close().catch(() => undefined);
    this.sessions.clear();
    this.sessionAdapters.clear();
  }

  private async runTurn(thread: ThreadRecord, turnId: string, input: TurnInput): Promise<void> {
    const start = this.store.listTurnEvents(thread.id, turnId).find(e => e.type === 'turn.started');
    if (!start?.data.handover && !start?.data.control) this.autoHandover.reserve(thread.id, turnId);
    let finalStatus: ThreadRecord['status'] = 'idle';
    // A finished turn is something new to look at. A turn the user stopped is not.
    let unread = true;
    try {
      const hooks = this.hooksFor(thread.id, turnId);
      const session = await this.ensureSession(thread);
      if (this.nativeTurns.get(thread.id)?.size) await new Promise<void>(resolve => {
        const waiters = this.nativeIdle.get(thread.id) ?? new Set<() => void>();
        waiters.add(resolve);
        this.nativeIdle.set(thread.id, waiters);
      });
      if (this.running.get(thread.id)?.cancelRequested) {
        // Cancelled while the agent was starting: never send the prompt.
        unread = false;
        this.emitThreadEvent(thread.id, turnId, 'turn.done', { stopReason: 'cancelled' });
        return;
      }
      const result = await session.prompt(input, hooks);
      if (!start?.data.handover && !start?.data.control) this.autoHandover.reserve(thread.id, turnId);
      if (result.stopReason === 'cancelled') unread = false;
      if (result.stopReason === 'error') {
        finalStatus = 'error';
        const message = result.error ?? 'agent error';
        const code = result.errorCode ?? (this.adapters.get(thread.agent)?.planExhausted?.(message) ? 'plan_exhausted' : undefined);
        this.emitThreadEvent(thread.id, turnId, 'turn.error', {
          message,
          ...(code ? { code, ...(code === 'permission_refused' ? { refused: result.refused ?? [] } : {}) } : {}),
        });
      } else {
        this.emitThreadEvent(thread.id, turnId, 'turn.done', { stopReason: result.stopReason });
        if (result.stopReason !== 'cancelled' && this.reportTurns.has(turnId)) this.recordProgress(thread.id, turnId);
      }
    } catch (err) {
      finalStatus = 'error';
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = this.adapters.get(thread.agent)?.planExhausted?.(message);
      this.emitThreadEvent(thread.id, turnId, 'turn.error', { message, ...(exhausted ? { code: 'plan_exhausted' } : {}) });
      await this.dropSession(thread.id);
    } finally {
      this.reportTurns.delete(turnId);
      if (!this.nativeTurns.get(thread.id)?.size) this.inputs.cancel(thread.id, undefined, true);
      if (this.running.get(thread.id)?.turnId === turnId) this.running.delete(thread.id);
      const nativeTurn = this.nativeTurns.get(thread.id)?.values().next().value;
      if (nativeTurn && !this.running.has(thread.id)) {
        this.running.set(thread.id, { turnId: nativeTurn, cancelRequested: false, since: new Date().toISOString() });
        finalStatus = 'running';
      }
      // The thread may have been deleted while its last turn was winding down.
      if (this.store.getThread(thread.id)) {
        this.store.updateThread(thread.id, { status: finalStatus, ...(unread ? { unread: true } : {}) }, { touch: true });
        this.emitThreadEvent(thread.id, null, 'thread.updated', {});
        const settling = this.autoHandover.settled(thread.id, turnId);
        this.settlingHandovers.add(settling);
        try { await settling; } finally { this.settlingHandovers.delete(settling); }
        this.startNextQueued(thread.id);
      }
    }
  }

  /**
   * Reads the turn's `[进度]` line. A turn that was asked and said nothing withdraws the last
   * report, so an old one never outlives the work.
   */
  private recordProgress(threadId: string, turnId: string): void {
    const said = parseProgress(turnAnswer(this.store.listTurnEvents(threadId, turnId), turnId));
    this.store.setThreadProgress(threadId, { report: said ? { ...said, at: new Date().toISOString() } : null });
  }

  voiceProvider(threadId: string): { providerId: string } {
    const thread = this.getThread(threadId);
    if (thread.archivedAt || !this.adapters.get(thread.agent)?.capabilities.realtimeVoice
      || this.sessions.has(threadId) && this.sessionAdapters.get(threadId) !== this.adapters.get(thread.agent) && this.running.has(threadId)) {
      throw new HttpError(409, 'voice_provider_unavailable');
    }
    return { providerId: thread.agent };
  }

  /** Deferred initialization lets the lease own cancellation before any process is started. */
  voiceTransport(threadId: string, authorize: () => void = () => {}): VoiceTransport {
    const provider = this.voiceProvider(threadId).providerId;
    const adapter = this.adapters.get(provider);
    let ended = false;
    let started = false;
    let transport: VoiceTransport | undefined;
    const conversation = new VoiceConversation(
      () => this.store.history.latest(threadId),
      message => {
        if (this.store.getThread(threadId)) this.emitThreadEvent(threadId, null, 'voice.message', { ...message });
      },
    );
    return {
      start: async (offer, emit) => {
        if (ended || started) throw new Error('voice_session_ended');
        started = true;
        if (this.sessions.has(threadId) && this.sessionAdapters.get(threadId) !== adapter) {
          if (this.running.has(threadId)) throw new Error('voice_provider_changed');
          await this.dropSession(threadId);
        }
        const session = await this.ensureSession(this.getThread(threadId));
        if (ended) throw new Error('voice_session_ended');
        if (this.voiceProvider(threadId).providerId !== provider || this.adapters.get(provider) !== adapter) {
          throw new Error('voice_provider_changed');
        }
        transport = session.voiceTransport?.() ?? undefined;
        if (!transport) throw new Error('voice_session_unavailable');
        return transport.start(offer, signal => {
          if (ended) return;
          // Persistence must obey the same current grant/account checks as the private SSE,
          // before any final transcript can reach the ordinary conversation history.
          try {
            authorize();
            if (this.voiceProvider(threadId).providerId !== provider || this.adapters.get(provider) !== adapter) {
              throw new Error('voice_provider_changed');
            }
          } catch { emit({ type: 'error' }); return; }
          emit(conversation.accept(signal));
        });
      },
      stop: async () => {
        ended = true;
        conversation.close();
        await transport?.stop();
      },
      dispose: () => { ended = true; conversation.close(); transport?.dispose(); },
    };
  }

  private async ensureSession(thread: ThreadRecord): Promise<AgentSession> {
    const pending = this.sessionStarts.get(thread.id);
    if (pending) return pending;
    const task = this.createSession(thread);
    this.sessionStarts.set(thread.id, task);
    try { return await task; }
    finally { if (this.sessionStarts.get(thread.id) === task) this.sessionStarts.delete(thread.id); }
  }

  private async createSession(thread: ThreadRecord): Promise<AgentSession> {
    const existing = this.sessions.get(thread.id);
    if (existing) {
      if (existing.setWorkMode) await existing.setWorkMode(thread.workMode ?? 'execute');
      return existing;
    }
    const adapter = this.adapters.get(thread.agent);
    if (!adapter) throw new Error(`unknown agent: ${thread.agent}`);
    const session = await adapter.start({
      borrowedTool: this.borrowing?.toolForThread(thread.id),
      coordinationEnv: { ...this.coordination?.environment(thread.id), ...this.borrowing?.environment(thread.id) },
      cwd: thread.cwd,
      resumeId: thread.agentSessionId ?? undefined,
      permissionMode: thread.permissionMode as PermissionMode,
      speed: thread.speed,
      workMode: thread.workMode ?? 'execute',
      onSpeed: (speed) => {
        if (!this.store.getThread(thread.id)) return;
        this.store.updateThread(thread.id, { speed });
        this.emitThreadEvent(thread.id, null, 'thread.updated', {});
      },
      onWorkMode: (workMode) => {
        if (!this.store.getThread(thread.id)) return;
        this.store.updateThread(thread.id, { workMode });
        this.emitThreadEvent(thread.id, null, 'thread.updated', {});
      },
      model: thread.model ?? undefined,
      effort: (thread.effort ?? undefined) as EffortLevel | undefined,
    });
    session.setSessionHooks?.({
      turnStarted: nativeId => {
        const turnId = randomUUID();
        const turns = this.nativeTurns.get(thread.id) ?? new Map<string, string>();
        turns.set(nativeId, turnId);
        this.nativeTurns.set(thread.id, turns);
        // The native engine serializes turns. Keep its work visible and block queued prompts.
        if (!this.running.has(thread.id)) this.running.set(thread.id, {
          turnId, cancelRequested: false, since: new Date().toISOString(),
        });
        this.store.updateThread(thread.id, { status: 'running', hubTurnAt: new Date().toISOString() }, { touch: true });
        this.emitThreadEvent(thread.id, turnId, 'turn.started', { text: '', source: 'voice', nativeTurnId: nativeId });
        return this.hooksFor(thread.id, turnId);
      },
      turnFinished: (nativeId, result) => {
        const turns = this.nativeTurns.get(thread.id);
        const turnId = turns?.get(nativeId);
        if (!turnId) return;
        turns!.delete(nativeId);
        if (!turns!.size) {
          this.nativeTurns.delete(thread.id);
          const waiters = this.nativeIdle.get(thread.id);
          this.nativeIdle.delete(thread.id);
          for (const resolve of waiters ?? []) resolve();
        }
        if (!this.store.getThread(thread.id)) return;
        this.emitThreadEvent(thread.id, turnId, result.stopReason === 'error' ? 'turn.error' : 'turn.done',
          result.stopReason === 'error' ? { message: result.error ?? 'agent error' } : { stopReason: result.stopReason });
        if (this.running.get(thread.id)?.turnId === turnId) {
          this.running.delete(thread.id);
          this.inputs.cancel(thread.id, undefined, true);
          for (const [id, approval] of this.approvals) if (approval.threadId === thread.id) this.resolveApproval(id, { cancelled: true });
          this.store.updateThread(thread.id, { status: result.stopReason === 'error' ? 'error' : 'idle', unread: result.stopReason !== 'cancelled' }, { touch: true });
          this.emitThreadEvent(thread.id, null, 'thread.updated', {});
          this.startNextQueued(thread.id);
        }
      },
    });
    this.sessions.set(thread.id, session);
    this.sessionAdapters.set(thread.id, adapter);
    if (session.agentSessionId !== thread.agentSessionId) {
      this.store.updateThread(thread.id, { agentSessionId: session.agentSessionId });
    }
    return session;
  }

  private async dropSession(threadId: string): Promise<void> {
    const pending = this.sessionStarts.get(threadId);
    if (pending) await pending.catch(() => undefined);
    const s = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    this.sessionAdapters.delete(threadId);
    if (s) await s.close().catch(() => undefined);
  }

  private hooksFor(threadId: string, turnId: string): TurnHooks {
    return {
      emit: (ev: EmittedEvent) => {
        this.emitThreadEvent(threadId, turnId, ev.type, ev.data);
        // A finished plan ends plan mode: what is said next, a go-ahead or a change to the plan, is
        // a normal turn. The session takes the mode back on before that turn (ensureSession).
        if (ev.type === 'plan.completed' && this.store.getThread(threadId)?.workMode === 'plan') {
          this.store.updateThread(threadId, { workMode: 'execute' });
          this.emitThreadEvent(threadId, null, 'thread.updated', {});
        }
      },
      requestInput: req => this.running.get(threadId)?.cancelRequested
        ? Promise.resolve({ cancelled: true }) : this.inputs.request(threadId, turnId, req),
      cancelInput: id => this.inputs.cancel(threadId, id, true),
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
    if (type === 'turn.started') {
      const agent = this.store.getThread(threadId)?.agent;
      const account = this.agentMeta().find(m => m.id === agent)?.account;
      if (account) data = { ...data, linkedAccount: account };
    }
    const stored = this.store.appendEvent(threadId, turnId, type, data);
    for (const l of this.listeners) l(stored);
  }
}
