import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Api, coordinationSettings, type Coordination, type Thread } from '../src/api.js';
import { CollaborationMenu, collaborationMembers } from '../src/components/CollaborationMenu.js';
import * as collaboration from '../src/components/CollaborationMenu.js';

const team = (over: Partial<Coordination> = {}): Coordination => ({ rootId: 'root', paused: false, directories: [], agents: ['helper'], members: [], messages: [], ...over });
const member = (over: Partial<Coordination['members'][number]> = {}): Coordination['members'][number] => ({ id: 'member', name: 'Helper', thread: null, latest: null, ...over });
const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id, title: id, agent: 'helper', cwd: '/project', cwdReal: '/project', status: 'idle', preview: null,
  agentSessionId: 'session', pinned: false, permissionMode: 'auto_edit', model: null, effort: null, archivedAt: null,
  sectionId: null, forkedFrom: null, unread: false, terminalActivity: false, waiting: false, queued: [], resumeCommand: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...over,
});

// Eligibility changes patch the exact thread; false is an explicit update, not a toggle.
test('thread API preserves the exact session target and disabled boolean', async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  class RecordingApi extends Api {
    protected override async send<T>(method: string, url: string, body?: unknown): Promise<T> {
      calls.push({ method, url, body });
      return thread(url.split('/').at(-1)!, body as { disabled: boolean }) as T;
    }
  }
  const api = new RecordingApi('');
  assert.equal((await api.updateThread('member-one', { disabled: true })).disabled, true);
  assert.equal((await api.updateThread('member-two', { disabled: false })).disabled, false);
  assert.deepEqual(calls, [
    { method: 'PATCH', url: '/api/threads/member-one', body: { disabled: true } },
    { method: 'PATCH', url: '/api/threads/member-two', body: { disabled: false } },
  ]);
});

// Only a true thread flag excludes a member; missing thread state remains old-daemon compatible.
test('member candidates filter thread eligibility and return plain mentions', () => {
  const view = team({ members: [
    member({ id: 'legacy' }),
    member({ id: 'missing', thread: thread('missing') }),
    member({ id: 'enabled', thread: thread('enabled', { disabled: false }) }),
    member({ id: 'disabled', thread: thread('disabled', { disabled: true }) }),
  ] });
  assert.deepEqual(collaborationMembers(view), ['legacy', 'missing', 'enabled'].map(id => ({ id, label: 'Helper', kind: 'member' })));
  assert.deepEqual(collaborationMembers(team()), []);
});

// Two sessions of one instance have independent eligibility, without changing the source snapshot.
test('one disabled session does not exclude its sibling or mutate collaboration history', () => {
  const latest: Coordination['messages'][number] = { id: 'result', from: 'one', to: 'root', text: 'task', kind: 'result', state: 'told', result: 'kept answer', createdAt: '2026-01-01T00:00:00Z', turnId: 'turn' };
  const view = team({ members: [
    member({ id: 'one', thread: thread('one', { disabled: true }), latest }),
    member({ id: 'two', thread: thread('two', { disabled: false }) }),
  ], messages: [latest] });
  const snapshot = structuredClone(view);
  assert.deepEqual(collaborationMembers(view), [{ id: 'two', label: 'Helper', kind: 'member' }]);
  assert.deepEqual(view, snapshot);
  const enabled = team({ ...view, members: view.members.map(m => m.id === 'one' ? { ...m, thread: { ...m.thread!, disabled: false } } : m) });
  assert.deepEqual(collaborationMembers(enabled).map(mention => mention.id), ['one', 'two']);
  assert.deepEqual(enabled.messages, snapshot.messages);
  assert.deepEqual(enabled.members[0].latest, latest);
});

// Old instance/member layers cannot exclude candidates or override the sole thread flag.
test('legacy two-level fields do not contribute to member eligibility', () => {
  const members: Array<Coordination['members'][number] & { disabled: boolean; effectiveDisabled: boolean; agentRef: string }> = [
    { ...member({ id: 'legacy', thread: thread('legacy') }), disabled: true, effectiveDisabled: true, agentRef: 'helper' },
    { ...member({ id: 'enabled', thread: thread('enabled', { disabled: false }) }), disabled: true, effectiveDisabled: true, agentRef: 'helper' },
    { ...member({ id: 'disabled', thread: thread('disabled', { disabled: true }) }), disabled: false, effectiveDisabled: false, agentRef: 'other' },
  ];
  const view = { ...team({ members }), disabledAgents: ['helper'] };
  assert.deepEqual(collaborationMembers(view), [
    { id: 'legacy', label: 'Helper', kind: 'member' },
    { id: 'enabled', label: 'Helper', kind: 'member' },
  ]);
});

// Recovery actions belong only to the thread menu, not collaboration selection helpers.
test('retired object policy helpers are no longer exported', () => {
  for (const name of ['CollaborationObjectRow', 'collaborationObjectActions', 'selectableCollaborators', 'withDraftDisabledAgents']) {
    assert.equal(name in collaboration, false, `${name} must not expose an old object policy entry point`);
  }
});

// Root settings are authoritative, including empty values; device preferences only supply absent fields.
test('saved-only activation retains root policy and falls back only for missing fields', () => {
  const fallback = { directories: ['/device'], defaults: { helper: { model: 'device', effort: null } }, permission: 'full_access' };
  const saved = team({ enabled: false, directories: ['/saved'], defaults: { helper: { model: 'saved', effort: 'low', permission: 'read_only' } }, permission: 'read_only' });
  assert.deepEqual(coordinationSettings(saved, fallback), { directories: saved.directories, defaults: saved.defaults, permission: 'read_only' });
  assert.deepEqual(coordinationSettings(team({ defaults: {}, permission: '' }), fallback), { directories: [], defaults: {}, permission: '' });
  assert.deepEqual(coordinationSettings(team(), fallback), { ...fallback, directories: [] });
  assert.deepEqual(coordinationSettings(null, fallback), fallback);
});

// Excluding an existing session leaves its ordinary instance candidate available for a new session.
test('collaboration selection keeps instance candidates without object actions or input locks', () => {
  const options = [
    { id: 'helper', label: 'Helper instance', kind: 'agent' as const, disabled: true, offline: true },
    ...collaborationMembers(team({ members: [
      member({ id: 'disabled-session', name: 'Disabled session', thread: thread('disabled-session', { disabled: true }) }),
      member({ id: 'available-session', name: 'Available session', thread: thread('available-session') }),
    ] })),
  ];
  const html = renderToStaticMarkup(createElement(CollaborationMenu, {
    options, selected: [options[0]], icon: () => undefined, onSelect: () => {}, settings: null, unavailable: 'No candidates',
  }));
  assert.match(html, /Helper instance/);
  assert.match(html, /Available session/);
  assert.match(html, /role="menuitem"/);
  assert.doesNotMatch(html, /Disabled session|coord-object-actions|collaboration-disabled-marker|data-object-kind/);
  assert.doesNotMatch(html, /(?:aria-)?disabled="(?:true|)"|oncontextmenu/i);
});
