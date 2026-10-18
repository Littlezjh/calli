export type WorkMode = 'execute' | 'plan';
export interface UserQuestion { id: string; question: string; header?: string; options: Array<{ value: string; label: string; description?: string }>; multiple?: boolean; freeText?: boolean; required?: boolean }
export type UserInputAnswer = { answers: Record<string, string[]> } | { cancelled: true };
import type { UsageReport, AgentDiagnostic } from './observability';
import type { StoredEvent } from './timeline';
import { cachedQuota, clearQuotaCache, rememberQuota } from './quota-cache';
import { localeTag, t } from './i18n';

/** Where threads may work: the project roots, and whether one can start outside any project. */
export interface FolderEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  /** Ignored by git: shown, but quieter. */
  ignored?: boolean;
}

/** A folder as the file browser sees it. `root` is the real path of the thread folder it is in. */
export interface FolderListing {
  root: string;
  path: string;
  entries: FolderEntry[];
  truncated: boolean;
}

export interface TextFile {
  root: string;
  path: string;
  size: number;
  /** Null for a binary file. */
  text: string | null;
  /** Only the start of a long file is in `text`. */
  truncated: boolean;
}

export interface WorkdirsConfig {
  workdirs: string[];
  /** Each root and whether it was added from the page (and so can be removed there). Missing from older daemons. */
  roots?: Array<{ path: string; removable: boolean }>;
  /** Missing from older daemons: no threads outside a project. */
  scratch?: boolean;
}

export interface AgentMention { id: string; label: string; kind: 'agent' | 'member'; cwd?: string; /** What the user asks of this one alone. */ task?: string }
/** One turn a search found: where it is, who said it, and the words around the match. */
export interface SearchHit {
  threadId: string;
  turnId: string;
  role: 'user' | 'assistant';
  ts: string;
  snippet: string;
  title: string;
  agent: string;
  cwd: string;
  archived: boolean;
}

/** The whole prompt a conversation runs with, as the agent itself persisted it. */
export interface SystemPrompt {
  text: string;
  source: string;
}

/** One day of the digest: what the user asked and what the models called. */
export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  turns: number;
  threads: number;
  prompts: Array<{ threadId: string; turnId: string; ts: string; text: string; title: string; agent: string; cwd: string; archived: boolean; /** Tool calls the turn made; absent from older daemons. */ tools?: number }>;
  morePrompts: number;
  tools: Array<{ name: string; count: number; mcp: boolean; server?: string }>;
  mcp: Array<{ server: string; count: number }>;
}

export interface ActivityReport {
  days: ActivityDay[];
}

export type TraceStepKind = 'user' | 'thinking' | 'assistant' | 'tool' | 'request' | 'context' | 'error';

/** One thing that happened in a turn, as the daemon's trace reads it out of the event log. */
export interface TraceStep {
  kind: TraceStepKind;
  ts: string;
  endTs?: string;
  text?: string;
  tool?: string;
  title?: string;
  server?: string;
  status?: string;
  input?: string;
  output?: string;
  model?: string;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** A text above was cut; the thread holds all of it. */
  cut?: boolean;
}

/** One turn read back step by step: the ask, the thinking, each tool and model request, the answer. */
export interface TurnTrace {
  threadId: string;
  turnId: string;
  title: string;
  agent: string;
  cwd: string;
  models: string[];
  status: 'running' | 'done' | 'cancelled' | 'error';
  startedAt: string;
  endedAt: string | null;
  steps: TraceStep[];
  totals: { tools: number; mcp: number; requests: number; input: number; output: number };
  turns: Array<{ turnId: string; ts: string }>;
}

/** The model and thinking effort members of one instance start with; null leaves the agent's own. */
export interface MemberDefault { model: string | null; effort: string | null; /** Set where this instance's members differ from the team's level. */ permission?: string }
export interface Coordination {
  rootId: string; paused: boolean; directories: string[]; agents: string[];
  /** By instance id. Absent from older daemons. */
  defaults?: Record<string, MemberDefault>;
  /** How much members may do without asking. Absent from older daemons. */
  permission?: string;
  members: Array<{ id: string; name: string; thread: Thread | null; latest: CoordinationMessage | null }>;
  messages: CoordinationMessage[];
}
export interface CoordinationMessage {
  id: string; from: string; to: string; text: string; kind: string; state: string; result: string; createdAt: string; turnId: string | null;
  /** For a result: the message it answers. Absent from older daemons. */
  replyTo?: string | null;
}
export interface Thread {
  /** `doing`, on a member: its latest task while it works, the opening of its answer once it has returned. */
  coordination?: { rootId: string; children: number; paused: boolean; doing?: string };
  id: string;
  agent: string;
  cwd: string;
  title: string;
  agentSessionId: string | null;
  status: 'idle' | 'running' | 'error';
  pinned: boolean;
  workMode?: WorkMode;
  speed?: string | null;
  permissionMode: string;
  model: string | null;
  effort: string | null;
  archivedAt: string | null;
  sectionId: string | null;
  /** The thread this one was forked from, if it is a fork. */
  forkedFrom: string | null;
  handover?: { sourceId: string; title: string; agent: string } | null;
  /**
   * The git worktree the thread runs in, when a fork was given one. `of` is the directory it would
   * be in otherwise, which is the project it is listed under; `ofReal` is that with symlinks
   * resolved. Missing from daemons that predate worktrees.
   */
  worktree?: { root: string; branch: string; of: string; ofReal: string } | null;
  /** In no project: working in the hub's scratch area. Missing from daemons that predate it. */
  scratch?: boolean;
  /** A turn finished and nobody has looked at the result yet. */
  unread: boolean;
  /** The newest thing the user asked, shown under the title. Null until the first ask. */
  preview: string | null;
  /** The scheduled task that started this thread, if any. Missing from older daemons. */
  schedule?: { id: string; name: string } | null;
  /** The terminal wrote to this session since the hub last did. */
  terminalActivity: boolean;
  /** The agent is waiting for the user to respond. */
  waiting: boolean;
  /** Missing from older daemons, which do not distinguish questions from approvals. */
  waitingReason?: 'approval' | 'question' | 'plan' | null;
  /** Messages sent while a turn was running; they go out as turns finish. */
  queued: QueuedMessage[];
  /** Shell command that continues this conversation in a terminal. Null before the first message. */
  resumeCommand: string | null;
  /** `cwd` with symlinks resolved, which is how agents report file paths. */
  cwdReal: string;
  createdAt: string;
  updatedAt: string;
}

