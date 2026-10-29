import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { saveToken, type Thread } from '../src/api.js';
import { cachedThreads, clearThreadCache, rememberThreads } from '../src/thread-cache.js';

function storage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } });
  t.after(() => {
    clearThreadCache();
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return data;
}

const thread = (id: string, minute: number) => ({ id, title: id, updatedAt: `2026-10-21T05:${String(minute).padStart(2, '0')}:00.000Z` }) as Thread;

test('each machine keeps its own last list, in memory whole and in storage the most recent', t => {
  const data = storage(t);
  assert.equal(cachedThreads(null), null, 'a machine never read has no list, not an empty one');
  rememberThreads(null, [thread('a', 1)], '2026-10-21T05:01:00Z');
  rememberThreads('devbox', [], '2026-10-21T05:02:00Z');
  assert.deepEqual(cachedThreads(null)?.threads.map(x => x.id), ['a']);
  assert.deepEqual(cachedThreads('devbox')?.threads, [], 'read and empty is remembered as empty');
  const many = Array.from({ length: 250 }, (_, i) => thread(`t${i}`, i % 60));
  rememberThreads('big', many, '2026-10-21T05:03:00Z');
  assert.equal(cachedThreads('big')?.threads.length, 250, 'this page keeps the whole list');
  const saved = JSON.parse(data.get('calli.threads.v1')!);
  assert.equal(saved.big.threads.length, 200, 'storage keeps the most recent');
  assert.ok(saved.big.threads.every((x: Thread) => x.updatedAt >= '2026-10-21T05:10'));
});

test('a list survives a reload, and another hub or signing out clears it', t => {
  storage(t);
  saveToken('first');
  rememberThreads(null, [thread('a', 1)], '2026-10-21T05:01:00Z');
  localStorage.setItem('calli.threads.v1', localStorage.getItem('calli.threads.v1')!);
  assert.deepEqual(cachedThreads(null)?.threads.map(x => x.id), ['a']);
  saveToken('second');
  assert.equal(cachedThreads(null), null);
  localStorage.setItem('calli.threads.v1', 'not json');
  assert.equal(cachedThreads(null), null, 'a broken store reads as nothing');
});
