import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { Workdirs } from '../src/workdirs.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { ExtensionHost } from '../src/extension-host.js';
import { loadCatalog } from '../src/extensions.js';
import { AUTOTITLE_ID, AutoTitle, cleanTitle, namingPrompt } from '../src/autotitle.js';
import { createHttpServer } from '../src/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-autotitle';
const PERMISSIONS = ['events.summary', 'transcript.read', 'threads.rename', 'agents.ask'];
const wait = async (check: () => boolean, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};

async function setup(opts: { install?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-autotitle-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  const adapters = new Map<string, AgentAdapter>([['claude', new ClaudeAcpAdapter([process.execPath, join(here, 'fixtures/fake-acp.mjs')])]]);
  const store = new Store(dir);
  const manager = new ThreadManager(store, adapters, new Workdirs([cwd], join(dir, 'dirs.json'), join(dir, 'scratch')), new AttachmentStore(dir));
  const extensions = new ExtensionHost({ store: store.extensions, source: manager, catalog: loadCatalog() });
  const autotitle = new AutoTitle(extensions.builtin(AUTOTITLE_ID)!, manager, store, extensions);
  extensions.register(autotitle);
  extensions.start();
  if (opts.install !== false) extensions.install(AUTOTITLE_ID, PERMISSIONS);
  const server = createHttpServer({ manager, extensions, autotitle, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const idle = (id: string) => wait(() => manager.threadView(id).status !== 'running');
  const send = async (id: string, text: string) => { await manager.startTurn(id, { text }); await idle(id); };
  return { dir, cwd, store, manager, extensions, autotitle, api, send, idle, async close() {
    extensions.dispose(); await manager.shutdown();
    await new Promise<void>(r => server.close(() => r()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('cleanTitle keeps the first line, without labels and quotes, emoji included, at most 40 characters', () => {
  assert.equal(cleanTitle('标题：「🐛 修复登录超时」\n解释'), '🐛 修复登录超时');
  assert.equal(cleanTitle('\n\n"Fix the login timeout"'), 'Fix the login timeout');
  assert.equal(cleanTitle('**整理周报**'), '整理周报');
  assert.equal([...cleanTitle('长'.repeat(80))].length, 40);
  assert.equal(cleanTitle('   '), '');
});

test('the naming request carries the rules as written, the conversation start, and the hub\'s own last line', () => {
  const prompt = namingPrompt('- 开头放一个 emoji', '为什么登录会超时？'.repeat(200), '因为 token 过期了');
  assert.match(prompt, /- 开头放一个 emoji/);
  assert.match(prompt, /用户：为什么登录会超时？/);
  assert.match(prompt, /回复：因为 token 过期了/);
  assert.ok(prompt.length < 2200, 'long messages are cut');
  assert.match(prompt.trim().split('\n').at(-1)!, /只输出标题本身/);
});

test('after the first turn the chosen agent names the thread by the rules; the question leaves no thread in the list', async () => {
  const h = await setup();
  try {
    assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', rules: '- 开头放一个贴切的 emoji' })).status, 200);
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录接口总是超时，帮我查一下');
    assert.equal(h.manager.titleBy(thread.id), 'default');
    await wait(() => h.manager.threadView(thread.id).title === '🐛 修复登录超时');
    assert.equal(h.manager.titleBy(thread.id), 'auto');
    const listed = h.manager.listThreads().map(t => t.id);
    assert.deepEqual(listed, [thread.id], 'the naming question ran in an archived thread');
    const asked = h.manager.listThreads({ archived: true });
    assert.equal(asked.length, 1);
    const question = String(h.store.listEventsOfType(asked[0].id, 'turn.started')[0].data.text);
    assert.match(question, /登录接口总是超时/);
    assert.doesNotMatch(question, /calli-tools|calli-progress/, 'nothing is added around the question');
    const status = await (await h.api('/api/extensions/autotitle/settings')).json() as { status: { last: { title: string } } };
    assert.equal(status.status.last.title, '🐛 修复登录超时');
    // Later turns do not rename again unless asked for.
    await h.send(thread.id, '再看看 2'); await h.send(thread.id, '再看看 3');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(h.manager.listThreads({ archived: true }).length, 1);
  } finally { await h.close(); }
});

test('a title the person set is never renamed, and the second pass only revises automatic titles', async () => {
  const h = await setup();
  try {
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', again: true });
    const mine = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.manager.startTurn(mine.id, { text: 'slow 一件事' });
    await h.manager.updateThread(mine.id, { title: '我自己起的名字' });
    await h.manager.cancelTurn(mine.id); await h.idle(mine.id);
    await h.send(mine.id, '继续'); await h.send(mine.id, '再继续');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(h.manager.threadView(mine.id).title, '我自己起的名字');
    assert.equal(h.manager.titleBy(mine.id), 'user');
    assert.equal(h.manager.listThreads({ archived: true }).length, 0, 'nothing was asked');

    const auto = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(auto.id, '登录总是超时');
    await wait(() => h.manager.titleBy(auto.id) === 'auto');
    await h.send(auto.id, '第二轮'); await h.send(auto.id, '第三轮');
    await wait(() => h.manager.listThreads({ archived: true }).length === 2);
  } finally { await h.close(); }
});

test('naming on send uses only the message; nothing happens without a chosen agent or the extension', async () => {
  const off = await setup({ install: false });
  try {
    await off.autotitle.configure({ agent: 'claude' });
    const thread = await off.manager.createThread({ agent: 'claude', cwd: off.cwd });
    await off.send(thread.id, '登录总是超时');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(off.manager.threadView(thread.id).title, '登录总是超时', 'not installed: left alone');
    assert.equal((await off.api(`/api/threads/${thread.id}/autotitle`, 'POST')).status, 403);
  } finally { await off.close(); }

  const h = await setup();
  try {
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录总是超时');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(h.manager.threadView(thread.id).title, '登录总是超时', 'no agent chosen: left alone');
    assert.equal((await h.api(`/api/threads/${thread.id}/autotitle`, 'POST')).status, 409);

    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude', trigger: 'sent' });
    const early = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.manager.startTurn(early.id, { text: 'slow 登录总是超时' });
    await wait(() => h.manager.threadView(early.id).title === '修复登录超时');
    assert.equal(h.manager.threadView(early.id).status, 'running', 'named while its first turn still runs');
    await h.manager.cancelTurn(early.id);
  } finally { await h.close(); }
});

test('「重新取名」 renames any thread at once, the preview renames nothing, and bad settings are refused', async () => {
  const h = await setup();
  try {
    for (const bad of [{ agent: 'missing' }, { trigger: 'later' }, { again: 'yes' }, { rules: 7 }, { colour: 'red' }]) {
      assert.equal((await h.api('/api/extensions/autotitle/settings', 'PUT', bad)).status, 400, JSON.stringify(bad));
    }
    const thread = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    await h.send(thread.id, '登录总是超时');
    await h.manager.updateThread(thread.id, { title: '旧名字' });
    await h.api('/api/extensions/autotitle/settings', 'PUT', { agent: 'claude' });
    const preview = await (await h.api('/api/extensions/autotitle/preview', 'POST', { threadId: thread.id })).json() as { title: string };
    assert.equal(preview.title, '修复登录超时');
    assert.equal(h.manager.threadView(thread.id).title, '旧名字', 'a preview renames nothing');
    const named = await (await h.api(`/api/threads/${thread.id}/autotitle`, 'POST')).json() as { title: string };
    assert.equal(named.title, '修复登录超时');
    assert.equal(h.manager.threadView(thread.id).title, '修复登录超时');
  } finally { await h.close(); }
});

test('a naming agent that does not answer in time is stopped, and the title stays', async () => {
  const h = await setup();
  try {
    await assert.rejects(h.manager.askOnce('claude', '给下面这段对话起一个线程标题。slow name', { timeoutMs: 300 }), /too long/);
    await wait(() => h.manager.listThreads({ archived: true }).every(t => t.status !== 'running'));
    assert.equal(h.manager.listThreads().length, 0, 'the question never showed in the list');
  } finally { await h.close(); }
});
