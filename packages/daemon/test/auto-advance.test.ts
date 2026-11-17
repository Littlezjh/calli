import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { AttachmentStore } from '../src/attachments.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { createHttpServer } from '../src/http.js';
import { CoordinationManager } from '../src/coordination.js';
import { contextEntries } from '../src/personal-context.js';

// 会话自动推进: the `[进度] 等外部` / `[进度] 进行中` protocol words arm the hub to wake a thread by
// itself, bounded per chain, retiring whenever a person moves the thread on.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wait = async (check: () => unknown, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
};

/**
 * One daemon with a fake agy agent whose `FAKE_AGY_ADVANCE` script file drives the `[进度]` line of
 * each turn in order, so a test scripts whole chains of 等外部 / 进行中 reports. One "minute" is
 * 10ms and the continue delay 20ms, so waits play out without real time passing.
 */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'calli-advance-test-'));
  const script = join(dir, 'advance-script');
  writeFileSync(script, '');
  const store = new Store(dir);
  const adapters = new Map<string, AgentAdapter>();
  adapters.set('agy', new AgyAdapter([process.execPath, join(fixtures, 'fake-agy.mjs')], { FAKE_AGY_ADVANCE: script }));
  const manager = new ThreadManager(store, adapters, [dir], new AttachmentStore(dir), () => [{ id: 'agy', adapter: 'agy' }]);
  manager.progressWanted = () => true;
  Object.defineProperty(manager.autoAdvance, 'minuteMs', { value: 10 });
  Object.defineProperty(manager.autoAdvance, 'continueMs', { value: 20 });
  const server = createHttpServer({ manager, token: 'test-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const thread = await manager.createThread({ agent: 'agy', cwd: dir });
  const idle = (id = thread.id) => wait(() => manager.threadView(id).status !== 'running');
  // The settle that arms or retires a watch lands a beat after the thread shows idle.
  const armed = (id = thread.id) => wait(() => manager.autoAdvance.view(id) !== null);
  const gone = (id = thread.id) => wait(() => manager.autoAdvance.view(id) === null);
  return {
    dir, script, store, manager, thread, api, idle, armed, gone,
    /** Rewrites the script the fake agent consumes, one line per upcoming turn. */
    lines: (entries: string[]) => writeFileSync(script, entries.join('\n') + '\n'),
    /** The raw watch record, where the schedule itself is asserted. */
    watch: (id = thread.id) => store.hubSetting<Record<string, { reason: string; attempts: number; minutes?: number; nextAt: string | null; exhausted?: boolean }>>('advance.watches', {})[id],
    /** Runs turns until the script is spent or `until` says stop; each ask is a person's own. */
    turn: async (text: string, id = thread.id) => { await manager.startTurn(id, { text }); await idle(id); },
    /** Waits for the thread to settle and the watch's next look to come due, then runs one check pass. */
    due: async (id = thread.id) => {
      await idle(id);
      await wait(() => { const view = manager.autoAdvance.view(id); return view === null || view.nextAt === null || Date.parse(view.nextAt) <= Date.now(); });
      await manager.autoAdvance.check();
      await idle(id);
    },
    async close() {
      try { await manager.shutdown(); } catch { /* already down */ }
      await new Promise<void>(r => server.close(() => r()));
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the switch defaults off; nothing arms without it', async () => {
  const h = await setup();
  try {
    h.lines(['wait:等 CI 跑完:2']);
    await h.turn('去看看 CI');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.manager.autoAdvance.view(h.thread.id), null);
    assert.deepEqual((await (await h.api('/api/advance/settings')).json()) as object, { enabled: false });
    assert.equal((await h.api('/api/advance/settings', 'PUT', { enabled: 'yes' })).status, 400);
  } finally { await h.close(); }
});

test('a wait report arms, wakes on time, and doubles when it waits again', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['wait:等 CI 跑完:2', 'wait:还在等 CI']);
    await h.turn('去看看 CI');
    await h.armed();
    const armed = h.manager.autoAdvance.view(h.thread.id)!;
    assert.equal(armed.reason, 'wait');
    assert.equal(armed.what, '等 CI 跑完');
    assert.deepEqual([armed.attempts, armed.max], [0, 6]);
    assert.equal(h.watch().minutes, 2, 'the reported minutes set the first interval');

    await h.due();
    // The wakeup went out in the daemon's own words and the chain re-armed with the interval doubled.
    const turns = h.store.listTurns(h.thread.id);
    assert.equal(turns.length, 2, 'one wakeup was sent');
    const wake = h.store.listTurnEvents(h.thread.id, turns[1].turnId).find(e => e.type === 'turn.started')!;
    assert.match(String(wake.data.text), /你上一轮说在等：等 CI 跑完。现在去确认一下/);
    assert.equal(h.watch().attempts, 1);
    assert.equal(h.watch().minutes, 4, 'no fresh estimate: the interval doubles');
    assert.ok(Date.parse(h.watch().nextAt!) > Date.now());

    // A fresh estimate on a later wait wins over doubling, clamped to the stated bounds.
    h.lines(['wait:大约还要 30 分钟']);
    await h.turn('再等等'); // the person's own message: the chain starts fresh
    assert.equal(h.watch().attempts, 0, 'the person interjecting starts a fresh chain');
    assert.equal(h.watch().minutes, 30);
  } finally { await h.close(); }
});

