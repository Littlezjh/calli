import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { CoordinationManager, coordinationServer } from '../src/coordination.js';
import { HttpError } from '../src/errors.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager, type ThreadView } from '../src/threads.js';
import type { VoiceSignal } from '../src/voice-sessions.js';

const TOKEN = 'thread-collaboration-test-token';
const fixture = (name: string) => [process.execPath, fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))];
const wait = async (check: () => boolean, description: string, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>(resolve => setTimeout(resolve, 15));
  }
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const blocked = (error: unknown) => error instanceof HttpError && error.status === 409;
const spawn = (name: string, text = 'initial task') => ({ op: 'spawn', agent: 'pi', name, text, requestId: name });
type Job = { id: string; to: string };

async function setup(t: TestContext, voice = false, voiceEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-thread-collaboration-'));
  const cwd = join(dir, 'project');
  mkdirSync(cwd);
  const socket = join(dir, 'coordination.sock');
  const open = async () => {
    const adapters = new Map<string, AgentAdapter>([['pi', new PiRpcAdapter(fixture('fake-pi.mjs'))]]);
    if (voice) adapters.set('speaker', new CodexAppServerAdapter(fixture('fake-codex.mjs'), {
      FAKE_CODEX_VOICE_CONVERSATION: '1', FAKE_CODEX_VOICE_TRANSCRIPT_DELAY: '40', ...voiceEnv,
    }));
    const store = new Store(dir);
    const manager = new ThreadManager(store, adapters, [cwd], new AttachmentStore(dir));
    const team = new CoordinationManager(store, manager, socket, {
      exchangeRoot: join(dir, 'exchange'), resultDir: join(dir, 'results'),
    });
    const ipc = coordinationServer(team);
    const server = createHttpServer({ manager, token: TOKEN, webDir: null, version: 'test' });
    const close = async () => {
      team.dispose();
      await manager.shutdown();
      server.closeAllConnections();
      ipc.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => ipc.close(() => resolve()))]);
      store.close();
    };
    try {
      await listenPrivate(ipc, socket);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    } catch (error) { await close(); throw error; }
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const api = (path: string, method = 'GET', body?: unknown, options: RequestInit = {}) => fetch(base + path, {
      ...options, method, signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { adapters, store, manager, team, api, close };
  };
  let current: Awaited<ReturnType<typeof open>> | undefined;
  t.after(async () => {
    try { await current?.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  current = await open();
  const root = await current.manager.createThread({ agent: 'pi', cwd });
  return {
    dir, cwd, root,
    get adapters() { return current!.adapters; },
    get store() { return current!.store; },
    get manager() { return current!.manager; },
    get team() { return current!.team; },
    api: (path: string, method = 'GET', body?: unknown, options?: RequestInit) => current!.api(path, method, body, options),
    async patch(id: string, disabled: boolean, options?: RequestInit) {
      const response = await current!.api(`/api/threads/${id}`, 'PATCH', { disabled }, options);
      assert.equal(response.status, 200);
      const view = await response.json() as ThreadView;
      assert.equal(view.disabled, disabled);
      return view;
    },
    async restart() {
      const previous = current; current = undefined;
      await previous!.close();
      current = await open();
    },
    cli: (key: string, body: unknown) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request({ socketPath: socket, path: '/command', method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => req.destroy(new Error('coordination command timed out')));
      req.end(JSON.stringify(body));
    }),
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const starts = (h: Harness, id: string) => h.store.listEventsOfType(id, 'turn.started');
const savedTeam = (h: Harness, id = h.root.id) => JSON.parse(h.store.coordinationRecords().find(row => row.id === id)!.data);
async function members(h: Harness, names: string[]) {
  await h.team.enable(h.root.id);
  const jobs: Job[] = [];
  for (const name of names) jobs.push(await h.team.command(h.root.id, spawn(name)) as Job);
  await wait(() => jobs.every(job => h.team.view(h.root.id)!.messages.some(message => message.id === job.id && message.state === 'returned'))
    && h.manager.threadView(h.root.id).status === 'idle', 'initial member tasks and their results');
  return jobs;
}

// A late readiness promise still executes the real turn scheduler cleanup, but shutdown forbids closed-store queue reads.
test('late startTurn readiness after shutdown never dispatches queues or reads the closed Store', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'calli-thread-collaboration-'));
  const cwd = join(dir, 'project');
  mkdirSync(cwd);
  const store = new Store(dir);
  const manager = new ThreadManager(store, new Map([['pi', new PiRpcAdapter(fixture('fake-pi.mjs'))]]), [cwd], new AttachmentStore(dir));
  let stopped = false, closed = false, readsAfterClose = 0, cleanupChecks = 0;
  t.after(async () => {
    try { if (!stopped) await manager.shutdown(); }
    finally {
      try { if (!closed) store.close(); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  const thread = await manager.createThread({ agent: 'pi', cwd });
  const held = gate();
  let preparing = false;
  const boundary = manager as unknown as {
    startTurnReady(id: string): Promise<{ turnId: string }>;
    startNextQueued(id: string): void;
  };
  boundary.startTurnReady = async id => {
    assert.equal(id, thread.id);
    preparing = true;
    await held.promise;
    return { turnId: 'late-ready-turn' };
  };
  const queue = boundary.startNextQueued.bind(boundary);
  boundary.startNextQueued = id => { cleanupChecks++; queue(id); };
  const get = store.getThread.bind(store);
  store.getThread = id => { if (closed) readsAfterClose++; return get(id); };
  const pending = manager.startTurn(thread.id, { text: 'late readiness', fromUser: true });
  void pending.catch(() => undefined);
  try {
    await wait(() => preparing, 'the ready-promise scheduler boundary');
    await manager.shutdown(); stopped = true;
    store.close(); closed = true;
    held.release();
    assert.deepEqual(await pending, { turnId: 'late-ready-turn' });
    // Let detached promise cleanup finish; an unhandled rejection is also a node:test failure.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cleanupChecks, 1, 'the real startTurn cleanup reaches the queue scheduler exactly once');
    assert.equal(readsAfterClose, 0);
  } finally { held.release(); }
});

// The switch is a strict, persisted thread field, not a truthy input lock or a coordination action.
test('thread disabled PATCH validates booleans and survives a complete fixture restart', async t => {
  const h = await setup(t);
  const sibling = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  assert.equal(h.manager.threadView(h.root.id).disabled, false);
  assert.equal((await (await h.api(`/api/threads/${h.root.id}`)).json()).disabled, false);
  for (const disabled of ['true', 'false', '', null, 0, 1, [], {}]) {
    const response = await h.api(`/api/threads/${h.root.id}`, 'PATCH', { disabled, title: 'invalid partial update' });
    assert.equal(response.status, 400, JSON.stringify(disabled));
    assert.equal(h.manager.threadView(h.root.id).disabled, false);
    assert.equal(h.manager.threadView(h.root.id).title, h.root.title, 'validation must precede other mutations');
  }
  assert.equal((await h.api(`/api/threads/${h.root.id}`, 'PATCH', { disabled: true }, {
    headers: { authorization: 'Bearer wrong-token' },
  })).status, 401);
  const updates: string[] = [];
  const unsubscribe = h.manager.subscribe(event => { if (event.type === 'thread.updated') updates.push(event.threadId); });
  try { await h.patch(h.root.id, true); await h.patch(h.root.id, true); }
  finally { unsubscribe(); }
  assert.ok(updates.includes(h.root.id));
  assert.equal(updates.includes(sibling.id), false);
  assert.equal(h.team.view(h.root.id), null, 'PATCH alone does not activate collaboration');
  await h.restart();
  assert.equal((await (await h.api(`/api/threads/${h.root.id}`)).json()).disabled, true);
  assert.equal(h.manager.threadView(sibling.id).disabled, false);
  const fresh = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  assert.equal(fresh.disabled, false, 'another conversation on the same instance starts enabled');
  const list = await (await h.api('/api/threads')).json() as ThreadView[];
  assert.ok(list.every(thread => typeof thread.disabled === 'boolean'));
  await h.patch(h.root.id, false);
  await h.restart();
  assert.equal(h.manager.threadView(h.root.id).disabled, false);
});

// Old pages must receive 400 rather than silently activating a root or changing an instance policy.
test('retired object-disabled and unknown coordination actions are rejected without side effects', async t => {
  const h = await setup(t);
  for (const action of ['object-disabled', 'unknown']) {
    const response = await h.api(`/api/threads/${h.root.id}/coordination`, 'POST', {
      action, target: { kind: 'agent', id: 'pi' }, disabled: true,
    });
    assert.equal(response.status, 400);
    assert.equal(h.team.view(h.root.id), null);
    assert.equal(h.store.coordinationRecords().length, 0);
    assert.equal(h.manager.threadView(h.root.id).disabled, false);
  }
  await h.team.enable(h.root.id);
  const before = savedTeam(h);
  assert.equal((await h.api(`/api/threads/${h.root.id}/coordination`, 'POST', {
    action: 'object-disabled', target: { kind: 'agent', id: 'pi' }, disabled: false,
  })).status, 400);
  assert.deepEqual(savedTeam(h), before);
});

// A root and each member own their switch; the shared Pi instance and enabled peers remain usable.
test('root and same-instance members leave collaboration independently, including stale CLI credentials', async t => {
  const h = await setup(t);
  const [a, b] = await members(h, ['member-a', 'member-b']);
  const key = h.team.environment(a.to)!.CALLI_TEAM_KEY;
  await h.patch(a.to, true);
  assert.equal(h.manager.threadView(h.root.id).disabled, false);
  assert.equal(h.manager.threadView(b.to).disabled, false);
  const status = await h.team.command(h.root.id, { op: 'status' }) as { members: Array<{ id: string }> };
  assert.deepEqual(status.members.map(member => member.id), [b.to]);
  assert.ok((await h.team.command(h.root.id, { op: 'agents' }) as Array<{ id: string }>).some(agent => agent.id === 'pi'));
  await assert.rejects(h.team.command(h.root.id, { op: 'send', target: a.to, text: 'blocked', requestId: 'blocked-target' }), blocked);
  await assert.rejects(h.team.previewMentions(h.root.id, 'blocked mention', [{ kind: 'member', id: a.to }]), blocked);
  assert.equal((await h.cli(key, { op: 'send', target: b.to, text: 'stale sender', requestId: 'stale-sender' })).status, 409);
  const fresh = await h.team.command(h.root.id, spawn('fresh-member')) as Job;
  await wait(() => h.team.view(h.root.id)!.messages.some(message => message.id === fresh.id && message.state === 'returned')
    && h.manager.threadView(h.root.id).status === 'idle', 'fresh same-instance member');
  assert.equal(h.manager.threadView(fresh.to).disabled, false);
  await h.patch(h.root.id, true);
  assert.equal(h.manager.threadView(b.to).disabled, false);
  assert.equal(h.manager.threadView(fresh.to).disabled, false);
  await assert.rejects(h.team.command(h.root.id, spawn('blocked-root')), blocked);
  const peer = await h.team.command(b.to, { op: 'send', target: fresh.to, text: 'peer work', requestId: 'peer-work' }) as Job;
  await wait(() => h.team.view(h.root.id)!.messages.some(message => message.id === peer.id && message.state === 'returned'), 'enabled peers while root is disabled');
  await h.patch(h.root.id, false);
  await h.patch(a.to, false);
  assert.equal((await h.cli(key, { op: 'status' })).status, 200, 'reenabling permits future commands, not an instance-wide reset');
});

// Ordinary manual turns and queues are not collaboration mail; send-now remains an intentional interrupt.
test('disabled members accept manual manager and HTTP input, drain user queues and send queued input immediately', async t => {
  const h = await setup(t);
  const [member] = await members(h, ['human-member']);
  const rootStarts = starts(h, h.root.id).length;
  const active = await h.manager.startTurn(member.to, { text: 'slow', fromUser: true });
  assert.ok('turnId' in active);
  const firstResponse = await h.api(`/api/threads/${member.to}/turns`, 'POST', { text: 'HUMAN_QUEUE_FIRST', queue: true });
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json() as { queued: boolean; id: string };
  assert.equal(first.queued, true);
  await h.patch(member.to, true);
  assert.equal(h.manager.activeTurnId(member.to), active.turnId, 'the switch itself does not interrupt the current turn');
  assert.deepEqual(h.manager.threadView(member.to).queued.map(item => [item.id, item.text, item.error]), [[first.id, 'HUMAN_QUEUE_FIRST', undefined]]);
  const secondResponse = await h.api(`/api/threads/${member.to}/turns`, 'POST', { text: 'HUMAN_QUEUE_NOW', queue: true });
  assert.equal(secondResponse.status, 202);
  const second = await secondResponse.json() as { queued: boolean; id: string };
  assert.equal(second.queued, true);
  assert.equal((await h.api(`/api/threads/${member.to}/queue/${second.id}/now`, 'POST', {})).status, 204);
  await wait(() => h.manager.threadView(member.to).status === 'idle' && h.manager.threadView(member.to).queued.length === 0
    && starts(h, member.to).some(event => event.data.displayText === 'HUMAN_QUEUE_FIRST' || event.data.text === 'HUMAN_QUEUE_FIRST'), 'both human queued turns');
  const queuedStarts = starts(h, member.to).filter(event => String(event.data.displayText ?? event.data.text).startsWith('HUMAN_QUEUE_'));
  assert.deepEqual(queuedStarts.map(event => event.data.displayText ?? event.data.text), ['HUMAN_QUEUE_NOW', 'HUMAN_QUEUE_FIRST']);
  assert.ok(queuedStarts.every(event => event.data.fromUser === true && event.data.coordination === undefined));
  const manual = await h.manager.startTurn(member.to, { text: 'HUMAN_MANAGER_INPUT', fromUser: true });
  assert.ok('turnId' in manual);
  await wait(() => h.manager.threadView(member.to).status === 'idle', 'manual manager turn');
  assert.equal(starts(h, h.root.id).length, rootStarts, 'disabled human replies never wake the lead');
  const history = await h.api(`/api/threads/${member.to}/history`);
  assert.equal(history.status, 200);
  assert.match(JSON.stringify(await history.json()), /HUMAN_QUEUE_FIRST|HUMAN_MANAGER_INPUT/);
  await h.patch(member.to, false);
  const response = await h.api(`/api/threads/${h.root.id}/turns`, 'POST', { text: 'lead follow-up' });
  assert.equal(response.status, 202);
  const { turnId } = await response.json() as { turnId: string };
  assert.doesNotMatch(String(h.store.listTurnEvents(h.root.id, turnId).find(event => event.type === 'turn.started')!.data.text), /HUMAN_QUEUE_|HUMAN_MANAGER_INPUT/);
});

// Claimed work finishes normally, while withheld results stay readable and can never be replayed.
test('disabling an in-flight member preserves completion and permanently suppresses its automatic return', async t => {
  const h = await setup(t);
  const held = gate();
  let reached = false, cancellations = 0;
  const adapter = h.adapters.get('pi')!;
  const start = adapter.start.bind(adapter);
  adapter.start = async options => {
    const session = await start(options);
    const prompt = session.prompt.bind(session), cancel = session.cancel.bind(session);
    session.cancel = async () => { cancellations++; await cancel(); };
    session.prompt = async (input, hooks) => {
      if (input.text.includes('HELD_COLLABORATION_RESULT')) { reached = true; await held.promise; }
      return prompt(input, hooks);
    };
    return session;
  };
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('held-member', 'HELD_COLLABORATION_RESULT')) as Job;
    await wait(() => reached && h.manager.activeTurnId(job.to) !== null, 'claimed member turn');
    const turnId = h.manager.activeTurnId(job.to)!;
    await h.patch(job.to, true);
    assert.equal(h.manager.activeTurnId(job.to), turnId);
    assert.equal(cancellations, 0);
    held.release();
    await wait(() => h.team.view(h.root.id)!.messages.some(message => message.id === job.id && message.state === 'returned'), 'held result completion');
    const completed = h.team.view(h.root.id)!.messages.find(message => message.id === job.id)!;
    assert.equal('suppressed' in completed && completed.suppressed, true);
    assert.match(completed.result, /HELD_COLLABORATION_RESULT/);
    const ending = h.store.listTurnEvents(job.to, turnId).find(event => event.type === 'turn.done');
    assert.ok(ending);
    assert.notEqual(ending.data.stopReason, 'cancelled');
    assert.equal(starts(h, h.root.id).length, 0);
    const notifications = h.team.view(h.root.id)!.messages.filter(message => message.kind === 'result');
    assert.ok(notifications.length > 0);
    assert.ok(notifications.every(message => message.state === 'stopped' && 'suppressed' in message && message.suppressed));
    const before = h.team.view(h.root.id)!.messages;
    await h.patch(job.to, false);
    await h.team.command(h.root.id, { op: 'status' });
    await h.restart();
    await h.team.command(h.root.id, { op: 'status' });
    assert.deepEqual(h.team.view(h.root.id)!.messages, before);
    assert.equal(starts(h, h.root.id).length, 0);
    assert.equal(starts(h, job.to).length, 1);
    const events = await h.api(`/api/threads/${job.to}/events?all`);
    assert.equal(events.status, 200);
    assert.match(JSON.stringify(await events.json()), /HELD_COLLABORATION_RESULT/);
    const next = await h.team.command(h.root.id, { op: 'send', target: job.to, text: 'future collaboration', requestId: 'future' }) as Job;
    await wait(() => h.team.view(h.root.id)!.messages.some(message => message.id === next.id && message.state === 'returned')
      && h.manager.threadView(h.root.id).status === 'idle', 'fresh work after reenabling');
    assert.equal(starts(h, job.to).length, 2, 'only a fresh delivery can start a new member turn');
  } finally { held.release(); }
});

// A switch commits while preparation is pending and the final local claim cannot revive stopped mail.
test('disabling a preparing local collaboration delivery stops it without blocking PATCH or replaying on enable', async t => {
  const h = await setup(t);
  const held = gate();
  let preparing = false;
  const start = h.manager.startTurn.bind(h.manager);
  h.manager.startTurn = async (id, input, delivery, ...rest) => {
    if (delivery && input.text?.toString().includes('PREPARING_COLLABORATION')) { preparing = true; await held.promise; }
    return start(id, input, delivery, ...rest);
  };
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('preparing-member', 'PREPARING_COLLABORATION')) as Job;
    await wait(() => preparing, 'local delivery preparation gate');
    await h.patch(job.to, true, { signal: AbortSignal.timeout(1500) });
    assert.equal(h.team.view(h.root.id)!.messages.find(message => message.id === job.id)!.state, 'stopped');
    await h.patch(job.to, false);
    held.release();
    await h.team.command(h.root.id, { op: 'status' });
    assert.equal(starts(h, job.to).length, 0);
    await h.restart();
    await h.team.command(h.root.id, { op: 'status' });
    assert.equal(h.team.view(h.root.id)!.messages.find(message => message.id === job.id)!.state, 'stopped');
    assert.equal(starts(h, job.to).length, 0);
  } finally { held.release(); }
});

// Stale instance/member flags are ignored and hidden from DTOs, but terminal history is not rewritten.
test('legacy two-level policy is inert and stripped while stopped, suppressed and told records remain unchanged', async t => {
  const h = await setup(t);
  await h.team.enable(h.root.id);
  const member = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  h.team.dispose();
  const row = savedTeam(h);
  row.disabledAgents = ['pi'];
  row.members = [{ id: member.id, name: 'legacy-member', agentRef: 'pi', disabled: true }];
  const historical = (id: string, state: string, kind = 'message') => ({ id, key: id, fingerprint: '', from: h.root.id,
    to: member.id, text: id, kind, state, turnId: null, result: 'historical answer', createdAt: '2020-01-01T00:00:00.000Z' });
  row.deliveries = [historical('LEGACY_STOPPED', 'stopped'),
    { ...historical('LEGACY_SUPPRESSED', 'returned'), suppressed: true },
    { ...historical('LEGACY_WITHHELD_RETURN', 'stopped', 'result'), from: member.id, to: h.root.id, suppressed: true }];
  row.direct = [{ id: 'LEGACY_TOLD', to: member.id, turnId: 'legacy-human-turn', text: 'LEGACY_PRIVATE_TEXT',
    result: 'LEGACY_PRIVATE_RESULT', state: 'returned', createdAt: '2020-01-01T00:00:00.000Z', told: true }];
  h.store.saveCoordination(h.root.id, JSON.stringify(row));
  await h.restart();
  assert.equal(h.manager.threadView(h.root.id).disabled, false);
  assert.equal(h.manager.threadView(member.id).disabled, false, 'old member flags are not migrated to thread disabled');
  const dto = await (await h.api(`/api/threads/${h.root.id}/coordination`)).json();
  assert.equal(Object.hasOwn(dto, 'disabledAgents'), false);
  assert.equal(Object.hasOwn(dto.members[0], 'disabled'), false);
  assert.equal(Object.hasOwn(dto.members[0], 'effectiveDisabled'), false);
  assert.equal(Object.hasOwn(dto.members[0].thread.coordination, 'disabled'), false);
  assert.equal(Object.hasOwn(h.manager.threadView(h.root.id).coordination!, 'hasDisabledObjects'), false);
  const status = await h.team.command(h.root.id, { op: 'status' }) as { members: Array<{ id: string }> };
  assert.deepEqual(status.members.map(item => item.id), [member.id]);
  assert.ok((await h.team.command(h.root.id, { op: 'agents' }) as Array<{ id: string }>).some(agent => agent.id === 'pi'));
  assert.deepEqual(savedTeam(h).deliveries, row.deliveries);
  assert.deepEqual(savedTeam(h).direct, row.direct);
  assert.equal(starts(h, h.root.id).length, 0);
  assert.equal(starts(h, member.id).length, 0);
  const response = await h.api(`/api/threads/${h.root.id}/turns`, 'POST', { text: 'new human turn' });
  assert.equal(response.status, 202);
  const { turnId } = await response.json() as { turnId: string };
  assert.doesNotMatch(String(h.store.listTurnEvents(h.root.id, turnId).find(event => event.type === 'turn.started')!.data.text), /LEGACY_PRIVATE_/);
  await wait(() => h.manager.threadView(h.root.id).status === 'idle', 'ordinary legacy root turn');
  const next = await h.team.command(h.root.id, { op: 'send', target: member.id, text: 'fresh legacy member work', requestId: 'legacy-fresh' }) as Job;
  await wait(() => h.team.view(h.root.id)!.messages.some(message => message.id === next.id && message.state === 'returned'), 'fresh work despite stale instance policy');
  assert.deepEqual(savedTeam(h).deliveries.filter((item: { id: string }) => item.id.startsWith('LEGACY_')), row.deliveries);
  assert.deepEqual(savedTeam(h).direct, row.direct);
});

// Configuration-only records stay inert through toggles and human input; no runtime refresh is implied.
test('legacy enabled:false configuration is not activated by thread PATCH or ordinary human turns', async t => {
  const h = await setup(t);
  h.team.dispose();
  h.store.saveCoordination(h.root.id, JSON.stringify({ rootId: h.root.id, enabled: false, paused: false,
    directories: [h.cwd], agents: ['pi'], members: [], deliveries: [], disabledAgents: ['pi'] }));
  await h.restart();
  let refreshes = 0;
  const refresh = h.manager.refreshRuntime.bind(h.manager);
  h.manager.refreshRuntime = async id => { refreshes++; await refresh(id); };
  for (const disabled of [true, false]) {
    await h.patch(h.root.id, disabled);
    assert.equal(h.team.enabled(h.root.id), false);
    assert.equal(h.team.leads(h.root.id), false);
    assert.equal(h.team.environment(h.root.id)?.CALLI_TEAM_SOCKET, undefined);
    const response = await h.api(`/api/threads/${h.root.id}/turns`, 'POST', { text: `ordinary configured chat ${disabled}` });
    assert.equal(response.status, 202);
    const { turnId } = await response.json() as { turnId: string };
    assert.doesNotMatch(String(h.store.listTurnEvents(h.root.id, turnId).find(event => event.type === 'turn.started')!.data.text), /<calli-coordination>/);
    await wait(() => h.manager.threadView(h.root.id).status === 'idle', 'configuration-only human turn');
  }
  assert.equal(refreshes, 0);
  assert.equal(savedTeam(h).enabled, false);
  assert.deepEqual(savedTeam(h).deliveries, []);
  const dto = await (await h.api(`/api/threads/${h.root.id}/coordination`)).json();
  assert.equal(dto.enabled, false);
  assert.equal(Object.hasOwn(dto, 'disabledAgents'), false);
});

// Only the explicit remote marker selects automation; identical text and a client fromUser hint do not.
test('HTTP turns distinguish marked automatic collaboration from ordinary human input on disabled targets', async t => {
  const h = await setup(t);
  const [member] = await members(h, ['http-member']);
  const text = '[协作消息 remote-task｜remote → member] identical request text';
  const coordination = { messageId: 'remote-task', from: 'remote-lead', kind: 'message' };
  await h.patch(member.to, true);
  const before = starts(h, member.to).length;
  for (const kind of ['message', 'result']) {
    assert.equal((await h.api(`/api/threads/${member.to}/turns`, 'POST', { text, coordination: { ...coordination, kind } })).status, 409);
    assert.equal(starts(h, member.to).length, before);
    assert.deepEqual(h.manager.threadView(member.to).queued, []);
  }
  const manual = await h.api(`/api/threads/${member.to}/turns`, 'POST', { text, fromUser: false });
  assert.equal(manual.status, 202);
  const humanId = (await manual.json() as { turnId: string }).turnId;
  const human = h.store.listTurnEvents(member.to, humanId).find(event => event.type === 'turn.started')!;
  assert.equal(human.data.fromUser, true);
  assert.equal(human.data.coordination, undefined);
  await wait(() => h.manager.threadView(member.to).status === 'idle', 'unmarked HTTP human input');
  await h.patch(member.to, false);
  const automatic = await h.api(`/api/threads/${member.to}/turns`, 'POST', { text, fromUser: true, coordination });
  assert.equal(automatic.status, 202);
  const automaticId = (await automatic.json() as { turnId: string }).turnId;
  const started = h.store.listTurnEvents(member.to, automaticId).find(event => event.type === 'turn.started')!;
  assert.notEqual(started.data.fromUser, true);
  assert.deepEqual(started.data.coordination, coordination);
  await wait(() => h.manager.threadView(member.to).status === 'idle', 'marked HTTP automatic input');
  for (const invalid of [null, 'message', {}, { ...coordination, messageId: 1 }, { ...coordination, from: null }, { ...coordination, kind: 'other' }]) {
    assert.equal((await h.api(`/api/threads/${member.to}/turns`, 'POST', { text, coordination: invalid })).status, 400);
  }
});

// Receiving automation rechecks the actual stored target after async preparation, unlike manual HTTP turns.
test('marked remote HTTP delivery rechecks disabled at its final claim after preparation', async t => {
  const h = await setup(t);
  const held = gate();
  let preparing = false;
  const preview = h.team.previewMentions.bind(h.team);
  h.team.previewMentions = async (id, text, mentions, options) => {
    const result = await preview(id, text, mentions, options);
    if (id === h.root.id && text === 'REMOTE_PREPARATION_GATE') { preparing = true; await held.promise; }
    return result;
  };
  let pending: Promise<Response> | undefined;
  try {
    pending = h.api(`/api/threads/${h.root.id}/turns`, 'POST', {
      text: 'REMOTE_PREPARATION_GATE', coordination: { messageId: 'gated-remote-task', from: 'remote-lead', kind: 'message' },
    });
    await wait(() => preparing, 'incoming remote preparation');
    await h.patch(h.root.id, true, { signal: AbortSignal.timeout(1500) });
    held.release();
    assert.equal((await pending).status, 409);
    assert.equal(starts(h, h.root.id).length, 0);
    assert.equal(h.manager.threadView(h.root.id).status, 'idle');
    assert.deepEqual(h.manager.threadView(h.root.id).queued, []);
    const manual = await h.api(`/api/threads/${h.root.id}/turns`, 'POST', { text: 'REMOTE_PREPARATION_GATE' });
    assert.equal(manual.status, 202, 'the same disabled target still accepts an unmarked human request');
  } finally { held.release(); await pending?.catch(() => undefined); }
});

// Idle remote members refresh their lightweight eligibility without fetching idle history or results.
test('idle remote member polling observes disable and enable without loading its history', async t => {
  const h = await setup(t);
  await h.team.enable(h.root.id);
  h.team.dispose();
  const row = savedTeam(h);
  row.members = [{ id: 'remote-member', name: 'remote-member', host: 'fixture-machine', agentRef: 'pi@fixture-machine' }];
  h.store.saveCoordination(h.root.id, JSON.stringify(row));
  await h.restart();
  let disabled = false, viewReads = 0, historyReads = 0;
  h.team.hosts = {
    list: () => [{ id: 'fixture-machine', label: 'Fixture', status: 'online' }],
    call: async <T,>(_host: string, method: string, path: string): Promise<T> => {
      assert.equal(method, 'GET', 'idle eligibility never starts a remote turn');
      if (path === '/api/threads/remote-member') {
        viewReads++;
        return { id: 'remote-member', agent: 'pi', cwd: h.cwd, status: 'idle', queued: [], disabled } as T;
      }
      if (path.includes('/events') || path.includes('/history')) { historyReads++; return [] as T; }
      if (path === '/api/agents') return [] as T;
      throw new Error(`unexpected remote request: ${path}`);
    },
    exec: async () => { throw new Error('idle eligibility never executes remote commands'); },
  };
  const poll = (h.team as unknown as { pollRemote(): Promise<void> }).pollRemote.bind(h.team);
  for (const value of [false, true, false]) {
    disabled = value;
    await poll();
    const view = h.team.view(h.root.id)!;
    assert.equal((view.members[0].thread as { disabled: boolean }).disabled, value);
    const status = await h.team.command(h.root.id, { op: 'status' }) as { members: Array<{ id: string }> };
    assert.equal(status.members.some(member => member.id === 'remote-member'), !value);
  }
  assert.ok(viewReads >= 3);
  assert.equal(historyReads, 0, 'refreshing an idle member does not fetch its event log or result body');
});

// Thread ids belong to their machines; another team's same-id member must never mask remote eligibility.
test('separate teams keep same-id remote members scoped to their exact hosts', async t => {
  const h = await setup(t);
  const other = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  const remoteId = 'shared-remote-member';
  h.team.dispose();
  for (const [rootId, host] of [[h.root.id, 'machine-a'], [other.id, 'machine-b']]) {
    h.store.saveCoordination(rootId, JSON.stringify({ rootId, enabled: true, paused: false,
      directories: [h.cwd], agents: ['pi'], deliveries: [], members: [{ id: remoteId, name: 'same-id-member', host }] }));
  }
  await h.restart();
  const switches: Record<string, boolean> = { 'machine-a': true, 'machine-b': false };
  h.team.hosts = {
    list: () => Object.keys(switches).map(id => ({ id, label: id, status: 'online' })),
    call: async <T,>(host: string, method: string, path: string): Promise<T> => {
      assert.equal(method, 'GET');
      assert.equal(path, `/api/threads/${remoteId}`);
      return { id: remoteId, agent: 'pi', cwd: h.cwd, status: 'idle', queued: [], disabled: switches[host] } as T;
    },
    exec: async () => { throw new Error('eligibility lookup never executes remote commands'); },
  };
  const poll = (h.team as unknown as { pollRemote(): Promise<void> }).pollRemote.bind(h.team);
  for (const invert of [false, true]) {
    switches['machine-a'] = !invert; switches['machine-b'] = invert;
    await poll();
    const a = h.team.view(h.root.id)!.members[0].thread as { disabled: boolean };
    const b = h.team.view(other.id)!.members[0].thread as { disabled: boolean };
    assert.equal(a.disabled, !invert);
    assert.equal(b.disabled, invert);
    const statusA = await h.team.command(h.root.id, { op: 'status' }) as { members: Array<{ id: string }> };
    const statusB = await h.team.command(other.id, { op: 'status' }) as { members: Array<{ id: string }> };
    assert.equal(statusA.members.length, invert ? 1 : 0);
    assert.equal(statusB.members.length, invert ? 0 : 1);
  }
});

// Each host's receipt must update its caller-owned team, even when a later refresh re-enables a withheld producer.
test('same-id remote receipts retain exact team results and suppression across a later eligibility refresh', async t => {
  const h = await setup(t);
  const other = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  const remoteId = 'shared-receipt-member';
  const roots = [h.root.id, other.id];
  const hosts = ['receipt-a', 'receipt-b'];
  h.team.dispose();
  for (const [index, rootId] of roots.entries()) {
    h.store.saveCoordination(rootId, JSON.stringify({ rootId, enabled: true, paused: true,
      directories: [h.cwd], agents: ['pi'], members: [{ id: remoteId, name: 'receipt-member', host: hosts[index] }],
      deliveries: [{ id: `receipt-job-${index}`, key: `receipt-job-${index}`, fingerprint: '', from: rootId, to: remoteId,
        text: `original receipt task ${index}`, kind: 'message', state: 'running', turnId: `receipt-turn-${index}`,
        result: '', createdAt: '2020-01-01T00:00:00.000Z' }] }));
  }
  await h.restart();
  clearInterval((h.team as unknown as { remoteTimer: ReturnType<typeof setInterval> }).remoteTimer);
  let withheld = true;
  const pages: Record<string, number[]> = { 'receipt-a': [], 'receipt-b': [] };
  h.team.hosts = {
    list: () => hosts.map(id => ({ id, label: id, status: 'online' })),
    call: async <T,>(host: string, method: string, path: string): Promise<T> => {
      assert.equal(method, 'GET', 'paused receipt recovery never starts or cancels a remote turn');
      const index = hosts.indexOf(host);
      assert.notEqual(index, -1);
      if (path === `/api/threads/${remoteId}`) return { id: remoteId, agent: 'pi', cwd: h.cwd,
        status: 'idle', queued: [], disabled: host === 'receipt-b' && withheld } as T;
      assert.ok(path.startsWith(`/api/threads/${remoteId}/events?after=`));
      const after = Number(path.split('after=')[1]);
      pages[host].push(after);
      if (after >= 3) {
        // Re-enable only after the receipt was confirmed disabled; final refresh must not erase that decision.
        if (host === 'receipt-b') withheld = false;
        return [] as T;
      }
      const base = { threadId: remoteId, turnId: `receipt-turn-${index}`, ts: '2020-01-01T00:00:01.000Z' };
      return [{ ...base, seq: 1, type: 'turn.started', data: { text: `remote task ${index}`, fromUser: false } },
        { ...base, seq: 2, type: 'message.delta', data: { text: index === 0 ? 'A_RECEIPT_SENTINEL' : 'B_RECEIPT_SENTINEL' } },
        { ...base, seq: 3, type: 'turn.done', data: { stopReason: 'completed' } }] as T;
    },
    exec: async () => { throw new Error('inline receipt recovery never executes a remote command'); },
  };
  await (h.team as unknown as { pollRemote(): Promise<void> }).pollRemote();
  for (const [index, rootId] of roots.entries()) {
    const row = savedTeam(h, rootId);
    assert.equal(row.paused, true);
    assert.equal(row.deliveries.length, 1, 'a paused task receives history without queuing a lead notification');
    const result = row.deliveries[0];
    assert.equal(result.id, `receipt-job-${index}`);
    assert.equal(result.turnId, `receipt-turn-${index}`);
    assert.equal(result.state, 'returned');
    assert.equal(result.result, index === 0 ? 'A_RECEIPT_SENTINEL' : 'B_RECEIPT_SENTINEL');
    assert.equal(result.suppressed === true, index === 1, 'only the exact team whose producer was disabled retains suppression');
    assert.deepEqual(pages[hosts[index]], [0, 3], 'same-id hosts own independent receipt cursors');
    assert.equal(starts(h, rootId).length, 0);
  }
  assert.equal(withheld, false, 'both producers are enabled at the final receipt refresh');
});

// Equal turn ids on different hosts are different streams; disabled partial output must not contaminate an enabled result.
test('same-id same-turn remote streams never merge disabled partial output into another host result', async t => {
  const h = await setup(t);
  const other = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  const remoteId = 'shared-stream-member';
  const turnId = 'shared-stream-turn';
  const roots = [h.root.id, other.id];
  const hosts = ['stream-a', 'stream-b'];
  h.team.dispose();
  for (const [index, rootId] of roots.entries()) {
    h.store.saveCoordination(rootId, JSON.stringify({ rootId, enabled: true, paused: true,
      directories: [h.cwd], agents: ['pi'], members: [{ id: remoteId, name: 'stream-member', host: hosts[index] }],
      deliveries: [{ id: `stream-job-${index}`, key: `stream-job-${index}`, fingerprint: '', from: rootId, to: remoteId,
        text: `original stream task ${index}`, kind: 'message', state: 'running', turnId,
        result: '', createdAt: '2020-01-01T00:00:00.000Z' }] }));
  }
  await h.restart();
  clearInterval((h.team as unknown as { remoteTimer: ReturnType<typeof setInterval> }).remoteTimer);
  const pages: Record<string, number[]> = { 'stream-a': [], 'stream-b': [] };
  h.team.hosts = {
    list: () => hosts.map(id => ({ id, label: id, status: 'online' })),
    call: async <T,>(host: string, method: string, path: string): Promise<T> => {
      assert.equal(method, 'GET', 'paused stream recovery never starts or cancels a remote turn');
      const index = hosts.indexOf(host);
      assert.notEqual(index, -1);
      if (path === `/api/threads/${remoteId}`) return { id: remoteId, agent: 'pi', cwd: h.cwd,
        status: index === 0 ? 'busy' : 'idle', queued: [], disabled: index === 0 } as T;
      assert.ok(path.startsWith(`/api/threads/${remoteId}/events?after=`));
      const after = Number(path.split('after=')[1]);
      pages[host].push(after);
      if (after > 0) return [] as T;
      const base = { threadId: remoteId, turnId, ts: '2020-01-01T00:00:01.000Z' };
      const events = [{ ...base, seq: 1, type: 'turn.started', data: { text: `remote stream task ${index}`, fromUser: false } },
        { ...base, seq: 2, type: 'message.delta', data: { text: index === 0 ? 'PRIVATE_DISABLED_PARTIAL_STREAM' : 'ENABLED_COMPLETE_STREAM' } }];
      return (index === 0 ? events : [...events, { ...base, seq: 3, type: 'turn.done', data: { stopReason: 'completed' } }]) as T;
    },
    exec: async () => { throw new Error('inline stream recovery never executes a remote command'); },
  };
  await (h.team as unknown as { pollRemote(): Promise<void> }).pollRemote();
  const a = savedTeam(h, roots[0]).deliveries;
  const b = savedTeam(h, roots[1]).deliveries;
  assert.equal(a.length, 1);
  assert.equal(a[0].state, 'running', 'another host ending its same-id turn cannot finish this partial stream');
  assert.equal(a[0].result, '');
  assert.equal(b.length, 1);
  assert.equal(b[0].state, 'returned');
  assert.equal(b[0].result, 'ENABLED_COMPLETE_STREAM');
  assert.doesNotMatch(b[0].result, /PRIVATE_DISABLED_PARTIAL_STREAM/);
  assert.notEqual(b[0].suppressed, true, 'the other host being disabled cannot suppress this enabled producer');
  assert.deepEqual(pages['stream-a'], [0, 2]);
  assert.deepEqual(pages['stream-b'], [0, 3]);
  assert.ok(roots.every(rootId => starts(h, rootId).length === 0));
});

// A local caller and its human receipt belong to the local seat, never an earlier foreign seat with the same id.
test('local member lookup ignores earlier same-id remote seats for disable, environment and human receipts', async t => {
  const h = await setup(t);
  const localRoot = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  const member = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
  await h.patch(member.id, true);
  h.team.dispose();
  h.store.saveCoordination(h.root.id, JSON.stringify({ rootId: h.root.id, enabled: true, paused: true,
    directories: [h.cwd], agents: ['pi'], deliveries: [], members: [{ id: member.id, name: 'foreign-seat', host: 'foreign-machine' }] }));
  h.store.saveCoordination(localRoot.id, JSON.stringify({ rootId: localRoot.id, enabled: true, paused: true,
    directories: [h.cwd], agents: ['pi'], deliveries: [], members: [{ id: member.id, name: 'local-seat' }] }));
  await h.restart();
  clearInterval((h.team as unknown as { remoteTimer: ReturnType<typeof setInterval> }).remoteTimer);
  assert.equal(h.store.coordinationRecords()[0].id, h.root.id, 'the foreign team is intentionally loaded first');
  h.team.hosts = {
    list: () => [{ id: 'foreign-machine', label: 'Foreign', status: 'online' }],
    call: async <T,>(_host: string, method: string, path: string): Promise<T> => {
      assert.equal(method, 'GET');
      assert.equal(path, `/api/threads/${member.id}`);
      return { id: member.id, agent: 'pi', cwd: h.cwd, status: 'idle', queued: [], disabled: false } as T;
    },
    exec: async () => { throw new Error('local identity lookup never executes a remote command'); },
  };
  await (h.team as unknown as { pollRemote(): Promise<void> }).pollRemote();
  const before = savedTeam(h);
  const environment = h.team.environment(member.id);
  const commandError = await h.team.command(member.id, { op: 'status' }).then(() => null, error => error);
  const response = await h.api(`/api/threads/${member.id}/turns`, 'POST', { text: 'LOCAL_RECEIPT_SENTINEL' });
  assert.equal(response.status, 202, 'actual local disable still permits an ordinary human turn');
  const { turnId } = await response.json() as { turnId: string };
  await wait(() => h.store.listTurnEvents(member.id, turnId).some(event => event.type === 'turn.done'), 'the local human receipt');
  await h.team.command(localRoot.id, { op: 'status' });
  assert.ok(blocked(commandError), 'remote false cannot authorize an actually disabled local caller');
  assert.equal(environment, undefined, 'disabled local callers never receive the foreign team credentials');
  const local = savedTeam(h, localRoot.id);
  const receipt = local.direct?.find((item: { turnId: string }) => item.turnId === turnId);
  assert.ok(receipt, 'the real local receipt is saved to its local team');
  assert.equal(receipt.to, member.id);
  assert.equal(receipt.told, true);
  assert.match(receipt.result, /LOCAL_RECEIPT_SENTINEL/);
  assert.deepEqual(savedTeam(h), before, 'the earlier remote team receives no local history or result');
  assert.deepEqual(local.deliveries, []);
  assert.equal(h.manager.threadView(member.id).disabled, true);
  assert.equal(starts(h, h.root.id).length + starts(h, localRoot.id).length, 0);
});

// Existing ambiguous ids remain readable, but commands reject them and the local root flag always comes from Store.
test('actual local root flag wins a same-id remote collision and ambiguous commands are rejected', async t => {
  const h = await setup(t);
  h.team.dispose();
  h.store.saveCoordination(h.root.id, JSON.stringify({ rootId: h.root.id, enabled: true, paused: false,
    directories: [h.cwd], agents: ['pi'], deliveries: [], members: [{ id: h.root.id, name: 'colliding-member', host: 'collision-machine' }] }));
  await h.restart();
  let disabled = true;
  h.team.hosts = {
    list: () => [{ id: 'collision-machine', label: 'Collision', status: 'online' }],
    call: async <T,>(_host: string, method: string, path: string): Promise<T> => {
      assert.equal(method, 'GET');
      assert.equal(path, `/api/threads/${h.root.id}`);
      return { id: h.root.id, agent: 'pi', cwd: h.cwd, status: 'idle', queued: [], disabled } as T;
    },
    exec: async () => { throw new Error('ambiguous eligibility never executes a remote command'); },
  };
  const poll = (h.team as unknown as { pollRemote(): Promise<void> }).pollRemote.bind(h.team);
  await poll();
  assert.equal((h.team.view(h.root.id)!.members[0].thread as { disabled: boolean }).disabled, true);
  assert.equal(h.manager.threadView(h.root.id).disabled, false);
  await assert.rejects(h.team.command(h.root.id, { op: 'status' }),
    error => blocked(error) && /ID 冲突/.test((error as Error).message), 'remote disabled cannot mask the enabled local root');
  disabled = false;
  await h.patch(h.root.id, true);
  await poll();
  assert.equal((h.team.view(h.root.id)!.members[0].thread as { disabled: boolean }).disabled, false);
  await assert.rejects(h.team.command(h.root.id, { op: 'status' }),
    error => error instanceof HttpError && error.status === 409 && error.details?.code === 'coordination_disabled',
    'remote enabled cannot mask the actual disabled local root');
  assert.equal(starts(h, h.root.id).length, 0);
  assert.equal(savedTeam(h).members[0].id, h.root.id, 'rejecting ambiguity does not delete historical membership');
});

// A local notification must refresh its remote producer after async preparation, not trust the pump's old view.
test('preparing local result rechecks the actual remote producer before claiming the lead turn', async t => {
  const h = await setup(t);
  await h.team.enable(h.root.id);
  h.team.dispose();
  const row = savedTeam(h);
  row.paused = true;
  row.members = [{ id: 'remote-producer', name: 'remote-producer', host: 'producer-machine' }];
  row.deliveries = [{ id: 'remote-result', key: 'remote-result', fingerprint: '', from: 'remote-producer', to: h.root.id,
    text: 'PRIVATE_REMOTE_PRODUCER_RESULT', kind: 'result', state: 'queued', turnId: null, result: '', createdAt: '2020-01-01T00:00:00.000Z' }];
  h.store.saveCoordination(h.root.id, JSON.stringify(row));
  await h.restart();
  // Disable periodic polling so only the final delivery refresh can observe this fixture's remote switch.
  clearInterval((h.team as unknown as { remoteTimer: ReturnType<typeof setInterval> }).remoteTimer);
  let disabled = false, reads = 0, preparing = false;
  h.team.hosts = {
    list: () => [{ id: 'producer-machine', label: 'Producer', status: 'online' }],
    call: async <T,>(_host: string, method: string, path: string): Promise<T> => {
      assert.equal(method, 'GET');
      assert.equal(path, '/api/threads/remote-producer');
      reads++;
      return { id: 'remote-producer', agent: 'pi', cwd: h.cwd, status: 'idle', queued: [], disabled } as T;
    },
    exec: async () => { throw new Error('local result delivery never executes a remote command'); },
  };
  const held = gate();
  const preview = h.team.previewMentions.bind(h.team);
  h.team.previewMentions = async (id, text, mentions, options) => {
    const result = await preview(id, text, mentions, options);
    if (id === h.root.id && text.includes('PRIVATE_REMOTE_PRODUCER_RESULT')) { preparing = true; await held.promise; }
    return result;
  };
  try {
    await h.team.resume(h.root.id);
    await wait(() => preparing && reads > 0, 'local result preparation after the first remote eligibility read');
    const initialReads = reads;
    disabled = true;
    held.release();
    await h.team.command(h.root.id, { op: 'status' });
    const result = savedTeam(h).deliveries.find((delivery: { id: string }) => delivery.id === 'remote-result');
    assert.equal(result.state, 'stopped');
    assert.equal(result.suppressed, true);
    assert.equal(result.text, 'PRIVATE_REMOTE_PRODUCER_RESULT');
    assert.equal(result.turnId, null);
    assert.equal(starts(h, h.root.id).length, 0, 'a later status refresh cannot undo an incorrectly claimed lead turn');
    assert.ok(reads > initialReads, 'the actual remote producer is refreshed again after preparation');
  } finally { held.release(); }
});

for (const targetKind of ['native', 'fallback'] as const) for (const phase of ['discovery', 'runtime'] as const) {
  // An implicit voice enable that loses its race to PATCH must still open media without persisting collaboration.
  test(`${targetKind} voice disable during implicit enable ${phase} keeps the human connection and never activates collaboration`, async t => {
    const h = await setup(t, true);
    const target = targetKind === 'native' ? await h.manager.createThread({ agent: 'speaker', cwd: h.cwd }) : h.root;
    const held = gate();
    let preparing = false;
    if (phase === 'discovery') {
      const internal = h.team as unknown as { prepare(id: string, input?: unknown): Promise<unknown> };
      const prepare = internal.prepare.bind(internal);
      internal.prepare = async (id, input) => {
        const result = await prepare(id, input);
        if (id === target.id) { preparing = true; await held.promise; }
        return result;
      };
    } else {
      const refresh = h.manager.refreshRuntime.bind(h.manager);
      h.manager.refreshRuntime = async id => {
        await refresh(id);
        if (id === target.id) { preparing = true; await held.promise; }
      };
    }
    const signals: VoiceSignal[] = [];
    const voice = h.manager.voiceTransport(target.id, () => {}, targetKind === 'fallback' ? 'speaker' : undefined);
    let opening: Promise<void> | undefined;
    try {
      opening = voice.start('fixture-offer', signal => signals.push(signal));
      void opening.catch(() => undefined);
      await wait(() => preparing, 'implicit voice enable await gate');
      await h.patch(target.id, true, { signal: AbortSignal.timeout(1500) });
      held.release();
      await opening;
      await wait(() => signals.some(signal => signal.type === 'sdp' && signal.sdp === 'fixture-answer')
        && signals.some(signal => signal.type === 'transcript' && signal.final && signal.role === 'assistant'), 'human voice after the disable race');
      assert.equal(h.manager.threadView(target.id).disabled, true);
      assert.equal(h.team.enabled(target.id), false);
      assert.equal(h.team.leads(target.id), false);
      const record = h.store.coordinationRecords().find(item => item.id === target.id);
      if (record) assert.equal(JSON.parse(record.data).enabled, false, 'implicit enable may leave only inert configuration');
      await voice.appendText!('human voice after racing disable');
      await wait(() => signals.some(signal => signal.type === 'transcript' && signal.text === 'human voice after racing disable'), 'voice input after the race');
      await voice.stop('shutdown');
      assert.equal(starts(h, target.id).length, 0);
    } finally { held.release(); await opening?.catch(() => undefined); voice.dispose(); }
  });
}

for (const action of ['resume', 'userSpoke'] as const) {
  // Continuation may name a closed delegation, but it must never recover text from a suppressed result.
  test(`team ${action} excludes suppressed result text from continuation notices and the next lead prompt`, async t => {
    const h = await setup(t);
    const definition = h.team.definitions.save(await h.team.definitions.template());
    const { threadId } = await h.team.definitions.dispatch({ teamId: definition.id, text: 'TEAM_SHORT', cwd: h.cwd, source: { kind: 'http' } });
    await wait(() => h.team.view(threadId)?.team?.status === 'awaiting_confirm'
      && h.manager.threadView(threadId).status === 'idle', 'the original reusable team task');
    h.team.dispose();
    const row = savedTeam(h, threadId);
    const member = row.members.find((item: { name: string }) => item.name === 'dev');
    const delivery = row.deliveries.find((item: { to: string; kind: string }) => item.to === member.id && item.kind === 'message');
    assert.ok(delivery, 'the fixture completed a real delegation before seeding its withheld history');
    delivery.suppressed = true;
    delivery.result = 'PRIVATE_SUPPRESSED_CONTINUATION_RESULT';
    row.deliveries = [delivery];
    row.paused = true;
    row.team.status = 'needs_attention';
    row.team.resultTurnId = null;
    row.team.delegations = [{ from: 'lead', to: 'dev', deliveryId: delivery.id, closed: false }];
    delete row.team.continuationNotices;
    h.store.saveCoordination(threadId, JSON.stringify(row));
    await h.restart();
    await h.team[action](threadId);
    const continued = h.team.view(threadId)!;
    assert.equal(continued.team!.delegations[0].closed, true);
    assert.doesNotMatch(JSON.stringify(continued.team!.continuationNotices ?? []), /PRIVATE_SUPPRESSED_CONTINUATION_RESULT/);
    assert.doesNotMatch(h.team.instructions(threadId, 'safe continuation preview'), /PRIVATE_SUPPRESSED_CONTINUATION_RESULT/);
    const response = await h.api(`/api/threads/${threadId}/turns`, 'POST', { text: 'TEAM_FINISH' });
    assert.equal(response.status, 202);
    const { turnId } = await response.json() as { turnId: string };
    const prompt = h.store.listTurnEvents(threadId, turnId).find(event => event.type === 'turn.started')!;
    assert.doesNotMatch(String(prompt.data.text), /PRIVATE_SUPPRESSED_CONTINUATION_RESULT/);
    const history = savedTeam(h, threadId).deliveries.find((item: { id: string }) => item.id === delivery.id);
    assert.equal(history.suppressed, true);
    assert.equal(history.result, 'PRIVATE_SUPPRESSED_CONTINUATION_RESULT', 'the excluded text remains in manual history');
  });
}

// Stored notices from old versions may carry result payloads; previews and the next real prompt expose only closure context.
test('legacy continuation notices never replay stored payloads in views, CLI status or the next lead prompt', async t => {
  const h = await setup(t);
  const definition = h.team.definitions.save(await h.team.definitions.template());
  const { threadId } = await h.team.definitions.dispatch({ teamId: definition.id, text: 'TEAM_SHORT', cwd: h.cwd, source: { kind: 'http' } });
  await wait(() => h.team.view(threadId)?.team?.status === 'awaiting_confirm'
    && h.manager.threadView(threadId).status === 'idle', 'the original task before restoring legacy notices');
  h.team.dispose();
  const row = savedTeam(h, threadId);
  const member = row.members.find((item: { name: string }) => item.name === 'dev');
  const delivery = row.deliveries.find((item: { to: string; kind: string }) => item.to === member.id && item.kind === 'message');
  assert.ok(delivery);
  delivery.suppressed = true;
  delivery.result = 'PRIVATE_LEGACY_NOTICE_PAYLOAD';
  row.deliveries = [delivery];
  row.paused = true;
  row.team.status = 'needs_attention';
  row.team.resultTurnId = null;
  row.team.delegations = [{ from: 'lead', to: 'dev', deliveryId: delivery.id, closed: true }];
  row.team.continuationNotices = ['dev（已返回但未送达：PRIVATE_LEGACY_NOTICE_PAYLOAD）'];
  h.store.saveCoordination(threadId, JSON.stringify(row));
  await h.restart();
  assert.doesNotMatch(JSON.stringify(h.team.view(threadId)!.team!.continuationNotices), /PRIVATE_LEGACY_NOTICE_PAYLOAD/);
  assert.doesNotMatch(h.team.instructions(threadId, 'legacy continuation preview'), /PRIVATE_LEGACY_NOTICE_PAYLOAD/);
  const status = await h.team.command(threadId, { op: 'status' });
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_LEGACY_NOTICE_PAYLOAD/);
  const response = await h.api(`/api/threads/${threadId}/turns`, 'POST', { text: 'TEAM_FINISH' });
  assert.equal(response.status, 202);
  const { turnId } = await response.json() as { turnId: string };
  const prompt = h.store.listTurnEvents(threadId, turnId).find(event => event.type === 'turn.started')!;
  assert.doesNotMatch(String(prompt.data.text), /PRIVATE_LEGACY_NOTICE_PAYLOAD/);
  const history = savedTeam(h, threadId).deliveries.find((item: { id: string }) => item.id === delivery.id);
  assert.equal(history.suppressed, true);
  assert.equal(history.result, 'PRIVATE_LEGACY_NOTICE_PAYLOAD', 'normalizing old notices never rewrites the stored result');
});

