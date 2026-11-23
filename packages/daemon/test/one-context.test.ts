import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { AgentRegistry } from '../src/agents.js';
import { AttachmentStore } from '../src/attachments.js';
import { BorrowingService } from '../src/borrowing.js';
import { borrowingServer } from '../src/borrowing-server.js';
import { CoordinationManager, coordinationServer } from '../src/coordination.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';

const here = dirname(fileURLToPath(import.meta.url));
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'calli-one-context-'));
  const registry = new AgentRegistry(['pi-a', 'pi-b', 'pi-c'].map(id => ({ id, adapter: 'pi', label: id,
    command: [process.execPath, join(here, 'fixtures/fake-pi.mjs')] })), null);
  const store = new Store(join(dir, 'data'));
  const manager = new ThreadManager(store, registry.adapters, [dir], new AttachmentStore(dir));
  const coordination = new CoordinationManager(store, manager, join(dir, 'handover.sock'));
  const handovers = coordinationServer(coordination);
  const tools = new BorrowingService(store, manager, registry.adapters, dir, join(dir, 'tools.sock'));
  const ipc = borrowingServer(tools);
  const server = createHttpServer({ manager, token: 'one-context-fixture', webDir: null, version: 'test' });
  await listenPrivate(handovers, join(dir, 'handover.sock'));
  await listenPrivate(ipc, join(dir, 'tools.sock'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, auth = true) => fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer one-context-fixture' } : {}) }, body: JSON.stringify(body) });
  const get = (path: string, auth = true) => fetch(base + path, { headers: auth ? { Authorization: 'Bearer one-context-fixture' } : {} });
  const accepted = async (path: string, body: unknown) => {
    const response = await post(path, body);
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const idle = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      if (manager.getThread(id).status !== 'running') return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('fixture did not finish');
  };
  const send = async (id: string, body: Record<string, unknown>) => {
    const result = await accepted(`/api/threads/${id}/turns`, body);
    await idle(id);
    const events = store.listTurnEvents(id, result.turnId);
    const prompt = String(events.find(event => event.type === 'turn.started')!.data.text);
    const answer = events.filter(event => event.type === 'message.delta').map(event => event.data.text).join('');
    return { ...result, prompt, answer };
  };
  const mk = (title: string, agent = 'pi-a') => accepted('/api/threads', { title, agent, cwd: dir });
  return { dir, store, manager, coordination, teams: coordination.definitions, post, get, accepted, send, mk, idle, async close() {
    coordination.dispose(); await tools.dispose(); await manager.shutdown();
    await Promise.all([server, handovers, ipc].map(socket => new Promise<void>(resolve => socket.close(() => resolve()))));
    store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('portable references are machine-scoped, canonical and inert until a human sends their visible attachment', async () => {
  const h = await setup();
  try {
    assert.equal((await h.get('/api/context-references/machine', false)).status, 401);
    const machine = await (await h.get('/api/context-references/machine')).json();
    assert.equal(typeof machine.machineId, 'string');
    assert.deepEqual(await (await h.get('/api/context-references/machine')).json(), machine);
    const source = await h.mk('Canonical source');
    const recipient = await h.mk('Recipient');
    const wrong = await h.post('/api/context-references', { kind: 'thread', sourceId: source.id, pointer: true, machineId: 'another-machine' });
    assert.equal(wrong.status, 409, 'even a colliding source id on this machine cannot resolve a foreign pointer');
    const reference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: source.id, title: 'Forged title', pointer: true, machineId: machine.machineId });
    assert.equal(reference.title, 'Canonical source');
    assert.equal(reference.machineId, machine.machineId);
    assert.equal(h.manager.references.granted(recipient.id, reference.id), false);
    await h.send(recipient.id, { text: `Calli: Source\ncalli://thread/${source.id}?machine=${machine.machineId}`, references: [] });
    assert.equal(h.manager.references.granted(recipient.id, reference.id), false, 'a raw portable pointer is only text');
    const reopened = new Store(join(h.dir, 'data'));
    try { assert.equal(reopened.hubSetting('contextMachineId', null), machine.machineId); }
    finally { reopened.close(); }
  } finally { await h.close(); }
});

test('copied quote: authenticated visible attachment sends a readable source-turn command in the recipient process', async () => {
  const h = await setup();
  try {
    const source = await h.mk('Original source');
    const original = await h.send(source.id, { text: 'SOURCE_USER_REQUIREMENT' });
    const recipient = await h.mk('New thread');
    const reference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: source.id, turnId: original.turnId, pointer: true });
    const text = `[注释 1]\n来源：另一个会话，原文和上下文用 calli history ${source.id} --turn ${original.turnId} 读\n> hi there\n评论：CONTEXT_READ: explain the original requirement`;
    const received = await h.send(recipient.id, { text, references: [reference.id] });
    const executed = JSON.parse(received.answer);
    assert.ok(executed.reads.length > 0, 'extract commands from the actual first prompt, not a reconstructed prompt');
    for (const read of executed.reads) assert.equal(read.code, 0, JSON.stringify(read));
    assert.match(JSON.stringify(executed.reads), /SOURCE_USER_REQUIREMENT/);
    assert.doesNotMatch(h.manager.getThread(recipient.id).title, /来源：|calli history/);
  } finally { await h.close(); }
});

