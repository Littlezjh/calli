import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { personalServer } from '../src/personal.js';
import { PushService } from '../src/push.js';
import { Store } from '../src/store.js';
import { repoKeyForCwd } from '../src/task-ledger.js';
import { ThreadManager } from '../src/threads.js';
import { WorkerReports } from '../src/worker-reports.js';
import { Workdirs } from '../src/workdirs.js';

const exec = promisify(execFile);
const wait = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'calli-superagent-'));
  const cwd = join(dir, 'personal');
  const repo = join(dir, 'payment-repo');
  const worktreeDir = join(repo, '.worktrees', 'fix-bug');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

  const log = join(dir, 'lark-log');
  const config = join(dir, 'lark-config');
  writeFileSync(log, '');
  writeFileSync(config, '{}');

  const store = new Store(dir);
  const adapters = new Map<string, AgentAdapter>([
    ['pi', new PiRpcAdapter([process.execPath, resolve('test/fixtures/fake-pi.mjs')])],
    ['claude', new ClaudeAcpAdapter([process.execPath, resolve('test/fixtures/fake-acp.mjs')])],
  ]);
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'roots')), new AttachmentStore(dir));
  manager.personal.putSettings({ directory: cwd, agent: 'pi', model: 'fake/plain' });
  manager.personal.socket = join(dir, 'personal.sock');
  const personalSock = personalServer(manager.personal);
  await listenPrivate(personalSock, manager.personal.socket);

  const push = new PushService(store, manager, {
    executable: resolve('test/fixtures/fake-lark-cli.mjs'),
    retryMs: 1,
    env: { ...process.env, FAKE_LARK_LOG: log, FAKE_LARK_CONFIG: config },
  });
  manager.personal.supervision.attachPush(push);
  manager.personal.ledger.start();
  const reports = new WorkerReports(manager);
  reports.start();

  const server = createHttpServer({ manager, push, token: 'sa-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { Authorization: 'Bearer sa-token', 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const cli = async (threadId: string, args: string[]) =>
    JSON.parse((await exec(process.execPath, [resolve('bin/calli'), ...args], {
      env: { ...process.env, ...manager.personal.environment(threadId) },
    })).stdout);

  const sentPushes = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(c => c.args[0] === 'im');

  return {
    dir, cwd, repo, worktreeDir, store, manager, push, reports, api, cli, sentPushes,
    async close() {
      reports.stop();
      push.dispose();
      await manager.shutdown();
      await new Promise<void>(r => server.close(() => r()));
      await new Promise<void>(r => personalSock.close(() => r()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('task ledger auto-captures direct user sessions, normalizes worktree repoKey, skips internal threads, and backfills old sessions', async () => {
  const h = await setup();
  try {
    assert.equal(repoKeyForCwd('/a/repo/.worktrees/abc'), '/a/repo');
    assert.equal(repoKeyForCwd('/a/repo'), '/a/repo');

    // User directly opens a thread in a worktree and sends a turn.
    const direct = await h.manager.createThread({ agent: 'pi', cwd: h.worktreeDir, title: '修支付导出' });
    await h.manager.startTurn(direct.id, { text: '修复支付导出 CSV 乱码问题', fromUser: true });
    await wait(() => h.store.getThread(direct.id)?.status === 'idle');

    // Auto-captured into ledger with normalized repoKey and owner=agent (without auto-granting execution).
    const linked = h.manager.personal.ledger.linkedTodos(direct.id);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].owner, 'agent');
    assert.equal(linked[0].capture?.kind, 'direct');
    assert.equal(linked[0].capture?.repoKey, h.repo);
    assert.equal(h.manager.personal.supervision.activeGrant(linked[0].id), null, 'auto-capture never grants autonomous execution');

    // Handover successor automatically inherits the same matter and becomes activeSegmentId.
    const successor = await h.manager.createThread({ agent: 'pi', cwd: h.worktreeDir, title: '修支付导出（接手）' });
    h.store.setHandover(successor.id, { sourceId: direct.id, title: direct.title, agent: 'pi', mode: 'continue' });
    await h.manager.startTurn(successor.id, { text: '接着修导出编码', fromUser: true });
    await wait(() => h.store.getThread(successor.id)?.status === 'idle');
    assert.deepEqual(h.manager.personal.ledger.linkedTodos(successor.id).map(t => t.id), [linked[0].id]);
    assert.equal(h.manager.personal.ledger.activeSegmentId(direct.id), successor.id);

    // An old (>30 days) unlinked open thread is still picked up by backfill (no 3-day/7-day blind spot).
    const oldThread = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '一个月前的重构' });
    const oldTs = new Date(Date.now() - 40 * 86400_000).toISOString();
    h.store.appendEvent(oldThread.id, 'old-t1', 'turn.started', { text: '把老接口迁到新路由', userOrigin: 'person' });
    h.store.appendEvent(oldThread.id, 'old-t1', 'turn.done', {});
    h.store.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(oldTs, oldThread.id);

    // An archived thread is NOT turned into a new open task, yet stays searchable.
    const archivedThread = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '已归档的老排查' });
    h.store.appendEvent(archivedThread.id, 'arch-t1', 'turn.started', { text: '排查 Redis 抖动原因', userOrigin: 'person' });
    h.store.appendEvent(archivedThread.id, 'arch-t1', 'turn.done', {});
    h.store.updateThread(archivedThread.id, { archivedAt: oldTs });

    const cov = h.manager.personal.ledger.backfill();
    assert.ok(cov.backfilledAt);
    assert.equal(h.manager.personal.ledger.linkedTodos(oldThread.id).length, 1, 'old open thread captured by backfill');
    assert.equal(h.manager.personal.ledger.linkedTodos(archivedThread.id).length, 0, 'archived thread does not become an open task');

    // Router thread itself is never captured as a task.
    const { threadId: routerId } = await h.manager.personal.router.say({ text: '帮我看下进度' });
    await wait(() => h.manager.personal.router.status().status === 'idle');
    assert.equal(h.manager.personal.ledger.linkedTodos(routerId).length, 0);

    // Full-corpus thread search finds old, direct, handover, and archived threads by keyword/repo.
    const hitArchived = h.manager.personal.ledger.searchThreads({ query: 'Redis 抖动' }, routerId);
    assert.equal(hitArchived.threads[0]?.id, archivedThread.id);
    assert.equal(hitArchived.threads[0]?.archived, true);

    const hitHandover = h.manager.personal.ledger.searchThreads({ query: '支付导出' }, routerId);
    assert.ok(hitHandover.threads.some(t => t.id === direct.id && t.activeSegmentId === successor.id));
  } finally {
    await h.close();
  }
});

