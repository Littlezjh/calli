import type { StoredEvent } from './timeline';

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

export interface Thread {
  id: string;
  agent: string;
  cwd: string;
  title: string;
  agentSessionId: string | null;
  status: 'idle' | 'running' | 'error';
  pinned: boolean;
  permissionMode: string;
  model: string | null;
  effort: string | null;
  archivedAt: string | null;
  sectionId: string | null;
  /** The thread this one was forked from, if it is a fork. */
  forkedFrom: string | null;
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
  /** The terminal wrote to this session since the hub last did. */
  terminalActivity: boolean;
  /** The agent has stopped to ask for approval. */
  waiting: boolean;
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
}

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
  /** False when the model cannot read images. */
  images?: boolean;
  /** How images reach a model that cannot read them, such as a tool that hands them to a vision model. */
  imagesVia?: string;
  /** The model the agent uses when the thread does not pick one. */
  isDefault?: boolean;
}

export interface AgentInfo {
  id: string;
  label: string;
  /** The agent's mark: the path of a 24×24 drawing, filled with the even-odd rule. Missing from daemons that predate it. */
  icon?: string;
  available: boolean;
  capabilities: {
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
    fork: boolean;
    /** A fork can end at an earlier turn instead of taking the whole thread. Missing from daemons that predate it. */
    forkAt?: boolean;
    /** A fork can run in a git worktree of its own. Missing from daemons that predate it. */
    forkInto?: boolean;
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
}

/** Plan usage of an agent instance, read outside any session. */
export interface PlanQuota {
  windows: QuotaWindow[];
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
  constructor(
    private readonly token: string,
    private readonly base = '',
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
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

  /** Sends a message. With `queue`, one sent while a turn is running waits for that turn to finish. */
  startTurn(
    threadId: string,
    text: string,
    images: OutgoingImage[] = [],
    opts: { queue?: boolean } = {},
  ): Promise<{ turnId: string } | { queued: true; id: string }> {
    return this.request('POST', `/api/threads/${threadId}/turns`, {
      text,
      ...(images.length ? { images } : {}),
      ...(opts.queue ? { queue: true } : {}),
    });
  }

  /** Takes a waiting message out of the queue; it comes back whole, so it can be edited. */
  removeQueued(threadId: string, queuedId: string): Promise<{ text: string; images: OutgoingImage[] }> {
    return this.request('DELETE', `/api/threads/${threadId}/queue/${queuedId}`);
  }

  /** Interrupts the running turn and sends this waiting message next. */
  sendQueuedNow(threadId: string, queuedId: string): Promise<void> {
    return this.request('POST', `/api/threads/${threadId}/queue/${queuedId}/now`);
  }

  /** An image file in the thread's directory that the agent made or mentioned. Rejects if there is none. */
  async threadFile(threadId: string, path: string): Promise<Blob> {
    const res = await fetch(`${this.base}/api/threads/${threadId}/files?path=${encodeURIComponent(path)}`, { headers: this.headers() });
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
    const res = await fetch(`${this.base}/api/threads/${threadId}/attachments/${attachmentId}`, { headers: this.headers() });
    if (res.status === 401) throw new AuthError('unauthorized');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  /** Stops the running turn. Messages that were waiting are not sent; their text comes back. */
  cancel(threadId: string): Promise<{ dropped: string[] }> {
    return this.request('POST', `/api/threads/${threadId}/cancel`);
  }

  decide(approvalId: string, decision: { optionId: string } | { cancel: true }): Promise<void> {
    return this.request('POST', `/api/approvals/${approvalId}`, decision);
  }

  updateThread(
    threadId: string,
    updates: {
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

  /** Asks the thread's agent to write a handover summary for another agent, in its own session. */
  startHandover(threadId: string, target: string): Promise<{ turnId: string }> {
    return this.request('POST', `/api/threads/${threadId}/handover`, { target });
  }

  /** The handover summary: `{ pending: true }` while the handover turn is still running. */
  handoverSummary(
    threadId: string,
    turn: string,
    target: string,
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
  addAgent(input: { id?: string; adapter: string; label?: string; command?: string[]; env?: Record<string, string> }): Promise<{ id: string }> {
    return this.request('POST', '/api/agents', input);
  }

  /** Commands for an agent in a directory; project-level commands differ between directories. */
  commands(agent: string, cwd?: string): Promise<SlashCommand[]> {
    return this.request('GET', `/api/agents/${agent}/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
  }

  /** Plan usage of an agent instance, read outside any session. */
  agentQuota(agent: string): Promise<PlanQuota> {
    return this.request('GET', `/api/agents/${agent}/quota`);
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
    const res = await fetch(this.base + path, { headers: this.headers({ Accept: 'text/event-stream' }), signal });
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
