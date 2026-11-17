import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReferences, resolveThreadLinkReferences, splitReferences, ThreadLinkReferenceError, withReferences, type ContextReference } from '../src/context-references';
import { readDrafts, writeDraft } from '../src/drafts';
import { threadDeepLink, threadLinkHash } from '../src/thread-deep-links';

const deployment = 'https://calli.example/app/?token=not-copied#/thread/recipient';
const threadReference = (sourceId: string, id = `snapshot-${sourceId}`, snapshotSeq = 10): ContextReference => ({
  id, kind: 'thread', sourceId, snapshotSeq, title: sourceId, path: '/project', at: '2026-11-17T00:00:00Z',
});
const failure = (reason: ThreadLinkReferenceError['reason']) => (error: unknown) => error instanceof ThreadLinkReferenceError && error.reason === reason;

test('send resolution preserves the original URL and body while deduplicating links and selected snapshots', async () => {
  // A link is additional context, never a replacement for the user's words or an updated snapshot.
  const selected = threadReference('selected', 'old-selection', 3);
  const folder: ContextReference = { id: 'folder', kind: 'directory', title: 'project', path: '/project', at: selected.at };
  const message: ContextReference = { ...selected, id: 'message', kind: 'message', turnId: 'turn' };
  const link = threadDeepLink('source', null, deployment);
  const body = `Compare [this conversation](${link}), ${link} and ${threadLinkHash('selected', null)}.\nKeep this sentence.`;
  const created: string[] = [];
  const resolved = await resolveThreadLinkReferences({ body, references: [selected, folder, message], deployment,
    source: { host: null, createReference: async input => { created.push(input.sourceId); return threadReference(input.sourceId); } },
  });
  assert.deepEqual(created, ['source']);
  assert.deepEqual(resolved.slice(0, 3), [selected, folder, message]);
  assert.equal(resolved.length, 4);
  assert.deepEqual(splitReferences(withReferences(resolved, body)), { references: resolved, body });
  assert.deepEqual(mergeReferences([selected], [threadReference('selected', 'new-selection', 100)]), [selected]);
});

test('ordinary external URLs and quoted assistant text are not resolved implicitly', async () => {
  // The caller passes only the explicit user body, not quotes, scheduler text or assistant content.
  let creates = 0;
  const resolved = await resolveThreadLinkReferences({ body: 'Read https://docs.example/guide and ftp://other/#/thread/not-local.', deployment,
    source: { host: null, createReference: async input => { creates++; return threadReference(input.sourceId); } },
  });
  assert.deepEqual(resolved, []);
  assert.equal(creates, 0);
});

test('all invalid, foreign and cross-machine links fail before creating any reference', async () => {
  // Validation covers the entire message first, so an earlier valid link cannot cause partial work.
  let creates = 0;
  const source = { host: null, createReference: async (input: { kind: 'thread'; sourceId: string }) => { creates++; return threadReference(input.sourceId); } };
  for (const body of [
    '#/thread/ok #/thread/%ZZ', '#/thread/ok #/thread/',
    '#/thread/ok https://foreign.example/app/#/thread/source',
    '#/thread/ok https://calli.example/other/#/thread/source',
  ]) await assert.rejects(resolveThreadLinkReferences({ body, deployment, source }), failure('invalid'));
  await assert.rejects(resolveThreadLinkReferences({ body: '#/thread/ok #/thread/source?machine=remote', deployment, source }), failure('remote'));
  assert.equal(creates, 0);
});

test('the recipient API host determines machine identity and missing sources fail explicitly', async () => {
  // Null means the main Hub; a remote composer cannot reinterpret a main-Hub hash as local.
  const body = threadDeepLink('source', 'remote', deployment);
  const resolved = await resolveThreadLinkReferences({ body, deployment,
    source: { host: 'remote', createReference: async input => threadReference(input.sourceId) },
  });
  assert.equal(resolved[0].sourceId, 'source');
  await assert.rejects(resolveThreadLinkReferences({ body: '#/thread/source', deployment,
    source: { host: 'remote', createReference: async input => threadReference(input.sourceId) },
  }), failure('remote'));
  await assert.rejects(resolveThreadLinkReferences({ body: '#/thread/source', deployment, references: [threadReference('source')] }), failure('unavailable'));
});

