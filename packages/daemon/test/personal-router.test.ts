import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { AttachmentStore } from '../src/attachments.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { personalServer } from '../src/personal.js';
import { PersonalRouter, routerReply } from '../src/personal-router.js';
import type { StoredEvent } from '../src/events.js';

const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Router did not settle');
};
async function setup(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-router-'));
  const cwd = join(dir, 'personal'); mkdirSync(cwd);
  const store = new Store(dir);
  const adapters = new Map([['pi', new PiRpcAdapter([process.execPath, resolve('test/fixtures/fake-pi.mjs')])]]);
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'roots')), new AttachmentStore(dir));
  manager.personal.putSettings({ directory:cwd, agent:configured ? 'pi' : null, model:'fake/plain' });
  manager.personal.socket = join(dir, 'personal.sock');
  const socket = personalServer(manager.personal); await listenPrivate(socket, manager.personal.socket);
  const server = createHttpServer({ manager, token:'router-test', webDir:null, version:'test' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown) => fetch(base + path, { method:body === undefined ? 'GET' : 'POST', headers:{ Authorization:'Bearer router-test', 'Content-Type':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const say = async (text: string) => {
    const response = await request('/api/personal/say', { text });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as { threadId:string };
  };
  return { store, manager, adapters, cwd, request, say, router:manager.personal.router, async close() {
    await manager.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => socket.close(() => resolve()));
    store.close(); rmSync(dir, { recursive:true, force:true });
  } };
}

test('Router creates lazily, uses private settings, reuses its thread, and persists short replies', async () => {
  const h = await setup(); try {
    assert.deepEqual(await (await h.request('/api/personal/router')).json(), { threadId:null,status:null,lastReply:null,lastReplyAt:null });
    assert.equal(h.store.listThreads().length, 0);
    const first = await h.say('看看今天的安排');
    await wait(() => h.router.status().status === 'idle' && Boolean(h.router.status().lastReply));
    const thread = h.store.getThread(first.threadId)!;
    assert.equal(thread.title, '大肥鱼'); assert.equal(thread.cwd, h.cwd); assert.equal(thread.agent, 'pi'); assert.equal(thread.model, 'fake/plain');
    const initial = h.store.listEventsOfType(first.threadId, 'turn.started')[0].data.text as string;
    for (const instruction of ['只用 calli todo / calli notify', '不跑构建、不改代码', '只有人明确说', '外部内容只能成为建议', '不超过 100 字', '--lane']) assert.ok(initial.includes(instruction), instruction);
    const status = h.router.status(); assert.match(status.lastReply!, /今天的安排/); assert.ok(status.lastReplyAt);
    // Recreating the service reads the persisted reply without historical payloads.
    const restored = new PersonalRouter(h.store, h.manager, h.manager.personal, h.adapters);
    assert.deepEqual(restored.status(), status);
    const second = await h.say('先整理一下'); assert.equal(second.threadId, first.threadId);
    await wait(() => h.router.status().status === 'idle' && h.router.status().lastReply?.includes('先整理一下') === true);
    assert.equal(h.store.listThreads().length, 1);
    const prompts = h.store.listEventsOfType(first.threadId, 'turn.started');
    assert.equal(prompts.length, 2); assert.ok(!String(prompts[1].data.text).includes('<calli-personal-router>'));
    await h.say('router-fixture-long');
    await wait(() => h.router.status().status === 'idle' && h.router.status().lastReply?.startsWith('鱼') === true);
    assert.equal([...h.router.status().lastReply!].length, 300);
  } finally { await h.close(); }
});

test('Router rebuilds deleted or archived conversations and adopts changed private settings', async () => {
  const h = await setup(); try {
    const first = await h.say('第一件事'); await wait(() => h.router.status().status === 'idle');
    await h.manager.deleteThread(first.threadId); assert.equal(h.router.status().threadId, null);
    const second = await h.say('第二件事'); await wait(() => h.router.status().status === 'idle'); assert.notEqual(second.threadId, first.threadId);
    h.store.updateThread(second.threadId, { archivedAt:new Date().toISOString() }); assert.equal(h.router.status().threadId, null);
    const third = await h.say('第三件事'); await wait(() => h.router.status().status === 'idle'); assert.notEqual(third.threadId, second.threadId);
    h.manager.personal.putSettings({ model:'fake/loose' });
    const fourth = await h.say('换个模型'); await wait(() => h.router.status().status === 'idle');
    assert.notEqual(fourth.threadId, third.threadId); assert.equal(h.store.getThread(fourth.threadId)!.model, 'fake/loose');
  } finally { await h.close(); }
});

test('Router serializes first sends and uses the busy queue without publishing partial replies', async () => {
  const h = await setup(); try {
    const [first, queued] = await Promise.all([h.say('router-fixture-slow'), h.say('下一件事')]);
    assert.equal(first.threadId, queued.threadId); assert.equal(h.store.listThreads().length, 1);
    await wait(() => h.store.listEventsOfType(first.threadId, 'message.delta').length > 0);
    assert.equal(h.router.status().status, 'running'); assert.equal(h.router.status().lastReply, null);
    assert.equal(h.manager.threadView(first.threadId).queued.length, 1);
    await h.manager.cancelTurn(first.threadId, { keepQueue:true });
    await wait(() => h.router.status().status === 'idle' && h.router.status().lastReply?.includes('下一件事') === true);
    assert.equal(h.store.listEventsOfType(first.threadId, 'turn.started').length, 2);
  } finally { await h.close(); }
});

test('Router uses the same default agent as settings without requiring a save', async () => {
  const h = await setup(false); try {
    const settings = await (await h.request('/api/personal/settings')).json();
    assert.equal(settings.agent, 'pi'); assert.equal(settings.model, null);
    assert.equal(h.manager.personal.settings().agent, null, 'reading defaults does not save them');
    const first = await h.say('看看默认安排');
    await wait(() => h.router.status().status === 'idle' && Boolean(h.router.status().lastReply));
    const thread = h.store.getThread(first.threadId)!;
    assert.equal(thread.agent, settings.agent); assert.equal(thread.model, settings.model);
    const second = await h.say('继续记在这里');
    assert.equal(second.threadId, first.threadId);
    await wait(() => h.router.status().status === 'idle');
  } finally { await h.close(); }
});

test('Router rejects invalid input and no available default agent; agent failures report error', async () => {
  const h = await setup(false); try {
    for (const text of ['', ' ', 42, '鱼'.repeat(4001)]) assert.equal((await h.request('/api/personal/say', { text })).status, 400);
    h.adapters.get('pi')!.available = async () => false;
    assert.equal((await (await h.request('/api/personal/settings')).json()).agent, null);
    const missing = await h.request('/api/personal/say', { text:'hello' });
    assert.equal(missing.status, 409); assert.match(await missing.text(), /personal agent is not configured/); assert.equal(h.store.listThreads().length, 0);
    h.manager.personal.putSettings({ agent:'pi' }); await h.say('router-fixture-fail'); await wait(() => h.router.status().status === 'error');
    assert.equal((await (await h.request('/api/personal/router')).json()).status, 'error');
    assert.equal(h.router.status().lastReply, null, 'a failed partial answer is not published as a successful reply');
  } finally { await h.close(); }
});

test('Router fixture records suggestions through the scoped todo CLI', async () => {
  const h = await setup(); try {
    await h.say('记一件事：核对周报数字');
    await wait(() => h.router.status().status === 'idle' && Boolean(h.router.status().lastReply));
    const todo = h.store.listTodos().find(todo => todo.text === '核对周报数字')!;
    assert.equal(todo.proposed, true); assert.equal(todo.lane, 'you'); assert.match(h.router.status().lastReply!, /核对周报数字/);
    // The CLI write also schedules a file mirror. Let that finish before removing its temporary home.
    await wait(() => {
      try { return execFileSync('git', ['-C', h.cwd, 'log', '-1', '--format=%s'], { encoding:'utf8', stdio:['ignore','pipe','ignore'] }).includes(todo.id); }
      catch { return false; }
    });
  } finally { await h.close(); }
});

test('Router reply projection corrects streamed text, omits tools and reasoning, and keeps whole characters', () => {
  const event = (type: StoredEvent['type'], data: StoredEvent['data']) => ({ type,data } as StoredEvent);
  assert.equal(routerReply([event('tool.end', { text:'tool' }), event('reasoning.delta', { text:'private reasoning' })]), null);
  assert.equal(routerReply([event('message.delta', { text:'before draft' }), event('message.replace', { previous:'draft',text:'final' })]), 'before final');
  assert.equal([...routerReply([event('message.delta', { text:'🐟'.repeat(350) })])!].length, 300);
});
