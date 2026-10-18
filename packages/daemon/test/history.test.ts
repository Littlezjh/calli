import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import type { EventType } from '../src/events.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rah-history-'));
  const store = new Store(dir);
  const make = (id: string) => store.createThread({ id, agent: 'pi', cwd: dir, title: id, agentSessionId: null, permissionMode: 'default', model: null, effort: null });
  make('thread');
  const add = (turn: string, type: EventType, data: Record<string, unknown>) => store.appendEvent('thread', turn, type, data);
  return { store, add, make, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('eight turns of answers exclude tools and intermediate text; work and detail are separate', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 12; i++) {
      const turn = `t${i}`;
      f.add(turn, 'turn.started', { text: `question ${i}` });
      f.add(turn, 'message.delta', { text: 'intermediate note' });
      f.add(turn, 'reasoning.delta', { text: 'private thinking '.repeat(1000) });
      f.add(turn, 'tool.start', { id: 'call', kind: 'execute', input: { command: 'secret argument' }, title: 'run test' });
      f.add(turn, 'tool.update', { id: 'call', output: 'SUPER_LARGE_RESULT'.repeat(3000), content: [{ type: 'diff', path: 'a.ts', oldText: 'one\n', newText: 'two\nthree\n' }] });
      f.add(turn, 'tool.end', { id: 'call', status: 'completed' });
      f.add(turn, 'message.delta', { text: `final answer ${i}` });
      f.add(turn, 'turn.done', {});
    }
    const page = await f.store.history.page('thread');
    assert.equal(page.events.filter(e => e.type === 'turn.started').length, 8);
    assert.equal(page.hasOlder, true);
    const json = JSON.stringify(page);
    for (const text of ['SUPER_LARGE_RESULT', 'secret argument', 'private thinking', 'intermediate note']) assert.ok(!json.includes(text), text);
    const work = page.events.find(e => e.type === 'history.work')!;
    assert.equal(work.data.count, 1);
    assert.equal((work.data.files as any[])[0].added, 2);
    const { events: entries } = await f.store.history.work('thread', work.turnId!, work.seq);
    assert.ok(JSON.stringify(entries).includes('intermediate note'));
    assert.ok(!JSON.stringify(entries).includes('SUPER_LARGE_RESULT'));
    const tool = entries.find(e => e.type === 'history.tool.start')!;
    const detail = await f.store.history.detail('thread', tool.turnId!, (tool.data.detail as any).id);
    assert.equal((detail.input as any).command, 'secret argument');
    assert.ok(String(detail.output).startsWith('SUPER_LARGE_RESULT'));
    assert.equal((detail.content as any[])[0].newText, 'two\nthree\n');
    const older = await f.store.history.page('thread', page.nextCursor!);
    assert.equal(older.events.filter(e => e.type === 'turn.started').length, 4);
    assert.equal(older.hasOlder, false);
    assert.equal(older.nextCursor, null);
    assert.equal(page.snapshotSeq, f.store.history.latest('thread'));
  } finally { f.close(); }
});

test('cold copied history rebuilds and detail identifiers are scoped to a turn', async () => {
  const f = fixture();
  try {
    f.add('a', 'turn.started', { text: 'hi' });
    f.add('a', 'reasoning.delta', { text: 'first ' });
    f.add('a', 'reasoning.delta', { text: 'second' });
    f.add('a', 'message.delta', { text: 'answer' });
    f.add('a', 'turn.done', {});
    f.make('copy'); f.store.copyEvents('thread', 'copy');
    const page = await f.store.history.page('copy');
    const work = page.events.find(e => e.type === 'history.work')!;
    const { events: entries } = await f.store.history.work('copy', 'a', work.seq);
    const thought = entries.find(e => e.type === 'history.thought')!;
    const detail = await f.store.history.detail('copy', 'a', (thought.data.detail as any).id);
    assert.equal(detail.text, 'first second');
    await assert.rejects(f.store.history.detail('copy', 'no-such-turn', (thought.data.detail as any).id), /turn not found/);
    assert.deepEqual(await f.store.history.page('copy'), page);
  } finally { f.close(); }
});

test('reconnect replaces affected turns with summaries and keeps a final remark after a tool', async () => {
  const f = fixture();
  try {
    f.add('a', 'turn.started', { text: 'hi' });
    const before = f.add('a', 'message.delta', { text: 'last remark' }).seq;
    f.add('a', 'tool.start', { id: 't', title: 'run' });
    f.add('a', 'tool.end', { id: 't', status: 'completed', output: 'hidden output' });
    f.add('a', 'turn.done', {});
    const reconnect = await f.store.history.since('thread', before);
    assert.deepEqual(reconnect.turns, ['a']);
    assert.ok(reconnect.events.some(e => e.type === 'message.delta' && e.data.text === 'last remark'));
    assert.ok(!JSON.stringify(reconnect).includes('hidden output'));
    assert.equal(reconnect.snapshotSeq, 5);
  } finally { f.close(); }
});

