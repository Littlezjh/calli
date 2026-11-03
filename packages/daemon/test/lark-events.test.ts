import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { LarkChannel, type LarkChannelSettings } from '../src/channels/lark.js';
import { LarkEvents, eventSignals } from '../src/channels/lark-events.js';
import type { PersonalService } from '../src/personal.js';

const settings: LarkChannelSettings = { enabled: true, people: [{ id: 'ou_watch', name: '同事' }], chats: [], intervalMin: 120, workHours: { start: 9, end: 21, timeZone: 'UTC' } };
const message = { type: 'im.message.receive_v1', message_id: 'om_live', event_id: 'event_live', thread_id: 'omt_live', sender_id: 'ou_watch', content: '请检查材料' };
const waitFor = async (condition: () => boolean) => {
  const end = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < end, 'fixture did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function setup(initial: object, missing = false) {
  const dir = mkdtempSync(join(tmpdir(), 'calli-lark-events-'));
  const data = join(dir, 'data.json'), log = join(dir, 'log.jsonl');
  const config = (v: object) => writeFileSync(data, JSON.stringify({ tasks: [], ...v })); config(initial);
  const store = new Store(dir), sent: string[] = [];
  const personal = { directory: () => dir, manager: { startTurn: async () => {} }, router: { status: () => ({ threadId: null }), receiveSignals: async (text: string) => { sent.push(text); return { threadId: 'router' }; } } } as unknown as Pick<PersonalService, 'directory' | 'manager' | 'router'>;
  const options = { executable: missing ? join(dir, 'missing') : resolve('test/fixtures/fake-lark-channel.mjs'), env: { ...process.env, CALLI_TEST_SECRET: 'must-be-stripped', FAKE_LARK_DATA: data, FAKE_LARK_LOG: log } };
  const channel = new LarkChannel(store, personal, options); channel.save(settings);
  const retries: Array<{ callback: () => void; ms: number; due: number; cancelled: boolean }> = []; let clock = 0;
  const events = new LarkEvents(channel, { ...options, schedule: (callback, ms) => { const retry = { callback, ms, due: clock + ms, cancelled: false }; retries.push(retry); return () => { retry.cancelled = true; }; } });
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s) as string[]); } catch { return []; } };
  const consumeCalls = () => calls().filter(args => args[0] === 'event' && !args.includes('--dry-run'));
  const advance = (ms: number) => { clock += ms; for (const retry of [...retries]) if (!retry.cancelled && retry.due <= clock) { retry.cancelled = true; retry.callback(); } };
  return { channel, events, store, sent, config, calls, consumeCalls, retries, advance, async close() { await events.dispose(); await channel.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('live NDJSON reaches Router immediately outside work hours, and polling duplicates are ignored', async () => {
  const h = setup({ realtime: { events: [message] }, messages: [message] }); try {
    h.events.start();
    await waitFor(() => h.sent.length === 1);
    assert.equal((await h.channel.status()).realtime, 'live');
    assert.equal(JSON.parse(h.sent[0]).source.ref, message.message_id);
    assert.equal(h.calls().some(args => args[1] === '+get-my-tasks'), false, 'no polling timer or run was needed');
    await h.channel.run(); assert.equal(h.sent.length, 1); assert.equal(h.store.listSignals().length, 1);
    assert.deepEqual(h.store.getSignal('lark-message:om_live')?.disposition, { outcome: 'router', pending: false, matterIds: [], threadId: 'router' });
    assert.ok(h.consumeCalls()[0].includes('bot'));
  } finally { await h.close(); }
});

test('busy-elsewhere retries only at ten minutes, then recovers without a restart storm', async () => {
  const h = setup({ realtime: { busy: true } }); try {
    h.events.start(); await waitFor(() => h.retries.length === 1);
    assert.equal((await h.channel.status()).realtime, 'busy-elsewhere'); assert.equal(h.retries[0].ms, 600_000);
    h.advance(599_999); assert.equal(h.consumeCalls().length, 1);
    h.config({ realtime: { events: [message] } }); h.advance(1);
    await waitFor(() => h.sent.length === 1);
    assert.equal(h.consumeCalls().length, 2); assert.equal((await h.channel.status()).realtime, 'live');
  } finally { await h.close(); }
});

test('crashes restart with exponential backoff, disable cancels retries and enable reconnects', async () => {
  const h = setup({ realtime: { exitCode: 2 } }); try {
    h.events.start(); await waitFor(() => h.retries.length === 1);
    assert.equal(h.retries[0].ms, 5000); h.advance(5000);
    await waitFor(() => h.retries.length === 2); assert.equal(h.retries[1].ms, 10000);
    h.channel.save({ enabled: false }); h.advance(300_000);
    assert.equal((await h.channel.status()).realtime, 'off'); assert.equal(h.consumeCalls().length, 2);
    h.config({ realtime: { events: [message] } }); h.channel.save({ enabled: true });
    await waitFor(() => h.sent.length === 1); assert.equal(h.consumeCalls().length, 3);
  } finally { await h.close(); }
});

test('console-off and unavailable are explicit, and disabled settings spawn no process', async () => {
  const h = setup({ realtime: { consoleOff: true } }); try {
    h.channel.save({ enabled: false }); h.events.start(); assert.equal(h.calls().length, 0);
    h.channel.save({ enabled: true }); await waitFor(() => h.retries.length === 1);
    assert.equal((await h.channel.status()).realtime, 'console-off'); assert.equal(h.consumeCalls().length, 0);
  } finally { await h.close(); }
  const missing = setup({}, true); try {
    missing.events.start(); await waitFor(() => missing.retries.length === 1);
    assert.equal((await missing.channel.status()).realtime, 'unavailable'); assert.equal(missing.retries[0].ms, 300_000);
  } finally { await missing.close(); }
});

test('task events use user identity and event IDs, while subscriptions use the task guid', async () => {
  const task = { header: { event_id: 'task_change_1', create_time: '1793498400000', token: 'private_callback_token' }, event: { task_guid: 'task_guid', event_types: ['task_summary_update'] } };
  const h = setup({ realtime: { events: [task] } }); try {
    h.channel.save({ events: ['task.task.update_user_access_v2'] }); h.events.start();
    await waitFor(() => h.sent.length === 1);
    const signal = JSON.parse(h.sent[0]);
    assert.deepEqual(signal.thread, { kind: 'lark-task', ref: 'task_guid' }); assert.equal(signal.source.ref, 'task_change_1');
    assert.ok(!h.sent[0].includes('private_callback_token')); assert.ok(h.consumeCalls()[0].includes('user'));
    const next = eventSignals({ ...task, header: { event_id: 'task_change_2' } }, 'task.task.update_user_access_v2', settings);
    await h.channel.receive(next); assert.equal(h.sent.length, 2, 'later changes to the same task are distinct signals');
  } finally { await h.close(); }
});

test('raw callback messages normalize IDs and JSON content; unrelated messages are archived as filtered', async () => {
  const h = setup({ realtime: { events: [{ ...message, sender_id: 'ou_other' }] } }); try {
    h.events.start(); await waitFor(() => h.store.listSignals().length === 1);
    assert.equal(h.sent.length, 0); assert.equal(h.store.listSignals()[0].disposition.reason, 'outside-watch-scope');
    const signals = eventSignals({ event: { message: { ...message, message_id: 'om_raw', content: '{"text":"请看回复"}' }, sender: { id: 'ou_watch' } } }, 'im.message.receive_v1', settings);
    await h.channel.receive(signals); assert.equal(JSON.parse(h.sent[0]).summary, '请看回复');
  } finally { await h.close(); }
});

test('message bodies cannot spoof consumer errors or terminate the connection', async () => {
  const h = setup({ realtime: { events: [{ ...message, content: '请检查：another event bus is already connected to this app' }] } });
  try {
    h.events.start(); await waitFor(() => h.sent.length === 1);
    assert.equal((await h.channel.status()).realtime, 'live'); assert.equal(h.retries.length, 0);
  } finally { await h.close(); }
});
