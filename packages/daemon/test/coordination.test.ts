import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { DshAcpAdapter } from '../src/adapters/dsh.js';
import { DoubaoAdapter } from '../src/adapters/doubao.js';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import { TraexAcpAdapter } from '../src/adapters/traex.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { CoordinationManager, coordinationServer, turnAnswer } from '../src/coordination.js';
import { HostRegistry } from '../src/hosts.js';
import { RelayClient } from '../src/relay-client.js';
import { HttpError } from '../src/errors.js';
import { createHttpServer, listenPrivate } from '../src/http.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wait = async (check: () => boolean, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'calli-team-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  const other = join(dir, 'other'); mkdirSync(other);
  const adapters = new Map<string, AgentAdapter>([
    ['pi', new PiRpcAdapter([process.execPath, join(fixtures, 'fake-pi.mjs')])],
    ['claude', new ClaudeAcpAdapter([process.execPath, join(fixtures, 'fake-acp.mjs')])],
    ['codex', new CodexAppServerAdapter([process.execPath, join(fixtures, 'fake-codex.mjs')])],
    ['agy', new AgyAdapter([process.execPath, join(fixtures, 'fake-agy.mjs')])],
    ['traex', new TraexAcpAdapter([process.execPath, join(fixtures, 'fake-acp.mjs')])],
    ['dsh', new DshAcpAdapter([process.execPath, join(fixtures, 'fake-acp.mjs')], { FAKE_ACP_FLAVOR: 'dsh' })],
    ['doubao', new DoubaoAdapter([process.execPath, join(fixtures, 'fake-doubao.mjs')])],
  ]);
  const store = new Store(dir);
  /** Mutable, so a test can make an instance hidden or account-linked after the fact. */
  const meta: Array<{ id: string; adapter?: string; account?: string | null; hidden?: boolean }> = [];
  const manager = new ThreadManager(store, adapters, [cwd, other], new AttachmentStore(dir), () => meta);
  const socket = join(dir, 'ipc', 'calli.sock');
  const team = new CoordinationManager(store, manager, socket, { exchangeRoot: join(dir, 'exchange'), resultDir: join(dir, 'results') });
  const local = coordinationServer(team); await listenPrivate(local, socket);
  const server = createHttpServer({ manager, token: 'test-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, body?: unknown, token = 'test-token') => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const root = await manager.createThread({ agent: 'pi', cwd });
  return { dir, cwd, other, store, manager, team, root, api, adapters, meta, async close() { team.dispose(); await manager.shutdown(); await new Promise<void>(r => local.close(() => r())); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const spawn = (name: string, agent = 'pi', text = 'hello', extra = {}) => ({ op: 'spawn', name, agent, text, requestId: name, ...extra });

test('coordination preserves slash commands and their arguments while enriching ordinary messages', async () => {
  const h = await setup();
  try {
    for (const agent of ['codex', 'pi']) {
      const thread = await h.manager.createThread({ agent, cwd: h.cwd });
      await h.team.enable(thread.id);
      const commands = agent === 'codex'
        ? ['/compact', '/mcp', '/skills', '/review', '/review 检查错误处理', '/inspect 检查测试']
        : ['/compact', '/compact keep the API notes', '/session'];
      for (const text of commands) {
        const response = await h.api(`/api/threads/${thread.id}/turns`, { text: `  ${text}\n` });
        assert.equal(response.status, 202);
        const { turnId } = await response.json() as { turnId: string };
        await wait(() => h.manager.threadView(thread.id).status !== 'running');
        const events = h.store.listEvents(thread.id, 0, -1).filter(e => e.turnId === turnId);
        assert.equal(events.find(e => e.type === 'turn.started')?.data.text, text);
        assert.equal(events.some(e => e.type === 'turn.error'), false, `${agent}: ${text}`);
        assert.ok(events.some(e => e.type === 'turn.done'));
        if (agent === 'codex' && text === '/compact') {
          assert.ok(events.some(e => e.type === 'message.delta' && e.data.text === '上下文压缩完成。'));
        }
      }
      await h.manager.startTurn(thread.id, { text: 'hello' });
      await wait(() => h.manager.threadView(thread.id).status !== 'running');
      const started = h.store.listEvents(thread.id, 0, -1).filter(e => e.type === 'turn.started').at(-1)!;
      assert.match(String(started.data.text), /<calli-coordination>/);
      assert.equal(started.data.displayText, 'hello');
    }
  } finally { await h.close(); }
});

test('each advertised adapter passes the runtime environment to its fixture', async () => {
  const h = await setup();
  try {
    for (const agent of ['pi', 'claude', 'codex', 'agy', 'traex', 'dsh', 'doubao']) {
      const thread = await h.manager.createThread({ agent, cwd: h.cwd });
      await h.team.enable(thread.id);
      await h.manager.startTurn(thread.id, { text: 'CALLI_ENV' });
      await wait(() => h.manager.threadView(thread.id).status !== 'running');
      const answer = h.store.listEvents(thread.id, 0, -1).filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
      assert.match(answer, /calli-ready:true/, agent);
    }
  } finally { await h.close(); }
});

test('coordination API enables an idle session and CLI resolves its scoped runtime context', async () => {
  const h = await setup();
  try {
    assert.equal((await h.api(`/api/threads/${h.root.id}/coordination`, {}, 'wrong')).status, 401);
    assert.equal((await h.api(`/api/threads/${h.root.id}/coordination`, {})).status, 200);
    await h.manager.startTurn(h.root.id, { text: 'CALLI_ENV' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    const answer = h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
    assert.match(answer, /calli-ready:true/);
    const directive = Buffer.from(JSON.stringify({ args: ['spawn', '--agent', 'claude', '--name', 'cli-worker', '--message-file', '-', '--request-id', 'cli-create'], text: 'hello' })).toString('base64');
    await h.manager.startTurn(h.root.id, { text: `CALLI_COMMAND:${directive}` });
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
    // A member's line in the sidebar says what it came back with; the lead's carries no such line.
    const first = h.team.view(h.root.id)!.members[0];
    assert.equal(h.manager.threadView(first.id).coordination!.doing, first.latest!.result.split('<calli-coordination>')[0].trim().slice(0, 200));
    assert.ok(h.manager.threadView(first.id).coordination!.doing);
    assert.equal(h.manager.threadView(h.root.id).coordination!.doing, undefined);
    await h.team.command(h.root.id, spawn('writer', 'codex', 'CALLI_WRITE'));
    await wait(() => {
      try { return readFileSync(join(h.cwd, 'review-document.md'), 'utf8').includes('## Errors'); } catch { return false; }
    });
    const state = h.team.view(h.root.id)!;
    const writer = state.members.find(m => m.name === 'writer')!;
    const reviewer = state.members.find(m => m.name === 'reviewer')!;
    assert.ok(state.messages.some(d => d.from === writer.id && d.to === reviewer.id && d.text === 'CALLI_REVIEW'));
    assert.ok(state.messages.some(d => d.from === reviewer.id && d.to === writer.id && d.kind === 'result'));
    // Every result names the message it answers, so a reader can hang it under that message.
    const asked = state.messages.find(d => d.from === writer.id && d.to === reviewer.id && d.text === 'CALLI_REVIEW')!;
    assert.equal(state.messages.find(d => d.from === reviewer.id && d.to === writer.id && d.kind === 'result')!.replyTo, asked.id);
    assert.equal(asked.replyTo, null);
    await wait(() => h.manager.threadView(writer.id).status === 'idle');
    assert.equal(h.manager.threadView(writer.id).agentSessionId, 'codex-thread-1');
  } finally { await h.close(); }
});

test('CLI status filters the actual preview source when newer work is queued', async t => {
  for (const withheld of [false, true]) await t.test(withheld ? 'suppressed result' : 'allowed result', async () => {
    const h = await setup();
    const text = withheld ? 'PRIVATE_PREVIEW_RESULT' : 'previous allowed result';
    let reached = false, release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const adapter = h.adapters.get('pi')!;
      const start = adapter.start.bind(adapter);
      adapter.start = async opts => {
        const session = await start(opts);
        const prompt = session.prompt.bind(session);
        session.prompt = async (input, hooks) => {
          if (input.text.includes(text)) { reached = true; await gate; }
          return prompt(input, hooks);
        };
        return session;
      };
      await h.team.enable(h.root.id);
      const job = await h.team.command(h.root.id, spawn('preview-worker', 'pi', text)) as { id: string; to: string };
      await wait(() => reached && h.team.view(h.root.id)!.members[0].latest?.state === 'running');
      if (withheld) await h.manager.updateThread(job.to, { disabled: true });
      release();
      await wait(() => h.team.view(h.root.id)!.messages.find(d => d.id === job.id)?.state === 'returned');
      const completed = h.team.view(h.root.id)!.messages.find(d => d.id === job.id)!;
      assert.equal(Boolean('suppressed' in completed && completed.suppressed), withheld);
      assert.match(completed.result, new RegExp(text), 'the fixture really produced the old result');
      if (withheld) await h.manager.updateThread(job.to, { disabled: false });
      await wait(() => h.manager.threadView(h.root.id).status === 'idle');
      for (let n = 0; n < 3; n++) await h.team.command(h.root.id, spawn(`busy-${n}`, 'pi', 'slow'));
      await wait(() => h.team.view(h.root.id)!.members.filter(m => m.thread?.status === 'running').length === 3);
      const queued = await h.team.command(h.root.id, { op: 'send', target: job.to, text: 'new allowed request', requestId: 'preview-next' }) as { id: string };
      const browser = h.team.view(h.root.id)!;
      const member = browser.members.find(m => m.id === job.to)!;
      assert.equal(member.latest!.id, queued.id);
      assert.equal(member.latest!.state, 'queued');
      assert.equal(member.thread!.status, 'idle');
      assert.ok(browser.messages.some(d => d.id === job.id && d.result.includes(text)), 'browser history still contains the old result');
      const status = await h.team.command(h.root.id, { op: 'status' }) as any;
      const visible = status.members.find((m: any) => m.id === job.to);
      assert.equal(visible.latest.id, queued.id, 'the legitimate queued task remains visible');
      if (withheld) {
        assert.doesNotMatch(visible.thread.coordination.doing ?? '', new RegExp(text), 'the selected old preview is withheld even though latest is allowed');
        assert.doesNotMatch(JSON.stringify(status), new RegExp(text));
      } else {
        assert.match(visible.thread.coordination.doing, new RegExp(text), 'an allowed result stays visible while its follow-up is queued');
      }
      const held = browser.members.find(m => m.name === 'busy-0')!;
      await h.team.command(h.root.id, { op: 'send', target: held.id, text: 'queued behind active', requestId: 'preview-active-next' });
      const active = (await h.team.command(h.root.id, { op: 'status' }) as any).members.find((m: any) => m.id === held.id);
      assert.equal(active.thread.status, 'running');
      assert.equal(active.latest.state, 'queued');
      assert.equal(active.thread.coordination.doing, 'slow', 'the genuine running task keeps its preview');
    } finally { release(); await h.close(); }
  });
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
    // The user writing to the lead again is enough to go on; a member's thread does not count.
    await h.api(`/api/threads/${first}/turns`, { text: 'hello' });
    assert.equal(h.team.view(h.root.id)!.paused, true);
    assert.equal((await h.api(`/api/threads/${h.root.id}/turns`, { text: 'hello' })).status, 202);
    assert.equal(h.team.view(h.root.id)!.paused, false);
    await wait(() => h.manager.threadView(h.root.id).status !== 'running' && h.manager.threadView(first).status !== 'running');
    // A member only stops to ask where the team has it ask.
    await h.team.setPermission(h.root.id, 'ask');
    await h.team.command(h.root.id, spawn('approver', 'claude', 'approve'));
    await wait(() => Boolean(h.team.view(h.root.id)!.members.find(m => m.name === 'approver')?.thread?.waiting));
    await h.manager.cancelTurn(h.root.id);
  } finally { await h.close(); }
});

test('restart preserves queued work, marks in-flight work interrupted and does not pause the team', async () => {
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
      assert.equal(state.paused, false);
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
        assert.equal(state.paused, false);
      } finally { recovered.dispose(); }
    }
  } finally { await h.close(); }
});

test('a member returns its closing answer, not the remarks made on the way', () => {
  let seq = 0;
  const ev = (type: string, text = '', turnId = 't1') => ({ threadId: 'th', seq: ++seq, turnId, type, ts: '', data: { text } });
  const worked = [ev('message.delta', '先看 diff。'), ev('tool.start'), ev('tool.end'), ev('message.delta', '## 结论\n'), ev('message.delta', '没有问题。'), ev('message.delta', '别的轮次', 't2')];
  assert.equal(turnAnswer(worked, 't1'), '## 结论\n没有问题。');
  // Ending on a tool call leaves no closing text; what was said before it is all there is.
  assert.equal(turnAnswer([ev('message.delta', '正在跑测试。'), ev('tool.start')], 't1'), '正在跑测试。');
  assert.equal(turnAnswer([ev('tool.start')], 't1'), '');
});

test('a message can carry a task for one member alone', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const text = h.team.mentionText(h.root.id, '审查代码', [{ id: 'pi', kind: 'agent', label: 'pi', task: ' 看 daemon ' }, { id: 'claude', kind: 'agent', label: 'Claude Code' }]);
    const [said, rest] = text.split('\n\n[指定协作对象]\n');
    assert.equal(said, '审查代码\n\n@pi：看 daemon');
    assert.deepEqual(JSON.parse(rest.split('\n')[0]), [{ agent: 'pi', cwd: h.cwd, task: '看 daemon' }, { agent: 'claude', cwd: h.cwd }]);
    // The tasks alone are a message; nothing at all is not.
    assert.match(h.team.mentionText(h.root.id, '', [{ id: 'pi', kind: 'agent', task: '看 daemon' }]), /^@pi：看 daemon\n\n\[指定协作对象\]/);
    assert.throws(() => h.team.mentionText(h.root.id, '', [{ id: 'pi', kind: 'agent', task: ' ' }]), /请说明协作任务/);
    assert.throws(() => h.team.mentionText(h.root.id, 'x', [{ id: 'pi', kind: 'agent', task: 'a'.repeat(4001) }]), /4000/);
  } finally { await h.close(); }
});