test('history HTTP APIs validate scope/cursors and summary SSE carries no deferred payload', async () => {
  const { createHttpServer } = await import('../src/http.js');
  const { ThreadManager } = await import('../src/threads.js');
  const { Workdirs } = await import('../src/workdirs.js');
  const { AttachmentStore } = await import('../src/attachments.js');
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'rah-history-api-'));
  const manager = new ThreadManager(f.store, new Map(), new Workdirs([dir], join(dir, 'workdirs.json'), join(dir, 'scratch')), new AttachmentStore(dir));
  const server = createHttpServer({ manager, token: 'history-test-token', webDir: null, version: 'test' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const headers = { Authorization: 'Bearer history-test-token' };
  const request = (path: string) => fetch(base + path, { headers });
  try {
    f.add('a', 'turn.started', { text: 'question' });
    f.add('a', 'tool.start', { id: 'x', input: { private: true }, title: 'run' });
    f.add('a', 'tool.end', { id: 'x', status: 'completed', output: 'private output' });
    f.add('a', 'message.delta', { text: 'answer' });
    f.add('a', 'turn.done', {});
    assert.equal((await fetch(base + '/api/threads/thread/history')).status, 401);
    assert.equal((await request('/api/threads/thread/history?before=-1')).status, 400);
    assert.equal((await request('/api/threads/missing/history')).status, 404);
    const page = await (await request('/api/threads/thread/history')).json() as any;
    const work = page.events.find((e: any) => e.type === 'history.work');
    const { events: entries } = await (await request(`/api/threads/thread/history/work?turn=a&id=${work.seq}`)).json() as any;
    const id = entries.find((e: any) => e.type === 'history.tool.start').data.detail.id;
    assert.equal((await request(`/api/threads/thread/history/detail?turn=elsewhere&id=${id}`)).status, 404);
    const detail = await (await request(`/api/threads/thread/history/detail?turn=a&id=${id}`)).json() as any;
    assert.equal(detail.output, 'private output');
    const controller = new AbortController();
    const stream = await fetch(base + '/api/threads/thread/stream?view=summary&after=0', { headers, signal: controller.signal });
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.ok(first.includes('history.reset'));
    assert.ok(first.includes('answer'));
    assert.ok(!first.includes('private output'));
    controller.abort();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('large work blocks and text details paginate with a stable version; file reads omit tool output', async () => {
  const f = fixture();
  try {
    f.add('a', 'turn.started', { text: 'question' });
    f.store.transaction(() => {
      for (let i = 0; i < 205; i++) {
        f.add('a', 'tool.start', { id: String(i), title: `tool ${i}` });
        f.add('a', 'tool.end', { id: String(i), status: 'completed', output: i === 0 ? 'abc'.repeat(50000) : 'small', content: i === 0 ? [{ type: 'diff', path: 'file.ts', oldText: null, newText: 'new' }] : undefined });
      }
    });
    const page = await f.store.history.page('thread');
    const first = page.events.find(e => e.type === 'history.tool.start')!;
    const work = await f.store.history.work('thread', 'a', first.seq);
    assert.equal(work.events.length, 101);
    assert.equal(work.nextCursor, 100);
    const second = await f.store.history.work('thread', 'a', first.seq, work.nextCursor!, work.version);
    assert.equal(second.events.length, 101);
    assert.equal(second.nextCursor, 200);
    const third = await f.store.history.work('thread', 'a', first.seq, second.nextCursor!, work.version);
    assert.equal(third.events.length, 6);
    assert.equal(third.nextCursor, null);
    const id = (first.data.detail as any).id;
    const detail = await f.store.history.detail('thread', 'a', id);
    assert.equal(String(detail.output).length, 65536);
    const more = await f.store.history.detail('thread', 'a', id, Number(detail.nextCursor), Number(detail.version));
    assert.equal(String(more.output).length, 65536);
    const last = await f.store.history.detail('thread', 'a', id, Number(more.nextCursor), Number(detail.version));
    assert.equal(String(detail.output) + String(more.output) + String(last.output), 'abc'.repeat(50000));
    assert.equal(last.nextCursor, null);
    const file = await f.store.history.detail('thread', 'a', id, 0, undefined, 'file.ts');
    assert.equal(file.output, undefined);
    assert.equal((file.content as any[])[0].newText, 'new');
    f.add('a', 'tool.update', { id: '0', output: 'new version' });
    await assert.rejects(f.store.history.detail('thread', 'a', id, 65536, Number(detail.version)), /detail changed/);
    await assert.rejects(f.store.history.work('thread', 'a', first.seq, 100, work.version), /work changed/);
  } finally { f.close(); }
});

test('batched thinking replay keeps a stable reference and transactions roll projections back', async () => {
  const f = fixture();
  try {
    f.add('a', 'turn.started', { text: 'question' });
    const a = f.add('a', 'reasoning.delta', { text: 'a' });
    const b = f.add('a', 'reasoning.delta', { text: 'b' });
    f.add('a', 'reasoning.delta', { text: 'c' });
    assert.equal((f.store.history.projected(a).data.detail as any).id, a.seq);
    assert.equal((f.store.history.projected(b).data.detail as any).id, a.seq);
    assert.throws(() => f.store.transaction(() => { f.add('a', 'tool.start', { id: 'rolled-back' }); throw new Error('rollback'); }), /rollback/);
    f.add('a', 'message.delta', { text: 'answer' });
    f.add('a', 'turn.done', {});
    const page = await f.store.history.page('thread');
    assert.ok(!JSON.stringify(page).includes('rolled-back'));
    assert.equal((await f.store.history.detail('thread', 'a', a.seq)).text, 'abc');
  } finally { f.close(); }
});

test('only pending approvals expose decision payloads and usage survives pagination', async () => {
  const f = fixture();
  try {
    f.add('old', 'turn.started', { text: 'older' });
    f.add('old', 'usage.updated', { used: 123, size: 1000 });
    f.add('old', 'turn.done', {});
    for (let i = 0; i < 8; i++) {
      f.add(`t${i}`, 'turn.started', { text: 'question' });
      f.add(`t${i}`, 'approval.request', { approvalId: `approve-${i}`, title: 'edit', toolCall: { content: [{ type: 'diff', path: 'file', newText: 'APPROVAL_SECRET' }] }, options: [] });
      if (i < 7) {
        f.add(`t${i}`, 'approval.resolved', { approvalId: `approve-${i}`, decision: { optionId: 'allow' } });
        f.add(`t${i}`, 'turn.done', {});
      }
    }
    let page = await f.store.history.page('thread');
    assert.equal(page.events.find(e => e.type === 'usage.updated')?.data.used, 123);
    assert.equal(page.events.filter(e => e.type === 'approval.request' && e.data.toolCall).length, 1);
    f.add('t7', 'approval.resolved', { approvalId: 'approve-7', decision: { optionId: 'allow' } });
    f.add('t7', 'turn.done', {});
    page = await f.store.history.page('thread');
    assert.ok(!JSON.stringify(page).includes('APPROVAL_SECRET'));
  } finally { f.close(); }
});

test('a build interrupted after writing rows repairs its coverage marker without replaying payloads', async () => {
  const f = fixture();
  try {
    f.add('a', 'turn.started', { text: 'question' });
    f.add('a', 'tool.start', { id: 'tool' });
    f.add('a', 'tool.end', { id: 'tool', status: 'completed', output: 'output' });
    f.add('a', 'turn.done', {});
    const db = (f.store as any).db as import('node:sqlite').DatabaseSync;
    db.prepare('DELETE FROM history_coverage WHERE thread_id=?').run('thread');
    await f.store.history.page('thread');
    const coverage = db.prepare('SELECT start_seq, end_seq FROM history_coverage WHERE thread_id=?').get('thread');
    assert.equal(coverage?.start_seq, 1);
    assert.equal(coverage?.end_seq, 4);
  } finally { f.close(); }
});

test('a forked side chat reads only the new turns after its inherited boundary', async () => {
  const f = fixture();
  try {
    f.add('inherited', 'turn.started', { text: 'inherited question' });
    f.add('inherited', 'message.delta', { text: 'inherited answer' });
    f.add('inherited', 'turn.done', {});
    const boundary = f.store.history.latest('thread');
    assert.deepEqual((await f.store.history.page('thread', undefined, boundary)).events, []);
    f.add('side', 'turn.started', { text: 'side question' });
    f.add('side', 'message.delta', { text: 'side answer' });
    f.add('side', 'turn.done', {});
    const page = await f.store.history.page('thread', undefined, boundary);
    assert.ok(page.events.every(e => e.seq > boundary));
    assert.equal(page.hasOlder, false);
    assert.equal(page.snapshotSeq, 6);
  } finally { f.close(); }
});
