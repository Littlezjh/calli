import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store, type TodoRecord } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { personalServer } from '../src/personal.js';
import { preparationCandidate, ProactiveService, type ProactiveRun } from '../src/proactive.js';
import { ProactiveSandbox } from '../src/proactive-sandbox.js';
import { PushService } from '../src/push.js';
import { Scheduler } from '../src/scheduler.js';

const exec = promisify(execFile);
const now = new Date(2026, 10, 1, 12);
const at = (hour: number, day = 1) => new Date(2026, 10, day, hour).toISOString();
const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out');
};
const historical = (id: string, kind: ProactiveRun['kind'], startedAt = at(8)): ProactiveRun => ({ id, kind, matterId: `old-${id}`, threadId: '', startedAt, endedAt: startedAt, status: 'discarded' });
async function setup(mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'calli-proactive-'));
  const cwd = join(dir, 'personal'); mkdirSync(cwd);
  const store = new Store(dir);
  const adapters = new Map<string, AgentAdapter>([['claude', new ClaudeAcpAdapter([process.execPath, resolve('test/fixtures/fake-acp.mjs')], mode ? { FAKE_PROACTIVE_MODE: mode } : {})]]);
  const manager = new ThreadManager(store, adapters, [dir], new AttachmentStore(dir));
  const personal = manager.personal, service = personal.proactive;
  personal.putSettings({ directory: cwd, agent: 'claude' });
  personal.socket = join(dir, 'personal.sock');
  const socket = personalServer(personal); await listenPrivate(socket, personal.socket);
  const server = createHttpServer({ manager, token: 'test', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const git = async (repo: string, ...args: string[]) => (await exec('git', ['-C', repo, '-c', 'user.name=Tester', '-c', 'user.email=tester@localhost', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();
  const repository = async (name = 'repo') => {
    const repo = join(dir, name); mkdirSync(repo);
    await git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'base.txt'), 'base\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'initial');
    return repo;
  };
  const todo = (input: Record<string, unknown> = {}) => personal.create({ text: '会前提纲', importance: 'high', dueAt: at(15), ...input });
  const settled = async (id?: string) => {
    await wait(() => service.runs().some(run => (!id || run.id === id) && run.status !== 'running'));
    await wait(() => store.listThreads().every(thread => thread.status !== 'running'));
    await service.flush(); await personal.flushMirror();
    return service.runs().find(run => !id || run.id === id)!;
  };
  return { dir, cwd, store, manager, personal, service, adapters, api, git, repository, todo, settled, async close() {
    await manager.shutdown(); await service.flush(); await personal.flushMirror();
    await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => socket.close(() => r()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('settings are opt-in, validate the whole list, canonicalize symlinks and persist', async () => {
  const h = await setup(), outside = mkdtempSync(join(tmpdir(), 'calli-proactive-outside-'));
  try {
    assert.deepEqual(await (await h.api('/api/personal/proactive')).json(), { settings: { mode: 'off', repos: [], enabled: false }, runs: [] });
    const repo = await h.repository();
    const link = join(h.dir, 'repo-link'); symlinkSync(repo, link);
    // The old switch still works: turning it on lands in observe, not in auto.
    const saved = await h.api('/api/personal/proactive/settings', 'PUT', { enabled: true, repos: [repo, link] });
    assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { mode: 'observe', repos: [repo], enabled: true });
    for (const [repos, status] of [[['relative'], 400], [[h.cwd], 400], [[join(h.dir, 'missing')], 400], [[outside], 403], [[repo, h.cwd], 400], ['bad', 400]] as const) {
      assert.equal((await h.api('/api/personal/proactive/settings', 'PUT', { mode: 'off', repos })).status, status);
      assert.deepEqual(h.service.settings(), { mode: 'observe', repos: [repo], enabled: true }, 'an invalid list never partially saves the mode or repos');
    }
    symlinkSync(outside, join(h.dir, 'escape'));
    assert.equal((await h.api('/api/personal/proactive/settings', 'PUT', { repos: [join(h.dir, 'escape')] })).status, 403);
    mkdirSync(join(repo, 'nested'));
    assert.equal((await h.api('/api/personal/proactive/settings', 'PUT', { repos: [join(repo, 'nested')] })).status, 400);
    assert.equal((await h.api('/api/personal/proactive/settings', 'PUT', { enabled: 'yes' })).status, 400);
    assert.equal((await h.api('/api/personal/proactive/settings', 'PUT', { mode: 'whenever' })).status, 400);
    for (const body of [null, [], 'settings']) assert.equal((await h.api('/api/personal/proactive/settings', 'PUT', body)).status, 400);
    const reborn = new ProactiveService(h.store, h.manager, h.personal, h.adapters);
    assert.deepEqual(reborn.settings(), h.service.settings());
    assert.equal((await h.api('/api/personal/proactive/settings', 'PUT', { repos: [] })).status, 200);
    assert.deepEqual(h.service.settings(), { mode: 'observe', repos: [], enabled: true });
  } finally { await h.close(); rmSync(outside, { recursive: true, force: true }); }
});

test('legacy switches migrate on read; the old switch writes observe, an explicit mode wins', async () => {
  const h = await setup(); try {
    h.store.saveHubSetting('personalProactiveSettings', { enabled: true, repos: [h.cwd] });
    assert.deepEqual(h.service.settings(), { mode: 'auto', repos: [h.cwd], enabled: true }, 'an old on switch was acting, so it stays auto');
    h.store.saveHubSetting('personalProactiveSettings', { enabled: false, repos: [] });
    assert.deepEqual(h.service.settings(), { mode: 'off', repos: [], enabled: false });
    h.store.saveHubSetting('personalProactiveSettings', {});
    assert.deepEqual(h.service.settings(), { mode: 'off', repos: [], enabled: false });
    assert.deepEqual(await h.service.save({ enabled: true }), { mode: 'observe', repos: [], enabled: true }, 'newly opened starts in observe');
    assert.deepEqual(await h.service.save({ enabled: true, mode: 'auto' }), { mode: 'auto', repos: [], enabled: true }, 'an explicit mode wins over the switch');
    assert.deepEqual(await h.service.save({ enabled: false }), { mode: 'off', repos: [], enabled: false });
    await assert.rejects(h.service.save({ mode: 'whenever' }), (error: { status?: number }) => error.status === 400);
    assert.deepEqual(h.service.settings(), { mode: 'off', repos: [], enabled: false }, 'a rejected mode writes nothing');
  } finally { await h.close(); }
});

test('preparation candidates require an accepted open matter, timing and no prepared note', async () => {
  const h = await setup(); try {
    const base = h.todo();
    const candidate = (patch: Partial<TodoRecord>, note = '') => preparationCandidate({ ...base, ...patch }, note, now);
    assert.equal(candidate({}), true);
    for (const patch of [{ done: true }, { state: 'done' as const }, { proposed: true }, { dueAt: at(13, 3) }, { dueAt: null }, { importance: 'normal' as const, dueAt: null, urgentUntil: at(13) }]) assert.equal(candidate(patch), false);
    assert.equal(candidate({}, '## 做到哪\n已备好会前提纲'), false);
    assert.equal(candidate({ dueAt: at(12, 3) }), true, 'inclusive 48-hour boundary');
    assert.equal(candidate({ importance: 'normal', dueAt: at(10) }), true, 'overdue is urgent');
    assert.equal(candidate({ importance: 'normal', dueAt: null, source: { type: 'lark-calendar', ref: 'meeting', at: at(15) } }), true);
    assert.equal(candidate({ dueAt: null, source: { type: 'lark-calendar', ref: 'meeting', at: at(15, 2) } }), false);
  } finally { await h.close(); }
});

test('idle gates: disabled, empty, shared quiet hours, busy threads, interval and daily limit', async () => {
  const h = await setup(); try {
    await h.service.tick(now); assert.equal(h.service.runs().length, 0);
    await h.service.save({ mode: 'auto' }); await h.service.tick(now); assert.equal(h.store.listThreads().length, 0);
    h.todo();
    await h.service.save({ mode: 'off' }); await h.service.tick(now); assert.equal(h.service.runs().length, 0);
    await h.service.save({ mode: 'auto' });
    await h.service.tick(new Date(2026, 10, 1, 23)); await h.service.tick(new Date(2026, 10, 1, 7, 59));
    assert.equal(h.service.runs().length, 0);
    const review = h.personal.review.status();
    h.store.saveHubSetting('personalReview', { ...review, quietHours: { start: '11:00', end: '13:00' } });
    await h.service.tick(now); assert.equal(h.service.runs().length, 0, 'uses the edited brief/review window');
    h.store.saveHubSetting('personalReview', review);
    const busy = await h.manager.createThread({ agent: 'claude', cwd: h.cwd }); h.store.updateThread(busy.id, { status: 'running' });
    await h.service.tick(now); assert.equal(h.service.runs().length, 0);
    h.store.updateThread(busy.id, { status: 'idle' });
    h.store.saveHubSetting('personalProactiveRuns', [historical('recent', 'sandbox', new Date(now.getTime() - 3599999).toISOString())]);
    await h.service.tick(now); assert.equal(h.service.runs().length, 1, 'interval includes other kinds');
    h.store.saveHubSetting('personalProactiveRuns', Array.from({ length: 5 }, (_, i) => historical(String(i), 'prepare', at(5 + i))));
    await h.service.tick(now); assert.equal(h.service.runs().length, 5);
    h.store.saveHubSetting('personalProactiveRuns', [historical('exact-hour', 'prepare', at(11))]);
    await Promise.all([h.service.tick(now), h.service.tick(now)]); await h.settled();
    assert.equal(h.service.runs().length, 2, 'exactly one hour and overlapping ticks start one run');
  } finally { await h.close(); }
});

test('L1 fake agent writes artifacts, updates the note, commits only materials and records a quiet notice', async () => {
  const h = await setup();
  const push = new PushService(h.store, h.manager);
  try {
    push.putSettings({ enabled: true, recipient: 'test-user', scheduled: true });
    const todo = h.todo(); await h.personal.flushMirror();
    writeFileSync(join(h.cwd, 'unrelated.txt'), 'keep staged\n'); await h.git(h.cwd, 'add', '--', 'unrelated.txt');
    await h.service.save({ mode: 'auto' }); await h.service.tick(now);
    const run = await h.settled();
    assert.equal(run.status, 'ready', run.summary); assert.equal(run.kind, 'prepare'); assert.equal(run.matterId, todo.id);
    assert.ok(run.threadId); assert.ok(run.endedAt); assert.match(run.summary!, /已备好会前提纲/);
    assert.equal(run.files?.length, 1); assert.match(run.files![0].path, /artifacts\/outline\.md$/);
    assert.equal(run.files![0].additions, 3); assert.equal(run.files![0].deletions, 0);
    assert.match(readFileSync(join(h.cwd, run.files![0].path), 'utf8'), /会前提纲/);
    assert.match(h.store.todoNote(todo.id).text, /已备好/);
    assert.equal(h.store.todoThreadIds(todo.id).includes(run.threadId), true);
    const log = await h.git(h.cwd, 'log', '--format=%an %s', '--', run.files![0].path);
    assert.match(log, new RegExp(`Calli .*prepare.*${todo.id}|Calli .*${todo.id}.*prepare`));
    assert.equal(await h.git(h.cwd, 'diff', '--cached', '--name-only'), 'unrelated.txt');
    const notices = h.store.listEventsOfType(run.threadId, 'agent.notice');
    assert.equal(notices.length, 1); assert.equal(notices[0].data.proactive, true);
    assert.equal((await push.status()).records.length, 0, 'neither notice nor routine completion pushes');
    await h.service.save({ mode: 'off' }); await h.service.tick(new Date(2026, 10, 1, 14)); assert.equal(h.service.runs().length, 1);
    const counts = await (await h.api('/api/personal/proactive?summary=true')).json(); assert.deepEqual(counts.counts, { [todo.id]: 1 }); assert.equal('runs' in counts, false);
    const todos = await (await h.api('/api/todos')).json(); assert.equal(todos[0].proactiveRunCount, 1); assert.equal('files' in todos[0], false);
    assert.deepEqual((await (await h.api(`/api/personal/proactive?matterId=${todo.id}`)).json()).runs, [run]);
    assert.deepEqual((await (await h.api('/api/personal/proactive?matterId=missing')).json()).runs, []);
    assert.equal((await h.api(`/api/personal/proactive/runs/${run.id}/merge`, 'POST')).status, 400);
    assert.equal((await h.api(`/api/personal/proactive/runs/${run.id}/diff`)).status, 400);
  } finally { push.dispose(); await h.close(); }
});

test('no-op preparation ends quietly; worker failure is visible and counted', async () => {
  for (const mode of ['quiet', 'error']) {
    const h = await setup(mode); try {
      h.todo(); await h.service.save({ mode: 'auto' }); await h.service.tick(now);
      const run = await h.settled();
      assert.equal(run.status, mode === 'quiet' ? 'discarded' : 'failed', run.summary);
      if (mode === 'error') assert.match(run.summary!, /fixture proactive failed/);
      assert.equal(h.store.listEventsOfType(run.threadId, 'agent.notice').length, 0);
      await h.service.tick(new Date(now.getTime() + 1000)); assert.equal(h.service.runs().length, 1);
    } finally { await h.close(); }
  }
});

test('observe records what would be done and why, starting no thread and no sandbox', async () => {
  const h = await setup(); try {
    const repo = await h.repository();
    const todo = h.todo({ importance: 'normal', dueAt: null }); // not worth preparing; but started in the repo
    const work = await h.manager.createThread({ agent: 'claude', cwd: repo }); h.store.linkTodoThread(todo.id, work.id);
    await h.service.save({ mode: 'observe', repos: [repo] });
    await h.service.tick(now);
    const observation = h.service.runs()[0];
    assert.equal(observation.status, 'observed'); assert.equal(observation.kind, 'sandbox');
    assert.equal(observation.matterId, todo.id); assert.equal(observation.repo, repo);
    assert.equal(observation.threadId, ''); assert.equal(observation.branch, undefined);
    assert.equal(observation.summary, `会在 ${repo.split('/').pop()} 的沙盒里继续「${todo.text}」：你之前开始过这件事`);
    assert.equal(existsSync(join(repo, '.worktrees')), false, 'no sandbox was prepared');
    assert.deepEqual(h.store.todoThreadIds(todo.id), [work.id], 'no thread was opened on the matter');
  } finally { await h.close(); }
});

test('observations are free of the daily limit but keep the hour, one per matter per day', async () => {
  const h = await setup(); try {
    const todo = h.todo();
    await h.service.save({ mode: 'observe' });
    const observed = (id: string, startedAt: string): ProactiveRun =>
      ({ ...historical(id, 'prepare', startedAt), status: 'observed', summary: '旧的观察' });
    h.store.saveHubSetting('personalProactiveRuns', Array.from({ length: 5 }, (_, i) => observed(String(i), at(5 + i))));
    await h.service.tick(now);
    const first = h.service.runs().at(-1)!;
    assert.equal(h.service.runs().length, 6, 'five observations today do not consume the daily limit');
    assert.equal(first.status, 'observed'); assert.equal(first.matterId, todo.id);
    assert.equal(first.summary, `会为「${todo.text}」提前准备材料：重要，今天截止`);
    await h.service.tick(new Date(2026, 10, 1, 14));
    assert.equal(h.service.runs().length, 6, 'the same candidate is observed once per day');
    h.store.saveHubSetting('personalProactiveRuns', [observed('recent', new Date(now.getTime() - 3599999).toISOString())]);
    await h.service.tick(now);
    assert.equal(h.service.runs().length, 1, 'an observation still waits a full hour');
    h.store.saveHubSetting('personalProactiveRuns', [observed('hour-edge', at(11))]);
    await h.service.tick(now);
    assert.equal(h.service.runs().length, 2, 'a full hour admits the next observation');
  } finally { await h.close(); }
});

test('approve marks an observation as read; other states refuse and a verdict mutes the candidate for a day', async () => {
  const h = await setup(); try {
    const todo = h.todo();
    await h.service.save({ mode: 'observe' });
    await h.service.tick(now);
    const observation = h.service.runs()[0];
    // Through the route: a 200 with the whole run; the same call again is a 409 the page can show.
    const marked = await h.api(`/api/personal/proactive/runs/${observation.id}/approve`, 'POST');
    assert.equal(marked.status, 200);
    assert.equal((await marked.json()).status, 'approved');
    assert.equal((await h.api(`/api/personal/proactive/runs/${observation.id}/approve`, 'POST')).status, 409);
    h.store.saveHubSetting('personalProactiveRuns', h.service.runs().map(run => run.id === observation.id ? { ...run, status: 'observed' } : run));
    assert.equal(h.service.approve(observation.id).status, 'approved');
    assert.throws(() => h.service.approve(observation.id),
      (error: { status: number; message: string }) => error.status === 409 && /只有观察记录可以标记/.test(error.message), 'only observed can be approved');
    h.store.saveHubSetting('personalProactiveRuns', [...h.service.runs(), { ...historical('done', 'prepare'), status: 'ready' }]);
    assert.throws(() => h.service.approve('done'),
      (error: { status: number; message: string }) => error.status === 409 && /只有观察记录可以标记/.test(error.message), 'a ready run is not an observation');
    assert.throws(() => h.service.approve('missing'), (error: { status: number }) => error.status === 404);
    assert.equal(h.service.counts()[todo.id], 1, 'approved observations stay counted');
    await h.service.tick(new Date(2026, 10, 1, 14));
    assert.equal(h.service.runs().length, 2, 'a verdict does not trigger execution and does not unblock a new record');
    await h.service.tick(new Date(2026, 10, 2, 13));
    assert.equal(h.service.runs().length, 3, 'a day later the same candidate is observed again');
    assert.equal(h.service.runs().filter(run => run.matterId === todo.id).length, 2);
  } finally { await h.close(); }
});

test('switching from observe to auto starts the very candidate that was recorded', async () => {
  const h = await setup(); try {
    const todo = h.todo();
    await h.service.save({ mode: 'observe' });
    await h.service.tick(now);
    assert.equal(h.service.runs()[0].status, 'observed');
    assert.equal(h.store.listThreads().length, 0);
    await h.service.save({ mode: 'auto' });
    await h.service.tick(new Date(2026, 10, 1, 14));
    const run = await h.settled(h.service.runs().at(-1)!.id);
    assert.equal(run.status, 'ready', run.summary); assert.equal(run.kind, 'prepare'); assert.equal(run.matterId, todo.id);
    assert.ok(run.threadId);
    assert.equal(h.store.todoThreadIds(todo.id).includes(run.threadId), true);
  } finally { await h.close(); }
});

test('a sandbox round with failing tests ends silently: audit kept, no notice, no card', async () => {
  const h = await setup(); try {
    const repo = await h.repository();
    const todo = h.todo({ importance: 'normal', dueAt: null });
    const work = await h.manager.createThread({ agent: 'claude', cwd: repo }); h.store.linkTodoThread(todo.id, work.id);
    await h.service.save({ mode: 'auto', repos: [repo] });
    // The fixture passes its check; doctor the answer the way an honest failing run would report it.
    const answers = h.store.voiceAnswerEvents.bind(h.store);
    h.store.voiceAnswerEvents = (threadId: string, turnId: string | null) => {
      const events = answers(threadId, turnId); const last = events.at(-1);
      return last ? [...events, { ...last, type: 'message.delta' as const, data: { text: '\n2 个用例失败' } }] : events;
    };
    await h.service.tick(now);
    const failed = await h.settled(h.service.runs().at(-1)!.id);
    assert.equal(failed.status, 'discarded'); assert.equal(failed.discardReason, '测试未通过');
    assert.equal(failed.summary, '补好沙盒示例。');
    assert.match(failed.testReport!, /失败/);
    assert.deepEqual(failed.files, [{ path: 'proactive-fixture.txt', additions: 1, deletions: 0 }]);
    assert.equal(h.store.listEventsOfType(failed.threadId, 'agent.notice').length, 0, 'no notice went out');
    assert.deepEqual(h.service.counts(), {}, 'a silent trial does not light the desk');
    assert.equal(existsSync(join(repo, 'proactive-fixture.txt')), false, 'the main workspace was never touched');
  } finally { await h.close(); }
});

test('a sandbox round with nothing to review ends silently too', async () => {
  const h = await setup('quiet'); try {
    const repo = await h.repository();
    const todo = h.todo({ importance: 'normal', dueAt: null });
    const work = await h.manager.createThread({ agent: 'claude', cwd: repo }); h.store.linkTodoThread(todo.id, work.id);
    await h.service.save({ mode: 'auto', repos: [repo] });
    await h.service.tick(now);
    const run = await h.settled(h.service.runs().at(-1)!.id);
    assert.equal(run.status, 'discarded'); assert.equal(run.discardReason, '没有可审阅的改动');
    assert.equal(run.testReport, '工作线程未报告测试结果');
    assert.deepEqual(run.files, []);
    assert.equal(h.store.listEventsOfType(run.threadId, 'agent.notice').length, 0);
    assert.deepEqual(h.service.counts(), {});
  } finally { await h.close(); }
});

test('L2 requires a prior linked work thread inside an explicitly allowed repo and respects its daily limit', async () => {
  const h = await setup(); try {
    const repo = await h.repository();
    const todo = h.todo({ importance: 'normal', dueAt: null });
    const other = await h.manager.createThread({ agent: 'claude', cwd: h.cwd }); h.store.linkTodoThread(todo.id, other.id);
    await h.service.save({ mode: 'auto', repos: [repo] });
    await h.service.tick(now); assert.deepEqual(h.service.runs(), []);
    const work = await h.manager.createThread({ agent: 'claude', cwd: repo }); h.store.linkTodoThread(todo.id, work.id);
    await h.service.save({ repos: [] }); await h.service.tick(now); assert.deepEqual(h.service.runs(), []);
    await h.service.save({ repos: [repo] });
    h.store.saveHubSetting('personalProactiveRuns', [historical('one', 'sandbox', at(8)), historical('two', 'sandbox', at(9))]);
    await h.service.tick(now); assert.equal(h.service.runs().length, 2);
    h.store.saveHubSetting('personalProactiveRuns', [historical('yesterday', 'sandbox', at(9, 0))]);
    await h.service.tick(now); const run = await h.settled(h.service.runs().at(-1)!.id);
    assert.equal(run.status, 'ready', run.summary); assert.equal(run.kind, 'sandbox'); assert.equal(run.repo, repo);
    assert.equal(run.branch, `calli/proactive/${todo.id}`); assert.notEqual(h.store.getThread(run.threadId)!.cwd, repo);
    assert.equal(existsSync(join(repo, 'proactive-fixture.txt')), false);
    assert.equal(run.summary, '补好沙盒示例。'); assert.equal(run.testReport, 'fixture check: passed');
    assert.deepEqual(run.files, [{ path: 'proactive-fixture.txt', additions: 1, deletions: 0 }]);
    await h.service.tick(new Date(2026, 10, 1, 14)); assert.equal(h.service.runs().length, 2, 'ready work awaits the person');
  } finally { await h.close(); }
});

test('sandbox API: real git diff, refused merge preserves status, merge/revert/discard and invalid transitions', async () => {
  const h = await setup(); try {
    const repo = await h.repository(); const sandbox = new ProactiveSandbox();
    const seed = async (matterId: string) => {
      const tree = await sandbox.prepare(repo, matterId);
      writeFileSync(join(tree.root, `${matterId}.txt`), `${matterId}\n`);
      await h.git(tree.root, 'add', '.'); await h.git(tree.root, 'commit', '-qm', `change\n\nCalli-Proactive: ${matterId}`);
      const run: ProactiveRun = { ...historical(matterId, 'sandbox'), matterId, repo, branch: tree.branch, status: 'ready' };
      h.store.saveHubSetting('personalProactiveRuns', [...h.service.runs(), run]); return run;
    };
    const run = await seed('merge-me'); const endpoint = `/api/personal/proactive/runs/${run.id}`;
    assert.deepEqual(await (await h.api(`${endpoint}/diff`)).json(), { files: [{ path: 'merge-me.txt', additions: 1, deletions: 0 }] });
    assert.equal((await h.api(`${endpoint}/revert`, 'POST')).status, 409);
    await h.git(repo, 'switch', '-qc', 'feature');
    const refused = await h.api(`${endpoint}/merge`, 'POST'); assert.equal(refused.status, 409); assert.match((await refused.json()).error, /默认分支/);
    assert.equal(h.service.runs()[0].status, 'ready'); await h.git(repo, 'switch', 'main');
    const merged = await h.api(`${endpoint}/merge`, 'POST'); assert.equal(merged.status, 200); assert.equal((await merged.json()).status, 'merged');
    assert.equal(readFileSync(join(repo, 'merge-me.txt'), 'utf8'), 'merge-me\n');
    assert.match(await h.git(repo, 'log', '-1', '--format=%B'), /Calli-Proactive: merge-me/);
    assert.equal((await h.api(`${endpoint}/discard`, 'POST')).status, 409);
    assert.equal((await h.api(`${endpoint}/merge`, 'POST')).status, 409);
    const reverted = await h.api(`${endpoint}/revert`, 'POST'); assert.equal(reverted.status, 200); assert.equal((await reverted.json()).status, 'reverted');
    assert.equal(existsSync(join(repo, 'merge-me.txt')), false);
    assert.equal((await h.api(`${endpoint}/revert`, 'POST')).status, 409);
    const discard = await seed('discard-me');
    assert.equal((await h.api(`/api/personal/proactive/runs/${discard.id}/discard`, 'POST')).status, 200);
    assert.equal(h.service.runs().find(r => r.id === discard.id)?.status, 'discarded');
    assert.equal((await h.api(`/api/personal/proactive/runs/${discard.id}/diff`)).status, 409);
    assert.equal((await h.api('/api/personal/proactive/runs/missing/merge', 'POST')).status, 404);
    assert.equal((await h.api('/api/personal/proactive/runs/missing/diff')).status, 404);
  } finally { await h.close(); }
});

test('merge and revert succeed on a machine with no git identity, leaving a clean worktree', async () => {
  const h = await setup(); try {
    const repo = await h.repository(); const sandbox = new ProactiveSandbox();
    // Neutralize the host's global and system git config: the sandbox must work on a blank machine.
    const blank = join(h.dir, 'blank.gitconfig'); writeFileSync(blank, '');
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL, savedSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = blank; process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    try {
      const matterId = 'no-identity';
      const tree = await sandbox.prepare(repo, matterId);
      writeFileSync(join(tree.root, `${matterId}.txt`), `${matterId}\n`);
      await h.git(tree.root, 'add', '.'); await h.git(tree.root, 'commit', '-qm', `change\n\nCalli-Proactive: ${matterId}`);
      const run: ProactiveRun = { ...historical(matterId, 'sandbox'), matterId, repo, branch: tree.branch, status: 'ready' };
      h.store.saveHubSetting('personalProactiveRuns', [...h.service.runs(), run]);
      const endpoint = `/api/personal/proactive/runs/${run.id}`;
      assert.equal((await h.api(`${endpoint}/merge`, 'POST')).status, 200, 'merge brings its own identity');
      assert.equal(readFileSync(join(repo, `${matterId}.txt`), 'utf8'), `${matterId}\n`);
      const reverted = await h.api(`${endpoint}/revert`, 'POST');
      assert.equal(reverted.status, 200, 'revert brings its own identity instead of retrying a half-done one');
      assert.equal((await reverted.json()).status, 'reverted');
      assert.equal(existsSync(join(repo, `${matterId}.txt`)), false);
      assert.equal(await h.git(repo, 'status', '--porcelain'), '', 'no REVERT_HEAD or merge state is left behind');
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    }
  } finally { await h.close(); }
});

test('startup/tick recovery fails ended or missing workers even while disabled, preserves live ones', async () => {
  const h = await setup(); try {
    const live = await h.manager.createThread({ agent: 'claude', cwd: h.cwd }); h.store.updateThread(live.id, { status: 'running' });
    const ended = await h.manager.createThread({ agent: 'claude', cwd: h.cwd });
    h.store.saveHubSetting('personalProactiveRuns', [
      { ...historical('missing', 'prepare'), status: 'running' },
      { ...historical('ended', 'prepare'), status: 'running', threadId: ended.id },
      { ...historical('live', 'sandbox'), status: 'running', threadId: live.id },
    ]);
    const reborn = new ProactiveService(h.store, h.manager, h.personal, h.adapters);
    reborn.recover(now);
    assert.deepEqual(reborn.runs().map(run => run.status), ['failed', 'failed', 'running']);
    h.store.updateThread(live.id, { status: 'idle' }); await reborn.tick(now);
    assert.deepEqual(reborn.runs().map(run => run.status), ['failed', 'failed', 'failed']);
    assert.ok(reborn.runs().every(run => run.endedAt === now.toISOString()));
  } finally { await h.close(); }
});

test('history retains 200 records and the scheduler invokes proactive on its shared tick', async () => {
  const h = await setup('quiet'); try {
    h.todo();
    h.store.saveHubSetting('personalProactiveRuns', Array.from({ length: 200 }, (_, i) => historical(String(i), 'prepare', at(8, 0))));
    await h.service.save({ mode: 'auto' }); await h.service.tick(now); await h.settled(h.service.runs().at(-1)!.id);
    assert.equal(h.service.runs().length, 200); assert.equal(h.service.runs()[0].id, '1');
    const scheduler = new Scheduler(h.store, h.manager, h.adapters);
    const ticks: Date[] = []; h.service.tick = async now => { ticks.push(now!); };
    await scheduler.tick(); scheduler.dispose(); assert.equal(ticks.length, 1); assert.ok(ticks[0] instanceof Date);
  } finally { await h.close(); }
});

test('turn completion may collect files asynchronously; disabling prevents new turns and lets this one settle', async () => {
  const h = await setup(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let collecting = false;
  try {
    h.todo();
    const commit = h.personal.commitArtifacts.bind(h.personal);
    h.personal.commitArtifacts = async id => { collecting = true; await gate; return commit(id); };
    await h.service.save({ mode: 'auto' }); await h.service.tick(now);
    await wait(() => collecting);
    await h.service.tick(new Date(2026, 10, 1, 14));
    assert.equal(h.service.runs()[0].status, 'running', 'an ending being collected is not a stale run');
    assert.equal(h.service.runs().length, 1);
    await h.service.save({ mode: 'off' }); release();
    const run = await h.settled(); assert.equal(run.status, 'ready', run.summary);
    await h.service.tick(new Date(2026, 10, 1, 15)); assert.equal(h.service.runs().length, 1);
  } finally { release(); await h.close(); }
});

test('preparation failure is recorded, and activity arriving during async sandbox setup prevents a new worker', async () => {
  const h = await setup(); try {
    const repo = await h.repository(); const todo = h.todo({ dueAt: null });
    const work = await h.manager.createThread({ agent: 'claude', cwd: repo }); h.store.linkTodoThread(todo.id, work.id);
    await h.service.save({ mode: 'auto', repos: [repo] });
    const sandbox = new ProactiveSandbox();
    sandbox.prepare = async () => { throw new Error('仓库没有初始提交'); };
    const service = new ProactiveService(h.store, h.manager, h.personal, h.adapters, sandbox);
    await service.tick(now);
    assert.equal(service.runs()[0].status, 'failed'); assert.match(service.runs()[0].summary!, /初始提交/);
    assert.equal(h.store.listThreads().length, 1);
    sandbox.prepare = async () => {
      h.store.updateThread(work.id, { status: 'running' });
      return { root: repo, branch: `calli/proactive/${todo.id}` };
    };
    await service.tick(new Date(2026, 10, 1, 14));
    assert.equal(service.runs().at(-1)?.status, 'failed'); assert.match(service.runs().at(-1)!.summary!, /正在运行/);
    assert.equal(service.runs().at(-1)?.branch, `calli/proactive/${todo.id}`, 'a prepared sandbox stays discardable when its worker cannot start');
    assert.equal(h.store.listThreads().length, 1);
    h.store.updateThread(work.id, { status: 'idle' });
  } finally { await h.close(); }
});

test('counts skip discarded runs but keep failures, running, observations and outcomes', async () => {
  const h = await setup(); try {
    const ready = h.todo(), dropped = h.todo(), troubled = h.todo(), watched = h.todo();
    const run = (id: string, matterId: string, status: ProactiveRun['status']): ProactiveRun =>
      ({ id, kind: 'prepare', matterId, threadId: '', startedAt: at(9), status });
    h.store.saveHubSetting('personalProactiveRuns', [
      run('r1', ready.id, 'ready'), run('d1', dropped.id, 'discarded'), run('d2', dropped.id, 'discarded'),
      run('f1', troubled.id, 'failed'), run('f2', troubled.id, 'running'),
      run('o1', watched.id, 'observed'), run('o2', watched.id, 'approved'),
    ]);
    assert.deepEqual(h.service.counts(), { [ready.id]: 1, [troubled.id]: 2, [watched.id]: 2 }, 'observations count too: they await a verdict');
    const todos = await (await h.api('/api/todos')).json();
    const count = (id: string) => todos.find((todo: { id: string }) => todo.id === id)?.proactiveRunCount;
    assert.equal(count(ready.id), 1);
    assert.equal(count(dropped.id), 0, 'a discarded-only matter has nothing to show');
    assert.equal(count(troubled.id), 2, 'failures and a live run stay visible');
    assert.equal(count(watched.id), 2, 'observed and approved records stay visible');
  } finally { await h.close(); }
});

test('a worker thread whose turn never starts is removed when the run fails', async () => {
  const h = await setup(); try {
    const repo = await h.repository(); const todo = h.todo({ dueAt: null });
    const work = await h.manager.createThread({ agent: 'claude', cwd: repo }); h.store.linkTodoThread(todo.id, work.id);
    await h.service.save({ mode: 'auto', repos: [repo] });
    const original = h.manager.createThread.bind(h.manager);
    h.manager.createThread = async input => { const thread = await original(input); h.store.updateThread(work.id, { status: 'running' }); return thread; };
    await h.service.tick(now);
    h.manager.createThread = original;
    const run = h.service.runs().at(-1)!;
    assert.equal(run.status, 'failed'); assert.match(run.summary!, /正在运行/);
    assert.ok(run.threadId, 'the run records the thread it briefly created');
    assert.equal(h.store.getThread(run.threadId), null, 'a thread whose turn never started is deleted');
    assert.deepEqual(h.store.todoThreadIds(todo.id), [work.id], 'the matter keeps only its work thread');
  } finally { await h.close(); }
});

test('sandbox decisions serialize per repository, reject running workers and preserve the state on git errors', async () => {
  const h = await setup(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const repo = await h.repository(); const thread = await h.manager.createThread({ agent: 'claude', cwd: repo });
    const run: ProactiveRun = { ...historical('one', 'sandbox'), status: 'ready', repo, threadId: thread.id };
    const another: ProactiveRun = { ...historical('two', 'sandbox'), status: 'ready', repo };
    h.store.saveHubSetting('personalProactiveRuns', [run, another]);
    const sandbox = new ProactiveSandbox(); let called = 0;
    sandbox.merge = async () => { called++; await gate; return { commit: 'commit' }; };
    sandbox.discard = async () => { throw new Error('沙盒有未提交改动，请先查看'); };
    const service = new ProactiveService(h.store, h.manager, h.personal, h.adapters, sandbox);
    h.store.updateThread(thread.id, { status: 'running' });
    await assert.rejects(service.act('one', 'merge'), /仍在运行/); assert.equal(called, 0);
    h.store.updateThread(thread.id, { status: 'idle' });
    const merging = service.act('one', 'merge');
    await assert.rejects(service.act('one', 'merge'), /另一项操作/);
    await assert.rejects(service.act('two', 'discard'), /另一项操作/);
    release(); assert.equal((await merging).status, 'merged'); assert.equal(called, 1);
    await assert.rejects(service.act('two', 'discard'), /未提交改动/); assert.equal(service.runs()[1].status, 'ready');
    sandbox.discard = async () => {};
    h.store.saveHubSetting('personalProactiveRuns', [service.runs()[0], { ...another, status: 'failed' }]);
    assert.equal((await service.act('two', 'discard')).status, 'discarded');
  } finally { release(); await h.close(); }
});
