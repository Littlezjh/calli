import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { createHttpServer } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { parseTodoReport, todoInstructions } from '../src/todo-report.js';

// Plan-page CRUD over HTTP. Threads exist only as rows: linking never starts an agent, so a
// stub adapter is enough.

const stubAdapter: AgentAdapter = {
  label: 'Stub',
  available: async () => true,
  capabilities: {
    resume: false,
    approvals: false,
    permissionModes: [],
    effortLevels: [],
    images: false,
    deleteSession: false,
    history: false,
    fork: false,
  },
  async commands() {
    return [];
  },
  async start() {
    throw new Error('not used here');
  },
} as unknown as AgentAdapter;

// Answers each prompt with the next scripted reply, keeping what it was sent.
const prompts: string[] = [];
const replies: string[] = [];
const echoAdapter: AgentAdapter = {
  ...stubAdapter,
  label: 'Echo',
  resumeCommand: (id: string) => `echo resume ${id}`,
  async start() {
    return {
      agentSessionId: 'echo-session',
      async prompt(input: { text: string }, hooks: { emit(event: { type: string; data: Record<string, unknown> }): void }) {
        prompts.push(input.text);
        hooks.emit({ type: 'message.delta', data: { text: replies.shift() ?? 'ok' } });
        return { stopReason: 'end_turn' };
      },
      async cancel() {},
      async close() {},
    };
  },
} as unknown as AgentAdapter;

const TOKEN = 'test-token-0123456789';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

let server: Server;
let base: string;
let dataDir: string;
let workroot: string;
let manager: ThreadManager;
let store: Store;

const api = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(base + path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

interface TodoJson {
  id: string;
  text: string;
  done: boolean;
  parentId: string | null;
  position: number;
  threads: Array<{ id: string; title: string }>;
  report: { stage: string; note: string; threadId: string; at: string } | null;
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rah-todo-test-'));
  workroot = mkdtempSync(join(tmpdir(), 'rah-todo-work-'));
  store = new Store(dataDir);
  manager = new ThreadManager(store, new Map([['pi', stubAdapter], ['echo', echoAdapter]]), [workroot], new AttachmentStore(dataDir));
  server = createHttpServer({ manager, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.close();
  await manager.shutdown();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workroot, { recursive: true, force: true });
});

test('todos: create, list, edit, strike through, delete', async () => {
  const created = await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '  重构支付  ' }) });
  assert.equal(created.status, 201);
  const todo = (await created.json()) as TodoJson;
  assert.equal(todo.text, '重构支付');
  assert.equal(todo.done, false);

  // Empty and over-long texts are refused, so the list never holds blank rows.
  assert.equal((await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '   ' }) })).status, 400);
  assert.equal((await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(301) }) })).status, 400);

  const patched = await api(`/api/todos/${todo.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
  const after = (await patched.json()) as TodoJson;
  assert.equal(after.done, true);
  assert.ok(after.doneAt);

  const untoggled = await api(`/api/todos/${todo.id}`, { method: 'PATCH', body: JSON.stringify({ done: false }) });
  assert.equal(((await untoggled.json()) as TodoJson).done, false);

  const listed = await api('/api/todos');
  assert.deepEqual(((await listed.json()) as TodoJson[]).map((t) => t.id), [todo.id]);

  assert.equal((await api(`/api/todos/${todo.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/todos/${todo.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) })).status, 404);
});

test('todos: sub-items nest one level under a real plan, never deeper', async () => {
  const parent = (await (await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '计划页' }) })).json()) as TodoJson;
  const child = (await (
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '折叠已完成', parentId: parent.id }) })
  ).json()) as TodoJson;
  assert.equal(child.parentId, parent.id);

  // A child is not a valid parent.
  const deep = await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '太深', parentId: child.id }) });
  assert.equal(deep.status, 400);
  const ghost = await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '悬空', parentId: 'nope' }) });
  assert.equal(ghost.status, 404);

  // Deleting the plan takes its sub-item with it.
  await api(`/api/todos/${parent.id}`, { method: 'DELETE' });
  const listed = (await (await api('/api/todos')).json()) as TodoJson[];
  assert.equal(listed.find((t) => t.id === child.id), undefined);
});

