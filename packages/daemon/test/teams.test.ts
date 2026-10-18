import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { CoordinationManager } from '../src/coordination.js';
import { parseTeamMentions } from '../src/teams.js';
import { createHttpServer } from '../src/http.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'limi-teams-test-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  const store = new Store(dir);
  const manager = new ThreadManager(store, new Map([['pi', new PiRpcAdapter([process.execPath, join(fixtures, 'fake-pi.mjs')])], ['second', new PiRpcAdapter([process.execPath, join(fixtures, 'fake-pi.mjs')])]]), [cwd], new AttachmentStore(dir));
  const coordination = new CoordinationManager(store, manager, join(dir, 'unused.sock'));
  const teams = coordination.definitions;
  const server = createHttpServer({ manager, token: 'test-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path = '', method = 'GET', body?: unknown) => fetch(base + '/api/teams' + path, { method, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const template = await teams.template();
  const definition = teams.save(template);
  const dispatch = (text = 'TEAM_FLOW') => teams.dispatch({ teamId: definition.id, text, cwd, source: { kind: 'http' } });
  const settled = async (id: string, status = 'awaiting_confirm') => wait(() => coordination.view(id)?.team?.status === status);
  return { dir, cwd, store, manager, coordination, teams, base, api, definition, dispatch, settled,
    async close() { coordination.dispose(); await manager.shutdown(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function wait(check: () => boolean) { const deadline = Date.now() + 12000; while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(r => setTimeout(r, 15)); } }

test('team definitions validate every boundary and retain unavailable instances', async () => {
  const h = await setup();
  try {
    const draft = { ...h.definition, name: 'Other' };
    const bad = (patch: object, match: RegExp) => assert.throws(() => h.teams.save({ ...draft, ...patch }), match);
    bad({ name: ' ' }, /名称/); bad({ name: h.definition.name }, /已存在/);
    for (const name of ['user', 'bad name', '', 'a'.repeat(41)]) bad({ members: [{ name, agent: 'pi' }] }, /成员名称/);
    bad({ members: [{ name: 'a', agent: 'pi' }, { name: 'a', agent: 'pi' }] }, /成员名称/);
    bad({ members: [] }, /1～12/); bad({ members: Array.from({ length: 13 }, (_, i) => ({ name: `m${i}`, agent: 'pi' })) }, /1～12/);
    bad({ entry: 'missing' }, /入口/);
    for (const relations of [[{ kind: 'transfer', from: ['lead'], to: 'dev' }], [{ kind: 'delegate', from: ['lead'], to: 'lead' }], [{ kind: 'delegate', from: ['missing'], to: 'dev' }], [{ kind: 'delegate', from: [], to: 'dev' }], [{ kind: 'delegate', from: ['dev'], to: 'missing' }]]) bad({ relations }, /关系/);
    bad({ members: [{ name: 'lead', agent: 'pi', instruction: 'x'.repeat(4001) }] }, /4000/);
    for (const maxDeliveries of [0, 201, 1.5, '30']) bad({ budget: { maxDeliveries } }, /预算/);
    bad({ members: [{ name: 'lead', agent: 'pi', cwd: h.dir }] }, /目录/);
    symlinkSync(h.dir, join(h.cwd, 'outside')); bad({ members: [{ name: 'lead', agent: 'pi', cwd: join(h.cwd, 'outside') }] }, /目录/);
    const saved = h.teams.save({ ...draft, members: [{ name: 'lead', agent: 'missing', instruction: 'x'.repeat(4000) }], relations: [], budget: { maxDeliveries: 200 } });
    assert.equal(saved.members[0].name, 'lead');
    await assert.rejects(h.teams.dispatch({ teamId: saved.id, text: 'task', cwd: h.cwd, source: { kind: 'http' } }), /lead.*missing/);
    await assert.rejects(h.teams.dispatch({ teamId: h.definition.id, text: 'task', cwd: h.dir, source: { kind: 'http' } }), /目录/);
  } finally { await h.close(); }
});

test('authenticated CRUD, template, JSON import/export and dispatch APIs', async () => {
  const h = await setup();
  try {
    assert.equal((await fetch(h.base + '/api/teams')).status, 401);
    assert.equal((await h.api()).status, 200);
    const template = await (await h.api('/template')).json() as any;
    assert.deepEqual(template.members.map((m: any) => m.agent), ['pi', 'pi', 'pi']);
    const created = await (await h.api('', 'POST', { ...template, name: 'API' })).json() as any;
    assert.equal((await h.api('/' + created.id)).status, 200);
    assert.equal((await h.api('/' + created.id, 'PUT', { ...created, name: 'Changed' })).status, 200);
    const exported = await (await h.api('/' + created.id + '/export')).json() as any;
    assert.equal(exported.name, 'Changed');
    assert.equal((await h.api('/import', 'POST', exported)).status, 409);
    assert.equal((await h.api('/' + created.id, 'DELETE')).status, 204);
    const imported = await (await h.api('/import', 'POST', exported)).json() as any;
    assert.notEqual(imported.id, created.id);
    assert.equal((await h.api('/' + created.id)).status, 404);
    const response = await h.api('/' + imported.id + '/tasks', 'POST', { text: 'TEAM_FLOW', cwd: h.cwd });
    assert.equal(response.status, 202); const { threadId } = await response.json() as any;
    await h.settled(threadId);
    const confirm = () => fetch(`${h.base}/api/threads/${threadId}/coordination`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
    assert.equal((await confirm()).status, 200); assert.equal((await confirm()).status, 409);
    const invalidTurn = await fetch(`${h.base}/api/threads/${threadId}/turns`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
    assert.equal(invalidTurn.status, 400); assert.equal(h.coordination.view(threadId)!.team!.status, 'done');
  } finally { await h.close(); }
});

test('line-start mentions, punctuation, background, multiple peers and unauthorized plain text', () => {
  assert.deepEqual(parseTeamMentions('Context\n@dev: build\ninline @reviewer ignored\n@stranger ignored\n@reviewer：review', ['dev', 'reviewer']), [
    { to: 'dev', text: 'Context\n\nbuild\ninline @reviewer ignored\n@stranger ignored' }, { to: 'reviewer', text: 'Context\n\nreview' },
  ]);
  assert.deepEqual(parseTeamMentions('@dev\nTask', ['dev']), [{ to: 'dev', text: 'Task' }]);
  assert.deepEqual(parseTeamMentions(' @dev task\n@developer task\nemail @dev', ['dev']), []);
});

for (const scenario of ['TEAM_FLOW', 'TEAM_REWORK']) test(`scripted ${scenario}: delegation, automatic return, completion and snapshot isolation`, async () => {
  const h = await setup();
  try {
    const { threadId } = await h.dispatch(scenario);
    h.teams.save({ ...h.definition, description: 'changed later' }, h.definition.id);
    await h.settled(threadId);
    const view = h.coordination.view(threadId)!;
    assert.equal(view.team!.snapshot.description, h.definition.description);
    assert.equal(view.team!.delegations.every(d => d.closed), true);
    assert.equal(view.team!.deliveries, scenario === 'TEAM_FLOW' ? 4 : 8);
    assert.deepEqual(view.members.map(m => m.name), ['dev', 'reviewer']);
    for (const id of [threadId, ...view.members.map(m => m.id)]) {
      assert.equal(h.coordination.environment(id), undefined);
      assert.match(h.coordination.instructions(id, 'x'), /<limi-team>/);
      await assert.rejects(h.coordination.command(id, { op: 'spawn' }), /@/);
    }
    const rootId = view.team!.taskId;
    await h.coordination.userSpoke(threadId); await h.manager.startTurn(threadId, { text: 'Additional requirements' });
    await h.settled(threadId); assert.equal(h.coordination.view(threadId)!.team!.taskId, rootId);
    await h.coordination.confirm(threadId);
    await h.coordination.userSpoke(threadId); await h.manager.startTurn(threadId, { text: scenario });
    await h.settled(threadId);
    const next = h.coordination.view(threadId)!;
    assert.equal(next.team!.deliveries, scenario === 'TEAM_FLOW' ? 4 : 8);
    assert.notEqual(next.team!.taskId, rootId); assert.equal(next.team!.snapshot.description, 'changed later');
    assert.deepEqual(next.members.map(m => m.id), view.members.map(m => m.id));
    assert.equal(next.team!.history[0].taskId, rootId);
    h.teams.remove(h.definition.id); await h.coordination.confirm(threadId);
    await h.coordination.userSpoke(threadId); await h.manager.startTurn(threadId, { text: 'after deletion' }); await h.settled(threadId);
  } finally { await h.close(); }
});

test('budget exhaustion pauses, stop preserves pause, and user input resumes', async () => {
  const h = await setup();
  try {
    h.teams.save({ ...h.definition, budget: { maxDeliveries: 2 } }, h.definition.id);
    const { threadId } = await h.dispatch('TEAM_BUDGET'); await h.settled(threadId, 'needs_attention');
    assert.equal(h.coordination.view(threadId)!.paused, true);
    assert.equal(h.coordination.view(threadId)!.team!.deliveries, 2);
    await assert.rejects(h.coordination.confirm(threadId), /待确认/);
    await h.coordination.userSpoke(threadId);
    assert.equal(h.coordination.view(threadId)!.team!.status, 'running');
    await h.manager.cancelTurn(threadId); assert.equal(h.coordination.view(threadId)!.paused, true);
    await h.coordination.userSpoke(threadId); assert.equal(h.coordination.view(threadId)!.paused, false);
  } finally { await h.close(); }
});

test('interrupted team root recovers into needs_attention without injecting CLI environment', async () => {
  const h = await setup();
  try {
    const { threadId } = await h.dispatch('slow');
    h.coordination.dispose();
    const manager = new ThreadManager(h.store, new Map(), [h.cwd], new AttachmentStore(h.dir));
    manager.recoverInterrupted();
    const restored = new CoordinationManager(h.store, manager, join(h.dir, 'other.sock'));
    try { await wait(() => restored.view(threadId)?.team?.status === 'needs_attention'); assert.equal(restored.view(threadId)!.paused, true); }
    finally { restored.dispose(); }
  } finally { await h.close(); }
});

test('CLI team ls and run use authenticated HTTP without socket credentials', async () => {
  const h = await setup();
  const cli = (args: string[], input = '') => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [join(fixtures, '../../bin/limi'), 'team', ...args], { env: { ...process.env, LIMI_URL: h.base, LIMI_TOKEN: 'test-token', LIMI_SOCKET: '', LIMI_KEY: '' }, stdio: 'pipe' });
    let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d); child.on('error', reject);
    child.on('exit', code => code ? reject(new Error(err)) : resolve(JSON.parse(out))); child.stdin.end(input);
  });
  try {
    assert.equal((await cli(['ls']))[0].id, h.definition.id);
    const task = await cli(['run', h.definition.name, '--cwd', h.cwd, '--task-file', '-'], 'TEAM_FLOW');
    await h.settled(task.threadId); assert.equal(h.coordination.view(task.threadId)!.team!.source.kind, 'cli');
  } finally { await h.close(); }
});

test('parallel delegations stay open until every peer returns; results link to the oldest outstanding request', async () => {
  const h = await setup();
  try {
    h.teams.save({ ...h.definition, relations: [{ kind: 'delegate', from: ['lead'], to: 'dev' }, { kind: 'delegate', from: ['lead'], to: 'reviewer' }] }, h.definition.id);
    const { threadId } = await h.dispatch('TEAM_MULTI'); await h.settled(threadId);
    const view = h.coordination.view(threadId)!;
    assert.equal(view.team!.delegations.length, 2);
    assert.ok(view.team!.delegations.every(d => d.closed));
    for (const d of view.messages.filter(d => d.kind === 'result')) {
      assert.ok(d.replyTo); const asked = view.messages.find(v => v.id === d.replyTo)!;
      assert.equal(asked.from, d.to); assert.equal(asked.to, d.from);
    }
  } finally { await h.close(); }
});

for (const text of ['fail', 'TEAM_MEMBER_ERROR']) test(`errors in ${text} stop routing and keep the failure visible`, async () => {
  const h = await setup();
  try {
    const { threadId } = await h.dispatch(text); await h.settled(threadId, 'needs_attention');
    assert.equal(h.coordination.view(threadId)!.paused, true);
    assert.ok(h.coordination.view(threadId)!.team!.error);
    await h.coordination.userSpoke(threadId);
    assert.equal(h.coordination.view(threadId)!.team!.status, 'running');
  } finally { await h.close(); }
});

test('team runtime has no CLI credentials and members honor fixed directories', async () => {
  const h = await setup();
  try {
    const cwd = join(h.cwd, 'fixed'); mkdirSync(cwd);
    h.teams.save({ ...h.definition, members: h.definition.members.map(m => m.name === 'dev' ? { ...m, cwd } : m) }, h.definition.id);
    const first = await h.dispatch('TEAM_ENV'); await h.settled(first.threadId);
    const answer = h.store.listEvents(first.threadId, 0, -1).filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
    assert.match(answer, /limi-ready:false/);
    const flow = await h.dispatch(); await h.settled(flow.threadId);
    assert.equal(h.coordination.view(flow.threadId)!.members.find(m => m.name === 'dev')!.thread!.cwd, cwd);
  } finally { await h.close(); }
});

test('recovery replays a committed finish exactly once before delivering new work', async () => {
  const h = await setup();
  try {
    const { threadId } = await h.dispatch('TEAM_FLOW'); await h.settled(threadId);
    h.coordination.dispose();
    const persisted = JSON.parse(h.store.coordinationRecords().find(r => r.id === threadId)!.data);
    const final = persisted.team.resultTurnId;
    persisted.team.status = 'running'; persisted.team.resultTurnId = null;
    persisted.team.processed = persisted.team.processed.filter((id: string) => id !== final);
    const last = persisted.deliveries.find((d: any) => d.turnId === final); last.state = 'running';
    h.store.saveCoordination(threadId, JSON.stringify(persisted));
    for (let n = 0; n < 2; n++) {
      const restored = new CoordinationManager(h.store, h.manager, join(h.dir, 'recovered.sock'));
      try {
        await wait(() => restored.view(threadId)?.team?.status === 'awaiting_confirm');
        assert.equal(restored.view(threadId)!.team!.deliveries, 4);
        assert.equal(restored.view(threadId)!.paused, false);
      } finally { restored.dispose(); }
    }
  } finally { await h.close(); }
});

test('new tasks replace changed member instances while retaining previous thread links', async () => {
  const h = await setup();
  try {
    const { threadId } = await h.dispatch(); await h.settled(threadId);
    const previous = h.coordination.view(threadId)!.members;
    await h.coordination.confirm(threadId);
    h.teams.save({ ...h.definition, members: h.definition.members.map(m => m.name === 'dev' ? { ...m, agent: 'second' } : m) }, h.definition.id);
    await h.coordination.userSpoke(threadId); await h.manager.startTurn(threadId, { text: 'TEAM_FLOW' }); await h.settled(threadId);
    const current = h.coordination.view(threadId)!.members;

    assert.notEqual(current.find(m => m.name === 'dev')!.id, previous.find(m => m.name === 'dev')!.id);
    assert.equal(current.find(m => m.name === 'dev')!.thread!.agent, 'second');
    assert.equal(current.find(m => m.name === 'reviewer')!.id, previous.find(m => m.name === 'reviewer')!.id);
    assert.equal(h.coordination.metadata(previous[0].id)!.rootId, threadId);
    await h.coordination.confirm(threadId);
    h.teams.save({ ...h.definition, members: h.definition.members.map(m => m.name === 'lead' ? { ...m, agent: 'second' } : m) }, h.definition.id);
    await assert.rejects(h.coordination.userSpoke(threadId), /入口实例/);
    assert.equal(h.coordination.view(threadId)!.team!.status, 'done');
  } finally { await h.close(); }
});

test('entry and member settings use snapshot models and lead is an ordinary non-entry role', async () => {
  const h = await setup();
  try {
    const models = await h.manager.listModels('pi');
    const model = models.find(m => m.efforts?.includes('high')) ?? models[0];
    const effort = model.efforts?.includes('high') ? 'high' : undefined;
    h.teams.save({ ...h.definition, entry: 'chief', members: [{ name: 'chief', agent: 'pi', model: model.id, effort }, { name: 'lead', agent: 'pi', model: model.id, effort }], relations: [{ kind: 'delegate', from: ['chief'], to: 'lead' }] }, h.definition.id);
    const { threadId } = await h.dispatch('TEAM_CUSTOM'); await h.settled(threadId);
    const view = h.coordination.view(threadId)!;
    assert.equal(view.members[0].name, 'lead'); assert.equal(view.members[0].thread!.model, model.id);
    assert.equal(h.manager.threadView(threadId).model, model.id);
    if (effort) assert.equal(view.members[0].thread!.effort, effort);
    assert.equal(view.team!.delegations[0].from, 'chief'); assert.ok(view.team!.delegations[0].closed);
  } finally { await h.close(); }
});

test('a crash after task creation but before its first turn is an interrupted task', async () => {
  const h = await setup();
  try {
    const { threadId } = await h.dispatch('TEAM_ENV'); await h.settled(threadId);
    h.coordination.dispose();
    const fresh = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
    const record = JSON.parse(h.store.coordinationRecords().find(r => r.id === threadId)!.data);
    record.rootId = fresh.id; record.members = []; record.deliveries = [];
    record.team.status = 'running'; record.team.processed = []; record.team.resultTurnId = null;
    h.store.saveCoordination(fresh.id, JSON.stringify(record));
    const restored = new CoordinationManager(h.store, h.manager, join(h.dir, 'restart.sock'));
    try { assert.equal(restored.view(fresh.id)!.team!.status, 'needs_attention'); assert.equal(restored.view(fresh.id)!.paused, true); }
    finally { restored.dispose(); }
  } finally { await h.close(); }
});
