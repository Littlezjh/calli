import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import { TraexAcpAdapter } from '../src/adapters/traex.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { CoordinationManager, coordinationServer } from '../src/coordination.js';
import { createHttpServer, listenPrivate } from '../src/http.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wait = async (check: () => boolean, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'limi-team-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  const other = join(dir, 'other'); mkdirSync(other);
  const adapters = new Map<string, AgentAdapter>([
    ['pi', new PiRpcAdapter([process.execPath, join(fixtures, 'fake-pi.mjs')])],
    ['claude', new ClaudeAcpAdapter([process.execPath, join(fixtures, 'fake-acp.mjs')])],
    ['codex', new CodexAppServerAdapter([process.execPath, join(fixtures, 'fake-codex.mjs')])],
    ['agy', new AgyAdapter([process.execPath, join(fixtures, 'fake-agy.mjs')])],
    ['traex', new TraexAcpAdapter([process.execPath, join(fixtures, 'fake-acp.mjs')])],
  ]);
  const store = new Store(dir);
  const manager = new ThreadManager(store, adapters, [cwd, other], new AttachmentStore(dir));
  const socket = join(dir, 'ipc', 'limi.sock');
  const team = new CoordinationManager(store, manager, socket);
  const local = coordinationServer(team); await listenPrivate(local, socket);
  const server = createHttpServer({ manager, token: 'test-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, body?: unknown, token = 'test-token') => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const root = await manager.createThread({ agent: 'pi', cwd });
  return { dir, cwd, other, store, manager, team, root, api, async close() { team.dispose(); await manager.shutdown(); await new Promise<void>(r => local.close(() => r())); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const spawn = (name: string, agent = 'pi', text = 'hello', extra = {}) => ({ op: 'spawn', name, agent, text, requestId: name, ...extra });

test('each advertised adapter passes the runtime environment to its fixture', async () => {
  const h = await setup();
  try {
    for (const agent of ['pi', 'claude', 'codex', 'agy', 'traex']) {
      const thread = await h.manager.createThread({ agent, cwd: h.cwd });
      await h.team.enable(thread.id);
      await h.manager.startTurn(thread.id, { text: 'LIMI_ENV' });
      await wait(() => h.manager.threadView(thread.id).status !== 'running');
      const answer = h.store.listEvents(thread.id, 0, -1).filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
      assert.match(answer, /limi-ready:true/, agent);
    }
  } finally { await h.close(); }
});

test('coordination API enables an idle session and CLI resolves its scoped runtime context', async () => {
  const h = await setup();
  try {
    assert.equal((await h.api(`/api/threads/${h.root.id}/coordination`, {}, 'wrong')).status, 401);
    assert.equal((await h.api(`/api/threads/${h.root.id}/coordination`, {})).status, 200);
    await h.manager.startTurn(h.root.id, { text: 'LIMI_ENV' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    const answer = h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
    assert.match(answer, /limi-ready:true/);
    const directive = Buffer.from(JSON.stringify({ args: ['spawn', '--agent', 'claude', '--name', 'cli-worker', '--message-file', '-', '--request-id', 'cli-create'], text: 'hello' })).toString('base64');
    await h.manager.startTurn(h.root.id, { text: `LIMI_COMMAND:${directive}` });
    await wait(() => h.team.view(h.root.id)?.members.length === 1);
    assert.equal(h.team.view(h.root.id)!.members[0].thread!.cwd, h.cwd);
    assert.equal(h.manager.threadView(h.root.id).coordination!.children, 1);
  } finally { await h.close(); }
});

test('Codex writes a file, Claude reviews it, and peer feedback resumes the original writer', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    await h.team.command(h.root.id, spawn('reviewer', 'claude'));
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    await h.team.command(h.root.id, spawn('writer', 'codex', 'LIMI_WRITE'));
    await wait(() => {
      try { return readFileSync(join(h.cwd, 'review-document.md'), 'utf8').includes('## Errors'); } catch { return false; }
    });
    const state = h.team.view(h.root.id)!;
    const writer = state.members.find(m => m.name === 'writer')!;
    const reviewer = state.members.find(m => m.name === 'reviewer')!;
    assert.ok(state.messages.some(d => d.from === writer.id && d.to === reviewer.id && d.text === 'LIMI_REVIEW'));
    assert.ok(state.messages.some(d => d.from === reviewer.id && d.to === writer.id && d.kind === 'result'));
    await wait(() => h.manager.threadView(writer.id).status === 'idle');
    assert.equal(h.manager.threadView(writer.id).agentSessionId, 'codex-thread-1');
  } finally { await h.close(); }
});

test('idempotency, member scope and real-path directory validation', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const [a, b] = await Promise.all([h.team.command(h.root.id, spawn('worker')), h.team.command(h.root.id, spawn('worker'))]) as any[];
    assert.equal(a.id, b.id);
    assert.equal(h.team.view(h.root.id)!.members.length, 1);
    await assert.rejects(h.team.command(h.root.id, spawn('worker', 'pi', 'different')), /request-id/);
    await assert.rejects(h.team.command(a.to, spawn('nested')), /只有主控/);
    await assert.rejects(h.team.command(a.to, { op: 'send', target: 'unrelated', text: 'test', requestId: 'x' }), /接收者/);
    await assert.rejects(h.team.command(h.root.id, spawn('outside', 'pi', 'hello', { cwd: h.other })), /目录/);
    symlinkSync(h.other, join(h.cwd, 'escape'));
    await assert.rejects(h.team.command(h.root.id, spawn('escape', 'pi', 'hello', { cwd: join(h.cwd, 'escape') })), /目录/);
    assert.throws(() => h.team.caller('wrong'), /凭据/);
    assert.throws(() => h.team.mentionText(h.root.id, 'task', [{ id: 'unknown', kind: 'agent' }]), /实例/);
    const invalid = await h.api(`/api/threads/${h.root.id}/turns`, { mentions: [{ id: 'pi', kind: 'agent' }] });
    assert.equal(invalid.status, 400);
  } finally { await h.close(); }
});

test('three-member concurrency limit, durable queue, approval visibility and stop cascade', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id, { directories: [h.cwd, h.other] });
    for (let n = 0; n < 4; n++) await h.team.command(h.root.id, spawn(`worker-${n}`, 'pi', 'slow', { cwd: n === 3 ? h.other : h.cwd }));
    await wait(() => h.team.view(h.root.id)!.members.filter(m => m.thread?.status === 'running').length === 3);
    assert.equal(h.team.view(h.root.id)!.members[3].latest!.state, 'queued');
    const first = h.team.view(h.root.id)!.members[0].id;
    await h.manager.cancelTurn(first);
    await wait(() => h.team.view(h.root.id)!.members[3].thread?.status === 'running');
    assert.equal(h.team.view(h.root.id)!.members[3].thread!.cwd, h.other);
    await h.manager.cancelTurn(h.root.id);
    await wait(() => h.team.view(h.root.id)!.members.every(m => m.thread?.status !== 'running'));
    assert.equal(h.team.view(h.root.id)!.paused, true);
    assert.ok(h.team.view(h.root.id)!.messages.every(d => d.state !== 'queued'));
    await assert.rejects(h.team.command(h.root.id, spawn('late')), /暂停/);
    await h.team.resume(h.root.id);
    await h.team.command(h.root.id, spawn('approver', 'claude', 'approve'));
    await wait(() => Boolean(h.team.view(h.root.id)!.members.find(m => m.name === 'approver')?.thread?.waiting));
    await h.manager.cancelTurn(h.root.id);
  } finally { await h.close(); }
});

