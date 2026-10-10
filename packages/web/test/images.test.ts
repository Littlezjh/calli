import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithin } from '../src/images.js';

test('pictures within the limit keep their size', () => {
  assert.deepEqual(fitWithin(800, 600, 2048), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(2048, 2048, 2048), { width: 2048, height: 2048 });
});

test('larger pictures are scaled so the longest edge meets the limit, keeping their shape', () => {
  assert.deepEqual(fitWithin(4096, 2048, 2048), { width: 2048, height: 1024 });
  assert.deepEqual(fitWithin(3024, 4032, 2048), { width: 1536, height: 2048 });
});

test('a very thin picture never gets a zero edge', () => {
  assert.deepEqual(fitWithin(10000, 2, 2048), { width: 2048, height: 1 });
});
