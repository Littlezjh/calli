import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { ZcodeAdapter } from '../src/adapters/zcode.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import { TraexAcpAdapter } from '../src/adapters/traex.js';
import type { EmittedEvent } from '../src/events.js';
import type { TurnHooks } from '../src/adapters/types.js';
import { ThreadManager } from '../src/threads.js';
import { Store } from '../src/store.js';
import { AttachmentStore } from '../src/attachments.js';
const here = dirname(fileURLToPath(import.meta.url));
const input = (text: string) => ({ text, images: [] });
const hooks = (events: EmittedEvent[]): TurnHooks => ({ emit: (e) => events.push(e), requestApproval: async (r) => ({ optionId: r.options[0].optionId }) });

for (const [name, Adapter, fixture] of [['Codex', CodexAppServerAdapter, 'fake-codex.mjs'], ['TraeX', TraexAcpAdapter, 'fake-acp.mjs'], ['zcode', ZcodeAdapter, 'fake-zcode.mjs']] as const) {
  test(`${name} native goal owns multiple turns, approvals and terminal status`, { timeout: 5000 }, async () => {
    const adapter = new Adapter([process.execPath, join(here, 'fixtures', fixture)]);
    assert.ok((await adapter.commands(here)).some(c => c.name === 'goal'));
    const s = await adapter.start({ cwd: here });
    const events: EmittedEvent[] = [];
    try {
      assert.equal((await s.prompt(input('/goal'), hooks(events))).stopReason, 'end_turn');
      assert.match(String(events.at(-1)?.data.text), /没有目标/);
      assert.equal((await s.prompt(input('/goal approve'), hooks(events))).stopReason, 'end_turn');
      const text = events.filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
      assert.match(text, /目标第 1 轮/);
      assert.match(text, /approved|decision:allow/);
      assert.match(text, /报告已完成/);
      assert.equal((await s.prompt(input('/goal clear'), hooks(events))).stopReason, 'end_turn');
      assert.equal((await s.prompt(input('hello'), hooks(events))).stopReason, 'end_turn');
    } finally { await s.close(); }
  });

  for (const control of ['stop', 'pause'] as const) {
    test(`${name} ${control} stops native continuation and allows subsequent prompts`, { timeout: 5000 }, async () => {
      const s = await new Adapter([process.execPath, join(here, 'fixtures', fixture)]).start({ cwd: here });
      const events: EmittedEvent[] = [];
      try {
        const pending = s.prompt(input('/goal slow'), hooks(events));
        if (control === 'stop') await s.cancel(); else await s.controlGoal!('pause');
        assert.equal((await pending).stopReason, 'cancelled');
        assert.equal((await s.prompt(input('/goal'), hooks(events))).stopReason, 'end_turn');
        assert.match(events.filter(e => e.type === 'message.delta').map(e => e.data.text).join(''), /已暂停/);
        assert.equal((await s.prompt(input('/goal clear'), hooks(events))).stopReason, 'end_turn');
        assert.equal((await s.prompt(input('hello'), hooks(events))).stopReason, 'end_turn');
      } finally { await s.close(); }
    });
  }

  test(`${name} unsupported goal fails visibly and leaves session usable`, { timeout: 5000 }, async () => {
    const s = await new Adapter([process.execPath, join(here, 'fixtures', fixture)], { FAKE_CODEX_NO_GOALS: '1', FAKE_ZCODE_NO_GOALS: '1' }).start({ cwd: here });
    try {
      const result = await s.prompt(input('/goal something'), hooks([])).catch(error => ({ stopReason: 'error', error: String(error) }));
      assert.equal(result.stopReason, 'error');
      assert.match(result.error!, /support/);
      assert.equal((await s.prompt(input('hello'), hooks([]))).stopReason, 'end_turn');
    } finally { await s.close(); }
  });
}

for (const env of [{ FAKE_CODEX_GOAL_EARLY: '1' }, { FAKE_CODEX_GOAL_LATE: '1' }]) {
  test(`Codex goal tolerates native notification order ${JSON.stringify(env)}`, { timeout: 5000 }, async () => {
    const s = await new CodexAppServerAdapter([process.execPath, join(here, 'fixtures/fake-codex.mjs')], env).start({ cwd: here });
    try { assert.equal((await s.prompt(input('/goal test'), hooks([]))).stopReason, 'end_turn'); }
    finally { await s.close(); }
  });
}

test('Claude exposes native goal, forwards the session command and clears during execution', { timeout: 5000 }, async () => {
  const a = new ClaudeAcpAdapter([process.execPath, join(here, 'fixtures/fake-acp.mjs')]);
  const s = await a.start({ cwd: here });
  try {
    assert.ok((await a.commands(here)).some(c => c.name === 'goal'));
    assert.equal((await s.prompt(input('/goal test'), hooks([]))).stopReason, 'end_turn');
    assert.equal((await s.prompt(input('/goal pause'), hooks([]))).stopReason, 'error');
    const pending = s.prompt(input('/goal slow'), hooks([]));
    await s.controlGoal!('clear');
    assert.equal((await pending).stopReason, 'end_turn');
    assert.equal((await s.prompt(input('hello'), hooks([]))).stopReason, 'end_turn');
  } finally { await s.close(); }
});

