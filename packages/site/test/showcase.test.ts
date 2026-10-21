import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShowcaseApi, HandoverShowcaseApi } from '../src/ShowcaseApi';
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

test('collaboration delegates to two members, returns readable results and stops without late replies', async () => {
  const { api, drain, tasks } = setup();
  try {
    const scene = SCENARIOS.find(s => s.id === 'collaboration')!;
    await api.startTurn(scene.threadId, scene.prompt);
    drain();
    const team = await api.coordination(scene.threadId);
    assert.equal(team?.members.length, 2);
    assert.ok(team!.members.every(m => m.latest?.state === 'returned' && m.latest.result && m.thread?.status === 'idle'));
    for (const member of team!.members) {
      const timeline = buildTimeline(await api.eventsTail(member.id));
      assert.equal(timeline.running, false);
      assert.ok(timeline.items.some(i => i.kind === 'assistant'));
    }
    assert.match((await api.eventsTail(scene.threadId)).map(e => e.data.text ?? '').join(''), /协作结果/);
    assert.equal(api.progress(scene.threadId), 'completed');
    assert.equal(tasks.size, 0);
  } finally { api.dispose(); }
  const second = setup();
  try {
    const scene = SCENARIOS.find(s => s.id === 'collaboration')!;
    await second.api.startTurn(scene.threadId, scene.prompt);
    for (let i = 0; i < 2; i++) {
      const next = second.tasks.values().next().value!;
      second.tasks.delete(next); next();
    }
    assert.ok((await second.api.coordination(scene.threadId))?.members.every(m => m.thread?.status === 'running'));
    await second.api.cancel(scene.threadId);
    second.drain();
    assert.ok((await second.api.coordination(scene.threadId))?.members.every(m => m.latest?.state === 'stopped' && m.thread?.status === 'idle'));
    assert.equal(second.tasks.size, 0);
  } finally { second.api.dispose(); }
});

test('board acceptance and memory reads use isolated sample data, without network calls', async () => {
  const api = new ShowcaseApi();
  const other = new ShowcaseApi();
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No network allowed'); };
  try {
    assert.ok((await api.extensions()).filter(e => ['board', 'memory'].includes(e.manifest.id)).every(e => e.installed && e.enabled));
    assert.equal((await api.thread('showcase-review')).doneAt, null);
    await api.updateThread('showcase-review', { done: true });
    assert.ok((await api.thread('showcase-review')).doneAt);
    assert.equal((await other.thread('showcase-review')).doneAt, null);
    await api.updateThread('showcase-review', { done: false });
    assert.equal((await api.thread('showcase-review')).doneAt, null);
    const [source] = await api.memorySources('memory');
    const index = await api.memoryList('memory', source.id);
    assert.equal(index.state, 'available');
    assert.equal(index.files.length, 3);
    const document = await api.memoryRead('memory', source.id, index.files[0].id);
    assert.match(document.text, /虚构记忆/);
    await assert.rejects(api.memoryRead('memory', source.id, '../private'), DemoError);
    await assert.rejects(api.memoryList('memory', 'unknown'), DemoError);
    assert.deepEqual(await new DemoApi().coordination('demo-dark-mode'), null);
  } finally { globalThis.fetch = fetch; api.dispose(); other.dispose(); }
});

function handoverSetup() {
  const tasks = new Set<() => void>();
  const api = new HandoverShowcaseApi(run => { tasks.add(run); return () => { tasks.delete(run); }; });
  const tick = () => { const task = tasks.values().next().value!; assert.ok(task); tasks.delete(task); task(); };
  return { api, tasks, tick };
}

for (const branch of ['account', 'model'] as const) test(`handover ${branch} finishes a turn, waits, then continues locally`, async () => {
  const { api, tick, tasks } = handoverSetup();
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No network allowed'); };
  try {
    api.reset(branch); api.start();
    const sourceId = api.snapshot().source.id;
    assert.equal(api.snapshot().phase, 'finishing');
    tick();
    assert.ok(api.snapshot().sourceEvents.some(e => e.type === 'turn.done'));
    if (branch === 'account') {
      assert.equal(api.snapshot().phase, 'preparing');
      assert.equal((await api.historySummary(sourceId, 'sample-summary')).text, '');
      tick();
      assert.match((await api.historySummary(sourceId, 'sample-summary')).text, /虚构/);
      const items = buildTimeline(api.snapshot().sourceEvents).items;
      assert.equal(items.filter(i => i.kind === 'handover-summary').length, 1);
    }
    assert.equal(api.snapshot().phase, 'countdown');
    assert.ok(Date.parse(api.snapshot().current.autoHandover!.deadline!) - Date.now() > 4500);
    tick();
    const state = api.snapshot();
    assert.equal(state.phase, 'completed');
    assert.equal(state.current.id === sourceId, branch === 'model');
    assert.equal(Boolean(state.current.handover), branch === 'account');
    assert.equal(state.nextEvents.some(e => e.type === 'handover.model'), branch === 'model');
    assert.ok(buildTimeline(state.nextEvents).items.some(i => i.kind === 'assistant'));
    assert.equal(tasks.size, 0);
  } finally { globalThis.fetch = fetch; api.dispose(); }
});

for (const phase of ['preparing', 'countdown']) test(`cancel handover during ${phase}, reset and dispose clear every timer`, async () => {
  const { api, tick, tasks } = handoverSetup();
  try {
    api.start(); tick();
    if (phase === 'countdown') tick();
    await api.cancelAutoHandover(api.snapshot().current.id);
    assert.equal(api.snapshot().phase, 'cancelled');
    assert.equal(api.snapshot().current.id, api.snapshot().source.id);
    assert.equal(tasks.size, 0);
    assert.equal(api.snapshot().nextEvents.length, 0);
    if (phase === 'preparing') assert.equal((await api.historySummary(api.snapshot().source.id, 'sample-summary')).text, '');
    api.reset(); api.start(); api.reset('model');
    assert.equal(tasks.size, 0);
    assert.equal(api.snapshot().sourceEvents.length, 0);
    api.start(); api.dispose();
    assert.equal(tasks.size, 0);
  } finally { api.dispose(); }
});

test('changing branch during countdown cannot deliver a stale account handover', () => {
  const { api, tick, tasks } = handoverSetup();
  try {
    api.start(); tick(); tick();
    assert.equal(api.snapshot().phase, 'countdown');
    api.reset('model');
    assert.equal(tasks.size, 0);
    api.start(); tick(); tick();
    assert.equal(api.snapshot().phase, 'completed');
    assert.equal(api.snapshot().current.model, 'Sonnet');
    assert.equal(api.snapshot().current.handover, undefined);
  } finally { api.dispose(); }
});