test('priority triage ranks urgent/important/needs_user ahead of lower-priority work and paginates ledger snapshots', async () => {
  const h = await setup();
  try {
    const lowPaused = h.manager.personal.create({ text: '低优搁置任务', lane: 'later', importance: 'low' });
    const normalOpen = h.manager.personal.create({ text: '普通任务', importance: 'normal' });
    const urgentImportant = h.manager.personal.create({
      text: '老板要的线上事故复盘',
      importance: 'high',
      dueAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    h.store.updateTodo(urgentImportant.id, { state: 'waiting', waitingOn: '等你确认口径' }, urgentImportant.rev);

    // Parent goal + child execution item: totalOpen counts leaf execution tasks without double-counting parent.
    const parent = h.manager.personal.create({ text: 'Q4 目标', horizon: 'month' });
    const child = h.manager.personal.create({ text: 'Q4 子任务', parentId: parent.id });

    const snap = h.manager.personal.ledger.snapshot({ limit: 2 });
    assert.equal(snap.items.length, 2);
    assert.equal(snap.items[0].id, urgentImportant.id, 'overdue high-importance needs_user ranks first');
    assert.equal(snap.items[0].priority.quadrant, 'now');
    assert.equal(snap.items[0].phase, 'needs_user');
    assert.ok(snap.nextCursor, 'paginates cleanly');

    const page2 = h.manager.personal.ledger.snapshot({ cursor: snap.nextCursor!, limit: 10 });
    const allIds = [...snap.items, ...page2.items].map(i => i.id);
    assert.ok(allIds.includes(normalOpen.id));
    assert.ok(allIds.includes(lowPaused.id));
    assert.ok(allIds.includes(child.id));
    assert.equal(page2.items.at(-1)?.id, lowPaused.id, 'paused low-priority item ranks last');
    // 4 leaf execution tasks (urgentImportant, normalOpen, lowPaused, child); parent goal is not double-counted.
    assert.equal(snap.totalOpen, 4);

    // HTTP /api/personal/ledger exposes the same prioritized snapshot.
    const res = await h.api('/api/personal/ledger?limit=2');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items[0].id, urgentImportant.id);
  } finally {
    await h.close();
  }
});

test('supervision enforces defaults, human-only grant/settings, scopeHash invalidation, bounded recovery, single-owner AutoRetry, modelPolicy, and safe approval answering', async () => {
  const h = await setup();
  try {
    // Section 9 defaults: enabled=false, ledgerCapture=true, notifyMergeMs=15000.
    const defaults = await (await h.api('/api/personal/superagent/settings')).json();
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.ledgerCapture, true);
    assert.equal(defaults.notifyMergeMs, 15_000);

    // Start assistant router thread.
    const { threadId: routerId } = await h.manager.personal.router.say({ text: '你好' });
    await wait(() => h.manager.personal.router.status().status === 'idle');

    // Cannot toggle superagent.* outside an active human turn (e.g., from a worker/signal turn).
    await assert.rejects(
      h.manager.personal.command(routerId, { op: 'settings.set', key: 'superagent.enabled', value: 'true' }),
      /当前对话轮/,
    );

    // Create a matter and linked work thread.
    const matter = h.manager.personal.create({ text: '修复支付回调', owner: 'agent', acceptance: '单测通过且附真实日志' });
    const worker = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '支付回调修复' });
    h.store.linkTodoThread(matter.id, worker.id);

    // Grant requires active human turn via CLI; test refusal outside human turn.
    await assert.rejects(
      h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'grant' }),
      /human-initiated/,
    );

    // Bind grant directly with trusted origin, while superagent.enabled is STILL false -> autonomous retry refused.
    h.manager.personal.supervision.grant(matter.id, { threadId: routerId, turnId: 'human-1', seq: 1 }, { modelPolicy: 'keep', fixedModel: 'fake/plain' });
    await assert.rejects(
      h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'retry' }),
      /disabled/,
    );

    // Enable superagent via HTTP settings (user action on web page).
    const saved = await (await h.api('/api/personal/superagent/settings', 'PUT', { enabled: true, notifyMergeMs: 0 })).json();
    assert.equal(saved.enabled, true);

    // Fixed modelPolicy refuses switch_model.
    await assert.rejects(
      h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'switch_model', model: 'fake/loose' }),
      /fixed model policy/,
    );

    // Single-owner check: when AutoRetry is watching the thread, supervision defers instead of double-retrying.
    h.manager.autoRetry.parked(worker.id, 'err-turn-1');
    const deferred = await h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'retry' }) as { status: string; handledBy: string };
    assert.equal(deferred.status, 'deferred');
    assert.equal(deferred.handledBy, 'auto_retry');
    h.manager.autoRetry.drop(worker.id);

    // Bounded recovery: retry succeeds ONCE per incidentId, and a second retry on the same incident is refused (409).
    const retried = await h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'retry', incidentId: 'inc-1' }) as { status: string; threadId: string };
    assert.equal(retried.status, 'started');
    assert.equal(retried.threadId, worker.id);
    await wait(() => h.store.getThread(worker.id)?.status === 'idle');
    await assert.rejects(
      h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'retry', incidentId: 'inc-1' }),
      /recovery limit reached/,
    );

    // ScopeHash invalidation: changing goal text invalidates the old grant!
    const current = h.store.getTodo(matter.id)!;
    h.store.updateTodo(matter.id, { text: '改做完全不同的需求' }, current.rev);
    assert.equal(h.manager.personal.supervision.activeGrant(matter.id), null);
    await assert.rejects(
      h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'continue', incidentId: 'inc-2' }),
      /no active supervision grant/,
    );

    // Re-grant for updated scope and test safe native approval answering: allow_always is REFUSED, allow_once succeeds!
    h.manager.personal.supervision.grant(matter.id, { threadId: routerId, turnId: 'human-2', seq: 5 });
    let resolvedDecision: unknown = null;
    (h.manager as any).approvals.set('appr-1', {
      threadId: worker.id,
      turnId: 't-appr',
      title: 'Run npm test',
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      ],
      optionIds: ['once', 'always'],
      resolve: (d: unknown) => { resolvedDecision = d; },
    });
    await assert.rejects(
      h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'answer', requestId: 'appr-1', optionId: 'always', reason: 'test' }),
      /allow_always/,
    );
    const answered = await h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter.id, action: 'answer', requestId: 'appr-1', optionId: 'once', reason: '用户要求跑测试' }) as { resolved: boolean };
    assert.equal(answered.resolved, true);
    assert.deepEqual(resolvedDecision, { optionId: 'once' });
  } finally {
    await h.close();
  }
});

