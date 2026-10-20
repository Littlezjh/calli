import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import { AttachmentStore } from '../src/attachments.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import type { StoredEvent } from '../src/events.js';
import type { VoiceSignal } from '../src/voice-sessions.js';

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function setup(t: TestContext, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rah-voice-production-'));
  const log = join(directory, 'rpc.jsonl');
  const adapter = new CodexAppServerAdapter([process.execPath, fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))], {
    ...env, FAKE_CODEX_RPC_LOG: log,
  });
  const store = new Store(directory);
  const adapters = new Map([['provider', adapter]]);
  const manager = new ThreadManager(store, adapters, [directory], new AttachmentStore(directory));
  const events: StoredEvent[] = [];
  manager.subscribe(event => events.push(event));
  const thread = await manager.createThread({ agent: 'provider', cwd: directory });
  t.after(async () => { await manager.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { adapter, adapters, manager, thread, events, store,
    methods: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).method) : [],
  };
}

test('protocol availability is read-only and unsupported versions cannot advertise voice', async t => {
  const a = await setup(t);
  assert.deepEqual(await a.adapter.realtimeSupport(), { supported: true, login: 'ready' });
  assert.ok(!a.methods().includes('thread/start'));
  assert.ok(!a.methods().includes('thread/realtime/start'));
  const b = await setup(t, { FAKE_CODEX_NO_VOICE: '1' });
  assert.deepEqual(await b.adapter.realtimeSupport(), { supported: false });
});

test('native voice work retains approvals, survives voice stop, and drains queued text exactly once', async t => {
  const { manager, thread, events, methods } = await setup(t, { FAKE_CODEX_VOICE_TASK: 'approve' });
  const voice = manager.voiceTransport(thread.id);
  const signals: VoiceSignal[] = [];
  await voice.start('fixture-offer', signal => signals.push(signal));
  await until(() => events.some(e => e.type === 'approval.request'));
  const native = events.find(e => e.type === 'turn.started' && e.data.source === 'voice')!;
  const approval = events.find(e => e.type === 'approval.request')!;
  assert.equal(approval.turnId, native.turnId);
  assert.equal(manager.getThread(thread.id).status, 'running');
  const queued = await manager.startTurn(thread.id, { text: 'after voice', queue: true });
  assert.ok('queued' in queued);
  await voice.stop(); voice.dispose();
  assert.equal(manager.getThread(thread.id).status, 'running');
  assert.ok(!methods().includes('turn/interrupt'));
  const option = (approval.data.options as { optionId: string }[])[0].optionId;
  manager.resolveApproval(String(approval.data.approvalId), { optionId: option });
  await until(() => events.filter(e => e.type === 'turn.done').length === 2);
  assert.equal(events.filter(e => e.type === 'turn.started').length, 2);
  assert.equal(methods().filter(m => m === 'turn/start').length, 1);
  assert.ok(signals.some(s => s.type === 'transcript'));
  assert.ok(!JSON.stringify(events).includes('temporary caption'));
  assert.ok(events.filter(e => e.turnId === native.turnId && e.type === 'message.delta').map(e => e.data.text).join('').includes('approved'));
  assert.equal(manager.getThread(thread.id).status, 'idle');
});

test('opening and closing voice during an existing task preserves its process and cancellation ownership', async t => {
  const { manager, thread, events, methods } = await setup(t);
  await manager.startTurn(thread.id, { text: 'slow' });
  await until(() => methods().includes('turn/start'));
  const voice = manager.voiceTransport(thread.id);
  await voice.start('fixture-offer', () => {});
  await voice.stop(); voice.dispose();
  assert.equal(manager.getThread(thread.id).status, 'running');
  assert.equal(methods().filter(m => m === 'thread/start').length, 1);
  assert.ok(!methods().includes('turn/interrupt'));
  await manager.cancelTurn(thread.id);
  await until(() => events.some(e => e.type === 'turn.done'));
  assert.equal(methods().filter(m => m === 'turn/interrupt').length, 1);
});

test('a clean native close permits another voice session on the same live thread', async t => {
  const { manager, thread, methods } = await setup(t);
  for (let i = 0; i < 2; i++) {
    const voice = manager.voiceTransport(thread.id);
    await voice.start('fixture-offer', () => {});
    await voice.stop(); voice.dispose();
  }
  assert.equal(methods().filter(m => m === 'thread/realtime/start').length, 2);
  assert.equal(methods().filter(m => m === 'thread/start').length, 1);
});

test('disposing an unclean voice source blocks unsafe reuse without replacing the task thread', async t => {
  const { manager, thread, methods } = await setup(t, { FAKE_CODEX_VOICE_NO_CLOSE: '1' });
  const voice = manager.voiceTransport(thread.id);
  await voice.start('fixture-offer', () => {});
  const stop = voice.stop(); voice.dispose(); await stop;
  const next = manager.voiceTransport(thread.id);
  await assert.rejects(next.start('another-offer', () => {}), /voice_session_unavailable/);
  next.dispose();
  assert.equal(methods().filter(m => m === 'thread/realtime/start').length, 1);
  assert.equal(methods().filter(m => m === 'thread/start').length, 1);
});

test('API key accounts fail locally without a realtime start or fallback', async t => {
  const { manager, thread, methods } = await setup(t, { FAKE_CODEX_VOICE_API_KEY: '1' });
  const voice = manager.voiceTransport(thread.id);
  await assert.rejects(voice.start('fixture-offer', () => {}), /chatgpt_login_required/);
  voice.dispose();
  assert.ok(!methods().includes('thread/realtime/start'));
});

test('a lease cancelled during process initialization never starts a late upstream voice session', async t => {
  const { manager, thread, methods } = await setup(t);
  const voice = manager.voiceTransport(thread.id);
  const pending = voice.start('fixture-offer', () => {});
  await voice.stop(); voice.dispose();
  await assert.rejects(pending, /voice_session_ended/);
  assert.ok(!methods().includes('thread/realtime/start'));
});


test('a native task starting in the same stdout batch as a prompted completion remains running', async t => {
  const { manager, thread, events } = await setup(t, { FAKE_CODEX_VOICE_AFTER_PROMPT: '1' });
  await manager.startTurn(thread.id, { text: 'first' });
  await until(() => events.some(e => e.type === 'approval.request'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.getThread(thread.id).status, 'running');
  const approval = events.find(e => e.type === 'approval.request')!;
  const native = events.find(e => e.type === 'turn.started' && e.data.source === 'voice')!;
  assert.equal(approval.turnId, native.turnId);
  assert.ok('queued' in await manager.startTurn(thread.id, { text: 'next', queue: true }));
  manager.resolveApproval(String(approval.data.approvalId), { optionId: 'accept' });
  await until(() => events.filter(e => e.type === 'turn.done').length === 3);
  assert.equal(manager.getThread(thread.id).status, 'idle');
});


test('replacing an idle provider cannot reuse the previous account connection for voice', async t => {
  const { adapter, adapters, manager, thread, methods } = await setup(t);
  const first = manager.voiceTransport(thread.id);
  await first.start('fixture-offer', () => {});
  await first.stop(); first.dispose();
  const before = methods().length;
  const replacement = new CodexAppServerAdapter([process.execPath, fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))], { FAKE_CODEX_VOICE_API_KEY: '1' });
  assert.notEqual(adapter, replacement);
  adapters.set('provider', replacement);
  const next = manager.voiceTransport(thread.id);
  await assert.rejects(next.start('fixture-offer', () => {}), /chatgpt_login_required/);
  next.dispose();
  assert.equal(methods().length, before, 'the old account must not receive new RPCs');
});
