import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { AgyAdapter, cloneAgySession } from '../src/adapters/agy.js';
import type { EmittedEvent } from '../src/events.js';
import type { TurnHooks } from '../src/adapters/types.js';
const fixture = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));

test('agy ACP: settings and compact stay in one process, queries do not enter the conversation, old IDs resume', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agy-acp-'));
  const log = join(cwd, 'rpc.jsonl');
  const adapter = new AgyAdapter([process.execPath, fixture], { FAKE_AGY_RPC_LOG: log });
  const events: EmittedEvent[] = [];
  let approvals = 0;
  const hooks: TurnHooks = { emit: e => events.push(e), requestApproval: async () => { approvals++; return { optionId: 'allow' }; } };
  const s = await adapter.start({ cwd, resumeId: 'old-conversation', model: 'fast', effort: 'low' });
  const prompt = (text: string) => s.prompt({ text, images: [] }, hooks);
  try {
    assert.equal(adapter.capabilities.compact, true);
    await prompt('hello');
    await s.setModel!('big-thinking');
    await s.setEffort!('high');
    await s.setPermissionMode!('ask');
    await prompt('run a command');
    assert.equal(approvals, 1);
    await s.setPermissionMode!('full_access');
    await prompt('run a command');
    assert.equal(approvals, 1, 'full access grants the offered allow option without asking again');
    await s.setWorkMode!('plan');
    await prompt('plan-draft');
    assert.ok(events.some(e => e.type === 'plan.completed'));
    await s.setWorkMode!('execute');
    await prompt('/usage');
    events.length = 0;
    await prompt('/compact');
    assert.deepEqual(events.map(e => e.type), ['tool.start', 'usage.updated', 'tool.end']);
    assert.equal(events[2].data.status, 'completed');
    assert.equal(events[1].data.used, 250);
    events.length = 0;
    await prompt('usage-drop');
    assert.ok(!events.some(e => e.type === 'context.compaction'), 'a decline is not an automatic compaction signal');
    events.length = 0;
    assert.equal((await prompt('/compact fail')).stopReason, 'error');
    assert.equal(events.at(-1)?.data.status, 'failed');
    events.length = 0;
    const pending = prompt('/compact slow');
    await s.waitForSubmission!();
    await s.cancel();
    assert.equal((await pending).stopReason, 'cancelled');
    assert.equal(events.at(-1)?.data.status, 'failed');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(new Set(calls.map(c => c.pid)).size, 1);
    assert.ok(calls.some(c => c.method === 'session/resume' && c.params.sessionId === 'old-conversation'));
    assert.ok(!calls.some(c => c.method === 'session/new'));
    assert.ok(!calls.some(c => c.method === 'session/prompt' && c.params.prompt.some((p: any) => p.text === '/usage')));
    assert.deepEqual(calls.filter(c => c.method === 'session/set_config_option').map(c => [c.params.configId, c.params.value]),
      [['model', 'fast'], ['thought_level', 'low'], ['model', 'big-thinking'], ['thought_level', 'high']]);
  } finally { await s.close(); rmSync(cwd, { recursive: true, force: true }); }
});

