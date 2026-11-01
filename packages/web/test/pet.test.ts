import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPetStarter, clearPetHaze, nextPetFrame, petCacheKey, petCacheName, petErrorDetail, petReplyParts, petRing, parsePetPending, petDay, petGreetingLine, petReplyPreview, PET_GIVE_UP_MS, PET_QUIET_POLLS, readPetRouter, yawnDelay } from '../src/pet.js';

test('a looping clip wraps and a one-shot clip ends', () => {
  assert.equal(nextPetFrame(0, 121, true), 1);
  assert.equal(nextPetFrame(120, 121, true), 0);
  assert.equal(nextPetFrame(119, 121, false), 120);
  assert.equal(nextPetFrame(120, 121, false), null);
});

test('only the frames just ahead stay decoded', () => {
  assert.deepEqual(petRing(0, 121, true, 4), [0, 1, 2, 3]);
  assert.deepEqual(petRing(119, 121, true, 4), [119, 120, 0, 1]);
  assert.deepEqual(petRing(119, 121, false, 4), [119, 120]);
  assert.deepEqual(petRing(0, 1, true, 8), [0]);
});

test('cleaned frames are filed under the artwork they came from', () => {
  assert.match(petCacheName('dafeiyu'), /dafeiyu-[0-9a-f]{40}/);
  assert.equal(petCacheKey('idle', 7), '/calli-pet-frames/idle/7.webp');
});

test('she yawns between 40 and 80 seconds', () => {
  assert.equal(yawnDelay(() => 0), 40_000);
  assert.equal(yawnDelay(() => 1), 80_000);
});

test('the day turns over at local midnight', () => {
  assert.equal(petDay(new Date(2026, 9, 31, 23, 59)), '2026-10-31');
  assert.equal(petDay(new Date(2026, 10, 1, 0, 1)), '2026-11-01');
});

test('the greeting names what is most urgent, and is light when nothing is', () => {
  const now = new Date(2026, 9, 31);
  const busy = petGreetingLine({ you: 3, first: 'OKR 自评' }, now);
  assert.match(busy, /3/);
  assert.match(busy, /OKR 自评/);
  const calm = petGreetingLine({ you: 0, first: null }, now);
  assert.ok(calm.length > 0);
  assert.doesNotMatch(calm, /0/);
  assert.doesNotMatch(petGreetingLine({ you: 2, first: null }, now), /null/);
});

test('an opening goes in front of the words and replaces another opening', () => {
  const starts = ['记一下：', '这件最急：'];
  assert.equal(applyPetStarter('', '记一下：', starts), '记一下：');
  assert.equal(applyPetStarter('买票', '记一下：', starts), '记一下：买票');
  assert.equal(applyPetStarter('记一下：买票', '这件最急：', starts), '这件最急：买票');
});

test('a message in flight survives a reload until it is too old to wait for', () => {
  const sentAt = 1_000;
  const raw = JSON.stringify({ since: 'a', threadId: 't', sentAt, text: '买票' });
  assert.deepEqual(parsePetPending(raw, sentAt + 1), { since: 'a', threadId: 't', sentAt, text: '买票' });
  assert.equal(parsePetPending(raw, sentAt + PET_GIVE_UP_MS + 1), null);
  assert.equal(parsePetPending('not json', 0), null);
  assert.equal(parsePetPending('{"since":null}', 0), null);
  assert.equal(parsePetPending(null, 0), null);
});

test('only a reply newer than the message answers it', () => {
  const router = { threadId: 't', status: 'idle', lastReply: '记下了', lastReplyAt: '2026-10-31T10:00:00.000Z' };
  assert.deepEqual(readPetRouter(router, null, 1), { reply: '记下了' });
  assert.deepEqual(readPetRouter(router, '2026-10-31T09:59:59.000Z', 1), { reply: '记下了' });
  assert.equal(readPetRouter(router, '2026-10-31T10:00:00.000Z', 1), 'waiting');
  assert.equal(readPetRouter({ ...router, status: 'running' }, router.lastReplyAt, 99), 'waiting');
  assert.equal(readPetRouter({ ...router, status: 'error' }, router.lastReplyAt, 1), 'failed');
  assert.equal(readPetRouter(router, router.lastReplyAt, PET_QUIET_POLLS), 'quiet');
  assert.equal(readPetRouter({ ...router, lastReply: null, lastReplyAt: null }, null, 1), 'waiting');
});

test('the sheet of near-invisible pixels goes and everything else stays', () => {
  const pixels = new Uint8ClampedArray([0, 0, 0, 1, 0, 0, 0, 3, 9, 9, 9, 4, 9, 9, 9, 255]);
  clearPetHaze(pixels);
  assert.deepEqual([...pixels], [0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 4, 9, 9, 9, 255]);
});

test('details leave addresses out', () => {
  assert.equal(petErrorDetail(new Error('pet download failed: 502 https://raw.example.test/a/b.webp')), 'pet download failed: 502');
  assert.equal(petErrorDetail(new Error('https://raw.example.test/a')), null);
  assert.equal(petErrorDetail('hub down'), 'hub down');
  assert.equal(petErrorDetail(null), null);
});

test('a reply is split around the matters it names', () => {
  const todos = [{ id: 'a', text: 'OKR' }, { id: 'b', text: 'OKR 自评' }, { id: 'c', text: '买' }];
  assert.deepEqual(petReplyParts('记下了「OKR 自评」，还有买票', todos), [
    { text: '记下了「' }, { text: 'OKR 自评', todoId: 'b' }, { text: '」，还有买票' },
  ]);
  assert.deepEqual(petReplyParts('没提到', todos), [{ text: '没提到' }]);
  assert.deepEqual(petReplyParts('OKR', todos), [{ text: 'OKR', todoId: 'a' }]);
});

test('reply previews are at most 100 characters and preserve Unicode', () => {
  assert.equal(petReplyPreview('  已记下  '), '已记下');
  const reply = petReplyPreview('🐟'.repeat(101));
  assert.equal(Array.from(reply).length, 100);
  assert.equal(reply, '🐟'.repeat(99) + '…');
  assert.equal(petReplyPreview('a'.repeat(100)), 'a'.repeat(100));
});
