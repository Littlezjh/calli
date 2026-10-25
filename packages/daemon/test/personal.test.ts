import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { PushService } from '../src/push.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';
import { AttachmentStore } from '../src/attachments.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { defaultPersonalDirectory, personalServer } from '../src/personal.js';
import { BorrowingService } from '../src/borrowing.js';
import { borrowingServer } from '../src/borrowing-server.js';
import { Scheduler } from '../src/scheduler.js';
import { sessionEnvironment } from '../src/adapters/types.js';
const exec = promisify(execFile);
const wait = async (fn: () => boolean | Promise<boolean>) => { for (let i = 0; i < 500; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timed out'); };
async function setup(options: { startError?: string; followUpMode?: string; clarifyDelegate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'limi-personal-'));
  const cwd = join(dir, 'personal'), outside = join(dir, 'elsewhere'); mkdirSync(cwd); mkdirSync(outside);
  const store = new Store(dir);
  const log = join(dir, 'lark-log'), config = join(dir, 'lark-config'); writeFileSync(log, ''); writeFileSync(config, '{}');
  const followUpMode = join(dir, 'follow-up-mode');
  if (options.followUpMode) writeFileSync(followUpMode, options.followUpMode);
  const env = { ...(options.startError ? { FAKE_ACP_START_ERROR: options.startError } : {}), ...(options.followUpMode ? { FAKE_PERSONAL_FOLLOW_UP_MODE_FILE: followUpMode } : {}) };
  const adapters = new Map<string, AgentAdapter>([['claude', new ClaudeAcpAdapter([process.execPath, resolve('test/fixtures/fake-acp.mjs')], env)], ['pi', new PiRpcAdapter([process.execPath, resolve('test/fixtures/fake-pi.mjs')], options.clarifyDelegate ? { FAKE_PERSONAL_DELEGATE_CLARIFY: '1' } : {})]]);
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'dirs')), new AttachmentStore(dir));
  const push = new PushService(store, manager, { executable: resolve('test/fixtures/fake-lark-cli.mjs'), retryMs: 1, env: { ...process.env, FAKE_LARK_LOG: log, FAKE_LARK_CONFIG: config } });
  const service = manager.personal; service.socket = join(dir, 'personal.sock'); service.putSettings({ directory: cwd, agent: 'claude' });
  const socket = personalServer(service); await listenPrivate(socket, service.socket);
  const borrowing = new BorrowingService(store, manager, adapters, dir, join(dir, 'tools.sock'));
  const tools = borrowingServer(borrowing); await listenPrivate(tools, borrowing.socket);
  const scheduler = new Scheduler(store, manager, adapters); scheduler.start();
  const server = createHttpServer({ manager, scheduler, token: 'test', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const thread = await manager.createThread({ agent: 'claude', cwd });
  const cli = async (args: string[], extra = {}) => JSON.parse((await exec(process.execPath, [resolve('bin/limi'), ...args], { env: { ...process.env, ...service.environment(thread.id), ...borrowing.environment(thread.id), ...extra } })).stdout);
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const file = (name: string, text: string) => { const path = join(dir, name); writeFileSync(path, text); return path; };
  return { dir, cwd, outside, store, manager, service, adapters, scheduler, thread, cli, api, file, push, log, async close() {
    push.dispose(); scheduler.dispose(); await borrowing.dispose(); await manager.shutdown(); await new Promise<void>(r => tools.close(() => r())); await new Promise<void>(r => socket.close(() => r())); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test('personal CRUD checks provided revisions, note lists remain small, writes overwrite and reject obvious secrets', async () => {
  const h = await setup(); try {
    assert.equal((await (await h.api('/api/personal/settings')).json()).directory, h.cwd);
    assert.equal((await h.api('/api/personal/settings', 'PUT', { agent: 'missing' })).status, 400);
    assert.equal((await h.api('/api/personal/settings', 'PUT', { directory: h.cwd, agent: null })).status, 200);
    h.service.putSettings({ agent: 'claude' });
    assert.equal((await (await h.api('/api/personal/settings', 'PUT', { model: 'small' })).json()).model, 'small');
    const scheduled = await h.scheduler.create({ agent: 'claude', prompt: 'personal-quiet', cron: '0 0 1 1 *', mode: 'new', enabled: false });
    assert.equal(scheduled.cwd, h.cwd);
    const todo = await (await h.api('/api/todos', 'POST', { text: 'A commitment' })).json();
    assert.equal(todo.owner, 'me'); assert.equal(todo.state, 'open'); assert.equal(todo.rev, 1);
    assert.equal((await h.api(`/api/todos/${todo.id}`, 'PATCH', { state: 'waiting' })).status, 400);
    assert.equal((await h.api(`/api/todos/${todo.id}`, 'PATCH', { rev: 1, state: 'waiting' })).status, 400);
    const waiting = await (await h.api(`/api/todos/${todo.id}`, 'PATCH', { rev: 1, state: 'waiting', waitingOn: 'reply' })).json();
    assert.equal(waiting.rev, 2); assert.equal(waiting.done, false);
    assert.equal((await h.api(`/api/todos/${todo.id}`, 'PATCH', { rev: 1, text: 'stale' })).status, 409);
    assert.equal((await h.api(`/api/todos/${todo.id}/note`, 'PUT', { rev: 2, text: '😀'.repeat(4001) })).status, 400);
    assert.equal((await h.api(`/api/todos/${todo.id}/note`, 'PUT', { rev: 2, text: '-----BEGIN PRIVATE KEY-----' })).status, 400);
    const noted = await (await h.api(`/api/todos/${todo.id}/note`, 'PUT', { rev: 2, text: '## 欠谁什么\nPrivate continuation details\n## 下一步\nPreview' })).json();
    assert.equal(noted.rev, 3);
    const listText = await (await h.api('/api/todos')).text(); assert.ok(listText.includes('Preview')); assert.ok(!listText.includes('Private continuation'));
    assert.equal(JSON.parse(listText)[0].notePreview, 'Preview');
    assert.equal((await (await h.api(`/api/todos/${todo.id}/note`)).json()).text, '## 欠谁什么\nPrivate continuation details\n## 下一步\nPreview');
    assert.equal((await h.api(`/api/todos/${todo.id}/note`, 'PUT', { rev: 2, text: 'stale' })).status, 409);
    await h.api(`/api/todos/${todo.id}/note`, 'PUT', { rev: 3, text: 'Replacement' });
    assert.equal(h.store.todoNote(todo.id).text, 'Replacement');
    const done = await (await h.api(`/api/todos/${todo.id}`, 'PATCH', { rev: 4, done: true })).json(); assert.equal(done.state, 'done'); assert.equal(done.waitingOn, null);
    assert.equal((await h.api(`/api/todos/${todo.id}?rev=4`, 'DELETE')).status, 409);
    assert.equal((await h.api(`/api/todos/${todo.id}?rev=5`, 'DELETE')).status, 204);
  } finally { await h.close(); }
});
test('todo note previews prefer next steps, skip headings and backfill existing notes without changing revisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limi-note-preview-'));
  let store = new Store(dir);
  try {
    const cases = [
      ['## 欠谁什么\nBackground\n## 下一步\n\n  Review the draft  \nThen send it\n## 其他\nUnrelated', 'Review the draft'],
      ['\n# Heading\n## Details\n\n First useful line\nMore details', 'First useful line'],
      ['## 下一步\r\n\r\n### Review\r\nCheck results\r\n## Later\r\nOther', 'Check results'],
      ['## 欠谁什么\nBackground\n## 下一步\n\n## 其他\nUnrelated', ''],
      ['\n# Title\n## Section\n', ''],
      ['', ''],
      [' \t\r\n　', ''],
    ];
    for (const [index, [note, preview]] of cases.entries()) {
      const todo = store.createTodo(String(index), 'Preview fixture', null);
      store.writeTodoNote(todo.id, note, null, todo.rev);
      assert.equal(store.getTodo(todo.id)?.notePreview, preview);
      assert.equal(store.getTodo(todo.id)?.hasNote, Boolean(note.trim()));
    }
    const expected = store.listTodos();
    store.close();
    const old = new DatabaseSync(join(dir, 'hub.db'));
    old.exec("ALTER TABLE todos DROP COLUMN has_note");
    old.exec("UPDATE todos SET note_preview = '## 欠谁什么'; DELETE FROM hub_settings WHERE key = 'todo_note_preview_v2'"); old.close();
    store = new Store(dir);
    assert.deepEqual(store.listTodos(), expected, 'backfill updates only the cached preview');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('background agent startup failure creates one run and one push without retrying the follow-up', async t => {
  const h = await setup({ startError: 'fixture startup refused' }); try {
    h.push.putSettings({ enabled: true });
    await h.manager.updateThread(h.thread.id, { archived: true });
    const todo = h.store.createTodo('startup-failure', 'Follow-up fixture', null);
    h.store.linkTodoThread(todo.id, h.thread.id);
    h.store.updateTodo(todo.id, { followUpAt: new Date(Date.now() - 1000).toISOString() });
    const create = t.mock.method(h.manager, 'createThread');
    await h.scheduler.followUps();
    await wait(() => h.store.listTodoRuns(todo.id)[0]?.status === 'error');
    const run = h.store.listTodoRuns(todo.id)[0];
    await wait(async () => (await h.push.status()).records.some(r => r.kind === 'failure' && r.result === 'sent'));
    assert.equal(h.store.listEventsOfType(run.threadId!, 'turn.error').length, 1);
    assert.equal(h.store.getTodo(todo.id)?.followUpAt, null);
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    for (let i = 0; i < 20; i++) { now += 30_000; await h.scheduler.tick(); }
    assert.equal(create.mock.callCount(), 1);
    assert.equal(h.store.listTodoRuns(todo.id).length, 1);
    assert.equal(h.store.listThreads().length, 1);
    assert.equal((await h.push.status()).records.length, 1);
    assert.equal((await h.push.status()).records[0].kind, 'failure');
    assert.equal(h.store.listEventsOfType(h.thread.id, 'agent.notice').length, 0);
  } finally { await h.close(); }
});

test('three quiet follow-ups pause the item, notify once, reject agent rescheduling and allow a human restart', async () => {
  const h = await setup({ followUpMode: 'quiet' }); try {
    h.push.putSettings({ enabled: true, scheduled: true });
    const todo = h.service.create({ text: 'Wait for progress', owner: 'agent' }, h.thread.id);
    h.service.writeNote(todo.id, { text: 'Still waiting' });
    const follow = async () => {
      const rev = h.store.getTodo(todo.id)!.rev;
      await h.cli(['todo', 'update', todo.id, '--rev', String(rev), '--follow-up', new Date(Date.now() - 1000).toISOString()]);
      await h.scheduler.followUps();
      await wait(() => h.store.listTodoRuns(todo.id)[0]?.status === 'quiet' && h.store.getThread(h.thread.id)?.status !== 'running');
    };
    for (let count = 1; count <= 3; count++) {
      await follow();
      assert.equal(h.store.getTodo(todo.id)?.followUpNoProgress, count);
      assert.equal(h.store.getTodo(todo.id)?.followUpPaused, count === 3);
    }
    assert.equal(h.store.getTodo(todo.id)?.followUpAt, null);
    const notice = h.store.listEventsOfType(h.thread.id, 'agent.notice');
    assert.equal(notice.length, 1); assert.equal(notice[0].data.confirmation, undefined);
    assert.equal(notice[0].data.text, '连续 3 次跟进没有进展，已停止自动跟进');
    assert.equal(h.store.getThread(h.thread.id)?.unread, true);
    await wait(async () => (await h.push.status()).records[0]?.result === 'sent');
    assert.equal((await h.push.status()).records.length, 1);
    assert.equal((await h.push.status()).records[0].kind, 'notice');
    const shown = await h.cli(['todo', 'show', todo.id]);
    assert.equal(shown.followUpNoProgress, 3); assert.equal(shown.followUpPaused, true);
    const listed = await (await h.api('/api/todos')).json();
    assert.equal(listed[0].followUpNoProgress, 3); assert.equal(listed[0].followUpPaused, true);
    const future = new Date(Date.now() + 3600000).toISOString();
    await assert.rejects(h.cli(['todo', 'update', todo.id, '--rev', String(shown.rev), '--follow-up', future]), /已停止自动跟进/);
    await assert.rejects(h.service.command(h.thread.id, { op: 'todo.update', id: todo.id, rev: shown.rev, followUpAt: future }), { status: 409 });
    await assert.rejects(h.cli(['todo', 'update', todo.id, '--rev', String(shown.rev), '--follow-up', future, '--note-file', h.file('unchanged-note', 'Still waiting')]), /已停止自动跟进/);
    for (let i = 0; i < 5; i++) await h.scheduler.tick();
    assert.equal(h.store.listTodoRuns(todo.id).length, 3);
    assert.equal(h.store.listEventsOfType(h.thread.id, 'agent.notice').length, 1);
    const resumed = await (await h.api(`/api/todos/${todo.id}`, 'PATCH', { followUpAt: future })).json();
    assert.equal(resumed.followUpPaused, false); assert.equal(resumed.followUpNoProgress, 0);
    await follow(); assert.equal(h.store.getTodo(todo.id)?.followUpNoProgress, 1);
    h.file('follow-up-mode', 'progress');
    await follow(); assert.equal(h.store.getTodo(todo.id)?.followUpNoProgress, 0, 'a changed note during the follow-up resets the streak');
    assert.match(h.store.todoNote(todo.id).text, /Progress made/);
  } finally { await h.close(); }
});

test('normal and failed follow-ups count too, while changed notes from either actor resume paused items', async () => {
  const h = await setup({ followUpMode: 'done' }); try {
    const todo = h.service.create({ text: 'Count every ending', owner: 'agent' }, h.thread.id);
    for (const [index, mode] of ['done', 'error', 'quiet'].entries()) {
      h.file('follow-up-mode', mode);
      await h.cli(['todo', 'update', todo.id, '--rev', String(h.store.getTodo(todo.id)!.rev), '--follow-up', new Date(Date.now() - 1000).toISOString()]);
      await h.scheduler.followUps();
      await wait(() => h.store.listTodoRuns(todo.id)[0]?.status === mode && h.store.getThread(h.thread.id)?.status !== 'running');
      assert.equal(h.store.getTodo(todo.id)?.followUpNoProgress, index + 1);
    }
    assert.equal(h.store.getTodo(todo.id)?.followUpPaused, true);
    const resumed = await h.cli(['todo', 'update', todo.id, '--rev', String(h.store.getTodo(todo.id)!.rev), '--note-file', h.file('progress-note', 'New evidence'), '--follow-up', new Date(Date.now() + 3600000).toISOString()]);
    assert.equal(resumed.followUpPaused, false); assert.equal(resumed.followUpNoProgress, 0);
    h.store.updateTodo(todo.id, { followUpNoProgress: 3, followUpPaused: true, followUpAt: null });
    const unchanged = await (await h.api(`/api/todos/${todo.id}/note`, 'PUT', { text: 'New evidence' })).json();
    assert.equal(unchanged.followUpPaused, true, 'rewriting identical content does not count as progress');
    const edited = await (await h.api(`/api/todos/${todo.id}/note`, 'PUT', { text: 'Further evidence' })).json();
    assert.equal(edited.followUpPaused, false); assert.equal(edited.followUpNoProgress, 0);
  } finally { await h.close(); }
});

test('follow-up streaks and pauses survive reopening the store and each run is counted once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limi-follow-up-streak-'));
  let store = new Store(dir);
  try {
    const todo = store.createTodo('streak', 'Persistent streak', null);
    assert.equal(todo.followUpNoProgress, 0); assert.equal(todo.followUpPaused, false);
    const run = (id: string) => store.insertScheduleRun({ id, todoId: todo.id, scheduleId: null, status: 'running', threadId: null,
      turnId: id, startedAt: new Date().toISOString(), finishedAt: null, message: null }, '');
    run('first'); assert.equal(store.finishTodoFollowUp('first'), false);
    assert.equal(store.finishTodoFollowUp('first'), false); assert.equal(store.getTodo(todo.id)?.followUpNoProgress, 1);
    run('second'); store.finishTodoFollowUp('second'); run('third');
    store.close(); store = new Store(dir);
    assert.equal(store.getTodo(todo.id)?.followUpNoProgress, 2);
    assert.equal(store.finishTodoFollowUp('third'), true);
    store.close(); store = new Store(dir);
    assert.equal(store.getTodo(todo.id)?.followUpNoProgress, 3); assert.equal(store.getTodo(todo.id)?.followUpPaused, true);
    assert.equal(store.finishTodoFollowUp('third'), false);
    assert.ok(!JSON.stringify(store.listTodoRuns(todo.id)).includes('note_before'), 'private snapshots stay out of run lists');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('real personal CLI uses scoped credentials, denies symlink escape and stale edits, protects me completion', async () => {
  const h = await setup(); try {
    h.push.putSettings({ enabled: true });
    const todo = await h.cli(['todo', 'add', '--owner', 'me', '--text-file', h.file('text', 'Review report')]);
    await wait(async () => (await h.push.status()).records[0]?.result === 'sent');
    assert.equal((await h.push.status()).records[0].kind, 'confirmation');
    assert.ok(readFileSync(h.log, 'utf8').includes('待你确认：Review report'));
    assert.equal(h.store.listEventsOfType(h.thread.id, 'agent.notice')[0].data.text, '待你确认：Review report');
    assert.equal(todo.proposed, true); assert.equal(h.store.getThread(h.thread.id)?.unread, true);
    assert.equal((await h.cli(['todo', 'show', todo.id])).proposals[0].kind, 'add');
    await assert.rejects(h.cli(['todo', 'update', todo.id, '--rev', String(todo.rev), '--state', 'done']), /propose-done/);
    await assert.rejects(h.cli(['todo'], { LIMI_TODO_KEY: 'wrong' }), /credentials/);
    const outside = await h.manager.createThread({ agent: 'claude', cwd: h.outside }); assert.equal(h.service.environment(outside.id), undefined);
    const escape = join(h.cwd, 'escape'); symlinkSync(h.outside, escape);
    const escaped = await h.manager.createThread({ agent: 'claude', cwd: escape }); assert.equal(h.service.environment(escaped.id), undefined);
    const env = sessionEnvironment({ LIMI_TODO_KEY: 'parent', LIMI_TODO_SOCKET: 'parent' }); assert.equal(env.LIMI_TODO_KEY, undefined);
    h.service.putSettings({ directory: h.outside }); await assert.rejects(h.cli(['todo']), /personal directory/);
  } finally { await h.close(); }
});
test('shell-only fake agent creates, writes, follows up in a fresh thread, proposes and waits for human acceptance', async () => {
  const h = await setup(); try {
    h.service.putSettings({ model: 'small' });
    await h.manager.startTurn(h.thread.id, { text: 'personal-start' });
    await wait(() => h.manager.threadView(h.thread.id).status !== 'running');
    const todo = h.store.listTodos()[0]; assert.ok(todo.proposed); assert.ok(todo.followUpAt);
    const events = h.store.listEventsOfType(h.thread.id, 'turn.started'); assert.match(String(events[0].data.text), /由 Limi 附加/);
    assert.equal(h.service.instructions(h.thread.id, 'next'), 'next');
    assert.match(h.service.context(h.thread.id), /Draft ready/);
    const suggestion = h.store.todoProposals(todo.id)[0];
    const accepted = await (await h.api(`/api/todos/${todo.id}/proposals/${suggestion.id}/accept`, 'POST', { rev: todo.rev })).json();
    assert.equal(accepted.proposed, false);
    await h.manager.deleteThread(h.thread.id);
    h.store.updateTodo(todo.id, { followUpAt: new Date(Date.now() - 1000).toISOString() });
    await h.scheduler.followUps();
    await wait(() => h.store.todoProposals(todo.id).some(p => p.kind === 'done'));
    const run = h.store.listTodoRuns(todo.id)[0]; assert.ok(run.newThread); assert.notEqual(run.threadId, h.thread.id);
    assert.equal(h.store.getThread(run.threadId!)?.model, 'small');
    await wait(() => h.store.getThread(run.threadId!)?.status !== 'running');
    assert.equal(h.store.getTodo(todo.id)?.followUpAt, null); assert.equal(h.store.getTodo(todo.id)?.done, false);
    assert.equal(h.store.listEventsOfType(run.threadId!, 'agent.notice').find(event => event.data.confirmation)?.data.text, `待你确认：${todo.text}`);
    const proposal = h.store.todoProposals(todo.id).find(p => p.kind === 'done')!;
    assert.match(h.store.todoNote(todo.id).text, /Reviewed/); assert.equal(h.store.todoNote(todo.id).threadId, run.threadId);
    assert.equal((await h.api(`/api/todos/${todo.id}/proposals/${proposal.id}/accept`, 'POST', { rev: accepted.rev })).status, 409);
    const final = await (await h.api(`/api/todos/${todo.id}/proposals/${proposal.id}/accept`, 'POST', { rev: h.store.getTodo(todo.id)!.rev })).json(); assert.equal(final.done, true);
    await h.scheduler.followUps(); assert.equal(h.store.listTodoRuns(todo.id).length, 1);
  } finally { await h.close(); }
});
test('wish and quiet stay unread-free, scheduled new quiet runs archive, busy follow-ups defer', async () => {
  const h = await setup(); try {
    h.push.putSettings({ enabled: true, scheduled: true });
    await h.manager.startTurn(h.thread.id, { text: 'personal-wish' }); await wait(() => h.manager.threadView(h.thread.id).status !== 'running');
    assert.equal(h.store.getThread(h.thread.id)?.unread, false); assert.equal(h.store.listWishes().length, 1);
    assert.equal(h.store.listEventsOfType(h.thread.id, 'turn.done')[0].data.quiet, true);
    await assert.rejects(h.cli(['quiet']), /running turn/);
    const schedule = await h.scheduler.create({ agent: 'claude', cwd: h.outside, prompt: 'personal-quiet', cron: '0 0 1 1 *', mode: 'new', enabled: false });
    await h.scheduler.runNow(schedule.id);
    await wait(() => h.store.listScheduleRuns(schedule.id)[0]?.status === 'quiet');
    const run = h.store.listScheduleRuns(schedule.id)[0]; await wait(() => Boolean(h.store.getThread(run.threadId!)?.archivedAt));
    const todo = h.service.create({ text: 'Later', owner: 'agent' }, h.thread.id);
    h.store.updateTodo(todo.id, { followUpAt: new Date(Date.now() - 1000).toISOString() });
    await h.manager.startTurn(h.thread.id, { text: 'slow' }); await h.scheduler.followUps(); assert.equal(h.store.listTodoRuns(todo.id).length, 0);
    assert.equal((await h.push.status()).records.length, 0);
    h.service.writeNote(todo.id, { text: 'Draft ready' });
    await h.manager.stopTurn(h.thread.id);
    await wait(() => h.store.listTodoRuns(todo.id).length === 1);
    await wait(() => h.store.listTodoRuns(todo.id)[0].status !== 'running');
    assert.equal(h.store.listTodoRuns(todo.id)[0].threadId, h.thread.id);
    assert.equal(h.store.getTodo(todo.id)?.followUpAt, null);
  } finally { await h.close(); }
});

for (const archived of [false, true]) test(`follow-up startup rejections back off, notify once and recover with ${archived ? 'new' : 'existing'} threads`, async t => {
  const h = await setup(); try {
    h.push.putSettings({ enabled: true });
    if (archived) await h.manager.updateThread(h.thread.id, { archived: true });
    const epoch = Date.now(); let now = epoch;
    t.mock.method(Date, 'now', () => now);
    const todo = h.store.createTodo('retry-todo', 'Resume after recovery', null);
    h.store.writeTodoNote(todo.id, 'Draft ready', h.thread.id, todo.rev);
    h.store.updateTodo(todo.id, { followUpAt: new Date(epoch - 1000).toISOString() });
    h.store.linkTodoThread(todo.id, h.thread.id);
    const create = t.mock.method(h.manager, 'createThread');
    const start = h.manager.startTurn.bind(h.manager);
    let unavailable = true;
    // Reject before turn.started: actual adapter failures after that event are recorded turns.
    const starts = t.mock.method(h.manager, 'startTurn', async (...args: Parameters<typeof start>) => {
      if (unavailable) throw new Error('raw startup output with credential=private-fixture-value');
      return start(...args);
    });
    for (let seconds = 0; seconds <= 600; seconds += 30) {
      now = epoch + seconds * 1000;
      await h.scheduler.followUps();
    }
    assert.equal(starts.mock.callCount(), 3, 'only attempts at minutes 0, 1 and 6');
    assert.equal(create.mock.callCount(), archived ? 3 : 0);
    assert.equal(h.store.listThreads().length, archived ? 0 : 1);
    assert.equal(h.store.listThreads({ archived: true }).length, archived ? 1 : 0, 'no archived failure threads accumulate');
    assert.equal(h.store.listTodoRuns(todo.id).length, 0);
    assert.ok(h.store.getTodo(todo.id)?.followUpAt, 'rejected starts stay due');
    const notices = () => h.store.listEventsOfType(h.thread.id, 'agent.notice');
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].data.confirmation, undefined);
    assert.equal(notices()[0].data.text, '跟进没能启动：无法启动 agent，稍后自动重试');
    assert.equal(h.store.getThread(h.thread.id)?.unread, true);
    await wait(async () => (await h.push.status()).records.some(r => r.kind === 'notice' && r.result === 'sent'));
    assert.equal((await h.push.status()).records.filter(r => r.kind === 'notice').length, 1);
    assert.ok(!readFileSync(h.log, 'utf8').includes('private-fixture-value'));
    for (const [minutes, attempts] of [[35.5, 3], [36, 4], [95.5, 4], [96, 5], [155.5, 5]] as const) {
      now = epoch + minutes * 60_000;
      await h.scheduler.followUps(); assert.equal(starts.mock.callCount(), attempts);
    }
    assert.equal(notices().length, 1, 'continuous failures never repeat the notice');
    unavailable = false; now = epoch + 156 * 60_000;
    await h.scheduler.followUps();
    await wait(() => h.store.listTodoRuns(todo.id)[0]?.status === 'done');
    assert.equal(h.store.getTodo(todo.id)?.followUpAt, null);
    const recovered = h.store.listTodoRuns(todo.id)[0].threadId!;
    assert.equal(h.store.listEventsOfType(recovered, 'turn.started').length, 1);
    assert.ok(h.store.todoProposals(todo.id).some(p => p.kind === 'done'), 'real fake ACP resumes through the CLI');
    unavailable = true; now += 60_000;
    h.store.updateTodo(todo.id, { followUpAt: new Date(now - 1000).toISOString() });
    await h.scheduler.followUps();
    const failures = h.store.listEventsOfType(recovered, 'agent.notice').filter(e => String(e.data.text).startsWith('跟进没能启动：'));
    assert.equal(failures.length, archived ? 1 : 2, 'a successful start resets notification suppression');
    const before = starts.mock.callCount();
    now += 59_000; await h.scheduler.followUps(); assert.equal(starts.mock.callCount(), before);
    now += 1000; await h.scheduler.followUps(); assert.equal(starts.mock.callCount(), before + 1, 'recovery resets backoff to one minute');
  } finally { await h.close(); }
});

test('legacy todos migrate to me with state consistent with done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limi-todo-migration-'));
  const old = new DatabaseSync(join(dir, 'hub.db'));
  old.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, parent_id TEXT, position REAL NOT NULL, created_at TEXT NOT NULL, done_at TEXT); INSERT INTO todos VALUES ('old', 'Legacy', 1, NULL, 1, '2026-01-01', '2026-01-02');"); old.close();
  const store = new Store(dir);
  try { const todo = store.getTodo('old')!; assert.equal(todo.owner, 'me'); assert.equal(todo.state, 'done'); assert.equal(todo.rev, 1); assert.equal(todo.notePreview, null); assert.equal(todo.followUpNoProgress, 0); assert.equal(todo.followUpPaused, false); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('startup catches one overdue follow-up, agent revisions are mandatory, dismissals persist', async () => {
  const h = await setup(); let resumed: Scheduler | undefined;
  try {
    const todo = h.service.create({ text: 'Catch up', owner: 'agent' }, h.thread.id);
    await assert.rejects(h.service.command(h.thread.id, { op: 'todo.update', id: todo.id, state: 'done' }), /rev is required/);
    const noted = h.service.writeNote(todo.id, { text: 'Draft ready', rev: todo.rev }, h.thread.id);
    assert.throws(() => h.service.update(todo.id, { state: 'done', rev: todo.rev }, h.thread.id), /todo changed/);
    h.scheduler.dispose();
    h.store.updateTodo(todo.id, { followUpAt: new Date(Date.now() - 3600000).toISOString() }, noted.rev);
    resumed = new Scheduler(h.store, h.manager, new Map()); resumed.start();
    await wait(() => h.store.listTodoRuns(todo.id).length === 1);
    await wait(() => h.store.todoProposals(todo.id).length > 0);
    await wait(() => h.store.listTodoRuns(todo.id)[0].status !== 'running');
    const proposal = h.store.todoProposals(todo.id)[0];
    assert.equal((await h.api(`/api/todos/${todo.id}/proposals/${proposal.id}/dismiss`, 'POST', { rev: h.store.getTodo(todo.id)!.rev })).status, 200);
    assert.equal(h.store.getTodo(todo.id)?.done, false);
    assert.equal(h.store.todoProposals(todo.id)[0].state, 'dismissed');
    await resumed.followUps(); assert.equal(h.store.listTodoRuns(todo.id).length, 1);
    const suggestion = h.service.create({ text: 'Optional promise', owner: 'me' }, h.thread.id);
    const pid = h.store.todoProposals(suggestion.id)[0].id;
    await h.api(`/api/todos/${suggestion.id}/proposals/${pid}/dismiss`, 'POST', { rev: suggestion.rev });
    assert.equal(h.store.getTodo(suggestion.id), null);
  } finally { resumed?.dispose(); await h.close(); }
});

for (const automatic of [false, true]) test(`${automatic ? 'automatic' : 'manual'} handover transfers personal work from ACP to Pi and follow-ups stay with the successor`, async () => {
  const h = await setup(); try {
    await h.manager.startTurn(h.thread.id, { text: 'personal-start' });
    await wait(() => h.store.getThread(h.thread.id)?.status !== 'running');
    const created = h.store.listTodos()[0];
    h.service.resolveProposal(created.id, h.store.todoProposals(created.id)[0].id, 'accept', created.rev);
    const beforeModel = h.store.getTodo(created.id)!;
    await h.manager.updateThread(h.thread.id, { model: 'small' });
    assert.deepEqual(h.store.getTodo(created.id), beforeModel, 'changing models does not change todo state or its follow-up');
    const summary = await h.manager.handoverSummary(h.thread.id, null, 'pi');
    assert.ok('summary' in summary); if (!('summary' in summary)) return;
    assert.match(summary.summary, /关联事项与接续说明/); assert.match(summary.summary, /Draft ready/);
    let successor: string;
    if (automatic) {
      await h.manager.executeAutoHandover(h.thread.id, { agent: 'pi' }, summary.summary, null);
      successor = h.manager.listThreads().find(t => t.handover?.sourceId === h.thread.id)!.id;
    } else {
      successor = (await h.manager.createHandoverThread(h.thread.id, 'pi')).id;
      await h.manager.startTurn(successor, { text: summary.summary });
    }
    assert.equal(h.store.todoThreadIds(created.id)[0], successor);
    await wait(() => h.store.getThread(successor)?.status !== 'running');
    const start = h.store.listEventsOfType(successor, 'turn.started')[0];
    assert.match(String(start.data.text), /<limi-todo>由 Limi 附加/);
    const proposal = h.store.todoProposals(created.id).find(p => p.kind === 'done')!;
    assert.ok(proposal); assert.equal(proposal.threadId, successor); assert.equal(h.store.todoNote(created.id).threadId, successor);
    h.store.updateTodo(created.id, { followUpAt: new Date(Date.now() - 1000).toISOString() });
    await h.scheduler.followUps();
    await wait(() => h.store.listTodoRuns(created.id)[0]?.status === 'quiet');
    assert.equal(h.store.listTodoRuns(created.id)[0].threadId, successor);
    assert.equal(h.store.getTodo(created.id)?.done, false);
    h.service.resolveProposal(created.id, proposal.id, 'accept', h.store.getTodo(created.id)!.rev);
    assert.equal(h.store.getTodo(created.id)?.done, true);
  } finally { await h.close(); }
});

test('schedule history survives the nullable schedule-id migration for one-shot todo runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limi-run-migration-'));
  let store = new Store(dir);
  try {
    store.createSchedule({ id: 'schedule', name: 'Existing', agent: 'fixture', cwd: dir, prompt: 'test', cron: '0 0 * * *', mode: 'new', threadId: null,
      permissionMode: 'auto_edit', enabled: false, timezone: null, catchUp: false, lastFiredAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
    store.close();
    const old = new DatabaseSync(join(dir, 'hub.db'));
    old.exec("DROP TABLE schedule_runs; CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE, status TEXT NOT NULL, thread_id TEXT, turn_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, message TEXT); INSERT INTO schedule_runs VALUES ('run', 'schedule', 'done', NULL, NULL, '2026-01-01', '2026-01-01', NULL);"); old.close();
    store = new Store(dir);
    assert.equal(store.listScheduleRuns('schedule')[0].status, 'done');
    assert.equal(store.listScheduleRuns('schedule')[0].id, 'run');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('delegating a plan uses personal settings, links before the first turn, includes its note and rejects absent agents', async () => {
  const h = await setup();
  try {
    const todo = h.service.create({ text: 'Prepare the checklist' });
    h.service.writeNote(todo.id, { text: '## 下一步\nReview the remaining steps' });
    const savedAdapters = new Map(h.adapters); h.adapters.clear();
    h.service.putSettings({ directory: null, agent: null });
    assert.equal((await h.api(`/api/todos/${todo.id}/delegate`, 'POST', {})).status, 409);
    assert.equal((await h.api('/api/todos/missing/delegate', 'POST', {})).status, 404);
    for (const [id, adapter] of savedAdapters) h.adapters.set(id, adapter);
    h.service.putSettings({ directory: h.cwd, agent: 'pi', model: 'fake/plain' });
    const response = await h.api(`/api/todos/${todo.id}/delegate`, 'POST', {});
    assert.equal(response.status, 201, response.status === 201 ? undefined : await response.text());
    const thread = await response.json();
    assert.equal(thread.cwd, h.cwd); assert.equal(thread.agent, 'pi'); assert.equal(thread.model, 'fake/plain');
    assert.ok(h.store.todoThreadIds(todo.id).includes(thread.id));
    await wait(() => h.store.getThread(thread.id)?.status !== 'running');
    const events = h.store.listEvents(thread.id);
    const prompt = events.find(e => e.type === 'turn.started');
    assert.match(String(prompt?.data.text), /Prepare the checklist/);
    assert.match(String(prompt?.data.text), /Review the remaining steps/);
    assert.ok(h.service.environment(thread.id)?.LIMI_TODO_KEY);
    h.service.update(todo.id, { done: true });
    assert.equal((await h.api(`/api/todos/${todo.id}/delegate`, 'POST', {})).status, 409);
  } finally { await h.close(); }
});

test('wish summaries contain only a count until details are requested', async () => {
  const h = await setup();
  try {
    h.store.saveWish('one', h.thread.id, 'A private side note');
    assert.deepEqual(await (await h.api('/api/wishes?summary=true')).json(), { count: 1 });
    assert.equal((await (await h.api('/api/wishes')).json())[0].text, 'A private side note');
  } finally { await h.close(); }
});

test('a rejected delegation removes only its empty thread and does not associate the plan', async () => {
  const h = await setup();
  try {
    const todo = h.service.create({ text: 'A rejected delegation' });
    const before = h.store.listThreads().map(t => t.id);
    h.manager.startTurn = async () => { throw new Error('fixture refuses to start'); };
    assert.equal((await h.api(`/api/todos/${todo.id}/delegate`, 'POST', {})).status, 500);
    assert.deepEqual(h.store.listThreads().map(t => t.id), before);
    assert.deepEqual(h.store.todoThreadIds(todo.id), []);
    assert.equal(h.store.getTodo(todo.id)?.rev, todo.rev);
  } finally { await h.close(); }
});

test('personal settings abbreviate only home directory boundaries for display without changing stored paths', async () => {
  const h = await setup(); try {
    for (const [directory, display] of [[homedir(), '~'], [join(homedir(), 'personal'), '~/personal'], [homedir() + '-other', homedir() + '-other']]) {
      h.store.saveHubSetting('personal', { directory, agent: 'claude', model: null });
      const settings = await (await h.api('/api/personal/settings')).json();
      assert.equal(settings.directoryDisplay, display); assert.equal(settings.directory, directory);
      assert.equal(h.service.settings().directory, directory);
      assert.equal(Object.hasOwn(h.service.settings(), 'directoryDisplay'), false);
    }
  } finally { await h.close(); }
});

test('default personal directory is created privately, stays unlisted, permits only its subtree and delegates without setup', async () => {
  const h = await setup(); try {
    h.service.putSettings({ directory: null, agent: null });
    const root = defaultPersonalDirectory(); rmSync(root, { recursive: true });
    assert.equal(existsSync(root), false);
    const settings = await (await h.api('/api/personal/settings')).json();
    assert.equal(settings.directory, root); assert.equal(settings.directoryIsDefault, true);
    assert.equal(settings.agent, 'pi'); assert.equal(settings.model, null);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    chmodSync(root, 0o750); await h.api('/api/personal/settings'); assert.equal(statSync(root).mode & 0o777, 0o750);
    assert.equal(h.manager.dirs.roots().includes(root), false);
    assert.equal((await (await h.api('/api/config')).json()).workdirs.includes(root), false);
    assert.equal((await h.api('/api/projects', 'POST', { parent: root, name: 'project' })).status, 201);
    const child = join(root, 'child'); mkdirSync(child); writeFileSync(join(child, 'note.txt'), 'private note');
    const created = await h.manager.createThread({ agent: 'pi', cwd: child });
    assert.ok(h.service.environment(created.id)?.LIMI_TODO_KEY);
    assert.equal((await h.api(`/api/directories?path=${encodeURIComponent(child)}`)).status, 200);
    assert.equal((await h.api(`/api/threads/${created.id}/text?path=note.txt`)).status, 200);
    const sibling = join(dirname(root), 'sibling'); mkdirSync(sibling, { recursive: true });
    await assert.rejects(h.manager.createThread({ agent: 'pi', cwd: sibling }), /allowed workdirs/);
    assert.equal((await h.api(`/api/directories?path=${encodeURIComponent(sibling)}`)).status, 403);
    assert.equal((await h.api('/api/personal/settings', 'PUT', { directory: sibling })).status, 400);
    symlinkSync(sibling, join(root, 'escape'));
    await assert.rejects(h.manager.createThread({ agent: 'pi', cwd: join(root, 'escape') }), /allowed workdirs/);
    const todo = h.service.create({ text: 'Use the default agent' });
    const delegated = await (await h.api(`/api/todos/${todo.id}/delegate`, 'POST', {})).json();
    assert.equal(delegated.cwd, root); assert.equal(delegated.agent, 'pi');
    await wait(() => h.store.getThread(delegated.id)?.status !== 'running');
    assert.ok(h.store.todoThreadIds(todo.id).includes(delegated.id));
    const custom = await (await h.api('/api/personal/settings', 'PUT', { directory: h.cwd })).json();
    assert.equal(custom.directoryIsDefault, false);
    assert.equal(h.manager.dirs.all().includes(root), false, 'only the effective directory receives the implicit grant');
    const restored = await (await h.api('/api/personal/settings', 'PUT', { directory: root })).json();
    assert.equal(restored.directoryIsDefault, true);
  } finally { await h.close(); }
});

test('default agent prefers any available Pi instance, falls back, and reports no usable agents', async () => {
  const h = await setup(); try {
    h.service.putSettings({ directory: null, agent: null, model: 'ignored-default-model' });
    const pi = h.adapters.get('pi')!; h.adapters.delete('pi'); h.adapters.set('second-pi', pi);
    assert.equal((await h.service.settingsView()).agent, 'second-pi');
    pi.available = async () => false;
    assert.equal((await h.service.settingsView()).agent, 'claude');
    h.adapters.get('claude')!.available = async () => false;
    assert.equal((await h.service.settingsView()).agent, null);
    const todo = h.service.create({ text: 'No available instance' });
    assert.equal((await h.api(`/api/todos/${todo.id}/delegate`, 'POST', {})).status, 409);
  } finally { await h.close(); }
});

test('default directory rejects leaf and parent symlinks without creating files at their targets', async () => {
  const h = await setup(); const root = defaultPersonalDirectory();
  try {
    h.service.putSettings({ directory: null });
    rmSync(root, { recursive: true }); symlinkSync(h.outside, root);
    const response = await h.api('/api/personal/settings'); assert.equal(response.status, 400); assert.match(await response.text(), /symbolic link/);
    const due = h.service.create({ text: 'Blocked directory follow-up' });
    h.service.update(due.id, { followUpAt: new Date(Date.now() - 1000).toISOString() });
    await h.scheduler.followUps();
    assert.equal(h.store.listTodoRuns(due.id).length, 0, 'a directory refusal stays in follow-up retry handling');
    assert.throws(() => h.service.allowed(h.thread.id), /symbolic link/);
    h.store.saveHubSetting('personal', { directory: root, agent: 'pi', model: null });
    assert.throws(() => h.service.directory(), /symbolic link/, 'explicit paths in older settings cannot bypass the default guard');
    h.service.putSettings({ directory: null });
    rmSync(root); mkdirSync(root, { mode: 0o700 });
    const parent = dirname(root); rmSync(parent, { recursive: true }); symlinkSync(h.outside, parent);
    assert.equal((await h.api('/api/personal/settings')).status, 400);
    assert.equal(existsSync(join(h.outside, root.slice(parent.length + 1))), false);
    rmSync(parent); defaultPersonalDirectory();
  } finally {
    const parent = dirname(root); if (lstatSync(parent).isSymbolicLink()) rmSync(parent);
    defaultPersonalDirectory(); await h.close();
  }
});

test('follow-ups create threads using the effective default directory and available agent', async () => {
  const h = await setup(); try {
    h.service.putSettings({ directory: null, agent: null });
    const todo = h.service.create({ text: 'Resume in the default directory' });
    h.service.writeNote(todo.id, { text: 'Draft ready' });
    h.service.update(todo.id, { followUpAt: new Date(Date.now() - 1000).toISOString() });
    await h.scheduler.followUps();
    const run = h.store.listTodoRuns(todo.id)[0]; assert.ok(run?.newThread);
    assert.equal(h.store.getThread(run.threadId!)?.cwd, defaultPersonalDirectory());
    assert.equal(h.store.getThread(run.threadId!)?.agent, 'pi');
    await wait(() => h.store.getThread(run.threadId!)?.status !== 'running');
    assert.ok(h.store.todoProposals(todo.id).some(proposal => proposal.kind === 'done'));
  } finally { await h.close(); }
});

test('delegation accepts allowed projects without personal credentials and rejects outside or symlink paths', async () => {
  const h = await setup();
  const forbidden = mkdtempSync(join(tmpdir(), 'limi-forbidden-'));
  try {
    const todo = h.service.create({ text: 'Review project changes' });
    h.service.writeNote(todo.id, { text: '## 下一步\nCheck the project checklist' });
    for (const cwd of [forbidden, join(h.dir, '..'), '', 7]) {
      const response = await h.api(`/api/todos/${todo.id}/delegate`, 'POST', { cwd });
      assert.equal(response.status, typeof cwd === 'string' && cwd ? 403 : 400);
    }
    const link = join(h.dir, 'escape'); symlinkSync(forbidden, link);
    assert.equal((await h.api(`/api/todos/${todo.id}/delegate`, 'POST', { cwd: link })).status, 403);
    const response = await h.api(`/api/todos/${todo.id}/delegate`, 'POST', { cwd: h.outside });
    assert.equal(response.status, 201);
    const thread = await response.json();
    assert.equal(thread.cwd, h.outside);
    assert.equal(h.service.environment(thread.id), undefined);
    assert.ok(h.store.todoThreadIds(todo.id).includes(thread.id));
    await wait(() => h.store.getThread(thread.id)?.status !== 'running');
    const prompt = String(h.store.listEvents(thread.id).find(e => e.type === 'turn.started')?.data.text);
    assert.match(prompt, /Review project changes/); assert.match(prompt, /Check the project checklist/);
    assert.doesNotMatch(prompt, /limi todo/);
  } finally { await h.close(); rmSync(forbidden, { recursive: true, force: true }); }
});


for (const personal of [true, false]) for (const scenario of [
  { name: 'with note', text: '跟着 Agent 架构变化', note: '## 下一步\n列出本项目所用框架的三条架构变化，写成一页摘要' },
  { name: 'without note and clear goal', text: '给房东回邮件确认退租日期', note: '' },
  { name: 'without note and vague goal', text: '跟着 Agent 架构变化', note: '' },
]) test(`delegation prompt distinguishes a new task from handover: ${personal ? 'personal' : 'project'}, ${scenario.name}`, async () => {
  const h = await setup();
  try {
    h.service.putSettings({ agent: 'pi' });
    const todo = h.service.create({ text: scenario.text });
    if (scenario.note) h.service.writeNote(todo.id, { text: scenario.note });
    const response = await h.api(`/api/todos/${todo.id}/delegate`, 'POST', personal ? {} : { cwd: h.outside });
    assert.equal(response.status, 201);
    const thread = await response.json();
    await wait(() => h.store.getThread(thread.id)?.status !== 'running');
    const prompt = String(h.store.listEventsOfType(thread.id, 'turn.started')[0].data.text);
    assert.ok(prompt.startsWith('这是一件新交给你的事，不是交接；这个线程就是它的工作线程，没有更早的对话需要读。'));
    assert.ok(prompt.includes(`事项：${scenario.text}`));
    assert.match(prompt, /只有目标笼统、看不出要交付什么时，这一轮才只做澄清/);
    assert.doesNotMatch(prompt, /没有接续说明，或|目标清楚且已有接续说明/);
    assert.match(prompt, /没有说明也直接推进，并在结束前.*第一版接续说明/);
    assert.match(prompt, /先起草给人看，发送前再问/);
    assert.match(prompt, /1～3 个具体问题.*每个问题给出你建议的默认选项/);
    assert.match(prompt, /不要自己猜着开工/);
    assert.match(prompt, /按说明的「下一步」推进/);
    assert.match(prompt, /不要用 handover\/history.*不要翻本地会话文件/);
    assert.match(prompt, /不可逆操作（提交、付款、发消息、删除、推送代码）.*先停下来问人/);
    assert.match(prompt, scenario.note ? /列出本项目所用框架的三条架构变化/ : /接续说明：\n尚未写入。/);
    if (personal) {
      assert.match(prompt, /limi todo update .*--state waiting --waiting-on "等你说明目标" --note-file FILE/);
      assert.match(prompt, /「## 欠谁什么」写已知部分/);
      assert.match(prompt, /「## 下一步」写「等回答后……」/);
      assert.match(prompt, /limi notify.*然后结束本轮/);
      assert.match(prompt, /limi todo propose-done/);
    } else {
      assert.match(prompt, /只在回复中提问并结束本轮/);
      assert.doesNotMatch(prompt, /limi todo/);
      assert.equal(h.service.environment(thread.id), undefined);
    }
  } finally { await h.close(); }
});

test('real todo CLI marks self in list and show without exposing linked thread history', async () => {
  const h = await setup();
  try {
    const todo = h.service.create({ text: 'Clarify the outcome' });
    const other = await h.manager.createThread({ agent: 'pi', cwd: h.cwd });
    h.store.linkTodoThread(todo.id, other.id); h.store.linkTodoThread(todo.id, h.thread.id);
    const expected = h.store.todoThreadIds(todo.id).map(id => ({ id, self: id === h.thread.id }));
    const shown = await h.cli(['todo', 'show', todo.id]);
    assert.deepEqual(shown.threads, expected);
    assert.deepEqual((await h.cli(['todo'])).find((item: { id: string }) => item.id === todo.id).threads, expected);
    const unlinked = h.service.create({ text: 'An unrelated item' });
    h.store.linkTodoThread(unlinked.id, other.id);
    assert.deepEqual((await h.cli(['todo', 'show', unlinked.id])).threads, [{ id: other.id, self: false }]);
    const help = (await exec(process.execPath, [resolve('bin/limi'), 'todo', '--help'])).stdout;
    assert.match(help, /self: true marks the current thread/);
    assert.match(help, /cannot read their history; handover\/history are only for a handover chain/);
  } finally { await h.close(); }
});

test('fake Pi clarifies a newly delegated item without a note, sets waiting, notifies and ends the turn', async () => {
  const h = await setup({ clarifyDelegate: true });
  try {
    h.service.putSettings({ agent: 'pi' }); h.push.putSettings({ enabled: true });
    const todo = h.service.create({ text: '跟着 Agent 架构变化' });
    h.store.linkTodoThread(todo.id, h.thread.id);
    const response = await h.api(`/api/todos/${todo.id}/delegate`, 'POST', {});
    assert.equal(response.status, 201);
    const thread = await response.json();
    await wait(() => h.store.listEventsOfType(thread.id, 'turn.done').length === 1);
    const updated = h.store.getTodo(todo.id)!;
    assert.equal(updated.state, 'waiting'); assert.equal(updated.waitingOn, '等你说明目标');
    assert.equal(updated.done, false); assert.equal(updated.followUpAt, null);
    assert.match(h.store.todoNote(todo.id).text, /## 欠谁什么\n.*具体交付尚未确定/);
    assert.match(h.store.todoNote(todo.id).text, /## 下一步\n等回答后/);
    const events = h.store.listEvents(thread.id);
    const answer = events.filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
    assert.equal((answer.match(/建议默认：/g) ?? []).length, 2);
    const notices = events.filter(e => e.type === 'agent.notice');
    assert.equal(notices.length, 1); assert.match(String(notices[0].data.text), /需要你回答目标和交付形式/);
    assert.equal(events.filter(e => e.type === 'turn.started').length, 1);
    assert.equal(events.filter(e => e.type === 'turn.error').length, 0);
    assert.equal(h.store.todoProposals(todo.id).length, 0);
    await wait(async () => (await h.push.status()).records.some(record => record.kind === 'notice' && record.result === 'sent'));
    assert.equal(h.store.getThread(thread.id)?.unread, true);
  } finally { await h.close(); }
});