test('members start with the model and effort chosen for their instance, unless the lead names others', async () => {
  const h = await setup();
  try {
    const models = (await (h.manager as any).adapters.get('claude').models()).map((m: any) => m.id).filter((id: string) => id !== 'default');
    assert.ok(models.length >= 2, 'the fixture offers models to choose from');
    await assert.rejects(h.team.enable(h.root.id, { defaults: { nobody: { model: 'x' } } }), /实例/);
    const view = await h.team.enable(h.root.id, { defaults: { claude: { model: models[0], effort: 'high' }, pi: { model: '', effort: null } } });
    assert.deepEqual(view!.defaults, { claude: { model: models[0], effort: 'high' } });
    const member = async (name: string, extra = {}, agent = 'claude') => h.manager.threadView(((await h.team.command(h.root.id, spawn(name, agent, 'hello', extra))) as any).to);
    const usual = await member('usual');
    assert.deepEqual([usual.model, usual.effort], [models[0], 'high']);
    const named = await member('named', { model: models[1] });
    // The usual effort stays where the named model takes it, and is dropped where it does not.
    assert.equal(named.model, models[1]);
    assert.ok(named.effort === 'high' || named.effort === null);
    assert.equal((await member('plain', {}, 'pi')).model, null);
    await assert.rejects(h.team.command(h.root.id, spawn('wrong', 'claude', 'hello', { model: 'no-such-model' })), /unknown model/);
    // A choice the agent no longer offers is dropped rather than keeping the member from starting.
    assert.deepEqual((await h.team.setDefaults(h.root.id, { claude: { model: 'gone' } }))!.defaults, { claude: { model: 'gone', effort: null } });
    assert.equal((await member('later')).model, null);
    const member2 = h.team.view(h.root.id)!.members[0].id;
    await assert.rejects(h.team.setDefaults(member2, {}), /主线程/);
  } finally { await h.close(); }
});

test('an instance that joins the hub after the collaboration started is offered to it', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    assert.equal(h.team.view(h.root.id)!.agents.includes('late'), false);
    // The hub joins two more instances: a second copy of a CLI, and one hidden on purpose.
    h.adapters.set('late', new PiRpcAdapter([process.execPath, join(fixtures, 'fake-pi.mjs')]));
    h.adapters.set('shy', new PiRpcAdapter([process.execPath, join(fixtures, 'fake-pi.mjs')]));
    h.meta.push({ id: 'shy', hidden: true });
    // Still the old roster until something uses the team.
    assert.equal(h.team.view(h.root.id)!.agents.includes('late'), false);
    // A mention of the latecomer is accepted and brings it onto the roster; the hidden one is not.
    const text = await h.team.previewMentions(h.root.id, 'do it', [{ kind: 'agent', id: 'late', label: 'late' }]);
    assert.match(text, /"agent":"late"/);
    assert.equal(h.team.view(h.root.id)!.agents.includes('late'), true);
    assert.equal(h.team.view(h.root.id)!.agents.includes('shy'), false);
    await assert.rejects(h.team.previewMentions(h.root.id, 'no', [{ kind: 'agent', id: 'shy', label: 'shy' }]), /实例不在本次协作中/);
    await assert.rejects(h.team.previewMentions(h.root.id, 'no', [{ kind: 'agent', id: 'ghost', label: 'ghost' }]), /实例不在本次协作中/);
    // The same through a whole turn, the path the page takes, and through the lead's own spawn.
    await h.manager.startTurn(h.root.id, { text: 'go', mentions: [{ kind: 'agent', id: 'late', label: 'late' }] });
    await wait(() => h.manager.threadView(h.root.id).status !== 'running');
    const started = h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').at(-1)!;
    assert.match(String(started.data.text), /"agent":"late"/);
    const job = await h.team.command(h.root.id, spawn('latecomer', 'late')) as any;
    assert.equal(h.manager.threadView(job.to).agent, 'late');
    await assert.rejects(h.team.command(h.root.id, spawn('quiet', 'shy')), /实例不在本次协作范围内/);
    // The lead's own list of instances says the same.
    const agents = await h.team.command(h.root.id, { op: 'agents' }) as any[];
    assert.ok(agents.some(a => a.id === 'late'));
    assert.ok(!agents.some(a => a.id === 'shy'));
  } finally { await h.close(); }
});