// Native voice executes in its own disabled conversation without activating a configuration-only team.
test('disabled configured native voice conversation receives task output and still accepts manual text', async t => {
  const h = await setup(t, true, { FAKE_CODEX_VOICE_TASK: 'NATIVE_HUMAN_VOICE_TASK' });
  const target = await h.manager.createThread({ agent: 'speaker', cwd: h.cwd });
  h.team.dispose();
  h.store.saveCoordination(target.id, JSON.stringify({ rootId: target.id, enabled: false, paused: false,
    directories: [h.cwd], agents: ['pi', 'speaker'], members: [], deliveries: [] }));
  await h.restart();
  await h.patch(target.id, true);
  const signals: VoiceSignal[] = [];
  const voice = h.manager.voiceTransport(target.id);
  try {
    await voice.start('fixture-offer', signal => signals.push(signal));
    await wait(() => h.store.listEventsOfType(target.id, 'message.delta').map(event => event.data.text).join('').includes('NATIVE_HUMAN_VOICE_TASK')
      && h.store.listEventsOfType(target.id, 'turn.done').length > 0, 'native human voice task output');
    assert.ok(signals.some(signal => signal.type === 'sdp' && signal.sdp === 'fixture-answer'));
    await voice.appendText!('manual native voice text while disabled');
    await wait(() => signals.some(signal => signal.type === 'transcript' && signal.text === 'manual native voice text while disabled'), 'native human voice text');
    assert.equal(h.manager.threadView(target.id).disabled, true);
    assert.equal(savedTeam(h, target.id).enabled, false);
    assert.deepEqual(savedTeam(h, target.id).deliveries, []);
    // Close the fixture without starting an unrelated end-of-voice summary before the manual lock check.
    await voice.stop('shutdown');
    const response = await h.api(`/api/threads/${target.id}/turns`, 'POST', { text: 'manual text after native voice' });
    assert.equal(response.status, 202);
    const { turnId } = await response.json() as { turnId: string };
    await wait(() => h.store.listTurnEvents(target.id, turnId).some(event => event.type === 'turn.done'), 'manual native target text after voice');
    assert.equal((await h.api(`/api/threads/${target.id}/history`)).status, 200);
    assert.equal(savedTeam(h, target.id).enabled, false);
    assert.deepEqual(savedTeam(h, target.id).deliveries, []);
  } finally { voice.dispose(); }
});

