import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter } from './adapters/types.js';
import { isWithinWorkdirs } from './workdirs.js';
import { HttpError } from './errors.js';
import type { Store, TodoPatch, TodoRecord, TodoProposal } from './store.js';
import type { ThreadManager } from './threads.js';

// Keep the default location in one place so its final component can change independently.
const PERSONAL_DIRECTORY = ['.limi', 'personal'] as const;
export function defaultPersonalDirectory(): string {
  let path = realpathSync(homedir());
  for (const part of PERSONAL_DIRECTORY) {
    path = join(path, part);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new HttpError(400, 'cannot create the default personal directory'); }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) throw new HttpError(400, 'default personal directory must be a real directory, not a symbolic link');
  }
  return path;
}
export interface PersonalSettings { directory: string | null; agent: string | null; model: string | null }
/** Reject only unmistakable credential formats; this is not a general secret detector. */
export function personalText(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > limit) throw new HttpError(400, `text must contain ${empty ? '0' : '1'}–${limit} characters`);
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})/.test(value)) throw new HttpError(400, 'text contains a credential; remove secrets before saving');
  return value;
}
const time = (value: unknown): string | null => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400, 'time must be ISO 8601');
  return new Date(value).toISOString();
};

export class PersonalService {
  private readonly credentials = new Map<string, string>();
  private readonly introduced = new Set<string>();
  socket = '';
  constructor(readonly store: Store, private readonly manager: ThreadManager, private readonly adapters: Map<string, AgentAdapter>) {}
  private storedSettings(): PersonalSettings { return this.store.hubSetting('personal', { directory: null, agent: null, model: null }); }
  directory(): string {
    const configured = this.storedSettings().directory;
    if (!configured) return defaultPersonalDirectory();
    const defaultPath = join(realpathSync(homedir()), ...PERSONAL_DIRECTORY);
    // Older settings may explicitly name the default or one of its children.
    if (configured === defaultPath || configured.startsWith(defaultPath + sep)) defaultPersonalDirectory();
    return configured;
  }
  settings(): PersonalSettings & { directory: string } { return { ...this.storedSettings(), directory: this.directory() }; }
  async resolvedSettings(): Promise<PersonalSettings & { directory: string }> {
    const settings = this.settings();
    if (!settings.agent) {
      const agents = (await this.manager.listAgents()).filter(agent => agent.available && !agent.hidden);
      settings.agent = (agents.find(agent => this.adapters.get(agent.id)?.id === 'pi') ?? agents[0])?.id ?? null;
      settings.model = null;
    }
    return settings;
  }
  async settingsView() {
    const settings = await this.resolvedSettings(), home = realpathSync(homedir());
    const display = (path: string | null) => path === home ? '~' : path?.startsWith(home + sep) ? '~' + path.slice(home.length) : path;
    const defaultDirectory = defaultPersonalDirectory();
    return { ...settings, directoryDisplay: display(settings.directory), directoryIsDefault: settings.directory === defaultDirectory,
      defaultDirectory, defaultDirectoryDisplay: display(defaultDirectory) };
  }
  putSettings(input: Record<string, unknown>): PersonalSettings {
    const next = { ...this.storedSettings() };
    if (input.directory !== undefined) {
      if (input.directory === null || input.directory === '') next.directory = null;
      else {
        if (typeof input.directory !== 'string') throw new HttpError(400, 'directory must be a path');
        try { next.directory = realpathSync(input.directory); if (!statSync(next.directory).isDirectory()) throw new Error(); }
        catch { throw new HttpError(400, 'personal directory does not exist'); }
        const defaultDirectory = defaultPersonalDirectory();
        if (![...this.manager.dirs.roots(), defaultDirectory].some(root => this.within(next.directory!, root))) throw new HttpError(400, 'personal directory must be an allowed workdir or the default personal directory');
        if (next.directory === defaultDirectory) next.directory = null;
      }
    }
    if (input.agent !== undefined) {
      if (input.agent !== null && (typeof input.agent !== 'string' || !this.adapters.has(input.agent))) throw new HttpError(400, 'unknown personal agent');
      next.agent = input.agent as string | null;
    }
    if (input.model !== undefined) {
      if (input.model !== null && (typeof input.model !== 'string' || input.model.length > 200)) throw new HttpError(400, 'model must be a string');
      next.model = input.model ? String(input.model) : null;
    }
    this.store.saveHubSetting('personal', next);
    return next;
  }
  async delegate(id: string, input: { cwd?: unknown } = {}) {
    const todo = this.store.getTodo(id);
    if (!todo) throw new HttpError(404, 'todo not found');
    if (todo.done || todo.proposed) throw new HttpError(409, 'accept an open plan before delegating');
    const settings = await this.resolvedSettings(), adapter = settings.agent ? this.adapters.get(settings.agent) : undefined;
    if (!settings.directory || !adapter) throw new HttpError(409, 'personal agent is not configured');
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) throw new HttpError(400, 'cwd must be a nonempty directory');
    const cwd = typeof input.cwd === 'string' ? input.cwd : settings.directory;
    if (!isWithinWorkdirs(cwd, this.manager.allowedWorkdirs)) throw new HttpError(403, 'cwd is not in allowed workdirs');
    const active = this.store.todoThreadIds(id).map(t => this.store.getThread(t)).find(t => t?.status === 'running');
    if (active) return this.manager.threadView(active.id);
    const thread = await this.manager.createThread({ agent: settings.agent!, cwd, title: todo.text,
      permissionMode: adapter.capabilities.defaultPermissionMode, ...(settings.model ? { model: settings.model } : {}) });
    try {
      const note = this.store.todoNote(id);
      const text = `由 Limi 交给你的事项。\n事项：${todo.text}\nID：${id}；状态：${todo.state}；归属：${todo.owner}\n接续说明：\n${note.text}\n\n${this.within(cwd, settings.directory) ? '请推进这件事，结束前更新接续说明；需要人确认完成时用 limi todo propose-done。' : '请推进这件事，并在回复中说明进展与下一步。'}`;
      await this.manager.startTurn(thread.id, { text }, undefined, false, undefined, () => {
        this.store.checkTodoRev(id, todo.rev);
        this.store.linkTodoThread(id, thread.id);
        this.store.updateTodo(id, {}, todo.rev);
      });
      this.manager.broadcastTodo();
      return this.manager.threadView(thread.id);
    } catch (error) {
      if (!this.store.listEventsOfType(thread.id, 'turn.started').length) await this.manager.deleteThread(thread.id);
      throw error;
    }
  }
  private within(path: string, root: string) {
    try { const rel = relative(realpathSync(root), realpathSync(path)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
    catch { return false; }
  }
  allowed(threadId: string): boolean {
    const thread = this.store.getThread(threadId), root = this.settings().directory;
    return Boolean(thread && root && this.within(thread.cwd, root));
  }
  require(threadId: string) { if (!this.allowed(threadId)) throw new HttpError(403, 'personal commands require a thread in the personal directory'); }
  environment(threadId: string): Record<string, string> | undefined {
    if (!this.socket || !this.allowed(threadId)) return undefined;
    let key = this.credentials.get(threadId);
    if (!key) { key = randomUUID(); this.credentials.set(threadId, key); }
    return { LIMI_TODO_SOCKET: this.socket, LIMI_TODO_KEY: key, LIMI_BIN_DIR: resolve(dirname(fileURLToPath(import.meta.url)), '../bin') };
  }
  caller(key: string): string {
    for (const [id, secret] of this.credentials) if (key === secret) { this.require(id); return id; }
    throw new HttpError(401, 'invalid personal credentials');
  }
  instructions(threadId: string, text: string): string {
    if (!this.allowed(threadId) || this.introduced.has(threadId)) return text;
    return `${text}\n\n<limi-todo>由 Limi 附加：事项和跟进用 limi todo，用法 limi todo --help。改了事项的这一轮结束前，请写接续说明。</limi-todo>`;
  }
  started(threadId: string) { if (this.allowed(threadId)) this.introduced.add(threadId); }
  note(id: string) {
    if (!this.store.getTodo(id)) throw new HttpError(404, 'todo not found');
    return { ...this.store.todoNote(id), rev: this.store.getTodo(id)!.rev };
  }
  private patch(input: Record<string, unknown>): TodoPatch {
    const patch: TodoPatch = {};
    if (input.text !== undefined) patch.text = personalText(input.text, 300).trim();
    if (input.owner !== undefined) {
      if (input.owner !== 'me' && input.owner !== 'agent') throw new HttpError(400, 'owner must be me or agent');
      patch.owner = input.owner;
    }
    if (input.state !== undefined) {
      if (!['open', 'waiting', 'done'].includes(String(input.state))) throw new HttpError(400, 'invalid todo state');
      patch.state = input.state as TodoRecord['state'];
    }
    if (input.done !== undefined) {
      if (typeof input.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
      patch.done = input.done;
      if (patch.state && (patch.state === 'done') !== patch.done) throw new HttpError(400, 'state and done disagree');
    }
    if (input.waitingOn !== undefined) patch.waitingOn = input.waitingOn === null ? null : personalText(input.waitingOn, 500).trim();
    if (input.dueAt !== undefined) patch.dueAt = time(input.dueAt);
    if (input.followUpAt !== undefined) patch.followUpAt = time(input.followUpAt);
    return patch;
  }
  create(input: Record<string, unknown>, actor?: string): TodoRecord {
    if (actor) this.require(actor);
    const patch = this.patch(input);
    const text = personalText(input.text, 300).trim();
    let parentId: string | null = null;
    if (input.parentId != null) {
      const parent = this.store.getTodo(String(input.parentId));
      if (!parent) throw new HttpError(404, 'parent todo not found');
      if (parent.parentId) throw new HttpError(400, 'only one level of sub-items is allowed');
      parentId = parent.id;
    }
    const todo = this.store.transaction(() => {
      const proposed = Boolean(actor && (patch.owner ?? 'me') === 'me');
      const todo = this.store.createTodo(randomUUID(), text, parentId, { owner: patch.owner, dueAt: patch.dueAt, proposed });
      if (actor) this.store.linkTodoThread(todo.id, actor);
      if (proposed) this.store.saveTodoProposal({ id: randomUUID(), todoId: todo.id, kind: 'add', evidence: '', threadId: actor!, createdAt: new Date().toISOString(), state: 'open' });
      return todo;
    });
    this.manager.broadcastTodo();
    if (todo.proposed) this.manager.notice(actor!, `待你确认：${todo.text}`, true);
    return todo;
  }
  update(id: string, input: Record<string, unknown>, actor?: string): TodoRecord {
    if (actor) this.require(actor);
    const current = this.store.checkTodoRev(id, input.rev === undefined && !actor ? this.store.getTodo(id)?.rev : input.rev), patch = this.patch(input);
    if (actor && patch.owner !== undefined && patch.owner !== current.owner) throw new HttpError(403, 'agents cannot change ownership');
    if (actor && current.owner === 'me' && (patch.done === true || patch.state === 'done' || patch.owner === 'agent')) throw new HttpError(403, 'use limi todo propose-done for your personal commitments');
    if ((patch.state ?? current.state) === 'waiting' && !(patch.waitingOn ?? current.waitingOn)) throw new HttpError(400, 'waitingOn is required for waiting');
    const note = input.note !== undefined ? personalText(input.note, 4000, true) : undefined;
    if (patch.followUpAt != null) {
      if (actor && current.followUpPaused && (note === undefined || note === this.store.todoNote(id).text)) {
        throw new HttpError(409, '连续 3 次跟进没有进展，已停止自动跟进；请更新接续说明，或由人在网页重新设置跟进时间');
      }
      if (!actor) { patch.followUpNoProgress = 0; patch.followUpPaused = false; }
    }
    const todo = this.store.transaction(() => {
      let next = this.store.updateTodo(id, patch, current.rev);
      if (note !== undefined) next = this.store.writeTodoNote(id, note, actor ?? null, next.rev, false);
      if (actor) this.store.linkTodoThread(id, actor);
      return next;
    });
    this.manager.broadcastTodo(); return todo;
  }
  writeNote(id: string, input: Record<string, unknown>, actor?: string): TodoRecord {
    if (actor) this.require(actor);
    const current = this.store.checkTodoRev(id, input.rev === undefined && !actor ? this.store.getTodo(id)?.rev : input.rev);
    const text = personalText(input.text, 4000, true);
    const todo = this.store.writeTodoNote(id, text, actor ?? null, current.rev);
    if (actor) this.store.linkTodoThread(id, actor);
    this.manager.broadcastTodo(); return todo;
  }
  propose(id: string, input: Record<string, unknown>, actor: string) {
    this.require(actor);
    const current = this.store.checkTodoRev(id, input.rev === undefined && !actor ? this.store.getTodo(id)?.rev : input.rev);
    const evidence = personalText(input.evidence, 500);
    if (current.proposed || current.state === 'done') throw new HttpError(409, 'todo is not an accepted open commitment');
    const proposal: TodoProposal = { id: randomUUID(), todoId: id, kind: 'done', evidence, threadId: actor, createdAt: new Date().toISOString(), state: 'open' };
    this.store.transaction(() => {
      this.store.updateTodo(id, {}, current.rev); this.store.saveTodoProposal(proposal); this.store.linkTodoThread(id, actor);
    });
    this.manager.broadcastTodo(); this.manager.notice(actor, `待你确认：${current.text}`, true);
    return { ...proposal, rev: this.store.getTodo(id)!.rev };
  }
  resolveProposal(id: string, pid: string, action: 'accept' | 'dismiss', rev: unknown) {
    const current = this.store.checkTodoRev(id, rev === undefined ? this.store.getTodo(id)?.rev : rev);
    const proposal = this.store.todoProposals(id).find(p => p.id === pid);
    if (!proposal) throw new HttpError(404, 'proposal not found');
    if (proposal.state !== 'open') throw new HttpError(409, 'proposal already resolved');
    this.store.transaction(() => {
      if (proposal.kind === 'add' && action === 'dismiss') this.store.deleteTodo(id);
      else {
        this.store.updateTodo(id, action === 'dismiss' ? {} : proposal.kind === 'add' ? { proposed: false } : { state: 'done', followUpAt: null }, current.rev);
        this.store.saveTodoProposal({ ...proposal, state: action === 'accept' ? 'accepted' : 'dismissed' });
      }
    });
    this.manager.broadcastTodo(); return this.store.getTodo(id);
  }
  inherit(sourceId: string, targetId: string): void {
    if (!this.allowed(sourceId) || !this.allowed(targetId)) return;
    this.store.transaction(() => {
      for (const todo of this.store.listTodos()) {
        if (!this.store.todoThreadIds(todo.id).includes(sourceId)) continue;
        this.store.linkTodoThread(todo.id, targetId);
        this.store.updateTodo(todo.id, {}, todo.rev);
      }
    });
    this.manager.broadcastTodo();
  }

  context(threadId: string): string {
    if (!this.allowed(threadId)) return '';
    const todos = this.store.listTodos().filter(t => this.store.todoThreadIds(t.id).includes(threadId));
    if (!todos.length) return '';
    return '\n\n## 关联事项与接续说明\n改了事项后，请在这一轮结束前更新接续说明。\n' + todos.map(t => {
      const note = this.store.todoNote(t.id);
      return `### ${t.text}\nID：${t.id}；状态：${t.state}；归属：${t.owner}\n说明更新时间：${note.updatedAt ?? '尚未写入'}；写入线程：${note.threadId ?? '无'}\n${note.text}`;
    }).join('\n\n');
  }
  async command(owner: string, input: Record<string, unknown>) {
    this.require(owner);
    switch (input.op) {
      case 'todo.list': return this.store.listTodos().filter(t => !t.done);
      case 'todo.show': {
        const todo = this.store.getTodo(String(input.id)); if (!todo) throw new HttpError(404, 'todo not found');
        return { ...todo, note: this.note(todo.id), threads: this.store.todoThreadIds(todo.id), proposals: this.store.todoProposals(todo.id) };
      }
      case 'todo.add': return this.create(input, owner);
      case 'todo.update': return this.update(String(input.id), input, owner);
      case 'todo.propose-done': return this.propose(String(input.id), input, owner);
      case 'wish': { const id = randomUUID(); this.store.saveWish(id, owner, personalText(input.text, 500)); return { id }; }
      default: throw new HttpError(400, 'unknown personal command; see limi todo --help');
    }
  }
}

export function personalServer(service: PersonalService) {
  return createServer(async (req, res) => {
    try {
      const owner = service.caller((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (req.method !== 'POST' || req.url !== '/command') throw new HttpError(404, 'not found');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 64000) throw new HttpError(413, 'command too large'); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'command must be an object');
      const result = await service.command(owner, value);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (e) { res.writeHead(e instanceof HttpError ? e.status : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message })); }
  });
}