test('the twelve-reference limit counts unique targets before any create request', async () => {
  // Repeated links and an already selected target take no extra slots, even with different snapshot IDs.
  const references = Array.from({ length: 11 }, (_, index) => threadReference(`selected-${index}`));
  let creates = 0;
  const source = { host: null, createReference: async (input: { kind: 'thread'; sourceId: string }) => { creates++; return threadReference(input.sourceId); } };
  await assert.rejects(resolveThreadLinkReferences({ body: '#/thread/one #/thread/two #/thread/one', references, deployment, source }), failure('limit'));
  assert.equal(creates, 0);
  const resolved = await resolveThreadLinkReferences({ body: '#/thread/one #/thread/one #/thread/selected-0', references: [...references, threadReference('selected-0', 'duplicate')], deployment, source });
  assert.equal(resolved.length, 12);
  assert.equal(creates, 1);
  assert.equal(resolved[0].id, 'snapshot-selected-0');
});

test('partial lookup failures persist completed snapshots through reload and reuse them on retry', async () => {
  // Creating metadata grants nothing; completed snapshots still belong to the original retryable draft.
  let value = '{}';
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
  const body = '#/thread/first #/thread/second';
  const capturedKey = 'original-thread';
  writeDraft(storage, capturedKey, { text: body, notes: [] });
  writeDraft(storage, 'switched-thread', { text: 'A different draft', notes: [] });
  const creates: string[] = [];
  await assert.rejects(resolveThreadLinkReferences({ body, deployment,
    source: { host: null, createReference: async input => {
      creates.push(input.sourceId);
      if (input.sourceId === 'second') throw new Error('source unavailable');
      return threadReference(input.sourceId, 'frozen-first', 4);
    } },
    onResolved: references => writeDraft(storage, capturedKey, { text: body, notes: [], references }),
  }), failure('unavailable'));
  const reloaded = readDrafts(storage);
  assert.equal(reloaded['switched-thread'].text, 'A different draft');
  assert.equal(reloaded['switched-thread'].references, undefined);
  assert.equal(reloaded[capturedKey].references?.[0].snapshotSeq, 4);
  const resolved = await resolveThreadLinkReferences({ body: reloaded[capturedKey].text, references: reloaded[capturedKey].references, deployment,
    source: { host: null, createReference: async input => { creates.push(input.sourceId); return threadReference(input.sourceId, `new-${input.sourceId}`, 100); } },
  });
  assert.deepEqual(creates, ['first', 'second', 'second']);
  assert.equal(resolved[0].id, 'frozen-first');
  assert.equal(resolved[0].snapshotSeq, 4);
  assert.deepEqual(splitReferences(withReferences(resolved, body)), { body, references: resolved });
});

test('editing never snapshots or retains the same thread that is about to rewrite its history', async () => {
  // Reject the whole edit before creating other snapshots or allowing destructive native history edits.
  let creates = 0;
  const source = { host: null, createReference: async (input: { kind: 'thread'; sourceId: string }) => { creates++; return threadReference(input.sourceId); } };
  for (const body of ['#/thread/edited', '#/thread/other #/thread/edited']) {
    await assert.rejects(resolveThreadLinkReferences({ body, deployment, source, editingThreadId: 'edited' }), failure('editing'));
  }
  await assert.rejects(resolveThreadLinkReferences({ body: 'Keep this message', references: [threadReference('edited')], deployment, source, editingThreadId: 'edited' }), failure('editing'));
  assert.equal(creates, 0);
  const resolved = await resolveThreadLinkReferences({ body: '#/thread/other', deployment, source, editingThreadId: 'edited' });
  assert.equal(resolved[0].sourceId, 'other');
  // Ordinary new turns may still refer to their own fixed snapshot; only rewrites are unsafe.
  const own = await resolveThreadLinkReferences({ body: '#/thread/edited', deployment, source });
  assert.equal(own[0].sourceId, 'edited');
});

test('deleted or mismatched sources fail without pretending they were read', async () => {
  // The existing authenticated createReference operation is the only resolver, with no arbitrary fetch.
  await assert.rejects(resolveThreadLinkReferences({ body: '#/thread/missing', deployment,
    source: { host: null, createReference: async () => { throw new Error('not found'); } },
  }), failure('unavailable'));
  await assert.rejects(resolveThreadLinkReferences({ body: '#/thread/wanted', deployment,
    source: { host: null, createReference: async () => threadReference('different') },
  }), failure('unavailable'));
});