// Fallback voice is a human connection, but opening it must not activate an inert collaboration mailbox.
test('disabled configured Pi conversation retains manual voice captions, appendText and text history', async t => {
  const h = await setup(t, true);
  h.team.dispose();
  h.store.saveCoordination(h.root.id, JSON.stringify({ rootId: h.root.id, enabled: false, paused: false,
    directories: [h.cwd], agents: ['pi', 'speaker'], members: [], deliveries: [] }));
  await h.restart();
  await h.patch(h.root.id, true);
  const first = await h.manager.startTurn(h.root.id, { text: 'existing text conversation', fromUser: true });
  assert.ok('turnId' in first);
  await wait(() => h.manager.threadView(h.root.id).status === 'idle', 'existing text turn');
  const nativeId = h.manager.threadView(h.root.id).agentSessionId;
  const signals: VoiceSignal[] = [];
  const voice = h.manager.voiceTransport(h.root.id, () => {}, 'speaker');
  try {
    await voice.start('fixture-offer', signal => signals.push(signal));
    await wait(() => signals.some(signal => signal.type === 'sdp' && signal.sdp === 'fixture-answer')
      && signals.some(signal => signal.type === 'transcript' && signal.final && signal.role === 'assistant'), 'fallback voice answer and final transcript');
    assert.equal(h.manager.threadView(h.root.id).disabled, true);
    assert.equal(h.manager.threadView(h.root.id).agentSessionId, nativeId);
    assert.equal(h.manager.threadView(h.root.id).agent, 'pi');
    assert.equal(savedTeam(h).enabled, false);
    assert.deepEqual(savedTeam(h).deliveries, []);
    await voice.appendText!('manual voice input while disabled');
    await wait(() => signals.some(signal => signal.type === 'transcript' && signal.text === 'manual voice input while disabled'), 'human fallback voice text');
    await voice.stop('shutdown');
    assert.ok(h.store.listEventsOfType(h.root.id, 'voice.message').some(event => event.data.final && event.data.role === 'assistant'));
    assert.equal((await h.api(`/api/threads/${h.root.id}/history`)).status, 200);
    assert.equal(h.store.listTurnEvents(h.root.id, first.turnId).some(event => event.type === 'turn.done'), true);
    assert.equal(starts(h, h.root.id).length, 1, 'captions and appendText do not become automatic target turns');
    assert.equal(savedTeam(h).enabled, false);
    assert.deepEqual(savedTeam(h).deliveries, []);
  } finally { voice.dispose(); }
});