test('restart preserves queued work, marks in-flight work interrupted and requires explicit resume', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const job = await h.team.command(h.root.id, spawn('worker', 'pi', 'slow')) as any;
    await wait(() => h.team.view(h.root.id)!.members[0].thread?.status === 'running');
    await h.team.command(h.root.id, { op: 'send', target: 'worker', text: 'next', requestId: 'next' });
    h.team.dispose();
    // Construct from persisted state, as a new daemon would, without executing interrupted work.
    const nextManager = new ThreadManager(h.store, new Map(), [h.cwd], new AttachmentStore(h.dir));
    nextManager.recoverInterrupted();
    const restored = new CoordinationManager(h.store, nextManager, join(h.dir, 'unused.sock'));
    try {
      const state = restored.view(h.root.id)!;
      assert.equal(state.paused, true);
      assert.equal(state.messages.find(d => d.id === job.id)!.state, 'interrupted');
      assert.ok(state.messages.some(d => d.state === 'queued' && d.text === 'next'));
    } finally { restored.dispose(); }
  } finally { await h.close(); }
});

test('stopping while a delivery prepares cannot start a late turn', async () => {
  const h = await setup();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const original = h.manager.startTurn.bind(h.manager);
  let preparing = false;
  h.manager.startTurn = async (id, input, delivery) => {
    if (delivery) { preparing = true; await gate; }
    return original(id, input, delivery);
  };
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('worker')) as any;
    await wait(() => preparing);
    await h.manager.cancelTurn(h.root.id);
    release();
    // Await the same serialized queue, after the suspended delivery has been refused.
    await h.team.command(h.root.id, { op: 'status' });
    assert.equal(h.manager.threadView(job.to).status, 'idle');
    assert.ok(!h.store.listEvents(job.to, 0, -1).some(e => e.type === 'turn.started'));
    assert.equal(h.team.view(h.root.id)!.messages[0].state, 'stopped');
  } finally { release(); await h.close(); }
});

test('restart reconstructs a result committed before its notification, only once', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('worker')) as any;
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    h.team.dispose();
    const persisted = JSON.parse(h.store.coordinationRecords()[0].data);
    persisted.deliveries = persisted.deliveries.filter((d: any) => d.id === job.id);
    persisted.deliveries[0].state = 'running';
    h.store.saveCoordination(h.root.id, JSON.stringify(persisted));
    const next = new ThreadManager(h.store, new Map(), [h.cwd], new AttachmentStore(h.dir));
    for (let n = 0; n < 2; n++) {
      const recovered = new CoordinationManager(h.store, next, join(h.dir, 'unused.sock'));
      try {
        const state = recovered.view(h.root.id)!;
        assert.equal(state.messages.filter(d => d.kind === 'result').length, 1);
        assert.equal(state.messages[0].state, 'returned');
        assert.equal(state.paused, true);
      } finally { recovered.dispose(); }
    }
  } finally { await h.close(); }
});
