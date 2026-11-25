import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { extractLinks, isHighPrioritySignal, messageCandidates, type LarkChannelSettings, type LarkSignal } from '../src/channels/lark.js';
import { FeishuChat } from '../src/feishu-chat.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { personalServer } from '../src/personal.js';
import { PersonalBriefSchedule } from '../src/personal-brief-schedule.js';
import {
  formatBriefMarkdown,
  matchDecisionOption,
  parseDecisionBrief,
  selectBriefTargets,
  type DecisionBrief,
} from '../src/proactive-investigate.js';
import { PushService } from '../src/push.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';

const wait = async (fn: () => boolean | Promise<boolean>, label = 'condition') => {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

test('extractLinks and isHighPrioritySignal enrich Lark messages deterministically', () => {
  const settings: LarkChannelSettings = {
    enabled: true,
    people: [{ id: 'ou_boss', name: '老板', role: 'boss' }],
    chats: [{ id: 'oc_mig', name: 'ModelHub 迁移群' }],
    intervalMin: 30,
    workHours: { start: 9, end: 21, timeZone: 'Asia/Shanghai' },
  };
  const longText = `请看 https://example.invalid/sheets/mig，以及 https://example.invalid/doc/guide）。还有 http://insecure.invalid/skip 不应提取。${'补充说明'.repeat(100)}`;
  assert.deepEqual(extractLinks(longText), ['https://example.invalid/sheets/mig', 'https://example.invalid/doc/guide']);

  const [enriched] = messageCandidates([
    { message_id: 'om_1', chat_id: 'oc_mig', sender: { id: 'ou_boss' }, content: longText, is_at_me: true },
  ], settings);
  assert.equal(enriched.chatName, 'ModelHub 迁移群');
  assert.deepEqual(enriched.links, ['https://example.invalid/sheets/mig', 'https://example.invalid/doc/guide']);
  assert.ok(enriched.body && enriched.body.length > enriched.summary.length);
  assert.equal(isHighPrioritySignal(enriched, 'ou_self', false), true);

  const ordinary: LarkSignal = {
    summary: '好的收到',
    source: { type: 'lark-message', ref: 'om_2' },
    message: { senderId: 'ou_peer', chatId: 'oc_other', mentions: [], atMe: false, deleted: false },
  };
  assert.equal(isHighPrioritySignal(ordinary, 'ou_self', false), false);
  assert.equal(isHighPrioritySignal(ordinary, 'ou_self', true), true);
  assert.equal(isHighPrioritySignal({ ...ordinary, links: ['https://example.invalid/a'] }), true);
});

test('parseDecisionBrief validates schema strictly, tolerates fences, and rejects malformed or unsafe fields', () => {
  assert.equal(parseDecisionBrief('not json'), null);
  assert.equal(parseDecisionBrief(JSON.stringify({ worthy: true, headline: '缺少归因' })), null);
  assert.equal(parseDecisionBrief(JSON.stringify({
    worthy: true,
    headline: '推荐 ID 不存在',
    attribution: '归因',
    options: [{ id: 'opt-1', label: 'A', action: 'do A', tradeoff: 'none' }],
    recommendedId: 'opt-99',
    recommendReason: '原因',
  })), null);

  const quiet = parseDecisionBrief(JSON.stringify({ worthy: false, headline: '无变化', attribution: '已填好' }), 'todo-1');
  assert.equal(quiet?.worthy, false);
  assert.equal(quiet?.matterId, 'todo-1');

  const parsed = parseDecisionBrief('前文\n```json\n' + JSON.stringify({
    worthy: true,
    matterId: 'm1',
    headline: '需要拍板路线',
    attribution: '表里三列仍空',
    evidence: [
      { label: '全量表', fact: '三列空着', url: 'https://example.invalid/sheet' },
      { label: '危险链接', fact: '应剥掉非 https', url: 'javascript:alert(1)' },
    ],
    gaps: ['邮件未查'],
    canDo: { user: ['定路线'], agent: ['改代码'] },
    options: [
      { id: 'opt-1', label: '迁方舟', action: '补表并改代码', tradeoff: '时间紧' },
      { id: 'opt-2', label: '延期', action: '提延期单', tradeoff: '需审批' },
    ],
    recommendedId: 'opt-1',
    recommendReason: '风险更低',
    prepared: { label: '群回复', artifactPath: '../escape.md', preview: '今天先补表' },
  }) + '\n```');
  assert.ok(parsed && parsed.worthy);
  assert.equal(parsed.evidence[0].url, 'https://example.invalid/sheet');
  assert.equal(parsed.evidence[1].url, undefined, 'unsafe URL scheme must be stripped');
  assert.equal(parsed.prepared?.artifactPath, undefined, 'path traversal must be stripped');
  assert.equal(matchDecisionOption(parsed, 'opt-2')?.id, 'opt-2');
  assert.equal(matchDecisionOption(parsed, '选 1')?.id, 'opt-1');
  assert.equal(matchDecisionOption(parsed, '按推荐的办')?.id, 'opt-1');
  assert.equal(matchDecisionOption(parsed, '延期')?.id, 'opt-2');
  assert.equal(matchDecisionOption(parsed, '我想先问问别人'), null);

  const md = formatBriefMarkdown(parsed, { heading: '早间深度复核', baseUrl: 'https://calli.invalid', replyable: true });
  assert.match(md, /\[全量表\]\(https:\/\/example\.invalid\/sheet\)/);
  assert.match(md, /迁方舟\*\*（推荐）/);
  assert.match(md, /未核实缺口：邮件未查/);
  assert.match(md, /已为你备好 · 群回复/);
  assert.match(md, /直接回复编号/);
  assert.ok([...md].length <= 2000);
});

test('selectBriefTargets prioritizes overdue, urgent, high-importance and stale waiting matters', () => {
  const now = new Date('2026-11-25T08:15:00+08:00');
  const base = {
    parentId: null, owner: 'me' as const, state: 'open' as const, lane: null,
    importance: null, horizon: null, urgentUntil: null, dueAt: null,
    waitingOn: null, followUpAt: null, followUpNoProgress: 0, followUpPaused: false,
    done: false, proposed: false, rev: 1, source: null, subscriptions: [],
    notePreview: null, acceptance: null, capture: null, validation: null,
    createdAt: '2026-11-20T01:00:00Z', updatedAt: '2026-11-20T01:00:00Z', doneAt: null,
  };
  const targets = selectBriefTargets([
    { ...base, id: 'low', text: '普通杂项', importance: 'low' },
    { ...base, id: 'wait', text: '等陈芃伊发 case', state: 'waiting', lane: 'wait', updatedAt: '2026-11-22T01:00:00Z' },
    { ...base, id: 'due', text: 'ModelHub 迁移', importance: 'high', dueAt: '2026-11-25T18:00:00+08:00' },
    { ...base, id: 'done', text: '已完成', importance: 'high', dueAt: '2026-11-24T18:00:00+08:00', done: true },
  ], now, 5);
  assert.deepEqual(targets.map(t => t.id), ['due', 'wait']);
});

async function setupE2E(investigateMode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'calli-investigate-'));
  const cwd = join(dir, 'personal');
  mkdirSync(cwd, { recursive: true });
  const feishuLog = join(dir, 'feishu.ndjson');
  const feishuCfg = join(dir, 'feishu-cfg.json');
  const feishuEvents = join(dir, 'feishu-events.ndjson');
  const pushLog = join(dir, 'push.ndjson');
  const pushCfg = join(dir, 'push-cfg.json');
  writeFileSync(feishuLog, '');
  writeFileSync(feishuCfg, JSON.stringify({ configured: true, ready: true, openId: 'ou_owner' }));
  writeFileSync(feishuEvents, '');
  writeFileSync(pushLog, '');
  writeFileSync(pushCfg, JSON.stringify({}));

  const store = new Store(dir);
  const adapters = new Map<string, AgentAdapter>([
    ['claude', new ClaudeAcpAdapter([process.execPath, resolve('test/fixtures/fake-acp.mjs')], investigateMode ? { FAKE_INVESTIGATE_MODE: investigateMode } : {})],
  ]);
  const manager = new ThreadManager(store, adapters, new Workdirs([dir], join(dir, 'roots'), join(dir, 'scratch')), new AttachmentStore(dir));
  const personal = manager.personal;
  personal.putSettings({ directory: cwd, agent: 'claude' });
  personal.socket = join(dir, 'personal.sock');
  const socket = personalServer(personal);
  await listenPrivate(socket, personal.socket);

  const feishu = new FeishuChat(store, manager, {
    executable: resolve('test/fixtures/fake-lark-feishu.mjs'),
    timeoutMs: 1500,
    retryMs: 20,
    env: { ...process.env, FAKE_LARK_LOG: feishuLog, FAKE_LARK_CONFIG: feishuCfg, FAKE_LARK_EVENTS: feishuEvents },
  });
  const push = new PushService(store, manager, {
    executable: resolve('test/fixtures/fake-lark-cli.mjs'),
    timeoutMs: 1500,
    retryMs: 20,
    env: { ...process.env, FAKE_LARK_LOG: pushLog, FAKE_LARK_CONFIG: pushCfg },
  });
  personal.proactive.attachDelivery(async (run, brief, markdown) => {
    const routerId = await personal.router.ensureThread();
    if (routerId && store.getThread(routerId)) manager.notice(routerId, `${brief.headline}`, false, true);
    const key = `proactive-brief:${run.id}`;
    if (routerId && await feishu.sendProactive(markdown, key, routerId, brief.headline)) {
      return { delivered: true, channel: 'feishu' };
    }
    const pushed = push.sendDecisionBrief(key, brief.headline, markdown, routerId);
    return { delivered: Boolean(pushed && pushed.result !== 'dropped'), channel: pushed ? 'push' : 'none' };
  });

  const server = createHttpServer({ manager, push, feishu, token: 'test', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const feishuCalls = () => readFileSync(feishuLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { args: string[]; input: string });
  const pushCalls = () => readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { args: string[]; input: string });

  return {
    dir, cwd, store, manager, personal, feishu, push, api, feishuEvents, feishuCalls, pushCalls,
    async close() {
      feishu.dispose();
      push.dispose();
      await manager.shutdown();
      await personal.proactive.flush();
      await personal.flushMirror();
      await new Promise<void>(r => server.close(() => r()));
      await new Promise<void>(r => socket.close(() => r()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('high-priority signal runs deep investigation, commits L1 draft, delivers via Feishu linked to Router, and Feishu reply continues Router as human turn', async () => {
  const h = await setupE2E();
  try {
    const todo = h.personal.create({ text: 'ModelHub 迁移方舟', importance: 'high', dueAt: '2026-11-30T10:00:00Z' });
    await h.personal.flushMirror();
    h.feishu.putSettings({ enabled: true, agent: 'claude', cwd: h.cwd, owner: 'ou_owner' });

    const signal: LarkSignal = {
      summary: '请在 11/30 前填完迁移全量表',
      links: ['https://example.invalid/sheets/modelhub'],
      senderRole: 'boss',
      source: { type: 'lark-message', ref: 'om_sig_1', from: '老板' },
    };

    // observe mode records without running a model turn
    await h.personal.proactive.save({ mode: 'observe' });
    const observed = await h.personal.proactive.onSignals([signal], new Date(2026, 10, 25, 10, 0));
    assert.equal(observed?.status, 'observed');
    assert.equal(observed?.kind, 'investigate');
    assert.equal(h.feishuCalls().filter(c => c.args[3] === '+messages-send').length, 0);

    // switch to auto with a new signal key -> runs deep investigation
    await h.personal.proactive.save({ mode: 'auto' });
    const signal2: LarkSignal = { ...signal, source: { type: 'lark-message', ref: 'om_sig_2', from: '老板' } };
    const started = await h.personal.proactive.onSignals([signal2], new Date(2026, 10, 25, 10, 5));
    assert.ok(started);
    await wait(() => h.personal.proactive.runs().find(r => r.id === started.id)?.status === 'asking', 'investigation asking');
    await h.personal.proactive.flush();

    const run = h.personal.proactive.runs().find(r => r.id === started.id)!;
    assert.equal(run.kind, 'investigate');
    assert.equal(run.status, 'asking');
    assert.equal(run.brief?.recommendedId, 'opt-1');
    assert.equal(run.brief?.evidence[0]?.url, 'https://example.invalid/sheets/modelhub');

    // Cooldown prevents re-investigating the same signal within 6 hours
    const skipped = await h.personal.proactive.onSignals([signal2], new Date(2026, 10, 25, 11, 0));
    assert.equal(skipped, null);

    // Feishu proactive send linked message_id to Router thread
    await wait(() => h.feishuCalls().some(c => c.args[3] === '+messages-send'), 'feishu proactive send');
    const sentCall = h.feishuCalls().find(c => c.args[3] === '+messages-send')!;
    assert.match(sentCall.input, /ModelHub 迁移表三列仍空/);
    assert.match(sentCall.input, /按原计划迁方舟\*\*（推荐）/);
    const routerId = h.personal.router.status().threadId!;
    assert.ok(routerId);

    // Find the linked Feishu message_id and simulate the user replying "按推荐的办" in Feishu
    const sentMsgId = h.store.feishuLastOf(routerId);
    assert.ok(sentMsgId && sentMsgId.startsWith('om_'));
    await wait(async () => (await h.feishu.status()).realtime === 'live', 'feishu realtime live');
    appendFileSync(h.feishuEvents, JSON.stringify({
      message_id: 'om_user_reply_1',
      chat_id: 'oc_p2p',
      chat_type: 'p2p',
      sender_id: 'ou_owner',
      sender_type: 'user',
      message_type: 'text',
      content: '按推荐的办',
      reply_to: sentMsgId,
    }) + '\n');

    await wait(() => h.store.listEventsOfType(routerId, 'turn.started').some(ev => String(ev.data.displayText ?? ev.data.text).includes('按推荐的办')), 'feishu reply routed to router');
    const replyTurn = h.store.listEventsOfType(routerId, 'turn.started').find(ev => String(ev.data.displayText ?? ev.data.text).includes('按推荐的办'))!;
    assert.equal(replyTurn.data.personalOrigin, 'person', 'Feishu reply to proactive brief must be a trusted human turn');
    assert.match(String(replyTurn.data.text), /按原计划迁方舟\(推荐\)/, 'Router receives active decision brief options in <calli-context>');

    // Answering via HTTP API records selectedOptionId and forwards decision to Router
    const answeredRes = await h.api(`/api/personal/proactive/runs/${run.id}/answer`, 'POST', { answer: 'opt-1' });
    assert.equal(answeredRes.status, 200);
    const answered = await answeredRes.json();
    assert.equal(answered.status, 'answered');
    assert.equal(answered.selectedOptionId, 'opt-1');
    assert.ok(existsSync(join(h.cwd, 'matters')), 'personal directory mirror exists');
    assert.ok(todo.id);
  } finally {
    await h.close();
  }
});

test('quiet investigation (worthy: false) stays silent without pushing; dynamic brief falls back to static brief on failure', async () => {
  const hQuiet = await setupE2E('quiet');
  try {
    hQuiet.push.putSettings({ enabled: true, recipient: 'ou_owner' });
    await hQuiet.personal.proactive.save({ mode: 'auto' });
    const sig: LarkSignal = { summary: '检查表格', links: ['https://example.invalid/sheet'], source: { type: 'lark-message', ref: 'om_q1' } };
    const started = await hQuiet.personal.proactive.onSignals([sig], new Date(2026, 10, 25, 10, 0));
    await wait(() => hQuiet.personal.proactive.runs().find(r => r.id === started!.id)?.status === 'discarded', 'quiet discarded');
    await hQuiet.personal.proactive.flush();
    assert.equal(hQuiet.pushCalls().filter(c => c.args.includes('+messages-send')).length, 0);
  } finally {
    await hQuiet.close();
  }

  const hFallback = await setupE2E('invalid');
  try {
    hFallback.push.putSettings({ enabled: true, recipient: 'ou_owner' });
    const now = new Date(2026, 10, 25, 9, 0);
    hFallback.store.createTodo('t1', '确认迁移方案', null, { importance: 'high', dueAt: new Date(now.getTime() + 3600_000).toISOString() });
    const schedule = new PersonalBriefSchedule(hFallback.store, () => ({ start: '23:00', end: '08:00' }));
    schedule.save({ enabled: true, morning: '09:00', deep: true });
    const fallbackSent: unknown[] = [];
    schedule.tick(now, { brief: (...args) => { fallbackSent.push(args); return {} as any; } }, (kind, at) => hFallback.personal.proactive.investigateBrief(kind, at));
    await wait(() => fallbackSent.length === 1, 'static brief fallback');
    assert.equal(fallbackSent.length, 1);
  } finally {
    await hFallback.close();
  }
});

test('when FeishuChat is disabled, decision brief falls back to PushService.sendDecisionBrief', async () => {
  const h = await setupE2E();
  try {
    h.push.putSettings({ enabled: true, recipient: 'ou_owner' });
    await h.personal.proactive.save({ mode: 'auto' });
    const sig: LarkSignal = { summary: '老板催迁方舟', senderRole: 'boss', source: { type: 'lark-message', ref: 'om_push_1' } };
    const started = await h.personal.proactive.onSignals([sig], new Date(2026, 10, 25, 10, 0));
    await wait(() => h.personal.proactive.runs().find(r => r.id === started!.id)?.status === 'asking', 'asking ready');
    await wait(() => h.pushCalls().some(c => c.args.includes('+messages-send')), 'push sendDecisionBrief');
    const sent = h.pushCalls().find(c => c.args.includes('+messages-send'))!;
    assert.match(sent.input, /ModelHub 迁移表三列仍空/);
  } finally {
    await h.close();
  }
});
