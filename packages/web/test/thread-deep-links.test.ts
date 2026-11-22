import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isThreadLinkQuery, parseThreadLink, threadDeepLink, threadLinkCandidates, threadLinkHash } from '../src/thread-deep-links';

const deployment = 'https://calli.example/app/?token=secret#/settings';
const uuid = '123e4567-e89b-42d3-a456-426614174000';

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

// Repair only temporary UUID candidates, including prose and common copy/paste artifacts.
test('UUID candidates tolerate attached prose, wrapping and copy artifacts', () => {
  const local = threadDeepLink(uuid, null, deployment);
  const hash = threadLinkHash(uuid, null);
  const encoded = [...uuid].map(char => `%${char.charCodeAt(0).toString(16)}`).join('');
  for (const [label, body, expected] of [
    ['attached Chinese', `${local}对这个增加配置，保留正文`, local],
    ['attached Japanese', `${hash}を参照してください`, hash],
    ['attached Korean', `${hash}를참고해주세요`, hash],
    ['Chinese prefix and suffix', `请看${local}并修改`, local],
    ['space', `${local} Please keep my words.`, local],
    ['newline', `${local}\n继续说明`, local],
    ['nonbreaking space', `${local} 继续说明`, local],
    ['ideographic space', `${local}　继续说明`, local],
    ['Markdown', `Read [this](${local}), please.`, local],
    ['smart quotes', `“${local}”`, local],
    ['colon', `${local}: next step`, local],
    ['em dash', `${local}—继续说明`, local],
    ['ellipsis', `${local}…继续说明`, local],
    ['backticks', `\`${hash}\``, hash],
    ['uppercase UUID', local.replace(uuid, uuid.toUpperCase()), local],
    ['zero-width space', local.replace(uuid, `${uuid.slice(0, 8)}\u{200B}${uuid.slice(8)}`), local],
    ['word joiner', local.replace(uuid, `${uuid.slice(0, 18)}\u{2060}${uuid.slice(18)}`), local],
    ['soft hyphen', local.replace(uuid, `${uuid.slice(0, 23)}\xAD${uuid.slice(23)}`), local],
    ['byte-order mark', local.replace(uuid, `${uuid.slice(0, 8)}\u{FEFF}${uuid.slice(8)}`), local],
    ['copy artifacts before prose', `${local}\u{200B}继续说明`, local],
    ['nonbreaking hyphens', local.replace(uuid, uuid.replace(/-/g, '‑')), local],
    ['fullwidth hyphens', local.replace(uuid, uuid.replace(/-/g, '－')), local],
    ['encoded UUID', local.replace(uuid, encoded), local],
    ['encoded copy artifacts', local.replace(uuid, encodeURIComponent(`${uuid.slice(0, 8)}\u{200B}${uuid.slice(8)}`)), local],
    ['encoded prose', `${local}${encodeURIComponent('继续说明')}`, local],
  ]) {
    assert.deepEqual(threadLinkCandidates(body), [expected], label);
    assert.deepEqual(parseThreadLink(threadLinkCandidates(body)[0], deployment), { id: uuid, machine: null }, label);
  }
});

// Machine identity and old exact IDs must survive normalization without introducing search syntax.
test('UUID repair preserves query identity and leaves exact parsing and legacy IDs unchanged', () => {
  const remote = threadDeepLink(uuid, 'dev (東京)', deployment);
  assert.deepEqual(threadLinkCandidates(remote.replace(uuid, uuid.toUpperCase())), [remote]);
  assert.deepEqual(parseThreadLink(threadLinkCandidates(remote.replace(uuid, uuid.toUpperCase()))[0], deployment), { id: uuid, machine: 'dev (東京)' });
  const machine = `${threadLinkHash(uuid, null)}继续说明?machine=remote`;
  assert.deepEqual(parseThreadLink(threadLinkCandidates(machine)[0]), { id: uuid, machine: 'remote' });
  const ambiguous = `${threadLinkHash(uuid, null)}?machine=remote继续说明`;
  assert.deepEqual(parseThreadLink(threadLinkCandidates(ambiguous)[0]), { id: uuid, machine: 'remote继续说明' });
  const colonMachine = `${threadLinkHash(uuid, null)}?machine=dev:`;
  assert.deepEqual(parseThreadLink(threadLinkCandidates(colonMachine)[0]), { id: uuid, machine: 'dev:' });
  const preview = `${threadLinkHash(uuid.toUpperCase(), null)}?preview=%2Fresult.html`;
  assert.deepEqual(threadLinkCandidates(preview), [`${threadLinkHash(uuid, null)}?preview=%2Fresult.html`]);
  assert.equal(parseThreadLink(`${remote} keywords`, deployment), null);
  assert.deepEqual(parseThreadLink(`${threadLinkHash(uuid, null)}继续说明`), { id: `${uuid}继续说明`, machine: null }, 'search/navigation never discard keywords');
  for (const id of ['source', 'old', '東京', 'so\u{200B}urce']) {
    const link = threadDeepLink(id, null, deployment);
    assert.deepEqual(threadLinkCandidates(link), [link]);
    assert.deepEqual(threadLinkCandidates(`${link}\u{FEFF}继续说明`), [link], 'legacy BOM separators keep their original meaning');
    assert.equal(parseThreadLink(link, deployment)?.id, id);
  }
});