/** What forking a thread can offer. The worktree is there for a thread in a git repository, with an agent that can move a copy. */
export interface ForkOptions {
  worktree: { available: boolean; reason?: string; branch?: string | null; changes?: number };
}

/** One firing of a scheduled task: how it went, and which thread to look at. */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  status: 'running' | 'done' | 'error' | 'skipped' | 'missed';
  threadId: string | null;
  turnId: string | null;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

/** A recurring task: a prompt an agent runs in a directory on a cron schedule. */
export interface Schedule {
  id: string;
  name: string;
  agent: string;
  cwd: string;
  prompt: string;
  cron: string;
  mode: 'new' | 'same';
  threadId: string | null;
  permissionMode: string;
  enabled: boolean;
  timezone: string | null;
  catchUp: boolean;
  /** The cron in words. Empty for uncommon shapes: show the raw expression. */
  description: string;
  nextRunAt: string | null;
  lastRun: ScheduleRun | null;
  /** Why this cannot run as-is: a broken expression, a gone agent, a gone thread. */
  problem: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A request the daemon refused. `details` is whatever it sent besides the message, for errors the page handles itself. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly status = 0,
  ) {
    super(message);
  }
}

/** How many messages may wait behind a running turn. Matches the daemon's limit. */
export const MAX_QUEUED = 5;

export interface QueuedMessage {
  id: string;
  text: string;
  /** How many pictures go with it. */
  images: number;
  videos?: number;
}

export interface VideoRef { id: string; name: string; mimeType: string; size: number }

/** A user-made group in the sidebar. */
export interface Section {
  id: string;
  name: string;
  position: number;
}

/** One entry on the plan page. `parentId` is a top-level todo or null: one level of nesting. */
export interface Todo {
  id: string;
  text: string;
  done: boolean;
  parentId: string | null;
  position: number;
  createdAt: string;
  doneAt: string | null;
  /** Threads linked to this plan, as full views so chips can show agent, title and state. */
  threads: Thread[];
}

/** An image ready to be sent with a message. */
export interface OutgoingImage {
  data: string;
  mimeType: string;
}

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  modified?: string;
}

export interface DirectoryInfo {
  path: string;
  files: DirectoryEntry[];
  parent?: string | null;
}

export interface ProjectDirectoryInfo {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
  allowed: boolean;
  selectable: boolean;
}

export interface DirectoryTreeNode {
  name: string;
  path: string;
  type: 'dir';
  children?: DirectoryTreeNode[];
}

export interface SlashCommand {
  name: string;
  description: string;
  /** What to type after the command, as the agent describes it. */
  hint?: string;
  /** Present only when the agent says what the entry is. */
  kind?: 'command' | 'prompt' | 'skill';
}

export interface ModelOption {
  id: string;
  label: string;
  /** Short note from the agent, such as the concrete version behind an alias. */
  description?: string;
  /** Effort levels this model accepts. Empty: none. Missing: use the agent-wide list. */
  efforts?: string[];
  speeds?: Array<{ id: string; label: string; description?: string; isFast?: boolean }>;
  /** False when the model cannot read images. */
  images?: boolean;
  /** How images reach a model that cannot read them, such as a tool that hands them to a vision model. */
  imagesVia?: string;
  /** The model the agent uses when the thread does not pick one. */
  isDefault?: boolean;
}

/** Older Hub responses lack isFast. Only recognize their advertised public fast-tier IDs. */
export function isFastSpeed(speed: NonNullable<ModelOption['speeds']>[number]): boolean {
  return speed.isFast ?? ['priority', 'fast', 'ultrafast'].includes(speed.id);
}

