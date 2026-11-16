import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { AgentRegistry } from '../src/agents.js';
import { AttachmentStore } from '../src/attachments.js';
import { CoordinationManager } from '../src/coordination.js';
import { createHttpServer } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';

const exec = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs');

/** Boots an HTTP hub with one fake agent and one thread, then runs bin/calli autohandover against it. */
test('calli autohandover reads and controls a thread over the HTTP API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-autohandover-cli-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const registry = new AgentRegistry([{
    id: 'claude-1', adapter: 'claude', label: 'Claude Code',
    command: [process.execPath, fixture],
    env: { CLAUDE_CONFIG_DIR: root, FAKE_SESSION_ROOT: root },
  }, {
    id: 'claude-2', adapter: 'claude', label: 'Claude Code',
    command: [process.execPath, fixture],
    env: { CLAUDE_CONFIG_DIR: join(root, 'two'), FAKE_SESSION_ROOT: join(root, 'two') },
  }], null);
  const store = new Store(join(root, 'data'));
  const manager = new ThreadManager(store, registry.adapters, new Workdirs([cwd], null), new AttachmentStore(join(root, 'data')));
  // The collaboration routes reach through manager.coordination, wired by the daemon entry.
  manager.coordination = new CoordinationManager(store, manager, join(root, 'coordination.sock'), {
    exchangeRoot: join(root, 'exchange'),
    resultDir: join(root, 'data', 'coordination', 'files'),
  });
  const TOKEN = 'autohandover-cli-token';
  const server = createHttpServer({ manager, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { ...process.env, CALLI_URL: base, CALLI_TOKEN: TOKEN };
  const calli = (...args: string[]) => exec(process.execPath, [resolve('bin/calli'), 'autohandover', ...args], { env });
  const http = (path: string, method: string, body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    const created = await http('/api/threads', 'POST', { agent: 'claude-1', cwd, title: '自动交接命令行' });
    assert.equal(created.status, 201);
    const { id } = await created.json() as { id: string };

    // The state alone: the effective value, where it came from and any progress.
    const view = JSON.parse((await calli(id)).stdout) as { enabled: boolean; source: string };
    assert.equal(view.source, 'global');

    // A per-thread override, and clearing it again.
    const off = JSON.parse((await calli(id, 'off')).stdout) as { enabled: boolean; source: string; override: boolean | null };
    assert.equal(off.enabled, false);
    assert.equal(off.source, 'thread');
    assert.equal(off.override, false);
    const inherited = JSON.parse((await calli(id, 'inherit')).stdout) as { source: string; override: boolean | null };
    assert.equal(inherited.source, 'global');
    assert.equal(inherited.override, null);

    // Cancelling with nothing in flight is a no-op that still reports the state.
    const cancelled = JSON.parse((await calli(id, 'cancel')).stdout) as { enabled: boolean };
    assert.equal(typeof cancelled.enabled, 'boolean');

    // Member migration belongs to a collaboration root; a lone thread is rejected, as on the web.
    await assert.rejects(calli(id, 'members', 'off'), /invalid collaboration handover setting/);

    // Detaching a thread that never took over is refused, as the chain dialog is.
    await assert.rejects(calli(id, 'detach'), /already independent/);

    // Unknown shapes point at the usage line.
    await assert.rejects(calli(id, 'sometimes'), /Use calli autohandover THREAD/);
    await assert.rejects(calli(), /Use calli autohandover THREAD/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A collaboration the auto handover moved to another thread goes home: the retired source takes its root
 *  seat back, the taker retires, and the source's own auto handover is off so it is not moved on at once. */
test('calli autohandover giveback returns a moved collaboration to its source thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-autohandover-giveback-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const registry = new AgentRegistry([{
    id: 'claude-1', adapter: 'claude', label: 'Claude Code',
    command: [process.execPath, fixture],
    env: { CLAUDE_CONFIG_DIR: root, FAKE_SESSION_ROOT: root },
  }, {
    id: 'claude-2', adapter: 'claude', label: 'Claude Code',
    command: [process.execPath, fixture],
    env: { CLAUDE_CONFIG_DIR: join(root, 'two'), FAKE_SESSION_ROOT: join(root, 'two') },
  }], null);
  const store = new Store(join(root, 'data'));
  const manager = new ThreadManager(store, registry.adapters, new Workdirs([cwd], null), new AttachmentStore(join(root, 'data')));
  const coordination = new CoordinationManager(store, manager, join(root, 'coordination.sock'), {
    exchangeRoot: join(root, 'exchange'),
    resultDir: join(root, 'data', 'coordination', 'files'),
  });
  manager.coordination = coordination;
  const TOKEN = 'giveback-test-token';
  const server = createHttpServer({ manager, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { ...process.env, CALLI_URL: base, CALLI_TOKEN: TOKEN };
  const calli = (...args: string[]) => exec(process.execPath, [resolve('bin/calli'), 'autohandover', ...args], { env });
  try {
    const source = await manager.createThread({ agent: 'claude-1', cwd, title: '原会话' });
    await coordination.enable(source.id);
    const spawned = await coordination.command(source.id, { op: 'spawn', name: 'ratchet', agent: 'claude-1', text: '开始', requestId: 'r1' }) as { to: string };
    // The handover: the taker thread continues the collaboration and the source retires.
    const taker = await manager.createHandoverThread(source.id, 'claude-2', undefined, 'continue', 'summary');
    coordination.replaceHandoverMember(source.id, taker.id, 'turn-1');
    assert.equal(coordination.metadata(source.id)?.retired, true);
    assert.equal(coordination.metadata(taker.id)?.rootId, taker.id);
    assert.equal(coordination.metadata(spawned.to)?.rootId, taker.id);

    JSON.parse((await calli(taker.id, 'giveback')).stdout);
    assert.equal(coordination.metadata(source.id)?.retired, undefined, 'the source is back in the team');
    assert.equal(coordination.metadata(source.id)?.rootId, source.id, 'the source leads again');
    assert.equal(coordination.metadata(taker.id)?.retired, true, 'the taker retires in its place');
    assert.equal(coordination.metadata(spawned.to)?.rootId, source.id);
    const view = JSON.parse((await calli(source.id)).stdout) as { enabled: boolean; source: string };
    assert.equal(view.enabled, false, 'the source does not hand itself on again at once');
    assert.equal(view.source, 'thread');

    // Without a handover behind it there is nothing to give back.
    await assert.rejects(calli(spawned.to, 'giveback'), /no handover behind it/);
  } finally {
    coordination.dispose();
    await manager.shutdown();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