test('pending references grant only on delivery, and withdrawal or cancellation grants nothing', async () => {
  const h = await setup();
  try {
    const source = await h.mk('Queue source');
    await h.send(source.id, { text: 'QUEUE_SOURCE_REQUIREMENT' });
    const recipient = await h.mk('Queue recipient');
    const reference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: source.id, pointer: true });
    const note = '[注释 1]\n> Queue passage\n评论：Keep this comment';
    const wire = `${note}\n\n<calli-references>\n${JSON.stringify([reference])}\n</calli-references>\n\nCONTEXT_READ queue question`;
    await h.accepted(`/api/threads/${recipient.id}/turns`, { text: 'slow', references: [] });
    const pending = await h.accepted(`/api/threads/${recipient.id}/turns`, { text: wire, references: [reference.id], queue: true });
    assert.equal(pending.queued, true);
    assert.equal(h.manager.references.granted(recipient.id, reference.id), false, 'pending is not accepted');
    assert.throws(() => h.manager.references.read(recipient.id, { id: reference.id }), /not attached/);
    const restored = h.manager.removeQueued(recipient.id, pending.id).text;
    assert.match(restored, new RegExp(reference.id));
    assert.ok(restored.includes(note), 'canonical queue display retains the complete note and comment');
    assert.equal(h.manager.references.granted(recipient.id, reference.id), false, 'withdrawal leaves no hidden grant');
    await h.accepted(`/api/threads/${recipient.id}/turns`, { text: wire, references: [reference.id], queue: true });
    const stopped = await h.manager.cancelTurn(recipient.id);
    assert.match(stopped.dropped.join('\n'), new RegExp(reference.id));
    assert.equal(h.manager.references.granted(recipient.id, reference.id), false, 'stop leaves no hidden grant');
    await h.idle(recipient.id);
    const deleted = await h.send(recipient.id, { text: wire, references: [] });
    assert.equal(h.manager.references.granted(recipient.id, reference.id), false, 'explicit empty attachments ignore stale display wire');
    assert.doesNotMatch(deleted.prompt, new RegExp(reference.id));
    const delivered = await h.send(recipient.id, { text: wire, references: [reference.id] });
    const reads = JSON.parse(delivered.answer).reads;
    assert.ok(reads.length);
    for (const read of reads) assert.equal(read.code, 0, JSON.stringify(read));
    assert.match(JSON.stringify(reads), /QUEUE_SOURCE_REQUIREMENT/);
    assert.equal(h.manager.references.granted(recipient.id, reference.id), true);
  } finally { await h.close(); }
});