test('members run with full access unless the team says otherwise, and a change reaches the members there are', async () => {
  const h = await setup();
  try {
    await assert.rejects(h.team.enable(h.root.id, { permission: 'anything' }), /权限/);
    assert.equal((await h.team.enable(h.root.id))!.permission, 'full_access');
    const member = async (name: string, agent = 'claude') => ((await h.team.command(h.root.id, spawn(name, agent))) as any).to as string;
    const first = await member('first');
    assert.equal(h.manager.threadView(first).permissionMode, 'full_access');
    // pi has no levels to choose from; it keeps its own.
    const plain = await member('plain', 'pi');
    assert.equal(h.manager.threadView(plain).permissionMode, 'auto_edit');
    assert.equal((await h.team.setPermission(h.root.id, 'ask'))!.permission, 'ask');
    assert.equal(h.manager.threadView(first).permissionMode, 'ask');
    assert.equal(h.manager.threadView(await member('second')).permissionMode, 'ask');
    // traex cannot ask before everything, so its members stay at its own default.
    assert.notEqual(h.manager.threadView(await member('third', 'traex')).permissionMode, 'ask');
    // One instance can differ from the team; setting the team's level again takes that away.
    assert.deepEqual((await h.team.setDefaults(h.root.id, { claude: { permission: 'auto_edit' } }))!.defaults, { claude: { model: null, effort: null, permission: 'auto_edit' } });
    assert.equal(h.manager.threadView(first).permissionMode, 'auto_edit');
    assert.equal(h.manager.threadView(await member('fourth')).permissionMode, 'auto_edit');
    assert.equal(h.manager.threadView(await member('fifth', 'codex')).permissionMode, 'ask');
    assert.deepEqual((await h.team.setPermission(h.root.id, 'full_access'))!.defaults, { claude: { model: null, effort: null } });
    assert.equal(h.manager.threadView(first).permissionMode, 'full_access');
    await assert.rejects(h.team.setDefaults(h.root.id, { claude: { permission: 'root' } }), /权限/);
    await assert.rejects(h.team.setPermission(first, 'ask'), /主线程/);
    await assert.rejects(h.team.setPermission(h.root.id, 'root'), /权限/);
  } finally { await h.close(); }
});

test('queued collaboration restores structured targets and compiles them once on dispatch', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const mentions = [{ id: 'claude', label: 'Claude Code', kind: 'agent', cwd: h.cwd, task: '只给建议' }];
    const response = await h.api(`/api/threads/${h.root.id}/turns`, { text: '一起分析', mentions, queue: true });
    assert.equal(response.status, 202);
    const queued = await response.json() as { id: string };
    assert.equal(h.manager.threadView(h.root.id).queued[0].text, '一起分析');
    const taken = h.manager.removeQueued(h.root.id, queued.id);
    assert.deepEqual(taken, { text: '一起分析', images: [], mentions });
    await h.manager.startTurn(h.root.id, { ...taken, queue: true });
    const stopped = await h.manager.cancelTurn(h.root.id);
    assert.deepEqual(stopped, { dropped: ['一起分析'], mentions });
    await wait(() => h.manager.threadView(h.root.id).status !== 'running');
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const next = await h.manager.startTurn(h.root.id, { ...taken, queue: true });
    assert.ok('id' in next);
    await h.manager.sendQueuedNow(h.root.id, (next as { id: string }).id);
    await wait(() => h.manager.threadView(h.root.id).status !== 'running' && h.manager.threadView(h.root.id).queued.length === 0);
    const event = h.store.listEvents(h.root.id, 0, -1).find(e => e.type === 'turn.started' && String(e.data.text).includes('一起分析'));
    assert.ok(event);
    assert.equal(String(event.data.text).split('[指定协作对象]').length - 1, 1);
    assert.match(String(event.data.text), /只给建议/);
  } finally { await h.close(); }
});

test('imported and terminal-synced member turns never deliver collaboration results', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('history-reader')) as { to: string; id: string };
    await wait(() => h.team.view(h.root.id)!.messages.some(d => d.id === job.id && d.state === 'returned'));
    const before = h.team.view(h.root.id)!.messages.length;
    for (const flag of ['imported', 'fromTerminal']) {
      for (const type of ['turn.done', 'turn.error']) {
        const turnId = `history-${flag}-${type}`;
        (h.manager as any).emitThreadEvent(job.to, turnId, 'turn.started', { [flag]: true });
        (h.manager as any).emitThreadEvent(job.to, turnId, 'message.delta', { text: 'Historical answer', [flag]: true });
        (h.manager as any).emitThreadEvent(job.to, turnId, type, { [flag]: true });
      }
    }
    // A serial command is a barrier after every queued finished() callback.
    await h.team.command(h.root.id, { op: 'status' });
    const messages = h.team.view(h.root.id)!.messages;
    assert.equal(messages.some(d => d.key.includes(':history-')), false);
    assert.equal(messages.length, before);
  } finally { await h.close(); }
});

test('running unconfigured threads queue collaboration without refreshing until earlier turns finish', async () => {
  const h = await setup();
  try {
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const mentions = [
      { id: 'claude', label: 'Claude Code', kind: 'agent', task: '只给建议' },
      // No task of its own: the lead assigns it, and the queue's chip should not name it.
      { id: 'pi', label: 'pi', kind: 'agent' },
    ];
    const earlier = await h.manager.startTurn(h.root.id, { text: 'slow earlier', queue: true });
    assert.ok('queued' in earlier);
    const response = await h.api(`/api/threads/${h.root.id}/turns`, { text: '一起分析', mentions, queue: true,
      collaboration: { directories: [h.cwd, h.other], defaults: { claude: { model: null, effort: 'high' } }, permission: 'ask' } });
    assert.equal(response.status, 202);
    const queued = await response.json() as { id: string };
    assert.equal(h.team.view(h.root.id), null);
    assert.equal(h.manager.threadView(h.root.id).status, 'running');
    assert.deepEqual(h.manager.threadView(h.root.id).queued[1].targets, ['Claude Code']);    await h.manager.cancelTurn(h.root.id, { keepQueue: true });
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started' && e.data.text === 'slow earlier'));
    assert.equal(h.team.view(h.root.id), null, 'an earlier queued turn must not gain collaboration');
    await h.manager.cancelTurn(h.root.id, { keepQueue: true });
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started' && String(e.data.text).includes('一起分析')));
    await wait(() => h.manager.threadView(h.root.id).status !== 'running');
    assert.deepEqual(h.team.view(h.root.id)!.directories, [h.cwd, h.other]);
    assert.equal(h.team.view(h.root.id)!.permission, 'ask');
    assert.equal(h.team.view(h.root.id)!.defaults.claude.effort, 'high');
    assert.equal(h.manager.threadView(h.root.id).queued.some(q => q.id === queued.id), false);
    const event = h.store.listEvents(h.root.id, 0, -1).find(e => e.type === 'turn.started' && String(e.data.text).includes('一起分析'))!;
    assert.equal(String(event.data.text).split('[指定协作对象]').length - 1, 1);
    assert.match(String(event.data.text), /只给建议/);
    await h.manager.startTurn(h.root.id, { text: 'CALLI_ENV' });
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'message.delta' && String(e.data.text).includes('calli-ready:true')));
  } finally { await h.close(); }
});

test('unconfigured queued collaboration can be withdrawn with all targets and per-target tasks', async () => {
  const h = await setup();
  try {
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const mentions = [{ id: 'claude', kind: 'agent', label: 'Claude Code', task: 'review' }, { id: 'pi', kind: 'agent', task: 'test' }];
    const response = await h.api(`/api/threads/${h.root.id}/turns`, { text: '', mentions, queue: true });
    assert.equal(response.status, 202);
    const queued = await response.json() as { id: string };
    assert.deepEqual(h.manager.removeQueued(h.root.id, queued.id), { text: '', images: [], mentions });
    assert.equal(h.team.view(h.root.id), null);
    const invalid = await h.api(`/api/threads/${h.root.id}/turns`, { text: 'task', mentions: [{ kind: 'member', id: 'missing' }], queue: true });
    assert.equal(invalid.status, 400);
    assert.deepEqual(h.manager.threadView(h.root.id).queued, []);
  } finally { await h.close(); }
});

test('failed collaboration does not block queued work or new messages while idle, and can be retried', async () => {
  const h = await setup();
  try {
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const mentions = [{ id: 'claude', kind: 'agent', label: 'Claude Code', task: 'review' }];
    const queued = await h.manager.startTurn(h.root.id, { text: 'review this', mentions, queue: true });
    assert.ok('id' in queued);
    await h.manager.startTurn(h.root.id, { text: 'next message', queue: true });
    const enable = h.team.enable.bind(h.team);
    h.team.enable = async () => { throw new Error('setup unavailable'); };
    await h.manager.cancelTurn(h.root.id, { keepQueue: true });
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started' && e.data.text === 'next message'));
    await wait(() => h.manager.threadView(h.root.id).status !== 'running');
    const queue = h.manager.threadView(h.root.id).queued;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, queued.id);
    assert.equal(queue[0].text, 'review this');
    assert.deepEqual(queue[0].targets, ['Claude Code']);
    assert.match(queue[0].error!, /setup unavailable/);
    const later = await h.manager.startTurn(h.root.id, { text: 'last message', queue: true });
    assert.ok('turnId' in later, 'only failed items remain, so a new message starts immediately');
    await wait(() => h.manager.threadView(h.root.id).status !== 'running');
    assert.equal(h.manager.threadView(h.root.id).queued[0].id, queued.id, 'failed work stays until an explicit retry or withdrawal');
    h.team.enable = enable;
    await h.manager.sendQueuedNow(h.root.id, queued.id);
    await wait(() => Boolean(h.team.view(h.root.id)));
    await wait(() => h.manager.threadView(h.root.id).status !== 'running' && h.manager.threadView(h.root.id).queued.length === 0);
    assert.ok(h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started' && String(e.data.text).startsWith('review this')));
  } finally { await h.close(); }
});

