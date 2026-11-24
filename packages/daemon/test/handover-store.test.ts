import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

test('legacy handovers recover only from explicit local first-turn coordinates and survive source deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-handover-store-'));
  let store = new Store(root);
  try {
    const create = (id: string, cwd = '/project') => store.createThread({ id, cwd, agent: 'test', title: 'Same title', permissionMode: 'auto_edit', model: null, effort: null });
    create('source');
    const envelope = '# 交接信息\n\n- Hub 线程 ID：source\n\n## 接手要求\nContinue';
    for (const [id, text, cwd] of [
      ['valid', '来源机器：本机（当前 hub）\n\n' + envelope, '/project'],
      ['remote', '来源机器：开发机\n\n' + envelope, '/project'],
      ['quoted', 'Here is an example:\n' + envelope, '/project'],
      ['other-dir', envelope, '/other'],
      ['later', 'ordinary request', '/project'],
    ]) {
      create(id, cwd);
      store.appendEvent(id, 'one', 'turn.started', { text });
    }
    store.appendEvent('later', 'two', 'turn.started', { text: envelope });
    store.close();
    const db = new DatabaseSync(join(root, 'hub.db'));
    db.exec("UPDATE threads SET created_at = '2020-01-01' WHERE id = 'source'; ALTER TABLE threads DROP COLUMN handover;");
    db.close();
    store = new Store(root);
    assert.deepEqual(store.getThread('valid')?.handover, { sourceId: 'source', title: 'Same title', agent: 'test' });
    for (const id of ['remote', 'quoted', 'other-dir', 'later']) assert.equal(store.getThread(id)?.handover, null);
    store.deleteThread('source');
    store.close();
    store = new Store(root);
    assert.equal(store.getThread('valid')?.handover?.title, 'Same title');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('lastContextUsed reads the newest reported context, and null when none was reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-context-used-'));
  const store = new Store(root);
  try {
    store.createThread({ id: 't', cwd: '/project', agent: 'test', title: 't', permissionMode: 'auto_edit', model: null, effort: null });
    assert.equal(store.lastContextUsed('t'), null);
    store.appendEvent('t', 'one', 'usage.updated', { used: 126_000, size: 200_000 });
    store.appendEvent('t', 'one', 'usage.updated', { used: null, size: 200_000 });
    assert.equal(store.lastContextUsed('t'), null);
    store.appendEvent('t', 'two', 'usage.updated', { used: 30_000, size: 200_000 });
    assert.equal(store.lastContextUsed('t'), 30_000);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

// Collaboration switches persist as booleans without changing activity, history or sibling threads.
test('thread disabled state defaults to false and persists both toggles without other side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-thread-disabled-'));
  let store = new Store(root);
  try {
    const thread = store.createThread({ id: 't', cwd: '/project', agent: 'test', title: 't', permissionMode: 'auto_edit', model: null, effort: null });
    store.createThread({ ...thread, id: 'sibling' });
    assert.equal(thread.disabled, false);
    assert.equal(store.getThread('t')?.disabled, false);
    assert.equal(store.listThreads().find(t => t.id === 't')?.disabled, false);
    assert.equal(store.db.prepare('SELECT disabled FROM threads WHERE id = ?').get('t')?.disabled, 0);
    store.updateThread('t', { agentSessionId: 'session', status: 'running', pinned: true, unread: true });
    store.appendEvent('t', 'one', 'turn.started', { text: 'Keep this conversation' });
    store.appendEvent('t', 'one', 'message.delta', { text: 'Still working' });
    const before = store.getThread('t')!;
    const events = store.listEvents('t');

    store.updateThread('t', { disabled: true });
    assert.deepEqual(store.getThread('t'), { ...before, disabled: true });
    assert.equal(store.listThreads().find(t => t.id === 't')?.disabled, true);
    assert.equal(store.findThreadByAgentSession('test', 'session')?.disabled, true);
    assert.equal(store.db.prepare('SELECT disabled FROM threads WHERE id = ?').get('t')?.disabled, 1);
    assert.equal(store.getThread('sibling')?.disabled, false);
    assert.deepEqual(store.listEvents('t'), events);

    store.close();
    store = new Store(root);
    assert.deepEqual(store.getThread('t'), { ...before, disabled: true });
    store.updateThread('t', { title: 'Renamed' });
    assert.equal(store.getThread('t')?.disabled, true);
    store.updateThread('t', { disabled: false });
    assert.deepEqual(store.getThread('t'), { ...before, title: 'Renamed', disabled: false });
    assert.equal(store.db.prepare('SELECT disabled FROM threads WHERE id = ?').get('t')?.disabled, 0);
    store.close();
    store = new Store(root);
    assert.deepEqual(store.getThread('t'), { ...before, title: 'Renamed', disabled: false });
    assert.deepEqual(store.listEvents('t'), events);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

// Copying a disabled source's settings and history never copies its collaboration switch.
test('new forks and handovers stay enabled even when their source is disabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-fork-disabled-'));
  const store = new Store(root);
  try {
    store.createThread({ id: 'source', cwd: '/project', agent: 'test', title: 'Source', permissionMode: 'auto_edit', model: null, effort: null });
    store.updateThread('source', { disabled: true });
    store.appendEvent('source', 'one', 'turn.started', { text: 'Source history' });
    const source = store.getThread('source')!;
    const fork = store.createThread({ ...source, id: 'fork', forkedFrom: source.id });
    const handover = store.createThread({ ...source, id: 'handover', handover: { sourceId: source.id, title: source.title, agent: source.agent } });
    store.copyEvents(source.id, fork.id);
    assert.equal(fork.disabled, false);
    assert.equal(fork.forkedFrom, source.id);
    assert.equal(store.getThread(fork.id)?.disabled, false);
    assert.equal(handover.disabled, false);
    assert.equal(handover.handover?.sourceId, source.id);
    assert.equal(store.getThread(source.id)?.disabled, true);
    assert.equal(store.listEvents(fork.id)[0]?.data.text, 'Source history');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

// Old databases gain one independent switch; legacy policies and stopped/suppressed/told history stay intact.
test('disabled migration is idempotent and does not import old coordination policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-disabled-migration-'));
  let store = new Store(root);
  try {
    for (const id of ['root', 'member', 'sibling']) {
      store.createThread({ id, cwd: '/project', agent: 'test', title: id, permissionMode: 'auto_edit', model: null, effort: null });
    }
    const legacy = JSON.stringify({
      rootId: 'root', enabled: false, paused: false, directories: ['/project'], agents: ['test'], disabledAgents: ['test'],
      members: [{ id: 'member', name: 'Member', agentRef: 'test', disabled: true }],
      deliveries: [
        { id: 'stopped', from: 'root', to: 'member', text: 'Keep stopped work', state: 'stopped' },
        { id: 'suppressed', from: 'member', to: 'root', text: 'Keep result', result: 'Withheld result', state: 'returned', suppressed: true },
      ],
      direct: [{ id: 'told', to: 'member', text: 'Manual chat', result: 'Already read', state: 'returned', told: true }],
    });
    store.coordinationRecords();
    store.saveCoordination('root', legacy);
    const records = store.coordinationRecords();
    store.appendEvent('member', 'one', 'turn.started', { text: 'Keep member history' });
    store.appendEvent('member', 'one', 'message.delta', { text: 'Keep member result' });
    store.appendEvent('member', 'one', 'turn.done', { stopReason: 'end_turn' });
    const events = store.listEvents('member');
    store.db.exec('ALTER TABLE threads DROP COLUMN disabled');
    store.close();

    store = new Store(root);
    const columns = store.db.prepare('PRAGMA table_info(threads)').all().filter(c => c.name === 'disabled');
    assert.equal(columns.length, 1);
    assert.equal(columns[0]?.notnull, 1);
    assert.equal(columns[0]?.dflt_value, '0');
    for (const id of ['root', 'member', 'sibling']) assert.equal(store.getThread(id)?.disabled, false);
    assert.deepEqual(store.coordinationRecords(), records);
    assert.deepEqual(store.listEvents('member'), events);
    store.updateThread('member', { disabled: true });
    store.close();
    store = new Store(root);
    assert.equal(store.db.prepare('PRAGMA table_info(threads)').all().filter(c => c.name === 'disabled').length, 1);
    assert.equal(store.getThread('member')?.disabled, true);
    assert.equal(store.getThread('root')?.disabled, false);
    assert.equal(store.getThread('sibling')?.disabled, false);
    assert.deepEqual(store.coordinationRecords(), records);
    assert.deepEqual(store.listEvents('member'), events);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