test('evidence verification rejects missing/forged refs, kicks back gaps when enabled, and merges verified review pushes', async () => {
  const h = await setup();
  try {
    h.push.putSettings({ enabled: true });
    await h.api('/api/personal/superagent/settings', 'PUT', { enabled: true, notifyMergeMs: 60 });

    const { threadId: routerId } = await h.manager.personal.router.say({ text: '准备验收' });
    await wait(() => h.manager.personal.router.status().status === 'idle');

    const matter1 = h.manager.personal.create({ text: '任务一：生成报告', owner: 'agent', acceptance: '存在报告文件' });
    const matter2 = h.manager.personal.create({ text: '任务二：修复样式', owner: 'agent', acceptance: '附构建结果' });
    const w1 = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '报告线程' });
    const w2 = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '样式线程' });
    h.store.linkTodoThread(matter1.id, w1.id);
    h.store.linkTodoThread(matter2.id, w2.id);
    h.manager.personal.supervision.grant(matter1.id, { threadId: routerId, turnId: 'h1', seq: 1 });

    // 1. Verify refuses empty refs, nonexistent file, and unlinked thread ref.
    await assert.rejects(h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter1.id, action: 'verify', refs: [] }), /at least one/);
    await assert.rejects(h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter1.id, action: 'verify', refs: [join(h.repo, 'does-not-exist.md')] }), /does not exist/);
    await assert.rejects(h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter1.id, action: 'verify', refs: [`thread:${w2.id}`] }), /linked thread/);

    // 2. Reject missing evidence kicks back to w1 and keeps phase out of `review`.
    const rejected = await h.manager.personal.command(routerId, {
      op: 'todo.supervise', id: matter1.id, action: 'reject_evidence', state: 'missing', gaps: ['缺少报告文件'], sourceTurnId: 'turn-1',
    }) as { kickedBack: boolean; validation: { state: string } };
    assert.equal(rejected.kickedBack, true);
    assert.equal(rejected.validation.state, 'missing');
    await wait(() => h.store.getThread(w1.id)?.status === 'idle');
    assert.notEqual(h.manager.personal.ledger.taskView(h.store.getTodo(matter1.id)!).phase, 'review');

    // 3. Create real artifact files and verify BOTH matters within the 60ms fixed merge window -> ONE consolidated push!
    const reportFile = join(h.repo, 'report.md');
    writeFileSync(reportFile, '# Report OK\n');
    const v1 = await h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter1.id, action: 'verify', refs: [reportFile, `thread:${w1.id}`], sourceTurnId: 'turn-2' }) as { validation: { state: string } };
    const v2 = await h.manager.personal.command(routerId, { op: 'todo.supervise', id: matter2.id, action: 'verify', refs: [`thread:${w2.id}`], sourceTurnId: 'turn-2' }) as { validation: { state: string } };
    assert.equal(v1.validation.state, 'passed');
    assert.equal(v2.validation.state, 'passed');
    assert.equal(h.manager.personal.ledger.taskView(h.store.getTodo(matter1.id)!).phase, 'review');

    await wait(() => h.sentPushes().length === 1);
    const pushMsg = h.sentPushes()[0].input as string;
    assert.match(pushMsg, /2 件待你处理/);
    assert.match(pushMsg, /任务一：生成报告/);
    assert.match(pushMsg, /任务二：修复样式/);

    // 4. Thread-open metrics API tracks direct vs assistant-link opens cleanly.
    assert.equal((await h.api('/api/personal/thread-open', 'POST', { threadId: w1.id, source: 'sidebar' })).status, 201);
    assert.equal((await h.api('/api/personal/thread-open', 'POST', { threadId: w2.id, source: 'assistant-link' })).status, 201);
    const metrics = await (await h.api('/api/personal/metrics/thread-opens?days=7')).json();
    assert.equal(metrics.totalDirectOpens, 1);
    assert.equal(metrics.daily[0].assistantLinkOpens, 1);

    // 5. CLI integration: `calli todo --ledger` and `calli threads --query` work end-to-end.
    const cliLedger = await h.cli(routerId, ['todo', '--ledger', '--limit', '10']);
    assert.ok(cliLedger.items.some((item: { id: string; phase: string }) => item.id === matter1.id && item.phase === 'review'));
    const cliSearch = await h.cli(routerId, ['threads', '--query', '报告线程']);
    assert.equal(cliSearch.threads[0].id, w1.id);
  } finally {
    await h.close();
  }
});