test('withdrawing an idle failed item restores mentions and the remaining queued message starts', async () => {
  const h = await setup();
  let unsubscribe = () => {};
  try {
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const mentions = [{ id: 'claude', kind: 'agent', label: 'Claude Code', task: 'review' }];
    const queued = await h.manager.startTurn(h.root.id, { text: 'review this', mentions, queue: true });
    assert.ok('id' in queued);
    await h.manager.startTurn(h.root.id, { text: 'after withdrawal', queue: true });
    h.team.enable = async () => { throw new Error('setup unavailable'); };
    let taken: ReturnType<typeof h.manager.removeQueued> | undefined;
    // Withdraw as soon as the idle failure is published, while the following message is still waiting.
    unsubscribe = h.manager.subscribe(event => {
      if (event.threadId !== h.root.id || event.type !== 'thread.updated' || taken) return;
      const view = h.manager.threadView(h.root.id);
      if (!view.queued.some(q => q.id === queued.id && q.error)) return;
      assert.equal(view.status, 'idle');
      assert.equal(view.queued.length, 2);
      taken = h.manager.removeQueued(h.root.id, queued.id);
    });
    await h.manager.cancelTurn(h.root.id, { keepQueue: true });
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started' && e.data.text === 'after withdrawal'));
    assert.deepEqual(taken, { text: 'review this', images: [], mentions });
    await wait(() => h.manager.threadView(h.root.id).status !== 'running');
    assert.equal(h.manager.threadView(h.root.id).queued.length, 0);
  } finally { unsubscribe(); await h.close(); }
});

test('natural completion enables queued collaboration without cancelling the active turn', async () => {
  const h = await setup();
  try {
    const first = await h.manager.startTurn(h.root.id, { text: 'slowthink' });
    assert.ok('turnId' in first);
    const response = await h.api(`/api/threads/${h.root.id}/turns`, { text: 'after natural completion', queue: true,
      mentions: [{ id: 'claude', kind: 'agent', task: 'review' }] });
    assert.equal(response.status, 202);
    assert.equal(h.team.view(h.root.id), null);
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started' && String(e.data.text).startsWith('after natural completion')));
    const events = h.store.listEvents(h.root.id, 0, -1);
    const ended = events.find(e => e.type === 'turn.done' && e.turnId === first.turnId)!;
    assert.ok(ended);
    assert.notEqual(ended.data.stopReason, 'cancelled');
    assert.ok(h.team.view(h.root.id));
  } finally { await h.close(); }
});

/** Another daemon connected through a real relay, including collaboration file commands. */
async function otherMachine() {
  const dir = mkdtempSync(join(tmpdir(), 'calli-remote-'));
  const cwd = join(dir, 'far-project'); mkdirSync(cwd);
  const store = new Store(dir);
  const manager = new ThreadManager(store, new Map<string, AgentAdapter>([['pi', new PiRpcAdapter([process.execPath, join(fixtures, 'fake-pi.mjs')])]]), [cwd], new AttachmentStore(dir));
  const socket = join(dir, 'node.sock');
  const server = createHttpServer({ manager, trusted: true, token: 'node-token', webDir: null, version: 'node' });
  await listenPrivate(server, socket);
  const hosts = new HostRegistry({ file: null });
  const hubServer = createHttpServer({ manager, hosts, token: 'hub-token', webDir: null, version: 'hub' });
  await new Promise<void>(r => hubServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(hubServer.address() as AddressInfo).port}`;
  const { token } = hosts.add({ label: 'devbox' });
  let client: RelayClient;
  const connect = async () => {
    client = new RelayClient({ hubUrl: base, token, socket, version: 'node', retryMs: 50 });
    client.start();
    await wait(() => hosts.list()[0].status === 'online');
  };
  await connect();
  return { base, dir, cwd, store, manager, hosts, async setOnline(v: boolean) {
    if (v) await connect();
    else { client.stop(); await wait(() => hosts.list()[0].status === 'offline'); }
  }, async close() {
    client.stop(); hosts.dispose();
    await manager.shutdown();
    hubServer.closeAllConnections(); server.closeAllConnections();
    await new Promise<void>(r => hubServer.close(() => r()));
    await new Promise<void>(r => server.close(() => r()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('a member on another machine runs there and its answer comes back to the lead', async () => {
  const h = await setup();
  const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const agents = await h.team.command(h.root.id, { op: 'agents' }) as Array<{ id: string; host?: string }>;
    assert.ok(agents.some(a => a.id === 'pi@devbox' && a.host === 'devbox'));
    assert.ok(agents.some(a => a.id === 'pi' && !a.host));
    // Directories over there are that machine's: this machine's own list does not apply to them.
    await assert.rejects(h.team.command(h.root.id, spawn('rel', 'pi@devbox', 'x', { cwd: 'relative' })), /绝对路径/);
    // No folder is guessed for it; the lead is told where it could work and how to look further.
    await assert.rejects(h.team.command(h.root.id, spawn('nodir', 'pi@devbox', 'x')), (err: Error) => err.message.includes('--cwd') && err.message.includes(JSON.stringify([far.cwd])));
    assert.deepEqual(await h.team.command(h.root.id, { op: 'dirs', target: 'devbox' }), { machine: 'devbox', workdirs: [far.cwd] });
    mkdirSync(join(far.cwd, 'app'));
    const listed = await h.team.command(h.root.id, { op: 'dirs', target: 'devbox', path: far.cwd }) as { directories: string[]; usable: boolean };
    assert.deepEqual(listed.directories, [join(far.cwd, 'app')]);
    assert.equal(listed.usable, true);
    await assert.rejects(h.team.command(h.root.id, { op: 'dirs', target: 'nowhere' }), /没有这台机器/);
    assert.equal(h.team.view(h.root.id)!.members.length, 0);
    await h.team.command(h.root.id, spawn('far', 'pi@devbox', 'REMOTE_TASK', { cwd: far.cwd }));
    const member = h.team.view(h.root.id)!.members[0];
    assert.equal(member.host, 'devbox');
    assert.equal(h.store.getThread(member.id), null);
    assert.equal(far.manager.threadView(member.id).cwd, far.cwd);
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    const state = h.team.view(h.root.id)!;
    assert.match(state.members[0].latest!.result, /REMOTE_TASK/);
    assert.ok(state.members[0].thread);
    // The result goes to the lead like any member's, and starts its turn here.
    const result = state.messages.find(d => d.from === member.id && d.to === h.root.id && d.kind === 'result');
    assert.ok(result);
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started' && String(e.data.text).includes('REMOTE_TASK')));
    // A second message continues the same thread over there.
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    await h.team.command(h.root.id, { op: 'send', target: 'far', text: 'SECOND_TASK', requestId: 'far-2' });
    await wait(() => h.team.view(h.root.id)!.messages.some(d => d.text === 'SECOND_TASK' && d.state === 'returned'));
    assert.equal(far.manager.listThreads().length, 1);
  } finally { await h.close(); await far.close(); }
});

test('a remote member reads its task from a handoff file, writes a result file, and the lead gets both', async () => {
  const h = await setup();
  const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    // The member leaves its report as soon as it has the handoff, as a real one would while working.
    const plainExec = far.hosts.exec.bind(far.hosts);
    far.hosts.exec = async (id, command, opts) => {
      const run = await plainExec(id, command, opts);
      if (command.includes('handoff.md') && opts?.input) {
        const dir = opts.input.split('\n')[0];
        writeFileSync(join(dir, 'result.md'), '# REPORT\n\nall done\n', { mode: 0o600 });
      }
      return run;
    };
    const delivery = await h.team.command(h.root.id, spawn('far', 'pi@devbox', 'SHORT_INSTRUCTION', {
      cwd: far.cwd, handoff: '# 交接\n\n实现 REMOTE_RULE', requestId: 'far-handoff',
    })) as { id: string };
    // The file is read after the turn ends, so the result message is the sign that both are in.
    await wait(() => h.team.view(h.root.id)!.messages.some(m => m.kind === 'result' && m.resultFile));
    const member = h.team.view(h.root.id)!.members[0];
    const dir = join(h.dir, 'exchange', h.root.id, delivery.id);
    const handoff = readFileSync(join(dir, 'handoff.md'), 'utf8');
    assert.match(handoff, /REMOTE_RULE/, 'the explicit handoff file is the task');
    assert.match(handoff, new RegExp(join(dir, 'result.md')), 'and it says where the result goes');
    const started = far.store.listEvents(member.id, 0, -1).find(e => e.type === 'turn.started');
    assert.match(String(started?.data.text), /交接文件/, 'the member is pointed at the file');
    assert.match(String(started?.data.text), /SHORT_INSTRUCTION/, 'the message itself stays short');
    assert.ok(String(started?.data.text).includes(join(dir, 'handoff.md')));
    // The result comes back as a file, and the hub keeps its own copy for the page.
    const view = h.team.view(h.root.id)!;
    const result = view.messages.find(m => m.kind === 'result' && m.from === member.id)!;
    assert.ok(result.resultFile, 'the result names the file');
    assert.equal(result.resultFile!.name, 'result.md');
    assert.ok(!result.text.includes('结果文件：'), 'the page uses the button instead of a folder name');
    const rawResult = await h.team.command(h.root.id, { op: 'result', target: result.id }) as { text: string };
    assert.match(rawResult.text, /结果文件：/, 'the agent-facing result keeps the path');
    const local = join(h.dir, 'results', h.root.id, `${delivery.id}.md`);
    assert.equal(readFileSync(local, 'utf8'), '# REPORT\n\nall done\n');
    // The lead reads the same copy through calli result, which is what it can open with its own tools.
    const raw = await h.team.command(h.root.id, { op: 'result', target: delivery.id }) as { resultFile?: { localPath: string } };
    assert.equal(raw.resultFile?.localPath, local);
    const res = await h.api(`/api/threads/${h.root.id}/coordination/result/${delivery.id}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '# REPORT\n\nall done\n');
    assert.equal((await h.api(`/api/threads/${h.root.id}/coordination/result/${delivery.id}`, undefined, 'wrong')).status, 401);
    assert.equal((await h.api(`/api/threads/${h.root.id}/coordination/result/${'0'.repeat(36)}`)).status, 404);
  } finally { await h.close(); await far.close(); }
});

