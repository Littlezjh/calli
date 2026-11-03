import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('signals deduplicate, persist updated destinations, query matters and prune after ninety days', () => {
  const directory = mkdtempSync(join(tmpdir(), 'calli-signals-'));
  let store = new Store(directory);
  try {
    const now = new Date('2026-11-01T00:00:00.000Z');
    const boundary = new Date(now.getTime() - 90 * 86400000).toISOString();
    const payload = { summary: '请看材料', source: { type: 'lark-message', ref: 'om_first' } };
    assert.equal(store.insertSignal('lark-message:om_first', payload, { outcome: 'router', pending: true }, boundary), true);
    assert.equal(store.insertSignal('lark-message:om_first', { different: true }, { outcome: 'filtered' }), false);
    store.updateSignalDisposition('lark-message:om_first', { outcome: 'delivered', threadId: 'worker', matterIds: ['one', 'two'] }, now.toISOString());
    assert.deepEqual(store.getSignal('lark-message:om_first')?.payload, payload);
    assert.equal(store.listSignals().length, 1);
    assert.equal(store.listSignals({ pending: true }).length, 0);
    assert.equal(store.listSignals({ matterId: 'two' })[0].disposition.outcome, 'delivered');
    assert.deepEqual(store.listSignals({ matterId: 'absent' }), []);
    store.insertSignal('old', {}, { outcome: 'filtered', reason: 'outside-watch-scope' }, new Date(Date.parse(boundary) - 1).toISOString());
    store.close(); store = new Store(directory);
    assert.equal(store.getSignal('lark-message:om_first')?.updatedAt, now.toISOString());
    store.pruneSignals(now);
    assert.equal(store.getSignal('old'), null);
    assert.equal(store.listSignals().length, 1, 'exact ninety-day boundary remains');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