test('agy native goals, when advertised, stay in the resumed conversation', { timeout: 5000 }, async () => {
  const a = new AgyAdapter([process.execPath, join(here, 'fixtures/fake-agy.mjs')], { FAKE_AGY_GOAL: '1' });
  assert.ok((await a.commands(here)).some(c => c.name === 'goal'));
  const s = await a.start({ cwd: here, resumeId: 'existing-conversation' });
  const events: EmittedEvent[] = [];
  try {
    await s.prompt(input('/goal test'), hooks(events));
    const text = events.filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
    assert.match(text, /echo:\/goal test/);
    assert.match(text, /conv:existing-conversation/);
    assert.doesNotMatch(text, /print:/);
  } finally { await s.close(); }
});

test('Codex can stop the current turn after clearing its goal', { timeout: 5000 }, async () => {
  const s = await new CodexAppServerAdapter([process.execPath, join(here, 'fixtures/fake-codex.mjs')]).start({ cwd: here });
  try {
    const pending = s.prompt(input('/goal slow'), hooks([]));
    await s.controlGoal!('clear');
    await s.cancel();
    assert.equal((await pending).stopReason, 'cancelled');
    assert.equal((await s.prompt(input('hello'), hooks([]))).stopReason, 'end_turn');
  } finally { await s.close(); }
});

test('zcode waits for native failure cleanup before releasing the goal turn', { timeout: 5000 }, async () => {
  const s = await new ZcodeAdapter([process.execPath, join(here, 'fixtures/fake-zcode.mjs')]).start({ cwd: here });
  const events: EmittedEvent[] = [];
  try {
    const result = await s.prompt(input('/goal turn-fail'), hooks(events));
    assert.equal(result.stopReason, 'error');
    assert.equal(result.error, '模型请求失败');
    assert.match(events.filter(e => e.type === 'message.delta').map(e => e.data.text).join(''), /已暂停/);
    assert.equal((await s.prompt(input('hello'), hooks([]))).stopReason, 'end_turn');
  } finally { await s.close(); }
});

test('goal controls reject during startup and bypass a full queue without releasing the running turn', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rah-goal-test-'));
  const store = new Store(dir);
  const adapter = new CodexAppServerAdapter([process.execPath, join(here, 'fixtures/fake-codex.mjs')]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = adapter.start.bind(adapter);
  adapter.start = async opts => { await gate; return start(opts); };
  const manager = new ThreadManager(store, new Map([['codex', adapter]]), [dir], new AttachmentStore(dir));
  const waitUntil = async (condition: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('native goal state timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    const thread = await manager.createThread({ agent: 'codex', cwd: dir });
    await manager.startTurn(thread.id, { text: '/goal slow' });
    await assert.rejects(manager.startTurn(thread.id, { text: '/goal pause', queue: true }), /正在启动/);
    assert.equal(manager.listThreads()[0].queued.length, 0);
    release();
    await waitUntil(() => !!store.getThread(thread.id)?.agentSessionId);
    for (let i = 0; i < 5; i++) assert.ok('queued' in await manager.startTurn(thread.id, { text: `hello ${i}`, queue: true }));
    const shown = await manager.startTurn(thread.id, { text: '/goal', queue: true });
    assert.ok('turnId' in shown);
    await waitUntil(() => manager.listEvents(thread.id, 0).some(e => e.turnId === shown.turnId && e.type === 'turn.done'));
    assert.equal(store.getThread(thread.id)?.status, 'running');
    assert.equal(manager.listThreads()[0].queued.length, 5);
    const paused = await manager.startTurn(thread.id, { text: '/goal pause', queue: true });
    assert.ok('turnId' in paused);
    await waitUntil(() => store.getThread(thread.id)?.status === 'idle' && manager.listThreads()[0].queued.length === 0);
    const entries = manager.listEvents(thread.id, 0);
    assert.equal(entries.filter(e => e.type === 'turn.started').length, 8);
    assert.equal(entries.filter(e => e.type === 'turn.error').length, 0);
  } finally {
    release();
    await manager.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex resumes a persisted goal through ordinary prompts without losing continuation', { timeout: 5000 }, async () => {
  const s = await new CodexAppServerAdapter([process.execPath, join(here, 'fixtures/fake-codex.mjs')], { FAKE_CODEX_ACTIVE_GOAL: '1' }).start({ cwd: here, resumeId: 'saved-thread' });
  const events: EmittedEvent[] = [];
  try {
    assert.equal((await s.prompt(input('继续处理'), hooks(events))).stopReason, 'end_turn');
    const text = events.filter(e => e.type === 'message.delta').map(e => e.data.text).join('');
    assert.match(text, /目标第 2 轮/);
    assert.match(text, /报告已完成/);
  } finally { await s.close(); }
});