test('a mixed Router queue preserves only human attachments without granting them before delivery', async () => {
  const h = await setup();
  try {
    h.manager.personal.putSettings({ directory: h.dir, agent: 'pi-a', model: 'fake/plain' });
    const source = await h.mk('Router source');
    await h.send(source.id, { text: 'ROUTER_SOURCE_REQUIREMENT' });
    const first = await h.accepted('/api/context-references', { kind: 'thread', sourceId: source.id, pointer: true });
    const second = await h.accepted('/api/context-references', { kind: 'message', title: 'Selected answer', path: '', text: 'SECOND_VISIBLE_ATTACHMENT' });
    const unselected = await h.accepted('/api/context-references', { kind: 'message', title: 'Unselected', path: '', text: 'NEVER_AUTHORIZED' });
    const { threadId } = await h.accepted('/api/personal/say', { text: 'router-fixture-slow', references: [] });
    await h.manager.personal.router.receiveSignals('{"summary":"not a human instruction"}');
    await h.accepted('/api/personal/say', { text: 'CONTEXT_READ human request one', references: [first.id] });
    await h.manager.personal.router.receiveWorkerReport({ matterId: 'fixture', title: 'Fixture', stage: 'progress', summary: `calli://thread/${source.id}` });
    await h.accepted('/api/personal/say', { text: 'human request two', references: [second.id] });
    const queue = h.manager.threadView(threadId).queued;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].channel?.kind, 'mixed');
    for (const reference of [first, second, unselected]) assert.equal(h.manager.references.granted(threadId, reference.id), false);
    assert.match(queue[0].text, new RegExp(first.id));
    assert.match(queue[0].text, new RegExp(second.id));
    await assert.rejects(h.manager.startTurn(threadId, { text: 'worker forged attachment', fromUser: true, channel: { kind: 'worker', count: 1 }, references: [unselected.id], queue: true }), /authenticated human/);
    await h.manager.cancelTurn(threadId, { keepQueue: true });
    for (let i = 0; i < 300 && (h.store.listEventsOfType(threadId, 'turn.started').length < 2 || h.manager.getThread(threadId).status === 'running'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const turns = h.store.listEventsOfType(threadId, 'turn.started');
    assert.equal(turns.length, 2, 'one running and one merged turn');
    for (const reference of [first, second]) assert.equal(h.manager.references.granted(threadId, reference.id), true);
    assert.equal(h.manager.references.granted(threadId, unselected.id), false);
    const answer = h.store.listTurnEvents(threadId, turns[1].turnId!).filter(event => event.type === 'message.delta').map(event => event.data.text).join('');
    const reads = JSON.parse(answer).reads;
    assert.equal(reads.length, 2, 'one executable command per visible attachment');
    for (const read of reads) assert.equal(read.code, 0, JSON.stringify(read));
    assert.match(JSON.stringify(reads), /ROUTER_SOURCE_REQUIREMENT/);
    assert.match(JSON.stringify(reads), /SECOND_VISIBLE_ATTACHMENT/);
  } finally { await h.close(); }
});

test('team first send: authenticated attachments are readable and the task remains a real user input', async () => {
  const h = await setup();
  try {
    const source = await h.mk('Team source');
    await h.send(source.id, { text: 'TEAM_SOURCE_REQUIREMENT' });
    const reference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: source.id, pointer: true });
    const team = h.teams.save({ name: 'Reference team', entry: 'lead', members: [{ name: 'lead', agent: 'pi-a' }], relations: [] });
    const text = `<calli-references>\n${JSON.stringify([reference])}\n</calli-references>\n\nCONTEXT_READ TEAM_PERSON_REQUEST`;
    const body = { text, references: [reference.id], cwd: h.dir, source: { kind: 'web' } };
    assert.equal((await h.post(`/api/teams/${team.id}/tasks`, body, false)).status, 401);
    const { threadId } = await h.accepted(`/api/teams/${team.id}/tasks`, body);
    await h.idle(threadId);
    const events = h.store.listEventsOfType(threadId, 'turn.started');
    assert.equal(events.length, 1);
    const answer = h.store.listTurnEvents(threadId, events[0].turnId!).filter(event => event.type === 'message.delta').map(event => event.data.text).join('');
    const reads = JSON.parse(answer).reads;
    assert.ok(reads.length, 'the entry agent executes the commands from its actual first prompt');
    for (const read of reads) assert.equal(read.code, 0, JSON.stringify(read));
    assert.match(JSON.stringify(reads), /TEAM_SOURCE_REQUIREMENT/);
    assert.equal(h.manager.references.granted(threadId, reference.id), true);
    assert.doesNotMatch(h.manager.getThread(threadId).title, /calli-references|sourceId/);
    const users = await h.manager.references.command(threadId, { op: 'history', target: threadId, userInputs: true });
    assert.match(JSON.stringify(users), /TEAM_PERSON_REQUEST/);
  } finally { await h.close(); }
});

