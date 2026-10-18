import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../daemon/src/store';
import { buildTimeline, type Item } from '../src/timeline';
import { mergeHistory } from '../src/history';
import type { EventType } from '../../daemon/src/events';

const visible = (items: Item[]) => items.map(i => i.kind === 'work' ? { kind: i.kind, key: i.key, count: i.count ?? i.steps.length, done: i.done, stopped: i.stopped, startedAt: i.startedAt, endedAt: i.endedAt }
  : i.kind === 'changes' ? { kind: i.kind, added: i.added, removed: i.removed, files: i.files.map(f => ({ path: f.path, added: f.added, removed: f.removed })) } : i);

test('projected completed histories have the same visible answers, boundaries, status and file counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rah-view-'));
  const store = new Store(dir);
  store.createThread({ id: 'th', agent: 'pi', cwd: dir, title: 'test', permissionMode: 'default', model: null, effort: null });
  const add = (turn: string, type: EventType, data: Record<string, unknown>) => store.appendEvent('th', turn, type, data);
  try {
    for (const ending of ['turn.done', 'turn.error', 'cancelled'] as const) {
      add(ending, 'turn.started', { text: 'question' });
      add(ending, 'message.delta', { text: 'commentary' });
      add(ending, 'reasoning.delta', { text: 'thought 1' });
      add(ending, 'reasoning.delta', { text: 'thought 2' });
      add(ending, 'tool.start', { id: 'a', title: 'edit', kind: 'edit' });
      add(ending, 'plan.delta', { id: 'proposal', text: 'draft plan' });
      add(ending, 'reasoning.delta', { text: 'check plan' });
      add(ending, 'plan.completed', { id: 'proposal', text: 'final plan' });
      add(ending, 'input.request', { inputId: ending, title: 'ask', questions: [] });
      add(ending, 'input.resolved', { inputId: ending, answer: { answers: {} } });
      add(ending, 'message.delta', { text: 'comment 2' });
      add(ending, 'tool.start', { id: 'b', title: 'run', kind: 'execute' });
      add(ending, 'tool.end', { id: 'a', status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: 'a\n', newText: 'b\nc\n' }] });
      add(ending, 'tool.end', { id: 'b', status: 'completed' });
      add(ending, 'message.delta', { text: 'final answer' });
      add(ending, ending === 'turn.error' ? 'turn.error' : 'turn.done', ending === 'cancelled' ? { stopReason: 'cancelled' } : { message: 'failure' });
    }
    const raw = buildTimeline(store.listEvents('th'));
    const page = await store.history.page('th');
    const light = buildTimeline(page.events);
    assert.deepEqual(visible(light.items), visible(raw.items));
    const backlog = await store.history.since('th', 0);
    const restored = mergeHistory([], [{ threadId: 'th', turnId: null, type: 'history.reset', seq: backlog.snapshotSeq, ts: '', data: backlog }]);
    assert.deepEqual(visible(buildTimeline(restored).items), visible(raw.items));
    for (const work of page.events.filter(e => e.type === 'history.work')) {
      const detail = buildTimeline((await store.history.work('th', work.turnId!, work.seq)).events);
      const loaded = detail.items.find(i => i.kind === 'work');
      const original = raw.items.find(i => i.kind === 'work' && i.key === `e${work.seq}`);
      assert.equal(loaded?.kind === 'work' && loaded.steps.length, original?.kind === 'work' && original.steps.length);
    }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('reconnect replaces existing turns without deleting earlier pages or a newer live event', () => {
  const event = (seq: number, turnId: string) => ({ seq, turnId, threadId: 'th', ts: '', type: 'message.delta', data: { text: String(seq) } });
  const events = [event(1,'old'), event(4,'a'), event(8,'new')];
  const reset = { ...event(7,''), type: 'history.reset', data: { turns: ['a'], events: [event(2,'a'),event(7,'a')] } };
  assert.deepEqual(mergeHistory(events,[reset]).map(e => e.seq), [1,2,7,8]);
});
