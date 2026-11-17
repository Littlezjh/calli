import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isThreadLinkQuery, parseThreadLink, threadDeepLink, threadLinkCandidates, threadLinkHash } from '../src/thread-deep-links';

const deployment = 'https://calli.example/app/?token=secret#/settings';

// Copied links identify a Calli thread and retain only the deployment path and machine.
test('deep links preserve deployment paths and machines without credentials', () => {
  const local = threadDeepLink('source', null, deployment);
  assert.equal(local, 'https://calli.example/app/#/thread/source');
  assert.deepEqual(parseThreadLink(local, deployment), { id: 'source', machine: null });
  const remote = threadDeepLink('source', 'dev (東京)', deployment);
  assert.equal(new URL(remote).search, '');
  assert.deepEqual(parseThreadLink(remote, deployment), { id: 'source', machine: 'dev (東京)' });
  assert.equal(threadLinkHash('source', 'dev box'), '#/thread/source?machine=dev%20box');
  assert.equal(new URL(threadDeepLink('source', null, 'https://user:pass@calli.example/app/?token=secret')).username, '');
  assert.equal(new URL(threadDeepLink('source', null, 'https://user:pass@calli.example/app/')).password, '');
});

// Existing hash/preview routes remain valid, but malformed or foreign identities never resolve locally.
test('deep-link parsing validates encoding, segments and deployment identity', () => {
  assert.deepEqual(parseThreadLink('#/thread/old?preview=%2Fresult.html'), { id: 'old', machine: null });
  for (const input of [
    '#/thread/', '#/thread/a/b', '#/thread/a%2Fb', '#/thread/%zz', '#/thread/%00',
    '#/thread/id?machine=%zz', '#/thread/id?machine=%E0%A4', '#/thread/id?machine=%00',
    '#/thread/id?machine=a&machine=b', '#/thread/id?machine=remote keywords',
    'https://calli.example/app/#/thread/id?machine=remote keywords', 'https://other.example/app/#/thread/id',
    'https://calli.example/other/#/thread/id', 'https://user:secret@calli.example/app/#/thread/id',
    'ftp://calli.example/app/#/thread/id', 'thread://source',
  ]) assert.equal(parseThreadLink(input, deployment), null, input);
  assert.equal(isThreadLinkQuery('#/thread/'), true);
  assert.equal(isThreadLinkQuery('https://other.example/#/thread/id'), true);
  assert.equal(isThreadLinkQuery('ordinary words'), false);
});

// User sentences and Markdown can contain links without granting access to URI fragments or unrelated websites.
test('link candidates retain exact links and deduplicate repeated mentions', () => {
  const local = threadDeepLink('source', null, deployment);
  const remote = threadDeepLink('other', 'dev (東京)', deployment);
  assert.deepEqual(threadLinkCandidates(`Read [this](${local}), then ${remote}. Again: ${local}`), [local, remote]);
  assert.deepEqual(threadLinkCandidates('Read #/thread/source, and #/thread/'), ['#/thread/source', '#/thread/']);
  assert.deepEqual(threadLinkCandidates('Read #/thread?machine=remote'), ['#/thread?machine=remote']);
  assert.deepEqual(threadLinkCandidates('https://example.com/a ftp://example.com/#/thread/source x#/thread/source'), []);
  assert.deepEqual(threadLinkCandidates('https://other.example/#/thread/source'), ['https://other.example/#/thread/source']);
  assert.deepEqual(threadLinkCandidates('"#/thread/source"'), ['#/thread/source']);
  assert.deepEqual(threadLinkCandidates("'#/thread/source'"), ['#/thread/source']);
  assert.deepEqual(threadLinkCandidates(`参考这个会话：${local}，以及#/thread/source。`), [local, '#/thread/source']);
  assert.deepEqual(threadLinkCandidates(`请看${local}`), [local]);
});