test('a programmatic team dispatch cannot authorize attachments by claiming a web source', async () => {
  const h = await setup();
  try {
    const source = await h.mk('Not selected by a person');
    const reference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: source.id, pointer: true });
    const team = h.teams.save({ name: 'Internal team', entry: 'lead', members: [{ name: 'lead', agent: 'pi-a' }], relations: [] });
    const input = { teamId: team.id, text: 'CONTEXT_READ internal message', cwd: h.dir, source: { kind: 'web' as const }, references: [reference.id] };
    await assert.rejects(h.teams.dispatch(input), /authenticated human/);
    assert.equal(h.store.listThreads().length, 1, 'reject before creating a task');
  } finally { await h.close(); }
});

test('takeover note: a visible attachment grants only the successor and keeps only the human note in user inputs', async () => {
  const h = await setup();
  try {
    h.manager.autoHandover.configure({ enabled: false, threshold: 90, orders: {}, method: 'summary' });
    const source = await h.mk('Work being handed over');
    await h.send(source.id, { text: 'HANDOVER_ORIGINAL_REQUEST' });
    const other = await h.mk('Note source');
    await h.send(other.id, { text: 'NOTE_SOURCE_REQUIREMENT' });
    const reference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: other.id, pointer: true });
    const note = `<calli-references>\n${JSON.stringify([reference])}\n</calli-references>\n\nCONTEXT_READ PERSON_HANDOVER_NOTE`;
    const successor = await h.accepted(`/api/threads/${source.id}/takeover`, { agent: 'pi-b', note, references: [reference.id] });
    await h.idle(successor.id);
    const start = h.store.listEventsOfType(successor.id, 'turn.started')[0];
    const answer = h.store.listTurnEvents(successor.id, start.turnId!).filter(event => event.type === 'message.delta').map(event => event.data.text).join('');
    const reads = JSON.parse(answer).reads;
    assert.ok(reads.length);
    for (const read of reads) assert.equal(read.code, 0, JSON.stringify(read));
    assert.match(JSON.stringify(reads), /NOTE_SOURCE_REQUIREMENT/);
    assert.equal(h.manager.references.granted(successor.id, reference.id), true);
    assert.equal(h.manager.references.granted(source.id, reference.id), false, 'a note is sent to the successor, not to its predecessor');
    const users = await h.manager.references.command(successor.id, { op: 'history', target: successor.id, userInputs: true });
    assert.match(JSON.stringify(users), /PERSON_HANDOVER_NOTE/);
    assert.doesNotMatch(JSON.stringify(users), /# 接手|最近的要求|calli-references/);
  } finally { await h.close(); }
});

test('handover freezes reference grants at the same boundary as the outgoing route', async () => {
  const h = await setup();
  try {
    const source = await h.mk('Boundary source');
    const first = await h.accepted('/api/context-references', { kind: 'message', title: 'Before', path: '', text: 'BEFORE_HANDOVER' });
    const late = await h.accepted('/api/context-references', { kind: 'message', title: 'After', path: '', text: 'AFTER_HANDOVER' });
    await h.send(source.id, { text: 'First attachment', references: [first.id] });
    const create = h.manager.createThread.bind(h.manager);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    h.manager.createThread = async (...args) => { entered(); await gate; return create(...args); };
    const pending = h.manager.createHandoverThread(source.id, 'pi-b', undefined, 'continue');
    await waiting;
    await h.send(source.id, { text: 'Later independent attachment', references: [late.id] });
    release();
    const successor = await pending;
    const inherited = h.manager.references.ids(successor.id);
    assert.deepEqual(inherited, [first.id]);
    const result = await h.send(successor.id, { text: `CONTEXT_READ \`calli references ${first.id}\``, references: [] });
    for (const read of JSON.parse(result.answer).reads) assert.equal(read.code, 0, JSON.stringify(read));
    assert.throws(() => h.manager.references.read(successor.id, { id: late.id }), /not attached/);
  } finally { await h.close(); }
});