test('todos: move reorders a level, indents under a plan and back out, one level only', async () => {
  const make = async (text: string, parentId?: string) =>
    (await (await api('/api/todos', { method: 'POST', body: JSON.stringify({ text, parentId }) })).json()) as TodoJson;
  const move = (id: string, body: Record<string, unknown>) =>
    api(`/api/todos/${id}/move`, { method: 'POST', body: JSON.stringify(body) });
  const order = async (parentId: string | null, ids: string[]) =>
    ((await (await api('/api/todos')).json()) as TodoJson[])
      .filter((t) => t.parentId === parentId && ids.includes(t.id))
      .sort((x, y) => x.position - y.position)
      .map((t) => t.text);

  const a = await make('甲');
  const b = await make('乙');
  const c = await make('丙');
  const ids = [a.id, b.id, c.id];

  // Reorder: 丙 before 甲, then 甲 to the end.
  assert.equal((await move(c.id, { parentId: null, before: a.id })).status, 204);
  assert.deepEqual(await order(null, ids), ['丙', '甲', '乙']);
  assert.equal((await move(a.id, { parentId: null, before: null })).status, 204);
  assert.deepEqual(await order(null, ids), ['丙', '乙', '甲']);

  // Tab: 乙 goes under 丙, last among its sub-items; Shift+Tab: back out, right after 丙.
  assert.equal((await move(b.id, { parentId: c.id })).status, 204);
  assert.deepEqual(await order(c.id, ids), ['乙']);
  assert.deepEqual(await order(null, ids), ['丙', '甲']);
  assert.equal((await move(b.id, { parentId: null, before: a.id })).status, 204);
  assert.deepEqual(await order(null, ids), ['丙', '乙', '甲']);

  // One level: a plan with sub-items stays a plan, a sub-item is no parent, nothing goes under itself.
  const kid = await make('丁', c.id);
  assert.equal((await move(c.id, { parentId: a.id })).status, 400);
  assert.equal((await move(a.id, { parentId: kid.id })).status, 400);
  assert.equal((await move(a.id, { parentId: a.id })).status, 400);
  // `before` has to be in the list the item lands in.
  assert.equal((await move(a.id, { parentId: null, before: kid.id })).status, 400);
  assert.equal((await move('nope', { parentId: null })).status, 404);
});

test('todos: threads link and unlink, and vanish with the thread', async () => {
  const workdir = join(workroot, 'proj');
  mkdirSync(workdir, { recursive: true });
  const thread = (await (
    await fetch(base + '/api/threads', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent: 'pi', cwd: workdir, title: '支付重构' }),
    })
  ).json()) as { id: string; title: string };
  assert.ok(thread.id, 'thread was created');
  const todo = (await (await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '支付重构收尾' }) })).json()) as TodoJson;

  assert.equal((await api(`/api/todos/${todo.id}/threads`, { method: 'POST', body: JSON.stringify({ threadId: thread.id }) })).status, 204);
  const linked = (await (await api('/api/todos')).json()) as TodoJson[];
  assert.deepEqual(linked.find((t) => t.id === todo.id)?.threads.map((t) => t.id), [thread.id]);

  // Unknown todos and threads are refused.
  assert.equal((await api('/api/todos/nope/threads', { method: 'POST', body: JSON.stringify({ threadId: thread.id }) })).status, 404);
  assert.equal((await api(`/api/todos/${todo.id}/threads`, { method: 'POST', body: JSON.stringify({ threadId: 'nope' }) })).status, 404);

  // Deleting the thread removes the link, not the plan.
  await fetch(`${base}/api/threads/${thread.id}`, { method: 'DELETE', headers: auth });
  const after = (await (await api('/api/todos')).json()) as TodoJson[];
  assert.deepEqual(after.find((t) => t.id === todo.id)?.threads, []);

  await api(`/api/todos/${todo.id}`, { method: 'DELETE' });
  rmSync(workdir, { recursive: true, force: true });
});

test('todo reports: the protocol line is read leniently and only its last say counts', () => {
  assert.equal(parseTodoReport('done the work'), null);
  assert.deepEqual(parseTodoReport('改好了。\n\n[计划状态] 待验收：等 CI'), { stage: 'review', note: '等 CI' });
  assert.deepEqual(parseTodoReport('**[计划状态] 需要你 - 缺少密钥**'), { stage: 'blocked', note: '缺少密钥' });
  assert.deepEqual(parseTodoReport('[计划状态] 需要你\n...\n[计划状态] 进行中: 还差测试'), { stage: 'doing', note: '还差测试' });
  assert.equal(parseTodoReport('[计划状态] 已完成：全部做完'), null, 'agents cannot declare an item done');
  assert.equal(parseTodoReport('引用 [计划状态] 待验收 的写法'), null, 'only a line of its own counts');
  assert.equal(parseTodoReport(`[计划状态] 待验收：${'长'.repeat(300)}`)?.note.length, 200);
  assert.equal(todoInstructions('hi', []), 'hi');
  const once = todoInstructions('hi', ['重构']);
  assert.ok(once.startsWith('hi\n\n<limi-plan>') && once.includes('「重构」'));
  assert.equal(todoInstructions(once, ['重构']), once, 'never appended twice');
});