test('the calli CLI carries a local handoff file to the member machine', async () => {
  const h = await setup();
  const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const file = join(h.dir, 'task.md');
    writeFileSync(file, '# CLI 交接\n\nCLI_RULE 请按文件执行\n');
    // The same directive the fake agent's CLI runs: the flag is read by bin/calli, not by the hub.
    const directive = Buffer.from(JSON.stringify({
      args: ['spawn', '--agent', 'pi@devbox', '--name', 'cli-far', '--cwd', far.cwd, '--handoff-file', file, '--request-id', 'cli-far'],
      text: '',
    })).toString('base64');
    await h.manager.startTurn(h.root.id, { text: `CALLI_COMMAND:${directive}` });
    await wait(() => h.team.view(h.root.id)!.members.length === 1);
    const member = h.team.view(h.root.id)!.members[0];
    await wait(() => h.team.view(h.root.id)!.messages.some(m => m.to === member.id && m.state === 'returned'));
    const delivery = h.team.view(h.root.id)!.messages.find(m => m.to === member.id)!;
    const handoff = readFileSync(join(h.dir, 'exchange', h.root.id, delivery.id, 'handoff.md'), 'utf8');
    assert.match(handoff, /CLI_RULE/, 'the local file is the task');
    const started = far.store.listEvents(member.id, 0, -1).find(e => e.type === 'turn.started');
    assert.match(String(started?.data.text), /CLI_RULE/, 'and the member is pointed at it');
    assert.ok(String(started?.data.text).includes(join(h.dir, 'exchange', h.root.id, delivery.id, 'handoff.md')));
  } finally { await h.close(); await far.close(); }
});

test('the lead reads and writes a remote member folder over relay; other members only read', async () => {
  const h = await setup();
  const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    writeFileSync(join(far.cwd, 'data.txt'), 'remote content\n');
    await h.team.command(h.root.id, spawn('far', 'pi@devbox', 'TASK', { cwd: far.cwd }));
    // Only local members have a calli caller identity; remote workers remain relay targets.
    const peer = await h.team.command(h.root.id, spawn('local', 'pi', 'LOCAL_TASK', {})) as { to: string };
    const listed = await h.team.command(h.root.id, { op: 'remote', action: 'ls', target: 'far' }) as { entries: Array<{ name: string }> };
    assert.ok(listed.entries.some(e => e.name === 'data.txt'));
    const read = await h.team.command(h.root.id, { op: 'remote', action: 'read', target: 'far', path: 'data.txt' }) as { text: string; hash: string; size: number; truncated: boolean };
    assert.equal(read.text, 'remote content\n');
    assert.equal(read.size, 15);
    assert.equal(read.truncated, false);
    const partial = await h.team.command(h.root.id, { op: 'remote', action: 'read', target: 'far', path: 'data.txt', offset: 7, limit: 7 }) as { text: string; truncated: boolean };
    assert.equal(partial.text, 'content');
    assert.equal(partial.truncated, true);
    const written = await h.team.command(h.root.id, { op: 'remote', action: 'write', target: 'far', path: 'data.txt', text: 'changed\n', expectHash: read.hash }) as { size: number };
    assert.equal(written.size, 8);
    assert.equal(readFileSync(join(far.cwd, 'data.txt'), 'utf8'), 'changed\n');
    assert.equal((await h.team.command(peer.to, { op: 'remote', action: 'read', target: 'far', path: 'data.txt' }) as { text: string }).text, 'changed\n');
    await assert.rejects(h.team.command(peer.to, { op: 'remote', action: 'write', target: 'far', path: 'data.txt', text: 'no' }), (err: any) => err.status === 403);
    // A stale hash does not overwrite what someone else wrote.
    await assert.rejects(
      h.team.command(h.root.id, { op: 'remote', action: 'write', target: 'far', path: 'data.txt', text: 'stale', expectHash: '0'.repeat(64) }),
      (err: any) => err.status === 409,
    );
    // Outside the member's own folder is refused, however the path is spelled.
    await assert.rejects(h.team.command(h.root.id, { op: 'remote', action: 'read', target: 'far', path: '../outside.txt' }), (err: any) => err.status === 403);
    await assert.rejects(h.team.command(h.root.id, { op: 'remote', action: 'write', target: 'far', path: '/etc/calli-nope', text: 'no' }), (err: any) => err.status === 403);
    writeFileSync(join(far.dir, 'outside.txt'), 'outside\n');
    symlinkSync(join(far.dir, 'outside.txt'), join(far.cwd, 'link.txt'));
    await assert.rejects(h.team.command(h.root.id, { op: 'remote', action: 'read', target: 'far', path: 'link.txt' }), (err: any) => err.status === 403);
    // Binary files are not read as text.
    writeFileSync(join(far.cwd, 'bin'), Buffer.from([0, 1, 2]));
    await assert.rejects(h.team.command(h.root.id, { op: 'remote', action: 'read', target: 'far', path: 'bin' }), (err: any) => err.status === 415);
    // A local member has no folder on another machine.
    await assert.rejects(h.team.command(h.root.id, { op: 'remote', action: 'read', target: 'local', path: 'x' }), (err: any) => err.status === 400);
  } finally { await h.close(); await far.close(); }
});

test('a handoff stays inline when the machine cannot take the file', async () => {
  const h = await setup();
  const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    far.hosts.exec = async () => { throw new HttpError(502, 'remote execution is unavailable'); };
    await h.team.command(h.root.id, spawn('far', 'pi@devbox', 'INLINE_TASK', { cwd: far.cwd }));
    const member = h.team.view(h.root.id)!.members[0];
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    const started = far.store.listEvents(member.id, 0, -1).find(e => e.type === 'turn.started');
    assert.match(String(started?.data.text), /INLINE_TASK/);
    assert.ok(!String(started?.data.text).includes('交接文件'), 'no pointer to a file that is not there');
    assert.equal(h.team.view(h.root.id)!.messages.find(m => m.kind === 'result')?.resultFile, undefined);
  } finally { await h.close(); await far.close(); }
});

test('a member on another machine works in a temporary worktree of a git repository there, and the branch it was on stays', async () => {
  const h = await setup();
  const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const repo = join(far.cwd, 'repo'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-q', '-m', 'one');
    await h.team.command(h.root.id, spawn('far', 'pi@devbox', 'REMOTE_TASK', { cwd: repo }));
    const member = h.team.view(h.root.id)!.members[0] as { id: string; worktree?: string };
    const there = far.manager.threadView(member.id);
    assert.ok(there.worktree, 'a worktree was made over there');
    assert.ok(there.cwd.startsWith(join(repo, '.worktrees')), 'the member stands in it, not in the folder it was given');
    assert.equal(member.worktree, there.worktree!.branch, 'the lead can see which branch it is');
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the branch checked out there is untouched');
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    assert.match(h.team.view(h.root.id)!.members[0].latest!.result, /临时 git worktree/, 'and the member is told');
    // A folder that is no repository there is used as it is.
    mkdirSync(join(far.cwd, 'plain'));
    await h.team.command(h.root.id, spawn('plain', 'pi@devbox', 'PLAIN_TASK', { cwd: join(far.cwd, 'plain') }));
    const plain = h.team.view(h.root.id)!.members.find(m => m.name === 'plain') as { id: string; worktree?: string };
    assert.equal(plain.worktree, undefined);
    assert.equal(far.manager.threadView(plain.id).worktree, null);
  } finally { await h.close(); await far.close(); }
});

test('messages for a machine that is away wait for it, and the user can @ an instance there', async () => {
  const h = await setup();
  const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const text = h.team.mentionText(h.root.id, 'split it', [{ id: 'pi@devbox', kind: 'agent', label: 'Pi · Devbox', cwd: far.cwd, task: 'check' }]);
    assert.match(text, /"agent":"pi@devbox"/);
    assert.throws(() => h.team.mentionText(h.root.id, 'x', [{ id: 'pi@devbox', kind: 'agent', cwd: 'rel' }]), /绝对路径/);
    assert.throws(() => h.team.mentionText(h.root.id, 'x', [{ id: 'pi@nowhere', kind: 'agent' }]), /实例不在本次协作中/);
    await h.team.command(h.root.id, spawn('far', 'pi@devbox', 'LATER', { cwd: far.cwd }));
    await far.setOnline(false);
    // Spawned while online; the first message only goes out once the machine is back.
    await new Promise(r => setTimeout(r, 300));
    const pending = h.team.view(h.root.id)!.messages.find(d => d.text === 'LATER')!;
    assert.ok(['queued', 'running'].includes(pending.state));
    await far.setOnline(true);
    await wait(() => h.team.view(h.root.id)!.messages.some(d => d.text === 'LATER' && d.state === 'returned'));
  } finally { await h.close(); await far.close(); }
});

