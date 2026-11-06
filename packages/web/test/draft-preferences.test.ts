import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchDraftModelPreference } from '../src/draft-preferences.js';

test('new-thread model preferences are remembered separately per agent', () => {
  const first = switchDraftModelPreference(
    {},
    'agent-a',
    { model: 'opus', effort: 'high', speed: 'priority' },
    'agent-b',
  );
  assert.deepEqual(first.preference, { model: null, effort: null, speed: null });
  assert.deepEqual(first.preferences, {
    'agent-a': { model: 'opus', effort: 'high', speed: 'priority' },
  });

  const second = switchDraftModelPreference(
    first.preferences,
    'agent-b',
    { model: 'sonnet', effort: 'medium', speed: null },
    'agent-a',
  );
  assert.deepEqual(second.preference, { model: 'opus', effort: 'high', speed: 'priority' });
  assert.deepEqual(second.preferences, {
    'agent-a': { model: 'opus', effort: 'high', speed: 'priority' },
    'agent-b': { model: 'sonnet', effort: 'medium', speed: null },
  });
});

test('switching to no agent clears the active draft without forgetting the previous agent', () => {
  const result = switchDraftModelPreference(
    {},
    'agent-a',
    { model: 'opus', effort: 'high', speed: null },
    '',
  );
  assert.deepEqual(result.preference, { model: null, effort: null, speed: null });
  assert.deepEqual(result.preferences, {
    'agent-a': { model: 'opus', effort: 'high', speed: null },
  });
});