// An actual voice-delegate CLI send remains automation; a persisted voiceTarget is not a disable bypass.
test('fallback voice-delegate automatic send cannot reach a disabled target', async t => {
  const h = await setup(t, true, { FAKE_CODEX_VOICE_TASK: 'voice-delegate', FAKE_CODEX_VOICE_MESSAGE: 'VOICE_AUTOMATION_BLOCKED' });
  await h.team.enable(h.root.id);
  const held = gate();
  let sending = false, rejected = false;
  const command = h.team.command.bind(h.team);
  h.team.command = async (caller, input) => {
    const delegation = input.op === 'send' && input.target === h.root.id && input.text === 'VOICE_AUTOMATION_BLOCKED';
    if (delegation) { sending = true; await held.promise; }
    try { return await command(caller, input); }
    catch (error) {
      if (delegation && blocked(error)) rejected = true;
      throw error;
    }
  };
  const voice = h.manager.voiceTransport(h.root.id, () => {}, 'speaker');
  try {
    await voice.start('fixture-offer', () => {});
    await wait(() => sending, 'real voice-delegate CLI send with existing collaboration credentials');
    assert.ok(h.team.view(h.root.id)!.members.some(member => member.voiceTarget === h.root.id));
    // Exit after the voice helper obtained its old environment, but before the actual command checks its target.
    await h.patch(h.root.id, true);
    held.release();
    await wait(() => rejected, 'real voice-delegate CLI send rejected by target eligibility');
    assert.equal(h.manager.threadView(h.root.id).disabled, true);
    assert.equal(starts(h, h.root.id).length, 0);
    assert.deepEqual(h.manager.threadView(h.root.id).queued, []);
    assert.ok(savedTeam(h).deliveries.every((delivery: { kind: string; state: string; suppressed?: boolean; turnId: string | null }) =>
      delivery.kind === 'result' && delivery.state === 'stopped' && delivery.suppressed === true && delivery.turnId === null),
    'a fixture exit may leave withheld failure history, but never an executable target delivery');
  } finally { held.release(); voice.dispose(); }
});