test('the person talking to a member directly is answered there and told to the lead once, without waking it', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const worker = (await h.team.command(h.root.id, spawn('worker')) as { to: string }).to;
    // The spawn's own result reaches the lead and is answered before the person steps in.
    await wait(() => h.team.view(h.root.id)!.messages.some(d => d.to === h.root.id && d.state === 'returned'));
    await wait(() => h.manager.threadView(h.root.id).status === 'idle' && h.manager.threadView(worker).status === 'idle');
    const before = h.team.view(h.root.id)!.messages.filter(d => d.to === h.root.id).length;
    const leadTurns = () => h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').length;
    const turnsBefore = leadTurns();

    const response = await h.api(`/api/threads/${worker}/turns`, { text: 'tighten the summary' });
    assert.equal(response.status, 202);
    const { turnId } = await response.json() as { turnId: string };
    await wait(() => h.team.view(h.root.id)!.messages.some(d => d.from === 'user'));
    const started = h.store.listEvents(worker, 0, -1).find(e => e.turnId === turnId && e.type === 'turn.started')!;
    assert.equal(started.data.fromUser, true);
    assert.equal(started.data.displayText, 'tighten the summary');
    assert.match(String(started.data.text), /用户直接发给你的/);

    const view = h.team.view(h.root.id)!;
    const talk = view.messages.find(d => d.from === 'user')!;
    assert.equal(talk.to, worker);
    assert.equal(talk.text, 'tighten the summary');
    assert.equal(talk.state, 'returned');
    assert.match(talk.result, /there tighten the summary/);
    assert.equal(talk.replyTo, null);
    // Nothing went to the lead, and it did not run.
    await new Promise(r => setTimeout(r, 200));
    assert.equal(h.team.view(h.root.id)!.messages.filter(d => d.to === h.root.id).length, before);
    assert.equal(leadTurns(), turnsBefore);

    // The lead hears of it with its next turn, once.
    await h.manager.startTurn(h.root.id, { text: 'how is it going' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    const told = h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').at(-1)!;
    assert.match(String(told.data.text), /用户对 worker 说：tighten the summary/);
    await h.manager.startTurn(h.root.id, { text: 'and now' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    const later = h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').at(-1)!;
    assert.doesNotMatch(String(later.data.text), /用户对 worker 说/);
  } finally { await h.close(); }
});

/** A switch commits while the serialized pump is waiting, before its local claim can start a turn. */
test('disabling a preparing local delivery commits promptly and stops its old queue permanently', async () => {
  const h = await setup();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const start = h.manager.startTurn.bind(h.manager);
  let preparing = false;
  h.manager.startTurn = async (id, input, delivery) => { if (delivery) { preparing = true; await gate; } return start(id, input, delivery); };
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('claim')) as { to: string; id: string };
    await wait(() => preparing);
    await Promise.race([h.manager.updateThread(job.to, { disabled: true }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('switch waited behind pump')), 500))]);
    assert.equal(h.team.view(h.root.id)!.messages.find(d => d.id === job.id)!.state, 'stopped');
    release(); await h.team.command(h.root.id, { op: 'status' });
    assert.equal(h.store.listEvents(job.to, 0, -1).some(e => e.type === 'turn.started'), false);
    await h.manager.updateThread(job.to, { disabled: false });
    assert.equal((await h.team.command(h.root.id, spawn('claim')) as any).state, 'stopped');
    await h.team.command(h.root.id, { op: 'send', target: 'claim', text: 'new work', requestId: 'claim-new' });
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    assert.equal(h.store.listEvents(job.to, 0, -1).filter(e => e.type === 'turn.started').length, 1);
  } finally { release(); await h.close(); }
});

/** Only completed results are sticky-suppressed; the active member turn is not cancelled. */
test('local results received while disabled remain in history and cannot revive on enabling or restart', async () => {
  const h = await setup();
  let restored: CoordinationManager | undefined;
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('late-result', 'pi', 'slowthink')) as { to: string; id: string };
    await wait(() => h.manager.threadView(job.to).status === 'running');
    await h.manager.updateThread(job.to, { disabled: true });
    assert.equal((h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any).suppressed, undefined);
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    const messages = h.team.view(h.root.id)!.messages;
    assert.equal((messages.find(d => d.id === job.id) as any).suppressed, true);
    assert.ok(messages.some(d => d.kind === 'result' && d.state === 'stopped' && 'suppressed' in d && d.suppressed));
    const ending = h.store.listEvents(job.to, 0, -1).find(e => e.type === 'turn.done')!;
    assert.notEqual(ending.data.stopReason, 'cancelled');
    assert.equal(h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'), false);
    await h.manager.updateThread(job.to, { disabled: false });
    await assert.rejects(h.team.command(h.root.id, { op: 'result', target: job.id }), /抑制/);
    await assert.rejects(h.team.command(h.root.id, spawn('late-result', 'pi', 'slowthink')), /抑制/);
    const execution = await h.team.command(h.root.id, { op: 'status' }) as any;
    assert.equal(execution.members[0].latest, null);
    assert.equal(execution.members[0].thread?.coordination?.doing, undefined);
    assert.equal(execution.members[0].thread?.preview, undefined);
    assert.equal(execution.members[0].thread?.title, 'late-result', 'an existing collaboration title is preserved');
    assert.ok(h.team.view(h.root.id)!.members[0].latest?.result, 'browser history retains the member answer');
    h.team.dispose();
    restored = new CoordinationManager(h.store, h.manager, join(h.dir, 'restored.sock'));
    assert.ok(restored.view(h.root.id)!.messages.some(d => d.kind === 'result' && d.state === 'stopped' && 'suppressed' in d && d.suppressed));
    await restored.command(h.root.id, { op: 'status' });
    assert.equal(h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'), false);
    assert.ok(h.store.listEvents(job.to, 0, -1).some(e => e.type === 'message.delta'), 'member history remains readable');
  } finally { restored?.dispose(); await h.close(); }
});

/** Re-enabling before completion preserves the original turn's normal result path. */
test('a member re-enabled before its original turn finishes can return its result', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('restored-turn', 'pi', 'slowthink')) as { to: string; id: string };
    await wait(() => h.manager.threadView(job.to).status === 'running');
    await h.manager.updateThread(job.to, { disabled: true });
    await h.manager.updateThread(job.to, { disabled: false });
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    assert.equal((h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any).suppressed, undefined);
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'));
    assert.ok(h.team.view(h.root.id)!.messages.some(d => d.kind === 'result' && !('suppressed' in d && d.suppressed)));
  } finally { await h.close(); }
});

/** An already queued notification is actually withheld and cannot become work after enabling. */
test('disabling a queued local result suppresses its related delivery permanently', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const job = await h.team.command(h.root.id, spawn('queued-result')) as { to: string; id: string };
    await wait(() => h.team.view(h.root.id)!.messages.some(d => d.kind === 'result' && d.state === 'queued'));
    await h.manager.updateThread(job.to, { disabled: true });
    await h.manager.updateThread(job.to, { disabled: false });
    assert.equal((h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any).suppressed, true);
    await h.manager.cancelTurn(h.root.id, { keepQueue: true });
    await h.team.command(h.root.id, { op: 'status' });
    assert.equal(h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').length, 1);
  } finally { await h.close(); }
});

/** A preparation error arriving after a switch is history, not a fresh notification. */
test('a late local start error is suppressed without reviving its stopped delivery', async () => {
  const h = await setup();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const start = h.manager.startTurn.bind(h.manager);
  let preparing = false;
  h.manager.startTurn = async (id, input, delivery) => {
    if (delivery) { preparing = true; await gate; throw new Error('delayed startup failure'); }
    return start(id, input, delivery);
  };
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('error-gate')) as { to: string; id: string };
    await wait(() => preparing);
    await h.manager.updateThread(job.to, { disabled: true });
    await h.manager.updateThread(job.to, { disabled: false });
    release(); await h.team.command(h.root.id, { op: 'status' });
    const message = h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any;
    assert.equal(message.state, 'stopped'); assert.equal(message.suppressed, true);
    assert.match(message.result, /startup failure/);
    assert.ok(h.team.view(h.root.id)!.messages.some(d => d.key === `start-error:${job.id}` && 'suppressed' in d && d.suppressed && d.state === 'stopped'));
    assert.equal(h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'), false);
  } finally { release(); await h.close(); }
});

/** Legacy local records default to enabled and recover withheld results without replay. */
test('legacy local records recover suppressed results without reconstructing runnable notifications', async () => {
  const h = await setup();
  let restored: CoordinationManager | undefined;
  try {
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('legacy')) as { id: string; to: string };
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    h.team.dispose();
    const row = JSON.parse(h.store.coordinationRecords()[0].data);
    delete row.enabled;
    row.deliveries = row.deliveries.filter((d: any) => d.id === job.id);
    row.deliveries[0].state = 'running'; row.deliveries[0].suppressed = true;
    h.store.saveCoordination(h.root.id, JSON.stringify(row));
    restored = new CoordinationManager(h.store, h.manager, join(h.dir, 'legacy.sock'));
    const view = restored.view(h.root.id)!;
    assert.equal(view.enabled, true);
    assert.equal(view.members[0].thread!.disabled, false);
    assert.equal(view.messages.find(d => d.id === job.id)!.state, 'returned');
    assert.ok(view.messages.some(d => d.kind === 'result' && d.state === 'stopped' && 'suppressed' in d && d.suppressed));
    const before = h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').length;
    await restored.command(h.root.id, { op: 'status' });
    assert.equal(h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').length, before);
  } finally { restored?.dispose(); await h.close(); }
});