test('a failed successor acceptance leaves no inherited references or readable handover route', async () => {
  const h = await setup();
  try {
    const source = await h.mk('Failed handover source');
    const reference = await h.accepted('/api/context-references', { kind: 'message', title: 'Inherited', path: '', text: 'DO_NOT_LEAK_ON_FAILURE' });
    await h.send(source.id, { text: 'HANDOVER_SOURCE', references: [reference.id] });
    const start = h.manager.startTurn.bind(h.manager);
    h.manager.startTurn = async () => { throw new Error('fixture rejected acceptance'); };
    await assert.rejects(h.manager.executeAutoHandover(source.id, { agent: 'pi-b' }, 'Continue', null), /fixture rejected acceptance/);
    h.manager.startTurn = start;
    const successor = h.store.listThreads().find(thread => thread.id !== source.id)!;
    assert.ok(successor);
    assert.equal(h.manager.references.granted(successor.id, reference.id), false);
    await assert.rejects(h.manager.references.command(successor.id, { op: 'history', target: source.id }), /outside handover chain/);
    assert.equal(h.manager.references.granted(source.id, reference.id), true, 'the predecessor keeps its accepted grant');
  } finally { await h.close(); }
});

test('a return rejected before acceptance does not install a new route when an attachment is missing', async () => {
  const h = await setup();
  try {
    const a = await h.mk('Return target');
    await h.send(a.id, { text: 'ORIGINAL_REQUEST' });
    const b = await h.manager.createHandoverThread(a.id, 'pi-b', undefined, 'continue');
    await h.send(b.id, { text: 'CONTINUED_REQUEST' });
    const failed = 'missing-attachment-fixture';
    h.store.appendEvent(b.id, failed, 'turn.started', { text: 'Real request with unavailable attachment', userOrigin: 'person', images: [{ id: 'missing-fixture' }] });
    h.store.appendEvent(b.id, failed, 'turn.error', { message: 'fixture' });
    await assert.rejects(h.manager.executeReturnHandover(b.id, a.id, 'Return brief', failed), /attachment unavailable/);
    assert.equal(h.manager.getThread(a.id).handback, null);
    await assert.rejects(h.manager.references.command(a.id, { op: 'history', target: b.id }), /outside handover chain/);
  } finally { await h.close(); }
});

test('handback: the original surviving process reads the segment present in the chain outline without new credentials', async () => {
  const h = await setup();
  try {
    const a = await h.mk('A');
    const first = JSON.parse((await h.send(a.id, { text: 'CONTEXT_BOOT A_USER_REQUIREMENT' })).answer);
    const b = await h.manager.createHandoverThread(a.id, 'pi-b', undefined, 'continue');
    await h.send(b.id, { text: 'B_USER_REQUIREMENT' });
    await h.manager.executeReturnHandover(b.id, a.id, `CONTEXT_READ\n\nRead the returned segment: \`calli history ${b.id}\``, null);
    await h.idle(a.id);
    const events = h.store.listTurnEvents(a.id, h.store.listTurns(a.id).at(-1)!.turnId);
    const executed = JSON.parse(events.filter(event => event.type === 'message.delta').map(event => event.data.text).join(''));
    assert.equal(executed.pid, first.pid, 'the original agent process remains alive');
    assert.ok(h.manager.handoverChain(a).some(segment => segment.id === b.id));
    for (const read of executed.reads) assert.equal(read.code, 0, JSON.stringify(read));
    assert.match(JSON.stringify(executed.reads), /B_USER_REQUIREMENT/);
  } finally { await h.close(); }
});