test('agy ACP: autonomous background turns without cost settle once quiet, but never while a tool is running', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agy-bg-'));
  const adapter = new AgyAdapter([process.execPath, fixture], { CALLI_ACP_BACKGROUND_IDLE_MS: '60' });
  const events: EmittedEvent[] = [];
  const bgEvents: EmittedEvent[] = [];
  const started: string[] = [];
  const finished: Array<{ id: string; stopReason: string }> = [];
  const hooks: TurnHooks = { emit: e => events.push(e), requestApproval: async () => ({ optionId: 'allow' }) };
  const waitFor = async (check: () => boolean, timeout = 3000) => {
    const end = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out waiting for background turn');
      await new Promise(r => setTimeout(r, 15));
    }
  };
  const s = await adapter.start({ cwd });
  s.setSessionHooks?.({
    turnStarted: (id) => {
      started.push(id);
      return { emit: e => bgEvents.push(e), requestApproval: async () => ({ optionId: 'allow' }) };
    },
    turnFinished: (id, result) => { finished.push({ id, stopReason: result.stopReason }); },
  });
  try {
    // 1. Stray uncosted agent_message_chunk (e.g. quota warning) settles instead of hanging forever.
    const r1 = await s.prompt({ text: 'background-notice', images: [] }, hooks);
    assert.equal(r1.stopReason, 'end_turn');
    await waitFor(() => finished.length === 1);
    assert.equal(started.length, 1);
    assert.equal(finished[0].stopReason, 'end_turn');
    assert.ok(bgEvents.some(e => e.type === 'message.delta' && String(e.data.text).includes('quota reached')));

    // 2. A background tool lasting longer than backgroundIdleMs (120ms > 60ms) stays open until done.
    bgEvents.length = 0;
    const r2 = await s.prompt({ text: 'background-tool', images: [] }, hooks);
    assert.equal(r2.stopReason, 'end_turn');
    await waitFor(() => bgEvents.some(e => e.type === 'tool.start'));
    await new Promise(r => setTimeout(r, 85));
    assert.equal(finished.length, 1, 'must not finish while background tool is still in_progress');
    await waitFor(() => finished.length === 2);
    assert.equal(finished[1].stopReason, 'end_turn');
    assert.ok(bgEvents.some(e => e.type === 'tool.end' && e.data.status === 'completed'));
    assert.ok(bgEvents.some(e => e.type === 'message.delta' && e.data.text === 'background work done'));
  } finally {
    await s.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('agy fork: clones SQLite DB (WAL + protobuf BLOB UUIDs), brain and annotations, and rejects per-turn fork', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-fork-'));
  const agyHome = join(root, 'agy-home');
  const srcId = '11111111-2222-4333-8444-555555555555';
  const srcTraj = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  try {
    mkdirSync(join(agyHome, 'conversations'), { recursive: true });
    mkdirSync(join(agyHome, 'brain', srcId, 'scratch'), { recursive: true });
    mkdirSync(join(agyHome, 'annotations'), { recursive: true });
    writeFileSync(join(agyHome, 'brain', srcId, 'scratch', 'note.txt'), 'kept');
    writeFileSync(join(agyHome, 'annotations', `${srcId}.pbtxt`), 'title:"Original"\n');

    const srcDbPath = join(agyHome, 'conversations', `${srcId}.db`);
    const db = new DatabaseSync(srcDbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)');
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB, step_payload BLOB)');
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)').run(srcTraj, srcId);
    const metaBlob = Buffer.concat([Buffer.from([0x0a, 0x24]), Buffer.from(srcId, 'utf8'), Buffer.from([0x12, 0x24]), Buffer.from(srcTraj, 'utf8')]);
    const payloadBlob = Buffer.from(`prefix-${srcId}-mid-${srcTraj}-suffix`, 'utf8');
    db.prepare('INSERT INTO steps VALUES (0, ?, ?)').run(metaBlob, payloadBlob);
    // Keep WAL active without closing before snapshot to verify VACUUM INTO sees WAL writes.
    const adapter = new AgyAdapter([process.execPath, fixture], { CALLI_AGY_HOME: agyHome });
    assert.equal(adapter.capabilities.fork, true);
    assert.equal(adapter.capabilities.forkInto, true);
    assert.equal(adapter.capabilities.forkAt, false);

    const copyId = await adapter.forkSession(srcId, root);
    db.close();
    assert.notEqual(copyId, srcId);
    assert.match(copyId, /^[0-9a-f-]{36}$/i);
    assert.equal(readFileSync(join(agyHome, 'brain', copyId, 'scratch', 'note.txt'), 'utf8'), 'kept');
    assert.equal(readFileSync(join(agyHome, 'annotations', `${copyId}.pbtxt`), 'utf8'), 'title:"Original"\n');

    const copyDb = new DatabaseSync(join(agyHome, 'conversations', `${copyId}.db`), { readOnly: true });
    try {
      const meta = copyDb.prepare('SELECT trajectory_id, cascade_id FROM trajectory_meta').get() as { trajectory_id: string; cascade_id: string };
      assert.equal(meta.cascade_id, copyId);
      assert.notEqual(meta.trajectory_id, srcTraj);
      assert.match(meta.trajectory_id, /^[0-9a-f-]{36}$/i);
      const step = copyDb.prepare('SELECT metadata, step_payload FROM steps WHERE idx = 0').get() as { metadata: Uint8Array; step_payload: Uint8Array };
      const copyMetaBuf = Buffer.from(step.metadata);
      assert.equal(copyMetaBuf.length, metaBlob.length, 'protobuf BLOB byte length must stay identical');
      assert.ok(copyMetaBuf.includes(Buffer.from(copyId, 'utf8')));
      assert.ok(copyMetaBuf.includes(Buffer.from(meta.trajectory_id, 'utf8')));
      assert.ok(!copyMetaBuf.includes(Buffer.from(srcId, 'utf8')));
      const copyPayloadStr = Buffer.from(step.step_payload).toString('utf8');
      assert.equal(copyPayloadStr, `prefix-${copyId}-mid-${meta.trajectory_id}-suffix`);
    } finally { copyDb.close(); }

    // Source DB remains untouched.
    const srcCheck = new DatabaseSync(srcDbPath, { readOnly: true });
    try {
      const orig = srcCheck.prepare('SELECT cascade_id FROM trajectory_meta').get() as { cascade_id: string };
      assert.equal(orig.cascade_id, srcId);
    } finally { srcCheck.close(); }

    await assert.rejects(adapter.forkSession(srcId, root, 'some-turn'), /only copy a whole conversation/);
    await assert.rejects(cloneAgySession(agyHome, 'missing-session', 'target-session'), /was not found/);
    assert.equal(existsSync(join(agyHome, 'conversations', 'target-session.db')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agy full_access auto-approves permission prompts in both foreground and autonomous background turns, while auto_edit asks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agy-bg-approval-'));
  const adapter = new AgyAdapter([process.execPath, fixture], { CALLI_ACP_BACKGROUND_IDLE_MS: '60' });
  const bgEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const bgApprovals: string[] = [];
  const finished: Array<{ id: string; stopReason: string }> = [];
  const s = await adapter.start({ cwd, permissionMode: 'full_access' });
  try {
    s.setSessionHooks({
      turnStarted: () => ({
        emit: ev => { bgEvents.push(ev as { type: string; data: Record<string, unknown> }); },
        requestApproval: async req => { bgApprovals.push(req.title); return { optionId: 'reject' }; },
      }),
      turnFinished: (id, res) => { finished.push({ id, stopReason: res.stopReason }); },
    });

    const r1 = await s.prompt(
      { text: 'background-approval', images: [] },
      { emit: () => {}, requestApproval: async () => { throw new Error('should not ask user in full_access'); } },
    );
    assert.equal(r1.stopReason, 'end_turn');
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (finished.length === 1) return resolve();
        if (Date.now() > deadline) return reject(new Error('timed out waiting for background approval turn'));
        setTimeout(check, 25);
      };
      check();
    });
    assert.deepEqual(bgApprovals, [], 'full_access must auto-approve background permission requests without prompting');
    assert.ok(bgEvents.some(e => e.type === 'message.delta' && e.data.text === 'background approved'));

    // Switching down to auto_edit forwards permission requests to the caller's approval hook.
    await s.setPermissionMode!('auto_edit');
    let asked = 0;
    const r2 = await s.prompt(
      { text: 'run a command', images: [] },
      { emit: () => {}, requestApproval: async () => { asked++; return { optionId: 'allow' }; } },
    );
    assert.equal(r2.stopReason, 'end_turn');
    assert.equal(asked, 1, 'auto_edit still asks for approval');
  } finally {
    await s.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