test('a doing report sends 「继续」 once quiet, at most three times', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['doing:还在改', 'doing:还在改', 'doing:还在改', 'doing:还在改']);
    await h.turn('继续改');
    await h.armed();
    assert.deepEqual([h.manager.autoAdvance.view(h.thread.id)!.reason, h.manager.autoAdvance.view(h.thread.id)!.max], ['continue', 3]);
    for (let i = 1; i <= 3; i++) {
      await h.due();
      assert.equal(h.watch().attempts, i);
      const ask = h.store.listTurnEvents(h.thread.id, h.store.listTurns(h.thread.id).at(-1)!.turnId).find(e => e.type === 'turn.started')!;
      // The block telling the agent about `[进度]` is injected once per thread, not on every turn.
      if (i === 1) assert.equal(String(ask.data.text), '继续');
    }
    // The fourth doing report spends the chain: nothing more is sent, the thread is the person's.
    await wait(() => { const v = h.manager.autoAdvance.view(h.thread.id); return v === null || v.nextAt === null; });
    const view = h.manager.autoAdvance.view(h.thread.id)!;
    assert.deepEqual([view.attempts, view.nextAt], [3, null]);
    assert.equal(h.store.listTurns(h.thread.id).length, 4, 'the ask plus three continues');
    await h.manager.autoAdvance.check();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.store.listTurns(h.thread.id).length, 4, 'an exhausted chain sends nothing');
    // The overview says it came back to the person, and why.
    const entry = contextEntries(h.store, h.manager, 'other-thread').find(e => e.id === h.thread.id)!;
    assert.equal(entry.category, 'needs');
    assert.match(entry.note, /自动推进 3 次仍未完成/);
  } finally { await h.close(); }
});

test('a wait chain gives up after six wakeups and the thread becomes the person\'s', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['wait:等 CI:2', 'wait:还在等', 'wait:还在等', 'wait:还在等', 'wait:还在等', 'wait:还在等', 'wait:还在等']);
    await h.turn('去看 CI');
    await h.armed();
    for (let i = 0; i < 6; i++) await h.due();
    assert.equal(h.store.listTurns(h.thread.id).length, 7, 'the ask plus six wakeups');
    await wait(() => { const v = h.manager.autoAdvance.view(h.thread.id); return v === null || v.nextAt === null; });
    const view = h.manager.autoAdvance.view(h.thread.id)!;
    assert.deepEqual([view.reason, view.attempts, view.nextAt], ['wait', 6, null]);
    await h.manager.autoAdvance.check();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.store.listTurns(h.thread.id).length, 7, 'nothing follows the cap');
    const entry = contextEntries(h.store, h.manager, 'other-thread').find(e => e.id === h.thread.id)!;
    assert.equal(entry.category, 'needs');
    assert.match(entry.note, /自动推进 6 次仍未完成/);
  } finally { await h.close(); }
});

test('an armed watch reads as arranged in the assistant overview, not as running or needing', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['wait:等部署:5']);
    await h.turn('等部署完');
    await h.armed();
    const entry = contextEntries(h.store, h.manager, 'other-thread').find(e => e.id === h.thread.id)!;
    assert.equal(entry.category, 'scheduled');
    assert.match(entry.note, /^等部署；.+再看$/);
  } finally { await h.close(); }
});

test('the person\'s word retires the watch; the line\'s cancel does too', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['wait:等 CI:10', 'review:做完了']);
    await h.turn('等 CI');
    await h.armed();
    // A turn that reports another stage retires it.
    await h.turn('别等了');
    await h.gone();
    // And the cancel on the thread's own line.
    h.lines(['wait:等 CI:10']);
    await h.turn('再等一次');
    await h.armed();
    assert.equal((await h.api(`/api/threads/${h.thread.id}/advance/watch`, 'DELETE')).status, 200);
    assert.equal(h.manager.autoAdvance.view(h.thread.id), null);
    await h.manager.autoAdvance.check();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.store.listTurns(h.thread.id).length, 3, 'nothing is sent after the cancel');
  } finally { await h.close(); }
});

test('a cancelled turn never arms, and retires what was armed', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['wait:等 CI:10', 'slow']);
    await h.turn('等 CI');
    await h.armed();
    const stopping = h.manager.startTurn(h.thread.id, { text: '说点什么' });
    await wait(() => h.manager.threadView(h.thread.id).status === 'running');
    await h.manager.cancelTurn(h.thread.id);
    await stopping.catch(() => undefined);
    await h.gone();
  } finally { await h.close(); }
});