test('superagent triage filters superseded/casual/stale noise, caps at top 5 by priority, and shelves without losing ledger items', async () => {
  const h = await setup();
  try {
    const now = new Date();
    const oldIso = new Date(now.getTime() - 72 * 3600_000).toISOString();

    // 1. Superseded handover chain: older segment was blocked, active tip segment is clean -> filtered out.
    const oldSeg = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '旧交接段' });
    h.store.setThreadProgress(oldSeg.id, { report: { stage: 'blocked', note: '旧段等你确认', at: oldIso } });
    const oldMatter = h.manager.personal.ledger.captureThread(oldSeg.id, { kind: 'direct' })!;
    const newSeg = await h.manager.createHandoverThread(oldSeg.id, 'pi', undefined, 'continue', undefined, true, false);
    h.store.setThreadProgress(newSeg.id, { report: { stage: 'doing', note: '正在推进', at: now.toISOString() } });
    assert.ok(oldMatter);

    // 2. Stale (>36h) unprioritized ad-hoc chat & casual sign-off & paused note -> all filtered out.
    const staleChat = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '三天前随手问' });
    h.store.setThreadProgress(staleChat.id, { report: { stage: 'blocked', note: '要不要继续看', at: oldIso } });
    h.manager.personal.ledger.captureThread(staleChat.id, { kind: 'direct' });
    h.store.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(oldIso, staleChat.id);
    // Even without raw SQL, casual & paused notes on fresh threads are filtered out:
    const casual = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '群消息闲聊' });
    h.store.setThreadProgress(casual.id, { report: { stage: 'blocked', note: '想听听你那条方案后来怎么样了，要不要我帮你看看它好不好读', at: now.toISOString() } });
    h.manager.personal.ledger.captureThread(casual.id, { kind: 'direct' });

    const paused = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '暂停开发会话' });
    h.store.setThreadProgress(paused.id, { report: { stage: 'blocked', note: '已暂停开发；恢复时请告诉我机器地址', at: now.toISOString() } });
    h.manager.personal.ledger.captureThread(paused.id, { kind: 'direct' });

    // 3. Unverified `review` thread ("看起来做完了") stays in `verifying`, NOT in home triage.
    const unverified = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '未核验完成会话' });
    h.store.setThreadProgress(unverified.id, { report: { stage: 'review', note: '自称已完成', at: now.toISOString() } });
    h.manager.personal.ledger.captureThread(unverified.id, { kind: 'direct' });

    // 4. Create 6 genuine blocked decisions (1 urgent+important, 5 regular fresh decisions) -> capped at Top 5 + 1 overflow!
    const urgentMatter = h.manager.personal.create({
      text: '核心发布窗口拍板',
      owner: 'me',
      lane: 'you',
      importance: 'high',
      dueAt: new Date(now.getTime() + 2 * 3600_000).toISOString(),
    });
    const urgentThread = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: '🚀核心发布窗口拍板（接手）（接手）' });
    h.store.linkTodoThread(urgentMatter.id, urgentThread.id);
    h.store.setThreadProgress(urgentThread.id, { report: { stage: 'blocked', note: '[进度] 需要你：确认今晚 20:00 灰度还是明早全量', at: now.toISOString() } });

    for (let i = 1; i <= 5; i++) {
      const t = await h.manager.createThread({ agent: 'pi', cwd: h.repo, title: `决策会话 ${i}` });
      h.store.setThreadProgress(t.id, { report: { stage: 'blocked', note: `请选方案 ${i}A 还是 ${i}B`, at: now.toISOString() } });
      h.manager.personal.ledger.captureThread(t.id, { kind: 'direct' });
    }

    const triageRes = await (await h.api('/api/personal/superagent/triage')).json();
    assert.equal(triageRes.items.length, 5, 'home triage caps visible items at 5');
    assert.ok(triageRes.total >= 6);
    assert.equal(triageRes.overflowCount, triageRes.total - 5);
    assert.equal(triageRes.items[0].id, urgentMatter.id, 'urgent + high-importance decision ranks #1');
    assert.equal(triageRes.items[0].title, '🚀核心发布窗口拍板', 'strips trailing （接手） suffixes');
    assert.equal(triageRes.items[0].summary, '确认今晚 20:00 灰度还是明早全量', 'strips raw [进度] 需要你： prefix');
    assert.ok(!triageRes.items.some((x: { title: string }) => /三天前随手问|群消息闲聊|暂停开发会话|未核验完成会话|旧交接段/.test(x.title)));

    // 5. Shelving removes the item from triage without deleting or closing the task in the ledger.
    const beforeOpen = h.manager.personal.ledger.snapshot().totalOpen;
    const shelveRes = await h.api(`/api/personal/superagent/triage/${urgentMatter.id}/shelve`, 'POST');
    assert.equal(shelveRes.status, 200);
    const afterTriage = await (await h.api('/api/personal/superagent/triage')).json();
    assert.ok(!afterTriage.items.some((x: { id: string }) => x.id === urgentMatter.id), 'shelved item leaves triage immediately');
    assert.equal(h.manager.personal.ledger.snapshot().totalOpen, beforeOpen, 'full unfinished ledger stays intact');
  } finally {
    await h.close();
  }
});