test('a pointer covers the prior handover chain and exposes source grants exactly one level deep', async () => {
  const h = await setup();
  try {
    const a = await h.mk('Chain start');
    await h.send(a.id, { text: 'CHAIN_A_REQUIREMENT' });
    const b = await h.manager.createHandoverThread(a.id, 'pi-b', undefined, 'continue');
    await h.send(b.id, { text: 'CHAIN_B_REQUIREMENT' });
    // Activity after the hand-over point, an unrelated branch and a later successor must stay out.
    await h.send(a.id, { text: 'A_FOLLOWUP_AFTER_HANDOVER' });
    const fork = await h.manager.createHandoverThread(a.id, 'pi-c', undefined, 'branch');
    await h.send(fork.id, { text: 'FORK_HIDDEN_REQUIREMENT' });
    const leaf = await h.mk('Leaf source');
    await h.send(leaf.id, { text: 'LEAF_REQUIREMENT' });
    const leafReference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: leaf.id, pointer: true });
    await h.send(b.id, { text: 'B attaches the leaf', references: [leafReference.id] });
    const pointer = await h.accepted('/api/context-references', { kind: 'thread', sourceId: b.id, pointer: true });
    const successor = await h.manager.createHandoverThread(b.id, 'pi-c', undefined, 'continue');
    await h.send(successor.id, { text: 'SUCCESSOR_HIDDEN_REQUIREMENT' });
    const recipient = await h.mk('Chain reader');
    await h.send(recipient.id, { text: 'CONTEXT_BOOT', references: [pointer.id] });
    const users = h.manager.references.read(recipient.id, { id: pointer.id, userInputs: true, turns: 50 }) as any;
    const flat = JSON.stringify(users);
    assert.match(flat, /CHAIN_A_REQUIREMENT/);
    assert.match(flat, /CHAIN_B_REQUIREMENT/);
    assert.doesNotMatch(flat, /A_FOLLOWUP_AFTER_HANDOVER|FORK_HIDDEN_REQUIREMENT|SUCCESSOR_HIDDEN_REQUIREMENT/);
    const listed = users.references.filter((entry: any) => entry.id === leafReference.id);
    assert.equal(listed.length, 1, 'the source\'s own grant is listed exactly one level deep');
    const via = h.manager.references.read(recipient.id, { id: pointer.id, via: leafReference.id, parentSnapshot: users.snapshot, userInputs: true, turns: 50 }) as any;
    assert.match(JSON.stringify(via), /LEAF_REQUIREMENT/);
    assert.equal(via.references, undefined, 'a nested read never lists another level');
    assert.throws(() => h.manager.references.read(recipient.id, { id: pointer.id, via: pointer.id, parentSnapshot: users.snapshot, userInputs: true }), /one-level scope/);
    await assert.rejects(h.manager.references.command(recipient.id, { op: 'history', target: fork.id }), /outside handover chain/);
  } finally { await h.close(); }
});

test('users-first includes human native answers at their real event time, pages them completely and excludes controls', async () => {
  const h = await setup();
  try {
    const source = await h.mk('User input chronology');
    const original = await h.send(source.id, { text: 'ORIGINAL_HUMAN_REQUEST' });
    for (const detail of ['FIRST_NATIVE_NOTE', 'SECOND_NATIVE_NOTE']) {
      const waiting = h.manager.inputs.request(source.id, original.turnId, { questions: [{ id: 'detail', question: 'User details?', options: [], freeText: true }] });
      const inputId = String(h.store.listEventsOfType(source.id, 'input.request').at(-1)!.data.inputId);
      assert.equal((await h.post(`/api/inputs/${inputId}`, { answers: { detail: [detail] } })).status, 204);
      await waiting;
    }
    const skipped = h.manager.inputs.request(source.id, original.turnId, { questions: [{ id: 'skip', question: 'Skip?', options: [], freeText: true }] });
    const skipId = String(h.store.listEventsOfType(source.id, 'input.request').at(-1)!.data.inputId);
    await h.post(`/api/inputs/${skipId}`, { cancelled: true });
    await skipped;
    const recipient = await h.mk('Chronology reader');
    const reference = await h.accepted('/api/context-references', { kind: 'thread', sourceId: source.id, pointer: true });
    await h.send(recipient.id, { text: 'CONTEXT_BOOT', references: [reference.id] });
    const rows: any[] = [];
    let page = h.manager.references.read(recipient.id, { id: reference.id, userInputs: true, turns: 1 }) as any;
    const snapshot = page.snapshot;
    while (true) {
      rows.push(...page.inputs);
      if (!page.hasMore) break;
      page = h.manager.references.read(recipient.id, { id: reference.id, userInputs: true, turns: 1, snapshot, cursor: page.nextCursor }) as any;
    }
    assert.equal(rows.length, 3);
    assert.match(rows[0].text, /ORIGINAL_HUMAN_REQUEST/);
    assert.match(rows[1].text, /FIRST_NATIVE_NOTE/);
    assert.match(rows[2].text, /SECOND_NATIVE_NOTE/);
    assert.equal(rows[1].inputId, h.store.listEventsOfType(source.id, 'input.resolved')[0].data.inputId);
    const resolved = h.store.listEventsOfType(source.id, 'input.resolved')[0];
    assert.equal(rows[1].at, resolved.ts);
    assert.equal(rows[1].startSeq, resolved.seq);
    assert.doesNotMatch(JSON.stringify(rows), /Skip\?/);
  } finally { await h.close(); }
});