test('an error turn and the assistant\'s, a collaboration\'s and a proactive thread never arm', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    // A turn that dies retires instead of arming.
    h.lines(['error:boom']);
    await h.turn('会失败的请求');
    assert.equal(h.manager.threadView(h.thread.id).status, 'error');
    assert.equal(h.manager.autoAdvance.view(h.thread.id), null);

    // The assistant's own conversation.
    const router = await h.manager.createThread({ agent: 'agy', cwd: h.dir });
    h.store.saveHubSetting('personalRouter', { threadId: router.id, introduced: true });
    h.lines(['wait:等 CI:10']);
    await h.turn('等 CI', router.id);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.manager.autoAdvance.view(router.id), null, 'the assistant thread is not advanced');

    // A thread the proactive machinery opened for itself.
    const worker = await h.manager.createThread({ agent: 'agy', cwd: h.dir });
    h.store.saveHubSetting('personalProactiveRuns', [{ id: 'run-1', matterId: '', kind: 'prepare', threadId: worker.id, startedAt: new Date().toISOString(), status: 'observed' }]);
    h.lines(['wait:等 CI:10']);
    await h.turn('等 CI', worker.id);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.manager.autoAdvance.view(worker.id), null, 'a proactive thread is not advanced');

    // A collaboration's thread: the lead runs it and member results wake it.
    const lead = await h.manager.createThread({ agent: 'agy', cwd: h.dir });
    const team = new CoordinationManager(h.store, h.manager, join(h.dir, 'ipc', 'calli.sock'), { exchangeRoot: join(h.dir, 'exchange'), resultDir: join(h.dir, 'results') });
    try {
      await team.enable(lead.id);
      h.lines(['wait:等 CI:10']);
      await h.turn('等 CI', lead.id);
      await new Promise(r => setTimeout(r, 50));
      assert.equal(h.manager.autoAdvance.view(lead.id), null, 'a collaboration thread is not advanced');
    } finally { team.dispose(); }
  } finally { await h.close(); }
});

test('a watch survives a daemon restart and then wakes', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['wait:等 CI:2']);
    await h.turn('等 CI');
    await h.armed();
    await h.manager.shutdown();
    h.store.close();
    // A fresh daemon on the same data still knows the wait. The fake agent is a fresh process, so
    // its script starts over: the wakeup's answer is the first line of what it reads now.
    h.lines(['review:好了']);
    const store = new Store(h.dir);
    const adapters = new Map<string, AgentAdapter>();
    adapters.set('agy', new AgyAdapter([process.execPath, join(fixtures, 'fake-agy.mjs')], { FAKE_AGY_ADVANCE: h.script }));
    const manager = new ThreadManager(store, adapters, [h.dir], new AttachmentStore(h.dir), () => [{ id: 'agy', adapter: 'agy' }]);
    manager.progressWanted = () => true;
    Object.defineProperty(manager.autoAdvance, 'minuteMs', { value: 10 });
    try {
      assert.equal(manager.autoAdvance.view(h.thread.id)?.reason, 'wait');
      const end = Date.now() + 8000;
      while (store.listTurns(h.thread.id).length < 2) {
        if (Date.now() > end) throw new Error('the wakeup never went out');
        await manager.autoAdvance.check();
        await new Promise(r => setTimeout(r, 10));
      }
      await wait(() => manager.threadView(h.thread.id).status !== 'running');
      await wait(() => manager.autoAdvance.view(h.thread.id) === null);
      // The wakeup's answer reported 待验收: the watch is gone and the report stands.
      assert.equal(store.getThread(h.thread.id)!.report!.stage, 'review');
    } finally { await manager.shutdown(); store.close(); }
  } finally { await h.close(); }
});

test('the thread view carries the watch; overrides and the global switch retire it', async () => {
  const h = await setup();
  try {
    h.manager.autoAdvance.configure({ enabled: true });
    h.lines(['wait:等 CI:10']);
    await h.turn('等 CI');
    await h.armed();
    const view = h.manager.threadView(h.thread.id).advance!;
    assert.deepEqual([view.reason, view.attempts], ['wait', 0]);
    assert.ok(view.nextAt);

    // The thread's own override wins over the global switch.
    assert.equal((await h.api(`/api/threads/${h.thread.id}/advance`, 'PUT', { enabled: false })).status, 200);
    assert.equal(h.manager.autoAdvance.view(h.thread.id), null);
    assert.deepEqual(h.manager.autoAdvance.state(h.thread.id), { enabled: false, source: 'thread', override: false });
    h.lines(['wait:等 CI:10']);
    await h.turn('又等了');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.manager.autoAdvance.view(h.thread.id), null, 'an overridden-off thread never arms');

    // Back to inherit: the global switch arms again, and turning the global off clears the watch.
    assert.equal((await h.api(`/api/threads/${h.thread.id}/advance`, 'PUT', { enabled: null })).status, 200);
    assert.equal((await h.api(`/api/threads/${h.thread.id}/advance`, 'PUT', { enabled: 'x' })).status, 400);
    h.lines(['wait:等 CI:10']);
    await h.turn('还等');
    await h.armed();
    assert.equal((await h.api('/api/advance/settings', 'PUT', { enabled: false })).status, 200);
    assert.equal(h.manager.autoAdvance.view(h.thread.id), null);
  } finally { await h.close(); }
});