// A complete UUID is not permission to guess a truncated ID, foreign link or hidden URI segment.
test('UUID repair does not reinterpret malformed identities or ordinary UUID text', () => {
  const local = threadDeepLink(uuid, null, deployment);
  for (const suffix of ['a', 'g', '-extra', '/extra', '%2Fextra', '%23fragment', '%3Fmachine=remote']) {
    const candidate = `${local}${suffix}`;
    assert.deepEqual(threadLinkCandidates(candidate), [candidate]);
    assert.notEqual(parseThreadLink(candidate, deployment)?.id, uuid, suffix);
  }
  const short = local.slice(0, -1);
  assert.deepEqual(threadLinkCandidates(short), [short]);
  assert.notEqual(parseThreadLink(short, deployment)?.id, uuid);
  for (const candidate of [
    local.replace('/app/', '/other/'), local.replace('calli.example', 'foreign.example'),
    local.replace('https://', 'https://user:secret@'), `${local}%ZZ`,
    `${local}?machine=%ZZ`, `${local}?machine=a&machine=b`,
  ]) assert.equal(parseThreadLink(threadLinkCandidates(`${candidate}继续说明`)[0], deployment), null, candidate);
  assert.deepEqual(threadLinkCandidates(`Ordinary ID ${uuid}; https://calli.example/app/files/${uuid}; ftp://calli.example/app/#/thread/${uuid}`), []);
});

// Only a matching outer wrapper may be removed; smart quotes within queries are identity characters.
test('smart quote wrappers never truncate machine values', () => {
  for (const [body, expected, machine] of [
    [`#/thread/${uuid}?machine=“remote”`, `#/thread/${uuid}?machine=“remote”`, '“remote”'],
    [`#/thread/${uuid}?machine=remote”`, `#/thread/${uuid}?machine=remote”`, 'remote”'],
    [`“#/thread/${uuid}?machine=remote”`, `#/thread/${uuid}?machine=remote`, 'remote'],
    [`‘#/thread/${uuid}?machine=remote’`, `#/thread/${uuid}?machine=remote`, 'remote'],
    [`“#/thread/${uuid}?machine=“remote””`, `#/thread/${uuid}?machine=“remote”`, '“remote”'],
    [`“https://calli.example/app/#/thread/${uuid}?machine=remote”`, `https://calli.example/app/#/thread/${uuid}?machine=remote`, 'remote'],
    ['#/thread/source?machine=“remote”', '#/thread/source?machine=“remote”', '“remote”'],
  ]) {
    assert.deepEqual(threadLinkCandidates(body), [expected], body);
    assert.equal(parseThreadLink(expected, deployment)?.machine, machine, body);
  }
});

// Embedded BOMs repair a complete copied UUID, but actual separators must not swallow later links.
test('BOM-separated links are all retained after embedded UUID repair', () => {
  const first = threadLinkHash(uuid, null);
  const copied = threadLinkHash(uuid, null).replace(uuid, `${uuid.slice(0, 8)}\u{FEFF}${uuid.slice(8)}`);
  const other = '#/thread/other?machine=remote';
  for (const [body, expected] of [
    [`${first}\u{FEFF}${other}`, [first, other]],
    [`x${first}\u{FEFF}${other}`, [other]],
    [`ftp://foreign.example/${copied}\u{FEFF}${other}`, [other]],
    [`${copied}\u{FEFF}${other}`, [first, other]],
    [`${first}\u{FEFF}?machine=remote`, [`${first}?machine=remote`]],
    [`${copied}\u{FEFF}?machine=remote`, [`${first}?machine=remote`]],
    [`${copied}\u{FEFF}?machine=remote\u{FEFF}${other}`, [`${first}?machine=remote`, other]],
    [`https://docs.example/\u{FEFF}${first}`, [first]],
    [`${copied.replace(/-/g, '‑').toUpperCase().replace('#/THREAD/', '#/thread/')}\u{FEFF}请看${other}`, [first, other]],
    [`“${copied}”\u{FEFF}${other}`, [first, other]],
    [`#/thread/source\u{FEFF}${other}`, ['#/thread/source', other]],
    [`${first}?machine=remote\u{FEFF}${other}`, [`${first}?machine=remote`, other]],
  ] as const) assert.deepEqual(threadLinkCandidates(body), expected, body);
});

// Detaching prose must not erase syntax that makes the original candidate invalid.
test('CJK suffix repair retains forbidden paths fragments queries and controls', () => {
  for (const suffix of [
    '继续/extra', '继续%2Fextra', '继续\\extra', '继续%3Fmachine=remote',
    '继续%23fragment', '继续#fragment', '继续%00', '继续%0Aextra',
    '以及https://foreign.example/app/#/thread/other', '以及#/thread/other?machine=remote',
  ]) {
    const candidate = `#/thread/${uuid}${suffix}`;
    assert.deepEqual(threadLinkCandidates(candidate), [candidate], suffix);
    assert.equal(parseThreadLink(threadLinkCandidates(candidate)[0], deployment), null, suffix);
  }
});
