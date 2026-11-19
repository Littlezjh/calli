import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAppServerAdapter } from '../src/adapters/codex.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { WorkerReports } from '../src/worker-reports.js';
import { Workdirs } from '../src/workdirs.js';

const settle = async (predicate: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('did not settle in time');
};

function rolloutFiles(codexHome: string): string[] {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'calli-session-reuse-'));
  const personalDir = join(dir, 'personal');
  const repoDir = join(dir, 'alpha-service');
  const codexHome = join(dir, 'codex-home');
  mkdirSync(personalDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const store = new Store(dir);
  const adapters = new Map<string, AgentAdapter>([
    ['pi', new PiRpcAdapter([process.execPath, resolve('test/fixtures/fake-pi.mjs')])],
    ['codex', new CodexAppServerAdapter([process.execPath, resolve('test/fixtures/fake-codex.mjs')], { CODEX_HOME: codexHome })],
  ]);
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'roots'), join(dir, 'scratch')), new AttachmentStore(dir));
  manager.personal.putSettings({ directory: personalDir, agent: 'pi', model: 'fake/plain' });
  const reports = new WorkerReports(manager);
  reports.start();
  const scheduler = new Scheduler(store, manager, adapters);
  return {
    dir,
    personalDir,
    repoDir,
    codexHome,
    store,
    manager,
    scheduler,
    async close() {
      reports.stop();
      await scheduler.stop();
      await manager.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('askOnce runs ephemerally without writing Codex rollout files and reuses a single archived hub thread', async () => {
  const h = await setup();
  try {
    for (let i = 1; i <= 4; i++) {
      const reply = await h.manager.askOnce('codex', `分类问题 ${i}`, { title: '推进分流', recordPrompt: false });
      assert.ok(reply.length > 0);
    }
    assert.deepEqual(rolloutFiles(h.codexHome), [], 'ephemeral askOnce leaves zero native sessions on disk');
    const archived = h.manager.listThreads({ archived: true });
    assert.equal(archived.length, 1, 'sequential askOnce calls reuse one archived hub thread');
    assert.equal(h.store.getThread(archived[0].id)?.agentSessionId, null);
    assert.equal(h.store.listEventsOfType(archived[0].id, 'turn.started').length, 4);
    assert.equal(readdirSync(join(h.dir, 'scratch')).length, 0);
  } finally {
    await h.close();
  }
});

test('dispatches, delegations and follow-ups reuse one cleanly named work session per (agent, cwd) and sync native title', async () => {
  const h = await setup();
  try {
    // 1. Personal directory: delegate + dispatch + followUp share one "管家工作台" thread.
    const m1 = h.manager.personal.create({ text: '整理周报数据' });
    const delegated = await h.manager.personal.delegate(m1.id);
    assert.equal(delegated.title, '管家工作台');
    assert.equal(h.manager.titleBy(delegated.id), 'user');
    await settle(() => h.store.getThread(delegated.id)?.status === 'idle');

    const m2 = h.manager.personal.create({ text: '核对月度预算' });
    const run = h.manager.personal.proactive.proposeDispatch({
      agent: 'pi', cwd: h.personalDir, task: '检查预算表格', title: '检查预算', matterId: m2.id,
    });
    const started = await h.manager.personal.proactive.startDispatch(run.id);
    assert.equal(started.threadId, delegated.id, 'dispatch in personal dir reuses 管家工作台');
    await settle(() => h.store.getThread(delegated.id)?.status === 'idle');

    const m3 = h.manager.personal.create({ text: '跟进审批结果' });
    h.store.updateTodo(m3.id, { followUpAt: new Date(Date.now() - 1000).toISOString() });
    await h.scheduler.followUps();
    assert.deepEqual(h.store.todoThreadIds(m3.id), [delegated.id], 'follow-up reuses 管家工作台');
    await settle(() => h.store.getThread(delegated.id)?.status === 'idle');

    // 2. Project directory on Codex: multiple dispatches reuse "管家工作台 · alpha-service" and sync native title.
    const r1 = h.manager.personal.proactive.proposeDispatch({
      agent: 'codex', cwd: h.repoDir, task: '检查接口延迟', title: '任务一', matterId: '',
    });
    const s1 = await h.manager.personal.proactive.startDispatch(r1.id);
    const repoThread = h.store.getThread(s1.threadId)!;
    assert.equal(repoThread.title, '管家工作台 · alpha-service');
    await settle(() => h.store.getThread(repoThread.id)?.status === 'idle');

    const r2 = h.manager.personal.proactive.proposeDispatch({
      agent: 'codex', cwd: h.repoDir, task: '补齐日志字段', title: '任务二', matterId: '',
    });
    const s2 = await h.manager.personal.proactive.startDispatch(r2.id);
    assert.equal(s2.threadId, repoThread.id, 'second repo dispatch reuses the same project work session');
    await settle(() => h.store.getThread(repoThread.id)?.status === 'idle');

    const files = rolloutFiles(h.codexHome);
    assert.equal(files.length, 1, 'only one persisted Codex session exists for both repo dispatches');
    const rollout = readFileSync(files[0], 'utf8');
    assert.match(rollout, /"type":"session_name".*"管家工作台 · alpha-service"/);

    // 3. Archiving the work session lets the next dispatch start a fresh one cleanly.
    await h.manager.updateThread(repoThread.id, { archived: true });
    const r3 = h.manager.personal.proactive.proposeDispatch({
      agent: 'codex', cwd: h.repoDir, task: '新一轮排查', title: '任务三', matterId: '',
    });
    const s3 = await h.manager.personal.proactive.startDispatch(r3.id);
    assert.notEqual(s3.threadId, repoThread.id);
    assert.equal(h.store.getThread(s3.threadId)?.title, '管家工作台 · alpha-service');
    await settle(() => h.store.getThread(s3.threadId)?.status === 'idle');
  } finally {
    await h.close();
  }
});

test('concurrent dispatches into a busy work session queue in order and report each turn with its own matter', async () => {
  const h = await setup();
  try {
    const firstMatter = h.manager.personal.create({ text: '第一件事' });
    const secondMatter = h.manager.personal.create({ text: '第二件事' });
    const r1 = h.manager.personal.proactive.proposeDispatch({
      agent: 'pi', cwd: h.repoDir, task: 'slow', title: '慢任务', matterId: firstMatter.id,
    });
    const r2 = h.manager.personal.proactive.proposeDispatch({
      agent: 'pi', cwd: h.repoDir, task: 'dispatch-worker-review', title: '快验收', matterId: secondMatter.id,
    });
    const s1 = await h.manager.personal.proactive.startDispatch(r1.id);
    await settle(() => h.store.getThread(s1.threadId)?.status === 'running');
    const s2 = await h.manager.personal.proactive.startDispatch(r2.id);
    assert.equal(s2.threadId, s1.threadId, 'busy dispatch queues into the same work session');
    assert.equal(h.manager.threadView(s1.threadId).queued.length, 1);

    // Cancel the slow turn while keeping the queue so the second dispatch runs next.
    await h.manager.cancelTurn(s1.threadId, { keepQueue: true });
    await settle(() => {
      const routerId = h.manager.personal.router.status().threadId;
      return Boolean(routerId && h.store.listEventsOfType(routerId, 'turn.started').length >= 1);
    });
    const routerId = h.manager.personal.router.status().threadId!;
    const routerTurn = h.store.listEventsOfType(routerId, 'turn.started').at(-1)!;
    assert.match(String(routerTurn.data.text), new RegExp(secondMatter.id));
    assert.match(String(routerTurn.data.text), /第二件事/);
  } finally {
    await h.close();
  }
});

test('proactive preparations reuse a single 管家准备 session', async () => {
  const h = await setup();
  try {
    const now = new Date(2026, 10, 18, 14, 0, 0);
    const t1 = h.manager.personal.create({ text: '准备架构评审提纲', importance: 'high', dueAt: new Date(now.getTime() + 4 * 3600_000).toISOString() });
    const t2 = h.manager.personal.create({ text: '准备季度复盘材料', importance: 'high', dueAt: new Date(now.getTime() + 6 * 3600_000).toISOString() });
    await h.manager.personal.proactive.save({ mode: 'auto' });
    await h.manager.personal.proactive.tick(now);
    await settle(() => h.manager.personal.proactive.runs(t1.id).some(r => r.status === 'ready'));
    await h.manager.personal.proactive.tick(new Date(now.getTime() + 65 * 60_000));
    await settle(() => h.manager.personal.proactive.runs(t2.id).some(r => r.status === 'ready'));

    const run1 = h.manager.personal.proactive.runs(t1.id).find(r => r.kind === 'prepare')!;
    const run2 = h.manager.personal.proactive.runs(t2.id).find(r => r.kind === 'prepare')!;
    assert.equal(run1.threadId, run2.threadId, 'both preparations reuse 管家准备');
    assert.equal(h.store.getThread(run1.threadId)?.title, '管家准备');
  } finally {
    await h.close();
  }
});
