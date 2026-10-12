import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFTS_KEY, MAX_DRAFTS, readDrafts, writeDraft } from '../src/drafts.js';

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

test('a draft is kept per thread and forgotten once emptied', () => {
  const s = memory();
  writeDraft(s, 't1', { text: 'half a thought', notes: [] }, 1);
  writeDraft(s, 't2', { text: '', notes: [{ quote: 'quoted', comment: '' }, { quote: 'two', comment: 'why?' }] }, 2);
  assert.deepEqual(readDrafts(s), {
    t1: { text: 'half a thought', notes: [], at: 1 },
    t2: { text: '', notes: [{ quote: 'quoted', comment: '' }, { quote: 'two', comment: 'why?' }], at: 2 },
  });
  writeDraft(s, 't1', { text: '   ', notes: [] });
  writeDraft(s, 't2', null);
  assert.deepEqual(readDrafts(s), {});
});

test('only the most recent drafts are kept', () => {
  const s = memory();
  for (let i = 0; i < MAX_DRAFTS + 5; i++) writeDraft(s, `t${i}`, { text: 'x', notes: [] }, i);
  const kept = readDrafts(s);
  assert.equal(Object.keys(kept).length, MAX_DRAFTS);
  assert.ok(!('t0' in kept) && `t${MAX_DRAFTS + 4}` in kept, 'the oldest make room');
});

test('a broken or foreign value reads as no drafts', () => {
  assert.deepEqual(readDrafts(memory({ [DRAFTS_KEY]: 'not json' })), {});
  assert.deepEqual(readDrafts(memory({ [DRAFTS_KEY]: '[1,2]' })), {});
  assert.deepEqual(readDrafts(memory({ [DRAFTS_KEY]: '{"a":{"text":3},"b":{"text":"ok"}}' })), { b: { text: 'ok', notes: [], at: 0 } });
});

test('a draft saved with the older single quote comes back as one note', () => {
  const s = memory({ [DRAFTS_KEY]: JSON.stringify({ t: { text: 'and?', quote: 'passage', at: 3 }, u: { text: '', quote: null, at: 4 } }) });
  assert.deepEqual(readDrafts(s), {
    t: { text: 'and?', notes: [{ quote: 'passage', comment: '' }], at: 3 },
    u: { text: '', notes: [], at: 4 },
  });
});