/** A told DirectTalk hides only its current failure in CLI execution, while browser history remains intact. */
test('a suppressed DirectTalk failure cannot leak through CLI member metadata after enabling', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const member = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
    const raw = (h.team as any).teams.get(h.root.id);
    raw.members.push({ id: member.id, name: 'direct-failure' });
    (h.team as any).changed(raw);
    await h.manager.updateThread(member.id, { disabled: true });
    const direct = await h.manager.startTurn(member.id, { text: 'private fail', fromUser: true });
    await wait(() => raw.direct?.some((d: any) => d.turnId === direct.turnId && d.told));
    assert.match(h.manager.threadView(member.id).failure!.message, /provider exploded/);
    await h.manager.updateThread(member.id, { disabled: false });
    const status = await h.team.command(h.root.id, { op: 'status' }) as any;
    assert.equal(status.members.find((m: any) => m.id === member.id).thread.failure, undefined);
    assert.doesNotMatch(JSON.stringify(status), /provider exploded|private fail/);
    assert.equal(status.members[0].thread.preview, undefined);
    assert.equal(status.members[0].thread.title, 'direct-failure');
    assert.equal(status.messages.some((d: any) => d.text === 'private fail'), false);
    assert.equal(h.team.view(h.root.id)!.members[0].thread!.preview, 'private fail');
    assert.equal(h.team.view(h.root.id)!.members[0].thread!.title, 'private fail');
    assert.match(h.team.view(h.root.id)!.members[0].thread!.failure!.message, /provider exploded/);
    assert.ok(h.store.listTurnEvents(member.id, direct.turnId).some(e => e.type === 'turn.error' && String(e.data.message).includes('provider exploded')));
    // A later legitimate collaboration failure must not be masked by that old told turn.
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const allowed = await h.team.command(h.root.id, { op: 'send', target: member.id, text: 'allowed work fail', requestId: 'allowed-failure' }) as { id: string };
    await wait(() => h.team.view(h.root.id)!.messages.find(d => d.id === allowed.id)?.state === 'failed');
    const later = await h.team.command(h.root.id, { op: 'status' }) as any;
    assert.match(later.members.find((m: any) => m.id === member.id).thread.failure.message, /provider exploded/);
    assert.match(later.members.find((m: any) => m.id === member.id).latest.text, /allowed work fail/);
    assert.doesNotMatch(JSON.stringify(later), /private fail/);
    assert.equal(h.manager.threadView(member.id).preview, 'private fail', 'a legitimate coordination turn does not overwrite the browser preview');
    const completed = await h.team.command(h.root.id, { op: 'send', target: member.id, text: 'allowed work completes', requestId: 'allowed-completion' }) as { id: string };
    await wait(() => h.team.view(h.root.id)!.messages.find(d => d.id === completed.id)?.state === 'returned');
    assert.doesNotMatch(JSON.stringify(await h.team.command(h.root.id, { op: 'status' })), /private fail/);
    assert.equal(h.manager.threadView(member.id).preview, 'private fail');
    // A pre-existing title is not hidden just because this member has a withheld direct reply.
    const named = await h.manager.createThread({ agent: 'pi', cwd: h.cwd, title: 'Existing manual title' });
    raw.members.push({ id: named.id, name: 'named-member' });
    await h.manager.updateThread(named.id, { disabled: true });
    const namedTalk = await h.manager.startTurn(named.id, { text: 'another private fail', fromUser: true });
    await wait(() => raw.direct?.some((d: any) => d.turnId === namedTalk.turnId && d.told));
    await h.manager.updateThread(named.id, { disabled: false });
    const namedStatus = await h.team.command(h.root.id, { op: 'status' }) as any;
    assert.equal(namedStatus.members.find((m: any) => m.id === named.id).thread.title, 'Existing manual title');
    assert.equal(namedStatus.members.find((m: any) => m.id === named.id).thread.preview, undefined);
  } finally { await h.close(); }
});

