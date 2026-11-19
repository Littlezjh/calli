import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeForkPoints } from '../src/adapters/claude-history.js';

const lines = (...entries: Array<Record<string, unknown>>) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, parentUuid, message: { role: 'user', content }, ...extra });
const said = (uuid: string, parentUuid: string, id: string, ...content: Array<Record<string, unknown>>) => ({ type: 'assistant', uuid, parentUuid, message: { id, role: 'assistant', content } });
const text = (value: string) => ({ type: 'text', text: value });

test('claudeForkPoints: a turn is a user message, and a copy stops at the last thing said in it', () => {
  const points = claudeForkPoints(lines(
    user('u1', null, 'first'),
    said('a1', 'u1', 'msg_1', { type: 'thinking', thinking: 'hm' }),
    said('a2', 'u1', 'msg_1', { type: 'tool_use', id: 't1', name: 'Read', input: {} }),
    user('r1', 'a2', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    said('a3', 'r1', 'msg_2', text('done')),
    user('u2', 'a3', [text('second')]),
    said('a4', 'u2', 'msg_3', { type: 'tool_use', id: 't2', name: 'Read', input: {} }),
  ));
  // The second turn so far only called a tool: no place to stop yet.
  assert.deepEqual(points, [{ text: 'first', forkRef: 'msg_2' }, { text: 'second' }]);
});

test('claudeForkPoints: what the user did not say is no turn', () => {
  const points = claudeForkPoints(lines(
    user('u1', null, 'first'),
    said('a1', 'u1', 'msg_1', text('one')),
    user('m1', 'a1', [text('[Image: original 10x10]')], { isMeta: true }),
    user('n1', 'm1', '<task-notification>stopped</task-notification>', { origin: { kind: 'task-notification' } }),
    user('i1', 'n1', [text('[Request interrupted by user]')]),
    user('u2', 'i1', 'second'),
    said('a2', 'u2', 'msg_2', text('two')),
    // A scheduled prompt is delivered to the model like any other.
    user('u3', 'a2', 'third', { origin: { kind: 'task-notification', subkind: 'routine' } }),
    { type: 'user', uuid: 's1', parentUuid: 'a2', isSidechain: true, message: { role: 'user', content: 'a subagent task' } },
  ));
  assert.deepEqual(points.map((p) => p.text), ['first', 'second', 'third']);
});

test('claudeForkPoints: every turn is there after a compaction, even when its boundary names a message the file lacks', () => {
  const points = claudeForkPoints(lines(
    user('u1', null, 'before'),
    said('a1', 'u1', 'msg_1', text('answer')),
    { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'never-written' },
    user('s1', 'b1', 'This session is being continued from a previous conversation', { isCompactSummary: true }),
    user('u2', 's1', 'after'),
    said('a2', 'u2', 'msg_2', text('answer')),
  ));
  assert.deepEqual(points, [{ text: 'before', forkRef: 'msg_1' }, { text: 'after', forkRef: 'msg_2' }]);

  // When the boundary does name a message that is there, that is the one it followed.
  const named = claudeForkPoints(lines(
    user('u1', null, 'before'),
    said('a1', 'u1', 'msg_1', text('answer')),
    said('a1b', 'a1', 'msg_9', text('a branch the boundary does not follow')),
    { type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a1' },
    user('u2', 'b1', 'after'),
  ));
  assert.deepEqual(named.map((p) => p.text), ['before', 'after']);
  assert.equal(named[0].forkRef, 'msg_1');
});

test('claudeForkPoints: a branch that was rewound away is not part of the conversation', () => {
  const points = claudeForkPoints(lines(
    user('u1', null, 'first'),
    said('a1', 'u1', 'msg_1', text('one')),
    user('x1', 'a1', 'asked, then rewound'),
    said('x2', 'x1', 'msg_x', text('discarded')),
    user('u2', 'a1', 'asked again'),
    said('a2', 'u2', 'msg_2', text('two')),
  ));
  assert.deepEqual(points.map((p) => p.text), ['first', 'asked again']);
});

test('claudeForkPoints: damaged lines are skipped, and an empty file has no turns', () => {
  assert.deepEqual(claudeForkPoints(''), []);
  assert.deepEqual(claudeForkPoints('not json\n' + lines(user('u1', null, 'only'))), [{ text: 'only' }]);
});
