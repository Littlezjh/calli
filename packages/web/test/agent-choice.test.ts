import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAgentChoice, parseAgentChoices } from '../src/agent-choice.js';

test('nothing saved, or something unreadable, gives no remembered choices', () => {
  assert.deepEqual(parseAgentChoices(null), {});
  assert.deepEqual(parseAgentChoices('not json'), {});
  assert.deepEqual(parseAgentChoices('[]'), {});
  assert.deepEqual(parseAgentChoices('{"codex":"claude-4"}'), {});
});

test('a saved choice is read back, and empty parts are dropped', () => {
  assert.deepEqual(parseAgentChoices('{"codex":{"model":"gpt-6","effort":"high"}}'), { codex: { model: 'gpt-6', effort: 'high' } });
  assert.deepEqual(parseAgentChoices('{"codex":{"model":"","effort":"high","speed":5}}'), { codex: { effort: 'high' } });
});

test('a change merges, and emptying a part releases it to the default', () => {
  let all = parseAgentChoices('{"codex":{"model":"gpt-6","effort":"high"}}');
  all = mergeAgentChoice(all, 'codex', { effort: 'medium' });
  assert.deepEqual(all, { codex: { model: 'gpt-6', effort: 'medium' } });
  all = mergeAgentChoice(all, 'codex', { model: null });
  assert.deepEqual(all, { codex: { effort: 'medium' } });
  all = mergeAgentChoice(all, 'codex', { effort: null });
  assert.deepEqual(all, {});
  all = mergeAgentChoice(all, 'pi', { model: 'default' });
  assert.deepEqual(all, { pi: { model: 'default' } });
});
