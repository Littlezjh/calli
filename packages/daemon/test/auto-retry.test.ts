import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wait = async (check: () => unknown, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
};

/** One daemon with a fake agy agent; `once` makes the transient failure happen once per conversation. */
async function setup(opts: { once?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-retry-test-'));
  const store = new Store(dir);
  const adapters = new Map<string, AgentAdapter>();
  adapters.set('agy', new AgyAdapter([process.execPath, join(fixtures, 'fake-agy.mjs')],
    opts.once ? { FAKE_TRANSIENT_ONCE: join(dir, 'transient-once') } : {}));
  const manager = new ThreadManager(store, adapters, [dir], new AttachmentStore(dir), () => [{ id: 'agy', adapter: 'agy' }]);
  Object.defineProperty(manager.autoRetry, 'backoffMs', { value: [10, 10, 10] });
  const server = createHttpServer({ manager, token: 'test-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const thread = await manager.createThread({ agent: 'agy', cwd: dir });
  const idle = (id = thread.id) => wait(() => manager.threadView(id).status !== 'running');
  const marks = (id = thread.id) => store.listEvents(id, 0, -1).filter(e => e.type === 'turn.retry');
  return {
    dir, store, manager, thread, api, idle, marks,
    /** The watch arms as the failing turn settles; one due watch then fires: the ask goes out
     * again, marked on the timeline. Waits for the arm first — the thread flips to `error` a
     * beat before the watch lands in the same settle. */
    armed: (id = thread.id) => wait(() => manager.autoRetryView(id) !== null),
    resend: async (id = thread.id) => {
      await wait(() => { const w = manager.autoRetryView(id); return w !== null && Date.parse(w.nextAt) <= Date.now(); });
      await manager.autoRetry.check();
      await wait(() => marks(id).length > 0);
    },
    close: async () => { await manager.shutdown(); server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a transient failure is retried by the daemon and the thread goes on', async () => {
  const h = await setup({ once: true });
  try {
    await h.manager.startTurn(h.thread.id, { text: 'no-capacity' });
    await h.idle();
    // The watch arms the moment the turn dies; the error carries no code of its own.
    await h.armed();
    assert.equal(h.store.lastTurnFailure(h.thread.id)!.code, null);
    await h.resend();
    await h.idle();
    // The marker makes the fake agent succeed the second time: the ask went out again, marked.
    const turns = h.store.listTurns(h.thread.id);
    assert.equal(turns.length, 2, 'the failed ask should be resent once');
    assert.equal(h.marks().length, 1);
    assert.equal(h.marks()[0].data.attempt, 1);
    const answer = h.store.listTurnEvents(h.thread.id, turns[1].turnId).filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
    assert.match(answer, /echo:no-capacity/);
    assert.equal(h.manager.threadView(h.thread.id).status, 'idle');
    // The watch retires on the next pass, as the daemon's interval would: the last turn no
    // longer fails, so there is nothing left to retry.
    await h.manager.autoRetry.check();
    assert.equal(h.manager.autoRetryView(h.thread.id), null, 'the watch retires with the thread back on its feet');
  } finally { await h.close(); }
});

test('the person can cancel the automatic retry from the error card', async () => {
  const h = await setup();
  try {
    await h.manager.startTurn(h.thread.id, { text: 'no-capacity' });
    await h.idle();
    await h.armed();
    assert.equal((await h.api(`/api/threads/${h.thread.id}/auto-retry`, 'PATCH', { enabled: false })).status, 200);
    assert.equal(h.manager.autoRetryView(h.thread.id), null);
    await h.manager.autoRetry.check();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.store.listTurns(h.thread.id).length, 1, 'nothing is resent after the cancel');
    // Arming stays automatic: the endpoint exists to call the retry off.
    assert.equal((await h.api(`/api/threads/${h.thread.id}/auto-retry`, 'PATCH', { enabled: true })).status, 400);
  } finally { await h.close(); }
});

test('persistent trouble exhausts the attempts and leaves the thread to the person', async () => {
  const h = await setup();
  try {
    await h.manager.startTurn(h.thread.id, { text: 'no-capacity' });
    await h.idle();
    await h.armed();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.resend();
      await h.idle();
      assert.equal(h.marks().length, attempt);
      if (attempt < 3) assert.ok(h.manager.autoRetryView(h.thread.id), `the watch should stay armed after attempt ${attempt}`);
    }
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.manager.autoRetryView(h.thread.id), null, 'the watch gives up after three attempts');
    assert.equal(h.manager.threadView(h.thread.id).status, 'error');
    assert.equal(h.store.listTurns(h.thread.id).length, 4, 'the original ask plus three resends');
  } finally { await h.close(); }
});

test('a quota failure never enters the automatic retry', async () => {
  const h = await setup();
  try {
    // The fixture's own exhaust trigger: a coded plan_exhausted goes to the handover machinery.
    await h.manager.startTurn(h.thread.id, { text: 'quota-exhausted' });
    await h.idle();
    assert.equal(h.manager.autoRetryView(h.thread.id), null);
    assert.equal(h.store.listTurns(h.thread.id).length, 1);
  } finally { await h.close(); }
});