export interface AgentInfo {
  id: string;
  label: string;
  /** The agent's mark: the path of a 24×24 drawing, filled with the even-odd rule. Missing from daemons that predate it. */
  icon?: string;
  /** Which adapter this instance is; instances of one adapter group together in the picker. */
  adapter?: string;
  /** The login this instance runs as, when it is a linked account (an email). */
  account?: string | null;
  available: boolean;
  capabilities: {
    workModes?: WorkMode[];
    speed?: boolean;
    coordination?: boolean;
    resume: boolean;
    approvals: boolean;
    permissionModes: string[];
    /** The level a new thread starts at. Missing: `auto_edit`. */
    defaultPermissionMode?: string;
    effortLevels: string[];
    images: boolean;
    deleteSession: boolean;
    /** Can list its past sessions and replay them, so they can be imported. */
    history: boolean;
    /** Can read plan usage outside a session, for the quota panel. */
    quota: boolean;
    compact?: boolean;
    goal?: { controls: Array<'show' | 'pause' | 'clear'>; actions?: Array<'set' | 'show' | 'pause' | 'resume' | 'clear'> };
    fork: boolean;
    /** A fork can end at an earlier turn instead of taking the whole thread. Missing from daemons that predate it. */
    forkAt?: boolean;
    /** A fork can run in a git worktree of its own. Missing from daemons that predate it. */
    forkInto?: boolean;
    /** The whole prompt of a conversation can be read from the agent's session file. Missing from daemons that predate it. */
    systemPrompt?: boolean;
  };
}

/** One window of a plan's usage, as the agent itself reports it. */
export interface QuotaWindow {
  /** Short chip label, such as "5H" or "7D". */
  label: string;
  /** What the window covers, when the agent splits by model group. */
  scope?: string;
  /** How much of the window is used, 0 to 100. */
  usedPercent: number;
  /** When the window resets, if the agent said so. ISO. */
  resetsAt?: string;
  /** How busy the model behind this window is right now; above 100 means overloaded. */
  loadPercent?: number;
}

/** Plan usage of an agent instance, read outside any session. */
export interface PlanQuota {
  windows: QuotaWindow[];
  note?: string;
  /** When the agent was last asked. ISO. */
  checkedAt: string;
}

/** A conversation the agent already has, as offered for import. */
export interface AgentSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string | null;
  /** Set when this session is already a thread here (possibly an archived one). */
  threadId: string | null;
}

/** A web terminal, as the daemon lists it. Exited ones are not listed. */
export interface TerminalInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  lastActivity: number;
}

/** One SSE frame of a terminal stream. Output is base64: programs may emit non-UTF-8 bytes. */
export type TerminalFrame = { type: 'backlog'; data: string } | { type: 'out'; data: string } | { type: 'exit'; code: number };

/** Why a machine cannot be reached, as the hub sorts what ssh said. */
export type HostFailure = 'no_ssh' | 'host_key' | 'auth' | 'unreachable' | 'ssh_failed' | 'daemon_missing' | 'forward_denied';

/** A folder an agent reads skills from. `agents` are the instances that see it. */
export interface SkillLocation {
  path: string;
  scope: 'personal' | 'shared';
  agents: string[];
}

/** One skill as it stands in one folder. */
export interface SkillPlace {
  /** The folder the skill sits in, not the skill's own folder. */
  path: string;
  mtime: string;
  sizeBytes: number;
  fileCount: number;
  /** sha256 of the layout plus the SKILL.md: how two machines tell they hold the same. */
  digest: string;
  agents: string[];
}

/** A skill merged across the folders it sits in, newest first. */
export interface SkillEntry extends SkillPlace {
  name: string;
  description: string;
  locations: SkillPlace[];
  /** Union of the agents that see it somewhere. */
  agents: string[];
}

export interface SkillsListing {
  locations: SkillLocation[];
  skills: SkillEntry[];
}

export interface SkillDetail extends SkillEntry {
  skillMd: string;
}

/** A skill packed to travel between machines. */
export interface SkillPayload {
  name: string;
  description?: string;
  files: Array<{ path: string; mode?: number; data: string }>;
  sizeBytes: number;
  digest: string;
}

export type SkillInstallStatus = 'installed' | 'exists' | 'same' | 'no_dir' | 'error';

export interface SkillInstallOutcome {
  agent: string;
  dir: string;
  status: SkillInstallStatus;
  error?: string;
}

/** One MCP server as one agent instance's own config states it. `config` is the server object
 * verbatim, so it can be shown, copied and reinstalled without knowing every agent's extras. */
export interface McpServer {
  name: string;
  config: Record<string, unknown>;
  sourcePath: string;
}

/** One agent instance's MCP servers, as the machine this client is for reads them. */
export interface McpAgentListing {
  agent: string;
  writable: boolean;
  servers: McpServer[];
  error?: string;
}

export interface McpListing {
  agents: McpAgentListing[];
}

export type McpInstallStatus = 'installed' | 'exists' | 'same' | 'error';

export interface McpInstallOutcome {
  agent: string;
  status: McpInstallStatus;
  error?: string;
}

/** The hub's own note about one server name: the business line and the purpose in words, plus the
 * config for servers registered on the page rather than found in any config file. */
export interface McpEntry {
  name: string;
  businessLine: string;
  description: string;
  server: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Another machine this hub shows: the same daemon over there, reached over SSH. */
export interface HostInfo {
  id: string;
  label: string;
  /** What ssh calls it. */
  target: string;
  status: 'connecting' | 'online' | 'offline';
  code?: HostFailure;
  /** The failure in ssh's own words. */
  error?: string;
  version?: string;
}

/** Where a path of the API is when another machine answers it: the same path, behind the hub's proxy. */
export function hostPath(host: string, path: string): string {
  return path.startsWith('/api/') ? `/api/hosts/${encodeURIComponent(host)}/proxy/${path.slice('/api/'.length)}` : path;
}

const TOKEN_KEY = 'rah.token';

/** Token lives in localStorage on this device only. Storage can be blocked, so every access is guarded. */
export function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  if (!token || token !== loadToken()) clearQuotaCache();
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: the token is kept in memory for this page only.
  }
}

