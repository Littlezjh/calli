import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyImage } from '../src/clipboard.js';

test('copyImage reports unavailable outside a browser image clipboard context', async () => {
  assert.equal(await copyImage('data:image/png;base64,'), 'unavailable');
});
