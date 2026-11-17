import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import { ZcodeAdapter } from '../src/adapters/zcode.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';
import { AttachmentStore } from '../src/attachments.js';
import { SessionWarmups } from '../src/session-warmups.js';
import { createHttpServer } from '../src/http.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/fake-${name}.mjs`, import.meta.url));
const token = 'test-warmups-token-0123456789';
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function setup(t: TestContext, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'calli-warmup-test-'));
  const log = join(root, 'rpc.jsonl');
  const adapter = new ClaudeAcpAdapter([process.execPath, fixture('acp')], { FAKE_ACP_RPC_LOG: log, ...env });
  const store = new Store(join(root, 'data'));
  const manager = new ThreadManager(store, new Map([['claude', adapter]]),
    new Workdirs([root], join(root, 'workdirs.json'), join(root, 'scratch')), new AttachmentStore(join(root, 'data')));
  const server = createHttpServer({ manager, token, webDir: null, version: 'test' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await manager.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const rpc = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const api = (path: string, body?: unknown, method = 'POST') => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const input = { agent: 'claude', cwd: root };
  const send = async (id: string) => {
    const started = await manager.startTurn(id, { text: 'hello' });
    assert.ok('turnId' in started);
    await until(() => manager.getThread(id).status !== 'running');
  };
  return { root, manager, store, adapter, rpc, api, input, send, base };
}

test('HTTP warmup starts no turn or visible thread; first send and follow-up use the same process', async t => {
  const f = await setup(t);
  assert.equal((await fetch(f.base + '/api/thread-warmups', { method: 'POST' })).status, 401);
  const response = await f.api('/api/thread-warmups', f.input);
  assert.equal(response.status, 202);
  const warm = await response.json() as { id: string };
  await until(() => f.rpc().some(r => r.method === 'session/new'));
  assert.equal(f.manager.listThreads().length, 0);
  assert.ok(!f.rpc().some(r => r.method === 'session/prompt'));
  const created = await f.api('/api/threads', { ...f.input, warmupId: warm.id });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  await f.send(id);
  await f.send(id);
  assert.equal(f.rpc().filter(r => r.method === 'initialize').length, 1);
  const prompts = f.rpc().filter(r => r.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].pid, prompts[1].pid);
  assert.ok(f.store.listEventsOfType(id, 'session.lifecycle').some(e => e.data.action === 'ready' && e.data.prewarmed === true));
  await f.manager.updateThread(id, { archived: true });
  assert.equal(f.store.listEventsOfType(id, 'session.lifecycle').at(-1)?.data.reason, 'archived');
});

test('sending while warmup is starting joins it instead of starting a second process', async t => {
  const f = await setup(t, { FAKE_ACP_INIT_DELAY_MS: '350' });
  const warm = await f.manager.warmDraft(f.input);
  await until(() => f.rpc().some(r => r.method === 'initialize'));
  const thread = await f.manager.createThread({ ...f.input, warmupId: warm.id! });
  await f.send(thread.id);
  assert.equal(f.rpc().filter(r => r.method === 'initialize').length, 1);
});

test('scratch draft cancellation removes its process and folder; invalid directories are refused', async t => {
  const f = await setup(t, { FAKE_ACP_INIT_DELAY_MS: '1000' });
  const warm = await f.manager.warmDraft({ ...f.input, cwd: '', scratch: true });
  await until(() => f.rpc().some(r => r.method === 'initialize'));
  const pid = f.rpc()[0].pid;
  assert.equal(readdirSync(join(f.root, 'scratch')).length, 1);
  assert.equal((await f.api(`/api/thread-warmups/${warm.id}`, undefined, 'DELETE')).status, 204);
  assert.equal(readdirSync(join(f.root, 'scratch')).length, 0);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(f.manager.listThreads().length, 0);
  assert.equal((await f.api('/api/thread-warmups', { ...f.input, cwd: tmpdir() })).status, 400);
});

test('scratch warmup is adopted with its reserved directory and remains after sending', async t => {
  const f = await setup(t);
  const input = { ...f.input, cwd: '', scratch: true };
  const warm = await f.manager.warmDraft(input);
  const folder = readdirSync(join(f.root, 'scratch'))[0];
  const thread = await f.manager.createThread({ ...input, warmupId: warm.id! });
  assert.equal(thread.cwd, join(f.root, 'scratch', folder));
  await f.send(thread.id);
  assert.equal(f.rpc().filter(r => r.method === 'initialize').length, 1);
  assert.equal(existsSync(thread.cwd), true);
});

