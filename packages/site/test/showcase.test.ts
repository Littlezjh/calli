import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShowcaseApi } from '../src/ShowcaseApi';
import { SCENARIOS } from '../src/scenarios';
import { DemoApi, DemoError } from '../../web/src/demo/DemoApi';
import { buildTimeline, type StoredEvent } from '../../web/src/timeline';

function setup() {
  const tasks = new Set<() => void>();
  const api = new ShowcaseApi(run => { tasks.add(run); return () => { tasks.delete(run); }; });
  const drain = () => {
    let count = 0;
    while (tasks.size) {
      assert.ok(count++ < 500, 'a walkthrough must finish or wait for the visitor');
      const next = tasks.values().next().value!;
      tasks.delete(next);
      next();
    }
  };
  const send = async (index: number) => {
    const scenario = SCENARIOS[index];
    await api.startTurn(scenario.threadId, scenario.prompt);
    drain();
    return scenario.threadId;
  };
  return { api, drain, send, tasks };
}

test('a guided task streams into the real timeline without network access', async () => {
  const { api, send } = setup();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('network disabled'); };
  try {
    const received: StoredEvent[] = [];
    const ctrl = new AbortController();
    const stream = api.stream<StoredEvent>('/api/threads/demo-dark-mode/stream?after=0', e => received.push(e), ctrl.signal);
    const id = await send(0);
    const events = await api.eventsTail(id);
    assert.deepEqual(received, events);
    assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
    assert.ok(events.filter(e => e.type === 'message.delta').length > 5, 'the reply arrives in chunks');
    const timeline = buildTimeline(events);
    assert.equal(timeline.running, false);
    assert.ok(timeline.items.some(item => item.kind === 'assistant'));
    assert.equal((await api.thread(id)).status, 'idle');
    assert.equal(api.progress(id), 'completed');
    assert.ok((await api.threadTree(id)).entries.length);
    assert.match((await api.threadText(id, 'src/theme.ts')).text ?? '', /applyTheme/);
    ctrl.abort();
    await stream;
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = realFetch; api.dispose(); }
});

for (const decision of ['allow', 'always', 'reject', 'cancel']) {
  test(`approval pauses playback, then resolves ${decision} in the real timeline`, async () => {
    const { api, send, drain, tasks } = setup();
    try {
      const id = await send(1);
      assert.equal(api.progress(id), 'approval');
      assert.equal(tasks.size, 0, 'waiting for a person consumes no timer');
      assert.equal(buildTimeline(await api.eventsTail(id)).awaitingApproval, true);
      await api.decide('demo-approval', decision === 'cancel' ? { cancel: true } : { optionId: decision });
      await assert.rejects(api.decide('demo-approval', { optionId: 'allow' }), /已经处理/);
      drain();
      const events = await api.eventsTail(id);
      const timeline = buildTimeline(events);
      const approval = timeline.items.find(item => item.kind === 'approval');
      assert.ok(approval?.kind === 'approval' && approval.decision);
      assert.equal(timeline.running, false);
      const testRan = events.some(e => e.type === 'tool.start' && e.data.id === 'showcase-test');
      assert.equal(testRan, decision === 'allow' || decision === 'always');
      if (!testRan) assert.ok(events.some(e => String(e.data.text).includes('尚未验证')));
    } finally { api.dispose(); }
  });
}

for (const choice of ['按文件', '集中一张表']) {
  test(`the answer ${choice} changes the resulting plan`, async () => {
    const { api, send, drain } = setup();
    try {
      const id = await send(2);
      assert.equal(api.progress(id), 'question');
      assert.equal((await api.thread(id)).waitingReason, 'question');
      await assert.rejects(api.answerInput('demo-question', { answers: { layout: ['anything else'] } }), /示例选项/);
      await api.answerInput('demo-question', { answers: { layout: [choice] } });
      drain();
      const timeline = buildTimeline(await api.eventsTail(id));
      assert.equal(timeline.running, false);
      const plan = timeline.items.find(item => item.kind === 'proposal');
      assert.ok(plan?.kind === 'proposal' && plan.done);
      assert.match(plan.text, choice === '按文件' ? /按文件组织/ : /集中声明/);
      assert.equal(api.progress(id), 'completed');
    } finally { api.dispose(); }
  });
}

test('skipping a question closes it and does not invent a plan', async () => {
  const { api, send, drain } = setup();
  try {
    const id = await send(2);
    await api.answerInput('demo-question', { cancelled: true });
    drain();
    const timeline = buildTimeline(await api.eventsTail(id));
    assert.equal(timeline.running, false);
    assert.equal(timeline.items.some(item => item.kind === 'proposal'), false);
    assert.equal(api.progress(id), 'stopped');
  } finally { api.dispose(); }
});

test('stopping playback cancels future events, including pending questions and approvals', async () => {
  for (let index = 0; index < 3; index++) {
    const { api, send, drain, tasks } = setup();
    try {
      const scenario = SCENARIOS[index];
      if (index === 0) await api.startTurn(scenario.threadId, scenario.prompt);
      else await send(index);
      await api.cancel(scenario.threadId);
      const before = await api.eventsTail(scenario.threadId);
      drain();
      assert.deepEqual(await api.eventsTail(scenario.threadId), before);
      assert.equal(tasks.size, 0);
      assert.equal(buildTimeline(before).awaitingApproval, false);
      assert.equal(api.progress(scenario.threadId), 'stopped');
    } finally { api.dispose(); }
  }
});

test('reopening a thread replays only events after its cursor; abort and dispose release streams', async () => {
  const { api, send } = setup();
  const id = await send(0);
  const events = await api.eventsTail(id);
  const ctrl = new AbortController();
  const received: StoredEvent[] = [];
  const pending = api.stream<StoredEvent>(`/api/threads/${id}/stream?after=3`, e => received.push(e), ctrl.signal);
  assert.deepEqual(received, events.filter(e => e.seq > 3));
  ctrl.abort();
  await pending;
  const global = api.stream('/api/stream', () => {}, new AbortController().signal);
  api.dispose();
  await global;
});

test('only preset messages are accepted, instances are isolated, and the original demo stays read-only', async () => {
  const { api, send } = setup();
  const second = setup();
  try {
    await assert.rejects(api.startTurn(SCENARIOS[0].threadId, 'arbitrary prompt'), DemoError);
    await assert.rejects(api.createThread({ agent: 'codex', cwd: '/example' }), DemoError);
    await assert.rejects(api.addHost('example'), DemoError);
    await assert.rejects(api.uploadVideo(SCENARIOS[0].threadId, {} as File), DemoError);
    await send(0);
    assert.equal(second.api.progress(SCENARIOS[0].threadId), 'ready');
    assert.equal((await second.api.eventsTail(SCENARIOS[0].threadId)).length, 1);
    await assert.rejects(new DemoApi().startTurn(SCENARIOS[0].threadId, SCENARIOS[0].prompt), DemoError);
  } finally { api.dispose(); second.api.dispose(); }
});
