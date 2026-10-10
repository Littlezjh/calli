import type { StoredEvent } from './timeline';

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
  /** A turn finished and nobody has looked at the result yet. */
  unread: boolean;
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
  available: boolean;
  capabilities: {
    resume: boolean;
    approvals: boolean;
    permissionModes: string[];
    effortLevels: string[];
    images: boolean;
    deleteSession: boolean;
    /** Can list its past sessions and replay them, so they can be imported. */
    history: boolean;
    fork: boolean;
  };
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
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    return json as T;
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.request('GET', '/api/health');
  }

  agents(): Promise<AgentInfo[]> {
    return this.request('GET', '/api/agents');
  }

  workdirs(): Promise<{ workdirs: string[] }> {
    return this.request('GET', '/api/config');
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

  thread(id: string): Promise<Thread> {
    return this.request('GET', `/api/threads/${id}`);
  }

  events(id: string, after = 0): Promise<StoredEvent[]> {
    return this.request('GET', `/api/threads/${id}/events?after=${after}`);
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
  }): Promise<Thread> {
    return this.request('POST', '/api/threads', input);
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

  removeQueued(threadId: string, queuedId: string): Promise<void> {
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
  deleteThread(threadId: string, opts: { agentSession?: boolean } = {}): Promise<void> {
    return this.request('DELETE', `/api/threads/${threadId}${opts.agentSession ? '?agentSession=1' : ''}`);
  }

  /** Sessions the agent has in the allowed directories, newest first. */
  agentSessions(agent: string): Promise<AgentSession[]> {
    return this.request('GET', `/api/agents/${agent}/sessions`);
  }

  /** Makes a thread out of an existing agent session, history included. */
  importSession(agent: string, sessionId: string): Promise<Thread> {
    return this.request('POST', '/api/threads/import', { agent, sessionId });
  }

  /** Copies a thread, on the agent's side too, into a new one that can go its own way. */
  forkThread(threadId: string): Promise<Thread> {
    return this.request('POST', `/api/threads/${threadId}/fork`);
  }

  /** Pulls in turns the terminal added to this thread's session. */
  syncThread(threadId: string): Promise<{ added: number; terminalActivity: boolean }> {
    return this.request('POST', `/api/threads/${threadId}/sync`);
  }

  /** CLIs on PATH that look like another copy of a known agent, offered for adding. */
  discoverAgents(): Promise<Array<{ id: string; adapter: string; command: string }>> {
    return this.request('GET', '/api/agents/discover');
  }

  /** Adds an agent instance (another CLI, another account). */
  addAgent(input: { id?: string; adapter: string; label?: string; command?: string[]; env?: Record<string, string> }): Promise<{ id: string }> {
    return this.request('POST', '/api/agents', input);
  }

  /** Commands for an agent in a directory; project-level commands differ between directories. */
  commands(agent: string, cwd?: string): Promise<SlashCommand[]> {
    return this.request('GET', `/api/agents/${agent}/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
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
  async stream(path: string, onEvent: (ev: StoredEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(this.base + path, { headers: this.headers({ Accept: 'text/event-stream' }), signal });
    if (res.status === 401) throw new AuthError('unauthorized');
    if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
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
        if (data) onEvent(JSON.parse(data) as StoredEvent);
      }
    }
  }
}