test('todo reports: linked threads are asked, answers move the item, ticking clears them', async () => {
  const workdir = join(workroot, 'report');
  mkdirSync(workdir, { recursive: true });
  const create = async (title: string) => (await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'echo', cwd: workdir, title }) })).json()) as { id: string };
  const thread = await create('报告');
  const other = await create('其他');
  const plan = (await (await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '支付重构' }) })).json()) as TodoJson;
  const sub = (await (await api('/api/todos', { method: 'POST', body: JSON.stringify({ text: '补测试', parentId: plan.id }) })).json()) as TodoJson;
  const read = async (id: string) => ((await (await api('/api/todos')).json()) as TodoJson[]).find((t) => t.id === id)!;
  const turn = async (threadId: string, text: string, reply: string) => {
    replies.push(reply);
    const before = prompts.length;
    const started = await api(`/api/threads/${threadId}/turns`, { method: 'POST', body: JSON.stringify({ text }) });
    assert.equal(started.status, 202);
    for (let i = 0; i < 200 && (prompts.length === before || store.getThread(threadId)?.status === 'running'); i++) await new Promise((r) => setTimeout(r, 10));
    return prompts.at(-1)!;
  };

  // Not linked: the agent is told nothing, and its words change nothing.
  assert.equal(await turn(thread.id, '你好', '[计划状态] 待验收'), '你好');

  await api(`/api/todos/${plan.id}/threads`, { method: 'POST', body: JSON.stringify({ threadId: thread.id }) });
  await api(`/api/todos/${sub.id}/threads`, { method: 'POST', body: JSON.stringify({ threadId: other.id }) });
  const asked = await turn(thread.id, '开始', '做完了\n[计划状态] 待验收：请看 diff');
  assert.ok(asked.startsWith('开始\n\n<limi-plan>') && asked.includes('「支付重构」'), 'a linked thread is asked');
  const shown = store.getThread(thread.id)!;
  assert.equal(shown.status, 'idle');
  const started = store.listEventsOfType(thread.id, 'turn.started').at(-1)!;
  assert.equal(started.data.displayText, '开始', 'the person sees what they wrote');
  let item = await read(plan.id);
  assert.deepEqual([item.report?.stage, item.report?.note, item.report?.threadId], ['review', '请看 diff', thread.id]);

  // A sub-item is named under its plan; slash commands are left alone.
  assert.ok((await turn(other.id, '继续', '[计划状态] 需要你：缺密钥')).includes('「支付重构 › 补测试」'));
  assert.equal((await read(sub.id)).report?.stage, 'blocked');
  assert.equal(await turn(thread.id, '/compact', 'compacted'), '/compact');
  assert.equal((await read(plan.id)).report?.stage, 'review', 'a turn that was not asked does not withdraw');

  // Asked and silent: what this thread said before is withdrawn.
  await turn(thread.id, '再改一下', '改好了');
  assert.equal((await read(plan.id)).report, null);

  await turn(thread.id, '继续', '[计划状态] 进行中：等 CI');
  assert.equal((await read(plan.id)).report?.stage, 'doing');
  await api(`/api/todos/${plan.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
  item = await read(plan.id);
  assert.deepEqual([item.done, item.report], [true, null], 'ticking is the person\'s word');
  // A done item is no longer worked on: not named, not reported into.
  assert.equal(await turn(thread.id, '收尾', '[计划状态] 待验收'), '收尾');
  assert.equal((await read(plan.id)).report, null);

  // Unlinking withdraws the thread's report.
  assert.equal((await read(sub.id)).report?.threadId, other.id);
  await api(`/api/todos/${sub.id}/threads?threadId=${other.id}`, { method: 'DELETE' });
  assert.equal((await read(sub.id)).report, null);

  await api(`/api/todos/${plan.id}`, { method: 'DELETE' });
  rmSync(workdir, { recursive: true, force: true });
});
