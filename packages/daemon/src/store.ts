import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventType, StoredEvent } from './events.js';
import { askedText } from './util.js';

export interface ThreadRecord {
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
  /** Set when the thread is archived: hidden from the sidebar, kept on disk, restorable. */
  archivedAt: string | null;
  /** The user-made section this thread is filed under, if any. */
  sectionId: string | null;
  /** The thread this one was forked from. Kept even if that thread is later deleted. */
  forkedFrom: string | null;
  handover?: { sourceId: string; title: string; agent: string } | null;
  /** Set when the thread runs in a git worktree the hub made for it, or shares one with the thread it was forked from. */
  worktree: ThreadWorktree | null;
  /** A turn finished and nobody has looked at the result yet. */
  unread: boolean;
  /** When the hub last started a turn here. Compared with `externalAt` for the terminal warning. */
  hubTurnAt: string | null;
  /** When syncing last found turns the terminal added to this session. */
  externalAt: string | null;
  /** The newest thing the user asked, kept as the sidebar's second line. Null until the first ask. */
  preview: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A git worktree a thread stands in. See worktrees.ts. */
export interface ThreadWorktree {
  /** The root of the checkout. The thread's `cwd` is this, or a directory inside it. */
  root: string;
  branch: string;
  /** The directory the thread would be in without the worktree: the one it is listed under. */
  of: string;
}

export interface SectionRecord {
  id: string;
  name: string;
  position: number;
}

/** One entry on the plan page. `parentId` is only ever a top-level todo: one level of nesting. */
export interface TodoRecord {
  id: string;
  text: string;
  done: boolean;
  parentId: string | null;
  position: number;
  createdAt: string;
  doneAt: string | null;
}

interface TodoRow {
  id: string;
  text: string;
  done: number;
  parent_id: string | null;
  position: number;
  created_at: string;
  done_at: string | null;
}

const toTodo = (r: TodoRow): TodoRecord => ({
  id: r.id,
  text: r.text,
  done: r.done === 1,
  parentId: r.parent_id,
  position: r.position,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

interface ThreadRow {
  id: string;
  agent: string;
  cwd: string;
  title: string;
  agent_session_id: string | null;
  status: string;
  pinned: number;
  permission_mode: string;
  model: string | null;
  effort: string | null;
  archived_at: string | null;
  section_id: string | null;
  forked_from: string | null;
  handover: string | null;
  worktree: string | null;
  unread: number;
  hub_turn_at: string | null;
  external_at: string | null;
  preview: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  thread_id: string;
  seq: number;
  turn_id: string | null;
  type: string;
  ts: string;
  data: string;
}

const toThread = (r: ThreadRow): ThreadRecord => ({
  id: r.id,
  agent: r.agent,
  cwd: r.cwd,
  title: r.title,
  agentSessionId: r.agent_session_id,
  status: r.status as ThreadRecord['status'],
  pinned: r.pinned === 1,
  permissionMode: r.permission_mode,
  model: r.model,
  effort: r.effort,
  archivedAt: r.archived_at,
  sectionId: r.section_id,
  forkedFrom: r.forked_from,
  handover: r.handover ? JSON.parse(r.handover) : null,
  worktree: r.worktree ? (JSON.parse(r.worktree) as ThreadWorktree) : null,
  unread: r.unread === 1,
  hubTurnAt: r.hub_turn_at,
  externalAt: r.external_at,
  preview: r.preview,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEvent = (r: EventRow): StoredEvent => ({
  threadId: r.thread_id,
  seq: r.seq,
  turnId: r.turn_id,
  type: r.type as EventType,
  ts: r.ts,
  data: JSON.parse(r.data) as Record<string, unknown>,
});

/** SQLite-backed store for threads and their event logs. Uses node:sqlite (no native build). */
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

/** The stretch of a text around the first word found in it, on one line. */
function snippetAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, at - 28);
  const end = Math.min(text.length, at + 110);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'hub.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        agent_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        permission_mode TEXT NOT NULL DEFAULT 'auto_edit',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        turn_id TEXT,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (thread_id, seq)
      );
    `);
    // Migration: add pinned column if it doesn't exist
    try {
      this.db.prepare('ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0').run();
    } catch {
      // Column already exists
    }
    // Migration: threads created before permission modes existed get the default level.
    const cols = this.db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'permission_mode')) {
      this.db.exec("ALTER TABLE threads ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto_edit'");
    }
    // Migration: model and thinking effort. NULL means the agent's default.
    if (!cols.some((c) => c.name === 'model')) this.db.exec('ALTER TABLE threads ADD COLUMN model TEXT');
    if (!cols.some((c) => c.name === 'effort')) this.db.exec('ALTER TABLE threads ADD COLUMN effort TEXT');
    // Migration: archive and sections.
    if (!cols.some((c) => c.name === 'archived_at')) this.db.exec('ALTER TABLE threads ADD COLUMN archived_at TEXT');
    if (!cols.some((c) => c.name === 'section_id')) this.db.exec('ALTER TABLE threads ADD COLUMN section_id TEXT');
    // Migration: terminal-activity tracking (turns the terminal added, hub turns).
    if (!cols.some((c) => c.name === 'hub_turn_at')) this.db.exec('ALTER TABLE threads ADD COLUMN hub_turn_at TEXT');
    if (!cols.some((c) => c.name === 'external_at')) this.db.exec('ALTER TABLE threads ADD COLUMN external_at TEXT');
    // Migration: the sidebar's preview line, the newest thing the user asked.
    if (!cols.some((c) => c.name === 'preview')) this.db.exec('ALTER TABLE threads ADD COLUMN preview TEXT');
    // Migration: forks.
    if (!cols.some((c) => c.name === 'handover')) this.db.exec('ALTER TABLE threads ADD COLUMN handover TEXT');
    if (!cols.some((c) => c.name === 'forked_from')) this.db.exec('ALTER TABLE threads ADD COLUMN forked_from TEXT');
    // Migration: the git worktree a forked thread stands in, as JSON.
    if (!cols.some((c) => c.name === 'worktree')) this.db.exec('ALTER TABLE threads ADD COLUMN worktree TEXT');
    // Migration: unread marker.
    if (!cols.some((c) => c.name === 'unread')) this.db.exec('ALTER TABLE threads ADD COLUMN unread INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Ensure index exists for sorting
    try {
      this.db.exec('CREATE INDEX idx_threads_pinned_updated ON threads(pinned DESC, updated_at DESC)');
    } catch {
      // Index already exists
    }
    // The plan page: long-lived items the user ticks off, optionally linked to threads.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT REFERENCES todos(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        done_at TEXT
      );
      CREATE TABLE IF NOT EXISTS todo_threads (
        todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        PRIMARY KEY (todo_id, thread_id)
      );
    `);
    if (!cols.some((c) => c.name === 'handover')) this.recoverHandovers();
    // What was said in each turn, whole: the user's words and the agent's. An answer is stored as
    // it streamed, a few characters an event, so nothing can be found in the log itself.
    const indexed = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_text'").get();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turn_text (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        ts TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (thread_id, turn_id, role)
      );
    `);
    if (!indexed) this.indexText();
  }

  /** Where each open turn began, so its answer is read from there and not from the thread's start. */
  private readonly turnStarts = new Map<string, number>();

  private saveText(threadId: string, turnId: string, role: 'user' | 'assistant', ts: string, text: string): void {
    if (!text.trim()) return;
    this.db
      .prepare('INSERT INTO turn_text (thread_id, turn_id, role, ts, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id, turn_id, role) DO UPDATE SET ts = excluded.ts, text = excluded.text')
      .run(threadId, turnId, role, ts, text);
  }

  /**
   * Reads turns out of the log into the searchable text: all of them, one thread's, or one turn
   * from a sequence number on. Turns the hub started itself (a handover, a teammate's message)
   * are not the user's words and are left out; what the agent answered is kept either way.
   */
  indexText(threadId?: string, turnId?: string, afterSeq = 0): void {
    const rows = this.db
      .prepare(`SELECT thread_id, turn_id, type, ts, data FROM events
        WHERE type IN ('turn.started', 'message.delta') AND turn_id IS NOT NULL AND seq > ?
        ${threadId ? 'AND thread_id = ?' : ''} ${turnId ? 'AND turn_id = ?' : ''} ORDER BY thread_id, seq`)
      .iterate(...[afterSeq, ...(threadId ? [threadId] : []), ...(turnId ? [turnId] : [])]) as Iterable<{ thread_id: string; turn_id: string; type: string; ts: string; data: string }>;
    const said = new Map<string, { threadId: string; turnId: string; ts: string; text: string }>();
    const flush = () => { for (const a of said.values()) this.saveText(a.threadId, a.turnId, 'assistant', a.ts, a.text); said.clear(); };
    let current = '';
    for (const row of rows) {
      if (row.thread_id !== current) { flush(); current = row.thread_id; }
      const data = JSON.parse(row.data) as Record<string, unknown>;
      if (row.type === 'turn.started') {
        const text = typeof data.displayText === 'string' ? data.displayText : data.text;
        if (typeof text === 'string' && !data.handover && !data.coordination) this.saveText(row.thread_id, row.turn_id, 'user', row.ts, text);
        continue;
      }
      const answer = said.get(row.turn_id) ?? { threadId: row.thread_id, turnId: row.turn_id, ts: row.ts, text: '' };
      answer.text += typeof data.text === 'string' ? data.text : '';
      said.set(row.turn_id, answer);
    }
    flush();
  }

  /**
   * Turns in which every word of the query was said, newest first: at most three a thread, so one
   * long thread does not crowd out the rest. Words are matched as they are written, anywhere in
   * the text, which is what works for Chinese; case is ignored for Latin letters.
   */
  searchText(query: string, limit = 40): SearchHit[] {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 6);
    if (terms.join('').length < 2) return [];
    const rows = this.db
      .prepare(`SELECT tt.thread_id, tt.turn_id, tt.role, tt.ts, tt.text, t.title, t.agent, t.cwd, t.archived_at
        FROM turn_text tt JOIN threads t ON t.id = tt.thread_id
        WHERE ${terms.map(() => 'instr(lower(tt.text), ?) > 0').join(' AND ')} ORDER BY tt.ts DESC LIMIT 600`)
      .all(...terms) as Array<{ thread_id: string; turn_id: string; role: string; ts: string; text: string; title: string; agent: string; cwd: string; archived_at: string | null }>;
    const perThread = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const seen = perThread.get(row.thread_id) ?? 0;
      if (seen >= 3) continue;
      perThread.set(row.thread_id, seen + 1);
      hits.push({ threadId: row.thread_id, turnId: row.turn_id, role: row.role === 'user' ? 'user' : 'assistant', ts: row.ts,
        snippet: snippetAround(row.text, terms), title: row.title, agent: row.agent, cwd: row.cwd, archived: row.archived_at !== null });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Recover only the hub's explicit local handover envelope, never title similarity. */
  private recoverHandovers(): void {
    const candidates = this.db.prepare(`SELECT t.id, t.cwd, t.created_at,
      (SELECT e.data FROM events e WHERE e.thread_id = t.id AND e.type = 'turn.started' ORDER BY e.seq LIMIT 1) AS first_turn
      FROM threads t WHERE t.handover IS NULL AND t.forked_from IS NULL`).all() as Array<{ id: string; cwd: string; created_at: string; first_turn: string | null }>;
    for (const candidate of candidates) {
      if (!candidate.first_turn) continue;
      let text: unknown;
      try { text = (JSON.parse(candidate.first_turn) as { text?: unknown }).text; } catch { continue; }
      if (typeof text !== 'string') continue;
      const envelope = text.match(/^(?:来源机器：本机（当前 hub）\s+)?# 交接信息\r?\n([\s\S]*?)\r?\n## 接手要求(?:\r?\n|$)/);
      if (!envelope) continue;
      const ids = [...envelope[1].matchAll(/^- Hub 线程 ID：([^\r\n]+)$/gm)];
      if (ids.length !== 1) continue;
      const source = this.getThread(ids[0][1].trim());
      if (!source || source.id === candidate.id || source.cwd !== candidate.cwd || source.createdAt >= candidate.created_at) continue;
      this.db.prepare('UPDATE threads SET handover = ? WHERE id = ?').run(JSON.stringify({ sourceId: source.id, title: source.title, agent: source.agent }), candidate.id);
    }
  }

  coordinationRecords(): Array<{ id: string; data: string }> {
    this.db.exec('CREATE TABLE IF NOT EXISTS coordination (id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, data TEXT NOT NULL)');
    return this.db.prepare('SELECT id, data FROM coordination').all() as Array<{ id: string; data: string }>;
  }

  saveCoordination(id: string, data: string): void {
    this.db.prepare('INSERT INTO coordination (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(id, data);
  }

  close(): void {
    this.db.close();
  }

  createThread(
    t: Omit<
      ThreadRecord,
      | 'status'
      | 'createdAt'
      | 'updatedAt'
      | 'agentSessionId'
      | 'pinned'
      | 'archivedAt'
      | 'sectionId'
      | 'forkedFrom'
      | 'worktree'
      | 'unread'
      | 'hubTurnAt'
      | 'externalAt'
      | 'preview'
    > & {
      forkedFrom?: string | null;
      worktree?: ThreadWorktree | null;
      sectionId?: string | null;
    },
  ): ThreadRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO threads (id, agent, cwd, title, status, pinned, permission_mode, model, effort, forked_from, worktree, section_id, created_at, updated_at, handover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        t.id,
        t.agent,
        t.cwd,
        t.title,
        'idle',
        0,
        t.permissionMode,
        t.model,
        t.effort,
        t.forkedFrom ?? null,
        t.worktree ? JSON.stringify(t.worktree) : null,
        t.sectionId ?? null,
        now,
        now,
        t.handover ? JSON.stringify(t.handover) : null,
      );
    return this.getThread(t.id)!;
  }

  getThread(id: string): ThreadRecord | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  /** The thread tied to an agent-side session, archived or not. Used to avoid importing one twice. */
  findThreadByAgentSession(agent: string, agentSessionId: string): ThreadRecord | null {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE agent = ? AND agent_session_id = ? LIMIT 1')
      .get(agent, agentSessionId) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  /** Copies a thread's whole event log to another thread, keeping order and timestamps. */
  copyEvents(fromThreadId: string, toThreadId: string, upToSeq = Number.MAX_SAFE_INTEGER): void {
    this.db
      .prepare(
        'INSERT INTO events (thread_id, seq, turn_id, type, ts, data) SELECT ?, seq, turn_id, type, ts, data FROM events WHERE thread_id = ? AND seq <= ?',
      )
      .run(toThreadId, fromThreadId, upToSeq);
    this.indexText(toThreadId);
  }

  /** Runs several writes as one: all of them happen, or none. Also much faster for bulk inserts. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Removes a thread and, through the foreign key, its event log. */
  deleteThread(id: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  /** Active threads by default; pass `archived: true` for the archive instead. */
  listThreads(opts: { archived?: boolean } = {}): ThreadRecord[] {
    const where = opts.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL';
    const order = opts.archived ? 'archived_at DESC' : 'pinned DESC, updated_at DESC';
    const rows = this.db.prepare(`SELECT * FROM threads WHERE ${where} ORDER BY ${order}`).all() as unknown as ThreadRow[];
    return rows.map(toThread);
  }

  updateThread(
    id: string,
    patch: Partial<
      Pick<
        ThreadRecord,
        | 'title'
        | 'status'
        | 'agentSessionId'
        | 'pinned'
        | 'permissionMode'
        | 'model'
        | 'effort'
        | 'archivedAt'
        | 'sectionId'
        | 'unread'
        | 'preview'
        | 'hubTurnAt'
        | 'externalAt'
      >
    >,
    /**
     * `touch` moves the thread to the top of "recent". Only conversation activity should do that;
     * renaming, pinning, filing or changing a setting must not reorder the list.
     */
    opts: { touch?: boolean } = {},
  ): void {
    const current = this.getThread(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: opts.touch ? new Date().toISOString() : current.updatedAt };
    this.db
      .prepare(
        'UPDATE threads SET title = ?, status = ?, agent_session_id = ?, pinned = ?, permission_mode = ?, model = ?, effort = ?, archived_at = ?, section_id = ?, unread = ?, preview = ?, hub_turn_at = ?, external_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.title,
        next.status,
        next.agentSessionId,
        next.pinned ? 1 : 0,
        next.permissionMode,
        next.model,
        next.effort,
        next.archivedAt,
        next.sectionId,
        next.unread ? 1 : 0,
        next.preview,
        next.hubTurnAt,
        next.externalAt,
        next.updatedAt,
        id,
      );
  }

  listSections(): SectionRecord[] {
    return this.db.prepare('SELECT id, name, position FROM sections ORDER BY position ASC').all() as unknown as SectionRecord[];
  }

  getSection(id: string): SectionRecord | null {
    const row = this.db.prepare('SELECT id, name, position FROM sections WHERE id = ?').get(id) as SectionRecord | undefined;
    return row ?? null;
  }

  /** New sections go to the end. */
  createSection(id: string, name: string): SectionRecord {
    const row = this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM sections').get() as { next: number };
    this.db
      .prepare('INSERT INTO sections (id, name, position, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, row.next, new Date().toISOString());
    return { id, name, position: row.next };
  }

  renameSection(id: string, name: string): void {
    this.db.prepare('UPDATE sections SET name = ? WHERE id = ?').run(name, id);
  }

  /** Removes the section. Its threads are kept and go back to being listed under their project. */
  deleteSection(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE threads SET section_id = NULL WHERE section_id = ?').run(id);
      this.db.prepare('DELETE FROM sections WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- Plan page (todos) ----------

  listTodos(): TodoRecord[] {
    return (this.db.prepare('SELECT * FROM todos ORDER BY position ASC, created_at ASC').all() as unknown as TodoRow[]).map(toTodo);
  }

  getTodo(id: string): TodoRecord | null {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow | undefined;
    return row ? toTodo(row) : null;
  }

  /** New items go to the end of their level: top level, or after their siblings under a parent. */
  createTodo(id: string, text: string, parentId: string | null): TodoRecord {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM todos WHERE parent_id IS ?')
      .get(parentId) as { next: number };
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO todos (id, text, done, parent_id, position, created_at) VALUES (?, ?, 0, ?, ?, ?)')
      .run(id, text, parentId, row.next, now);
    return { id, text, done: false, parentId, position: row.next, createdAt: now, doneAt: null };
  }

  /** Text edits keep the item where it is; toggling done stamps `done_at` (or clears it). */
  updateTodo(id: string, patch: { text?: string; done?: boolean }): TodoRecord {
    const current = this.getTodo(id);
    if (!current) throw new Error('todo not found');
    const text = patch.text !== undefined ? patch.text : current.text;
    const done = patch.done !== undefined ? patch.done : current.done;
    const doneAt = patch.done === undefined ? current.doneAt : done ? new Date().toISOString() : null;
    this.db.prepare('UPDATE todos SET text = ?, done = ?, done_at = ? WHERE id = ?').run(text, done ? 1 : 0, doneAt, id);
    return { ...current, text, done, doneAt };
  }

  deleteTodo(id: string): void {
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  }

  /**
   * Puts an item under `parentId` (null: top level), just before the sibling `beforeId`, or last
   * when that is null. The new level is renumbered from 1, so positions stay small and unique.
   */
  moveTodo(id: string, parentId: string | null, beforeId: string | null): void {
    this.transaction(() => {
      const siblings = (
        this.db
          .prepare('SELECT id FROM todos WHERE parent_id IS ? AND id != ? ORDER BY position ASC, created_at ASC')
          .all(parentId, id) as Array<{ id: string }>
      ).map((r) => r.id);
      const at = beforeId === null ? -1 : siblings.indexOf(beforeId);
      siblings.splice(at === -1 ? siblings.length : at, 0, id);
      this.db.prepare('UPDATE todos SET parent_id = ? WHERE id = ?').run(parentId, id);
      const place = this.db.prepare('UPDATE todos SET position = ? WHERE id = ?');
      siblings.forEach((sibling, i) => place.run(i + 1, sibling));
    });
  }

  todoThreadIds(todoId: string): string[] {
    const rows = this.db.prepare('SELECT thread_id FROM todo_threads WHERE todo_id = ?').all(todoId) as Array<{ thread_id: string }>;
    return rows.map((r) => r.thread_id);
  }

  linkTodoThread(todoId: string, threadId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO todo_threads (todo_id, thread_id) VALUES (?, ?)').run(todoId, threadId);
  }

  unlinkTodoThread(todoId: string, threadId: string): void {
    this.db.prepare('DELETE FROM todo_threads WHERE todo_id = ? AND thread_id = ?').run(todoId, threadId);
  }

  appendEvent(threadId: string, turnId: string | null, type: EventType, data: Record<string, unknown>): StoredEvent {
    const ts = new Date().toISOString();
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE thread_id = ?')
      .get(threadId) as { next: number };
    const seq = row.next;
    this.db
      .prepare('INSERT INTO events (thread_id, seq, turn_id, type, ts, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(threadId, seq, turnId, type, ts, JSON.stringify(data));
    if (turnId && type === 'turn.started') {
      this.turnStarts.set(turnId, seq);
      const text = typeof data.displayText === 'string' ? data.displayText : data.text;
      if (typeof text === 'string' && !data.handover && !data.coordination) this.saveText(threadId, turnId, 'user', ts, text);
    } else if (turnId && (type === 'turn.done' || type === 'turn.error')) {
      // Without the start (the daemon was restarted mid-turn) the whole thread is read for it.
      this.indexText(threadId, turnId, (this.turnStarts.get(turnId) ?? 1) - 1);
      this.turnStarts.delete(turnId);
    }
    // The sidebar's preview line is the newest ask, whatever wrote it — a live turn, an import, a
    // sync from the terminal. Hub-injected handover turns are not the user asking.
    if (type === 'turn.started' && typeof data.text === 'string' && data.text.trim() && !data.handover && !data.coordination) {
      this.db.prepare('UPDATE threads SET preview = ? WHERE id = ?').run(askedText(typeof data.displayText === 'string' ? data.displayText : data.text).slice(0, 80), threadId);
    }
    return { threadId, seq, turnId, type, ts, data };
  }

  /** Events after a sequence number, oldest first. A negative limit means all of them. */
  listEvents(threadId: string, afterSeq = 0, limit = 5000): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(threadId, afterSeq, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** Every event of one type in a thread, oldest first. There are few of the types this is asked for. */
  listEventsOfType(threadId: string, type: EventType): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE thread_id = ? AND type = ? ORDER BY seq ASC')
      .all(threadId, type) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * One page of a thread's history: the events just before `beforeSeq`, or the end of the log
   * when that is left out. A page begins where a turn begins, so the reader never gets an answer
   * without its question or a tool result without its call. It reaches back to the earliest turn
   * that starts within `budget` events of the page's end; a single turn longer than that still
   * comes whole. Whatever precedes the first turn rides along with it.
   */
  listEventsPage(threadId: string, budget: number, beforeSeq?: number): StoredEvent[] {
    const end =
      beforeSeq ??
      (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE thread_id = ?').get(threadId) as { next: number }).next;
    const turnStart = (where: string, order: 'ASC' | 'DESC', ...args: number[]) =>
      (
        this.db
          .prepare(`SELECT seq FROM events WHERE thread_id = ? AND type = 'turn.started' AND ${where} ORDER BY seq ${order} LIMIT 1`)
          .get(threadId, ...args) as { seq: number } | undefined
      )?.seq;
    let start = turnStart('seq < ? AND seq >= ?', 'ASC', end, end - budget) ?? turnStart('seq < ?', 'DESC', end) ?? 1;
    if (turnStart('seq < ?', 'DESC', start) === undefined) start = 1;
    const rows = this.db
      .prepare('SELECT * FROM events WHERE thread_id = ? AND seq >= ? AND seq < ? ORDER BY seq ASC')
      .all(threadId, start, end) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * The id of the thread's last turn when it never ended (no turn.done or turn.error), else null.
   */
  openTurn(threadId: string): string | null {
    const last = this.db
      .prepare("SELECT seq, turn_id FROM events WHERE thread_id = ? AND type = 'turn.started' ORDER BY seq DESC LIMIT 1")
      .get(threadId) as { seq: number; turn_id: string | null } | undefined;
    if (!last?.turn_id) return null;
    const ended = this.db
      .prepare("SELECT 1 AS yes FROM events WHERE thread_id = ? AND seq > ? AND turn_id = ? AND type IN ('turn.done', 'turn.error') LIMIT 1")
      .get(threadId, last.seq, last.turn_id);
    return ended ? null : last.turn_id;
  }
}