export class AuthError extends Error {}

/** The server pings every 15 seconds; a stream silent for this long is dead, not quiet. */
const STREAM_IDLE_MS = 40_000;
/** Back in the foreground, a stream that has said nothing for this long is reconnected at once. */
const STREAM_WAKE_MS = 5_000;

export class Api {
  private readonly videoUploads = new WeakMap<File, Map<string, Promise<VideoRef>>>();
  private readonly quotas = new Map<string, PlanQuota>();
  private readonly quotaRequests = new Map<string, Promise<PlanQuota>>();

  /** True for the made-up workspace shown before the page is connected: nothing reaches a daemon. */
  readonly demo: boolean = false;

  constructor(
    private readonly token: string,
    private readonly base = '',
    /** Another machine's id: every call is then answered by that machine's daemon, through the hub. */
    readonly host: string | null = null,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // The language picked in the hub, not the browser's: what the daemon writes for people can follow it.
    return { Authorization: `Bearer ${this.token}`, 'Accept-Language': localeTag(), ...extra };
  }

  private url(path: string): string {
    return this.base + (this.host ? hostPath(this.host, path) : path);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send(method, this.url(path), body);
  }

  protected async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) throw new AuthError('unauthorized');
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError((json as { error?: string }).error ?? `HTTP ${res.status}`, json as Record<string, unknown>, res.status);
    return json as T;
  }

  // The machines themselves are the hub's own, whichever machine this client is for.

  hosts(): Promise<HostInfo[]> {
    return this.send('GET', `${this.base}/api/hosts`);
  }

  /** Aliases in the hub user's ssh config that are not machines yet. */
  hostCandidates(): Promise<string[]> {
    return this.send('GET', `${this.base}/api/hosts/candidates`);
  }

  /** Signs in to the machine once to find its daemon; refused with a `code` when that fails. */
  addHost(target: string, label?: string): Promise<HostInfo> {
    return this.send('POST', `${this.base}/api/hosts`, { target, label });
  }

  removeHost(id: string): Promise<void> {
    return this.send('DELETE', `${this.base}/api/hosts/${encodeURIComponent(id)}`);
  }

  /** Tries the machine again now, and says how that went. */
  reconnectHost(id: string): Promise<HostInfo> {
    return this.send('POST', `${this.base}/api/hosts/${encodeURIComponent(id)}/reconnect`);
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.request('GET', '/api/health');
  }

  agents(): Promise<AgentInfo[]> {
    return this.request('GET', '/api/agents');
  }

  workdirs(): Promise<WorkdirsConfig> {
    return this.request('GET', '/api/config');
  }

  /** Allows another directory as a project root, from the page. */
  addWorkdir(path: string): Promise<WorkdirsConfig> {
    return this.request('POST', '/api/workdirs', { path });
  }

  /** Takes back a root that was added from the page. */
  removeWorkdir(path: string): Promise<WorkdirsConfig> {
    return this.request('DELETE', `/api/workdirs?path=${encodeURIComponent(path)}`);
  }

  /** A new project folder in `parent`, a git repository with a first commit when `git` is set. */
  createProject(input: { parent: string; name: string; git: boolean }): Promise<{ path: string; git: boolean }> {
    return this.request('POST', '/api/projects', input);
  }

  threads(opts: { archived?: boolean } = {}): Promise<Thread[]> {
    return this.request('GET', `/api/threads${opts.archived ? '?archived=1' : ''}`);
  }

  sections(): Promise<Section[]> {
    return this.request('GET', '/api/sections');
  }

  createSection(name: string): Promise<Section> {
    return this.request('POST', '/api/sections', { name });
  }

  renameSection(id: string, name: string): Promise<Section> {
    return this.request('PATCH', `/api/sections/${id}`, { name });
  }

  deleteSection(id: string): Promise<void> {
    return this.request('DELETE', `/api/sections/${id}`);
  }

  todos(): Promise<Todo[]> {
    return this.request('GET', '/api/todos');
  }

  createTodo(text: string, parentId?: string | null): Promise<Todo> {
    return this.request('POST', '/api/todos', { text, parentId });
  }

  updateTodo(id: string, patch: { text?: string; done?: boolean }): Promise<Todo> {
    return this.request('PATCH', `/api/todos/${id}`, patch);
  }

  deleteTodo(id: string): Promise<void> {
    return this.request('DELETE', `/api/todos/${id}`);
  }

  /** Puts an item under `parentId` (null: top level), before the sibling `before` (null: last). */
  moveTodo(id: string, to: { parentId: string | null; before: string | null }): Promise<void> {
    return this.request('POST', `/api/todos/${id}/move`, to);
  }

  linkTodo(id: string, threadId: string): Promise<void> {
    return this.request('POST', `/api/todos/${id}/threads`, { threadId });
  }

  unlinkTodo(id: string, threadId: string): Promise<void> {
    return this.request('DELETE', `/api/todos/${id}/threads?threadId=${encodeURIComponent(threadId)}`);
  }

  schedules(): Promise<Schedule[]> {
    return this.request('GET', '/api/schedules');
  }

  createSchedule(input: {
    name?: string;
    agent: string;
    cwd: string;
    prompt: string;
    cron: string;
    mode: 'new' | 'same';
    threadId?: string | null;
    permissionMode?: string;
    enabled?: boolean;
    timezone?: string | null;
    catchUp?: boolean;
  }): Promise<Schedule> {
    return this.request('POST', '/api/schedules', input);
  }

  updateSchedule(id: string, patch: Record<string, unknown>): Promise<Schedule> {
    return this.request('PATCH', `/api/schedules/${id}`, patch);
  }

  deleteSchedule(id: string): Promise<void> {
    return this.request('DELETE', `/api/schedules/${id}`);
  }

  /** Fires now, whatever the clock says and whether the schedule is enabled. */
  runSchedule(id: string): Promise<{ status: string; message?: string }> {
    return this.request('POST', `/api/schedules/${id}/run`);
  }

  scheduleRuns(id: string): Promise<ScheduleRun[]> {
    return this.request('GET', `/api/schedules/${id}/runs`);
  }

  /** What a cron expression means: for the form's live preview. */
  previewCron(cron: string, timezone?: string | null): Promise<{ description: string; fires: string[] }> {
    return this.request('POST', '/api/schedules/preview', { cron, ...(timezone ? { timezone } : {}) });
  }

  thread(id: string): Promise<Thread> {
    return this.request('GET', `/api/threads/${id}`);
  }

  events(id: string, after = 0): Promise<StoredEvent[]> {
    return this.request('GET', `/api/threads/${id}/events?after=${after}`);
  }

  /** A thread's whole log, with streamed fragments merged: for copying the conversation out. */
  allEvents(id: string): Promise<StoredEvent[]> {
    return this.request('GET', `/api/threads/${id}/events?all=1`);
  }

  /**
   * The newest turns of a thread: what a reopened page renders before any history is paged in.
   * Pages begin where a turn begins, and streamed fragments come merged.
   */
  eventsTail(id: string): Promise<StoredEvent[]> {
    return this.request('GET', `/api/threads/${id}/events?tail=1`);
  }

  /** The page of turns just before the given sequence number. */
  eventsBefore(id: string, before: number): Promise<StoredEvent[]> {
    return this.request('GET', `/api/threads/${id}/events?before=${before}`);
  }

  createThread(input: {
    workMode?: WorkMode;
    speed?: string | null;
    agent: string;
    cwd: string;
    title?: string;
    permissionMode?: string;
    model?: string | null;
    effort?: string | null;
    sectionId?: string | null;
    /** Start in a new git worktree under the repository's `.worktrees/`. */
    worktree?: boolean;
    /** In no project: the hub gives the thread a scratch folder of its own; `cwd` is ignored. */
    scratch?: boolean;
  }): Promise<Thread> {
    return this.request('POST', '/api/threads', input);
  }

  /** Whether a new thread in this directory could start in a git worktree of its own. */
  worktreeOptions(cwd: string): Promise<ForkOptions['worktree']> {
    return this.request('GET', `/api/worktree-options?cwd=${encodeURIComponent(cwd)}`);
  }

  coordination(id: string): Promise<Coordination | null> { return this.request('GET', `/api/threads/${id}/coordination`); }
  /** Turns of any thread on this machine, archived ones too, in which the words were said. */
  search(query: string): Promise<SearchHit[]> {
    return this.request('GET', `/api/search?q=${encodeURIComponent(query)}`);
  }

  /** The daily digest of what was asked and what was called, newest day last. */
  activity(days = 14): Promise<ActivityReport> {
    return this.request('GET', `/api/activity?days=${days}`);
  }

  /** One turn of a thread as a trace; the last turn when none is named. */
  trace(threadId: string, turnId?: string): Promise<TurnTrace> {
    return this.request('GET', `/api/threads/${threadId}/trace${turnId ? `?turn=${encodeURIComponent(turnId)}` : ''}`);
  }

  /** The whole prompt a thread's conversation runs with, as the agent itself persisted it. */
  systemPrompt(threadId: string): Promise<SystemPrompt> {
    return this.request('GET', `/api/threads/${threadId}/system-prompt`);
  }

  configureCoordination(id: string, body: { action?: string; directories?: string[]; defaults?: Record<string, MemberDefault>; permission?: string }): Promise<Coordination> {
    return this.request('POST', `/api/threads/${id}/coordination`, body);
  }

  /** Sends a message. With `queue`, one sent while a turn is running waits for that turn to finish. */
  startTurn(
    threadId: string,
    text: string,
    images: OutgoingImage[] = [],
    opts: { queue?: boolean; mentions?: AgentMention[]; videos?: string[]; workMode?: WorkMode } = {},
  ): Promise<{ turnId: string } | { queued: true; id: string }> {
    return this.request('POST', `/api/threads/${threadId}/turns`, {
      text,
      ...(images.length ? { images } : {}),
      ...(opts.queue ? { queue: true } : {}),
      ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
      ...(opts.videos?.length ? { videos: opts.videos } : {}),
      ...(opts.workMode ? { workMode: opts.workMode } : {}),
    });
  }

  /** Takes a waiting message out of the queue; it comes back whole, so it can be edited. */
  removeQueued(threadId: string, queuedId: string): Promise<{ text: string; images: OutgoingImage[]; videos?: VideoRef[]; mentions?: AgentMention[] }> {
    return this.request('DELETE', `/api/threads/${threadId}/queue/${queuedId}`);
  }

  /** Binary upload, shared across retries of the same file in the same thread. */
  uploadVideo(threadId: string, file: File): Promise<VideoRef> {
    const uploads = this.videoUploads.get(file) ?? new Map<string, Promise<VideoRef>>();
    this.videoUploads.set(file, uploads);
    const existing = uploads.get(threadId);
    if (existing) return existing;
    const pending = (async () => {
      const res = await fetch(this.url(`/api/threads/${threadId}/videos`), { method: 'POST', headers: this.headers({ 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }), body: file });
      if (res.status === 401) throw new AuthError('unauthorized');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status === 404 ? t('api.noVideos') : json.error ?? `HTTP ${res.status}`, json, res.status);
      return json as VideoRef;
    })();
    uploads.set(threadId, pending);
    pending.catch(() => uploads.delete(threadId));
    return pending;
  }

  async videoFile(threadId: string, video: VideoRef): Promise<File> {
    const file = new File([await this.attachment(threadId, video.id)], video.name, { type: video.mimeType });
    this.videoUploads.set(file, new Map([[threadId, Promise.resolve(video)]]));
    return file;
  }

  /** Interrupts the running turn and sends this waiting message next. */
  sendQueuedNow(threadId: string, queuedId: string): Promise<void> {
    return this.request('POST', `/api/threads/${threadId}/queue/${queuedId}/now`);
  }

  /** An image file in the thread's directory that the agent made or mentioned. Rejects if there is none. */
  async threadFile(threadId: string, path: string): Promise<Blob> {
    const res = await fetch(this.url(`/api/threads/${threadId}/files?path=${encodeURIComponent(path)}`), { headers: this.headers() });
    if (res.status === 401) throw new AuthError('unauthorized');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  /** One folder of the thread's directory, for the file browser. No path: the directory itself. */
  threadTree(threadId: string, path?: string): Promise<FolderListing> {
    return this.request('GET', `/api/threads/${threadId}/tree${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  }

  /** A text file in the thread's directory. A binary one comes back with `text: null`. */
  threadText(threadId: string, path: string): Promise<TextFile> {
    return this.request('GET', `/api/threads/${threadId}/text?path=${encodeURIComponent(path)}`);
  }

  /** Files in the thread's directory whose path has every word of the query, relative to `root`. */
  findFiles(threadId: string, query: string): Promise<{ root: string; paths: string[]; truncated: boolean }> {
    return this.request('GET', `/api/threads/${threadId}/find?q=${encodeURIComponent(query)}`);
  }

  /** An image attached to a turn. Fetched with the token, since an <img> tag cannot send it. */
  async attachment(threadId: string, attachmentId: string): Promise<Blob> {
    const res = await fetch(this.url(`/api/threads/${threadId}/attachments/${attachmentId}`), { headers: this.headers() });
    if (res.status === 401) throw new AuthError('unauthorized');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  /** Stops the running turn. Messages that were waiting are not sent; their text comes back. */
  cancel(threadId: string): Promise<{ dropped: string[]; mentions?: AgentMention[] }> {
    return this.request('POST', `/api/threads/${threadId}/cancel`);
  }

  decide(approvalId: string, decision: { optionId: string } | { cancel: true }): Promise<void> {
    return this.request('POST', `/api/approvals/${approvalId}`, decision);
  }

  answerInput(id: string, answer: UserInputAnswer): Promise<void> {
    return this.request('POST', `/api/inputs/${id}`, answer);
  }

  updateThread(
    threadId: string,
    updates: {
      workMode?: WorkMode;
      speed?: string | null;
      title?: string;
      pinned?: boolean;
      permissionMode?: string;
      /** null returns the setting to the agent's default. */
      model?: string | null;
      effort?: string | null;
      archived?: boolean;
      /** null takes the thread out of its section. */
      sectionId?: string | null;
      unread?: boolean;
    },
  ): Promise<Thread> {
    return this.request('PATCH', `/api/threads/${threadId}`, updates);
  }

  /** Deletes for good. With `agentSession`, the agent's own copy of the conversation goes too. */
  /**
   * `worktree` removes the git worktree the thread runs in as well. Work that exists nowhere else
   * stops that with an ApiError whose details say how much (`code: 'worktree_dirty'`), until `force`.
   */
  deleteThread(threadId: string, opts: { agentSession?: boolean; worktree?: boolean; force?: boolean } = {}): Promise<void> {
    const query = [opts.agentSession && 'agentSession=1', opts.worktree && 'worktree=1', opts.force && 'force=1'].filter(Boolean).join('&');
    return this.request('DELETE', `/api/threads/${threadId}${query ? `?${query}` : ''}`);
  }

  /** Sessions the agent has in the allowed directories, newest first. */
  agentSessions(agent: string): Promise<AgentSession[]> {
    return this.request('GET', `/api/agents/${agent}/sessions`);
  }

  /** Makes a thread out of an existing agent session, history included. */
  importSession(agent: string, sessionId: string): Promise<Thread> {
    return this.request('POST', '/api/threads/import', { agent, sessionId });
  }

  /**
   * Copies a thread, on the agent's side too, into a new one that can go its own way. With a turn,
   * the copy ends where that turn ended.
   */
  /** With `turnId` the copy ends where that turn ended; with `worktree` it runs in a git worktree of its own. */
  forkThread(threadId: string, opts: { turnId?: string; worktree?: boolean } = {}): Promise<Thread> {
    const body = { ...(opts.turnId ? { turnId: opts.turnId } : {}), ...(opts.worktree ? { worktree: true } : {}) };
    return this.request('POST', `/api/threads/${threadId}/fork`, Object.keys(body).length ? body : undefined);
  }

  /** What forking this thread can offer besides a copy in the same directory. */
  forkOptions(threadId: string): Promise<ForkOptions> {
    return this.request('GET', `/api/threads/${threadId}/fork-options`);
  }

  /** Pulls in turns the terminal added to this thread's session. */
  syncThread(threadId: string): Promise<{ added: number; terminalActivity: boolean }> {
    return this.request('POST', `/api/threads/${threadId}/sync`);
  }

  /** A short-lived signed URL for one file of the thread's directory, for a preview iframe. */
  previewLink(threadId: string, path: string): Promise<{ url: string }> {
    return this.request('GET', `/api/threads/${threadId}/preview-link?path=${encodeURIComponent(path)}`);
  }

  /** Creates an empty successor in the same directory and worktree, without starting an agent turn. */
  createHandoverThread(threadId: string, agent: string): Promise<Thread> {
    return this.request('POST', `/api/threads/${threadId}/handover-thread`, { agent });
  }

  /** Asks the thread's agent to write a handover summary for another agent, in its own session. */
  startHandover(threadId: string, target: string): Promise<{ turnId: string }> {
    return this.request('POST', `/api/threads/${threadId}/handover`, { target });
  }

  /** The handover summary: `{ pending: true }` while the handover turn is still running. */
  handoverSummary(
    threadId: string,
    turn = '',
    target = '',
  ): Promise<{ pending: true } | { summary: string; source: 'agent' | 'log' }> {
    const q = `turn=${encodeURIComponent(turn)}&target=${encodeURIComponent(target)}`;
    return this.request('GET', `/api/threads/${threadId}/handover?${q}`);
  }

  /** CLIs on PATH that look like another copy of a known agent, offered for adding. */
  discoverAgents(): Promise<Array<{ id: string; adapter: string; command: string }>> {
    return this.request('GET', '/api/agents/discover');
  }

  /** Accounts of multi-account agents already signed in on this host, ready to link in one click. */
  discoverAccounts(): Promise<Array<{ adapter: string; email: string; env: Record<string, string>; id: string; label: string }>> {
    return this.request('GET', '/api/agents/accounts/discover');
  }

  /** Adds an agent instance (another CLI, another account). */
  addAgent(input: { id?: string; adapter: string; label?: string; command?: string[]; env?: Record<string, string>; account?: string }): Promise<{ id: string }> {
    return this.request('POST', '/api/agents', input);
  }

  /** Commands for an agent in a directory; project-level commands differ between directories. */
  commands(agent: string, cwd?: string): Promise<SlashCommand[]> {
    return this.request('GET', `/api/agents/${agent}/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
  }

  /** Plan usage of an agent instance, read outside any session. `refresh` asks again now. */
  usageReport(hours = 24, agent = ''): Promise<UsageReport> {
    return this.request('GET', `/api/usage?hours=${hours}&agent=${encodeURIComponent(agent)}`);
  }

  agentDiagnostic(agent: string, refresh = false): Promise<AgentDiagnostic> {
    return this.request('GET', `/api/agents/${encodeURIComponent(agent)}/diagnostics${refresh ? '?refresh=1' : ''}`);
  }

  /** A previous reading for immediate display, even after reopening the board or reloading the page. */
  cachedAgentQuota(agent: string): PlanQuota | null {
    return this.quotas.get(agent) ?? (loadToken() === this.token
      ? cachedQuota(this.url(`/api/agents/${encodeURIComponent(agent)}/quota`)) : null);
  }

  agentQuota(agent: string, refresh = false): Promise<PlanQuota> {
    const pending = this.quotaRequests.get(agent);
    if (pending) return pending;
    const path = `/api/agents/${encodeURIComponent(agent)}/quota`;
    const request = this.request<PlanQuota>('GET', `${path}${refresh ? '?refresh=1' : ''}`).then(quota => {
      this.quotas.set(agent, quota);
      // A request that finishes after sign-out must not repopulate the next login's cache.
      if (loadToken() === this.token) rememberQuota(this.url(path), quota);
      return quota;
    }).finally(() => this.quotaRequests.delete(agent));
    this.quotaRequests.set(agent, request);
    return request;
  }

  // Skills, in the folders the agents themselves read. Whichever machine this client is for
  // answers from its own folders; the skills page also opens one client per other machine.

  skills(): Promise<SkillsListing> {
    return this.request('GET', '/api/skills');
  }

  /** One skill and its SKILL.md, of the copy in `path` when that is given. */
  skillDetail(name: string, path?: string | null): Promise<SkillDetail> {
    const q = `name=${encodeURIComponent(name)}${path ? `&path=${encodeURIComponent(path)}` : ''}`;
    return this.request('GET', `/api/skills/detail?${q}`);
  }

  /** A skill packed to carry to another machine. */
  skillExport(name: string, path?: string | null): Promise<SkillPayload> {
    const q = `name=${encodeURIComponent(name)}${path ? `&path=${encodeURIComponent(path)}` : ''}`;
    return this.request('GET', `/api/skills/export?${q}`);
  }

  /** Copies a skill into agents' folders: from a folder on this machine, or from a payload. */
  skillInstall(body: {
    from?: { name: string; path: string };
    skill?: SkillPayload;
    targets: string[];
    overwrite?: boolean;
  }): Promise<SkillInstallOutcome[]> {
    return this.request('POST', '/api/skills/install', body);
  }

  /** Takes a skill out of one folder on this machine. */
  skillRemove(name: string, path: string): Promise<void> {
    return this.request('DELETE', `/api/skills?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`);
  }

  // MCP, in each agent's own config. Whichever machine this client is for scans its own agents;
  // entries (the notes and manual servers) live on the hub the page talks to.

  /** This machine's scan: every agent instance whose MCP config the daemon can read. */
  mcp(): Promise<McpListing> {
    return this.request('GET', '/api/mcp');
  }

  /** Writes one server into each listed instance's config on this machine. */
  mcpInstall(body: { targets: string[]; name: string; config: Record<string, unknown>; overwrite?: boolean }): Promise<McpInstallOutcome[]> {
    return this.request('POST', '/api/mcp/install', body);
  }

  /** Takes one server out of one instance's config on this machine. */
  mcpRemove(agent: string, name: string): Promise<void> {
    return this.request('DELETE', `/api/mcp?agent=${encodeURIComponent(agent)}&name=${encodeURIComponent(name)}`);
  }

  /** The registry of notes and manually registered servers, on this daemon. */
  mcpEntries(): Promise<McpEntry[]> {
    return this.request('GET', '/api/mcp/entries');
  }

  mcpSaveEntry(body: { name: string; businessLine?: string; description?: string; server?: Record<string, unknown> | null }): Promise<McpEntry> {
    return this.request('PUT', '/api/mcp/entries', body);
  }

  mcpDeleteEntry(name: string): Promise<void> {
    return this.request('DELETE', `/api/mcp/entries/${encodeURIComponent(name)}`);
  }

  /** Live web terminals on this daemon. */
  listTerminals(): Promise<TerminalInfo[]> {
    return this.request('GET', '/api/terminals');
  }

  /** Starts a terminal in `cwd`, which must be one of the allowed workdirs. */
  createTerminal(cwd: string): Promise<TerminalInfo> {
    return this.request('POST', '/api/terminals', { cwd });
  }

  /** Sends keystrokes (or a paste) to a terminal. */
  terminalInput(id: string, data: string): Promise<void> {
    return this.request('POST', `/api/terminals/${id}/input`, { data });
  }

  terminalSize(id: string, cols: number, rows: number): Promise<void> {
    return this.request('POST', `/api/terminals/${id}/size`, { cols, rows });
  }

  /** Ends a terminal. Closing its panel does not; the shell is exited by typing, or reaped when idle. */
  killTerminal(id: string): Promise<void> {
    return this.request('DELETE', `/api/terminals/${id}`);
  }

  models(agent: string): Promise<ModelOption[]> {
    return this.request('GET', `/api/agents/${agent}/models`);
  }

  listDirectory(path: string): Promise<DirectoryInfo> {
    const encoded = encodeURIComponent(path);
    return this.request('GET', `/api/directories?path=${encoded}`);
  }

  projectDirectories(path?: string): Promise<ProjectDirectoryInfo> {
    return this.request('GET', `/api/project-directories${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  }

  directoryTree(root: string, maxDepth = 3): Promise<DirectoryTreeNode> {
    const encoded = encodeURIComponent(root);
    return this.request('GET', `/api/directory-tree?root=${encoded}&maxDepth=${maxDepth}`);
  }

  /**
   * Opens an SSE stream and calls `onEvent` for each message. Resolves when the server closes the stream.
   * The caller aborts via `signal`. Uses fetch (not EventSource) so the Authorization header can be sent.
   */
  /**
   * Reads a server-sent event stream until it ends, and returns so the caller can reconnect. A
   * stream can also die without ending: a phone that slept or changed network leaves a read that
   * never resolves. The server writes at least a ping every 15 seconds, so a stream silent for
   * `idleMs` is taken for dead; and when the page comes back to the foreground, one that has been
   * silent for a few seconds is not waited on at all.
   */
  async stream<T = StoredEvent>(path: string, onEvent: (ev: T) => void, signal: AbortSignal, idleMs = STREAM_IDLE_MS): Promise<void> {
    const res = await fetch(this.url(path), { headers: this.headers({ Accept: 'text/event-stream' }), signal });
    if (res.status === 401) throw new AuthError('unauthorized');
    if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let heardAt = Date.now();
    const giveUp = () => void reader.cancel().catch(() => undefined);
    let idle = setTimeout(giveUp, idleMs);
    const onVisible = () => {
      if (!document.hidden && Date.now() - heardAt > STREAM_WAKE_MS) giveUp();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        heardAt = Date.now();
        clearTimeout(idle);
        idle = setTimeout(giveUp, idleMs);
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data) onEvent(JSON.parse(data) as T);
        }
      }
    } finally {
      clearTimeout(idle);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    }
  }
}
