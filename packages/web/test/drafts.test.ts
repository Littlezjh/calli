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

test('a draft on its way out says so, and stops saying so once it is saved as a plain draft again', () => {
  const storage = memory();
  const notes = [{ quote: 'the passage', comment: 'why' }];
  const sending = { text: '[注释 1]\n> the passage\n评论：why\n\nbody', after: 'turn-7' };
  writeDraft(storage, 't1', { text: 'body', notes, sending }, 1);
  assert.deepEqual(readDrafts(storage).t1.sending, sending);
  writeDraft(storage, 't1', { text: 'body, edited', notes }, 2);
  assert.equal('sending' in readDrafts(storage).t1, false);
  // A thread with no turn of the user's yet; and a mark that is not one.
  storage.setItem(DRAFTS_KEY, JSON.stringify({ t2: { text: 'x', notes: [], at: 1, sending: { text: 'x' } }, t3: { text: 'y', notes: [], at: 1, sending: 'y' } }));
  assert.deepEqual(readDrafts(storage).t2.sending, { text: 'x', after: null });
  assert.equal('sending' in readDrafts(storage).t3, false);
});

// Retired policy alone is not draft content; ordinary drafts keep their machine-scoped keys.
test('legacy disabled agents do not keep empty drafts or affect another machine', () => {
  const s = memory();
  const empty = { text: '', notes: [], disabledAgents: ['helper'] };
  const remote = { text: 'remote words', notes: [], disabledAgents: ['helper@other'] };
  writeDraft(s, 'new', empty, 1);
  writeDraft(s, 'host:remote:new', remote, 2);
  assert.equal(readDrafts(s).new, undefined);
  assert.deepEqual(readDrafts(s)['host:remote:new'], { text: 'remote words', notes: [], at: 2 });
  assert.equal(readDrafts(s)['host:unrelated:new'], undefined);
  writeDraft(s, 'new', { ...empty, text: '   ' }, 3);
  assert.equal(readDrafts(s).new, undefined);
  assert.equal('disabledAgents' in JSON.parse(s.data.get(DRAFTS_KEY)!)['host:remote:new'], false);
});

// Old policy values are ignored without erasing stored words, attachments, or pending-send state.
test('reading legacy drafts ignores disabled agents and preserves all ordinary draft fields', () => {
  const note = { quote: 'passage', comment: 'why?', file: 'a.md', source: { threadId: 't', turnId: 'turn' } };
  const reference = { id: 'folder', kind: 'directory' as const, title: 'Project', path: '/project', at: '2026-01-01T00:00:00Z' };
  const mention = { id: 'helper', label: 'Helper', kind: 'agent' as const, cwd: '/project', task: 'review' };
  const draft = { text: 'old words', notes: [note], references: [reference], mentions: [mention], sending: { text: 'outgoing words', after: 'turn' }, at: 7 };
  for (const disabledAgents of [['helper'], ['helper', '', null, 4, 'helper'], 'helper', null]) {
    const stored = JSON.stringify({ 'host:remote:new': { ...draft, disabledAgents }, empty: { text: '', notes: [], disabledAgents } });
    const s = memory({ [DRAFTS_KEY]: stored });
    assert.deepEqual(readDrafts(s), { 'host:remote:new': draft, empty: { text: '', notes: [], at: 0 } });
    assert.equal(s.data.get(DRAFTS_KEY), stored, 'reading must not rewrite or purge legacy storage');
    const legacy = { ...draft, disabledAgents };
    writeDraft(s, 'host:remote:new', legacy, 8);
    assert.deepEqual(readDrafts(s)['host:remote:new'], { ...draft, at: 8 });
    assert.equal(s.data.get(DRAFTS_KEY)!.includes('disabledAgents'), false);
  }
});

// First-send migration preserves useful content and only drops the retired policy field.
test('pending first messages migrate by machine key without carrying legacy disabled agents', () => {
  const other = { text: 'other machine', notes: [], at: 3 };
  const note = { quote: 'passage', comment: 'explain' };
  const reference = { id: 'folder', kind: 'directory' as const, title: 'Project', path: '/project', at: '2026-01-01T00:00:00Z' };
  const mention = { id: 'helper', label: 'Helper', kind: 'agent' as const };
  const draft = { text: 'first task', notes: [note], references: [reference], mentions: [mention], sending: { text: 'first task', after: null } };
  const s = memory({ [DRAFTS_KEY]: JSON.stringify({ 'host:remote:new': { ...draft, disabledAgents: ['helper'], at: 1 }, 'host:other:new': other }) });
  writeDraft(s, 'host:remote:root', readDrafts(s)['host:remote:new'], 2);
  writeDraft(s, 'host:remote:new', null);
  assert.deepEqual(readDrafts(s), { 'host:remote:root': { ...draft, at: 2 }, 'host:other:new': other });
  assert.equal(s.data.get(DRAFTS_KEY)!.includes('disabledAgents'), false);
});

test('a noted passage keeps its file and the conversation it came from', () => {
  const s = memory();
  const note = { quote: 'q', comment: '', file: 'a.md', source: { threadId: 'th', turnId: 'turn' } };
  writeDraft(s, 't1', { text: '', notes: [note] }, 1);
  assert.deepEqual(readDrafts(s).t1.notes, [note]);
});