/** A rebuilt hub must recover the actual failure turn even when the withheld remote task is already terminal. */
test('suppressed remote failures remain hidden after recreation without hiding later allowed failures', async () => {
  const h = await setup(); const far = await otherMachine();
  let restored: CoordinationManager | undefined;
  let eventsReady = false;
  const call = far.hosts.call.bind(far.hosts);
  far.hosts.call = async (id, method, path, body) => {
    if (!eventsReady && path.includes('/events?')) throw new HttpError(409, 'event log temporarily unavailable');
    return call(id, method, path, body);
  };
  try {
    await h.team.enable(h.root.id);
    const member = await far.manager.createThread({ agent: 'pi', cwd: far.cwd, title: 'remote-failure' });
    const failed = await far.manager.startTurn(member.id, { text: 'old private fail' });
    await wait(() => far.manager.threadView(member.id).status === 'error');
    h.team.dispose();
    const row = JSON.parse(h.store.coordinationRecords()[0].data);
    row.members = [{ id: member.id, name: 'remote-failure', host: 'devbox' }];
    row.deliveries = [
      { id: 'old-remote-task', key: 'old-remote-task', fingerprint: '', from: h.root.id, to: member.id,
        text: 'old private fail', kind: 'message', state: 'failed', turnId: failed.turnId, result: 'provider exploded', suppressed: true, createdAt: new Date().toISOString() },
      { id: 'old-remote-result', key: `result:${member.id}:${failed.turnId}`, fingerprint: '', from: member.id, to: h.root.id,
        text: 'provider exploded', kind: 'result', state: 'stopped', turnId: null, result: '', suppressed: true, createdAt: new Date().toISOString() },
    ];
    h.store.saveCoordination(h.root.id, JSON.stringify(row));
    restored = new CoordinationManager(h.store, h.manager, join(h.dir, 'remote-failure-recovery.sock'));
    restored.hosts = far.hosts;
    await (restored as any).pollRemote();
    const status = await restored.command(h.root.id, { op: 'status' }) as any;
    assert.equal(status.members[0].thread.failure, undefined);
    assert.doesNotMatch(JSON.stringify(status), /provider exploded|old private fail/);
    assert.equal(status.members[0].thread.title, 'remote-failure');
    assert.equal(status.members[0].thread.preview, undefined);
    assert.match((restored.view(h.root.id)!.members[0].thread as any).failure.message, /provider exploded/);
    assert.equal((restored as any).remoteFailures.has(`devbox:${member.id}`), false, 'a view alone cannot establish the failing turn');
    eventsReady = true;
    await (restored as any).pollRemote();
    assert.equal((restored as any).remoteFailures.get(`devbox:${member.id}`).turnId, failed.turnId);
    assert.equal((await restored.command(h.root.id, { op: 'status' }) as any).members[0].thread.failure, undefined);
    assert.equal(h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'), false);
    await h.manager.startTurn(h.root.id, { text: 'slow' });
    const allowed = await restored.command(h.root.id, { op: 'send', target: member.id, text: 'later allowed fail', requestId: 'later-remote-failure' }) as { id: string };
    await wait(() => restored!.view(h.root.id)!.messages.find(d => d.id === allowed.id)?.state === 'failed');
    const later = await restored.command(h.root.id, { op: 'status' }) as any;
    assert.match(later.members[0].thread.failure.message, /provider exploded/);
    assert.match(later.members[0].latest.text, /later allowed fail/);
    assert.equal(far.store.listEvents(member.id, 0, -1).filter(e => e.type === 'turn.error').length, 2);
  } finally { restored?.dispose(); await h.close(); await far.close(); }
});

/** Final prompt filtering removes switched-off summaries and consumes only injected records. */
test('DirectTalk filtering leaves other members and older uninjected summaries untouched', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const members = await Promise.all(['a', 'b', 'c'].map(name => h.manager.createThread({ agent: 'pi', cwd: h.cwd, title: name })));
    const raw = (h.team as any).teams.get(h.root.id);
    raw.members = members.map((m, i) => ({ id: m.id, name: ['a', 'b', 'c'][i] }));
    raw.direct = Array.from({ length: 8 }, (_, i) => ({ id: `talk-${i}`, to: members[i < 6 ? 0 : i - 5].id,
      turnId: `direct-${i}`, text: `person-${i}`, result: `answer-${i}`, state: 'returned', createdAt: new Date().toISOString() }));
    (h.team as any).changed(raw);
    const instructions = h.team.instructions.bind(h.team);
    let switched = false;
    h.team.instructions = (id, text, fromUser, gate) => {
      const result = instructions(id, text, fromUser, gate);
      if (id === h.root.id && !switched) { switched = true; void h.manager.updateThread(members[1].id, { disabled: true }); }
      return result;
    };
    await h.manager.startTurn(h.root.id, { text: 'read selected summaries' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    const first = h.store.listEvents(h.root.id, 0, -1).find(e => e.type === 'turn.started')!;
    assert.doesNotMatch(String(first.data.text), /person-6|answer-6/);
    assert.match(String(first.data.text), /person-7/);
    assert.deepEqual(raw.direct.map((d: any) => Boolean(d.told)), [false, false, false, true, true, true, true, true]);
    await h.manager.startTurn(h.root.id, { text: 'read remaining summaries' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    const second = h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').at(-1)!;
    assert.match(String(second.data.text), /person-0/); assert.doesNotMatch(String(second.data.text), /person-6|person-7/);
    assert.ok(raw.direct.every((d: any) => d.told));
    // Direct user chat still runs on the disabled member and is never offered to the lead later.
    await h.manager.startTurn(members[1].id, { text: 'private direct message', fromUser: true });
    await wait(() => raw.direct.some((d: any) => d.text === 'private direct message'));
    assert.equal(raw.direct.find((d: any) => d.text === 'private direct message').told, true);
    await h.manager.updateThread(members[1].id, { disabled: false });
    const status = await h.team.command(h.root.id, { op: 'status' }) as any;
    assert.equal(status.messages.some((d: any) => d.text === 'private direct message' || d.text === 'person-6'), false);
    assert.ok(h.team.view(h.root.id)!.messages.some(d => d.text === 'private direct message'), 'browser history keeps the withheld direct reply');
    await h.manager.startTurn(h.root.id, { text: 'after private direct message' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    assert.doesNotMatch(String(h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').at(-1)!.data.text), /用户对 b 说：private direct message/);
  } finally { await h.close(); }
});

/** A root moving during either discovery or refresh must never be registered under both ids. */
test('configuration enabling rechecks root ownership after discovery and runtime refresh', async () => {
  const h = await setup();
  let release = () => {};
  const prepare = (h.team as any).prepare.bind(h.team);
  const refresh = h.manager.refreshRuntime.bind(h.manager);
  try {
    for (const phase of ['prepare', 'refresh']) {
      const root = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
      // Recover inert configuration directly; the retired object-switch API is not its owner.
      const configured = await prepare(root.id, { permission: 'ask' });
      configured.enabled = false;
      (h.team as any).teams.set(root.id, configured);
      (h.team as any).changed(configured);
      const gate = new Promise<void>(r => { release = r; });
      let preparing = false, refreshes = 0;
      (h.team as any).prepare = async (id: string, input: unknown) => {
        const result = await prepare(id, input);
        if (id === root.id && phase === 'prepare') { preparing = true; await gate; }
        return result;
      };
      h.manager.refreshRuntime = async id => {
        if (id === root.id) {
          refreshes++;
          if (phase === 'refresh') { preparing = true; await gate; }
        }
        await refresh(id);
      };
      const pending = h.team.enable(root.id);
      const rejected = assert.rejects(pending, /主线程已变化/);
      await wait(() => preparing);
      const successor = await h.manager.createHandoverThread(root.id, 'claude');
      release(); await rejected;
      assert.equal(h.team.view(successor.id)!.enabled, false);
      assert.equal(h.team.view(successor.id)!.permission, 'ask');
      assert.equal((h.team as any).teams.has(root.id), false, 'the source never becomes a second root alias');
      assert.equal(refreshes, phase === 'prepare' ? 0 : 1);
      (h.team as any).prepare = prepare;
      h.manager.refreshRuntime = refresh;
    }
  } finally { release(); (h.team as any).prepare = prepare; h.manager.refreshRuntime = refresh; await h.close(); }
});

/** A remote POST must recheck after handoff IO, with switches not queued behind that IO. */
test('disabling a remote member during handoff prevents the final POST and stops its old queue', async () => {
  const h = await setup(); const far = await otherMachine();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const exec = far.hosts.exec.bind(far.hosts);
  let preparing = false;
  far.hosts.exec = async (id, command, opts) => { if (command.includes('handoff.md')) { preparing = true; await gate; } return exec(id, command, opts); };
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('remote-post', 'pi@devbox', 'REMOTE_BEFORE_SWITCH', { cwd: far.cwd })) as { id: string; to: string };
    await wait(() => preparing);
    await Promise.race([far.manager.updateThread(job.to, { disabled: true }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('switch waited behind remote IO')), 500))]);
    // Refresh the remote thread flag while handoff IO still holds the delivery chain.
    await (h.team as any).pollRemote();
    assert.equal(h.team.view(h.root.id)!.members[0].thread!.disabled, true);
    release(); await h.team.command(h.root.id, { op: 'status' });
    assert.equal(far.store.listEvents(job.to, 0, -1).some(e => e.type === 'turn.started'), false);
    assert.equal(h.team.view(h.root.id)!.messages.find(d => d.id === job.id)!.state, 'stopped');
    await assert.rejects(h.team.command(h.root.id, { op: 'remote', action: 'ls', target: 'remote-post' }), /退出协作/);
    await far.manager.updateThread(job.to, { disabled: false });
    await h.team.command(h.root.id, { op: 'send', target: 'remote-post', text: 'NEW_REMOTE_WORK', requestId: 'new-remote-post' });
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    assert.equal(far.store.listEvents(job.to, 0, -1).filter(e => e.type === 'turn.started').length, 1);
  } finally { release(); await h.close(); await far.close(); }
});

/** A quarantined remote queue cannot revive through a non-409 preparation error after enabling. */
test('a late remote start error stays suppressed after disabling and re-enabling its member', async () => {
  const h = await setup(); const far = await otherMachine();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const call = far.hosts.call.bind(far.hosts);
  let preparing = false;
  far.hosts.call = async (id, method, path, body) => {
    if (method === 'POST' && path.endsWith('/turns')) {
      preparing = true; await gate; throw new Error('late remote startup failure');
    }
    return call(id, method, path, body);
  };
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('remote-error-gate', 'pi@devbox', 'hello', { cwd: far.cwd })) as { id: string; to: string };
    await wait(() => preparing);
    // Withdrawal observed during an in-flight POST must survive a later non-409 failure.
    await far.manager.updateThread(job.to, { disabled: true });
    await (h.team as any).pollRemote();
    await wait(() => h.team.view(h.root.id)!.messages.find(d => d.id === job.id)?.state === 'stopped');
    await far.manager.updateThread(job.to, { disabled: false });
    await (h.team as any).pollRemote();
    await wait(() => h.team.view(h.root.id)!.members[0].thread!.disabled === false);
    release(); await h.team.command(h.root.id, { op: 'status' });
    const message = h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any;
    assert.equal(message.state, 'stopped'); assert.equal(message.suppressed, true);
    assert.match(message.result, /remote startup failure/);
    assert.ok(h.team.view(h.root.id)!.messages.some(d => d.key === `start-error:${job.id}` && 'suppressed' in d && d.suppressed && d.state === 'stopped'));
    assert.equal(far.store.listEvents(job.to, 0, -1).some(e => e.type === 'turn.started'), false);
    assert.equal(h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'), false);
  } finally { release(); await h.close(); await far.close(); }
});

/** Remote receipt, not a remote timestamp, makes suppression sticky across later file IO. */
test('remote results received while disabled stay suppressed after enabling during result IO', async () => {
  const h = await setup(); const far = await otherMachine();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const collect = (h.team as any).collectResult.bind(h.team);
  let received = false;
  (h.team as any).collectResult = async (...args: unknown[]) => { received = true; await gate; return collect(...args); };
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('remote-result', 'pi@devbox', 'slowthink', { cwd: far.cwd })) as { id: string; to: string };
    await wait(() => far.manager.threadView(job.to).status === 'running');
    await far.manager.updateThread(job.to, { disabled: true });
    assert.equal((h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any).suppressed, undefined);
    await wait(() => received);
    assert.equal((h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any).suppressed, true);
    await far.manager.updateThread(job.to, { disabled: false });
    release(); await h.team.command(h.root.id, { op: 'status' });
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    assert.ok(h.team.view(h.root.id)!.messages.some(d => d.kind === 'result' && 'suppressed' in d && d.suppressed && d.state === 'stopped'));
    await assert.rejects(h.team.command(h.root.id, { op: 'result', target: job.id }), /抑制/);
    assert.equal(h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'), false);
    assert.notEqual(far.store.listEvents(job.to, 0, -1).find(e => e.type === 'turn.done')!.data.stopReason, 'cancelled');
  } finally { release(); await h.close(); await far.close(); }
});

/** A disconnected result not yet received is evaluated against the restored current state. */
test('remote results not received while disabled can return after reconnecting enabled', async () => {
  const h = await setup(); const far = await otherMachine();
  try {
    h.team.hosts = far.hosts;
    await h.team.enable(h.root.id);
    const job = await h.team.command(h.root.id, spawn('remote-offline-result', 'pi@devbox', 'slowthink', { cwd: far.cwd })) as { id: string; to: string };
    await wait(() => h.team.view(h.root.id)!.messages.find(d => d.id === job.id)?.state === 'running');
    await far.setOnline(false);
    await far.manager.updateThread(job.to, { disabled: true });
    await wait(() => far.manager.threadView(job.to).status === 'idle');
    assert.equal((h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any).suppressed, undefined);
    await far.manager.updateThread(job.to, { disabled: false });
    await far.setOnline(true);
    await wait(() => h.team.view(h.root.id)!.members[0].latest?.state === 'returned');
    assert.equal((h.team.view(h.root.id)!.messages.find(d => d.id === job.id) as any).suppressed, undefined);
    await wait(() => h.store.listEvents(h.root.id, 0, -1).some(e => e.type === 'turn.started'));
  } finally { await h.close(); await far.close(); }
});

test('a message the person queues behind a member\'s task is still theirs when it goes out', async () => {
  const h = await setup();
  try {
    await h.team.enable(h.root.id);
    const worker = (await h.team.command(h.root.id, spawn('worker', 'pi', 'slow')) as { to: string }).to;
    await wait(() => h.manager.threadView(worker).status === 'running');
    const queued = await h.api(`/api/threads/${worker}/turns`, { text: 'after that, add tests', queue: true });
    assert.equal(queued.status, 202);
    const { id } = await queued.json() as { id: string };
    await h.manager.sendQueuedNow(worker, id);
    await wait(() => h.team.view(h.root.id)!.messages.some(d => d.from === 'user' && d.state === 'returned'));
    const starts = h.store.listEvents(worker, 0, -1).filter(e => e.type === 'turn.started');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].data.fromUser, undefined);
    assert.equal(starts[1].data.fromUser, true);
    // Turns the hub starts in a member stay deliveries; the lead's own thread is never "direct".
    await h.api(`/api/threads/${h.root.id}/turns`, { text: 'lead turn' });
    await wait(() => h.manager.threadView(h.root.id).status === 'idle');
    assert.equal(h.store.listEvents(h.root.id, 0, -1).filter(e => e.type === 'turn.started').at(-1)!.data.fromUser, undefined);
  } finally { await h.close(); }
});