test('a mismatched draft or a setting changed before sending never uses the stale process', async t => {
  const f = await setup(t);
  const warm = await f.manager.warmDraft(f.input);
  await until(() => f.rpc().some(r => r.method === 'session/new'));
  const thread = await f.manager.createThread({ ...f.input, permissionMode: 'ask', warmupId: warm.id! });
  await f.send(thread.id);
  assert.equal(f.rpc().filter(r => r.method === 'initialize').length, 2);
  const nextWarm = await f.manager.warmDraft(f.input);
  const next = await f.manager.createThread({ ...f.input, warmupId: nextWarm.id! });
  await f.manager.updateThread(next.id, { permissionMode: 'ask' });
  await f.send(next.id);
  assert.ok(f.store.listEventsOfType(next.id, 'session.lifecycle').some(e => e.data.reason === 'draft_settings_changed'));
});

test('a failed warmup falls back to a normal first send', async t => {
  const marker = join(tmpdir(), `calli-warm-fail-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const f = await setup(t, { FAKE_ACP_INIT_FAIL_ONCE: marker });
  const warm = await f.manager.warmDraft(f.input);
  await until(() => existsSync(marker));
  const thread = await f.manager.createThread({ ...f.input, warmupId: warm.id! });
  await f.send(thread.id);
  assert.equal(f.manager.getThread(thread.id).status, 'idle');
  assert.equal(f.rpc().filter(r => r.method === 'initialize').length, 2);
});

test('a warm process that exits after becoming ready is replaced before submitting the prompt', async t => {
  const f = await setup(t);
  const warm = await f.manager.warmDraft(f.input);
  await until(() => f.rpc().some(r => r.method === 'session/set_mode'));
  const pid = f.rpc()[0].pid;
  process.kill(pid, 'SIGTERM');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  const thread = await f.manager.createThread({ ...f.input, warmupId: warm.id! });
  await f.send(thread.id);
  assert.equal(f.manager.getThread(thread.id).status, 'idle');
  assert.equal(f.rpc().filter(r => r.method === 'initialize').length, 2);
  assert.ok(f.store.listEventsOfType(thread.id, 'session.lifecycle').some(e => e.data.reason === 'prewarm_failed'));
});

test('unused warmups expire, capacity is bounded, and adopted sessions outlive expiry', async () => {
  const warmups = new SessionWarmups(60, 500);
  const adapter = new ClaudeAcpAdapter([process.execPath, fixture('acp')]);
  let closed = 0, cleaned = 0;
  const start = async () => ({ agentSessionId: 'fake', prompt: async () => ({ stopReason: 'end_turn' as const }), cancel: async () => {}, close: async () => { closed++; } });
  const make = () => warmups.start({ threadId: 'reserved', cwd: tmpdir(), adapter, key: 'same' }, start, () => { cleaned++; });
  const first = make(); await first.ready; make(); const kept = make();
  await until(() => closed === 1);
  assert.equal(warmups.take(first.id, 'same', adapter), null);
  assert.equal(warmups.take(kept.id, 'same', adapter), kept);
  await until(() => cleaned === 2);
  assert.equal(closed, 2);
  await kept.dispose();
  assert.equal(closed, 3);
  assert.equal(cleaned, 2, 'an adopted directory belongs to its real thread');
  await warmups.shutdown();
});

test('replaced adapter instances cannot adopt another account\'s warm process', async () => {
  const warmups = new SessionWarmups();
  const first = new ClaudeAcpAdapter([process.execPath, fixture('acp')]);
  const second = new ClaudeAcpAdapter([process.execPath, fixture('acp')]);
  let closed = false;
  const entry = warmups.start({ threadId: 'reserved', cwd: tmpdir(), adapter: first, key: 'same' },
    () => first.start({ cwd: tmpdir() }), () => { closed = true; });
  await entry.ready;
  assert.equal(warmups.take(entry.id, 'same', second), null);
  await until(() => closed);
  await warmups.shutdown();
});

test('shutdown cancels an unsent startup and cleans its scratch directory', async t => {
  const f = await setup(t, { FAKE_ACP_INIT_DELAY_MS: '1000' });
  await f.manager.warmDraft({ ...f.input, scratch: true });
  await until(() => f.rpc().length > 0);
  const pid = f.rpc()[0].pid;
  await f.manager.shutdown();
  assert.equal(readdirSync(join(f.root, 'scratch')).length, 0);
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(f.manager.warmDraft(f.input), /stopping/);
});

test('every prewarming adapter cancels a handshake without a prompt', async () => {
  const command = (name: string) => [process.execPath, fixture(name)];
  for (const adapter of [new ClaudeAcpAdapter(command('acp')), new CodexAppServerAdapter(command('codex')),
    new PiRpcAdapter(command('pi')), new AgyAdapter(command('agy')), new ZcodeAdapter(command('zcode'))]) {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapter.start({ cwd: tmpdir(), signal: controller.signal }), undefined, adapter.id);
  }
});
